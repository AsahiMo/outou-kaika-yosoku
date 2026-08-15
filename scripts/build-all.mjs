// build-all.mjs — data/target-stations.json に登録された全地点について、
// 過去N年分(既定10年)の気候値をまとめて作成する。
//
// 使い方:
//   node scripts/build-all.mjs [--years 10] [--end <seasonStartYear>] [--force]

import { buildClimatology } from "./build-climatology.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const years = args.includes("--years") ? Number(args[args.indexOf("--years") + 1]) : 10;
const endSeasonStartYear = args.includes("--end") ? Number(args[args.indexOf("--end") + 1]) : undefined;
const force = args.includes("--force");

const targetPath = path.join(__dirname, "..", "data", "target-stations.json");
const target = JSON.parse(await readFile(targetPath, "utf-8"));

for (const [stid, info] of Object.entries(target.stations)) {
  console.log(`\n=== ${info.name} (${stid}) ===`);
  try {
    const { climatology } = await buildClimatology(stid, { years, endSeasonStartYear, force });
    const totalSamples = climatology.days.reduce(
      (acc, d) => acc + d.hours.reduce((a, h) => a + h.sampleCount, 0),
      0
    );
    console.log(`  対象シーズン: ${climatology.seasonStartYearsUsed.join(", ")}`);
    console.log(`  総サンプル数: ${totalSamples}`);
  } catch (err) {
    console.error(`  [エラー] ${info.name} (${stid}): ${err.message}`);
  }
}
