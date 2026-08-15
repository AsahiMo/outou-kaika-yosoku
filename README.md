# おうとう開花予測

アメダスの毎時気温データから、おうとう（桜桃）の開花日を予測するプログラム。

気温データの取得・格納（前年9/1以降の実測値＋欠測期間を埋める過去10年平均＝
気候値）と、チルユニット・DTS発育量モデルによる開花予測、それを使うWebアプリを
実装済み。

## Webアプリ

構成はAppleScabプロジェクトと同様（無料枠で運用可能）：

* フロントエンド: GitHub Pages（静的サイト、[frontend/](frontend/)）
* アメダスデータ取得プロキシ: Cloudflare Workers（無料プラン、[src/index.js](src/index.js)）
* 気候値・地点マスタ・品種パラメータは静的JSONとして`frontend/data/`に同梱
  （予測計算自体はブラウザ側のJavaScriptで実行、サーバー側での計算処理は不要）

### デプロイ手順

1. Cloudflare Workersのプロキシをデプロイ
   ```bash
   npm install
   npm run worker:deploy
   ```
   表示されたURL（例: `https://outou-kaika-amedas-proxy.<サブドメイン>.workers.dev`）を
   [frontend/config.js](frontend/config.js)の`WORKER_BASE`に設定する。
2. このリポジトリをGitHubにpushし、リポジトリの Settings → Pages で
   ソースを「GitHub Actions」に設定する（[.github/workflows/pages.yml](.github/workflows/pages.yml)が
   `frontend/`を自動的に公開する）。

### ローカルでの動作確認

```bash
npm install
npm run worker:dev          # Cloudflare Workerをローカル起動（既定 http://127.0.0.1:8787）
python -m http.server 8123 --directory frontend   # 別ターミナルでフロントエンドを起動
```

ローカルで試す場合は[frontend/config.js](frontend/config.js)の`WORKER_BASE`を
一時的に`http://127.0.0.1:8787`に変更する（コミット前に本番URLへ戻すこと）。

## セットアップ（データ取得・気候値計算スクリプト）

Node.js 20以上（組み込みの`fetch`を使用、追加パッケージ不要）。

対象地点は山形県内8地点（山形・東根・村山・新庄・酒田・鶴岡・高畠・米沢。
左沢は標高が高いため除外）で、[data/target-stations.json](data/target-stations.json)
に登録済み。2015〜2024シーズン分の気候値は生成済み（`data/climatology/`）。

## 使い方

### 全地点まとめて気候値を更新する

```bash
node scripts/build-all.mjs --years 10 --end <seasonStartYear>
```

`data/target-stations.json` の全地点について、未取得のシーズンを自動取得しつつ
気候値を再計算する。

### 1地点ずつ扱う場合

#### 1. 観測地点(stid)を調べる（対象地点を追加・変更する場合）

`node scripts/lookup-stations.mjs <pd>`（`pd`は都道府県コード。一覧は
`node scripts/lookup-stations.mjs --list-pd`）で観測地点番号を確認する。

#### 2. 1シーズン分の実測気温を取得（キャッシュ）

```bash
node scripts/fetch-season.mjs <stid> <seasonStartYear>
```

`seasonStartYear` は「9/1始まりのシーズン」の開始年。例えば `2023` を指定すると
2023/9/1〜2024/8/31の分を取得し、`data/raw/<stid>/2023.json` に保存する。
進行中のシーズン（終了日が未来）を指定した場合は、取得可能な直近日（昨日）
までを取得する。

#### 3. 過去10年平均（気候値）を計算

```bash
node scripts/build-climatology.mjs <stid> --years 10 --end <seasonStartYear>
```

未取得のシーズンがあれば自動的に`fetch-season`を呼んで取得する。
結果は `data/climatology/<stid>.json` に保存される（多年平均`meanTemperature`に
加え、KZフィルタ後の平年値`normal`も含む）。

### 開花予測を実行する

```bash
node scripts/predict-flowering.mjs <stid> <calcYear> [--alpha <数値>]
```

`calcYear`年の開花を、前年9/1〜`calcYear`年5/31相当の気温データ(実測+気候値)
から予測する。実測データが存在する最後の時刻より後（＝まだ観測されていない
未来分）は気候値に`--alpha`（℃、既定0）を加えて埋める。佐藤錦・紅秀峰それぞれの
開花始・満開の予測日時をJSONで出力する。

## ディレクトリ構成

```
scripts/
  obsdl-client.mjs       obsdlから時別気温を取得するクライアント
  season-calendar.mjs    9/1始まりシーズン・通し日数(うるう年対応)のユーティリティ
  lookup-stations.mjs    obsdlの地点マスタから都道府県内の観測地点を検索
  fetch-season.mjs       1地点・1シーズン分の実測気温を取得しキャッシュ
  build-climatology.mjs  過去N年分から気候値(平均値+KZフィルタ後の平年値)を計算・保存(1地点)
  build-all.mjs          target-stations.jsonの全地点をまとめて処理
  flowering-model.mjs    チルユニット・MCR・DTS発育速度モデル(純粋関数)
  predict-flowering.mjs  実測+気候値から開花始・満開日時を予測(CLI)
data/
  target-stations.json    対象観測地点一覧(山形県8地点)
  cultivar-params.json    品種(佐藤錦・紅秀峰)ごとの予測式パラメータ
  raw/<stid>/<seasonStartYear>.json   実測データのキャッシュ(gitignore対象)
  climatology/<stid>.json              気候値(過去10年平均・KZフィルタ後平年値)
src/
  index.js               Cloudflare Worker本体(obsdl気温データ取得プロキシAPI)
wrangler.toml            Cloudflare Workersのデプロイ設定
frontend/                GitHub Pagesで公開する静的サイト
  index.html, style.css, app.js  UIと予測ロジック(ブラウザで実行)
  config.js               デプロイ環境ごとのWORKER_BASE設定
  flowering-model.mjs, season-calendar.mjs  scripts/から複製した純粋関数
  data/                   target-stations.json・cultivar-params.json・climatology/のコピー
.github/workflows/pages.yml  GitHub Pagesへの自動デプロイ
```
