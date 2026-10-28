// Tests for the opencode-team mod. Run with `claude plugin test` from the plugin folder.
// No network: a small fake OpenCode server answers the mod's $.http.fetch calls.

import { expect, mock, test as kitTest } from 'claude-code/testing'

/** Every test runs with a worker model set; the original tests use the "ask" permission mode. */
function test(name: string, body: ($: any, on: any) => Promise<void>, options: Record<string, unknown> = {}) {
  kitTest(name, { options: { model: 'company/qwen-test', workerPermissions: 'ask', ...options } }, body)
}

/** On Windows the engine resolves "/work/x" to "C:\\work\\x"; key the fake disk by the POSIX form. */
const posix = (p: string) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')

type Msg = { info: Record<string, any>; parts: Record<string, any>[] }

/** Wires every stub the mod needs and returns handles to inspect what it did. */
function harness(on: any, opts: { agents?: any[]; serverUp?: boolean; askAnswer?: string; fetch?: (e: any) => any } = {}) {
  const pendingPermissions: any[] = []
  const permissionReplies: { id: string; response: string; message?: string }[] = []
  const questions: string[] = []
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const sessions = new Map<string, { messages: Msg[]; busy: boolean }>()
  const prompts: { id: string; body: any }[] = []
  const submitted: string[] = []
  const sentToAgents: { to: string; text: string }[] = []
  const aborted: string[] = []
  const coreToolCalls: any[] = []
  const created: any[] = []
  const runs: string[][] = []
  let serverUp = opts.serverUp !== false
  let nextId = 1

  on('session.start', () => ({ cwd: '/work' }))
  on('agent.register', () => ({ value: { agent: 'opencode-team:worker' } }))
  on('command.register', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'claude-session-1' }))
  on('agent.list', () => ({ value: opts.agents || [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: files.has(posix(e.path)) }))
  on('fs.read', ($: any, e: any) => {
    const p = posix(e.path)
    if (files.has(p)) return { value: files.get(p) }
    // The plugin's own copy of the OpenCode tools ($.plugin.root differs per machine)
    if (p.endsWith('/opencode/tools/team.ts')) return { value: '// team tools' }
    return { deny: 'ENOENT ' + p }
  })
  on('fs.write', ($: any, e: any) => {
    files.set(posix(e.path), e.text)
    return { value: undefined }
  })
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv || e.command || e.args || [])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('env.get', ($: any, e: any) => ({ value: ({ USERPROFILE: '/home/me', LOCALAPPDATA: '/home/me/AppData/Local' } as any)[e.name] }))
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.send', ($: any, e: any) => {
    sentToAgents.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('tool.call', ($: any, e: any) => {
    // $.ui.ask reaches Claude Code as an AskUserQuestion tool call
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0].question
      questions.push(q)
      return { result: { answers: { [q]: opts.askAnswer || 'Reject' } } }
    }
    coreToolCalls.push(e)
    return { result: 'handled by Claude Code' }
  })

  const json = (status: number, body: unknown) => ({
    value: { status, ok: status >= 200 && status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) },
  })

  on('http.fetch', ($: any, e: any) => {
    if (opts.fetch) return opts.fetch(e)
    if (!serverUp) return { deny: 'ECONNREFUSED' }
    const url = new URL(e.url)
    const method = (e.init && e.init.method) || 'GET'
    const path = url.pathname
    const body = e.init && e.init.body ? JSON.parse(e.init.body) : undefined
    let m: RegExpMatchArray | null
    if (path === '/session/status') {
      const out: Record<string, unknown> = {}
      for (const [id, s] of sessions) if (s.busy) out[id] = { type: 'busy' }
      return json(200, out)
    }
    if (path === '/permission') return json(200, pendingPermissions)
    if ((m = path.match(/^\/permission\/([^/]+)\/reply$/))) {
      const pid = m[1]
      permissionReplies.push(body.message ? { id: pid, response: body.reply, message: body.message } : { id: pid, response: body.reply })
      const i = pendingPermissions.findIndex((p) => p.id === pid)
      if (i >= 0) pendingPermissions.splice(i, 1)
      return json(200, true)
    }
    if ((m = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/))) {
      const pid = m[2]
      permissionReplies.push({ id: pid, response: body.response })
      const i = pendingPermissions.findIndex((p) => p.id === pid)
      if (i >= 0) pendingPermissions.splice(i, 1)
      return json(200, true)
    }
    if (path === '/session' && method === 'POST') {
      created.push(body)
      const id = 'ses_' + nextId++
      sessions.set(id, { messages: [], busy: false })
      return json(200, { id, title: body.title, permission: body.permission })
    }
    if ((m = path.match(/^\/session\/([^/]+)\/prompt_async$/))) {
      const s = sessions.get(m[1])!
      prompts.push({ id: m[1], body })
      s.messages.push({ info: { role: 'user', id: 'msg_u' + s.messages.length }, parts: body.parts })
      s.busy = true
      return json(204, undefined)
    }
    if ((m = path.match(/^\/session\/([^/]+)\/message$/))) return json(200, sessions.get(m[1])!.messages)
    if ((m = path.match(/^\/session\/([^/]+)\/abort$/))) {
      aborted.push(m[1])
      sessions.get(m[1])!.busy = false
      return json(200, true)
    }
    return json(404, { error: 'no route ' + method + ' ' + path })
  })

  /** Simulates the worker model finishing its turn. */
  function finish(id: string, text: string, opts2: { files?: string[]; error?: string; model?: string } = {}) {
    const s = sessions.get(id)!
    const parts: Record<string, any>[] = (opts2.files || []).map((f) => ({ type: 'tool', tool: 'edit', state: { input: { filePath: f } } }))
    parts.push({ type: 'text', text })
    const [providerID, modelID] = (opts2.model || 'company/qwen-test').split('/')
    const info: Record<string, any> = { role: 'assistant', id: 'msg_a' + s.messages.length, providerID, modelID, time: { created: 1, completed: 2 } }
    if (opts2.error) info.error = { name: 'APIError', data: { message: opts2.error } }
    s.messages.push({ info, parts })
    s.busy = false
  }

  return {
    clock, files, store, sessions, prompts, submitted, sentToAgents, aborted, coreToolCalls, created, finish, runs,
    pendingPermissions, permissionReplies, questions,
    setServerUp(v: boolean) {
      serverUp = v
    },
  }
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

