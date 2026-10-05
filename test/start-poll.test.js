import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

// The tool called and the arguments it is called with. Any valid call works:
// the point is the request sequence the server makes, not the actor's answer.
const CALL = {"tool":"find_people_and_emails","args":{"domain":"stripe.com"}};
const ACTOR_ID = "LEgloG7tWgQl4o6TD";

// Call one tool on the built server over stdio, with fetch replaced by
// test/mock-fetch.mjs. Returns the tools/call result and the logged requests.
function callTool(runStatus) {
  const log = join(mkdtempSync(join(tmpdir(), "mcp-mock-")), "fetch.log");
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      APIFY_TOKEN: "test-token",
      MOCK_FETCH_LOG: log,
      MOCK_RUN_STATUS: runStatus,
      MAMBA_POLL_INTERVAL_MS: "5",
    };
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(join(here, "mock-fetch.mjs")).href, join(repo, "build", "index.js")],
      { stdio: ["pipe", "pipe", "pipe"], env },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err}`));
    }, 20000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          const requests = existsSync(log)
            ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
            : [];
          resolve({ result: msg.result, requests });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrapper-test", version: "0.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: CALL.tool, arguments: CALL.args } });
  });
}

test("starts the run and polls it, never the synchronous endpoint", async () => {
  const { result, requests } = await callTool("SUCCEEDED");
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(requests.length >= 3, JSON.stringify(requests));
  assert.ok(requests.every((r) => !r.url.includes("run-sync")), "a synchronous endpoint was called");
  assert.equal(requests[0].method, "POST");
  assert.ok(requests[0].url.startsWith(`https://api.apify.com/v2/acts/${ACTOR_ID}/runs?`), requests[0].url);
  assert.ok(requests.some((r) => r.url.endsWith("/v2/actor-runs/run_mock_1")), "the run was never polled");
  assert.ok(requests.at(-1).url.includes("/v2/datasets/ds_mock_1/items"), "the dataset was never read");
  const rows = JSON.parse(result.content[0].text);
  assert.deepEqual(rows, [{ row_status: "ok", mock: true }]);
});

test("a run that does not succeed is an error with the run id, never an empty success", async () => {
  const { result, requests } = await callTool("FAILED");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /run_mock_1/);
  assert.match(result.content[0].text, /FAILED/);
  assert.ok(requests.every((r) => !r.url.includes("/datasets/")), "a failed run's dataset was read");
});
