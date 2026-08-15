// fetch-season.mjs — 指定地点・指定シーズン(9/1〜翌8/31)の時別気温をobsdlから取得し、
// data/raw/<stid>/<seasonStartYear>.json に生データとしてキャッシュする。
//
// 使い方:
//   node scripts/fetch-season.mjs <stid> <seasonStartYear> [--force]
//
// 例:
//   node scripts/fetch-season.mjs s47588 2023   # 山形、2023/9/1〜2024/8/31
//
// 生データを一度キャッシュしておくことで、
//   - 気候値（平均値）の計算方法を後で変更しても取得し直さずに再集計できる
//   - obsdl側への再リクエストを避けられる（サーバー負荷軽減・obsdl仕様変更時の記録としても残る）
// という理由からキャッシュ層を独立させている。集計済みの平均値(気候値)は
// data/climatology/ 以下に別途保存する（build-climatology.mjs 参照）。

import { fetchHourlyTemperature } from "./obsdl-client.mjs";
import { seasonRange, todayYmdJst, addDaysYmd } from "./season-calendar.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_RAW_DIR = path.join(__dirname, "..", "data", "raw");

export async function fetchSeason(stid, seasonStartYear, { force = false } = {}) {
  const outDir = path.join(DATA_RAW_DIR, stid);
  const outPath = path.join(outDir, `${seasonStartYear}.json`);

  if (!force) {
    try {
      const existing = JSON.parse(await readFile(outPath, "utf-8"));
      return { path: outPath, data: existing, cached: true };
    } catch {
      // キャッシュなし。取得を続行。
    }
  }

  const { fromYmd, toYmd: seasonEndYmd } = seasonRange(seasonStartYear);

  // obsdlは直近1日分を持たないため、終了日を「昨日」に丸める
  const yesterday = addDaysYmd(todayYmdJst(), -1);
  const toYmd = seasonEndYmd < yesterday ? seasonEndYmd : yesterday;

  if (fromYmd > toYmd) {
    throw new Error(
      `シーズン ${seasonStartYear} (${fromYmd}〜${seasonEndYmd}) はまだ開始していません（取得可能な最終日: ${yesterday}）`
    );
  }

  const records = await fetchHourlyTemperature(stid, fromYmd, toYmd);

  const data = {
    stid,
    seasonStartYear,
    fromYmd,
    toYmdRequested: seasonEndYmd,
    toYmdActual: toYmd,
    complete: toYmd === seasonEndYmd, // シーズンが最後まで確定データで埋まっているか
    fetchedAt: new Date().toISOString(),
    records,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(data, null, 2), "utf-8");

  return { path: outPath, data, cached: false };
}

// CLIとして直接実行された場合
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stid, seasonStartYearArg, ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");

  if (!stid || !seasonStartYearArg) {
    console.error("使い方: node scripts/fetch-season.mjs <stid> <seasonStartYear> [--force]");
    process.exit(1);
  }

  const seasonStartYear = Number(seasonStartYearArg);
  const { path: outPath, cached, data } = await fetchSeason(stid, seasonStartYear, { force });
  console.log(
    `${cached ? "[キャッシュ利用]" : "[取得完了]"} ${outPath} ` +
    `(${data.records.length}件, ${data.fromYmd}〜${data.toYmdActual}, complete=${data.complete})`
  );
}
