// OpenCode backend: workers are sessions on an `opencode serve` HTTP server.
//
// Every function takes ($, cfg, …); register.js picks this backend or ZCode's.
//
// Two server APIs are supported. OpenCode 1.x serves `/session/…` on serverUrl.
// OpenCode 2.x moved everything under `/api/…`, with new request and message shapes,
// and runs as a background service whose URL and password it writes to
// ~/.local/state/opencode/service.json. `resolve` finds out which one answers.

import { TEAM_DIR, isWindowsPath, pause, startDetached } from './util.js'

const EDIT_TOOLS = ['edit', 'write', 'patch', 'multiedit', 'apply_patch']

/** Pending OpenCode permission ids already passed on. */
const asked = new Set()

/** The server in use: { v: 1 | 2, url, password }, or null until resolve finds one. */
let server = null

export const meta = {
  id: 'opencode',
  label: 'OpenCode',
  toolsPath: '.opencode/team-mcp.mjs',
  saved: (w) => ({ seen: w.seen }),
  restore(w, s) {
    w.seen = Number(s.seen || 0)
  },
}

function authHeaders(password) {
  const h = { 'content-type': 'application/json' }
  if (password) h.authorization = 'Basic ' + btoa('opencode:' + password)
  return h
}

async function oc($, cfg, method, path, body) {
  const srv = server || { v: 1, url: cfg.serverUrl, password: cfg.serverPassword }
  let url = srv.url + path
  // v2 sessions carry their directory (set at create); v1 scopes every call by query.
  if (srv.v === 1) url += (path.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(await $.session.cwd())
  const init = { method, headers: authHeaders(srv.password) }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await $.http.fetch(url, init)
  if (!r.ok) {
    const err = new Error('OpenCode ' + method + ' ' + path.split('?')[0] + ' answered HTTP ' + r.status + ': ' + String(r.text || '').slice(0, 300))
    err.status = r.status
    throw err
  }
  if (!r.text) return null
  try {
    return JSON.parse(r.text)
  } catch {
    return r.text
  }
}

/** 1 or 2 when an OpenCode server of that API answers at url with password, 'auth' on a v2 401, else 0. */
async function probe($, url, password) {
  try {
    const r = await $.http.fetch(url + '/api/session/active', { method: 'GET', headers: authHeaders(password) })
    if (r.status === 401) return 'auth'
    const body = r.ok ? JSON.parse(r.text || 'null') : null
    if (body && body.data && typeof body.data === 'object') return 2
  } catch {
    // Not JSON (a v1 server's web UI), or nothing listening.
  }
  try {
    // A v2 server answers this path too, with its web UI, so only a JSON object counts.
    const r = await $.http.fetch(url + '/session/status', { method: 'GET', headers: authHeaders(password) })
    const body = r.ok ? JSON.parse(r.text || 'null') : null
    if (body && typeof body === 'object' && !Array.isArray(body)) return 1
  } catch {
    // Not JSON, or nothing listening.
  }
  return 0
}

/** The OpenCode 2 background service, from the file it writes while it runs. */
async function v2Service($) {
  const state = (await $.env.get('XDG_STATE_HOME')) || ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '') + '/.local/state'
  try {
    const s = JSON.parse(String(await $.fs.read(state + '/opencode/service.json')))
    if (s && s.url) return { url: String(s.url).replace(/\/+$/, ''), password: String(s.password || '') }
  } catch {
    // No service file: the service isn't installed or isn't running.
  }
  return null
}

/** Finds the server: serverUrl first (v1 or v2), then the v2 service. Sets `server`; null if none answers. */
async function resolve($, cfg) {
  const own = await probe($, cfg.serverUrl, cfg.serverPassword)
  if (own === 1 || own === 2) return (server = { v: own, url: cfg.serverUrl, password: cfg.serverPassword })
  const svc = await v2Service($)
  if (svc && (await probe($, svc.url, svc.password)) === 2) return (server = { v: 2, ...svc })
  server = null
  if (own === 'auth') {
    throw new Error(
      'OpenCode at ' + cfg.serverUrl + ' refused the password (HTTP 401). Set the serverPassword option, ' +
        'or, with OpenCode 2, start its background service so the mod can use that instead.',
    )
  }
  return null
}

export async function up($, cfg) {
  try {
    return !!(await resolve($, cfg))
  } catch {
    return false
  }
}

/** Where the workers' server is, for /opencode-team status. */
export function where(cfg) {
  return server ? server.url + (server.v === 2 ? ' (OpenCode 2)' : '') : cfg.serverUrl
}

