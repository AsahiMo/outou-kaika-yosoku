// config.js — デプロイ環境に応じて書き換える設定値。
//
// WORKER_BASE: obsdlプロキシ(Cloudflare Worker, src/index.js)のデプロイ先URL。
// `npm run worker:deploy`（内部で`wrangler deploy`）を実行すると表示されるURLに
// 書き換えてください。ローカルで`wrangler dev`を使う場合は
// "http://127.0.0.1:8787" 等に変更してください。
export const WORKER_BASE = "https://outou-kaika-amedas-proxy.my-worker-o.workers.dev";
