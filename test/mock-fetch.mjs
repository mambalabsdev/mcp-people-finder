// Preloaded with `node --import` by test/start-poll.test.js. Replaces fetch
// with an offline Apify stand in and logs every request the server makes, so
// the test can assert the start and poll sequence without a token or a network.
import { appendFileSync } from "node:fs";

const LOG = process.env.MOCK_FETCH_LOG;
const STATUS = process.env.MOCK_RUN_STATUS ?? "SUCCEEDED";
let polls = 0;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  if (LOG) appendFileSync(LOG, JSON.stringify({ method, url: u, body: init.body ?? null }) + "\n");
  if (method === "POST" && /\/v2\/acts\/[^/]+\/runs\?/.test(u)) {
    return json(201, { data: { id: "run_mock_1", status: "READY", defaultDatasetId: "ds_mock_1" } });
  }
  if (method === "GET" && u.endsWith("/v2/actor-runs/run_mock_1")) {
    polls += 1;
    return json(200, { data: { status: polls < 2 ? "RUNNING" : STATUS, defaultDatasetId: "ds_mock_1" } });
  }
  if (method === "GET" && u.includes("/v2/datasets/ds_mock_1/items")) {
    return json(200, [{ row_status: "ok", mock: true }]);
  }
  return json(500, { error: { message: `unexpected request in test: ${method} ${u}` } });
};
