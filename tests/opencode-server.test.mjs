import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import {
  resolveCredentials,
  serverAuthPath,
  authHeaders,
  classifyInfoResponse,
  probeServer,
  parseModelRef,
  isTurnDone,
  summarizeTurn,
  describeLastActivity,
} from "../plugins/opencode/scripts/lib/opencode-server.mjs";

describe("resolveCredentials", () => {
  let tmpDir;
  const saved = {};
  beforeEach(() => {
    tmpDir = createTmpDir();
    setupTestEnv(tmpDir);
    for (const k of ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanupTmpDir(tmpDir);
  });

  it("generates a password once and reuses it", () => {
    const first = resolveCredentials();
    assert.equal(first.username, "opencode");
    assert.ok(first.password.length >= 24);
    assert.ok(fs.existsSync(serverAuthPath()));
    assert.deepEqual(resolveCredentials(), first);
  });

  it("returns null without creating when create is false", () => {
    assert.equal(resolveCredentials({ create: false }), null);
    assert.equal(fs.existsSync(serverAuthPath()), false);
  });

  it("prefers OPENCODE_SERVER_PASSWORD from the environment", () => {
    process.env.OPENCODE_SERVER_PASSWORD = "from-env";
    process.env.OPENCODE_SERVER_USERNAME = "someone";
    assert.deepEqual(resolveCredentials(), { username: "someone", password: "from-env" });
    assert.equal(fs.existsSync(serverAuthPath()), false);
  });
});

describe("authHeaders", () => {
  it("builds a Basic header", () => {
    const h = authHeaders({ username: "opencode", password: "pw" });
    assert.equal(h.Authorization, "Basic " + Buffer.from("opencode:pw").toString("base64"));
  });

  it("is empty without credentials", () => {
    assert.deepEqual(authHeaders(null), {});
  });
});

describe("classifyInfoResponse", () => {
  it("accepts a v2 ServerInfo JSON body", () => {
    assert.equal(classifyInfoResponse(200, "application/json", { version: "2.0.15", pid: 1 }), "ok");
  });

  it("rejects the web UI's HTML fallback", () => {
    assert.equal(classifyInfoResponse(200, "text/html", "<!doctype html>"), "incompatible");
  });

  it("rejects JSON that is not ServerInfo", () => {
    assert.equal(classifyInfoResponse(200, "application/json", { healthy: true }), "incompatible");
  });

  it("reports 401 as unauthorized", () => {
    assert.equal(classifyInfoResponse(401, "application/json", {}), "unauthorized");
  });

  it("treats 404 (v1 server) as incompatible", () => {
    assert.equal(classifyInfoResponse(404, "text/plain", "Not Found"), "incompatible");
  });
});

describe("probeServer", () => {
  let server;
  let baseUrl;
  const creds = { username: "opencode", password: "secret" };

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      const ok = req.headers.authorization === authHeaders(creds).Authorization;
      if (req.url === "/api/info" && !ok) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ _tag: "UnauthorizedError" }));
      }
      if (req.url === "/api/info") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ version: "2.0.15", pid: 1, urls: [], paths: {} }));
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("is ok with the right credentials", async () => {
    const r = await probeServer(baseUrl, creds);
    assert.equal(r.state, "ok");
    assert.equal(r.info.version, "2.0.15");
  });

  it("is unauthorized with wrong credentials", async () => {
    const r = await probeServer(baseUrl, { username: "opencode", password: "nope" });
    assert.equal(r.state, "unauthorized");
  });

  it("is down when nothing listens", async () => {
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    server = http.createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const r = await probeServer(`http://127.0.0.1:${port}`, creds);
    assert.equal(r.state, "down");
  });
});

describe("parseModelRef", () => {
  it("splits provider and model on the first slash", () => {
    assert.deepEqual(parseModelRef("openrouter/anthropic/claude-x"), { providerID: "openrouter", id: "anthropic/claude-x" });
  });

  it("rejects malformed refs", () => {
    assert.equal(parseModelRef("no-slash"), null);
    assert.equal(parseModelRef("/model"), null);
    assert.equal(parseModelRef("provider/"), null);
    assert.equal(parseModelRef(undefined), null);
  });
});

describe("isTurnDone", () => {
  it("is done once idle at or after the prompt with an outcome", () => {
    assert.equal(isTurnDone({ outcome: "succeeded", time: { idle: 1000 } }, 1000), true);
  });

  it("ignores an idle marker from a previous turn", () => {
    assert.equal(isTurnDone({ outcome: "succeeded", time: { idle: 900 } }, 1000), false);
  });

  it("is not done while running", () => {
    assert.equal(isTurnDone({ time: { created: 1, updated: 2 } }, 1000), false);
  });
});

describe("summarizeTurn", () => {
  const messages = [
    { type: "idle", time: { created: 1300 }, outcome: "succeeded" },
    {
      type: "assistant", time: { created: 1200 },
      content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Final answer" }],
    },
    {
      type: "assistant", time: { created: 1100 },
      content: [{ type: "text", text: "I'll do it." }, { type: "tool", name: "write", state: { status: "completed" } }],
    },
    { type: "user", time: { created: 1050 }, text: "do it" },
    { type: "assistant", time: { created: 500 }, content: [{ type: "text", text: "previous turn" }] },
  ];

  it("returns the last assistant text of this turn only", () => {
    assert.deepEqual(summarizeTurn(messages, 1000), { text: "Final answer", error: null });
  });

  it("surfaces an assistant error", () => {
    const failed = [{
      type: "assistant", time: { created: 1100 }, content: [], finish: "error",
      error: { type: "provider.auth", message: "free tier can only be used from within OpenCode", status: 403 },
    }];
    assert.deepEqual(summarizeTurn(failed, 1000), { text: "", error: "free tier can only be used from within OpenCode" });
  });
});

describe("describeLastActivity", () => {
  it("reports the latest tool call", () => {
    const act = describeLastActivity([{
      type: "assistant", time: { created: 5, completed: 9 },
      content: [{ type: "text", text: "Running it" }, { type: "tool", name: "shell", state: { input: { command: "npm test" } } }],
    }]);
    assert.deepEqual(act, { kind: "tool", tool: "shell", command: "npm test", at: 9 });
  });

  it("reports text when there is no tool", () => {
    const act = describeLastActivity([{ type: "assistant", time: { created: 5 }, content: [{ type: "text", text: " hello " }] }]);
    assert.deepEqual(act, { kind: "text", text: "hello", at: 5 });
  });

  it("skips non-assistant messages", () => {
    assert.equal(describeLastActivity([{ type: "idle", time: { created: 1 } }]), null);
  });
});
