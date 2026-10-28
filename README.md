# opencode-team

**Put OpenCode or ZCode workers on your Claude Code team.** Claude (Opus, Sonnet…) plans, delegates, reviews, and approves the workers' shell commands like a project manager. The coding runs only on the model you choose: a local Qwen, a company-hosted endpoint, DeepSeek, GLM, Ollama…

Workers never wait on you. In the default `lead` mode they edit files freely, and every shell command they want to run is sent to Claude, which answers `approve` or `reject: <why>`. The worker reads the reason and carries on.

From Claude's side a worker looks and behaves like any background teammate:

| Claude does | What happens |
| --- | --- |
| `Agent(subagent_type: "opencode-team:worker", name: "qwen-api", prompt: …)` | An OpenCode session starts on your configured model and gets the task |
| *(worker finishes a turn)* | Its reply — plus the files it changed — arrives in Claude's conversation as a message |
| `SendMessage(to: "qwen-api", message: …)` | The message goes into the same OpenCode session; the worker keeps its context |
| `TaskStop("qwen-api")` | The OpenCode session is aborted |
| *(worker calls `team_send`)* | The worker messages the lead, a Claude teammate, or another worker on its own |
| *(worker wants to run `npm test`)* | Claude gets "qwen-api is waiting for your approval to use bash: npm test" and answers with `SendMessage(to: "qwen-api", message: "approve")` or `"reject: run npm run lint instead"` |

