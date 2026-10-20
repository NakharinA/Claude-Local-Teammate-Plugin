// opencode-team: ZCode PreToolUse hook. Passes a gated tool call to the lead and waits.
//
// The worker runs in yolo mode; config.json matches this hook to the tools that
// need the lead's approval (shell, web). The request is appended to
// <home>/requests.jsonl; the mod hands it to Claude (or to you, in "ask" mode),
// and the answer comes back as <home>/answers/<id>.json.
//
// ZCode treats a failed or timed-out hook as "no decision" and runs the tool, so
// this always prints a decision, and denies whenever something is off. (A
// PermissionRequest hook can't be used: in headless runs it races ZCode's deny
// broker and always loses.)

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WAIT_MS = 14 * 60 * 1000 // under the 15-minute hook timeout in config.json

function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) },
    }),
  )
  process.exit(0)
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  const home = process.env.OPENCODE_TEAM_HOME
  if (!home) decide('deny', 'opencode-team: no lead to ask for approval, so this was not run.')
  let req
  try {
    req = JSON.parse(input)
  } catch {
    decide('deny', 'opencode-team: unreadable tool call, so this was not run.')
  }
  // Tool-call ids repeat across turns (call_1, call_2 …): make each request's id unique.
  const id = (String(req.toolCallId || req.tool_use_id || 'call') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).replace(/[^\w.-]/g, '_')
  appendFileSync(
    join(home, 'requests.jsonl'),
    JSON.stringify({ id, tool: req.toolName || req.tool_name, input: req.toolInput || req.tool_input, at: new Date().toISOString() }) + '\n',
  )
  const answer = join(home, 'answers', id + '.json')
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) {
    if (existsSync(answer)) {
      try {
        const a = JSON.parse(readFileSync(answer, 'utf8'))
        if (a.behavior === 'allow') decide('allow', 'Approved by the lead.')
        decide('deny', a.message ? 'The lead rejected this: ' + a.message : 'The lead rejected this.')
      } catch {
        // Half-written; read it again on the next pass.
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  decide('deny', 'The lead did not answer within 14 minutes, so this was not run. Ask again later or try another way.')
})
