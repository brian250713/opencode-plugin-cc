# OpenCode plugin for Claude Code

> **Tribute**: This project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/anomalyco/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## Quickstart

```bash
# 1. Install opencode v2 (once). npm 12+ blocks install scripts by default,
#    and @opencode/cli needs its postinstall to fetch the native binary.
npm i -g @opencode/cli --allow-scripts=@opencode/cli

# 2. Install the plugin (see Install section below)

# 3. Run the self-test
node ~/.claude/plugins/cache/tasict-opencode-plugin-cc/opencode/2.0.1/scripts/opencode-companion.mjs doctor
```

Then delegate a task from Claude Code:

```
/opencode:rescue grep for XXX in src/ and summarize
```

The companion starts `opencode serve` on `127.0.0.1:4096` on first use, with a password it
generates and keeps in the plugin data dir. If `opencode` prints
"postinstall script was not run", reinstall with the `--allow-scripts` flag above.

## What You Get

- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:rescue`, `/opencode:status`, `/opencode:result`, and `/opencode:cancel` to delegate work and manage background jobs

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/anomalyco/opencode) **v2** installed (`npm i -g @opencode/cli --allow-scripts=@opencode/cli`). opencode v1 (`opencode-ai`) is not supported.
- A configured AI provider in OpenCode (Claude, OpenAI, Google, etc.)
- Node.js 18.18 or later

## Install

Inside Claude Code, run:

```
! curl -fsSL https://raw.githubusercontent.com/tasict/opencode-plugin-cc/main/install.sh | bash
```

Then reload the plugin:

```
/reload-plugins
```

You should see:

```
Reloaded: 1 plugin · 7 skills · 6 agents · 3 hooks ...
```

Finally, verify your setup:

```
/opencode:setup
```

> **What the installer does**: Clones the repo to `~/.claude/plugins/marketplaces/`,
> caches the plugin files, and registers it in Claude Code's plugin config.
> It tries SSH first and falls back to HTTPS automatically.

### Set up an AI Provider

If OpenCode is installed but no AI provider is configured, set one up:

```
! opencode auth login
```

To check your configured providers:

```
! opencode auth list
```

### Uninstall

```
/plugin uninstall opencode@tasict-opencode-plugin-cc
/reload-plugins
```

## Command Mapping (codex-plugin-cc -> opencode-plugin-cc)

| codex-plugin-cc | opencode-plugin-cc | Description |
|---|---|---|
| `/codex:review` | `/opencode:review` | Read-only code review |
| `/codex:adversarial-review` | `/opencode:adversarial-review` | Adversarial challenge review |
| `/codex:rescue` | `/opencode:rescue` | Delegate tasks to external agent |
| `/codex:status` | `/opencode:status` | Show running/recent jobs |
| `/codex:result` | `/opencode:result` | Show finished job output |
| `/codex:cancel` | `/opencode:cancel` | Cancel active background job |
| `/codex:setup` | `/opencode:setup` | Check install/auth, toggle review gate |

## Slash Commands

- `/opencode:review` -- Normal OpenCode code review (read-only). Supports `--base <ref>`, `--wait`, `--background`.
- `/opencode:adversarial-review` -- Steerable review that challenges implementation and design decisions. Accepts custom focus text.
- `/opencode:rescue` -- Delegates a task to OpenCode via the `opencode:opencode-rescue` subagent. Supports `--model`, `--agent`, `--resume`, `--fresh`, `--background`.
- `/opencode:status` -- Shows running/recent OpenCode jobs for the current repo.
- `/opencode:result` -- Shows final output for a finished job, including OpenCode session ID for resuming.
- `/opencode:cancel` -- Cancels an active background OpenCode job.
- `/opencode:setup` -- Checks OpenCode install/auth, can enable/disable the review gate hook.

## Review Gate

When enabled via `/opencode:setup --enable-review-gate`, a Stop hook runs a targeted OpenCode review on Claude's response. If issues are found, the stop is blocked so Claude can address them first. Warning: can create long-running loops and drain usage limits.

## Job Auto-Heal

Long-running tasks spawned via `/opencode:rescue --background` can get stuck in
`investigating` status even after the OpenCode session has finished server-side —
typically because the task-worker process was killed before it recorded the result.

The companion now reconciles this automatically:

- `companion.mjs status` and `companion.mjs result` run a silent auto-heal
  pass before they read state, so they never report a false "running" state
  for a session that is actually complete.
- `companion.mjs heal` scans for stuck jobs and reconciles them in bulk. Pass
  `--dry-run` to preview, `--json` for machine-readable output, and `--all`
  to include jobs from other Claude sessions.

Each heal check reads `GET /api/session/:id`. Once the session went idle
(`time.idle >= job.startedAt`), the job is transitioned to `completed` (or
`failed`, if the session outcome was `failed`/`interrupted`) and the reply text
is persisted to the job data file. If the task-worker PID is dead and the
session has been silent for >60 s, the job is transitioned to `failed` with a
clear reason.

If the OpenCode server is unreachable, auto-heal is a no-op — status/result
commands still work, they just can't move stuck jobs forward until the server
comes back.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_REQUEST_TIMEOUT_MS` | `1800000` | Per-HTTP-request abort timeout |
| `OPENCODE_PROMPT_TIMEOUT_MS` | `14400000` | Absolute cap on one prompt turn — the session is interrupted |
| `OPENCODE_IDLE_TIMEOUT_MS` | `3600000` | No session activity for this long → interrupt |
| `OPENCODE_COMPLETION_POLL_MS` | `2000` | Session poll interval while a prompt runs |
| `OPENCODE_COMPANION_DATA` | (self-derived) | Override for plugin data dir (otherwise derived from script path) |
| `OPENCODE_MONITOR_RESULT_CHARS` | (hook default) | Monitor hook: max chars per tool-result snippet |
| `OPENCODE_MONITOR_HEARTBEAT_POLLS` | (hook default) | Monitor hook: polls between heartbeats |
| `OPENCODE_SERVER_PASSWORD` | (generated) | HTTP Basic auth password. Unset: the companion generates one and stores it in `<data dir>/state/server-auth.json` |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP Basic auth username |