const spawnCall = {
  tool: 'Agent',
  subagent_type: 'opencode-team:worker',
  name: 'qwen-api',
  description: 'Build users API',
  prompt: 'Implement GET /users in api.js',
}

test('spawning a worker creates an OpenCode session and answers like a background agent', async ($, on) => {
  const h = harness(on)
  await start($)
  const out: any = await $.tool.call(spawnCall as any)

  expect(out.result).toMatchObject({
    status: 'async_launched',
    agentId: 'qwen-api',
    description: 'Build users API',
    prompt: 'Implement GET /users in api.js',
    outputFile: '/work/.opencode-team/logs/qwen-api.md',
  })
  expect(h.prompts.length).toBe(1)
  expect(h.prompts[0].body.parts[0].text).toBe('Implement GET /users in api.js')
  // `tools` on a prompt would replace the session's permission rules in OpenCode
  expect(h.prompts[0].body.tools).toBeUndefined()
  expect(h.prompts[0].body.system).toContain('"qwen-api"')
  // The roster the OpenCode team tools read
  const roster = JSON.parse(h.files.get('/work/.opencode-team/team.json')!)
  expect(roster.members[0]).toMatchObject({ name: 'qwen-api', kind: 'opencode', sessionID: 'ses_1' })
  // Claude Code itself never ran an Agent call for it
  expect(h.coreToolCalls.length).toBe(0)
})

test('in ask mode the worker may edit, but every shell command needs approval', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  const rules = h.created[0].permission
  const action = (p: string) => rules.find((r: any) => r.permission === p)?.action
  expect(action('edit')).toBe('allow')
  expect(action('bash')).toBe('ask')
  expect(action('webfetch')).toBe('deny')
  expect(action('question')).toBe('deny')
  expect(action('external_directory')).toBe('deny')
})

const npmTest = { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] }

test('a shell command the person rejects is not run, and the lead is told', async ($, on) => {
  const h = harness(on, { askAnswer: 'Reject' })
  await start($)
  await $.tool.call(spawnCall as any)
  h.pendingPermissions.push(npmTest)
  await h.clock.advance(2000)
  expect(h.questions[0]).toContain('qwen-api (OpenCode worker) wants to use bash: npm test')
  expect(h.permissionReplies).toEqual([{ id: 'per_1', response: 'reject' }])
  // OpenCode ends the worker's turn after a rejection
  h.finish('ses_1', '')
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('Not approved, so not run')
  expect(h.submitted[0]).toContain('bash: npm test')
})

test('a shell command the person allows is approved once', async ($, on) => {
  const h = harness(on, { askAnswer: 'Allow once' })
  await start($)
  await $.tool.call(spawnCall as any)
  h.pendingPermissions.push(npmTest)
  await h.clock.advance(2000)
  await h.clock.advance(2000) // still pending on the server? not asked twice
  expect(h.permissionReplies).toEqual([{ id: 'per_1', response: 'once' }])
  expect(h.questions.length).toBe(1)
})

