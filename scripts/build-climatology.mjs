// build-climatology.mjs — 過去N シーズン分（既定10年）の生データ(data/raw/)から、
// 「9/1からの通し日数 × 時刻」ごとの平均気温（気候値）を計算し、
// data/climatology/<stid>.json に保存する。
//
// 気候値は、実測データが存在しない期間（まだ観測されていない今シーズンの
// 未来日）の代わりに使う予測用データとして使う。開花予測式は別途用意予定で、
// このスクリプトはあくまで「平均値をどう計算し、どこに保存するか」を
// 確立するためのもの。
//
// 使い方:
//   node scripts/build-climatology.mjs <stid> [--years 10] [--end <seasonStartYear>] [--force]
//
// 例:
//   node scripts/build-climatology.mjs s47588 --years 10 --end 2023
//     -> 2014/9/1season 〜 2023/9/1season（2014〜2023の10シーズン、
//        すなわち2014/9/1〜2024/8/31の実データ）から気候値を作成
//
// 通し日数(dayCount)は 9/1=1 〜 最大366（うるう年を含むシーズンのみ366まで
// 存在）。同じ通し日数同士（例: 全シーズンの「120日目」）を平均することで、
// うるう年による2/29以降の暦日ズレを、通し日数ベースでは意識せずに済む
// ようにしている。

import { fetchSeason } from "./fetch-season.mjs";
import { seasonDayCount, seasonLength, dayCountToLabel } from "./season-calendar.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_CLIMATOLOGY_DIR = path.join(__dirname, "..", "data", "climatology");

const MAX_DAY_COUNT = 366;
const HOURS = 24;

export async function buildClimatology(stid, { years = 10, endSeasonStartYear, force = false } = {}) {
  const end = endSeasonStartYear ?? defaultEndSeasonStartYear();
  const seasonStartYears = [];
  for (let y = end - years + 1; y <= end; y++) seasonStartYears.push(y);

  // sum[dayCount][hour], count[dayCount][hour] (dayCount, hourともに1始まりなので配列は+1のサイズ)
  const sum = Array.from({ length: MAX_DAY_COUNT + 1 }, () => new Array(HOURS + 1).fill(0));
  const count = Array.from({ length: MAX_DAY_COUNT + 1 }, () => new Array(HOURS + 1).fill(0));

  const seasonsUsed = [];
  for (const seasonStartYear of seasonStartYears) {
    let result;
    try {
      result = await fetchSeason(stid, seasonStartYear, { force });
      // obsdl(気象庁の非公式インターフェース)への連続リクエストを避けるため、
      // 実際にネットワーク取得が発生した場合のみ少し間隔を空ける
      if (!result.cached) await sleep(300);
    } catch (err) {
      console.warn(`[警告] シーズン${seasonStartYear}の取得に失敗、スキップします: ${err.message}`);
      continue;
    }

    for (const rec of result.data.records) {
      if (rec.temperature === null) continue;
      const dayCount = seasonDayCount(seasonStartYear, rec.year, rec.month, rec.day);
      if (dayCount < 1 || dayCount > MAX_DAY_COUNT) continue; // 想定外の日付は無視
      sum[dayCount][rec.hour] += rec.temperature;
      count[dayCount][rec.hour] += 1;
    }
    seasonsUsed.push(seasonStartYear);
  }

  if (seasonsUsed.length === 0) {
    throw new Error("有効なシーズンデータが1件も取得できませんでした");
  }

  // ラベル表示は、対象シーズンのうち閏年を含むシーズン（366日ある年）を優先的に基準にする
  const labelReferenceYear = seasonStartYears.find((y) => seasonLength(y) === MAX_DAY_COUNT) ?? seasonStartYears[0];

  const days = [];
  for (let dayCount = 1; dayCount <= MAX_DAY_COUNT; dayCount++) {
    const hours = [];
    for (let hour = 1; hour <= HOURS; hour++) {
      const n = count[dayCount][hour];
      hours.push({
        hour,
        meanTemperature: n > 0 ? round2(sum[dayCount][hour] / n) : null,
        sampleCount: n,
      });
    }
    days.push({
      day: dayCount,
      labelSample: dayCountToLabel(labelReferenceYear, dayCount),
      hours,
    });
  }

  applyKzSmoothing(days);

  const climatology = {
    stid,
    seasonStartMonthDay: "09-01",
    dayCountMax: MAX_DAY_COUNT,
    hoursPerDay: HOURS,
    yearsRequested: years,
    seasonStartYearsUsed: seasonsUsed,
    generatedAt: new Date().toISOString(),
    method:
      "各シーズンをseasonStartYearの9/1を1日目とする通し日数(1-366)に変換し、" +
      "同じ通し日数×同じ時刻(1-24)の実測気温をシーズン横断で単純平均(meanTemperature)。" +
      "うるう年の2/29は通し日数を1つ増やすだけで、暦日そのものでは揃えない" +
      "（通し日数ベースで開花予測を行う前提のため）。day=366は366日あるシーズン" +
      "（=2月に閏日を含むシーズン）のみが寄与するため、他日よりsampleCountが少ない。" +
      "meanTemperatureに対し、同じ時刻(hour)ごとに通し日数の軸で" +
      "前後3日(クリップ付き、7点)移動平均を3回適用したものがk1→k2→k3(=normal、開花予測で使う平年値)。",
    days,
  };

  const outPath = path.join(DATA_CLIMATOLOGY_DIR, `${stid}.json`);
  await mkdir(DATA_CLIMATOLOGY_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(climatology), "utf-8");

  return { path: outPath, climatology };
}

