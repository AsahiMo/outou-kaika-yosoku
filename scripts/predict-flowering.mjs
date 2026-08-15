// predict-flowering.mjs — おうとう(桜桃)の開花予測ロジック。
// チルユニット(休眠打破)・DTS発育量(flowering-model.mjs)を1時間おきに積算し、
// 各品種の開花始(積算発育量がgdhStartを超えた時刻)・満開(gdhFullを超えた時刻)を求める。
//
// 気温データは、前年9/1〜計算年5月末相当(273日、6552時間)について、
//   - 実測データ(data/raw/、fetch-season.mjs)があればそれを使う
//   - 実測データがない(欠測、またはまだ観測されていない未来)場合は気候値
//     (data/climatology/、build-climatology.mjsが計算するKZフィルタ後の平年値=normal)で埋める。
//     ただし「実測データが存在する最後の時刻」より後(=未来分)は、平年値に
//     temperatureAlpha(「平年値との差」。ユーザーがその年の気象傾向に合わせて
//     ±5℃程度の幅で手動調整する想定、既定0)を加える。
//
// 使い方:
//   node scripts/predict-flowering.mjs <stid> <calcYear> [--alpha <数値>]
//
// 例:
//   node scripts/predict-flowering.mjs s47588 2024 --alpha 0
//     -> 2023/9/1〜2024年春の山形地点データから2024年の開花予測

import { fetchSeason } from "./fetch-season.mjs";
import { seasonDayCount } from "./season-calendar.mjs";
import { chillUnit, dt as growthDt } from "./flowering-model.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEASON_DAYS = 273; // 9/1 〜 翌5/31相当
const HOURS_PER_DAY = 24;
const TOTAL_HOURS = SEASON_DAYS * HOURS_PER_DAY; // 6552

export async function predictFlowering(stid, calcYear, { temperatureAlpha = 0 } = {}) {
  const seasonStartYear = calcYear - 1;

  const [{ data: seasonData }, climatology, cultivarParams] = await Promise.all([
    fetchSeason(stid, seasonStartYear),
    loadClimatology(stid),
    loadCultivarParams(),
  ]);

  // 通し日数×時刻 -> 実測気温 のインデックス(0始まり、9/1の1時=0)を作る
  const actualByIndex = new Map();
  for (const rec of seasonData.records) {
    if (rec.temperature === null) continue;
    const dayCount = seasonDayCount(seasonStartYear, rec.year, rec.month, rec.day);
    if (dayCount < 1 || dayCount > SEASON_DAYS) continue;
    const idx = (dayCount - 1) * HOURS_PER_DAY + (rec.hour - 1);
    actualByIndex.set(idx, rec.temperature);
  }

  const lastObservedIndex = actualByIndex.size > 0 ? Math.max(...actualByIndex.keys()) : -1;

  const climByIndex = new Map();
  for (const day of climatology.days) {
    if (day.day > SEASON_DAYS) continue;
    for (const h of day.hours) {
      const idx = (day.day - 1) * HOURS_PER_DAY + (h.hour - 1);
      climByIndex.set(idx, h.normal);
    }
  }

  const temps = new Array(TOTAL_HOURS);
  const source = new Array(TOTAL_HOURS); // "actual" | "gap" | "future"
  for (let idx = 0; idx < TOTAL_HOURS; idx++) {
    if (actualByIndex.has(idx)) {
      temps[idx] = actualByIndex.get(idx);
      source[idx] = "actual";
      continue;
    }
    const normal = climByIndex.get(idx);
    if (normal === null || normal === undefined) {
      throw new Error(`気候値が見つかりません: stid=${stid} idx=${idx}`);
    }
    if (idx <= lastObservedIndex) {
      temps[idx] = normal; // 実測期間内の欠測 -> 平年値そのまま
      source[idx] = "gap";
    } else {
      temps[idx] = normal + temperatureAlpha; // 未来分 -> 平年値+補正
      source[idx] = "future";
    }
  }

  const gapCount = source.filter((s) => s === "gap").length;
  const futureCount = source.filter((s) => s === "future").length;

  const cultivars = {};
  for (const [name, p] of Object.entries(cultivarParams)) {
    cultivars[name] = accumulateAndFindDates(temps, p, seasonStartYear);
  }

  return {
    stid,
    calcYear,
    seasonStartYear,
    temperatureAlpha,
    lastObservedIndex,
    lastObservedDate: lastObservedIndex >= 0 ? indexToDate(seasonStartYear, lastObservedIndex) : null,
    gapHours: gapCount,
    futureHours: futureCount,
    cultivars,
  };
}

function accumulateAndFindDates(temps, params, seasonStartYear) {
  let chill = 0;
  let growth = 0;
  let startIndex = null;
  let fullIndex = null;

  for (let idx = 0; idx < temps.length; idx++) {
    const te = temps[idx];

    chill += chillUnit(te, params.tu, params.td, params.m);
    if (chill < 0) chill = 0;

    growth += growthDt(te, chill, params.cur, params.d);

    if (startIndex === null && growth > params.gdhStart) startIndex = idx;
    if (fullIndex === null && growth > params.gdhFull) fullIndex = idx;
  }

  return {
    bloomStartDate: startIndex !== null ? indexToDate(seasonStartYear, startIndex) : null,
    fullBloomDate: fullIndex !== null ? indexToDate(seasonStartYear, fullIndex) : null,
    finalChillUnit: round2(chill),
    finalGrowth: round2(growth),
  };
}

function indexToDate(seasonStartYear, idx) {
  // idx=0 は季節開始日(9/1)の1時。季節開始日0時からidx+1時間後として計算する。
  const ms = Date.UTC(seasonStartYear, 8, 1) + (idx + 1) * 3600 * 1000;
  return new Date(ms).toISOString();
}

async function loadClimatology(stid) {
  const p = path.join(__dirname, "..", "data", "climatology", `${stid}.json`);
  return JSON.parse(await readFile(p, "utf-8"));
}

async function loadCultivarParams() {
  const p = path.join(__dirname, "..", "data", "cultivar-params.json");
  const data = JSON.parse(await readFile(p, "utf-8"));
  return data.cultivars;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// CLIとして直接実行された場合
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const stid = args[0];
  const calcYear = Number(args[1]);
  const alphaArgIdx = args.indexOf("--alpha");
  const temperatureAlpha = alphaArgIdx >= 0 ? Number(args[alphaArgIdx + 1]) : 0;

  if (!stid || !calcYear) {
    console.error("使い方: node scripts/predict-flowering.mjs <stid> <calcYear> [--alpha <数値>]");
    process.exit(1);
  }

  const result = await predictFlowering(stid, calcYear, { temperatureAlpha });
  console.log(JSON.stringify(result, null, 2));
}
