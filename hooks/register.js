// opencode-team — OpenCode (or ZCode) workers as Claude Code teammates.
//
// Claude spawns a worker with the Agent tool (subagent_type "opencode-team:worker"),
// talks to it with SendMessage and stops it with TaskStop, exactly as with a Claude
// teammate. This mod answers those three tool calls itself: the work runs in a
// coding agent on your own model (OpenCode or ZCode, see hooks/lib/), and when the
// worker finishes a turn its reply is delivered back to whoever wrote to it — the
// lead (main loop) or a Claude teammate.
//
// In the default "lead" permission mode the worker never waits on a person: when it
// wants to run a shell command, the request goes to Claude, who answers it with
// SendMessage ("approve" / "reject: why"), like a project manager.
//
// Workers can also message the team on their own through the `team_send` tool
// (opencode/tools/team.ts for OpenCode, zcode/team-mcp.js for ZCode), which appends
// to .opencode-team/outbox.jsonl; the poll loop below routes those lines.

import {
  meta as ocMeta,
  up as ocUp,
  ensure as ocEnsure,
  create as ocCreate,
  prompt as ocPrompt,
  abort as ocAbort,
  poll as ocPoll,
  answer as ocAnswer,
  setup as ocSetup,
} from './lib/opencode.js'
import {
  meta as zcMeta,
  up as zcUp,
  ensure as zcEnsure,
  create as zcCreate,
  prompt as zcPrompt,
  abort as zcAbort,
  poll as zcPoll,
  answer as zcAnswer,
  setup as zcSetup,
} from './lib/zcode.js'
import { TEAM_DIR, errText } from './lib/util.js'

const AGENT_NAME = 'worker'
const AGENT_TYPE = 'opencode-team:worker'
const MAX_WORKER_HOPS = 6
const MODES = ['lead', 'ask', 'read-only', 'full-auto']

/** Settings from plugin.json userConfig, normalized. */
let cfg = normalizeConfig({})
/** The coding agent the workers run in: id, label and the non-$ helpers of its module. */
let backend = ocMeta

/** name -> worker record. */
const workers = new Map()
let ticking = false
let lastRosterJson = ''
let outboxDone = -1

