// season-calendar.mjs — 「9月1日始まりのシーズン」と「9月1日からの通し日数」を扱うユーティリティ。
//
// 開花予測では、うるう年（2月29日の有無）による日付のズレを吸収するため、
// カレンダー上の月日ではなく「シーズン開始日（9/1）からの通し日数」を
// 気候値テーブルのキーとして使う。これにより、うるう年か平年かで
// if分岐を書く必要がなくなる（2/29は単に「通し日数が1つ多い年」として
// 自然に扱われる）。
//
// シーズンは "seasonStartYear" で表す。例: seasonStartYear=2024 のシーズンは
// 2024/9/1 〜 2025/8/31（2025年が閏年でなければ365日、閏年なら366日）。

/** シーズン開始年から、そのシーズンの [fromYmd, toYmd]（ともにYYYYMMDD文字列）を返す */
export function seasonRange(seasonStartYear) {
  const fromYmd = `${seasonStartYear}0901`;
  const toYmd = `${seasonStartYear + 1}0831`;
  return { fromYmd, toYmd };
}

/**
 * シーズン開始年と、その中の日付(年月日)から、9/1を1日目とした通し日数を返す。
 * 例: seasonStartYear=2024, 2024/9/1 -> 1、2024/12/31 -> 122、2025/2/29 -> 182、
 *     2025/8/31 -> 365 または 366（うるう年の場合）。
 */
export function seasonDayCount(seasonStartYear, year, month, day) {
  const seasonStartUtc = Date.UTC(seasonStartYear, 8, 1); // 9月=月index8
  const targetUtc = Date.UTC(year, month - 1, day);
  const diffDays = Math.round((targetUtc - seasonStartUtc) / 86400000);
  return diffDays + 1;
}

/** そのシーズンの総日数（365 または 366）を返す */
export function seasonLength(seasonStartYear) {
  const { fromYmd, toYmd } = seasonRange(seasonStartYear);
  const fromUtc = Date.UTC(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(4, 6)) - 1, Number(fromYmd.slice(6, 8)));
  const toUtc = Date.UTC(Number(toYmd.slice(0, 4)), Number(toYmd.slice(4, 6)) - 1, Number(toYmd.slice(6, 8)));
  return Math.round((toUtc - fromUtc) / 86400000) + 1;
}

/** 通し日数(1始まり)と時(1-24)から、人が読める "MM/DD" 形式の代表的な月日を返す（平年基準） */
export function dayCountToLabel(seasonStartYear, dayCount) {
  const seasonStartUtc = Date.UTC(seasonStartYear, 8, 1);
  const targetUtc = seasonStartUtc + (dayCount - 1) * 86400000;
  const d = new Date(targetUtc);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/** JST基準の「今日」のYYYYMMDD文字列を返す */
export function todayYmdJst() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** YYYYMMDD文字列に日数を加算した YYYYMMDD文字列を返す（負数で減算） */
export function addDaysYmd(ymd, days) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(4, 6)), d = Number(ymd.slice(6, 8));
  const utc = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}
