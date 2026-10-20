// ZCode backend: each worker turn is one headless `zcode --prompt` run.
//
// ZCode has no server the mod can call, so a turn runs detached through
// zcode/run-turn.mjs, which streams ZCode's stream-json output to a file in the
// worker's private home (<your home>/.opencode-team/zcode/<project>/<worker>).
// The poll loop reads that file; a session id from the first turn lets later
// turns `--resume` the same conversation. Gated tool calls (shell, web) wait in
// zcode/approve.mjs until the mod writes the lead's answer.

import { TEAM_DIR, isWindowsPath, startDetached } from './util.js'

const GATE = 'Bash|WebFetch|WebSearch'
// Agent would start subagents on other models; AskUserQuestion would wait for a person nobody sees.
const DISALLOWED = ['Agent', 'AskUserQuestion']
const EDIT_TOOLS = ['Write', 'Edit']

export const meta = {
  id: 'zcode',
  label: 'ZCode',
  toolsPath: '',
  saved: (w) => ({ home: w.home, turn: w.turn, reqSeen: w.reqSeen }),
  restore(w, s) {
    w.home = s.home
    w.turn = Number(s.turn || 0)
    w.reqSeen = Number(s.reqSeen || 0)
  },
}

/** The resolved ZCode CLI, found once. */
let command = ''