It works from the lead and from Claude teammates in an [agent team](https://code.claude.com/docs/en/agent-teams): a Claude teammate that messages a worker gets the reply back itself.

```
┌──────────────── Claude Code session ────────────────┐
│ lead (Opus) ── Agent / SendMessage / TaskStop ──┐   │
│ Claude teammates ───────────────────────────────┤   │
│                                   opencode-team mod │
└─────────────────────────────────────┬───────────────┘
                     HTTP (localhost) │ ▲ replies, team_send
                                      ▼ │
                 opencode serve ── sessions: qwen-api, qwen-web …
                                      │
                       your model (Qwen via company API, Ollama …)
```

## Install by asking Claude

Paste this into Claude Code. Claude will check your machine, ask for your model's URL, model id and key, set up OpenCode or ZCode, install the plugin with your settings, and check that the model answers:

```
Install and set up the opencode-team plugin for me by following
https://raw.githubusercontent.com/NakharinA/Claude-Local-Teammate-Plugin/main/INSTALL.md
Ask me for anything you need (backend, model URL, model id, API key).
```

To skip the questions, put the answers in the prompt:

```
Install and set up the opencode-team plugin by following
https://raw.githubusercontent.com/NakharinA/Claude-Local-Teammate-Plugin/main/INSTALL.md
Backend: OpenCode. Model: qwen3.8 at https://llm.mycompany.com/v1, key in the COMPANY_API_KEY env var.
```

The steps Claude follows are in [INSTALL.md](INSTALL.md), if you'd rather do it by hand.

## Quick install

You need Claude Code **2.1.287 or newer** (`claude --version`; update with `npm i -g @anthropic-ai/claude-code@latest`) and Node.js.

**With OpenCode.** Your model must already work in OpenCode (`opencode run -m company/qwen3.8 "say hi"`; see [Configure](#1-tell-opencode-about-your-model) to add it).

```bash
npm i -g opencode-ai
claude plugin install opencode-team --marketplace NakharinA/Claude-Local-Teammate-Plugin \
  --config model=company/qwen3.8
```

**With ZCode.** Install the [ZCode desktop app](https://github.com/zai-org/ZCode/releases) and add your Qwen provider to `~/.zcode/v2/provider_config.json` (format under [Configure](#1-tell-opencode-about-your-model)).

```bash
claude plugin install opencode-team --marketplace NakharinA/Claude-Local-Teammate-Plugin \
  --config backend=zcode --config model=qwen/qwen3.8
```

Replace `company/qwen3.8` or `qwen/qwen3.8` with your own `provider/model`. On Windows PowerShell, put the command on one line, or replace each `\` with a backtick.

**Then, in your project:**

```
claude
/opencode-team setup      # OpenCode only: lets workers message the team
/opencode-team            # check: server or ZCode found, model, workers
```

Now ask Claude to delegate:

> Spawn an opencode worker named qwen-api to implement GET /users in src/api.js with a test. Approve its test commands, review its diff, and report back.

Workers edit files on their own, and Claude approves or rejects each shell command they want to run. To approve commands yourself instead, add `--config workerPermissions=ask`. All options are listed under [Configure](#2-set-the-plugins-options).

## Status

Early (v0.2). Built on Claude Code **mods**, which are new: the APIs this uses can change between Claude Code releases.

| Tested with | Version |
| --- | --- |
| Claude Code | 2.1.304 (mods need ≥ 2.1.287) |
| OpenCode | 1.19.3 |
| ZCode | desktop app 3.14.3, CLI 0.16.9 |
| OS | Linux; Windows 11 (unit tests and the end-to-end runs). macOS should behave like Linux. See [Windows](#windows). |

What has been exercised end to end, with a real Claude Code session against a mock model:
- **OpenCode:** spawn, reply, follow-up message, `team_send` to the lead, auto-start, and shell commands approved or rejected by Claude in `lead` mode, or by you in `ask` mode.
- **ZCode:** spawn, reply, follow-up message resuming the same session, `team_send` to the lead, and a shell command rejected by Claude with a reason.

The Claude-teammate ↔ worker path and worker ↔ worker routing are covered by the unit tests only, because headless Claude Code can't spawn agent-team teammates.

## Install

You need Claude Code ≥ 2.1.287, Node.js on `PATH`, and one of:
- **OpenCode** (`npm i -g opencode-ai`) with your model already working in it, or
- **ZCode** (the [desktop app](https://github.com/zai-org/ZCode/releases); its CLI ships inside it) with your model added as a provider.

**From GitHub:**

```bash
claude plugin install opencode-team --marketplace NakharinA/Claude-Local-Teammate-Plugin
# Claude Code older than 2.1.292: two steps
claude plugin marketplace add NakharinA/Claude-Local-Teammate-Plugin
claude plugin install opencode-team@opencode-team
```

Add `--scope project` to enable it for one project only (stored in `.claude/settings.json`, shared with the repo). To update later: `claude plugin update opencode-team@opencode-team`.

**From a local folder** (one session, good for trying it):

```bash
claude --plugin-dir /path/to/opencode-team
```

## Configure

### 1. Tell OpenCode about your model

If OpenCode already talks to your model, skip this. For a company OpenAI-compatible endpoint, add a provider to `opencode.json` in your project (or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "company": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Company Qwen",
      "options": { "baseURL": "https://YOUR_URL/v1", "apiKey": "{env:COMPANY_API_KEY}" },
      "models": { "qwen3.8": { "name": "Qwen 3.8" } }
    }
  }
}
```

Check it by hand first: `opencode run -m company/qwen3.8 "say hi"`.

**ZCode instead:** add the provider in `~/.zcode/v2/provider_config.json` (ZCode doesn't expand environment variables there, so the key is written in the file):

```json
{"schemaVersion": 1, "config": {
  "providerConfigRules": {"providerRules": [{"providerId": "qwen", "providerName": "Company Qwen",
    "config": {"group": "standard-personal",
      "access": {"type": "api-key", "apiKey": "YOUR_KEY"},
      "api": {"type": "openai-chat-completions", "baseUrl": "https://YOUR_URL/v1"},
      "personalModelIds": ["qwen3.8"]}}]},
  "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
  "defaultModelSelection": {"providerId": "qwen", "modelId": "qwen3.8"}}}
```

### 2. Set the plugin's options

In Claude Code run `/plugin configure opencode-team@opencode-team` (or `/config`):

| Option | Default | What it does |
| --- | --- | --- |
| `backend` | `opencode` | `opencode` or `zcode`: which coding agent runs the workers |
| `model` | — **(required)** | The only model workers run on. OpenCode: `provider/model`, e.g. `company/qwen3.8`. ZCode: `providerId/modelId` from the provider config, e.g. `qwen/qwen3.8`. Without it, workers aren't started |
| `models` | — | Optional extra models one spawn can pick with the Agent call's `model` field: `alias=provider/model`, comma-separated, e.g. `sonnet=github-copilot/claude-sonnet-5.5`. Without a `model` on the call, workers use `model`. An alias that isn't listed is refused, never swapped for another model |
| `workerPermissions` | `lead` | `lead`: workers edit files freely and **Claude approves or rejects every shell command**; you get no dialogs. `ask`: you approve every shell command in a Claude Code dialog. `read-only`: no edits, no shell. `full-auto`: edits and shell without asking |
| `serverUrl` | `http://127.0.0.1:4096` | OpenCode: where `opencode serve` listens. With OpenCode 2, if nothing usable answers here, the mod uses OpenCode's background service instead (URL and password from `~/.local/state/opencode/service.json`) |
| `autoStart` | `true` | OpenCode: start `opencode serve` in the project folder if nothing answers |
| `opencodeCommand` | `opencode` | OpenCode: path to OpenCode if it isn't on `PATH` |
| `agent` | `build` | OpenCode: the agent workers run as. Pinned so that plugins which replace OpenCode's default agent can't switch the model |
| `zcodeCommand` | `zcode` | ZCode: the CLI. On Windows the default finds the desktop app's copy at `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`; set the full path if ZCode is installed elsewhere |
| `serverPassword` | — | OpenCode: only if you run it with `OPENCODE_SERVER_PASSWORD` |
| `pollSeconds` | `2` | How often replies, approval requests and messages are picked up |

### 3. Once per project: install the team tools (OpenCode only)

```
/opencode-team setup
```

This copies [`opencode/tools/team.ts`](opencode/tools/team.ts) to `.opencode/tools/` so workers get `team_send` and `team_members`, and adds `.opencode-team/` to `.gitignore`. Restart `opencode serve` afterwards if it was running (OpenCode loads tools at startup). Workers work without this step; they just can't start conversations on their own. ZCode workers get the same two tools automatically from a small MCP server ([`zcode/team-mcp.mjs`](zcode/team-mcp.mjs)).

## Use it

Ask the lead in plain words:

> Plan the users feature. Spawn an opencode worker named qwen-api for the backend endpoint and one named qwen-web for the page. Review their diffs and run the tests before you accept anything.

`/opencode-team` shows the server, the model and every worker with its state. Each worker's conversation is logged to `.opencode-team/logs/<name>.md`, which Claude can read while the worker runs.

### Claude approves the workers' commands (`lead` mode)

When a worker wants to run a shell command (or fetch a web page), Claude gets a message like this:

```
qwen-api (OpenCode worker, company/qwen3.8) is waiting for your approval to use bash:

    npm test

Answer with SendMessage(to: "qwen-api", message: …):
- "approve": run it this once
- "approve always": also allow the same kind of command for the rest of its session
- "reject: <why, or what to do instead>": it is not run; the worker reads your reason and carries on
```

How it behaves:
- The worker waits until Claude answers. Any answer that isn't a yes counts as a rejection, and the whole text goes to the worker as the reason.
- If several requests queue up, Claude sees them one at a time, and each answer shows the next request.
- `/opencode-team` and the status line show which workers are *awaiting approval*.
- ZCode has no "approve always". A ZCode request that gets no answer within 14 minutes is rejected.

### Make Claude a good project manager

Local models do best on narrow, well-specified tasks. Put rules like these in your project's `CLAUDE.md`:

```markdown
## Delegation
- Delegate implementation to opencode workers (subagent_type "opencode-team:worker"); you plan and review.
- One task per worker: one module or a few files, the exact function signatures, and a test that defines done.
- Give each worker a name and say which files it owns, so two workers never edit the same file.
- When a reply arrives: read the diff, run the tests, then accept or SendMessage specific feedback.
- Approve workers' build, test and lint commands inside the project. Reject anything destructive (rm -rf, git push, installs), outside the project, or unrelated to the task, and say what to do instead.
- If a worker fails the same task twice, do it yourself.
```

## How it works

The mod uses only documented Claude Code mod hooks — nothing reads or writes Claude Code's internal team files:

- **Spawn.** A `tool.call` hook on `Agent` answers calls for `opencode-team:worker` itself: it creates an OpenCode session (`POST /session` with the permission rules), sends the task (`prompt_async`), and returns a normal *background agent launched* result, so Claude treats the worker like any background agent.
- **Messages in.** A `tool.call` hook on `SendMessage` forwards messages addressed to a worker; messages to anyone else pass through untouched. `TaskStop` works the same way.
- **OpenCode 1 and 2.** OpenCode 2 moved its API under `/api` and changed the request and message shapes. The mod probes the server and talks to either version; the paths below are OpenCode 1's. With OpenCode 2 the model is pinned on the session rather than on each prompt, the team instructions open the first prompt (v2 prompts take no system text), and a turn counts as finished once OpenCode writes its `idle` message.
- **Replies out.** A timer polls OpenCode (`/session/status`, `/session/{id}/message`). When a worker's turn ends, its text, changed files and any error go to whoever last wrote to it: the lead via `$.prompt.submit`, a Claude teammate via `$.session.send`.
- **Worker-initiated messages.** `team_send` appends a line to `.opencode-team/outbox.jsonl`; the timer routes it. `team_members` reads `.opencode-team/team.json`, which the mod keeps current.
- **Approvals.**
  - **OpenCode:** a shell or web request a worker makes (`/permission`) goes to Claude in `lead` mode, or to you as a dialog in `ask` mode. The answer goes back through `POST /permission/{id}/reply`; a rejection carries its reason, so the worker's turn continues.
  - **ZCode:** the worker runs in `yolo` mode with a `PreToolUse` hook ([`zcode/approve.mjs`](zcode/approve.mjs)) on `Bash|WebFetch|WebSearch`. The hook writes the request to a file and waits for the answer the mod writes back. ZCode's `PermissionRequest` hook can't be used, because in headless runs it loses a race against ZCode's built-in deny.
  - **In `ask` mode with nobody to answer** (`claude -p`), the request is rejected and the lead is told what was not run.
  - **Turned off on both backends:** questions that would wait for a person nobody sees, and subagents.
- **Only your model.** Workers aren't started without `model`. OpenCode prompts pin the model and the `build` agent, and `task` (subagents) is denied. ZCode runs with a provider config whose default is your model, and `Agent` is disallowed. If a reply still comes from another model, Claude is told.
- **ZCode turns.** ZCode has no server, so each turn is one detached `zcode --prompt … --output-format stream-json` run ([`zcode/run-turn.mjs`](zcode/run-turn.mjs)), with `--resume` on later turns. Each worker gets a private ZCode home under `~/.opencode-team/zcode/<project>/<worker>`, which holds its config, sessions and approval files. Your own ZCode settings aren't touched, and nothing with your API key is written into the project.
- **A worker never runs as Claude.** If the spawn isn't intercepted, an `agent.spawn` hook refuses it rather than silently starting a Claude subagent.

## Windows

Tested on Windows 11 with Claude Code 2.1.304 and OpenCode 1.19.3: `claude plugin test` passes, and the end-to-end run (auto-start, spawn, reply, follow-up message, `team_send`, shell-command rejection) works.

- Check `claude --version` first. Claude Code older than 2.1.287 has no mods: the plugin installs, but the spawn is never intercepted.
- Auto-start uses PowerShell `Start-Process`, which finds `opencode.cmd` on `PATH` (npm or Yarn global installs). If it doesn't start OpenCode, set `autoStart` to `false` and run it yourself in the project folder: `opencode serve --port 4096`.
- If `opencode` isn't found, set `opencodeCommand` to the full path, e.g. `C:\Users\you\AppData\Roaming\npm\opencode.cmd`.
- The auto-started server has no window. If an OpenCode plugin of yours shows desktop notifications (a session finished, a permission is wanted), they come from that hidden server and can't be acted on there; approvals reach you in Claude Code.
- For the `dev/` scripts use `python` instead of `python3`. `dev/drive.py` reads `CLAUDE_BIN` to pick a specific Claude Code.

## Limitations

- **Not a native teammate.** Workers don't appear in Claude Code's agent panel or `/list-agents`; use `/opencode-team`. To Claude they look like background agents named by you.
- **Replies wait for an idle lead.** A reply to the lead starts its next turn once the lead finishes the current one. A reply to a Claude teammate is sent the way SendMessage sends to it.
- **One OpenCode server per project folder**, shared by all workers. No git-worktree isolation yet, so give workers separate files.
- **Worker-to-worker chatter is capped** at 6 exchanges without the lead; the next message is held for the lead.
- **Quality depends on the model's tool calling.** If a worker doesn't use `team_send` or wanders off, tighten the task, or keep it to edits and let Claude run the tests.
- **Workers survive a hot reload or `claude --resume` of the same session**, but not a brand-new session.

## Develop

```bash
claude plugin validate --strict .   # static checks of the manifest and the hooks module
claude plugin test                   # unit tests with a fake OpenCode server (no network, no sign-in)
```

`dev/` has the end-to-end rig used during development: [`dev/mock_llm.py`](dev/mock_llm.py) is a deterministic OpenAI-compatible model server that stands in for Qwen (it can call `team_send` and `bash` on cue), and [`dev/drive.py`](dev/drive.py) drives a real headless Claude Code session with the mod loaded and prints the conversation.

```bash
python3 dev/mock_llm.py 18080 /tmp/mock.log &
# in a test project whose opencode.json points a "company" provider at http://127.0.0.1:18080/v1:
python3 dev/drive.py /path/to/test-project settings.json 120 'Spawn an opencode worker named qwen-api …'
```

## License

MIT
