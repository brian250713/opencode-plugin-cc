import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { spawnDetached } from "../plugins/opencode/scripts/lib/process.mjs";

const LIB = path.resolve("plugins/opencode/scripts/lib");

// Runs one tracked job in a detached child whose stdout/stderr go to the job
// log, the way `task --background` starts its task-worker.
const CHILD = `
const { runTrackedJob } = await import(${JSON.stringify(pathToFileURL(path.join(LIB, "tracked-jobs.mjs")).href)});
const { jobLogPath } = await import(${JSON.stringify(pathToFileURL(path.join(LIB, "state.mjs")).href)});
const [workspace, jobId, echo] = process.argv.slice(1);
await runTrackedJob(workspace, { id: jobId }, async ({ report }) => {
  report("starting", "hello from worker");
  return { rendered: "ok" };
}, { echo: echo === "true" });
process.stdout.write(jobLogPath(workspace, jobId));
`;

async function runDetachedJob(tmpDir, echo) {
  const jobId = `task-test${echo}-abcd`;
  const workspace = path.join(tmpDir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const outFile = path.join(tmpDir, `out-${echo}.txt`);
  const child = spawnDetached(process.execPath, ["--input-type=module", "-e", CHILD, workspace, jobId, String(echo)], {
    cwd: workspace,
    logFile: outFile,
    env: { OPENCODE_COMPANION_DATA: tmpDir },
  });
  child.ref(); // spawnDetached unrefs it; keep the test alive until it exits
  await new Promise((resolve) => child.on("exit", resolve));
  return fs.readFileSync(outFile, "utf8");
}

describe("runTrackedJob in a background worker", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  it("writes each progress line once when echo is off", async () => {
    const out = await runDetachedJob(tmpDir, false);
    assert.doesNotMatch(out, /hello from worker/, "nothing echoed to the redirected stderr");
    const logPath = out.slice(out.lastIndexOf(tmpDir));
    const log = fs.readFileSync(logPath, "utf8");
    assert.equal(log.match(/hello from worker/g).length, 1);
  });

  it("echoes progress to stderr by default", async () => {
    const out = await runDetachedJob(tmpDir, true);
    assert.equal(out.match(/hello from worker/g).length, 1);
  });
});
