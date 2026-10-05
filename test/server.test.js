import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

const TOOL_NAMES = ["find_people_and_emails"];
const ACTOR_ID = "LEgloG7tWgQl4o6TD";
// A copy of the live actor's input schema, taken from its latest build on
// 2026-10-05 (test/fixtures/live-input-schema.json). Every tool parameter must
// be an input the actor accepts, so the wrapper can never send the actor an
// input property its schema does not have.
const LIVE = JSON.parse(readFileSync(join(here, "fixtures", "live-input-schema.json"), "utf8"));
const LIVE_INPUTS = new Set(Object.keys(LIVE.properties));
// Tool parameters the wrapper itself consumes and never sends to the actor.
const WRAPPER_ONLY = new Set([]);

// Speak MCP over stdio to the built server and return the tools/list result.
// No APIFY_TOKEN is set, on purpose: a client must see capabilities before it
// has configured anything.
function listTools() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.APIFY_TOKEN;
    const child = spawn(process.execPath, [join(repo, "build", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
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
          resolve(msg.result);
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
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

test("serves tools/list with no APIFY_TOKEN set", async () => {
  const result = await listTools();
  assert.deepEqual(result.tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of result.tools) assert.ok(t.description.length > 0, t.name);
});

test("every tool parameter is an input the live actor accepts", async () => {
  const result = await listTools();
  for (const t of result.tools) {
    for (const p of Object.keys(t.inputSchema.properties ?? {})) {
      if (WRAPPER_ONLY.has(p)) continue;
      assert.ok(LIVE_INPUTS.has(p), `${t.name}.${p} is not an actor input`);
    }
  }
});

test("source_tag is never exposed to a caller", async () => {
  const result = await listTools();
  for (const t of result.tools) assert.ok(!("source_tag" in (t.inputSchema.properties ?? {})), t.name);
});

test("source pins the immutable actor id and uses no synchronous endpoint", () => {
  const src = readFileSync(join(repo, "src", "index.ts"), "utf8");
  assert.ok(src.includes(`"${ACTOR_ID}"`), "actor id missing from source");
  assert.ok(!src.includes("run-sync-get-dataset-items"), "synchronous endpoint still in source");
});

test("package identity matches the locked naming convention", () => {
  const slug = pkg.name.split("/")[1];
  assert.equal(pkg.name, `@mambalabsdev/${slug}`);
  assert.equal(pkg.mcpName, `com.mambabuilt/${slug}`);
  assert.equal(pkg.bin[slug], "./build/index.js");
  const server = JSON.parse(readFileSync(join(repo, "server.json"), "utf8"));
  assert.equal(server.version, pkg.version);
  for (const p of server.packages ?? []) assert.equal(p.version, pkg.version);
});