Run `companion.mjs config` to see resolved values with source (env vs default).

## Pitfalls

- **`companion status` stuck on `investigating`** — run `companion heal` (or wait; `status`/`result` auto-heal on every call).
- **"rejected the companion's credentials"** — something else already runs an OpenCode server on port 4096 (a manual `opencode serve`, or the background service). Stop it so the companion can start its own, or set `OPENCODE_SERVER_PASSWORD` to that server's password.
- **"is not an OpenCode v2 API server"** — an opencode v1 server (or another program) holds port 4096. This plugin needs opencode v2.
- **"waiting for permission"** — the session hit a permission prompt no one can answer headlessly. Write tasks run with an allow-all ruleset; reviews use the read-only `plan` agent.
- **Live view of a running task** — `companion trace <task-id>` prints each tool call and message.
- **`CLAUDE_PLUGIN_DATA` points at another plugin** — harmless: the companion self-derives its own data dir from `import.meta.url`. `doctor` will print a WARN so you know.

## Troubleshooting

<details>
<summary><strong>Plugin not loading after install (0 plugins)</strong></summary>

1. Re-run the installer: `! curl -fsSL https://raw.githubusercontent.com/tasict/opencode-plugin-cc/main/install.sh | bash`
2. Run `/reload-plugins` again.
3. If still failing, restart Claude Code.
</details>

<details>
<summary><strong>Install script fails to clone</strong></summary>

The script tries SSH first, then HTTPS. If both fail:

- Check your network connection
- For SSH: ensure `ssh -T git@github.com` works
- For HTTPS: run `gh auth login` to set up credentials
</details>

<details>
<summary><strong>OpenCode commands not working</strong></summary>

1. Verify OpenCode is installed: `! opencode --version`
2. Verify a provider is configured: `! opencode auth list`
3. Run `/opencode:setup` to check the full status.
</details>

## Architecture

Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout, this plugin communicates with
OpenCode via its v2 HTTP API (`/api/*`, HTTP Basic auth). The server is automatically started and
managed by the companion scripts; prompts are queued and the companion polls the session until it
goes idle.

```
codex-plugin-cc                          opencode-plugin-cc
+----------------------+                 +------------------------+
| JSON-RPC over stdio  |                 | HTTP REST (v2 /api)    |
| codex app-server     |      vs.        | opencode serve         |
| Broker multiplexing  |                 | Native HTTP (no broker)|
| codex CLI binary     |                 | opencode CLI binary    |
+----------------------+                 +------------------------+
```

## Project Structure

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace registration
├── install.sh                            # One-line installer
├── plugins/opencode/
│   ├── .claude-plugin/plugin.json        # Plugin metadata
│   ├── agents/opencode-rescue.md         # Rescue subagent definition
│   ├── commands/                         # 7 slash commands
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── rescue.md
│   │   ├── status.md
│   │   ├── result.md
│   │   ├── cancel.md
│   │   └── setup.md
│   ├── hooks/hooks.json                  # Lifecycle hooks
│   ├── prompts/                          # Prompt templates
│   ├── schemas/                          # Output schemas
│   ├── scripts/                          # Node.js runtime
│   │   ├── opencode-companion.mjs        # CLI entry point
│   │   ├── session-lifecycle-hook.mjs
│   │   ├── stop-review-gate-hook.mjs
│   │   └── lib/                          # Core modules
│   │       ├── opencode-server.mjs       # HTTP API client
│   │       ├── state.mjs                 # Persistent state
│   │       ├── job-control.mjs           # Job management
│   │       ├── tracked-jobs.mjs          # Job lifecycle tracking
│   │       ├── render.mjs               # Output rendering
│   │       ├── prompts.mjs              # Prompt construction
│   │       ├── git.mjs                  # Git utilities
│   │       ├── process.mjs             # Process utilities
│   │       ├── args.mjs                # Argument parsing
│   │       ├── fs.mjs                  # Filesystem utilities
│   │       └── workspace.mjs           # Workspace detection
│   └── skills/                          # Internal skills
├── tests/                               # Test suite
├── LICENSE                              # Apache License 2.0
├── NOTICE                               # Attribution notice
└── README.md
```

## OpenCode Integration

Wraps the OpenCode HTTP server API. Picks up config from:
- User-level: `~/.config/opencode/config.json`
- Project-level: `.opencode/opencode.jsonc`

## License

Copyright 2026 OpenCode Plugin Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
