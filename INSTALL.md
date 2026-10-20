# Installing opencode-team (instructions for Claude)

These steps are written for Claude Code to follow when a person asks it to install and set up
opencode-team. A person can follow them by hand too.

Work through the steps in order. Ask the person only for what you can't find out yourself, and ask
it in one message per step. Never print an API key back, and never write one into a file that git
tracks.

## 1. Check the machine

Run these and note the results:

```bash
claude --version
node --version
opencode --version
git --version
```

- **Claude Code below 2.1.287:** the plugin can't work, because it relies on mods. Tell the person
  to quit Claude Code, run `npm i -g @anthropic-ai/claude-code@latest` (and
  `yarn global upgrade @anthropic-ai/claude-code` if `claude` comes from Yarn), and then start you
  again. Stop here, since Claude Code can't upgrade itself while it is running.
- **Node.js missing:** ask the person to install it from https://nodejs.org. Workers and the ZCode
  scripts need it.
- **Windows:** `git` (Git for Windows) matters for ZCode, because its shell tool uses Git Bash.

## 2. Choose the backend

Ask which coding agent should run the workers, unless the person already said:

- **OpenCode** (default): a local server. It supports "approve always" and is the best tested.
- **ZCode**: Z.ai's agent, which needs the ZCode desktop app.

## 3. Get the model details

Ask for:

1. the model's **base URL**, OpenAI-compatible and ending in `/v1` (e.g. `https://llm.company.com/v1`,
   or `http://localhost:11434/v1` for Ollama);
2. the **model id** the endpoint expects (e.g. `qwen3.8`, `qwen2.5-coder:32b`);
3. how to get the **API key**: an environment variable that is already set (preferred), or the key
   itself. Local servers such as Ollama usually need no key; use any placeholder text then.

Use `company` as the provider id unless the person wants another one. The worker model is then
`company/<model id>` for OpenCode, or `qwen/<model id>` for ZCode with provider id `qwen`.

## 4a. OpenCode: install it and add the provider

1. If `opencode --version` failed, run `npm i -g opencode-ai`.
2. Add the provider to the global OpenCode config, `~/.config/opencode/opencode.json` (on Windows,
   `%USERPROFILE%\.config\opencode\opencode.json`). If an `opencode.jsonc` exists there instead,
   edit that file. Merge into the existing file, and keep its other keys and plugins:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "company": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Company Qwen",
         "options": { "baseURL": "<BASE_URL>", "apiKey": "{env:COMPANY_API_KEY}" },
         "models": { "<MODEL_ID>": { "name": "<MODEL_ID>" } }
       }
     }
   }
   ```

   `{env:COMPANY_API_KEY}` makes OpenCode read the key from that environment variable. If the person
   only has the key itself, ask them to set the variable themselves rather than pasting the key into
   the chat:
   - Windows: `setx COMPANY_API_KEY "..."`, then open a new terminal
   - macOS/Linux: `export COMPANY_API_KEY=...` in their shell profile
3. Check that the model answers:
   `opencode run -m company/<MODEL_ID> "Reply with exactly: ok"`.
   If it fails, show the error and fix the base URL, model id or key before going on.

## 4b. ZCode: find it and add the provider

1. Look for the CLI that ships inside the desktop app:
   - Windows: `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`
   - otherwise: `zcode` on `PATH`

   If it isn't there, ask the person to install the app from
   https://github.com/zai-org/ZCode/releases (or for the folder they installed it to), then look again.
2. Add the provider to `~/.zcode/v2/provider_config.json`. Merge into the file if it already exists:
   append to `providerRules`, and leave other providers and `defaultModelSelection` alone.

   ```json
   {"schemaVersion": 1, "config": {
     "providerConfigRules": {"providerRules": [{"providerId": "qwen", "providerName": "Company Qwen",
       "config": {"group": "standard-personal",
         "access": {"type": "api-key", "apiKey": "<API_KEY>"},
         "api": {"type": "openai-chat-completions", "baseUrl": "<BASE_URL>"},
         "personalModelIds": ["<MODEL_ID>"]}}]},
     "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
     "defaultModelSelection": {"providerId": "qwen", "modelId": "<MODEL_ID>"}}}
   ```

   ZCode doesn't read environment variables in this file, so the key itself has to go in. Tell the
   person this before you write it. The file is in their home folder, outside any repository.
3. Check that the model answers. Outside the app, the app's `zcode.cjs` needs both provider files
   named explicitly (the plugin does the same). On Windows, in PowerShell:

   ```powershell
   $z = "$env:LOCALAPPDATA\Programs\ZCode\resources"
   $env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "$z\config\provider\zcode-builtin.json"
   $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = "$env:USERPROFILE\.zcode\v2\provider_config.json"
   node "$z\glm\zcode.cjs" --prompt "Reply with exactly: ok" --output-format json
   ```

   Elsewhere, with `zcode` on `PATH`: `zcode --prompt "Reply with exactly: ok" --output-format json`.
   If it fails, show the error and fix the provider before going on.

## 5. Install the plugin with its settings

OpenCode:

```bash
claude plugin install opencode-team --marketplace NakharinA/Claude-Local-Teammate-Plugin --config model=company/<MODEL_ID>
```

ZCode:

```bash
claude plugin install opencode-team --marketplace NakharinA/Claude-Local-Teammate-Plugin --config backend=zcode --config model=qwen/<MODEL_ID>
```

If the plugin is already installed (`claude plugin list` shows `opencode-team@opencode-team`), ask
the person to set the options with `/plugin configure opencode-team@opencode-team` instead.

Optional settings: add one `--config key=value` per setting, but only if the person asks for it.

| Setting | Values | When |
| --- | --- | --- |
| `workerPermissions` | `lead` (default), `ask`, `read-only`, `full-auto` | `ask`: the person wants to approve shell commands themselves instead of Claude |
| `serverUrl` | e.g. `http://127.0.0.1:4096` | OpenCode runs on another port |
| `opencodeCommand` | full path to `opencode.cmd` | `opencode` isn't on `PATH` |
| `zcodeCommand` | full path to `zcode.cjs` | ZCode is installed somewhere unusual |

## 6. Set up the project

The plugin loads when Claude Code starts. Tell the person to restart Claude Code in their project
folder (quit, then `claude`) and run:

```
/opencode-team setup
/opencode-team
```

`setup` installs the OpenCode team tools and adds `.opencode-team/` to `.gitignore`. For ZCode it
only explains that nothing is needed. The status output should show the server or ZCode as found,
the model, and `permissions: lead`.

Offer to add delegation rules to the project's `CLAUDE.md`; the README has a ready block under
"Make Claude a good project manager".

## 7. Finish

Summarize for the person:
- the backend and model they're set up with, and where the provider config lives;
- that Claude approves the workers' shell commands (or that they do, in `ask` mode);
- how to try it: "Spawn an opencode worker named qwen-api to … and review its diff."
