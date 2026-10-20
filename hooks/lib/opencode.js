// OpenCode backend: workers are sessions on an `opencode serve` HTTP server.
//
// Every function takes ($, cfg, …); register.js picks this backend or ZCode's.

import { TEAM_DIR, isWindowsPath, pause, startDetached } from './util.js'

const EDIT_TOOLS = ['edit', 'write', 'patch', 'multiedit']

/** Pending OpenCode permission ids already passed on. */
const asked = new Set()

export const meta = {
  id: 'opencode',
  label: 'OpenCode',
  toolsPath: '.opencode/tools/team.ts',
  saved: (w) => ({ seen: w.seen }),
  restore(w, s) {
    w.seen = Number(s.seen || 0)
  },
}

function authHeaders(cfg) {
  const h = { 'content-type': 'application/json' }
  if (cfg.serverPassword) h.authorization = 'Basic ' + btoa('opencode:' + cfg.serverPassword)
  return h
}

async function oc($, cfg, method, path, body) {
  const dir = await $.session.cwd()
  const url = cfg.serverUrl + path + (path.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(dir)
  const init = { method, headers: authHeaders(cfg) }
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

export async function up($, cfg) {
  try {
    const r = await $.http.fetch(cfg.serverUrl + '/session/status', { method: 'GET', headers: authHeaders(cfg) })
    return r.ok
  } catch {
    return false
  }
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

function modelRef(cfg) {
  const i = cfg.model.indexOf('/')
  if (i <= 0) return null
  return { providerID: cfg.model.slice(0, i), modelID: cfg.model.slice(i + 1) }
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

export async function ensure($, cfg) {
  if (await up($, cfg)) return
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
    if (await up($, cfg)) {
      $.ui.toast('opencode-team: started OpenCode on port ' + port)
      return
    }
  }
  throw new Error('OpenCode did not answer at ' + cfg.serverUrl + ' within 30 seconds. See ' + TEAM_DIR + '/opencode-server.log')
}

export async function create($, cfg, w) {
  const session = await oc($, cfg, 'POST', '/session', {
    title: w.name + ': ' + (w.description || 'task'),
    permission: permissionRules(cfg.workerPermissions),
  })
  if (!session || !session.id) throw new Error('OpenCode returned no session id')
  w.sessionID = session.id
  w.seen = 0
}

export async function prompt($, cfg, w, text, system, first) {
  const body = { parts: [{ type: 'text', text }], system, agent: cfg.agent }
  const model = modelRef(cfg)
  if (model) body.model = model
  if (!first) {
    const msgs = await oc($, cfg, 'GET', '/session/' + w.sessionID + '/message')
    w.seen = Array.isArray(msgs) ? msgs.length : w.seen
  }
  await oc($, cfg, 'POST', '/session/' + w.sessionID + '/prompt_async', body)
}

export async function abort($, cfg, w) {
  await oc($, cfg, 'POST', '/session/' + w.sessionID + '/abort')
}

/** Returns [{ type: 'permission', w, req }] and [{ type: 'reply', w, result }] for busy workers. */
export async function poll($, cfg, busy) {
  const events = []
  if (!busy.length || !(await up($, cfg))) return events
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

/** decision: { reply: 'once' | 'always' | 'reject', message? } */
export async function answer($, cfg, w, req, decision) {
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

export async function setup($, cfg) {
  const dir = await $.session.cwd()
  await $.fs.write(dir + '/.opencode/tools/team.ts', await $.fs.read($.plugin.root + '/opencode/tools/team.ts'))
  return (
    'Installed the team tools at .opencode/tools/team.ts.' +
    ((await up($, cfg)) ? ' Restart `opencode serve` so it loads them (OpenCode reads tools at startup).' : '')
  )
}

function portOf(u) {
  const m = /:(\d+)(?:\/|$)/.exec(u.replace(/^[a-z]+:\/\//, ''))
  return m ? m[1] : '4096'
}
function hostOf(u) {
  return u.replace(/^[a-z]+:\/\//, '').split(/[:/]/)[0] || '127.0.0.1'
}