function defaultEndSeasonStartYear() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jstNow.getUTCFullYear();
  const m = jstNow.getUTCMonth() + 1;
  const currentSeasonStartYear = m >= 9 ? y : y - 1;
  // 今シーズンはまだ進行中(未完了)なので、完了している直近シーズンを既定の終端にする
  return currentSeasonStartYear - 1;
}

// 「平均気温(meanTemperature)」に対し、同じ時刻(hour)ごとに通し日数(day)の軸で
// 前後3日(端はクリップ、最大7点)の移動平均を3回繰り返すKZフィルタを適用し、
// k1・k2・k3(=normal、開花予測式が使う「平年値」)を各hourエントリに追加する。
// 端(季節の最初・最後の数日)ではmin/maxでクリップし、常に対称な窓
// （データが足りない端では自然に縮む窓）になるようにしている。
function applyKzSmoothing(days) {
  const n = days.length;
  for (let hourIdx = 0; hourIdx < HOURS; hourIdx++) {
    let series = days.map((d) => d.hours[hourIdx].meanTemperature);
    let k1, k2, k3;
    series = kzPass(series, n);
    k1 = series;
    series = kzPass(series, n);
    k2 = series;
    series = kzPass(series, n);
    k3 = series;
    for (let i = 0; i < n; i++) {
      const h = days[i].hours[hourIdx];
      h.k1 = round2OrNull(k1[i]);
      h.k2 = round2OrNull(k2[i]);
      h.k3 = round2OrNull(k3[i]);
      h.normal = h.k3; // 開花予測式が使う「平年値」
    }
  }
}

function kzPass(series, n) {
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 3);
    const hi = Math.min(n - 1, i + 3);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= hi; j++) {
      if (series[j] !== null) {
        sum += series[j];
        cnt++;
      }
    }
    out[i] = cnt > 0 ? sum / cnt : null;
  }
  return out;
}

function round2OrNull(n) {
  return n === null ? null : Math.round(n * 100) / 100;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CLIとして直接実行された場合
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const stid = args[0];
  if (!stid) {
    console.error("使い方: node scripts/build-climatology.mjs <stid> [--years 10] [--end <seasonStartYear>] [--force]");
    process.exit(1);
  }

  const years = args.includes("--years") ? Number(args[args.indexOf("--years") + 1]) : 10;
  const endSeasonStartYear = args.includes("--end") ? Number(args[args.indexOf("--end") + 1]) : undefined;
  const force = args.includes("--force");

  const { path: outPath, climatology } = await buildClimatology(stid, { years, endSeasonStartYear, force });
  const totalSamples = climatology.days.reduce(
    (acc, d) => acc + d.hours.reduce((a, h) => a + h.sampleCount, 0),
    0
  );
  console.log(
    `[完了] ${outPath}\n` +
    `  対象シーズン: ${climatology.seasonStartYearsUsed.join(", ")}\n` +
    `  総サンプル数(時間単位の平均に使われた実測値の合計): ${totalSamples}`
  );
}