export function register(on, options) {
  cfg = normalizeConfig(options || {})
  backend = cfg.backend === 'zcode' ? zcMeta : ocMeta

  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: AGENT_NAME,
      description:
        'A teammate that runs on ' +
        (cfg.model ? 'the model ' + cfg.model : 'your own model') +
        ' through ' + backend.label + ' instead of Claude (for example a local or company-hosted Qwen). ' +
        'Use it for well-scoped implementation work: one module or a few files, with clear acceptance criteria ' +
        'and the exact interfaces to use. Always give it a name (Agent name: "qwen-api") so you can ' +
        'SendMessage it later. It runs in the background and its reply arrives as a message when it finishes a turn. ' +
        'Review its changes (git diff, tests) before accepting them.' +
        (cfg.workerPermissions === 'lead'
          ? ' You approve its shell commands: each request arrives as a message, and you answer it with SendMessage ' +
            '("approve", "approve always", or "reject: <why / what to do instead>"). Approve routine build, test and ' +
            'lint commands inside the project; reject anything destructive, outside the project, or unrelated to its task.'
          : ''),
      prompt:
        'You are a placeholder for an ' + backend.label + ' worker. If you are running, the opencode-team mod failed ' +
        'to intercept the spawn: reply only with "opencode-team could not start the worker."',
      model: 'haiku',
      tools: ['Read'],
    })
    try {
      await $.command.register({
        name: 'opencode-team',
        description: 'Workers on your own model: status, setup (install the team tools), stop <name>',
        argumentHint: '[status | setup | stop <name>]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('opencode-team: could not add /opencode-team (' + errText(err) + ')', { to: 'debug' })
    }
    await restoreWorkers($)
    $.clock.every(cfg.pollMs, () => tick($))
    return next(e)
  })

  // Safety net: our agent type must never start as a Claude subagent.
  on('agent.spawn', { subagentType: AGENT_TYPE }, async () => ({
    deny: 'opencode-team workers start through the Agent tool call; this spawn was not intercepted.',
  })).catch(() => ({ deny: 'opencode-team workers cannot start as Claude subagents.' }))

  // Spawn: Agent({ subagent_type: "opencode-team:worker", name, description, prompt })
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!isWorkerType(e.subagent_type)) return next(e)
    try {
      const result = await spawnWorker($, e)
      return { result }
    } catch (err) {
      return { deny: 'Could not start the ' + backend.label + ' worker: ' + errText(err) }
    }
  }).catch(($, e, next) =>
    isWorkerType(e.subagent_type) ? { deny: 'opencode-team failed: ' + next.error.message } : next(e),
  )

  // Messages: SendMessage({ to: "<worker name>", message })
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const w = findWorker(e.to)
    if (!w) return next(e)
    if (w.status === 'stopped') {
      return { result: { success: false, message: w.name + ' was stopped. Spawn a new worker to continue.' } }
    }
    if (typeof e.message !== 'string' || !e.message.trim()) return next(e)
    try {
      if (w.pending && w.pending.length) return { result: await decide($, w, e.message) }
      const sender = await senderOf($, e.agentId)
      w.hops = 0
      await promptWorker($, w, e.message, sender)
      return {
        result: {
          success: true,
          message: 'Message delivered to ' + w.name + ' (' + backend.label + ' worker). Its reply will arrive as a message when it finishes.',
        },
      }
    } catch (err) {
      return { result: { success: false, message: 'Not delivered to ' + w.name + ': ' + errText(err) } }
    }
  }).catch(($, e, next) =>
    findWorker(e.to) ? { result: { success: false, message: 'opencode-team failed: ' + next.error.message } } : next(e),
  )

  // Stop: TaskStop({ task_id: "<worker name>" })
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const w = findWorker(e.task_id || e.shell_id)
    if (!w) return next(e)
    await stopWorker($, w)
    return {
      result: {
        message: 'Stopped ' + backend.label + ' worker ' + w.name + '.',
        task_id: w.name,
        task_type: 'opencode_worker',
        command: w.description,
      },
    }
  }).catch(($, e, next) => (findWorker(e.task_id || e.shell_id) ? { deny: 'opencode-team failed: ' + next.error.message } : next(e)))

  on('command.run', { command: 'opencode-team' }, async ($, e) => {
    const args = String(e.args || '').trim().split(/\s+/).filter(Boolean)
    const sub = (args[0] || 'status').toLowerCase()
    if (sub === 'setup') return { text: await installTeamTools($) }
    if (sub === 'stop') {
      const w = findWorker(args[1])
      if (!w) return { text: 'No worker named "' + (args[1] || '') + '".' }
      await stopWorker($, w)
      return { text: 'Stopped ' + w.name + '.' }
    }
    return { text: await statusText($) }
  })
}

// ---------------------------------------------------------------------------
// Configuration

function normalizeConfig(o) {
  const perm = String(o.workerPermissions || 'lead')
  return {
    backend: String(o.backend || 'opencode') === 'zcode' ? 'zcode' : 'opencode',
    serverUrl: String(o.serverUrl || 'http://127.0.0.1:4096').replace(/\/+$/, ''),
    model: String(o.model || '').trim(),
    agent: String(o.agent || 'build').trim() || 'build',
    workerPermissions: MODES.includes(perm) ? perm : 'lead',
    autoStart: o.autoStart !== false,
    opencodeCommand: String(o.opencodeCommand || 'opencode'),
    zcodeCommand: String(o.zcodeCommand || 'zcode'),
    serverPassword: String(o.serverPassword || ''),
    pollMs: Math.max(500, Math.round(Number(o.pollSeconds || 2) * 1000)),
  }
}

// ---------------------------------------------------------------------------
// Backend dispatch (plain if/else: the mod engine resolves every function that receives $)

