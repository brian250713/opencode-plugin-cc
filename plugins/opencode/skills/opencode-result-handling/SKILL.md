---
name: opencode-result-handling
description: Guidance for interpreting and presenting OpenCode task results, plus how to poll live progress of a running background task
user-invocable: false
---

# OpenCode Result Handling

## Result Structure

OpenCode returns results as structured session data containing:
- **Messages**: The full conversation between the user prompt and OpenCode's agent
- **Tool calls**: All tool invocations (bash, edit, read, write, grep, glob, etc.)
- **File changes**: Diffs of all files modified during the session
- **Status**: Whether the session completed successfully, was aborted, or errored

## Presenting Results

When displaying results from `/opencode:result`:
1. Show the session ID for reference
2. Present the final assistant message as the primary output
3. If file changes were made, summarize which files were modified
4. Include the session status (completed/aborted/error)

## Resuming Sessions

OpenCode sessions can be resumed by sending additional messages to the same session.
The `--resume-last` flag in the companion script handles this by reusing the last session ID
from the current workspace state.

## Inspecting Live Progress (while a task is still running)

A dispatched opencode task produces live progress in several layers — use the appropriate tool for the granularity you need.

### Layer 1: Companion phase (coarse, whole-task)

Phase-level signals like `starting → investigating → running → completed/failed`. Useful to confirm the task is alive, not the specific work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
```

Returns JSON with `job.status`, `job.phase`, `job.elapsed`, `job.opencodeSessionId`, and a `progressPreview` string (just phase-transition lines).

### Layer 2: Full tool-call trace (fine, every action)

The companion's `trace` subcommand reads the session's messages from the local OpenCode server (it handles the server's Basic auth for you) and prints one line per event — prompts, assistant text, every tool call with its status, shell runs, and the final idle outcome. This is the best signal for "what has opencode actually done so far."

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" trace <task-id> --limit 20
```

`<task-id>` is the companion job id (or pass an OpenCode session id `ses_...` directly). Output looks like:

```
[23:32:30] user: Create a file named e2e.txt ...
[23:32:36] tool/write/completed: e2e.txt
[23:32:36] tool/shell/running: npm test
[23:32:42] assistant: DONE
[23:32:42] idle: succeeded
```

Add `--json` for the raw v2 message list. Do not `curl` the server directly — every `/api` route requires the companion's credentials.

### Layer 3: Bash wrapper output (when subagent tails companion --wait)

When the rescue subagent runs `companion task --wait` via Bash `run_in_background=true`, the subagent's Bash tool emits a local_bash task-id (e.g. `buzkqvlq7`). Use `TaskOutput(task_id=<bash-id>, block=false)` to see the raw tail of the companion's stdout — this has phase lines, **not** the inner opencode session messages. Prefer Layer 2 for real content.

### Which layer to use

- "Is the task still alive / which phase?" → Layer 1 (companion status).
- "What has opencode actually been doing the last few minutes?" → Layer 2 (`companion trace`).
- "What did the subagent's shell emit?" → Layer 3 (TaskOutput on the bash-id).

## When to Ask the User

If Layer 2 shows the opencode task has been stuck on the same tool call for many minutes without progress, or is looping on the same error, surface that to the user — they can decide whether to cancel or let it continue. Do not silently wait through apparent deadlocks.
