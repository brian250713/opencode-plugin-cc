// Session-level auto-heal for tracked jobs.
//
// Background: task-worker subprocesses wrap `client.runPrompt(sid, ...)` in
// runTrackedJob so that on successful return the job flips status→completed
// and the response text is persisted to jobDataPath. But the worker can be
// killed before that return happens — even though the OpenCode session itself
// completed cleanly server-side. The job then stays
// in a non-terminal state ("investigating"/"running") forever and downstream
// Monitor scripts never see the true finish.
//
// This module provides a best-effort reconciliation pass: given a job with
// an `opencodeSessionId`, ask the OpenCode server whether that session went
// idle after the job started. If so, upsert the job as completed (or failed,
// per the session outcome) and persist the reply text. If the worker process is gone and the session has
// been idle long enough, mark as failed with a clear error message.
//
// All functions are no-ops (or log to stderr and return the original job)
// when the server is unreachable, so callers can sprinkle autoHealJob at
// the top of status-reading paths without wrapping in try/catch themselves.

import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "./fs.mjs";
import { upsertJob, jobDataPath } from "./state.mjs";
import {
  DEFAULT_BASE_URL,
  createClient,
  isTurnDone,
  summarizeTurn,
  describeLastActivity,
} from "./opencode-server.mjs";

// A worker/session can be legitimately silent for a while (big model thinking,
// slow tool) — only declare it dead after >60s of no session activity AND no
// live task-worker process.
const STALE_IDLE_MS = 60_000;

/**
 * True if the given PID is currently alive. Treats missing/invalid PID as dead.
 * @param {number|undefined|null} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a permission/existence probe — no signal delivered.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = process exists but we can't signal it
    // (still alive from our perspective).
    return err.code === "EPERM";
  }
}

/**
 * Query the opencode server for the terminal state of a session.
 *
 * Returns:
 *   { terminal: true, outcome, completed, text, error } when the session went
 *     idle at or after startedAtMs.
 *   { terminal: false, reachable: true, lastUpdatedAt } when the session is still running.
 *   { terminal: false, reachable: false, error }        when server unreachable / errored.
 *
 * @param {string} baseUrl
 * @param {string} sessionId
 * @param {number} startedAtMs - epoch ms; only treat completions >= this as ours
 */
export async function probeSessionTerminal(baseUrl, sessionId, startedAtMs) {
  const client = createClient(baseUrl);
  let session;
  try {
    session = await client.getSession(sessionId);
  } catch (err) {
    return { terminal: false, reachable: false, error: err.message };
  }
  try {
    const messages = await client.listMessages(sessionId, { limit: 50, order: "desc" });
    if (isTurnDone(session, startedAtMs || 0)) {
      const { text, error } = summarizeTurn(messages, startedAtMs || 0);
      return { terminal: true, outcome: session.outcome, completed: session.time.idle, text, error };
    }
    const newest = messages[0]?.time ?? {};
    const lastUpdatedAt = Math.max(newest.completed ?? 0, newest.streamed ?? 0, newest.created ?? 0, session.time?.updated ?? 0);
    return { terminal: false, reachable: true, lastUpdatedAt };
  } catch (err) {
    return { terminal: false, reachable: false, error: err.message };
  }
}

/**
 * Fetch the session's last activity summary for display in `status` output.
 * Never throws — returns null on any failure (unreachable, bad response).
 *
 * Return shape:
 *   null                                         — server unreachable / no activity
 *   { kind:"tool", tool, command, ageSec }       — latest activity is a tool call
 *   { kind:"text", text, ageSec }                — latest activity is text
 *
 * @param {string} baseUrl
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function getSessionLastActivity(baseUrl, sessionId) {
  if (!sessionId) return null;
  try {
    const messages = await createClient(baseUrl).listMessages(sessionId, { limit: 5, order: "desc" });
    const act = describeLastActivity(messages);
    if (!act) return null;
    const ageSec = act.at ? Math.max(0, Math.floor((Date.now() - act.at) / 1000)) : null;
    return { ...act, ageSec };
  } catch {
    return null;
  }
}

/**
 * Parse an ISO-ish timestamp that might be a number or string. Returns epoch ms, or 0.
 */
