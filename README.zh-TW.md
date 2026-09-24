# Claude Code 的 OpenCode 外掛

[English](README.md) | 繁體中文

> **致敬**：本專案受 OpenAI 的 [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
> 啟發並向其致敬。外掛架構、指令結構與設計模式皆源自原本的 codex-plugin-cc 專案，
> 並改為搭配 [OpenCode](https://github.com/anomalyco/opencode) 而非 Codex 使用。

在 Claude Code 中使用 OpenCode 進行程式碼審查，或把任務委派給它。

本外掛適合想在既有工作流程中輕鬆開始使用 OpenCode 的 Claude Code 使用者。

## 快速開始

```bash
# 1. 安裝 opencode v2（只需一次）。npm 12+ 預設會封鎖安裝腳本，
#    而 @opencode/cli 需要執行 postinstall 才能下載原生執行檔。
npm i -g @opencode/cli --allow-scripts=@opencode/cli

# 2. 安裝外掛（見下方「安裝」一節）

# 3. 執行自我檢測
node ~/.claude/plugins/cache/tasict-opencode-plugin-cc/opencode/2.0.2/scripts/opencode-companion.mjs doctor
```

接著就能在 Claude Code 中委派任務：

```
/opencode:rescue grep for XXX in src/ and summarize
```

companion 會在第一次使用時於 `127.0.0.1:4096` 啟動 `opencode serve`，並自動產生一組密碼，
保存在外掛的資料目錄中。如果 `opencode` 顯示 "postinstall script was not run"，
請用上面的 `--allow-scripts` 旗標重新安裝。

## 功能

- `/opencode:review`：一般的唯讀 OpenCode 審查
- `/opencode:adversarial-review`：可引導方向的挑戰式審查
- `/opencode:rescue`、`/opencode:status`、`/opencode:result` 與 `/opencode:cancel`：委派工作並管理背景任務

## 需求

- [Claude Code](https://claude.com/claude-code)（CLI、桌面應用程式或 IDE 擴充功能）
- 已安裝 [OpenCode](https://github.com/anomalyco/opencode) **v2**（`npm i -g @opencode/cli --allow-scripts=@opencode/cli`）。不支援 opencode v1（`opencode-ai`）。
- 已在 OpenCode 中設定 AI 供應商（Claude、OpenAI、Google 等）
- Node.js 18.18 或更新版本

## 安裝

在 Claude Code 中執行：

```
! curl -fsSL https://raw.githubusercontent.com/tasict/opencode-plugin-cc/main/install.sh | bash
```

接著重新載入外掛：

```
/reload-plugins
```

應該會看到：

```
Reloaded: 1 plugin · 7 skills · 6 agents · 3 hooks ...
```

最後確認設定是否正確：

```
/opencode:setup
```

> **安裝程式做了什麼**：將 repo clone 到 `~/.claude/plugins/marketplaces/`，
> 快取外掛檔案，並註冊到 Claude Code 的外掛設定中。
> 它會先嘗試 SSH，失敗時自動改用 HTTPS。

### 設定 AI 供應商

如果已安裝 OpenCode 但尚未設定 AI 供應商，請先設定：

```
! opencode auth login
```

查看已設定的供應商：

```
! opencode auth list
```

### 解除安裝

```
/plugin uninstall opencode@tasict-opencode-plugin-cc
/reload-plugins
```

## 指令對照（codex-plugin-cc -> opencode-plugin-cc）

| codex-plugin-cc | opencode-plugin-cc | 說明 |
|---|---|---|
| `/codex:review` | `/opencode:review` | 唯讀程式碼審查 |
| `/codex:adversarial-review` | `/opencode:adversarial-review` | 挑戰式審查 |
| `/codex:rescue` | `/opencode:rescue` | 將任務委派給外部 agent |
| `/codex:status` | `/opencode:status` | 顯示執行中／最近的任務 |
| `/codex:result` | `/opencode:result` | 顯示已完成任務的輸出 |
| `/codex:cancel` | `/opencode:cancel` | 取消執行中的背景任務 |
| `/codex:setup` | `/opencode:setup` | 檢查安裝／驗證狀態，切換審查閘門 |

## 斜線指令

- `/opencode:review` -- 一般的 OpenCode 程式碼審查（唯讀）。支援 `--base <ref>`、`--wait`、`--background`。
- `/opencode:adversarial-review` -- 可引導方向的審查，會質疑實作與設計決策。可附上自訂的關注重點文字。
- `/opencode:rescue` -- 透過 `opencode:opencode-rescue` subagent 將任務委派給 OpenCode。支援 `--model`、`--agent`、`--resume`、`--fresh`、`--background`。
- `/opencode:status` -- 顯示目前 repo 中執行中／最近的 OpenCode 任務。
- `/opencode:result` -- 顯示已完成任務的最終輸出，包含可用於恢復的 OpenCode session ID。
- `/opencode:cancel` -- 取消執行中的背景 OpenCode 任務。
- `/opencode:setup` -- 檢查 OpenCode 安裝與驗證狀態，並可啟用／停用審查閘門 hook。

## 審查閘門（Review Gate）

透過 `/opencode:setup --enable-review-gate` 啟用後，Stop hook 會針對 Claude 的回應執行一次聚焦的 OpenCode 審查。若發現問題，就會阻擋 Stop，讓 Claude 先處理。警告：這可能造成長時間的迴圈並耗盡用量額度。

## 任務自動修復（Auto-Heal）

透過 `/opencode:rescue --background` 啟動的長時間任務，即使 OpenCode session 已在伺服器端完成，
仍可能卡在 `investigating` 狀態——通常是因為 task-worker 程序在記錄結果前就被終止了。

companion 現在會自動修正這種情況：

- `companion.mjs status` 與 `companion.mjs result` 在讀取狀態前會先靜默執行一次自動修復，
  因此不會把實際上已完成的 session 誤報為「執行中」。
- `companion.mjs heal` 會掃描卡住的任務並批次修正。加上 `--dry-run` 可預覽，
  `--json` 輸出機器可讀格式，`--all` 則會一併處理其他 Claude session 的任務。

每次修復檢查都會讀取 `GET /api/session/:id`。一旦 session 進入閒置
（`time.idle >= job.startedAt`），任務就會轉為 `completed`（若 session 結果為
`failed`／`interrupted` 則轉為 `failed`），並將回覆文字寫入任務資料檔。
若 task-worker 的 PID 已不存在，且 session 已超過 60 秒沒有動靜，任務會轉為 `failed`
並附上明確原因。

若 OpenCode 伺服器無法連線，自動修復不會做任何事——status／result 指令仍可正常使用，
只是在伺服器恢復前無法推進卡住的任務。

## 環境變數

| 變數 | 預設值 | 用途 |
|---|---|---|
| `OPENCODE_REQUEST_TIMEOUT_MS` | `1800000` | 單一 HTTP 請求的中止逾時 |
| `OPENCODE_PROMPT_TIMEOUT_MS` | `14400000` | 單次 prompt 回合的絕對上限——超過會中斷 session |
| `OPENCODE_IDLE_TIMEOUT_MS` | `3600000` | session 無任何活動超過此時間 → 中斷 |
| `OPENCODE_COMPLETION_POLL_MS` | `2000` | prompt 執行期間輪詢 session 的間隔 |
| `OPENCODE_COMPANION_DATA` | （自動推導） | 覆寫外掛資料目錄（否則由腳本路徑推導） |
| `OPENCODE_MONITOR_RESULT_CHARS` | （hook 預設） | Monitor hook：每段工具結果摘錄的最大字元數 |
| `OPENCODE_MONITOR_HEARTBEAT_POLLS` | （hook 預設） | Monitor hook：兩次心跳之間的輪詢次數 |
| `OPENCODE_SERVER_PASSWORD` | （自動產生） | HTTP Basic 驗證密碼。未設定時，companion 會產生一組並存放在 `<data dir>/state/server-auth.json` |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP Basic 驗證使用者名稱 |

執行 `companion.mjs config` 可查看解析後的值及其來源（環境變數或預設值）。

## 常見陷阱

- **`companion status` 卡在 `investigating`** —— 執行 `companion heal`（或稍候；`status`／`result` 每次呼叫都會自動修復）。
- **"rejected the companion's credentials"** —— 已有其他程式在 port 4096 執行 OpenCode 伺服器（手動執行的 `opencode serve` 或背景服務）。請停止它，讓 companion 啟動自己的伺服器，或將 `OPENCODE_SERVER_PASSWORD` 設為該伺服器的密碼。
- **"is not an OpenCode v2 API server"** —— port 4096 被 opencode v1 伺服器（或其他程式）占用。本外掛需要 opencode v2。
- **"waiting for permission"** —— session 遇到了無人能在無介面模式下回應的權限提示。寫入類任務會使用全部允許的規則集；審查則使用唯讀的 `plan` agent。
- **即時查看執行中的任務** —— `companion trace <task-id>` 會印出每次工具呼叫與訊息。
- **`CLAUDE_PLUGIN_DATA` 指向其他外掛** —— 無害：companion 會從 `import.meta.url` 自行推導資料目錄。`doctor` 會印出 WARN 提醒你。

## 疑難排解

<details>
<summary><strong>安裝後外掛沒有載入（0 plugins）</strong></summary>

1. 重新執行安裝程式：`! curl -fsSL https://raw.githubusercontent.com/tasict/opencode-plugin-cc/main/install.sh | bash`
2. 再執行一次 `/reload-plugins`。
3. 若仍失敗，請重新啟動 Claude Code。
</details>

<details>
<summary><strong>安裝腳本無法 clone</strong></summary>

腳本會先嘗試 SSH，再改用 HTTPS。若兩者都失敗：

- 檢查網路連線
- SSH：確認 `ssh -T git@github.com` 可以正常運作
- HTTPS：執行 `gh auth login` 設定憑證
</details>

<details>
<summary><strong>OpenCode 指令無法運作</strong></summary>

1. 確認已安裝 OpenCode：`! opencode --version`
2. 確認已設定供應商：`! opencode auth list`
3. 執行 `/opencode:setup` 檢查完整狀態。
</details>

## 架構

codex-plugin-cc 透過 stdin/stdout 使用 JSON-RPC 溝通，而本外掛則透過 OpenCode 的 v2 HTTP API
（`/api/*`，HTTP Basic 驗證）與其溝通。伺服器由 companion 腳本自動啟動與管理；
prompt 送出後進入佇列，companion 會持續輪詢 session 直到它進入閒置。

```
codex-plugin-cc                          opencode-plugin-cc
+----------------------+                 +------------------------+
| JSON-RPC over stdio  |                 | HTTP REST (v2 /api)    |
| codex app-server     |      vs.        | opencode serve         |
| Broker multiplexing  |                 | Native HTTP (no broker)|
| codex CLI binary     |                 | opencode CLI binary    |
+----------------------+                 +------------------------+
```

## 專案結構

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace 註冊
├── install.sh                            # 一行安裝程式
├── plugins/opencode/
│   ├── .claude-plugin/plugin.json        # 外掛中繼資料
│   ├── agents/opencode-rescue.md         # Rescue subagent 定義
│   ├── commands/                         # 7 個斜線指令
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── rescue.md
│   │   ├── status.md
│   │   ├── result.md
│   │   ├── cancel.md
│   │   └── setup.md
│   ├── hooks/hooks.json                  # 生命週期 hooks
│   ├── prompts/                          # Prompt 範本
│   ├── schemas/                          # 輸出 schema
│   ├── scripts/                          # Node.js 執行環境
│   │   ├── opencode-companion.mjs        # CLI 進入點
│   │   ├── session-lifecycle-hook.mjs
│   │   ├── stop-review-gate-hook.mjs
│   │   └── lib/                          # 核心模組
│   │       ├── opencode-server.mjs       # HTTP API 用戶端
│   │       ├── state.mjs                 # 持久化狀態
│   │       ├── job-control.mjs           # 任務管理
│   │       ├── tracked-jobs.mjs          # 任務生命週期追蹤
│   │       ├── render.mjs                # 輸出呈現
│   │       ├── prompts.mjs               # Prompt 組建
│   │       ├── git.mjs                   # Git 工具
│   │       ├── process.mjs               # 程序工具
│   │       ├── args.mjs                  # 參數解析
│   │       ├── fs.mjs                    # 檔案系統工具
│   │       └── workspace.mjs             # 工作區偵測
│   └── skills/                           # 內部 skills
├── tests/                                # 測試
├── LICENSE                               # Apache License 2.0
├── NOTICE                                # 署名聲明
├── README.md
└── README.zh-TW.md
```

## OpenCode 整合

包裝 OpenCode 的 HTTP 伺服器 API。會讀取下列設定：
- 使用者層級：`~/.config/opencode/config.json`
- 專案層級：`.opencode/opencode.jsonc`

## 授權

本專案採用 Apache License 2.0 授權。以下為具法律效力的英文原文：

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
