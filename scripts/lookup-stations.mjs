// lookup-stations.mjs — obsdlの地点マスタから、都道府県内の観測地点一覧
// （stid・地点名・緯度経度・観測要素フラグ）を取得する。
//
// 使い方:
//   node scripts/lookup-stations.mjs <pd>        # 都道府県コード指定
//   node scripts/lookup-stations.mjs --list-pd    # 都道府県コード一覧を表示
//
// 詳細仕様は docs/amedas-obsdl-guide.md の3節を参照。

const STATION_RE = /title="([\s\S]*?)"[^>]*>\s*<input type="hidden" name="stid" value="([^"]*)">\s*<input type="hidden" name="stname" value="([^"]*)">\s*<input type="hidden" name="prid" value="([^"]*)">\s*<input type="hidden" name="kansoku" value="([^"]*)">/g;

async function fetchStationHtml(pd) {
  const res = await fetch("https://www.data.jma.go.jp/risk/obsdl/top/station", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `pd=${pd}`,
  });
  return res.text();
}

export async function listPrefectureCodes() {
  const html = await fetchStationHtml("00");
  return [...html.matchAll(/id="pr(\d+)"/g)].map((m) => m[1]);
}

export async function listStations(pd) {
  const html = await fetchStationHtml(pd);
  const stations = [];
  const seen = new Set();
  for (const m of html.matchAll(STATION_RE)) {
    const [, title, stid, stname, prid, kansoku] = m;
    if (stid.startsWith("h")) continue; // グループ項目は除外
    if (seen.has(stid)) continue; // タイトルパターンが2回出現するため重複除去
    seen.add(stid);
    stations.push({ stid, stname, prid, kansoku, ...parseTitle(title) });
  }
  return stations;
}

function parseTitle(title) {
  const latM = title.match(/北緯：(\d+)度([\d.]+)分/);
  const lonM = title.match(/東経：(\d+)度([\d.]+)分/);
  const altM = title.match(/標高：([\-\d.]+)m/);
  const lat = latM ? Number(latM[1]) + Number(latM[2]) / 60 : null;
  const lon = lonM ? Number(lonM[1]) + Number(lonM[2]) / 60 : null;
  const alt = altM ? Number(altM[1]) : null;
  return { lat, lon, alt };
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg === "--list-pd") {
    const codes = await listPrefectureCodes();
    console.log(codes.join(", "));
  } else if (arg) {
    const stations = await listStations(arg);
    for (const s of stations) {
      console.log(`${s.stid}\t${s.stname}\tkansoku=${s.kansoku}\tlat=${s.lat?.toFixed(4)}\tlon=${s.lon?.toFixed(4)}\talt=${s.alt}`);
    }
  } else {
    console.error("使い方: node scripts/lookup-stations.mjs <pd> | --list-pd");
    process.exit(1);
  }
}
