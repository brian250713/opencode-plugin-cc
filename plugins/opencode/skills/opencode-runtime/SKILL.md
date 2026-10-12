---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"`

Default dispatch pattern — **dispatch then wait-and-result loop** (same as the `opencode:opencode-rescue` agent instructions):

1. `task --background --write "<prompt>"` → capture the task-id from stdout (`task-[a-z0-9]{6,}-[a-z0-9]{4,}`).
2. Loop up to 20 times: `wait-and-result <task-id> --max-wait 480`. It polls internally and fits under the Bash 10-minute cap.
   - Exit 0: the job is terminal and stdout is the rendered `result` report (`## Job:` header, `### Output` section). Return it unchanged.
   - Exit 2: still running — call it again.
   - Exit 1: return `ERROR: companion dispatch failed (wait-and-result exit 1)`.
3. After 20 rounds without exit 0, return `ERROR: companion dispatch failed (timeout after 20 wait-and-result rounds)`.

Do not hand-roll `sleep` + `status` polling, and do not use `tail -f` on the companion log file. Each extra Bash call is a chance to time out or return a vague fallback string; `wait-and-result` does the polling and the final `result` render in one call.

Execution rules:

- The rescue subagent is a forwarder, not an orchestrator. Its only work is the dispatch plus the `wait-and-result` loop, returning its final stdout.
- Prefer the helper over hand-rolled `git`, direct OpenCode CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, or `cancel` from the subagent. `wait-and-result` (and `status` / `result`, if ever needed) are permitted only as part of the wait loop.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `opencode-prompting` skill to rewrite the user's request into a tighter OpenCode prompt before the `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--agent` unset unless the user explicitly requests a specific agent (build or plan).
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.

Command selection:

- Use exactly one `task` invocation per rescue handoff, followed by the `wait-and-result` loop.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`. The dispatch always uses `--background` at the companion level internally.
- If the forwarded request includes `--model`, pass it through to `task`.
- If the forwarded request includes `--agent`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.

Safety rules:

- Default to write-capable OpenCode work in `opencode:opencode-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, fetch results outside the wait loop, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the final `wait-and-result` call (exit 0) exactly as-is.
- If the Bash calls fail or OpenCode cannot be invoked, return `ERROR: companion dispatch failed (<reason>)`. Never return placeholder strings like "Monitor started" or "Waiting for completion" — they are failure modes, not results.
