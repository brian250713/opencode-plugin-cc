// OpenCode HTTP API client (opencode v2 only).
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API under /api. This module wraps that API.
//
// v2 facts this module relies on (verified against opencode 2.0.15):
// - Every /api route requires HTTP Basic auth. `opencode serve` generates a
//   random password unless OPENCODE_SERVER_PASSWORD is set (username
//   "opencode"), so the companion starts the server with its own password and
//   persists it for later invocations.
// - Non-/api paths are served by the web UI's SPA fallback (200 text/html for
//   anything), so health checks must validate a JSON body, not just `res.ok`.
// - POST /api/session/:id/prompt returns as soon as the prompt is queued.
//   Completion is signalled by the session going idle: `time.idle` set at or
//   after the prompt's `time.created`, with `outcome` succeeded|failed|interrupted.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { classifyError } from "./errors.mjs";
import { opencodeSpawnSpec } from "./process.mjs";
import { stateBase } from "./state.mjs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4096;
export const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const SERVER_START_TIMEOUT = 30_000;

const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
// Absolute cap on a single prompt turn.
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 14_400_000;
// No new message/tool activity for this long → interrupt the session.
const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 3_600_000;
const POLL_INTERVAL_MS = Number(process.env.OPENCODE_COMPLETION_POLL_MS) || 2_000;
// Pending permission requests are checked every N polls; a turn blocked on one
// would otherwise wait for a human that isn't there.
const PERMISSION_CHECK_EVERY = 3;

// Session-level ruleset for write-capable runs. Narrower rules (e.g. denying
// `shell`) are not an option: with opencode's free models, denying shell makes
// the provider reject every request with 403 "free tier can only be used from
// within OpenCode". Read-only runs rely on the `plan` agent instead.
export const ALLOW_ALL_PERMISSIONS = [{ action: "*", resource: "*", effect: "allow" }];

// ------------------------------------------------------------------
// Credentials
// ------------------------------------------------------------------

/**
 * Where the companion keeps the password for the server it starts.
 * @returns {string}
 */
export function serverAuthPath() {
  return path.join(stateBase(), "server-auth.json");
}

/**
 * Resolve Basic-auth credentials for the local server. An explicit
 * OPENCODE_SERVER_PASSWORD wins; otherwise a random password is generated
 * once and persisted so every companion process (hooks, workers) agrees.
 * @param {object} [opts]
 * @param {boolean} [opts.create=true] - generate and persist one if missing
 * @returns {{ username: string, password: string } | null}
 */
export function resolveCredentials(opts = {}) {
  const create = opts.create ?? true;
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    return {
      username: process.env.OPENCODE_SERVER_USERNAME || "opencode",
      password: process.env.OPENCODE_SERVER_PASSWORD,
    };
  }
  const file = serverAuthPath();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof saved?.password === "string" && saved.password) {
      return { username: "opencode", password: saved.password };
    }
  } catch {
    // Missing or unreadable — fall through
  }
  if (!create) return null;
  const password = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ password }), { encoding: "utf8", mode: 0o600 });
  return { username: "opencode", password };
}

/**
 * @param {{ username: string, password: string } | null} creds
 * @returns {Record<string, string>}
 */
export function authHeaders(creds) {
  if (!creds) return {};
  const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

// ------------------------------------------------------------------
// Health
// ------------------------------------------------------------------

/**
 * Classify a GET /api/info response.
 *   "ok"           — a v2 server that accepted our credentials
 *   "unauthorized" — a server is there but rejected our credentials
 *   "incompatible" — something answered that isn't the v2 API (v1 opencode,
 *                    the web UI's HTML fallback, another service)
 * @param {number} status
 * @param {string} contentType
 * @param {any} body - parsed JSON, or the raw text
 * @returns {"ok" | "unauthorized" | "incompatible"}
 */
export function classifyInfoResponse(status, contentType, body) {
  if (status === 401) return "unauthorized";
  const isJson = (contentType || "").includes("application/json");
  if (status === 200 && isJson && typeof body?.version === "string") return "ok";
  return "incompatible";
}

/**
 * Probe the server at baseUrl.
 * @param {string} [baseUrl]
 * @param {{ username: string, password: string } | null} [creds]
 * @returns {Promise<{ state: "ok" | "unauthorized" | "incompatible" | "down", info?: object }>}
 */
export async function probeServer(baseUrl = DEFAULT_BASE_URL, creds = resolveCredentials({ create: false })) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/info`, {
      headers: authHeaders(creds),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return { state: "down" };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const state = classifyInfoResponse(res.status, contentType, body);
  return state === "ok" ? { state, info: body } : { state };
}

/**
 * True only when a v2 server is listening AND accepts our credentials.
 * @param {string} [host]
 * @param {number} [port]
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return (await probeServer(`http://${host}:${port}`)).state === "ok";
}

/**
 * Human-readable explanation for a non-ok probe state.
 * @param {string} state
 * @param {string} baseUrl
 * @returns {string}
 */