async function realHome($) {
  return String((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')
}

/** The ZCode CLI: the configured command, else the copy inside the Windows desktop app. */
async function resolveCommand($, cfg) {
  if (command) return command
  if (cfg.zcodeCommand !== 'zcode') return (command = cfg.zcodeCommand)
  const roots = [(await $.env.get('LOCALAPPDATA')) + '/Programs/ZCode', (await $.env.get('ProgramFiles')) + '/ZCode']
  for (const r of roots) {
    const cjs = r + '/resources/glm/zcode.cjs'
    if (r.length > 7 && (await $.fs.exists(cjs))) return (command = cjs)
  }
  return (command = 'zcode')
}

async function available($, cfg) {
  const c = await resolveCommand($, cfg)
  if (/[\\/]/.test(c)) return $.fs.exists(c)
  try {
    const r = await $.process.run([c, '--version'], { timeoutMs: 20000 })
    return r.exitCode === 0
  } catch {
    return false
  }
}

function projectKey(dir) {
  let h = 5381
  for (const ch of dir) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  const base = dir.split(/[\\/]/).filter(Boolean).pop() || 'project'
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 30) + '-' + h.toString(36)
}

async function readLines($, path) {
  if (!(await $.fs.exists(path))) return []
  return String(await $.fs.read(path))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function describe(tool, input) {
  input = input || {}
  if (tool === 'Bash') return String(input.command || '')
  if (tool === 'WebFetch') return String(input.url || '')
  if (tool === 'WebSearch') return String(input.query || '')
  return JSON.stringify(input).slice(0, 500)
}

function summarize(lines) {
  const deltas = []
  const files = new Set()
  let text = ''
  let error = ''
  let model = ''
  let sessionId = ''
  let exit = null
  for (const l of lines) {
    if (l.sessionId) sessionId = l.sessionId
    const p = l.payload || {}
    if (l.type === 'model.streaming' && p.kind === 'text_delta') deltas.push(p.delta || '')
    if (l.type === 'session.updated' && p.providerId && p.modelId) model = p.providerId + '/' + p.modelId
    if (l.type === 'tool.updated' && p.kind === 'scheduled') {
      const input = p.input || {}
      if (EDIT_TOOLS.includes(p.toolName) && input.file_path) files.add(String(input.file_path))
      if (p.toolName === 'ApplyPatch' && input.patch_text) {
        for (const m of String(input.patch_text).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.add(m[1].trim())
      }
    }
    if (l.type === 'turn.completed') {
      if (p.response) text = p.response
      if (p.resultType && p.resultType !== 'success') error = 'ZCode ended the turn: ' + p.resultType
    }
    if (l.type === 'turn.failed') error = typeof p.error === 'string' ? p.error : (p.error && p.error.message) || JSON.stringify(p.error)
    if (l.type === 'result' && l.response) text = l.response
    if (l.type === '__exit') exit = l
  }
  if (!text && !error && exit && exit.code !== 0) {
    error = 'ZCode exited with code ' + exit.code + (exit.stderr ? ': ' + exit.stderr.trim().split('\n').slice(-5).join(' ').slice(0, 600) : '')
  }
  return { text: text || deltas.join('').trim(), files: Array.from(files), error, model, sessionId }
}

export async function up($, cfg) {
  return available($, cfg)
}

export async function ensure($, cfg) {
  if (!(await available($, cfg))) {
    throw new Error(
      'ZCode was not found. Install the ZCode desktop app, or set the plugin option "zcodeCommand" to its CLI, e.g. ' +
        'C:\\Users\\you\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
    )
  }
  if (cfg.model.indexOf('/') <= 0) throw new Error('for ZCode, set "model" as providerId/modelId from your ZCode provider config, e.g. qwen/qwen3-coder-plus.')
  const home = await realHome($)
  if (!home || !(await $.fs.exists(home + '/.zcode/v2/provider_config.json'))) {
    throw new Error('no ZCode provider config at ~/.zcode/v2/provider_config.json. Add your Qwen provider in ZCode first (see the README).')
  }
}

export async function create($, cfg, w) {
  const dir = await $.session.cwd()
  w.home = (await realHome($)) + '/' + TEAM_DIR + '/zcode/' + projectKey(dir) + '/' + w.name
  w.turn = 0
  w.reqSeen = 0
  w.sessionID = ''
  // A home reused from an earlier worker of the same name starts with no old requests.
  await $.fs.write(w.home + '/requests.jsonl', '')
}

export async function prompt($, cfg, w, text, system, first) {
  const dir = await $.session.cwd()
  w.turn = (w.turn || 0) + 1
  const base = w.home + '/turn-' + w.turn
  const gated = cfg.workerPermissions === 'lead' || cfg.workerPermissions === 'ask'
  const job = {
    worker: w.name,
    cwd: dir,
    teamDir: dir + '/' + TEAM_DIR,
    home: w.home,
    realHome: await realHome($),
    zcode: await resolveCommand($, cfg),
    model: cfg.model,
    mode: cfg.workerPermissions === 'read-only' ? 'plan' : 'yolo',
    gate: gated ? GATE : '',
    disallowed: DISALLOWED,
    // ZCode has no system-prompt flag: the first turn carries the worker's instructions.
    prompt: first ? system + '\n\n---\n\n' + text : text,
    resume: w.sessionID || '',
    out: base + '.jsonl',
    pidFile: w.home + '/pid.json',
  }
  await $.fs.write(job.out, '')
  await $.fs.write(base + '.job.json', JSON.stringify(job, null, 2))
  const runner = $.plugin.root + '/zcode/run-turn.mjs'
  await startDetached($, dir, 'node', [runner, base + '.job.json'], base + '.runner.log')
}

export async function abort($, cfg, w) {
  const pid = JSON.parse(await $.fs.read(w.home + '/pid.json')).pid
  const dir = await $.session.cwd()
  const argv = isWindowsPath(dir) ? ['taskkill', '/PID', String(pid), '/T', '/F'] : ['sh', '-c', 'kill -TERM -' + pid + ' 2>/dev/null || kill -TERM ' + pid]
  await $.process.run(argv, { timeoutMs: 15000 })
}

export async function poll($, cfg, busy) {
  const events = []
  for (const w of busy) {
    const reqs = await readLines($, w.home + '/requests.jsonl')
    for (const r of reqs.slice(w.reqSeen || 0)) {
      events.push({ type: 'permission', w, req: { id: r.id, tool: r.tool, what: describe(r.tool, r.input), canAlways: false } })
    }
    w.reqSeen = reqs.length
    const lines = await readLines($, w.home + '/turn-' + w.turn + '.jsonl')
    // Done once the runner has seen ZCode exit, so the next turn can resume the session.
    if (!lines.some((l) => l.type === '__exit')) continue
    const result = summarize(lines)
    if (result.sessionId) w.sessionID = result.sessionId
    events.push({ type: 'reply', w, result })
  }
  return events
}

export async function answer($, cfg, w, req, decision) {
  const behavior = decision.reply === 'reject' ? 'deny' : 'allow'
  await $.fs.write(w.home + '/answers/' + req.id + '.json', JSON.stringify({ behavior, message: decision.message || '' }))
}

export async function setup() {
  return 'ZCode workers get team_send and team_members automatically (an MCP server in each worker\'s own ZCode home); nothing to install in the project.'
}
