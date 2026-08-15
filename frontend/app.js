// app.js — おうとう開花予測 フロントエンドロジック
//
// 予測の考え方:
//   前年9/1〜計算年5/31相当(273日・6552時間)について、
//     - 実測データ(Cloudflare Worker経由でobsdlから取得)があればそれを使う
//     - 実測データがない(欠測、または「最終実測利用日」より後)場合は
//       気候値(climatology JSONのnormal=KZフィルタ後の平年値)で埋める。
//       ただし「最終実測利用日」より後(=未来分)だけtemperatureAlphaを加算する。
//   1時間ごとにチルユニット・DTS発育量を積算し、各品種の発育量が
//   gdhStart/gdhFullを超えた時刻を開花始・満開として求める。
//
//   temperatureAlpha(未来分に対する平年値からのずれ)は単一の値を指定せず、
//   -5℃〜+5℃の範囲を0.5℃刻みで網羅的に計算し、その年の気象がどちらに
//   振れても対応できるよう、結果を幅（レンジ）として示す。

import { WORKER_BASE } from "./config.js";
import { chillUnit, dt as growthDt } from "./flowering-model.mjs";
import { seasonDayCount, todayYmdJst, addDaysYmd } from "./season-calendar.mjs";

const SEASON_DAYS = 273; // 9/1 〜 翌5/31相当
const HOURS_PER_DAY = 24;
const TOTAL_HOURS = SEASON_DAYS * HOURS_PER_DAY; // 6552

const ALPHA_MIN = -5;
const ALPHA_MAX = 5;
const ALPHA_STEP = 0.5;

const el = (id) => document.getElementById(id);

let targetStations = null; // Map<stid, {name, ...}>
let cultivarParams = null; // {品種名: {tu,td,m,cur,d,gdhStart,gdhFull}}
const climatologyCache = new Map(); // stid -> climatology JSON

// ---------------------------------------------------------------------------
// データ読み込み
// ---------------------------------------------------------------------------

async function loadTargetStations() {
  if (targetStations) return targetStations;
  const res = await fetch("data/target-stations.json");
  const data = await res.json();
  targetStations = new Map(Object.entries(data.stations));
  return targetStations;
}

async function loadCultivarParams() {
  if (cultivarParams) return cultivarParams;
  const res = await fetch("data/cultivar-params.json");
  const data = await res.json();
  cultivarParams = data.cultivars;
  return cultivarParams;
}

async function loadClimatology(stid) {
  if (climatologyCache.has(stid)) return climatologyCache.get(stid);
  const res = await fetch(`data/climatology/${stid}.json`);
  if (!res.ok) throw new Error(`気候値データが見つかりません: ${stid}`);
  const data = await res.json();
  climatologyCache.set(stid, data);
  return data;
}

