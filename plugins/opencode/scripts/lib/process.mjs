// Process utilities for the OpenCode companion.
//
// Nothing here spawns through a shell with caller-supplied arguments: Node's
// `shell: true` concatenates args without escaping (DEP0190), so on Windows a
// task text containing `&`, `|` or `"` would be executed by cmd.exe. It also
// makes `child.pid` the shell's PID rather than the real process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

// Arguments we are willing to hand to cmd.exe when an npm .cmd shim cannot be
// bypassed. Only the fixed internal args (`serve --port 4096`, `--version`)
// are ever passed, so anything outside this set is a programming error.
const SHELL_SAFE_ARG = /^[A-Za-z0-9_.:=\/-]+$/;

/**
 * Pick the best launchable file from `where` output on Windows. `where`
 * also lists extensionless POSIX shims (npm writes one for Git Bash), which
 * Windows cannot execute, so prefer a real .exe, then a .cmd/.bat shim.
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function pickWindowsBinary(candidates) {
  const clean = candidates.map((c) => c.trim()).filter(Boolean);
  const byExt = (exts) => clean.find((c) => exts.includes(path.extname(c).toLowerCase()));
  return byExt([".exe"]) ?? byExt([".cmd", ".bat"]) ?? null;
}

/**
 * Extract the target executable from an npm cmd-shim, e.g.
 *   "%dp0%\node_modules\@opencode\cli\bin\opencode.exe"   %*
 * Returns null unless the target is an .exe (a node-script shim still needs
 * the shell).
 * @param {string} shimPath
 * @param {string} content
 * @returns {string|null}
 */
export function parseCmdShimTarget(shimPath, content) {
  const m = /"%dp0%\\([^"]+\.exe)"/i.exec(content);
  return m ? path.join(path.dirname(shimPath), m[1]) : null;
}

/**
 * Build spawn() arguments for a resolved launch target.
 * @param {{ file: string, shell: boolean }} launch
 * @param {string[]} args
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function buildSpawn(launch, args) {
  if (!launch.shell) return { command: launch.file, args, shell: false };
  const unsafe = args.find((a) => !SHELL_SAFE_ARG.test(a));
  if (unsafe !== undefined) {
    throw new Error(`Refusing to pass argument through the shell: ${JSON.stringify(unsafe)}`);
  }
  // A single command string (no args array) avoids DEP0190.
  return { command: [`"${launch.file}"`, ...args].join(" "), args: [], shell: true };
}

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    // `which` isn't a native Windows binary; `where` is the equivalent.
    const proc = spawn(IS_WINDOWS ? "where" : "which", ["opencode"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const lines = out.split(/\r?\n/);
      resolve(IS_WINDOWS ? pickWindowsBinary(lines) : lines[0].trim() || null);
    });
    proc.on("error", () => resolve(null));
  });
}

/**
 * Work out how to launch `opencode`. On Windows, npm installs a .cmd shim
 * that spawn() can only run via a shell; when the shim just forwards to a
 * native .exe we launch that directly instead.
 * @returns {Promise<{ file: string, shell: boolean }>}
 */
export async function resolveOpencodeLaunch() {
  if (!IS_WINDOWS) return { file: "opencode", shell: false };
  const bin = await resolveOpencodeBinary();
  if (!bin) return { file: "opencode", shell: true };
  if (path.extname(bin).toLowerCase() === ".exe") return { file: bin, shell: false };
  try {
    const target = parseCmdShimTarget(bin, fs.readFileSync(bin, "utf8"));
    if (target && fs.existsSync(target)) return { file: target, shell: false };
  } catch {
    // Unreadable shim — fall back to running it through cmd.exe
  }
  return { file: bin, shell: true };
}

/**
 * spawn() arguments for running `opencode` with fixed internal arguments.
 * Resolved up front so callers can attach listeners synchronously after
 * spawn() — a spawn error is emitted on nextTick, before an await resumes.
 * @param {string[]} args
 * @returns {Promise<{ command: string, args: string[], shell: boolean }>}
 */
export async function opencodeSpawnSpec(args) {
  return buildSpawn(await resolveOpencodeLaunch(), args);
}

/**
 * Check if `opencode` CLI is available.
 * @returns {Promise<boolean>}
 */
export async function isOpencodeInstalled() {
  const bin = await resolveOpencodeBinary();
  return bin !== null;
}

/**
 * Get the installed opencode version.
 * @returns {Promise<string|null>}
 */
export async function getOpencodeVersion() {
  const spec = await opencodeSpawnSpec(["--version"]);
  return new Promise((resolve) => {
    const proc = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "ignore"],
      shell: spec.shell,
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    proc.on("error", () => resolve(null));
  });
}

/**
 * Run a command and return { stdout, stderr, exitCode }. `cmd` must be a real
 * executable (e.g. git.exe on Windows), not a shell builtin or .cmd shim.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: String(err), exitCode: 1 }));
  });
}

/**
 * Spawn a detached background process. `cmd` must be a real executable; pass
 * `process.execPath` rather than "node" so the returned PID is the worker's.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const logFd = opts.logFile ? fs.openSync(opts.logFile, "a") : null;
  let child;
  try {
    child = spawn(cmd, args, {
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
  child.unref();
  return child;
}