test('other Agent calls pass through to Claude Code untouched', async ($, on) => {
  const h = harness(on)
  await start($)
  const out: any = await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'look', prompt: 'find x' } as any)
  expect(out.result).toBe('handled by Claude Code')
  expect(h.sessions.size).toBe(0)
})

test("a finished worker's reply wakes the lead", async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.finish('ses_1', 'Added GET /users with a test.', { files: ['src/api.js'] })
  await h.clock.advance(2000)

  expect(h.submitted.length).toBe(1)
  expect(h.submitted[0]).toContain('Reply from qwen-api')
  expect(h.submitted[0]).toContain('Added GET /users with a test.')
  expect(h.submitted[0]).toContain('Files it changed: src/api.js')
  expect(h.submitted[0]).toContain('SendMessage(to: "qwen-api")')
  // Delivered once, not on every poll
  await h.clock.advance(4000)
  expect(h.submitted.length).toBe(1)
  expect(h.files.get('/work/.opencode-team/logs/qwen-api.md')).toContain('Added GET /users with a test.')
})

test('a worker error is reported to the lead', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.finish('ses_1', '', { error: 'rate limited by provider' })
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('rate limited by provider')
})

test('SendMessage to a worker is forwarded to its OpenCode session', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.finish('ses_1', 'done')
  await h.clock.advance(2000)

  const out: any = await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', summary: 'follow up', message: 'Add pagination.' } as any)
  expect(out.result.success).toBe(true)
  expect(h.prompts.length).toBe(2)
  expect(h.prompts[1].body.parts[0].text).toBe('Message from lead:\n\nAdd pagination.')

  h.finish('ses_1', 'Pagination added.')
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(2)
  expect(h.submitted[1]).toContain('Pagination added.')
  expect(h.submitted[1]).not.toContain('done')
})

test('SendMessage to anyone else passes through', async ($, on) => {
  const h = harness(on)
  await start($)
  const out: any = await $.tool.call({ tool: 'SendMessage', to: 'frontend', message: 'hi' } as any)
  expect(out.result).toBe('handled by Claude Code')
  expect(h.coreToolCalls[0].to).toBe('frontend')
})

test("a Claude teammate's message gets the reply back, not the lead", async ($, on) => {
  const h = harness(on, { agents: [{ id: 'agent-7', name: 'frontend', description: 'UI', type: 'teammate', status: 'running' }] })
  await start($)
  await $.tool.call(spawnCall as any)
  h.finish('ses_1', 'first')
  await h.clock.advance(2000)

  await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'What is the user shape?', agentId: 'agent-7' } as any)
  expect(h.prompts[1].body.parts[0].text).toBe('Message from frontend:\n\nWhat is the user shape?')
  h.finish('ses_1', '{ id, name, email }')
  await h.clock.advance(2000)
  expect(h.sentToAgents.length).toBe(1)
  expect(h.sentToAgents[0].text).toContain('{ id, name, email }')
  expect(h.submitted.length).toBe(1) // only the first reply went to the lead
})

test('team_send lines in the outbox are routed to the lead and to other workers', async ($, on) => {
  const h = harness(on)
  await start($)
  await h.clock.advance(2000) // first poll: the outbox doesn't exist yet
  await $.tool.call(spawnCall as any)
  await $.tool.call({ ...spawnCall, name: 'qwen-web', description: 'Build web page' } as any)

  const lines = [
    { fromSession: 'ses_1', to: 'lead', text: 'Should GET /users paginate?' },
    { fromSession: 'ses_1', to: 'qwen-web', text: 'Contract: GET /users -> [{id,name}]' },
    { fromSession: 'ses_999', to: 'lead', text: 'from some other session, ignored' },
  ]
  h.files.set('/work/.opencode-team/outbox.jsonl', lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await h.clock.advance(2000)

  expect(h.submitted.length).toBe(1)
  expect(h.submitted[0]).toContain('Message from qwen-api')
  expect(h.submitted[0]).toContain('Should GET /users paginate?')
  const toWeb = h.prompts.filter((p) => p.id === 'ses_2')
  expect(toWeb[toWeb.length - 1].body.parts[0].text).toBe('Message from qwen-api:\n\nContract: GET /users -> [{id,name}]')

  // The same lines are not delivered twice
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(1)
})

test('a team_send made during a turn reaches the lead before that turn\'s reply', async ($, on) => {
  const h = harness(on)
  await start($)
  await h.clock.advance(2000) // first poll: the outbox doesn't exist yet
  await $.tool.call(spawnCall as any)
  // Within one poll interval the worker messages the lead and then finishes
  h.files.set('/work/.opencode-team/outbox.jsonl', JSON.stringify({ fromSession: 'ses_1', to: 'lead', text: 'Should GET /users paginate?' }) + '\n')
  h.finish('ses_1', 'Added GET /users.')
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(2)
  expect(h.submitted[0]).toContain('Should GET /users paginate?')
  expect(h.submitted[1]).toContain('Added GET /users.')
})

test('outbox lines left by an earlier session are skipped', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/.opencode-team/outbox.jsonl', JSON.stringify({ fromSession: 'ses_1', to: 'lead', text: 'old' }) + '\n')
  await start($)
  await $.tool.call(spawnCall as any)
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(0)
})

