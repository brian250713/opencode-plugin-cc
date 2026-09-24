// Shared input handling for the PostToolUse hooks.

import fs from "node:fs";

/**
 * Read the hook's JSON payload from stdin. Returns {} on any failure.
 * @returns {object}
 */
export function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const TASK_ID = "task-[a-z0-9]{6,}-[a-z0-9]{4,}";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Task ids that were just dispatched and are still running, according to
 * companion output: the `task --background` dispatch line, or a rendered
 * `## Job:` report whose status is not terminal. An id that merely appears
 * in text (source code, logs, a finished report) does not count.
 * @param {string} text
 * @returns {string[]}
 */
export function findDispatchedTaskIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(new RegExp(`OpenCode task started in background: (${TASK_ID})\\b`, "g"))) {
    ids.add(m[1]);
  }
  const reports = text.split(new RegExp(`^## Job: (?=${TASK_ID}\\b)`, "m")).slice(1);
  for (const report of reports) {
    const id = report.match(new RegExp(`^${TASK_ID}`))[0];
    const status = report.match(/^- \*\*Status\*\*: (\w+)/m)?.[1];
    if (status && !TERMINAL_STATUSES.has(status)) ids.add(id);
  }
  return [...ids];
}

/**
 * The text a tool actually printed/returned. Deliberately never serializes
 * the whole response: Bash responses carry side-channel fields such as
 * `bashEditDiff` (diffs of files the command touched), and scanning those
 * made hooks react to task ids that merely appeared in edited source files.
 * @param {any} response - hook `tool_response`
 * @returns {string}
 */
export function responseText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response !== "object") return "";
  if (typeof response.stdout === "string") return response.stdout;
  if (typeof response.result === "string") return response.result;
  if (typeof response.content === "string") return response.content;
  if (Array.isArray(response.content)) {
    return response.content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}
