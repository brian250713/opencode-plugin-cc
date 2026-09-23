# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin (`opencode`, marketplace `tasict-opencode-plugin-cc`) that lets Claude delegate tasks and code reviews to [OpenCode](https://github.com/anomalyco/opencode). It is a port of OpenAI's `codex-plugin-cc`; many comments reference the codex equivalents. Pure Node.js ESM (`.mjs`), no runtime dependencies, Node >= 18.18.

## Commands

```bash
npm test                                   # node --test tests/*.test.mjs
node --test tests/state.test.mjs           # single test file
node --test --test-name-pattern="roundtrip" tests/state.test.mjs   # single test
node plugins/opencode/scripts/opencode-companion.mjs <subcommand>  # run companion from source
```

Companion subcommands: `setup`, `review`, `adversarial-review`, `task`, `task-worker` (internal), `task-resume-candidate`, `status`, `result`, `wait-and-result`, `cancel`, `heal`, `doctor [--fix]`, `config`.

Tests only cover pure `lib/` modules (args, git, job-control, process, render, state). They isolate state via `tests/helpers.mjs` (sets `CLAUDE_PLUGIN_DATA` to a tmp dir). Nothing tests against a live OpenCode server. Process tests spawn `process.execPath` rather than `sh`/`echo` so they pass on Windows too.

## Architecture

Two layers:

1. **Claude-facing markdown** in `plugins/opencode/` — `commands/*.md` (slash commands), `agents/opencode-rescue.md` (subagent), `skills/`, `prompts/`, `hooks/hooks.json`. These are instructions to Claude; they almost all reduce to shelling out to `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" <subcommand> ...` and returning stdout **verbatim**. Changing companion output format can break these contracts (e.g. the rescue agent and hooks look for the `## Job:` header, `### Output` section, and task ids matching `task-[a-z0-9]{6,}-[a-z0-9]{4,}`).

2. **Companion runtime** in `plugins/opencode/scripts/` — `opencode-companion.mjs` is a single-file subcommand dispatcher (`handlers` map at top); logic lives in `lib/`.

Key flows:

- **Server**: `lib/opencode-server.mjs` talks to `opencode serve` over HTTP REST + SSE on `127.0.0.1:4096` (no JSON-RPC/broker, unlike codex). `connect()` → `ensureServer()` auto-spawns the server and first runs `ensureOpencodeConfig()` (`lib/opencode-config.mjs`) to merge `permission.*=allow` into `~/.config/opencode/opencode.json` — otherwise bash tools hang headless (sst/opencode#14473). `sendPrompt` has a watcher: completion polling, idle watchdog, and a pgrep-based "stuck bash tool" detector; tunables are the `OPENCODE_*_MS` env vars listed in README.
- **Background tasks**: `task --background` records a `queued` job, then `spawnDetached`s itself as `task-worker`, which runs via `runTrackedJob` (`lib/tracked-jobs.mjs`). The rescue subagent then loops on `wait-and-result <task-id> --max-wait 480` (exit 0 done, 2 timeout/keep looping, 1 error).
- **Auto-heal** (`lib/auto-heal.mjs`): `status`/`result` silently reconcile jobs stuck in `investigating` by querying `GET /session/:id/message?limit=1`; dead worker PID + >60s silence → `failed`. `heal` does it in bulk.
- **State** (`lib/state.mjs`): per-workspace JSON state keyed by SHA-256 of workspace path, plus per-job data/log files, capped at 50 jobs. Data dir resolution order: `OPENCODE_COMPANION_DATA` → path self-derived from the script's install location under `plugins/cache/<owner-repo>/<plugin>/<version>/` → `CLAUDE_PLUGIN_DATA` only if it names this plugin → tmp fallback. This deliberately ignores `CLAUDE_PLUGIN_DATA` leaked from other plugins (e.g. codex).
- **Hooks** (`hooks/hooks.json`): SessionStart/SessionEnd lifecycle; Stop → `stop-review-gate-hook.mjs` (only active when `setup --enable-review-gate` sets `state.config.reviewGate`); PostToolUse on `Agent|Bash` → monitor hook (injects reminders to Monitor dispatched task ids) and on `Agent` → vague-notification hook (catches rescue subagent returning placeholder text instead of the real result).
- **Windows / spawning**: never spawn with `shell: true` plus caller-supplied args — Node doesn't escape them (DEP0190), so task text reaches cmd.exe as commands, and `child.pid` becomes the shell's PID (breaks `cancel` and auto-heal). `runCommand`/`spawnDetached` take a real executable (use `process.execPath`, not `"node"`). `opencode` itself goes through `opencodeSpawnSpec()`, which unwraps the npm `.cmd` shim to the native `.exe` and only falls back to cmd.exe for whitelisted fixed args.

## Versioning

Version is duplicated in `package.json`, `.claude-plugin/marketplace.json` (twice), and `plugins/opencode/.claude-plugin/plugin.json`; bump all together. `install.sh` reads the version from `plugin.json` to build the cache path, and the README Quickstart path hardcodes it too.
