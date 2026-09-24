import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { probeSessionTerminal, autoHealJob } from "../plugins/opencode/scripts/lib/auto-heal.mjs";
import { loadState, upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";

const workspace = "/test/workspace";

describe("auto-heal against a server without the session", () => {
  let tmpDir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tmpDir = createTmpDir();
    setupTestEnv(tmpDir);
    server = http.createServer((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "not found" }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    cleanupTmpDir(tmpDir);
  });

  it("reports a 404 as a missing session, not an unreachable server", async () => {
    const probe = await probeSessionTerminal(baseUrl, "ses_gone", 0);
    assert.deepEqual(probe, { terminal: false, reachable: true, missing: true });
  });

  it("fails the job with a clear reason when the worker is gone", async () => {
    const job = {
      id: "task-abc123-def4",
      type: "task",
      status: "investigating",
      opencodeSessionId: "ses_gone",
      pid: 0,
      startedAt: new Date().toISOString(),
    };
    upsertJob(workspace, job);
    const r = await autoHealJob(workspace, job, { baseUrl });
    assert.equal(r.action, "healed-failed");
    const saved = loadState(workspace).jobs.find((j) => j.id === job.id);
    assert.equal(saved.status, "failed");
    assert.match(saved.errorMessage, /ses_gone no longer exists on the server/);
  });
});
