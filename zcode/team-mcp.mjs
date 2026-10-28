// opencode-team: a stdio MCP server that gives a worker `team_send` and `team_members`.
//
// The same contract as opencode/tools/team.ts: the mod keeps the roster in
// <teamDir>/team.json and routes lines appended to <teamDir>/outbox.jsonl.
// OPENCODE_TEAM_DIR points at the team folder. For ZCode the runner starts one
// process per worker and sets OPENCODE_TEAM_WORKER. OpenCode 2 starts one process
// for the whole project, so there the worker names itself in the `from` argument.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.OPENCODE_TEAM_DIR || join(process.cwd(), '.opencode-team')
const me = process.env.OPENCODE_TEAM_WORKER || ''

const TOOLS = [
  {
    name: 'team_send',
    description:
      'Send a message to a member of your team: the lead (use "lead"), a Claude teammate, or another worker, by name. ' +
      'Use it to ask a question, report a blocker, or share something another member needs (an API contract, a changed file). ' +
      "Your final answer already goes to whoever gave you the task, so don't use this just to report completion.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient name, as team_members lists it, or "lead"' },
        message: { type: 'string', description: 'Plain text. Make the first line a self-contained summary of what this is about.' },
        from: { type: 'string', description: 'Your own worker name, exactly as your instructions give it (e.g. "qwen-api")' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'team_members',
    description: 'List the members of your team (the lead, Claude teammates, and workers) and what each one does.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string', description: 'Your own worker name, exactly as your instructions give it' } },
    },
  },
]

function roster() {
  try {
    return JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8'))
  } catch {
    return null
  }
}

function send(args) {
  const team = roster()
  if (!team) return 'Not sent: no team is active in this directory (.opencode-team/team.json is missing).'
  const names = ['lead', ...(team.members || []).map((m) => m.name)]
  const to = String(args.to || '').trim()
  if (!names.includes(to)) return 'Not sent: no team member named "' + to + '". Members: ' + names.join(', ')
  mkdirSync(dir, { recursive: true })
  const from = me || String(args.from || '').trim()
  if (!from) return 'Not sent: say who you are in "from" (your worker name from your instructions).'
  const line = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), fromWorker: from, to, text: String(args.message || ''), at: new Date().toISOString() }
  appendFileSync(join(dir, 'outbox.jsonl'), JSON.stringify(line) + '\n', 'utf8')
  return 'Queued for ' + to + '. It will be delivered within a few seconds.'
}

function members(args) {
  const team = roster()
  if (!team) return 'No team is active in this directory.'
  return [
    'You are: ' + (me || String(args.from || '').trim() || '(unknown worker: pass your name as "from")'),
    '- lead: the Claude Code session that coordinates the team',
    ...(team.members || []).map((m) => '- ' + m.name + ' (' + m.kind + ')' + (m.role ? ': ' + m.role : '')),
  ].join('\n')
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // notifications need no answer
  if (msg.method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'opencode-team', version: '0.5.0' },
    })
  }
  if (msg.method === 'tools/list') return reply(msg.id, { tools: TOOLS })
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name
    const args = (msg.params && msg.params.arguments) || {}
    const text = name === 'team_send' ? send(args) : name === 'team_members' ? members(args) : 'Unknown tool ' + name
    return reply(msg.id, { content: [{ type: 'text', text }] })
  }
  if (msg.method === 'ping') return reply(msg.id, {})
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
})
