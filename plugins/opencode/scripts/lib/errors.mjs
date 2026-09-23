// Error classification helpers — turn raw fetch/abort/HTTP errors into
// actionable messages that point newcomers at the right knob to turn.
//
// Usage:
//   try { ... }
//   catch (err) { throw classifyError(err, { baseUrl, startedAt, timeoutMs }); }
//
// classifyError always returns an Error (never swallows). When the input
// matches one of the known patterns, the returned Error's message is prefixed
// with a one-line hint; otherwise the original error is returned unchanged.

/**
 * Classify an error and return an annotated Error instance.
 * @param {any} err
 * @param {object} [ctx]
 * @param {string} [ctx.baseUrl]
 * @param {number} [ctx.startedAt] - epoch ms when the request started
 * @param {number} [ctx.timeoutMs] - caller-side abort timeout
 * @param {string} [ctx.op] - operation name (e.g. "request GET /api/session")
 * @returns {Error}
 */
export function classifyError(err, ctx = {}) {
  if (!err) return new Error("unknown error");
  const original = err instanceof Error ? err : new Error(String(err));
  const msg = original.message || "";
  const code = original.code || original.cause?.code || "";
  const elapsedSec = ctx.startedAt ? Math.round((Date.now() - ctx.startedAt) / 1000) : null;

  // AbortSignal fired from our side (caller-imposed timeout).
  if (original.name === "AbortError" || original.name === "TimeoutError" || /abort/i.test(msg)) {
    if (ctx.timeoutMs && elapsedSec != null && elapsedSec * 1000 >= ctx.timeoutMs * 0.9) {
      return annotate(original,
        `Aborted after ${elapsedSec}s (OPENCODE_REQUEST_TIMEOUT_MS=${ctx.timeoutMs}).`);
    }
  }

  // Connection refused — server not listening.
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) {
    const url = ctx.baseUrl || "http://127.0.0.1:4096";
    return annotate(original,
      `OpenCode server at ${url} unreachable. Run 'companion doctor' to diagnose.`);
  }

  // HTTP status-coded errors (shape: "OpenCode API GET /foo returned 401: ...")
  const m = msg.match(/returned (\d{3})\b/);
  if (m) {
    const status = Number(m[1]);
    if (status === 401 || status === 403) {
      return annotate(original,
        `Auth failed (${status}). The server was likely started outside the plugin; stop it or set OPENCODE_SERVER_PASSWORD to its password.`);
    }
    if (status >= 500 && status < 600) {
      return annotate(original, `OpenCode server error ${status} (check opencode logs):`);
    }
  }

  return original;
}

function annotate(err, hint) {
  const wrapped = new Error(`${hint} [${err.message}]`);
  wrapped.cause = err;
  wrapped.code = err.code;
  return wrapped;
}