test('TaskStop aborts the worker and later messages are refused', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  const stop: any = await $.tool.call({ tool: 'TaskStop', task_id: 'qwen-api' } as any)
  expect(stop.result.task_id).toBe('qwen-api')
  expect(h.aborted).toEqual(['ses_1'])
  const out: any = await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'more' } as any)
  expect(out.result.success).toBe(false)
})

test('two workers with the same name get distinct names', async ($, on) => {
  harness(on)
  await start($)
  const a: any = await $.tool.call(spawnCall as any)
  const b: any = await $.tool.call(spawnCall as any)
  expect(a.result.agentId).toBe('qwen-api')
  expect(b.result.agentId).toBe('qwen-api-2')
})

test('spawn fails clearly when OpenCode is down and auto-start cannot reach it', async ($, on) => {
  const h = harness(on, { serverUp: false })
  await start($)
  const out: any = await $.tool.call(spawnCall as any)
  expect(out.deny).toContain('Could not start the OpenCode worker')
  expect(h.sessions.size).toBe(0)
})

test('/opencode-team setup installs the team tools and ignores the team folder in git', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/.gitignore', 'node_modules/\n')
  await start($)
  const out: any = await $.command.run({ command: 'opencode-team', args: 'setup' })
  expect(h.files.get('/work/.opencode/tools/team.ts')).toBe('// team tools')
  expect(h.files.get('/work/.gitignore')).toBe('node_modules/\n.opencode-team/\n')
  expect(out.text).toContain('Installed the team tools')
  // Running it again does not add the line twice
  await $.command.run({ command: 'opencode-team', args: 'setup' })
  expect(h.files.get('/work/.gitignore')).toBe('node_modules/\n.opencode-team/\n')
})

test('/opencode-team status lists workers', async ($, on) => {
  harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  const out: any = await $.command.run({ command: 'opencode-team', args: '' })
  expect(out.text).toContain('(running)')
  expect(out.text).toContain('- qwen-api [busy] Build users API')
  expect(out.text).toContain('/opencode-team setup')
})

// ---------------------------------------------------------------------------
// Lead mode: Claude approves the worker's shell commands, no dialogs

const lead = { workerPermissions: 'lead' }

test('lead is the default mode: edits allowed, shell and web go to Claude, no subagents', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  const action = (p: string) => h.created[0].permission.find((r: any) => r.permission === p)?.action
  expect(action('edit')).toBe('allow')
  expect(action('bash')).toBe('ask')
  expect(action('webfetch')).toBe('ask')
  expect(action('task')).toBe('deny')
}, { workerPermissions: undefined })

test('a shell command in lead mode goes to Claude, and "approve" runs it once', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.pendingPermissions.push(npmTest)
  await h.clock.advance(2000)
  expect(h.questions.length).toBe(0) // nobody gets a dialog
  expect(h.submitted[0]).toContain('qwen-api (OpenCode worker, company/qwen-test) is waiting for your approval to use bash')
  expect(h.submitted[0]).toContain('npm test')
  expect(h.submitted[0]).toContain('SendMessage(to: "qwen-api"')

  const out: any = await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'approve' } as any)
  expect(out.result.success).toBe(true)
  expect(out.result.message).toContain('Approved')
  expect(h.permissionReplies).toEqual([{ id: 'per_1', response: 'once' }])
  expect(h.prompts.length).toBe(1) // the answer is not sent as a new prompt
}, lead)

test('"reject: …" in lead mode sends the reason to the worker, which carries on', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.pendingPermissions.push(npmTest)
  await h.clock.advance(2000)
  const out: any = await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'reject: run npm run lint instead' } as any)
  expect(out.result.message).toContain('Rejected')
  expect(h.permissionReplies).toEqual([{ id: 'per_1', response: 'reject', message: 'run npm run lint instead' }])
  h.finish('ses_1', 'Ran lint instead.')
  await h.clock.advance(2000)
  expect(h.submitted[1]).toContain('Ran lint instead.')
  expect(h.submitted[1]).not.toContain('Not approved') // Claude already knows; no warning
}, lead)