function isZ() {
  return cfg.backend === 'zcode'
}
async function bUp($) {
  if (isZ()) return zcUp($, cfg)
  return ocUp($, cfg)
}
async function bEnsure($) {
  if (isZ()) await zcEnsure($, cfg)
  else await ocEnsure($, cfg)
}
async function bCreate($, w) {
  if (isZ()) await zcCreate($, cfg, w)
  else await ocCreate($, cfg, w)
}
async function bPrompt($, w, text, system, first) {
  if (isZ()) await zcPrompt($, cfg, w, text, system, first)
  else await ocPrompt($, cfg, w, text, system, first)
}
async function bAbort($, w) {
  if (isZ()) await zcAbort($, cfg, w)
  else await ocAbort($, cfg, w)
}
async function bPoll($, busy) {
  if (isZ()) return zcPoll($, cfg, busy)
  return ocPoll($, cfg, busy)
}
async function bAnswer($, w, req, decision) {
  if (isZ()) await zcAnswer($, cfg, w, req, decision)
  else await ocAnswer($, cfg, w, req, decision)
}
async function bSetup($) {
  if (isZ()) return zcSetup($, cfg)
  return ocSetup($, cfg)
}

// ---------------------------------------------------------------------------
// Workers

function isWorkerType(t) {
  return t === AGENT_TYPE || t === 'opencode-worker'
}

function findWorker(to) {
  if (typeof to !== 'string') return null
  const key = to.trim().split(/\s+/)[0].replace(/^@/, '')
  return workers.get(key) || null
}

function slug(s) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return out || 'worker'
}

function workerLabel() {
  return backend.label + ' worker' + (cfg.model ? ', ' + cfg.model : '')
}

async function spawnWorker($, e) {
  // Workers run only on the model you chose, never on whatever the agent defaults to.
  if (!cfg.model) {
    throw new Error(
      'no worker model is set. Set the plugin option "model" to your Qwen model (for OpenCode: provider/model, ' +
        'e.g. company/qwen3.8) with /plugin configure opencode-team@opencode-team.',
    )
  }
  const dir = await $.session.cwd()
  await bEnsure($)
  let name = slug(e.name || e.description)
  if (workers.has(name) && workers.get(name).status !== 'stopped') {
    let n = 2
    while (workers.has(name + '-' + n)) n++
    name = name + '-' + n
  }
  const sender = await senderOf($, e.agentId)
  const w = {
    name,
    sessionID: '',
    description: String(e.description || ''),
    status: 'busy',
    replyTo: sender,
    hops: 0,
    pending: [],
    busySince: await $.clock.now(),
    log: '',
  }
  await bCreate($, w)
  w.log = '# ' + name + ' (' + workerLabel() + ')\n\nSession: ' + (w.sessionID || 'known after its first turn') + '\n'
  workers.set(name, w)
  await writeRoster($)
  await promptWorker($, w, String(e.prompt || ''), sender, true)
  $.ui.toast('opencode-team: started ' + name)
  return {
    status: 'async_launched',
    isAsync: true,
    agentId: name,
    description: w.description,
    prompt: String(e.prompt || ''),
    outputFile: logPath(dir, name),
    canReadOutputFile: true,
  }
}