// Set once, on the session. Never pass `tools` with a prompt: OpenCode turns
// that map into permission rules that replace these (bash "ask" then becomes
// OpenCode's default "allow").
function permissionRules(mode) {
  const rule = (permission, action) => ({ permission, pattern: '*', action })
  // `question` would wait for a person in OpenCode's own UI, which nobody sees.
  // `task` starts subagents, which may run on other models than the worker's.
  const always = [rule('question', 'deny'), rule('external_directory', 'deny'), rule('task', 'deny')]
  if (mode === 'full-auto') return [rule('edit', 'allow'), rule('bash', 'allow'), rule('webfetch', 'allow'), ...always]
  if (mode === 'read-only') return [rule('edit', 'deny'), rule('bash', 'deny'), rule('webfetch', 'deny'), ...always]
  if (mode === 'lead') return [rule('edit', 'allow'), rule('bash', 'ask'), rule('webfetch', 'ask'), ...always]
  return [rule('edit', 'allow'), rule('bash', 'ask'), rule('webfetch', 'deny'), ...always]
}

// OpenCode 2 renamed the rule fields and some actions (bash → shell, task → subagent).
const V2_ACTIONS = { edit: ['edit', 'write'], bash: ['shell'], webfetch: ['webfetch', 'websearch'], task: ['subagent'] }

function permissionRulesV2(mode) {
  return permissionRules(mode).flatMap((r) =>
    (V2_ACTIONS[r.permission] || [r.permission]).map((action) => ({ action, resource: r.pattern, effect: r.action })),
  )
}

/** provider/model as OpenCode's model ref; null without a provider. */
function modelRef(ref) {
  const i = ref.indexOf('/')
  if (i <= 0) return null
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) }
}

function summarize(replies) {
  const texts = []
  const files = new Set()
  let error = ''
  let model = ''
  for (const m of replies) {
    for (const p of m.parts || []) {
      if (p.type === 'text' && p.text && !p.synthetic) texts.push(p.text.trim())
      if (p.type === 'tool' && EDIT_TOOLS.includes(p.tool)) {
        const input = (p.state && p.state.input) || {}
        const f = input.filePath || input.file_path || input.path
        if (f) files.add(String(f))
      }
    }
    if (m.info.providerID && m.info.modelID) model = m.info.providerID + '/' + m.info.modelID
    if (m.info.error) {
      const er = m.info.error
      error = (er.data && (er.data.message || er.data.error)) || er.name || JSON.stringify(er)
    }
  }
  return { text: texts.filter(Boolean).join('\n\n'), files: Array.from(files), error, model }
}

/** Like summarize, for OpenCode 2 messages; idle is the message that ended the turn. */
function summarizeV2(replies, idle) {
  const texts = []
  const files = new Set()
  let error = ''
  let model = ''
  for (const m of replies) {
    for (const p of m.content || []) {
      if (p.type === 'text' && p.text) texts.push(p.text.trim())
      if (p.type === 'tool' && EDIT_TOOLS.includes(p.name)) {
        const input = (p.state && p.state.input) || {}
        const f = input.filePath || input.file_path || input.path
        if (f) files.add(String(f))
      }
    }
    if (m.model && m.model.providerID && m.model.id) model = m.model.providerID + '/' + m.model.id
    if (m.error) error = m.error.message || m.error.type || JSON.stringify(m.error)
  }
  if (!error && idle.outcome === 'failed') error = (idle.error && idle.error.message) || 'the turn failed'
  return { text: texts.filter(Boolean).join('\n\n'), files: Array.from(files), error, model }
}

export async function ensure($, cfg) {
  if (await resolve($, cfg)) return
  if (!cfg.autoStart) {
    throw new Error(
      'nothing answers at ' + cfg.serverUrl + '. Start it in your project folder with `' + cfg.opencodeCommand +
        ' serve --port ' + portOf(cfg.serverUrl) + '`, or turn on auto-start.',
    )
  }
  const dir = await $.session.cwd()
  const port = portOf(cfg.serverUrl)
  const logFile = dir + '/' + TEAM_DIR + '/opencode-server.log'
  await $.fs.write(logFile, '')
  await startDetached($, dir, cfg.opencodeCommand, ['serve', '--port', port, '--hostname', hostOf(cfg.serverUrl)], logFile)
  for (let i = 0; i < 60; i++) {
    await pause($, 500, isWindowsPath(dir))
    if (await resolve($, cfg)) {
      $.ui.toast('opencode-team: started OpenCode on port ' + port)
      return
    }
  }
  throw new Error('OpenCode did not answer at ' + cfg.serverUrl + ' within 30 seconds. See ' + TEAM_DIR + '/opencode-server.log')
}