test('requests in lead mode are asked one at a time', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.pendingPermissions.push(npmTest, { ...npmTest, id: 'per_2', patterns: ['npm run build'] })
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(1)
  expect(h.submitted[0]).toContain('1 more waiting')
  const first: any = await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'approve always' } as any)
  expect(first.result.message).toContain('Next request')
  expect(first.result.message).toContain('npm run build')
  await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'no, the build is slow; skip it' } as any)
  expect(h.permissionReplies).toEqual([
    { id: 'per_1', response: 'always' },
    { id: 'per_2', response: 'reject', message: 'the build is slow; skip it' },
  ])
}, lead)

// ---------------------------------------------------------------------------
// Qwen only

test('a worker is not started without a configured model', async ($, on) => {
  const h = harness(on)
  await start($)
  const out: any = await $.tool.call(spawnCall as any)
  expect(out.deny).toContain('no worker model is set')
  expect(h.sessions.size).toBe(0)
}, { model: '' })

test('every prompt pins the model and the build agent', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  expect(h.prompts[0].body.model).toEqual({ providerID: 'company', modelID: 'qwen-test' })
  expect(h.prompts[0].body.agent).toBe('build')
})

test('a reply that came from another model is flagged', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.finish('ses_1', 'done', { model: 'anthropic/claude-sonnet' })
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('ran on anthropic/claude-sonnet, not on the configured company/qwen-test')
})

// ---------------------------------------------------------------------------
// ZCode backend

const zcode = { backend: 'zcode', workerPermissions: 'lead', model: 'qwen/qwen3-coder-plus' }
const ZCLI = '/home/me/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs'

function zcodeInstalled(h: any) {
  h.files.set(ZCLI, '// zcode')
  h.files.set('/home/me/.zcode/v2/provider_config.json', '{}')
}

function homeOf(h: any, name: string) {
  const suffix = '/' + name + '/turn-1.job.json'
  const job = Array.from(h.files.keys() as Iterable<string>).find((k) => k.endsWith(suffix))!
  return job.slice(0, job.length - suffix.length + name.length + 1)
}

const lines = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n'

test('a ZCode worker turn runs detached in yolo mode, with shell and web gated for Claude', async ($, on) => {
  const h = harness(on)
  zcodeInstalled(h)
  await start($)
  const out: any = await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  expect(out.result).toMatchObject({ status: 'async_launched', agentId: 'qwen-z' })
  const home = homeOf(h, 'qwen-z')
  expect(home.startsWith('/home/me/.opencode-team/zcode/work-')).toBe(true) // outside the project
  const job = JSON.parse(h.files.get(home + '/turn-1.job.json'))
  expect(job).toMatchObject({ zcode: ZCLI, model: 'qwen/qwen3-coder-plus', mode: 'yolo', gate: 'Bash|WebFetch|WebSearch', resume: '' })
  expect(job.disallowed).toEqual(['Agent', 'AskUserQuestion'])
  expect(job.prompt).toContain('You are "qwen-z"')
  expect(job.prompt).toContain('Implement GET /users in api.js')
  expect(h.runs.some((argv: string[]) => argv.join(' ').includes('run-turn.mjs'))).toBe(true)
  expect(h.sessions.size).toBe(0) // no OpenCode involved
}, zcode)

test('a ZCode approval request reaches Claude, and the answer is written for the hook', async ($, on) => {
  const h = harness(on)
  zcodeInstalled(h)
  await start($)
  await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  const home = homeOf(h, 'qwen-z')
  h.files.set(home + '/requests.jsonl', lines({ id: 'call_1-a', tool: 'Bash', input: { command: 'npm test' } }))
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('qwen-z (ZCode worker, qwen/qwen3-coder-plus) is waiting for your approval to use Bash')
  expect(h.submitted[0]).toContain('npm test')
  expect(h.submitted[0]).not.toContain('approve always') // ZCode has no "always"
  await $.tool.call({ tool: 'SendMessage', to: 'qwen-z', message: 'reject: use npm run lint' } as any)
  expect(JSON.parse(h.files.get(home + '/answers/call_1-a.json'))).toEqual({ behavior: 'deny', message: 'use npm run lint' })
}, zcode)

