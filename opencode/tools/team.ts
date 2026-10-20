// opencode-team: lets an OpenCode worker talk to its Claude Code team.
//
// Install by copying this file to `.opencode/tools/team.ts` in your project
// (or `~/.config/opencode/tools/team.ts` for every project). OpenCode exposes
// it to the model as two tools: `team_send` and `team_members`.
//
// How it works: the Claude Code side (the opencode-team mod) writes the team
// roster to `.opencode-team/team.json` and watches `.opencode-team/outbox.jsonl`.
// `team_send` appends one JSON line to that outbox; the mod picks it up within
// a couple of seconds and delivers it to the named teammate or the lead.

import { tool } from "@opencode-ai/plugin"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const DIR = ".opencode-team"

function teamDir(context: { directory?: string; worktree?: string }) {
  return join(context.directory || context.worktree || process.cwd(), DIR)
}

async function roster(context: { directory?: string; worktree?: string }) {
  try {
    return JSON.parse(await readFile(join(teamDir(context), "team.json"), "utf8"))
  } catch {
    return null
  }
}

export const send = tool({
  description:
    "Send a message to a member of your team: the lead (use \"lead\"), a Claude teammate, " +
    "or another OpenCode worker, by name. Use it to ask a question, report a blocker, or " +
    "share something another member needs (an API contract, a changed file). Your final " +
    "answer already goes to whoever gave you the task, so don't use this just to report completion.",
  args: {
    to: tool.schema.string().describe('Recipient name, as team_members lists it, or "lead"'),
    message: tool.schema
      .string()
      .describe("Plain text. Make the first line a self-contained summary of what this is about."),
  },
  async execute(args, context) {
    const team = await roster(context)
    if (!team) {
      return "Not sent: no team is active in this directory (.opencode-team/team.json is missing)."
    }
    const names: string[] = ["lead", ...(team.members || []).map((m: { name: string }) => m.name)]
    const to = String(args.to).trim()
    if (!names.includes(to)) {
      return `Not sent: no team member named "${to}". Members: ${names.join(", ")}`
    }
    const dir = teamDir(context)
    await mkdir(dir, { recursive: true })
    const line = JSON.stringify({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromSession: context.sessionID,
      to,
      text: String(args.message),
      at: new Date().toISOString(),
    })
    await appendFile(join(dir, "outbox.jsonl"), line + "\n", "utf8")
    return `Queued for ${to}. It will be delivered within a few seconds.`
  },
})

export const members = tool({
  description: "List the members of your team (the lead, Claude teammates, and OpenCode workers) and what each one does.",
  args: {},
  async execute(_args, context) {
    const team = await roster(context)
    if (!team) return "No team is active in this directory."
    const me = (team.members || []).find((m: { sessionID?: string }) => m.sessionID === context.sessionID)
    const lines = [
      `You are: ${me ? me.name : "(unknown worker)"}`,
      "- lead: the Claude Code session that coordinates the team",
      ...(team.members || []).map(
        (m: { name: string; kind: string; role?: string }) => `- ${m.name} (${m.kind})${m.role ? ": " + m.role : ""}`,
      ),
    ]
    return lines.join("\n")
  },
})