export function describeProbeFailure(state, baseUrl) {
  switch (state) {
    case "unauthorized":
      return `An OpenCode server at ${baseUrl} rejected the companion's credentials. ` +
        "It was probably started outside the plugin (e.g. `opencode serve` or the background service). " +
        "Stop it so the companion can start its own, or set OPENCODE_SERVER_PASSWORD to its password.";
    case "incompatible":
      return `The server at ${baseUrl} is not an OpenCode v2 API server. ` +
        "This plugin requires opencode v2 (npm i -g @opencode/cli); stop any v1 `opencode serve` on that port.";
    case "down":
      return `No OpenCode server is reachable at ${baseUrl}.`;
    default:
      return `OpenCode server at ${baseUrl}: ${state}`;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean, credentials: object }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;
  const credentials = resolveCredentials();

  const first = await probeServer(url, credentials);
  if (first.state === "ok") return { url, alreadyRunning: true, credentials };
  if (first.state !== "down") throw new Error(describeProbeFailure(first.state, url));

  const spec = await opencodeSpawnSpec(["serve", "--hostname", host, "--port", String(port)]);
  const proc = spawn(spec.command, spec.args, {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    shell: spec.shell,
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: credentials.username,
      OPENCODE_SERVER_PASSWORD: credentials.password,
    },
  });
  proc.unref();

  const deadline = Date.now() + SERVER_START_TIMEOUT;
  let last = first;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = await probeServer(url, credentials);
    if (last.state === "ok") return { url, pid: proc.pid, alreadyRunning: false, credentials };
    if (last.state !== "down") throw new Error(describeProbeFailure(last.state, url));
  }
  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
}

// ------------------------------------------------------------------
// Session / message helpers (pure)
// ------------------------------------------------------------------

/**
 * Parse a `provider/model` string into a v2 Model.Ref. The model id may itself
 * contain slashes (e.g. `openrouter/anthropic/claude-x`).
 * @param {string|undefined} ref
 * @returns {{ providerID: string, id: string } | null}
 */
export function parseModelRef(ref) {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { providerID: ref.slice(0, i), id: ref.slice(i + 1) };
}

/**
 * True once the session went idle for the turn that started at `sinceMs`.
 * @param {object} session - Session.Info
 * @param {number} sinceMs - server timestamp of the prompt (or job start)
 * @returns {boolean}
 */
export function isTurnDone(session, sinceMs) {
  const idle = session?.time?.idle;
  return typeof idle === "number" && idle >= sinceMs && typeof session?.outcome === "string";
}

/**
 * Visible text of an assistant message.
 * @param {object} msg
 * @returns {string}
 */