test('a finished ZCode turn is delivered, and the next message resumes its session', async ($, on) => {
  const h = harness(on)
  zcodeInstalled(h)
  await start($)
  await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  const home = homeOf(h, 'qwen-z')
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(0) // still running: no __exit line yet
  h.files.set(
    home + '/turn-1.jsonl',
    lines(
      { type: 'session.updated', sessionId: 'sess_1', payload: { providerId: 'qwen', modelId: 'qwen3-coder-plus' } },
      { type: 'tool.updated', sessionId: 'sess_1', payload: { kind: 'scheduled', toolName: 'Write', input: { file_path: 'src/api.js' } } },
      { type: 'turn.completed', sessionId: 'sess_1', payload: { response: 'Added GET /users.', resultType: 'success' } },
      { type: 'result', sessionId: 'sess_1', response: 'Added GET /users.' },
      { type: '__exit', code: 0, stderr: '' },
    ),
  )
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('Reply from qwen-z (ZCode worker, qwen/qwen3-coder-plus)')
  expect(h.submitted[0]).toContain('Files it changed: src/api.js')
  expect(h.submitted[0]).toContain('Added GET /users.')
  expect(h.submitted[0]).not.toContain('⚠')

  await $.tool.call({ tool: 'SendMessage', to: 'qwen-z', message: 'Add pagination.' } as any)
  const job2 = JSON.parse(h.files.get(home + '/turn-2.job.json'))
  expect(job2.resume).toBe('sess_1')
  expect(job2.prompt).toBe('Message from lead:\n\nAdd pagination.')
}, zcode)

test('a ZCode crash is reported to the lead', async ($, on) => {
  const h = harness(on)
  zcodeInstalled(h)
  await start($)
  await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  h.files.set(homeOf(h, 'qwen-z') + '/turn-1.jsonl', lines({ type: '__exit', code: 1, stderr: 'Error: provider qwen has no model qwen3-coder-plus' }))
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('ZCode exited with code 1: Error: provider qwen has no model qwen3-coder-plus')
}, zcode)

test('team_send from a ZCode worker (by name) is routed', async ($, on) => {
  const h = harness(on)
  zcodeInstalled(h)
  await start($)
  await h.clock.advance(2000)
  await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  h.files.set('/work/.opencode-team/outbox.jsonl', lines({ fromWorker: 'qwen-z', to: 'lead', text: 'Should GET /users paginate?' }))
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('Message from qwen-z (ZCode worker)')
}, zcode)

test('ZCode spawn explains what is missing', async ($, on) => {
  const h = harness(on)
  h.files.set(ZCLI, '// zcode')
  await start($)
  const out: any = await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  expect(out.deny).toContain('no ZCode provider config')
}, { ...zcode, zcodeCommand: ZCLI })

test('ZCode spawn says when ZCode is not installed', async ($, on) => {
  harness(on)
  await start($)
  const out: any = await $.tool.call({ ...spawnCall, name: 'qwen-z' } as any)
  expect(out.deny).toContain('ZCode was not found')
}, { ...zcode, zcodeCommand: '/nowhere/zcode.cjs' })

// ---------------------------------------------------------------------------
// OpenCode 2: everything under /api, found through the background service's file

const SVC = 'http://127.0.0.1:5000'