export async function create($, cfg, w) {
  if (server && server.v === 2) {
    const body = { agent: cfg.agent, location: { directory: await $.session.cwd() }, permissions: permissionRulesV2(cfg.workerPermissions) }
    const model = modelRef(w.model || cfg.model)
    // v2 pins the model on the session, not on each prompt.
    if (model) body.model = { providerID: model.providerID, id: model.modelID }
    const res = await oc($, cfg, 'POST', '/api/session', body)
    if (!res || !res.data || !res.data.id) throw new Error('OpenCode returned no session id')
    w.sessionID = res.data.id
    w.seen = 0
    return
  }
  const session = await oc($, cfg, 'POST', '/session', {
    title: w.name + ': ' + (w.description || 'task'),
    permission: permissionRules(cfg.workerPermissions),
  })
  if (!session || !session.id) throw new Error('OpenCode returned no session id')
  w.sessionID = session.id
  w.seen = 0
}

export async function prompt($, cfg, w, text, system, first) {
  if (server && server.v === 2) {
    // v2 prompts take no system text, so the team instructions open the first message.
    await oc($, cfg, 'POST', '/api/session/' + w.sessionID + '/prompt', { text: first && system ? system + '\n\n---\n\n' + text : text })
    return
  }
  const body = { parts: [{ type: 'text', text }], system, agent: cfg.agent }
  const model = modelRef(w.model || cfg.model)
  if (model) body.model = model
  if (!first) {
    const msgs = await oc($, cfg, 'GET', '/session/' + w.sessionID + '/message')
    w.seen = Array.isArray(msgs) ? msgs.length : w.seen
  }
  await oc($, cfg, 'POST', '/session/' + w.sessionID + '/prompt_async', body)
}

export async function abort($, cfg, w) {
  if (server && server.v === 2) {
    await oc($, cfg, 'POST', '/api/session/' + w.sessionID + '/interrupt')
    return
  }
  await oc($, cfg, 'POST', '/session/' + w.sessionID + '/abort')
}

/** Returns [{ type: 'permission', w, req }] and [{ type: 'reply', w, result }] for busy workers. */
export async function poll($, cfg, busy) {
  const events = []
  if (!busy.length || !(await up($, cfg))) return events
  if (server.v === 2) return pollV2($, cfg, busy, events)
  const pending = await oc($, cfg, 'GET', '/permission')
  if (Array.isArray(pending)) {
    // Forget requests OpenCode no longer lists, so the set doesn't grow all session.
    const live = new Set(pending.map((p) => p.id))
    for (const id of asked) if (!live.has(id)) asked.delete(id)
    for (const p of pending) {
      const w = busy.find((x) => x.sessionID === p.sessionID)
      if (!w || asked.has(p.id)) continue
      asked.add(p.id)
      const what = (p.patterns || []).join(' ') || (p.metadata && (p.metadata.command || p.metadata.title)) || ''
      events.push({ type: 'permission', w, req: { id: p.id, tool: p.permission, what, canAlways: true } })
    }
  }
  const status = (await oc($, cfg, 'GET', '/session/status')) || {}
  for (const w of busy) {
    const s = status[w.sessionID]
    if (s && s.type !== 'idle') continue
    const msgs = await oc($, cfg, 'GET', '/session/' + w.sessionID + '/message')
    if (!Array.isArray(msgs)) continue
    const fresh = msgs.slice(w.seen)
    let lastUser = -1
    fresh.forEach((m, i) => {
      if (m.info && m.info.role === 'user') lastUser = i
    })
    const replies = fresh.slice(lastUser + 1).filter((m) => m.info && m.info.role === 'assistant')
    if (!replies.length) continue
    const last = replies[replies.length - 1]
    if (!(last.info.error || (last.info.time && last.info.time.completed))) continue
    w.seen = msgs.length
    events.push({ type: 'reply', w, result: summarize(replies) })
  }
  return events
}

async function pollV2($, cfg, busy, events) {
  const live = new Set()
  for (const w of busy) {
    const pending = await oc($, cfg, 'GET', '/api/session/' + w.sessionID + '/permission')
    for (const p of (pending && pending.data) || []) {
      live.add(p.id)
      if (asked.has(p.id)) continue
      asked.add(p.id)
      const what = (p.resources || []).join(' ') || (p.metadata && (p.metadata.command || p.metadata.title)) || ''
      events.push({ type: 'permission', w, req: { id: p.id, tool: p.action, what, canAlways: true } })
    }
  }
  for (const id of asked) if (!live.has(id)) asked.delete(id)
  const active = ((await oc($, cfg, 'GET', '/api/session/active')) || {}).data || {}
  for (const w of busy) {
    if (active[w.sessionID]) continue
    const turn = await lastTurn($, cfg, w.sessionID)
    // The turn is over once OpenCode has written its idle marker after the replies.
    if (!turn.idle || !turn.replies.length) continue
    events.push({ type: 'reply', w, result: summarizeV2(turn.replies, turn.idle) })
  }
  return events
}