export function assistantText(msg) {
  if (msg?.type !== "assistant" || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Summarize the turn that started at `sinceMs` from a message list (any order).
 * The reply is the last assistant message with visible text; errors come from
 * the assistant messages' `error` field.
 * @param {object[]} messages - Session.Message.Info[]
 * @param {number} sinceMs
 * @returns {{ text: string, error: string | null }}
 */
export function summarizeTurn(messages, sinceMs) {
  const turn = (messages ?? [])
    .filter((m) => m?.type === "assistant" && (m.time?.created ?? 0) >= sinceMs)
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  let text = "";
  let error = null;
  for (const m of turn) {
    const t = assistantText(m);
    if (t) text = t;
    if (m.error?.message) error = m.error.message;
  }
  return { text, error };
}

/**
 * Short description of the latest activity in a session, for `status`.
 * @param {object[]} messages - newest first
 * @returns {{ kind: "tool", tool: string, command: string, at: number }
 *   | { kind: "text", text: string, at: number } | null}
 */
export function describeLastActivity(messages) {
  for (const m of messages ?? []) {
    const at = m?.time?.completed ?? m?.time?.streamed ?? m?.time?.created ?? 0;
    if (m?.type === "shell") {
      return { kind: "tool", tool: "shell", command: String(m.command ?? "").slice(0, 80), at };
    }
    if (m?.type !== "assistant" || !Array.isArray(m.content)) continue;
    for (let i = m.content.length - 1; i >= 0; i--) {
      const c = m.content[i];
      if (c?.type === "tool") {
        const input = c.state?.input ?? {};
        const detail = input.command ?? input.path ?? input.filePath ?? JSON.stringify(input);
        return { kind: "tool", tool: c.name ?? "tool", command: String(detail).slice(0, 80), at };
      }
      if (c?.type === "text" && c.text?.trim()) {
        return { kind: "text", text: c.text.trim().slice(0, 80), at };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Client
// ------------------------------------------------------------------

/**
 * Create an API client bound to a running OpenCode v2 server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory sessions run in
 * @param {{ username: string, password: string } | null} [opts.credentials]
 */
export function createClient(baseUrl = DEFAULT_BASE_URL, opts = {}) {
  const credentials = opts.credentials !== undefined ? opts.credentials : resolveCredentials({ create: false });
  const headers = { "Content-Type": "application/json", ...authHeaders(credentials) };
  const directory = opts.directory;
  const locationQuery = directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : "";

  async function request(method, urlPath, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyError(err, { baseUrl, startedAt, timeoutMs, op: `request ${method} ${urlPath}` });
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw classifyError(
        new Error(`OpenCode API ${method} ${urlPath} returned ${res.status}: ${text.slice(0, 500)}`),
        { baseUrl, startedAt, timeoutMs, op: `request ${method} ${urlPath}` },
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`OpenCode API ${method} ${urlPath} returned non-JSON (is this an opencode v2 server?)`);
    }
  }

  const client = {
    baseUrl,

    info: () => request("GET", "/api/info"),

    /**
     * @param {object} [o]
     * @param {string} [o.title]
     * @param {string} [o.agent] - e.g. "build" (writes) or "plan" (read-only)
     * @param {string} [o.model] - "provider/model"
     * @param {boolean} [o.write] - grant the allow-all permission ruleset
     */
    createSession: async (o = {}) => {
      const body = { title: o.title };
      if (o.agent) body.agent = o.agent;
      const model = parseModelRef(o.model);
      if (model) body.model = model;
      if (directory) body.location = { directory };
      if (o.write) body.permissions = ALLOW_ALL_PERMISSIONS;
      return (await request("POST", "/api/session", body)).data;
    },
    getSession: async (id) => (await request("GET", `/api/session/${id}`)).data,
    deleteSession: (id) => request("DELETE", `/api/session/${id}`),
    switchAgent: (id, agent) => request("POST", `/api/session/${id}/agent`, { agent }),
    interruptSession: (id) => request("POST", `/api/session/${id}/interrupt`),
    listPermissions: async (id) => (await request("GET", `/api/session/${id}/permission`)).data ?? [],
    getSessionDiff: async (id) => (await request("GET", `/api/session/${id}/diff`)).data ?? [],

    /**
     * @param {string} id
     * @param {object} [o]
     * @param {number} [o.limit]
     * @param {"asc"|"desc"} [o.order]
     * @returns {Promise<object[]>}
     */
    listMessages: async (id, o = {}) => {
      const params = new URLSearchParams();
      if (o.limit) params.set("limit", String(o.limit));
      if (o.order) params.set("order", o.order);
      const qs = params.toString();
      return (await request("GET", `/api/session/${id}/message${qs ? "?" + qs : ""}`)).data ?? [];
    },

    listProviders: async () => (await request("GET", `/api/provider${locationQuery}`)).data ?? [],
    listAgents: async () => (await request("GET", `/api/agent${locationQuery}`)).data ?? [],

    /**
     * Send a prompt and wait for the session to go idle.
     * @param {string} sessionId
     * @param {string} text
     * @param {object} [o]
     * @param {string} [o.agent] - switch the session's agent first (resumed sessions)
     * @returns {Promise<{ text: string, outcome: string, sessionId: string }>}
     */
    runPrompt: async (sessionId, text, o = {}) => {
      if (o.agent) await client.switchAgent(sessionId, o.agent);
      const queued = (await request("POST", `/api/session/${sessionId}/prompt`, { text })).data;
      const since = queued?.time?.created ?? Date.now();
      const startedAt = Date.now();
      let lastSig = "";
      let lastActivity = Date.now();

      const interruptAndFail = async (reason) => {
        await client.interruptSession(sessionId).catch(() => {});
        throw new Error(reason);
      };

      for (let poll = 1; ; poll++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let session;
        let recent;
        try {
          session = await client.getSession(sessionId);
          recent = await client.listMessages(sessionId, { limit: 1, order: "desc" });
        } catch (err) {
          // Transient network/server blip — keep polling until a timeout trips.
          if (Date.now() - startedAt > PROMPT_TIMEOUT_MS) throw err;
          continue;
        }

        if (isTurnDone(session, since)) {
          const messages = await client.listMessages(sessionId, { limit: 50, order: "desc" });
          const { text: reply, error } = summarizeTurn(messages, since);
          if (session.outcome !== "succeeded") {
            throw new Error(`OpenCode turn ${session.outcome}${error ? `: ${error}` : ""}`);
          }
          return { text: reply, outcome: session.outcome, sessionId };
        }

        const sig = JSON.stringify(recent?.[0] ?? null);
        if (sig !== lastSig) {
          lastSig = sig;
          lastActivity = Date.now();
        }

        if (poll % PERMISSION_CHECK_EVERY === 0) {
          const pending = await client.listPermissions(sessionId).catch(() => []);
          if (pending.length > 0) {
            const p = pending[0];
            await interruptAndFail(
              `OpenCode is waiting for permission to ${p.action} ${(p.resources ?? []).join(", ")} — ` +
              "headless runs cannot answer permission prompts",
            );
          }
        }
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          await interruptAndFail(`session idle ${Math.floor((Date.now() - lastActivity) / 1000)}s > ${IDLE_TIMEOUT_MS / 1000}s`);
        }
        if (Date.now() - startedAt > PROMPT_TIMEOUT_MS) {
          await interruptAndFail(`prompt exceeded OPENCODE_PROMPT_TIMEOUT_MS=${PROMPT_TIMEOUT_MS}`);
        }
      }
    },
  };
  return client;
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url, credentials } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd, credentials });
  return { ...client, serverInfo: { url } };
}