function systemFor(w) {
  return [
    'You are "' + w.name + '", a worker on a software team led by a Claude Code session ("lead").',
    'Your task comes from the lead or a teammate. Do the work in this repository, then end your turn with a short report:',
    'what you changed (files), how you checked it, and anything left open or uncertain.',
    'Your final answer is delivered to whoever gave you the task, so you do not need a tool to report completion.',
    'If you need a decision, are blocked, or have something another member needs (an API contract, a changed interface),',
    'use the team_send tool (team_members lists who is on the team). Stay inside the files your task names unless told otherwise.',
    cfg.workerPermissions === 'lead'
      ? 'Shell commands are approved by the lead. If one is rejected, read the reason in the tool result and follow it.'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function promptWorker($, w, text, sender, first) {
  w.status = 'busy'
  w.replyTo = sender
  w.busySince = await $.clock.now()
  w.log += '\n## → ' + w.name + ' (from ' + sender.label + ')\n\n' + text + '\n'
  await bPrompt($, w, first ? text : 'Message from ' + sender.label + ':\n\n' + text, systemFor(w), !!first)
  await saveLog($, w)
  await writeRoster($)
}

async function stopWorker($, w) {
  try {
    await bAbort($, w)
  } catch {
    // The backend may be gone; the worker is stopped either way.
  }
  w.status = 'stopped'
  w.pending = []
  w.log += '\n## stopped\n'
  await saveLog($, w)
  await writeRoster($)
}

/** Who is writing: the lead (main loop) or a Claude teammate/subagent loop. */
async function senderOf($, agentId) {
  if (!agentId) return { kind: 'main', label: 'lead' }
  const agents = await $.agent.list()
  const a = agents.find((x) => x.id === agentId)
  return { kind: 'agent', agentId, label: (a && (a.name || a.description)) || agentId }
}

function logPath(dir, name) {
  return dir + '/' + TEAM_DIR + '/logs/' + name + '.md'
}

async function saveLog($, w) {
  const dir = await $.session.cwd()
  await $.fs.write(logPath(dir, w.name), w.log)
}

// ---------------------------------------------------------------------------
// Permissions: a worker wants to run something its rules don't allow outright

async function onPermission($, w, req) {
  if (cfg.workerPermissions === 'lead') {
    // Announced by announceApprovals once the whole poll is in.
    w.pending.push(req)
    w.log += '\n_' + w.name + ' asks to use ' + req.tool + ': ' + req.what + '_\n'
    await saveLog($, w)
    return
  }
  let reply = 'reject'
  if (cfg.workerPermissions === 'full-auto') reply = 'once'
  if (cfg.workerPermissions === 'ask') {
    try {
      const choice = await $.ui.ask(w.name + ' (' + backend.label + ' worker) wants to use ' + req.tool + ': ' + req.what.slice(0, 200) + ' — allow it?', {
        header: 'Worker',
        options: ['Allow once', 'Allow always', 'Reject'],
      })
      reply = choice === 'Allow once' ? 'once' : choice === 'Allow always' ? 'always' : 'reject'
    } catch {
      reply = 'reject'
    }
  }
  await answerPermission($, w, req, { reply })
  if (reply === 'reject') (w.rejected = w.rejected || []).push(req.tool + ': ' + req.what)
}

/** One question at a time per worker; the next one rides on the answer to this one. */
async function announceApprovals($) {
  for (const w of workers.values()) {
    if (!w.pending || !w.pending.length || w.announced === w.pending[0].id) continue
    w.announced = w.pending[0].id
    await deliverToClaude($, w.replyTo, approvalText(w, w.pending[0]))
  }
}

function approvalText(w, req) {
  const more = w.pending.length > 1 ? ' (' + (w.pending.length - 1) + ' more waiting after this one)' : ''
  return [
    w.name + ' (' + workerLabel() + ') is waiting for your approval to use ' + req.tool + more + ':',
    '',
    '    ' + req.what.slice(0, 2000),
    '',
    'Answer with SendMessage(to: "' + w.name + '", message: …):',
    '- "approve": run it this once',
    req.canAlways ? '- "approve always": also allow the same kind of command for the rest of its session' : null,
    '- "reject: <why, or what to do instead>": it is not run; the worker reads your reason and carries on',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

/** Claude answered a pending request with SendMessage. */
async function decide($, w, message) {
  const req = w.pending[0]
  const text = message.trim()
  const yes = /^(?:approve[ds]?|allow(?:ed)?|yes|y|ok(?:ay)?|lgtm)\b[\s,.:;!-]*(?<always>always)?/i.exec(text)
  const no = /^(?:reject(?:ed)?|deny|denied|no|n)\b[\s,.:;!-]*(?<reason>[\s\S]*)$/i.exec(text)
  let decision
  if (yes) decision = { reply: yes.groups.always && req.canAlways ? 'always' : 'once' }
  // Anything that isn't a yes is a no, and the whole message goes to the worker as the reason.
  else decision = { reply: 'reject', message: (no ? no.groups.reason : text).trim() || 'The lead rejected this.' }
  await answerPermission($, w, req, decision)
  w.pending.shift()
  const verdict =
    decision.reply === 'reject' ? 'Rejected; ' + w.name + ' got your reason and continues.' : 'Approved' + (decision.reply === 'always' ? ' for the rest of its session' : '') + '; ' + w.name + ' continues.'
  if (w.pending.length) {
    w.announced = w.pending[0].id
    return { success: true, message: verdict + '\n\nNext request:\n' + approvalText(w, w.pending[0]) }
  }
  return { success: true, message: verdict + ' Its reply will arrive as a message when it finishes.' }
}

async function answerPermission($, w, req, decision) {
  try {
    await bAnswer($, w, req, decision)
    w.log += '\n_permission ' + req.tool + ' ' + req.what + ': ' + decision.reply + (decision.message ? ' (' + decision.message + ')' : '') + '_\n'
    await saveLog($, w)
  } catch (err) {
    $.ui.log('opencode-team: permission reply failed: ' + errText(err), { to: 'debug' })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Team roster (read by the team tools) and restore after reload

async function writeRoster($) {
  const dir = await $.session.cwd()
  const members = []
  for (const w of workers.values()) {
    if (w.status === 'stopped') continue
    members.push({ name: w.name, kind: backend.id, sessionID: w.sessionID, role: w.description, status: w.status })
  }
  try {
    for (const a of await $.agent.list()) {
      if (a.name && a.status === 'running') members.push({ name: a.name, kind: 'claude', role: a.description })
    }
  } catch {
    // Listing agents is best effort.
  }
  const roster = {
    lead: 'lead',
    ownerSession: await $.session.id(),
    backend: backend.id,
    model: cfg.model || null,
    members,
    saved: Array.from(workers.values()).map((w) => ({
      name: w.name,
      sessionID: w.sessionID,
      description: w.description,
      status: w.status,
      ...backend.saved(w),
    })),
  }
  const json = JSON.stringify(roster, null, 2)
  if (json === lastRosterJson) return
  lastRosterJson = json
  await $.fs.write(dir + '/' + TEAM_DIR + '/team.json', json + '\n')
}

async function restoreWorkers($) {
  const dir = await $.session.cwd()
  const p = dir + '/' + TEAM_DIR + '/team.json'
  if (workers.size || !(await $.fs.exists(p))) return
  try {
    const roster = JSON.parse(await $.fs.read(p))
    // Only a hot reload of this same session, on the same backend, resumes its workers.
    if (roster.ownerSession !== (await $.session.id()) || (roster.backend || 'opencode') !== backend.id) return
    for (const s of roster.saved || []) {
      if (s.status === 'stopped') continue
      let log = ''
      try {
        log = await $.fs.read(logPath(dir, s.name))
      } catch {
        log = '# ' + s.name + '\n'
      }
      const w = {
        name: s.name,
        sessionID: s.sessionID,
        description: s.description || '',
        status: s.status === 'busy' ? 'busy' : 'idle',
        replyTo: { kind: 'main', label: 'lead' },
        hops: 0,
        pending: [],
        busySince: await $.clock.now(),
        log,
      }
      backend.restore(w, s)
      workers.set(s.name, w)
    }
  } catch {
    // An unreadable roster just means no workers to restore.
  }
}

// ---------------------------------------------------------------------------
// Poll loop: outbox, permission requests, replies

async function tick($) {
  if (ticking) return
  ticking = true
  try {
    // Outbox first: a team_send made during a turn must reach Claude before
    // that turn's final reply, which may have finished in the same interval.
    await drainOutbox($)
    const busy = Array.from(workers.values()).filter((w) => w.status === 'busy')
    for (const ev of await bPoll($, busy)) {
      if (ev.w.status === 'stopped') continue
      if (ev.type === 'permission') await onPermission($, ev.w, ev.req)
      else if (ev.type === 'reply') {
        ev.w.status = 'idle'
        ev.w.pending = []
        await deliverReply($, ev.w, ev.result)
      }
    }
    await announceApprovals($)
    await writeRoster($)
    updateStatusLine($)
  } catch (err) {
    $.ui.log('opencode-team: ' + errText(err), { to: 'debug' })
  } finally {
    ticking = false
  }
}

let lastStatusLine = ''
function updateStatusLine($) {
  const active = Array.from(workers.values()).filter((w) => w.status !== 'stopped')
  const waiting = active.filter((w) => w.pending && w.pending.length).map((w) => w.name)
  const busy = active.filter((w) => w.status === 'busy' && !waiting.includes(w.name)).map((w) => w.name)
  const parts = []
  if (busy.length) parts.push('working: ' + busy.join(', '))
  if (waiting.length) parts.push('awaiting approval: ' + waiting.join(', '))
  const line = active.length ? 'workers: ' + active.length + ' · ' + (parts.join(' · ') || 'all idle') : ''
  if (line === lastStatusLine) return
  lastStatusLine = line
  $.ui.status(line || undefined)
}

async function deliverReply($, w, r) {
  const lines = []
  if (r.error) lines.push('⚠ The worker stopped with an error: ' + r.error)
  // "Qwen only": say so if the agent answered on a different model than configured.
  if (r.model && cfg.model && r.model !== cfg.model) lines.push('⚠ This turn ran on ' + r.model + ', not on the configured ' + cfg.model + '.')
  if (w.rejected && w.rejected.length) {
    lines.push(
      '⚠ Not approved, so not run (' + (cfg.workerPermissions === 'ask' ? 'rejected or nobody answered' : cfg.workerPermissions) +
        '): ' + w.rejected.join('; ') + '. Run it yourself, or set workerPermissions to lead or full-auto.',
    )
    w.rejected = []
  }
  if (r.files.length) lines.push('Files it changed: ' + r.files.join(', '))
  lines.push('', r.text || '(no text reply)')
  const report = lines.join('\n').trim()
  w.log += '\n## ← ' + w.name + ' (to ' + w.replyTo.label + ')\n\n' + report + '\n'
  await saveLog($, w)

  const to = w.replyTo
  if (to.kind === 'worker') {
    const target = workers.get(to.name)
    if (target && target.status !== 'stopped' && w.hops < MAX_WORKER_HOPS) {
      target.hops = w.hops + 1
      await promptWorker($, target, report, { kind: 'worker', name: w.name, label: w.name })
      return
    }
  }
  const text =
    'Reply from ' + w.name + ' (' + workerLabel() + '):\n\n' + report +
    '\n\nTo answer or give it more work: SendMessage(to: "' + w.name + '"). To stop it: TaskStop("' + w.name + '").'
  await deliverToClaude($, to, text)
  $.ui.toast('opencode-team: ' + w.name + ' replied')
}

async function deliverToClaude($, to, text) {
  if (to.kind === 'agent') {
    try {
      const sent = await $.session.send({ to: { agentId: to.agentId }, text })
      if (sent && sent.isDelivered) return
    } catch {
      // Fall through to the lead.
    }
  }
  $.prompt.submit({ text }).catch((err) => $.ui.log('opencode-team: could not wake the lead: ' + errText(err), { to: 'debug' }))
}

async function drainOutbox($) {
  const dir = await $.session.cwd()
  const p = dir + '/' + TEAM_DIR + '/outbox.jsonl'
  if (!(await $.fs.exists(p))) {
    if (outboxDone < 0) outboxDone = 0
    return
  }
  const lines = String(await $.fs.read(p)).split('\n').filter((l) => l.trim())
  if (outboxDone < 0) {
    // First look this session: skip what earlier sessions left behind.
    const key = 'outbox:' + (await $.session.id())
    const saved = await $.store.get(key)
    outboxDone = typeof saved === 'number' ? saved : lines.length
  }
  if (lines.length <= outboxDone) return
  const fresh = lines.slice(outboxDone)
  outboxDone = lines.length
  await $.store.set('outbox:' + (await $.session.id()), outboxDone)
  for (const line of fresh) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    // OpenCode's tool knows its session id; ZCode's MCP server knows the worker's name.
    const from = Array.from(workers.values()).find(
      (x) => (msg.fromSession && x.sessionID === msg.fromSession) || (msg.fromWorker && x.name === msg.fromWorker),
    )
    if (!from) continue // Not one of this session's workers.
    await routeOutbox($, from, String(msg.to || ''), String(msg.text || ''))
  }
}

async function routeOutbox($, from, to, text) {
  from.log += '\n## ' + from.name + ' → ' + to + ' (team_send)\n\n' + text + '\n'
  await saveLog($, from)
  if (to === 'lead') {
    await deliverToClaude(
      $,
      { kind: 'main', label: 'lead' },
      'Message from ' + from.name + ' (' + backend.label + ' worker), sent while it works:\n\n' + text +
        '\n\nReply with SendMessage(to: "' + from.name + '").',
    )
    return
  }
  const target = workers.get(to)
  if (target && target.status !== 'stopped') {
    if (from.hops >= MAX_WORKER_HOPS) {
      await deliverToClaude(
        $,
        { kind: 'main', label: 'lead' },
        from.name + ' and ' + to + ' have exchanged ' + MAX_WORKER_HOPS +
          ' messages without you. Their latest message was held for you:\n\n' + text,
      )
      return
    }
    target.hops = from.hops + 1
    await promptWorker($, target, text, { kind: 'worker', name: from.name, label: from.name })
    return
  }
  const agents = await $.agent.list()
  const mate = agents.find((a) => a.name === to)
  if (mate) {
    await deliverToClaude(
      $,
      { kind: 'agent', agentId: mate.id, label: to },
      'Message from ' + from.name + ' (' + backend.label + ' worker):\n\n' + text + '\n\nReply with SendMessage(to: "' + from.name + '").',
    )
    return
  }
  await deliverToClaude(
    $,
    { kind: 'main', label: 'lead' },
    from.name + ' tried to message "' + to + '", who is not on the team. Its message:\n\n' + text,
  )
}

// ---------------------------------------------------------------------------
// /opencode-team command

async function statusText($) {
  const up = await bUp($)
  const lines = [
    backend.label + ': ' + (backend.id === 'opencode' ? cfg.serverUrl + (up ? ' (running)' : ' (not running)') : up ? 'available' : 'not found (' + cfg.zcodeCommand + ')'),
    'Worker model: ' + (cfg.model || 'NOT SET — set the "model" option before spawning') + ' · permissions: ' + cfg.workerPermissions,
  ]
  const dir = await $.session.cwd()
  if (backend.toolsPath && !(await $.fs.exists(dir + '/' + backend.toolsPath))) {
    lines.push('Team tools: not installed in this project. Run /opencode-team setup so workers can message the team.')
  }
  if (!workers.size) lines.push('No workers yet. Ask Claude to spawn one with subagent_type "' + AGENT_TYPE + '".')
  for (const w of workers.values()) {
    const state = w.pending && w.pending.length ? 'awaiting approval' : w.status
    lines.push('- ' + w.name + ' [' + state + '] ' + w.description + ' (log: ' + TEAM_DIR + '/logs/' + w.name + '.md)')
  }
  return lines.join('\n')
}

async function installTeamTools($) {
  const dir = await $.session.cwd()
  const done = await bSetup($)
  const gi = dir + '/.gitignore'
  let note = ''
  if (await $.fs.exists(gi)) {
    const text = String(await $.fs.read(gi))
    if (!text.split('\n').some((l) => l.trim() === TEAM_DIR + '/' || l.trim() === TEAM_DIR)) {
      await $.fs.write(gi, text.replace(/\n?$/, '\n') + TEAM_DIR + '/\n')
      note = ' Added ' + TEAM_DIR + '/ to .gitignore.'
    }
  }
  return done + note
}