/** The newest turn: assistant replies since the last user message, oldest first, and its idle marker if it ended. */
async function lastTurn($, cfg, sessionID) {
  const replies = []
  let idle = null
  let path = '/api/session/' + sessionID + '/message?order=desc&limit=50'
  for (let page = 0; page < 20 && path; page++) {
    const res = (await oc($, cfg, 'GET', path)) || {}
    for (const m of res.data || []) {
      if (m.type === 'user') return { replies: replies.reverse(), idle }
      if (m.type === 'idle' && !replies.length && !idle) idle = m
      if (m.type === 'assistant') replies.push(m)
    }
    const next = res.cursor && res.cursor.next
    path = next && (res.data || []).length ? '/api/session/' + sessionID + '/message?limit=50&cursor=' + encodeURIComponent(next) : ''
  }
  return { replies: replies.reverse(), idle }
}

/** decision: { reply: 'once' | 'always' | 'reject', message? } */
export async function answer($, cfg, w, req, decision) {
  if (server && server.v === 2) {
    const v2 = { decision: decision.reply }
    if (decision.message) v2.message = decision.message
    await oc($, cfg, 'POST', '/api/session/' + w.sessionID + '/permission/' + req.id + '/reply', v2)
    return
  }
  const body = { reply: decision.reply }
  if (decision.message) body.message = decision.message
  try {
    // With a message, a rejection reaches the worker as feedback and its turn goes on.
    await oc($, cfg, 'POST', '/permission/' + req.id + '/reply', body)
  } catch (err) {
    if (err.status !== 404) throw err
    await oc($, cfg, 'POST', '/session/' + w.sessionID + '/permissions/' + req.id, { response: decision.reply })
  }
}

// OpenCode 1 loads custom tools from .opencode/tools/*.ts; OpenCode 2 doesn't, so
// there the same tools come from the stdio MCP server, set up in .opencode/opencode.json.
export async function setup($, cfg) {
  const dir = await $.session.cwd()
  await $.fs.write(dir + '/.opencode/tools/team.ts', await $.fs.read($.plugin.root + '/opencode/tools/team.ts'))
  await $.fs.write(dir + '/.opencode/team-mcp.mjs', await $.fs.read($.plugin.root + '/zcode/team-mcp.mjs'))
  const running = await up($, cfg)
  if (!running || server.v === 1) {
    return (
      'Installed the team tools at .opencode/tools/team.ts.' +
      (running ? ' Restart `opencode serve` so it loads them (OpenCode reads tools at startup).' : '')
    )
  }
  if (await $.fs.exists(dir + '/.opencode/opencode.jsonc')) {
    return (
      'Copied the team MCP server to .opencode/team-mcp.mjs, but .opencode/opencode.jsonc exists, so add this to it yourself: ' +
      JSON.stringify({ mcp: { servers: { 'opencode-team': teamServer(dir) } } })
    )
  }
  const file = dir + '/.opencode/opencode.json'
  let conf = {}
  if (await $.fs.exists(file)) {
    try {
      conf = JSON.parse(String(await $.fs.read(file)))
    } catch {
      throw new Error('.opencode/opencode.json is not valid JSON; fix it, then run setup again.')
    }
  }
  conf.mcp = conf.mcp || {}
  conf.mcp.servers = { ...(conf.mcp.servers || {}), 'opencode-team': teamServer(dir) }
  await $.fs.write(file, JSON.stringify(conf, null, 2) + '\n')
  // OpenCode 2 rereads a project's config on reload, no restart needed.
  await oc($, cfg, 'POST', '/api/location/reload?location%5Bdirectory%5D=' + encodeURIComponent(dir))
  return 'Installed the team tools for OpenCode 2: the opencode-team MCP server in .opencode/opencode.json (server .opencode/team-mcp.mjs).'
}

function teamServer(dir) {
  return {
    type: 'local',
    command: ['node', dir + '/.opencode/team-mcp.mjs'],
    environment: { OPENCODE_TEAM_DIR: dir + '/' + TEAM_DIR },
    codemode: false,
  }
}

function portOf(u) {
  const m = /:(\d+)(?:\/|$)/.exec(u.replace(/^[a-z]+:\/\//, ''))
  return m ? m[1] : '4096'
}
function hostOf(u) {
  return u.replace(/^[a-z]+:\/\//, '').split(/[:/]/)[0] || '127.0.0.1'
}
