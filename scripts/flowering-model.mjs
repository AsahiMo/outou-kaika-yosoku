// flowering-model.mjs — おうとう(桜桃)の休眠打破(チルユニット)・発育速度(DTS)モデル。

/**
 * チルユニット(1時間あたりの低温要求量)を計算する。
 * @param {number} te 気温(℃)
 * @param {number} tu 上限温度(℃)。これを超えるとチル蓄積なし
 * @param {number} td 下限温度(℃)。これを下回るとチル蓄積なし
 * @param {number} m チルユニットの下限値（通常は負の小さな値で、高温による打ち消しを表す）
 */
export function chillUnit(te, tu, td, m) {
  if (te < td) return 0;
  let chill = (4 * (tu - te) * (te - td)) / (tu - td) ** 2;
  if (chill < m) chill = m;
  return chill;
}

/**
 * MCR(モデュレーション係数)。休眠打破の進み具合(チル完了率 CR/cur)に応じて
 * 発育速度をどれだけ発現させるかを0〜1で返す。
 * @param {number} cr その時点までの累積チルユニット
 * @param {number} cur 休眠打破に必要な累積チルユニット(品種パラメータ)
 */
export function mcr(cr, cur) {
  const cs = cr / cur;
  if (cs < 0.55) return 0;
  if (cs < 1.2) return 1.041 / (1 + Math.exp(-16 * (cs - 1)));
  return 1;
}

/**
 * DTS(1時間あたりの発育量)。気温によるシグモイド発育速度に、
 * 休眠打破の進み具合(mcr)を掛け合わせる。
 * @param {number} te 気温(℃)
 * @param {number} cr その時点までの累積チルユニット
 * @param {number} cur 品種パラメータ(mcr参照)
 * @param {number} d 発育速度の下限値(品種パラメータ)
 */
export function dt(te, cr, cur, d) {
  const m = mcr(cr, cur);
  let dtVal = 25 / (1 + Math.exp(-0.185 * (te - 18.4))) + 0.5;
  if (dtVal < d) dtVal = d;
  return dtVal * m;
}
