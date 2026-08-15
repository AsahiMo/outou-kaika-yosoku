// obsdl-client.mjs — 気象庁「過去の気象データ・ダウンロード」(obsdl) から
// 時別の気温データを取得するクライアント。
//
// 詳細仕様は docs/amedas-obsdl-guide.md を参照（AppleScabプロジェクトの
// src/index.js をNode.js向けに移植したもの）。
//
// ⚠️ obsdlは公式に仕様が公開されているAPIではない。ページ実装の変更で
// 動作しなくなる可能性がある前提で利用すること。

const OBSDL_INDEX = "https://www.data.jma.go.jp/risk/obsdl/index.php";
const OBSDL_SHOW = "https://www.data.jma.go.jp/risk/obsdl/show/table";

const ELEMENT_CODE_TEMPERATURE = "201";

// 1リクエストあたりの上限（obsdl側JSの制限式: 地点数×項目数×時間数/44000<=1）。
// 1地点・1項目(気温のみ)の場合、時間数の上限 = 44000 時間 ≒ 1833日。
// 安全マージンを見て900日を超える場合は分割を推奨する。
export const MAX_DAYS_PER_REQUEST = 900;

/**
 * 指定地点・指定期間(YYYYMMDD)の時別気温データを取得する。
 * @param {string} stid obsdlの地点番号（例: "s47662", "a0365"）
 * @param {string} fromYmd 開始日 YYYYMMDD
 * @param {string} toYmd 終了日 YYYYMMDD
 * @returns {Promise<Array<{year:number, month:number, day:number, hour:number, temperature: number|null}>>}
 */
export async function fetchHourlyTemperature(stid, fromYmd, toYmd) {
  if (!/^(s\d{5}|a\d{4})$/.test(stid)) {
    throw new Error(`stidの形式が不正です: ${stid}`);
  }
  if (!/^\d{8}$/.test(fromYmd) || !/^\d{8}$/.test(toYmd)) {
    throw new Error("from/to は YYYYMMDD 形式で指定してください");
  }

  const csvText = await fetchObsdlCsv(stid, fromYmd, toYmd);
  return parseObsdlCsv(csvText);
}

async function fetchObsdlCsv(stid, fromYmd, toYmd) {
  const indexRes = await fetch(OBSDL_INDEX, { method: "GET" });
  const setCookie = indexRes.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";")[0];

  const fy = fromYmd.slice(0, 4), fm = String(Number(fromYmd.slice(4, 6))), fd = String(Number(fromYmd.slice(6, 8)));
  const ty = toYmd.slice(0, 4), tm = String(Number(toYmd.slice(4, 6))), td = String(Number(toYmd.slice(6, 8)));

  const payload = {
    stationNumList: JSON.stringify([stid]),
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
      "User-Agent": "Mozilla/5.0 (compatible; OutouKaikaYosoku/0.1)",
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
    // 気温のみ取得する場合の列: [年, 月, 日, 時, 気温, 品質情報, 均質番号]
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