/** A fake OpenCode 2: serverUrl (4096) refuses /api without its password; the service at SVC answers. */
function harnessV2(on: any, opts: { askAnswer?: string; service?: boolean } = {}) {
  const h = harness(on, { askAnswer: opts.askAnswer, fetch: (e: any) => fetchV2(e) })
  const sessions = new Map<string, { messages: any[]; busy: boolean; permissions: any[] }>()
  const created: any[] = []
  const prompts: { id: string; text: string }[] = []
  const replies: { id: string; body: any }[] = []
  const interrupted: string[] = []
  const auth: string[] = []
  let nextId = 1
  let nextMsg = 1
  if (opts.service !== false) h.files.set('/home/me/.local/state/opencode/service.json', JSON.stringify({ url: SVC + '/', password: 'svcpw' }))

  const json = (status: number, body: unknown) => ({
    value: { status, ok: status >= 200 && status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) },
  })
  function fetchV2(e: any) {
    const url = new URL(e.url)
    const method = (e.init && e.init.method) || 'GET'
    const path = url.pathname
    const body = e.init && e.init.body ? JSON.parse(e.init.body) : undefined
    // Every path that isn't /api is the web UI, an HTML page with 200
    if (!path.startsWith('/api/')) return { value: { status: 200, ok: true, headers: {}, text: '<!doctype html>' } }
    if (url.origin !== SVC || e.init.headers.authorization !== 'Basic ' + btoa('opencode:svcpw')) return json(401, { error: 'unauthorized' })
    auth.push(path)
    let m: RegExpMatchArray | null
    if (path === '/api/session/active') {
      const data: Record<string, unknown> = {}
      for (const [id, s] of sessions) if (s.busy) data[id] = { type: 'running' }
      return json(200, { data })
    }
    if (path === '/api/session' && method === 'POST') {
      created.push(body)
      const id = 'ses_v2_' + nextId++
      sessions.set(id, { messages: [], busy: false, permissions: [] })
      return json(200, { data: { id, location: body.location } })
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/prompt$/))) {
      const s = sessions.get(m[1])!
      prompts.push({ id: m[1], text: body.text })
      s.messages.push({ id: 'msg_' + nextMsg++, type: 'user', text: body.text })
      s.busy = true
      return json(200, { data: { id: 'msg_x', type: 'user' } })
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/message$/))) {
      // Newest first, like order=desc
      return json(200, { data: sessions.get(m[1])!.messages.slice().reverse(), cursor: { previous: null, next: null } })
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/permission$/))) return json(200, { data: sessions.get(m[1])!.permissions })
    if ((m = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/))) {
      const s = sessions.get(m[1])!
      replies.push({ id: m[2], body })
      s.permissions = s.permissions.filter((p) => p.id !== m![2])
      return json(204, undefined)
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/interrupt$/))) {
      interrupted.push(m[1])
      sessions.get(m[1])!.busy = false
      return json(200, { interrupted: true })
    }
    return json(404, { error: 'no route ' + method + ' ' + path })
  }

  /** The worker's turn ends: its replies, then the idle marker. */
  function finish(id: string, text: string, o: { files?: string[]; model?: string; error?: string } = {}) {
    const s = sessions.get(id)!
    const [providerID, mid] = (o.model || 'company/qwen-test').split('/')
    const content: any[] = (o.files || []).map((f) => ({ type: 'tool', name: 'write', state: { status: 'completed', input: { path: f } } }))
    content.push({ type: 'text', text })
    const msg: any = { id: 'msg_' + nextMsg++, type: 'assistant', model: { providerID, id: mid }, content, time: { created: 1, completed: 2 } }
    if (o.error) msg.error = { type: 'api', message: o.error }
    s.messages.push(msg)
    s.messages.push({ id: 'msg_' + nextMsg++, type: 'idle', outcome: o.error ? 'failed' : 'succeeded' })
    s.busy = false
  }
  return { ...h, sessions, created, prompts, replies, interrupted, auth, finish }
}

test('with OpenCode 2 the worker runs on the background service, with v2 permission rules', async ($, on) => {
  const h = harnessV2(on)
  await start($)
  const out: any = await $.tool.call(spawnCall as any)
  expect(out.result).toMatchObject({ status: 'async_launched', agentId: 'qwen-api' })
  const s = h.created[0]
  expect(s.model).toEqual({ providerID: 'company', id: 'qwen-test' })
  expect(s.agent).toBe('build')
  expect(s.location).toEqual({ directory: '/work' })
  const effect = (a: string) => s.permissions.find((r: any) => r.action === a)?.effect
  expect(effect('edit')).toBe('allow')
  expect(effect('write')).toBe('allow')
  expect(effect('shell')).toBe('ask')
  expect(effect('question')).toBe('deny')
  expect(effect('subagent')).toBe('deny')
  // No system field in v2: the team instructions open the first prompt
  expect(h.prompts[0].text).toContain('You are "qwen-api"')
  expect(h.prompts[0].text.endsWith('Implement GET /users in api.js')).toBe(true)
  const roster = JSON.parse(h.files.get('/work/.opencode-team/team.json')!)
  expect(roster.members[0]).toMatchObject({ name: 'qwen-api', sessionID: 'ses_v2_1' })
})

test('an OpenCode 2 reply is delivered once the idle marker follows it', async ($, on) => {
  const h = harnessV2(on)
  await start($)
  await $.tool.call(spawnCall as any)
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(0) // still running
  h.finish('ses_v2_1', 'Added GET /users.', { files: ['/work/src/api.js'] })
  await h.clock.advance(2000)
  expect(h.submitted.length).toBe(1)
  expect(h.submitted[0]).toContain('Reply from qwen-api')
  expect(h.submitted[0]).toContain('Added GET /users.')
  expect(h.submitted[0]).toContain('Files it changed: /work/src/api.js')
  expect(h.submitted[0]).not.toContain('⚠')
  await h.clock.advance(4000)
  expect(h.submitted.length).toBe(1)

  // The next message is a plain prompt, and only the new turn is delivered
  await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'Add pagination.' } as any)
  expect(h.prompts[1].text).toBe('Message from lead:\n\nAdd pagination.')
  h.finish('ses_v2_1', 'Pagination added.', { model: 'anthropic/claude-sonnet' })
  await h.clock.advance(2000)
  expect(h.submitted[1]).toContain('Pagination added.')
  expect(h.submitted[1]).not.toContain('Added GET /users.')
  expect(h.submitted[1]).toContain('ran on anthropic/claude-sonnet, not on the configured company/qwen-test')
})

