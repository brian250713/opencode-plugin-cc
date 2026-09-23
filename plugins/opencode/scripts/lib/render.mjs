// Output rendering for the OpenCode companion.

/**
 * Render a status snapshot as human-readable text.
 * @param {{ running: object[], latestFinished: object|null, recent: object[] }} snapshot
 * @returns {string}
 */
export function renderStatus(snapshot) {
  const lines = [];

  if (snapshot.running.length > 0) {
    lines.push("## Running Jobs\n");
    for (const job of snapshot.running) {
      const phase = job.breadcrumb || job.phase || "running";
      lines.push(`- **${job.id}** (${job.type}) — ${phase} — ${job.elapsed ?? "just started"}`);
      if (!job.breadcrumb && job.progressPreview) {
        lines.push(`  > ${job.progressPreview.split("\n").join("\n  > ")}`);
      }
    }
    lines.push("");
  }

  if (snapshot.latestFinished) {
    lines.push("## Latest Finished\n");
    const j = snapshot.latestFinished;
    lines.push(`- **${j.id}** (${j.type}) — ${j.status} — ${j.elapsed}`);
    if (j.errorMessage) {
      lines.push(`  Error: ${j.errorMessage}`);
    }
    lines.push("");
  }

  if (snapshot.recent.length > 1) {
    lines.push("## Recent Jobs\n");
    for (const j of snapshot.recent.slice(1)) {
      lines.push(`- **${j.id}** (${j.type}) — ${j.status} — ${j.elapsed}`);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push("No OpenCode jobs found for this workspace.");
  }

  return lines.join("\n");
}

/**
 * Render a job result as human-readable text.
 * @param {object} job
 * @param {object} [resultData]
 * @returns {string}
 */
export function renderResult(job, resultData) {
  const lines = [];

  lines.push(`## Job: ${job.id}\n`);
  lines.push(`- **Type**: ${job.type}`);
  lines.push(`- **Status**: ${job.status}`);
  lines.push(`- **Duration**: ${job.elapsed ?? "unknown"}`);

  if (job.opencodeSessionId) {
    lines.push(`- **OpenCode Session**: ${job.opencodeSessionId}`);
  }

  lines.push("");

  if (job.status === "failed") {
    lines.push(`### Error\n\n${job.errorMessage ?? "Unknown error"}`);
  } else if (resultData) {
    if (resultData.rendered) {
      lines.push(`### Output\n\n${resultData.rendered}`);
    } else if (resultData.messages) {
      // Extract the last assistant message
      const assistantMsgs = resultData.messages.filter((m) => m.role === "assistant");
      const last = assistantMsgs[assistantMsgs.length - 1];
      if (last) {
        const text = extractMessageText(last);
        lines.push(`### Output\n\n${text}`);
      }
    } else if (resultData.summary) {
      lines.push(`### Summary\n\n${resultData.summary}`);
    } else {
      lines.push("### Output\n\n(No output captured)");
    }

    if (resultData.changedFiles?.length > 0) {
      lines.push(`\n### Changed Files\n`);
      for (const f of resultData.changedFiles) {
        lines.push(`- ${f}`);
      }
    }
  } else if (job.result) {
    lines.push(`### Output\n\n${job.result}`);
  }

  return lines.join("\n");
}

/**
 * Render a review result (structured JSON output).
 * @param {object} review
 * @returns {string}
 */
export function renderReview(review) {
  const lines = [];

  if (review.verdict) {
    const emoji = review.verdict === "approve" ? "PASS" : "NEEDS ATTENTION";
    lines.push(`## Review Verdict: ${emoji}\n`);
  }

  if (review.summary) {
    lines.push(`${review.summary}\n`);
  }

  if (review.findings?.length > 0) {
    lines.push(`### Findings (${review.findings.length})\n`);
    for (const f of review.findings) {
      lines.push(`#### ${f.severity?.toUpperCase()}: ${f.title}`);
      lines.push(`- **File**: ${f.file}:${f.line_start}-${f.line_end}`);
      lines.push(`- **Confidence**: ${(f.confidence * 100).toFixed(0)}%`);
      lines.push(`- ${f.body}`);
      lines.push(`- **Recommendation**: ${f.recommendation}`);
      lines.push("");
    }
  } else {
    lines.push("No findings.");
  }

  return lines.join("\n");
}

/**
 * Extract text content from a message object.
 * @param {object} msg
 * @returns {string}
 */
function extractMessageText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(msg);
}

/**
 * Render an OpenCode v2 session message list as a one-line-per-event trace.
 * @param {object[]} messages - oldest first
 * @returns {string}
 */
export function renderTrace(messages) {
  const clip = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const lines = [];
  for (const m of messages ?? []) {
    const ts = m?.time?.created ? new Date(m.time.created).toISOString().slice(11, 19) : "--:--:--";
    switch (m?.type) {
      case "user":
        lines.push(`[${ts}] user: ${clip(m.text)}`);
        break;
      case "assistant":
        for (const c of m.content ?? []) {
          if (c?.type === "text" && c.text?.trim()) {
            lines.push(`[${ts}] assistant: ${clip(c.text)}`);
          } else if (c?.type === "tool") {
            const input = c.state?.input ?? {};
            const detail = input.command ?? input.path ?? input.filePath ?? input.pattern ?? JSON.stringify(input);
            lines.push(`[${ts}] tool/${c.name}/${c.state?.status ?? "?"}: ${clip(detail, 160)}`);
          }
        }
        if (m.error?.message) lines.push(`[${ts}] error: ${clip(m.error.message)}`);
        break;
      case "shell":
        lines.push(`[${ts}] shell/${m.status}: ${clip(m.command, 160)}`);
        break;
      case "idle":
        lines.push(`[${ts}] idle: ${m.outcome}`);
        break;
      default:
        break;
    }
  }
  return lines.length ? lines.join("\n") : "(no activity)";
}

/**
 * Render setup status.
 * @param {object} status
 * @returns {string}
 */
export function renderSetup(status) {
  const lines = [];
  lines.push("## OpenCode Setup Status\n");

  lines.push(`- **Installed**: ${status.installed ? "Yes" : "No"}`);
  if (status.version) {
    lines.push(`- **Version**: ${status.version}`);
  }
  if (status.serverRunning !== undefined) {
    lines.push(`- **Server Running**: ${status.serverRunning ? "Yes" : "No (started on first use)"}`);
  }
  if (status.serverProblem) {
    lines.push(`- **Server Problem**: ${status.serverProblem}`);
  }
  if (status.providers?.length > 0) {
    lines.push(`- **Configured Providers**: ${status.providers.join(", ")}`);
  } else if (status.serverRunning) {
    lines.push(`- **Providers**: None configured. Run \`!opencode auth\` to set up.`);
  }
  if (status.reviewGate !== undefined) {
    lines.push(`- **Review Gate**: ${status.reviewGate ? "Enabled" : "Disabled"}`);
  }

  return lines.join("\n");
}
