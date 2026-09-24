import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { responseText, findDispatchedTaskIds } from "../plugins/opencode/scripts/lib/hook-io.mjs";

const MONITOR_HOOK = path.resolve("plugins/opencode/scripts/post-tool-use-monitor-hook.mjs");

// Shape of a real Bash tool_response whose command edited files (git checkout,
// sed, ...). The false positive came from `bashEditDiff`, never from stdout.
const bashResponseWithEditDiff = {
  stdout: "f047d15 Bump version to 2.0.1\n",
  stderr: "",
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
  gitOperation: { push: { branch: "main" } },
  bashEditDiff: {
    files: [
      { filePath: "D:\\repo\\plugins\\opencode\\scripts\\opencode-companion.mjs", hunks: [] },
      { filePath: "D:\\repo\\tests\\auto-heal.test.mjs", hunks: [{ lines: ['-      id: "task-abc123-def4",'] }] },
    ],
  },
};

function runMonitorHook(input) {
  return spawnSync(process.execPath, [MONITOR_HOOK], { input: JSON.stringify(input), encoding: "utf8" });
}

describe("responseText", () => {
  it("reads only stdout from a Bash response", () => {
    assert.equal(responseText(bashResponseWithEditDiff), "f047d15 Bump version to 2.0.1\n");
  });

  it("joins text blocks from an Agent response", () => {
    const r = { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] };
    assert.equal(responseText(r), "a\nb");
  });

  it("never serializes unknown objects", () => {
    assert.equal(responseText({ bashEditDiff: { id: "task-abc123-def4" } }), "");
  });
});

describe("findDispatchedTaskIds", () => {
  it("picks up the background dispatch line", () => {
    const out = "OpenCode task started in background: task-mueqngbp-v421hk\nCheck `/opencode:status` for progress.";
    assert.deepEqual(findDispatchedTaskIds(out), ["task-mueqngbp-v421hk"]);
  });

  it("picks up a job report that is still running", () => {
    const out = "## Job: task-mueqngbp-v421hk\n\n- **Type**: task\n- **Status**: running\n";
    assert.deepEqual(findDispatchedTaskIds(out), ["task-mueqngbp-v421hk"]);
  });

  it("ignores a finished job report", () => {
    const out = "## Job: task-muer5i3z-6earte\n\n- **Type**: task\n- **Status**: completed\n\n### Output\n\ndone";
    assert.deepEqual(findDispatchedTaskIds(out), []);
  });

  it("ignores ids that merely appear in text", () => {
    const out = 'node opencode-companion.mjs status\n  id: "task-abc123-def4",\nopencode rescue';
    assert.deepEqual(findDispatchedTaskIds(out), []);
  });
});

describe("monitor hook", () => {
  it("stays silent for a Bash call whose edit diff mentions a task id", () => {
    const r = runMonitorHook({ tool_name: "Bash", tool_response: bashResponseWithEditDiff });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });

  it("asks for a Monitor after a real background dispatch", () => {
    const r = runMonitorHook({
      tool_name: "Bash",
      tool_response: { stdout: "OpenCode task started in background: task-mueqngbp-v421hk\n", stderr: "" },
    });
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /IDS=\("task-mueqngbp-v421hk"\)/);
  });
});