test('an OpenCode 2 error is reported to the lead', async ($, on) => {
  const h = harnessV2(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.finish('ses_v2_1', '', { error: 'rate limited by provider' })
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('rate limited by provider')
})

test('an OpenCode 2 shell request goes to Claude in lead mode, and the answer uses the v2 reply', async ($, on) => {
  const h = harnessV2(on)
  await start($)
  await $.tool.call(spawnCall as any)
  h.sessions.get('ses_v2_1')!.permissions.push(
    { id: 'per_a', sessionID: 'ses_v2_1', action: 'shell', resources: ['npm test'] },
    { id: 'per_b', sessionID: 'ses_v2_1', action: 'shell', resources: ['rm -rf dist'] },
  )
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('is waiting for your approval to use shell')
  expect(h.submitted[0]).toContain('npm test')
  await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'approve' } as any)
  await $.tool.call({ tool: 'SendMessage', to: 'qwen-api', message: 'reject: not outside the build' } as any)
  expect(h.replies).toEqual([
    { id: 'per_a', body: { decision: 'once' } },
    { id: 'per_b', body: { decision: 'reject', message: 'not outside the build' } },
  ])
  expect(h.prompts.length).toBe(1)
}, lead)

test('TaskStop interrupts an OpenCode 2 worker', async ($, on) => {
  const h = harnessV2(on)
  await start($)
  await $.tool.call(spawnCall as any)
  await $.tool.call({ tool: 'TaskStop', task_id: 'qwen-api' } as any)
  expect(h.interrupted).toEqual(['ses_v2_1'])
})

test('/opencode-team status names the OpenCode 2 service', async ($, on) => {
  harnessV2(on)
  await start($)
  const out: any = await $.command.run({ command: 'opencode-team', args: '' })
  expect(out.text).toContain(SVC + ' (OpenCode 2) (running)')
})

test('an OpenCode 2 server without its password and no service says so', async ($, on) => {
  const h = harnessV2(on, { service: false })
  await start($)
  const out: any = await $.tool.call(spawnCall as any)
  expect(out.deny).toContain('refused the password (HTTP 401)')
  expect(h.created.length).toBe(0)
})

// ---------------------------------------------------------------------------
// Per-worker models: the Agent call's model picks one of the "models" aliases

const aliases = { models: 'sonnet=github-copilot/claude-sonnet-5.5, opus = github-copilot/claude-opus-5.5' }

test('a spawn with a mapped model runs on that model, and its replies are not flagged', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call({ ...spawnCall, model: 'sonnet' } as any)
  expect(h.prompts[0].body.model).toEqual({ providerID: 'github-copilot', modelID: 'claude-sonnet-5.5' })
  h.finish('ses_1', 'done', { model: 'github-copilot/claude-sonnet-5.5' })
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('Reply from qwen-api (OpenCode worker, github-copilot/claude-sonnet-5.5)')
  expect(h.submitted[0]).not.toContain('⚠')
  const roster = JSON.parse(h.files.get('/work/.opencode-team/team.json')!)
  expect(roster.saved[0].model).toBe('github-copilot/claude-sonnet-5.5')
}, aliases)

test('workers spawned without a model keep the default next to an aliased one', async ($, on) => {
  const h = harness(on)
  await start($)
  await $.tool.call({ ...spawnCall, model: 'opus' } as any)
  await $.tool.call({ ...spawnCall, name: 'qwen-web' } as any)
  expect(h.prompts[0].body.model).toEqual({ providerID: 'github-copilot', modelID: 'claude-opus-5.5' })
  expect(h.prompts[1].body.model).toEqual({ providerID: 'company', modelID: 'qwen-test' })
  const out: any = await $.command.run({ command: 'opencode-team', args: '' })
  expect(out.text).toContain('- qwen-api [busy] Build users API · github-copilot/claude-opus-5.5')
  expect(out.text).toContain('- qwen-web [busy] Build users API · company/qwen-test')
}, aliases)

test('a model with no alias is refused, never swapped for the default', async ($, on) => {
  const h = harness(on)
  await start($)
  const out: any = await $.tool.call({ ...spawnCall, model: 'haiku' } as any)
  expect(out.deny).toContain('no worker model is mapped to "haiku"')
  expect(out.deny).toContain('sonnet → github-copilot/claude-sonnet-5.5')
  expect(h.sessions.size).toBe(0)
}, aliases)

test('with OpenCode 2 a mapped model is pinned on the session', async ($, on) => {
  const h = harnessV2(on)
  await start($)
  await $.tool.call({ ...spawnCall, model: 'sonnet' } as any)
  expect(h.created[0].model).toEqual({ providerID: 'github-copilot', id: 'claude-sonnet-5.5' })
}, aliases)