async function fetchActualTemperature(stid, fromYmd, toYmd) {
  const url = `${WORKER_BASE}/api/temperature?station=${encodeURIComponent(stid)}&from=${fromYmd}&to=${toYmd}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "気温データの取得に失敗しました");
  return data.hourly; // [{year,month,day,hour,temperature}]
}

// ---------------------------------------------------------------------------
// 予測本体
// ---------------------------------------------------------------------------

function dateInputToYmd(value) {
  return value.replaceAll("-", "");
}

function alphaSweep() {
  const values = [];
  for (let a = ALPHA_MIN; a <= ALPHA_MAX + 1e-9; a += ALPHA_STEP) {
    values.push(Math.round(a * 10) / 10);
  }
  return values;
}

/**
 * @param {string} stid
 * @param {number} calcYear 開花を予測する年
 * @param {{ lastActualYmd?: string }} options
 *   lastActualYmd: 実測値として利用する最終日(YYYYMMDD)。省略時は利用可能な全期間を実測値として使う。
 */
async function predictFloweringRange(stid, calcYear, { lastActualYmd = null } = {}) {
  const seasonStartYear = calcYear - 1;
  const fromYmd = `${seasonStartYear}0901`;
  const day273Ymd = addDaysYmd(fromYmd, SEASON_DAYS - 1);
  const yesterdayYmd = addDaysYmd(todayYmdJst(), -1);

  let toYmd = day273Ymd < yesterdayYmd ? day273Ymd : yesterdayYmd;
  if (lastActualYmd && lastActualYmd < toYmd) toYmd = lastActualYmd;

  const [climatology, params] = await Promise.all([loadClimatology(stid), loadCultivarParams()]);

  const actualByIndex = new Map();
  if (fromYmd <= toYmd) {
    const hourly = await fetchActualTemperature(stid, fromYmd, toYmd);
    for (const rec of hourly) {
      if (rec.temperature === null) continue;
      const dayCount = seasonDayCount(seasonStartYear, rec.year, rec.month, rec.day);
      if (dayCount < 1 || dayCount > SEASON_DAYS) continue;
      const idx = (dayCount - 1) * HOURS_PER_DAY + (rec.hour - 1);
      actualByIndex.set(idx, rec.temperature);
    }
  }

  const lastObservedIndex = actualByIndex.size > 0 ? Math.max(...actualByIndex.keys()) : -1;
  const futureStartIndex = lastObservedIndex + 1;

  const climByIndex = new Map();
  for (const day of climatology.days) {
    if (day.day > SEASON_DAYS) continue;
    for (const h of day.hours) {
      const idx = (day.day - 1) * HOURS_PER_DAY + (h.hour - 1);
      climByIndex.set(idx, h.normal);
    }
  }

  // baseTemps: alphaを含まない基準気温（未来分もここでは平年値そのまま）。
  // alphaは accumulate() 内で futureStartIndex 以降にだけ加える。
  const baseTemps = new Array(TOTAL_HOURS);
  for (let idx = 0; idx < TOTAL_HOURS; idx++) {
    if (actualByIndex.has(idx)) {
      baseTemps[idx] = actualByIndex.get(idx);
      continue;
    }
    const normal = climByIndex.get(idx);
    if (normal === null || normal === undefined) {
      throw new Error(`気候値が見つかりません: ${stid} idx=${idx}`);
    }
    baseTemps[idx] = normal;
  }

  const sweep = alphaSweep();
  const sweepResults = {}; // { 品種名: [{alpha, bloomStartIndex, fullBloomIndex}, ...] }

  for (const [name, p] of Object.entries(params)) {
    sweepResults[name] = sweep.map((alpha) => {
      const result = accumulate(baseTemps, futureStartIndex, alpha, p);
      return { alpha, ...result };
    });
  }

  return {
    stid,
    calcYear,
    seasonStartYear,
    lastObservedIndex,
    params,
    sweep,
    sweepResults,
  };
}

function accumulate(baseTemps, futureStartIndex, alpha, params) {
  let chill = 0;
  let growth = 0;
  let startIndex = null;
  let fullIndex = null;

  for (let idx = 0; idx < baseTemps.length; idx++) {
    const te = idx >= futureStartIndex ? baseTemps[idx] + alpha : baseTemps[idx];

    chill += chillUnit(te, params.tu, params.td, params.m);
    if (chill < 0) chill = 0;

    growth += growthDt(te, chill, params.cur, params.d);

    if (startIndex === null && growth > params.gdhStart) startIndex = idx;
    if (fullIndex === null && growth > params.gdhFull) fullIndex = idx;
  }

  return {
    bloomStartIndex: startIndex,
    fullBloomIndex: fullIndex,
    finalChillUnit: chill,
    finalGrowth: growth,
  };
}

function indexToDate(seasonStartYear, idx) {
  const ms = Date.UTC(seasonStartYear, 8, 1) + (idx + 1) * 3600 * 1000;
  return new Date(ms);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric" }).format(date);
}

function formatDateRange(seasonStartYear, minIdx, maxIdx) {
  if (minIdx === null || maxIdx === null) return "予測期間内に到達せず";
  if (minIdx === maxIdx) return formatDate(indexToDate(seasonStartYear, minIdx));
  return `${formatDate(indexToDate(seasonStartYear, minIdx))} 〜 ${formatDate(indexToDate(seasonStartYear, maxIdx))}`;
}

function indexRange(sweepResults, key) {
  const values = sweepResults.map((r) => r[key]).filter((v) => v !== null);
  if (values.length === 0) return { minIdx: null, maxIdx: null };
  return { minIdx: Math.min(...values), maxIdx: Math.max(...values) };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const CULTIVAR_COLORS = {
  佐藤錦: "var(--series-1, #d9534f)",
  紅秀峰: "var(--series-2, #337ab7)",
};

async function populateStationSelect() {
  const stations = await loadTargetStations();
  const select = el("station-select");
  select.innerHTML = "";
  for (const [stid, st] of stations) {
    const opt = document.createElement("option");
    opt.value = stid;
    opt.textContent = st.name;
    select.appendChild(opt);
  }
}

function defaultCalcYear() {
  // 9月以降ならその翌年の開花、9月より前なら今年の開花を既定値にする
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() + 1;
  return m >= 9 ? y + 1 : y;
}

function renderResults(result) {
  el("result-section").classList.remove("hidden");

  const tbody = el("result-tbody");
  tbody.innerHTML = "";
  for (const [name, rows] of Object.entries(result.sweepResults)) {
    const start = indexRange(rows, "bloomStartIndex");
    const full = indexRange(rows, "fullBloomIndex");

    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = name;
    const tdStart = document.createElement("td");
    tdStart.textContent = formatDateRange(result.seasonStartYear, start.minIdx, start.maxIdx);
    const tdFull = document.createElement("td");
    tdFull.textContent = formatDateRange(result.seasonStartYear, full.minIdx, full.maxIdx);
    tr.append(tdName, tdStart, tdFull);
    tbody.appendChild(tr);
  }

  const lastObsText =
    result.lastObservedIndex >= 0
      ? `実測データ利用: 〜${formatDate(indexToDate(result.seasonStartYear, result.lastObservedIndex))}` +
        `（それ以降は平年値を基準に、${ALPHA_MIN}℃〜+${ALPHA_MAX}℃の幅で計算）`
      : `実測データなし（全期間を平年値基準に${ALPHA_MIN}℃〜+${ALPHA_MAX}℃の幅で計算）`;
  el("result-meta").textContent = lastObsText;

  renderAlphaChart(result);
}

// 平年値との差(alpha)と開花日の関係を示すチャート
function renderAlphaChart(result) {
  const container = el("alpha-chart");
  container.innerHTML = "";

  const width = 720, height = 340;
  const margin = { top: 16, right: 20, bottom: 36, left: 64 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let minIdx = Infinity, maxIdx = -Infinity;
  for (const rows of Object.values(result.sweepResults)) {
    for (const r of rows) {
      if (r.bloomStartIndex !== null) {
        minIdx = Math.min(minIdx, r.bloomStartIndex);
        maxIdx = Math.max(maxIdx, r.bloomStartIndex);
      }
      if (r.fullBloomIndex !== null) {
        minIdx = Math.min(minIdx, r.fullBloomIndex);
        maxIdx = Math.max(maxIdx, r.fullBloomIndex);
      }
    }
  }
  if (!Number.isFinite(minIdx) || !Number.isFinite(maxIdx)) {
    container.textContent = "予測期間内に開花に到達しないため、グラフを表示できません。";
    el("alpha-chart-legend").innerHTML = "";
    return;
  }
  if (minIdx === maxIdx) {
    minIdx -= 24;
    maxIdx += 24;
  } else {
    const pad = Math.round((maxIdx - minIdx) * 0.08);
    minIdx -= pad;
    maxIdx += pad;
  }

  const x = (alpha) => margin.left + ((alpha - ALPHA_MIN) / (ALPHA_MAX - ALPHA_MIN)) * plotW;
  const y = (idx) => margin.top + plotH - ((idx - minIdx) / (maxIdx - minIdx)) * plotH;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "平年値との差(alpha)と開花日の関係グラフ");

  const gridGroup = document.createElementNS(svgNS, "g");
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const idxVal = minIdx + ((maxIdx - minIdx) / yTicks) * i;
    const gy = y(idxVal);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", margin.left);
    line.setAttribute("x2", width - margin.right);
    line.setAttribute("y1", gy);
    line.setAttribute("y2", gy);
    line.setAttribute("class", "grid-line");
    gridGroup.appendChild(line);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", margin.left - 8);
    label.setAttribute("y", gy);
    label.setAttribute("class", "axis-label");
    label.setAttribute("text-anchor", "end");
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = formatDate(indexToDate(result.seasonStartYear, Math.round(idxVal)));
    gridGroup.appendChild(label);
  }
  for (let a = ALPHA_MIN; a <= ALPHA_MAX; a += 1) {
    const gx = x(a);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", gx);
    label.setAttribute("y", height - margin.bottom + 18);
    label.setAttribute("class", "axis-label");
    label.setAttribute("text-anchor", "middle");
    label.textContent = `${a > 0 ? "+" : ""}${a}℃`;
    gridGroup.appendChild(label);
  }
  svg.appendChild(gridGroup);

  for (const [name, rows] of Object.entries(result.sweepResults)) {
    for (const [key, dash] of [["bloomStartIndex", null], ["fullBloomIndex", "6 4"]]) {
      let d = "";
      let started = false;
      for (const r of rows) {
        const idx = r[key];
        if (idx === null) continue;
        const cmd = started ? "L" : "M";
        d += `${cmd}${x(r.alpha).toFixed(1)},${y(idx).toFixed(1)} `;
        started = true;
      }
      if (!started) continue;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", d.trim());
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", CULTIVAR_COLORS[name] || "#333");
      path.setAttribute("class", "alpha-curve");
      if (dash) path.setAttribute("stroke-dasharray", dash);
      svg.appendChild(path);
    }
  }

  const yAxisTitle = document.createElementNS(svgNS, "text");
  yAxisTitle.setAttribute("class", "axis-title");
  yAxisTitle.setAttribute("x", -(margin.top + plotH / 2));
  yAxisTitle.setAttribute("y", 14);
  yAxisTitle.setAttribute("text-anchor", "middle");
  yAxisTitle.setAttribute("transform", "rotate(-90)");
  yAxisTitle.textContent = "予測日";
  svg.appendChild(yAxisTitle);

  const xAxisTitle = document.createElementNS(svgNS, "text");
  xAxisTitle.setAttribute("class", "axis-title");
  xAxisTitle.setAttribute("x", margin.left + plotW / 2);
  xAxisTitle.setAttribute("y", height - 4);
  xAxisTitle.setAttribute("text-anchor", "middle");
  xAxisTitle.textContent = "平年値との差（℃）";
  svg.appendChild(xAxisTitle);

  container.appendChild(svg);

  const legend = el("alpha-chart-legend");
  legend.innerHTML = "";
  for (const name of Object.keys(result.sweepResults)) {
    const li = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = CULTIVAR_COLORS[name] || "#333";
    const text = document.createElement("span");
    text.textContent = `${name}（実線=開花始、破線=満開）`;
    li.append(swatch, text);
    legend.appendChild(li);
  }
}

async function handlePredict() {
  const stid = el("station-select").value;
  const calcYear = Number(el("calc-year").value);
  const lastActualValue = el("last-actual-date").value;
  const lastActualYmd = lastActualValue ? dateInputToYmd(lastActualValue) : null;

  if (!stid || !calcYear) return;

  el("predict-status").textContent = "予測計算中…";
  el("result-section").classList.add("hidden");
  el("predict-btn").disabled = true;
  try {
    const result = await predictFloweringRange(stid, calcYear, { lastActualYmd });
    renderResults(result);
    el("predict-status").textContent = "";
  } catch (err) {
    el("predict-status").textContent = "エラー: " + err.message;
  } finally {
    el("predict-btn").disabled = false;
  }
}

async function init() {
  await populateStationSelect();
  el("calc-year").value = defaultCalcYear();
  el("predict-btn").addEventListener("click", handlePredict);
}

init();
