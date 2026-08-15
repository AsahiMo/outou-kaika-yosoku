// index.js — Cloudflare Worker
// 気象庁「過去の気象データ・ダウンロード」(obsdl) の気温データ取得プロキシAPI。
// AppleScabプロジェクトのamedas-proxy(src/index.js)を、気温のみに絞って移植したもの。
// 詳細仕様は docs/amedas-obsdl-guide.md を参照。
//
// GET /api/temperature?station=s47588&from=20230901&to=20240229
//   station: obsdlの地点番号(stid)。例: 山形(官署)="s47588"、東根(AMeDAS専用)="a1488"
//   from, to: YYYYMMDD形式
//
// 返り値: { station, from, to, hourly: [{ year, month, day, hour, temperature }, ...] }
//
// ⚠️ obsdlは気象庁の公式APIではありません。ページの実装変更で動作しなくなる
// 可能性がある前提で利用してください。

const OBSDL_INDEX = "https://www.data.jma.go.jp/risk/obsdl/index.php";
const OBSDL_SHOW = "https://www.data.jma.go.jp/risk/obsdl/show/table";
const ELEMENT_CODE_TEMPERATURE = "201";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname !== "/api/temperature") {
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    }

    const station = url.searchParams.get("station");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    if (!station || !from || !to) {
      return json({ error: "station, from, to は必須パラメータです" }, 400);
    }
    if (!/^(s\d{5}|a\d{4})$/.test(station)) {
      return json({ error: 'station は obsdlのstid形式（例: "s47588" や "a1488"）で指定してください' }, 400);
    }
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
      return json({ error: "from, to は YYYYMMDD 形式で指定してください" }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const csvText = await fetchObsdlCsv(station, from, to);
      const hourly = parseObsdlCsv(csvText);
      const response = json({ station, from, to, hourly });
      response.headers.set("Cache-Control", "public, max-age=21600"); // 6時間キャッシュ
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 502);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

async function fetchObsdlCsv(station, from, to) {
  const indexRes = await fetch(OBSDL_INDEX, { method: "GET" });
  const setCookie = indexRes.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";")[0];

  const fy = from.slice(0, 4), fm = String(Number(from.slice(4, 6))), fd = String(Number(from.slice(6, 8)));
  const ty = to.slice(0, 4), tm = String(Number(to.slice(4, 6))), td = String(Number(to.slice(6, 8)));

  const payload = {
    stationNumList: JSON.stringify([station]),
    aggrgPeriod: "9", // 9 = 時別値
    elementNumList: JSON.stringify([[ELEMENT_CODE_TEMPERATURE, ""]]),
    interAnnualType: "1",
    ymdList: JSON.stringify([fy, ty, fm, tm, fd, td]),
    optionNumList: JSON.stringify([]),
    downloadFlag: "true",
    rmkFlag: "1",
    disconnectFlag: "1",
    youbiFlag: "0",
    fukenFlag: "0",
    kijiFlag: "0",
    csvFlag: "1",
    jikantaiFlag: "0",
    jikantaiList: JSON.stringify([1, 24]),
    ymdLiteral: "0",
  };

  const body = new URLSearchParams(payload).toString();

  const res = await fetch(OBSDL_SHOW, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": sessionCookie,
      "User-Agent": "Mozilla/5.0 (compatible; OutouKaikaYosokuApp/1.0)",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`obsdlへのリクエストに失敗しました (HTTP ${res.status})`);
  }

  const buffer = await res.arrayBuffer();
  return new TextDecoder("shift_jis").decode(buffer);
}

function parseObsdlCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);

  const dataStartIndex = lines.findIndex((l) => /^\d{4},\d{1,2},\d{1,2},\d{1,2},/.test(l));
  if (dataStartIndex === -1) {
    throw new Error(
      "CSVのデータ行を検出できませんでした。先頭数行: " + lines.slice(0, 8).join(" | ")
    );
  }

  return lines.slice(dataStartIndex).map((line) => {
    const cols = line.split(",");
    const [year, month, day, hour, temperature] = cols;
    return {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      temperature: temperature === "" || temperature === undefined ? null : Number(temperature),
    };
  });
}
