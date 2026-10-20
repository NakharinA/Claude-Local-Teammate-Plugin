// opencode-team: runs one ZCode turn for a worker, detached from Claude Code.
//
//   node run-turn.mjs <job.json>
//
// The mod writes the job file and starts this script in the background. It prepares
// the worker's private ZCode home (provider config pinned to the worker model, the
// approval hook, the team MCP server), runs `zcode --prompt … --output-format
// stream-json`, and streams ZCode's output into job.out. A last line
// {"type":"__exit"} tells the mod the process ended, even when ZCode crashed.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
// job: { worker, cwd, teamDir, home, realHome, zcode, model, mode, gate, disallowed, prompt, resume, out, pidFile }
// gate: tool names (e.g. "Bash|WebFetch") whose calls wait for the lead's answer; empty for none.

function exitLine(code, stderr) {
  appendFileSync(job.out, JSON.stringify({ type: '__exit', code, stderr: String(stderr || '').slice(-4000) }) + '\n')
}

try {
  prepareHome()
  run()
} catch (err) {
  exitLine(1, 'opencode-team runner: ' + (err && err.stack ? err.stack : err))
}

function prepareHome() {
  const zdir = join(job.home, '.zcode')
  mkdirSync(join(zdir, 'cli'), { recursive: true })
  mkdirSync(join(zdir, 'v2'), { recursive: true })
  mkdirSync(join(job.home, 'answers'), { recursive: true })

  // Provider config: the person's own ZCode providers, with the default pinned to the worker model.
  const real = join(job.realHome, '.zcode', 'v2', 'provider_config.json')
  if (!existsSync(real)) {
    throw new Error('No ZCode provider config at ' + real + '. Add your Qwen provider in ZCode first (see the README).')
  }
  const providers = JSON.parse(readFileSync(real, 'utf8'))
  const i = job.model.indexOf('/')
  providers.config = providers.config || {}
  providers.config.defaultModelSelection = { providerId: job.model.slice(0, i), modelId: job.model.slice(i + 1) }
  writeFileSync(join(zdir, 'v2', 'provider_config.json'), JSON.stringify(providers, null, 2))

  // User-level config of the private home: no workspace trust needed, and the
  // person's own ZCode settings stay untouched.
  const node = process.execPath
  const config = {
    hooks: {
      enabled: !!job.gate,
      timeoutMs: 900000,
      events: job.gate
        ? { PreToolUse: [{ matcher: job.gate, hooks: [{ type: 'process', command: node, args: [join(here, 'approve.mjs')], timeoutMs: 900000 }] }] }
        : {},
    },
    mcp: {
      servers: {
        team: { type: 'stdio', command: node, args: [join(here, 'team-mcp.mjs')], enabled: true, timeoutMs: 30000 },
      },
    },
  }
  writeFileSync(join(zdir, 'cli', 'config.json'), JSON.stringify(config, null, 2))
}

/** How to start ZCode: the desktop app's zcode.cjs runs on the app's own runtime when it can. */
function command() {
  const z = job.zcode
  if (/\.(c|m)?js$/i.test(z)) {
    const appExe = resolve(dirname(z), '..', '..', 'ZCode.exe')
    if (process.platform === 'win32' && existsSync(appExe)) return { file: appExe, pre: [z], env: { ELECTRON_RUN_AS_NODE: '1' } }
    return { file: process.execPath, pre: [z], env: {} }
  }
  return { file: z, pre: [], env: {} }
}

function run() {
  const c = command()
  const env = {
    ...process.env,
    ...c.env,
    HOME: job.home,
    USERPROFILE: job.home,
    OPENCODE_TEAM_DIR: job.teamDir,
    OPENCODE_TEAM_WORKER: job.worker,
    OPENCODE_TEAM_HOME: job.home,
  }
  // Without the desktop app's launcher, ZCode wants both provider files named explicitly.
  const builtin = /\.(c|m)?js$/i.test(job.zcode) ? resolve(dirname(job.zcode), '..', 'config', 'provider', 'zcode-builtin.json') : ''
  if (builtin && existsSync(builtin)) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(job.home, '.zcode', 'v2', 'provider_config.json')
  }

  // Long prompts go through a file: Windows caps a command line at about 32K characters.
  let prompt = job.prompt
  if (prompt.length > 8000) {
    const file = job.out.replace(/\.jsonl$/, '') + '.prompt.md'
    writeFileSync(file, prompt)
    prompt = 'Your full instructions are in the file ' + file + '. Read that file first, then do what it says.'
  }
  const args = [...c.pre, '--prompt', prompt, '--cwd', job.cwd, '--mode', job.mode, '--output-format', 'stream-json']
  if (job.resume) args.push('--resume', job.resume)
  // Last, since the flag takes every following word.
  if (job.disallowed && job.disallowed.length) args.push('--disallowed-tools', ...job.disallowed)

  const out = createWriteStream(job.out, { flags: 'a' })
  let stderr = ''
  const child = spawn(c.file, args, { cwd: job.cwd, env, windowsHide: true, detached: process.platform !== 'win32' })
  writeFileSync(job.pidFile, JSON.stringify({ pid: child.pid, runner: process.pid }))
  child.stdout.pipe(out, { end: false })
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-8000)
  })
  child.on('error', (err) => {
    out.end(() => exitLine(1, 'could not start ZCode (' + c.file + '): ' + err.message))
  })
  child.on('close', (code) => {
    out.end(() => exitLine(code === null ? 1 : code, stderr))
  })
}
