import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  runCommand,
  spawnDetached,
  pickWindowsBinary,
  parseCmdShimTarget,
  buildSpawn,
} from "../plugins/opencode/scripts/lib/process.mjs";

// Argument that a shell would split, expand or execute. It must reach the
// child byte-for-byte.
const HOSTILE_ARG = `fix "bug" & echo INJECTED | more; $(whoami) %PATH% 'q'`;

// Spawn node itself so the tests run the same on Windows and POSIX.
const NODE = process.execPath;

describe("process", () => {
  it("runCommand captures stdout", async () => {
    const { stdout, exitCode } = await runCommand(NODE, ["-e", "process.stdout.write('hello')"]);
    assert.equal(stdout, "hello");
    assert.equal(exitCode, 0);
  });

  it("runCommand captures exit code on failure", async () => {
    const { exitCode } = await runCommand(NODE, ["-e", "process.exit(3)"]);
    assert.equal(exitCode, 3);
  });

  it("runCommand captures stderr", async () => {
    const { stderr } = await runCommand(NODE, ["-e", "process.stderr.write('err')"]);
    assert.equal(stderr, "err");
  });

  it("runCommand passes shell metacharacters through literally", async () => {
    const { stdout, exitCode } = await runCommand(NODE, [
      "-e", "process.stdout.write(process.argv[1])", HOSTILE_ARG,
    ]);
    assert.equal(exitCode, 0);
    assert.equal(stdout, HOSTILE_ARG);
  });

  it("runCommand reports a missing executable as exit 1", async () => {
    const { exitCode } = await runCommand("definitely-not-a-real-binary-xyz", []);
    assert.equal(exitCode, 1);
  });
});

describe("spawnDetached", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  it("returns the real child PID and passes arguments literally", async () => {
    const logFile = path.join(tmpDir, "worker.log");
    const script = "process.stdout.write(JSON.stringify({ pid: process.pid, arg: process.argv[1] }))";
    const child = spawnDetached(NODE, ["-e", script, HOSTILE_ARG], { logFile });

    const deadline = Date.now() + 10000;
    let report = null;
    while (Date.now() < deadline) {
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      try { report = JSON.parse(text); break; } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(report, "worker never wrote its report");
    assert.equal(report.pid, child.pid);
    assert.equal(report.arg, HOSTILE_ARG);
  });
});

describe("pickWindowsBinary", () => {
  it("skips the extensionless POSIX shim and prefers .cmd", () => {
    const lines = [
      "C:\\Users\\u\\AppData\\Roaming\\npm\\opencode",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd",
      "",
    ];
    assert.equal(pickWindowsBinary(lines), "C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd");
  });

  it("prefers .exe over .cmd regardless of order", () => {
    assert.equal(pickWindowsBinary(["C:\\a\\opencode.CMD", "C:\\b\\opencode.exe"]), "C:\\b\\opencode.exe");
  });

  it("returns null when nothing is launchable", () => {
    assert.equal(pickWindowsBinary(["C:\\a\\opencode", "C:\\a\\opencode.ps1"]), null);
  });
});

describe("parseCmdShimTarget", () => {
  const shimPath = path.join("C:", "npm", "opencode.cmd");

  it("extracts the .exe an npm cmd-shim forwards to", () => {
    const content = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
    ].join("\r\n");
    assert.equal(
      parseCmdShimTarget(shimPath, content),
      path.join(path.dirname(shimPath), "node_modules\\opencode-ai\\bin\\opencode.exe"),
    );
  });

  it("returns null for a shim that runs a node script", () => {
    const content = '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*';
    assert.equal(parseCmdShimTarget(shimPath, content), null);
  });
});

describe("buildSpawn", () => {
  it("passes args as an array when no shell is needed", () => {
    assert.deepEqual(
      buildSpawn({ file: "C:\\x\\opencode.exe", shell: false }, ["serve", "--port", "4096"]),
      { command: "C:\\x\\opencode.exe", args: ["serve", "--port", "4096"], shell: false },
    );
  });

  it("builds a single quoted command string for a shell launch", () => {
    assert.deepEqual(
      buildSpawn({ file: "C:\\Program Files\\npm\\opencode.cmd", shell: true }, ["serve", "--port", "4096"]),
      { command: '"C:\\Program Files\\npm\\opencode.cmd" serve --port 4096', args: [], shell: true },
    );
  });

  it("refuses to pass unsafe args through the shell", () => {
    assert.throws(
      () => buildSpawn({ file: "opencode", shell: true }, ["a & calc"]),
      /Refusing to pass argument through the shell/,
    );
  });
});