function toEpochMs(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // tolerate seconds
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Attempt to auto-heal a single job. Mutates persistent state via upsertJob
 * on transitions. Returns the up-to-date job record (healed or not).
 *
 * @param {string} workspace
 * @param {object} job
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {boolean} [opts.dryRun] - when true, do not write state; return `{job, action, details}`
 */
export async function autoHealJob(workspace, job, opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const dryRun = !!opts.dryRun;
  const HEALABLE = new Set(["starting", "investigating", "running", "finalizing"]);

  if (!job || !job.opencodeSessionId) {
    return { job, action: "skip", reason: "no opencodeSessionId" };
  }
  if (!HEALABLE.has(job.status)) {
    return { job, action: "skip", reason: `status=${job.status} not healable` };
  }

  const startedAtMs =
    toEpochMs(job.startedAt) ||
    toEpochMs(job.createdAt) ||
    toEpochMs(job.updatedAt) ||
    0;

  const probe = await probeSessionTerminal(baseUrl, job.opencodeSessionId, startedAtMs);

  if (probe.terminal) {
    const completedIso = new Date(probe.completed).toISOString();

    if (probe.outcome !== "succeeded") {
      const errMsg = `OpenCode turn ${probe.outcome}${probe.error ? `: ${probe.error}` : ""}`;
      if (dryRun) return { job, action: "would-fail", details: { errorMessage: errMsg } };
      upsertJob(workspace, {
        id: job.id,
        status: "failed",
        completedAt: completedIso,
        errorMessage: errMsg,
        healed: true,
      });
      return {
        job: { ...job, status: "failed", errorMessage: errMsg, healed: true },
        action: "healed-failed",
        details: { errorMessage: errMsg },
      };
    }

    const summary = (probe.text || "").slice(0, 500);
    if (dryRun) {
      return {
        job,
        action: "would-complete",
        details: {
          outcome: probe.outcome,
          completedAt: completedIso,
          textLen: (probe.text || "").length,
        },
      };
    }

    // Persist the result payload to disk so handleResult can surface it.
    try {
      const dataFile = jobDataPath(workspace, job.id);
      ensureDir(path.dirname(dataFile));
      const payload = {
        rendered: probe.text,
        summary,
        healed: true,
        outcome: probe.outcome,
      };
      fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      // Non-fatal: the status transition below is still useful.
      process.stderr.write(`auto-heal: failed to write data file for ${job.id}: ${err.message}
`);
    }

    upsertJob(workspace, {
      id: job.id,
      status: "completed",
      completedAt: completedIso,
      phase: "completed",
      result: summary || job.result || null,
      healed: true,
    });
    return {
      job: { ...job, status: "completed", completedAt: completedIso, result: summary, healed: true },
      action: "healed-completed",
      details: { outcome: probe.outcome, textLen: (probe.text || "").length },
    };
  }

  // Not terminal. Can we at least declare it dead?
  if (!probe.reachable) {
    const updatedMs = toEpochMs(job.updatedAt);
    const idleMs = updatedMs ? Date.now() - updatedMs : Infinity;
    if (!isProcessAlive(job.pid) && idleMs >= STALE_IDLE_MS) {
      const errMsg = "server unreachable while worker dead";
      if (dryRun) {
        return { job, action: "would-fail", details: { errorMessage: errMsg } };
      }

      upsertJob(workspace, {
        id: job.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: errMsg,
        healed: true,
      });
      return {
        job: { ...job, status: "failed", errorMessage: errMsg, healed: true },
        action: "healed-failed",
        details: { errorMessage: errMsg },
      };
    }
    return { job, action: "skip", reason: `server unreachable: ${probe.error}` };
  }

  const workerAlive = isProcessAlive(job.pid);
  if (workerAlive) {
    return { job, action: "skip", reason: "worker still alive" };
  }

  const lastUpdateMs = probe.lastUpdatedAt || toEpochMs(job.updatedAt);
  const idleMs = lastUpdateMs ? Date.now() - lastUpdateMs : Infinity;
  if (idleMs < STALE_IDLE_MS) {
    return { job, action: "skip", reason: `idle ${Math.floor(idleMs / 1000)}s < ${STALE_IDLE_MS / 1000}s threshold` };
  }

  const idleSec = Number.isFinite(idleMs) ? Math.floor(idleMs / 1000) : -1;
  const errMsg = `task-worker exited without completion; session last updated ${idleSec}s ago`;

  if (dryRun) {
    return { job, action: "would-fail", details: { errorMessage: errMsg } };
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: errMsg,
    healed: true,
  });
  return {
    job: { ...job, status: "failed", errorMessage: errMsg, healed: true },
    action: "healed-failed",
    details: { errorMessage: errMsg },
  };
}

/**
 * Auto-heal a list of jobs, returning the (possibly updated) jobs in the same
 * order, plus a list of heal actions for reporting.
 *
 * @param {string} workspace
 * @param {object[]} jobs
 * @param {object} [opts]
 * @returns {Promise<{ jobs: object[], actions: object[] }>}
 */
export async function autoHealJobs(workspace, jobs, opts = {}) {
  const actions = [];
  const out = [];
  for (const j of jobs ?? []) {
    try {
      const r = await autoHealJob(workspace, j, opts);
      out.push(r.job ?? j);
      if (r.action && r.action !== "skip") {
        actions.push({ id: j.id, action: r.action, details: r.details });
      }
    } catch (err) {
      // Auto-heal must never crash the caller.
      process.stderr.write(`auto-heal: ${j.id} errored: ${err.message}\n`);
      out.push(j);
    }
  }
  return { jobs: out, actions };
}
