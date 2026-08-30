#!/usr/bin/env node
// claude-manager MCP server — gives every Claude chat launched by Christopher
// OS the ability to SHARE CONTEXT with its sibling chats in the same project.
//
// Two halves (the hybrid distilled from the cross-tool research):
//   LIVE RELAY  (simple-code-gui's orchestrator pattern): list sibling chats,
//               read their live terminal output, send/broadcast input.
//   SHARED MEMORY (claude-os / claude-flow pattern): save + search a persisted
//               per-project memory that every chat reads AND writes.
//
// Transport: hand-rolled newline-delimited JSON-RPC 2.0 over stdio — zero
// dependencies, same approach simple-code-gui ships. All real work happens in
// the Christopher OS server (port 4020) via localhost HTTP; this script is a
// thin proxy that adds the calling chat's cwd so every tool is automatically
// scoped to the right project (the claude CLI spawns MCP servers with its own
// cwd — the claude-flow cwd-scoping trick).
//
// Registration (idempotent, done by the app / once by hand):
//   claude mcp add --scope user claude-manager -- node "<abs path to this file>"

import readline from 'node:readline'

const PORT = 4840
const API = `http://127.0.0.1:${PORT}`
// claude spawns stdio MCP servers in its own working directory; fall back to
// the hook-style env var if a future version changes that.
const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd()
// Self-identity, injected by the 9b server when it spawns the parent claude.
// Lets the server exclude THIS chat from broadcasts and reject self-messages,
// and tags every relayed message with its origin (the provenance envelope).
const SELF_KEY = process.env.COS_SESSION_KEY || ''

const SERVER_INFO = { name: 'munder-difflin-v2', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// Tools — descriptions are the discoverability layer: they must make Claude
// reach for these when the user says "the other chat/window" or "remember".
// ---------------------------------------------------------------------------
import { TOOLS } from './lib/toolCatalog.js'
// ---------------------------------------------------------------------------
// HTTP helpers (the 9b server does the real work)
// ---------------------------------------------------------------------------

// Every call carries cwd (directory scoping) AND self (identity scoping): the
// server uses self's sessionId to widen the sibling set to this chat's project
// group, whose members may live in entirely different directories.
async function apiGet(path, params) {
  const qs = new URLSearchParams({ cwd: CWD, self: SELF_KEY, ...params })
  const res = await fetch(`${API}${path}?${qs}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

async function apiPost(path, payload) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: CWD, self: SELF_KEY, ...payload }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

// A step result can be pages long; the board is a summary, so long fields are
// clipped here rather than server-side — read_chat is the way to see it all.
function clip(text, max = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function fmtMemory(entries) {
  if (!entries.length) return 'No shared memory entries found.'
  return entries
    .map((e) => {
      const when = String(e.ts || '').slice(0, 16).replace('T', ' ')
      const tags = e.tags && e.tags.length ? ` [${e.tags.join(', ')}]` : ''
      return `- (${when})${tags} ${e.text}`
    })
    .join('\n')
}

async function callTool(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'list_chats': {
      const { project, sessions } = await apiGet('/api/orchestrator/context')
      if (!sessions.length) {
        return `No other live chats in project "${project.name}" right now. (A sibling chat appears here once its terminal is open in Christopher OS.)`
      }
      const rows = sessions.map(
        (s) => `- sessionId: ${s.sessionId ?? 'new'} — "${s.title}"${s.attached ? ' (on screen)' : ''}`,
      )
      return `Live chats in project "${project.name}":\n${rows.join('\n')}`
    }
    case 'floor_roster': {
      const r = await apiGet('/api/orchestrator/roster')
      const rows = r.agents
        .map((a) => {
          const who = a.isBoss ? a.name + ' (boss)' : a.name
          const me = a.isYou ? ' <- you' : ''
          return '  ' + who + (a.role ? ' — ' + a.role : '') + ': ' + a.status + me
        })
        .join('\n')
      /* Returned directly. This used to be wrapped in a text() that does not
         exist in this file, so every floor_roster call died with a
         ReferenceError that surfaced to the model as "Error: text is not
         defined" — the boss could not count its own agents. */
      return (
        'Floor "' + r.floor.name + '": ' + r.total + ' agents — ' +
        r.online + ' online, ' + r.offline + ' offline.\n' + rows
      )
    }
    case 'read_chat': {
      const { output } = await apiGet('/api/orchestrator/output', {
        sessionId: String(a.sessionId || ''),
        lines: String(Math.min(Number(a.lines) || 100, 500)),
      })
      return output || '(no output yet)'
    }
    case 'send_to_chat': {
      await apiPost('/api/orchestrator/input', {
        sessionId: String(a.sessionId || ''),
        text: String(a.text || ''),
        from: SELF_KEY || undefined,
      })
      return `Sent to chat ${a.sessionId}. It will respond in its own window — use read_chat in a moment to see its reply.`
    }
    case 'broadcast_to_chats': {
      const { sentTo } = await apiPost('/api/orchestrator/broadcast', {
        text: String(a.text || ''),
        from: SELF_KEY || undefined,
      })
      return sentTo.length ? `Broadcast sent to ${sentTo.length} chat(s): ${sentTo.join(', ')}` : 'No live sibling chats to broadcast to.'
    }
    case 'memory_save': {
      const { entry, scopeName } = await apiPost('/api/orchestrator/memory/save', {
        text: String(a.text || ''),
        tags: Array.isArray(a.tags) ? a.tags : [],
      })
      const where = scopeName ? `"${scopeName}"` : 'this project'
      return `Saved to the shared memory of ${where} (id ${entry.id.slice(0, 8)}).`
    }
    case 'memory_search': {
      const { entries } = await apiGet('/api/orchestrator/memory/search', {
        q: String(a.query || ''),
        limit: String(Number(a.limit) || 10),
      })
      return fmtMemory(entries)
    }
    case 'memory_recent': {
      const { entries } = await apiGet('/api/orchestrator/memory/recent', {
        limit: String(Number(a.limit) || 10),
      })
      return fmtMemory(entries)
    }
    case 'workflow_status': {
      const info = await apiGet('/api/orchestrator/workflow/status')
      if (!info.inRun) {
        return 'This chat is not part of a workflow run, so there is no board to show. (workflow_status only answers for the father or a step of a run.)'
      }
      const run = info.run
      const you =
        info.role === 'father'
          ? 'You are the FATHER of this run: you dispatch and integrate, you do not do the steps.'
          : 'You are one of the steps below (marked YOURS).'
      const rows = run.steps.map((s, i) => {
        const stage = s.kind === 'stage' ? ' (stage — never dispatched)' : ''
        const who =
          s.kind === 'stage'
            ? ''
            : s.sessionId
              ? ` — chat ${s.sessionId}${s.live ? '' : ' (not running)'}`
              : ' — no chat yet'
        const lines = [`${i + 1}. [${s.status}]${stage} ${s.title}${who}${s.yours ? '  <-- YOURS' : ''}`]
        if (s.result) lines.push(`      result: ${clip(s.result)}`)
        if (s.blockedReason) lines.push(`      blocked: ${clip(s.blockedReason)}`)
        return lines.join('\n')
      })
      return `Run "${run.name}" — ${run.status}, ${run.progress.done}/${run.progress.total} steps done.\n${you}\n\n${rows.join('\n')}`
    }
    case 'dispatch_step': {
      const out = await apiPost('/api/orchestrator/workflow/dispatch', {
        step: String(a.step || ''),
        task: typeof a.task === 'string' && a.task.trim() ? a.task : undefined,
      })
      const started = out.created ? 'started its chat' : 'woke its existing chat'
      return `Dispatched "${out.step.title}" — ${started} ${out.sessionId}. The run is at ${out.progress.done}/${out.progress.total}. That chat has its own tutorial and will call step_done when it finishes; use read_chat on that session id to look in on it, or workflow_status for the board.`
    }
    case 'step_done': {
      const out = await apiPost('/api/orchestrator/workflow/step-done', {
        result: String(a.result || ''),
      })
      const father = out.father ? ` The father (chat ${out.father}) can see it.` : ''
      return `"${out.step.title}" is marked done on the board — the run is at ${out.progress.done}/${out.progress.total}.${father} Nothing further is needed from you unless you are asked.`
    }
    case 'step_blocked': {
      const out = await apiPost('/api/orchestrator/workflow/step-blocked', {
        reason: String(a.reason || ''),
      })
      const father = out.father ? ` The father (chat ${out.father}) reads the reason there.` : ''
      return `"${out.step.title}" is marked blocked on the board.${father} Wait to be unblocked or re-dispatched rather than working around it.`
    }
    case 'step_note': {
      await apiPost('/api/orchestrator/workflow/step-note', { text: String(a.text || '') })
      return 'Saved to this run\'s shared memory. Your siblings and the father will find it with memory_search or memory_recent.'
    }
    case 'floor_board': {
      const r = await apiGet('/api/orchestrator/floor/board')
      const where =
        r.scope.targetType === 'mine' ? 'my tasks' : `${r.scope.targetType} board`
      const cols = ['todo', 'in-progress', 'review', 'done']
        .map((c) => {
          const cards = r.board.columns[c] ?? []
          if (!cards.length) return `${c.toUpperCase()} (0)\n  -`
          const rows = cards
            .map((g) => `  - "${g.title}" [${g.priority}] id ${g.id}`)
            .join('\n')
          return `${c.toUpperCase()} (${cards.length})\n${rows}`
        })
        .join('\n')
      const roster = r.agents
        .map((a) => `  - ${a.name}${a.role ? ' — ' + a.role : ''}${a.isBoss ? ' (you, the boss)' : ''}`)
        .join('\n')
      return (
        `Floor "${r.floor.name}" — ${where}, ${r.board.total} goal(s).\n\n${cols}\n\n` +
        `Agents on this floor (assign by name):\n${roster}`
      )
    }
    case 'goal_add': {
      const out = await apiPost('/api/orchestrator/floor/goal', {
        title: String(a.title || ''),
        description: typeof a.description === 'string' ? a.description : undefined,
        priority: typeof a.priority === 'string' ? a.priority : undefined,
        status: typeof a.status === 'string' ? a.status : undefined,
        dueDate: typeof a.dueDate === 'string' ? a.dueDate : undefined,
      })
      return (
        `Added "${out.goal.title}" to the board (goal ${out.goal.id}, ${out.goal.status}, ` +
        `${out.goal.priority}). It is live in the CRM now — the human can see it. ` +
        `Give it to somebody with goal_assign when it is ready to be worked.`
      )
    }
    case 'agent_hire': {
      const out = await apiPost('/api/orchestrator/floor/agent', {
        name: String(a.name || ''),
        role: typeof a.role === 'string' ? a.role : undefined,
        md: typeof a.md === 'string' ? a.md : undefined,
        reportsTo: typeof a.reportsTo === 'string' ? a.reportsTo : undefined,
        model: typeof a.model === 'string' ? a.model : undefined,
      })
      return (
        `Hired ${out.agent.name}${out.agent.role ? ' (' + out.agent.role + ')' : ''} onto the floor — ` +
        `${out.total} agents now. It appears on the human's floor immediately. ` +
        `No chat starts until you give it work with goal_assign.`
      )
    }
    case 'goal_assign': {
      const out = await apiPost('/api/orchestrator/floor/assign', {
        goal: String(a.goal || ''),
        agent: String(a.agent || ''),
        task: typeof a.task === 'string' && a.task.trim() ? a.task : undefined,
      })
      const started = out.created ? 'started its chat' : 'woke its existing chat'
      const warn = out.moveError
        ? ` NOTE: ${out.agent.name} is working, but the card could not be moved on the board (${out.moveError}) — tell the human, and do not assign it again.`
        : ''
      return (
        `Gave "${out.goal.title}" to ${out.agent.name} — ${started} ${out.sessionId}, ` +
        `and the card is ${out.goal.status} on the board.${warn} ` +
        `It works in its own chat from here; read_chat on ${out.sessionId} to look in on it.`
      )
    }
    case 'prompt_board': {
      const r = await apiGet('/api/orchestrator/floor/prompts')
      /* No 'convo' here on purpose. The board the BOSS reads is a list of
         work; handing it "hi" and "ok" would spend its context on things
         nobody is asking it to do. Those cards are for the human. */
      const cols = ['awaiting-input', 'todo', 'in-progress', 'review', 'done', 'later']
        .map((c) => {
          const cards = r.board.columns[c] ?? []
          if (!cards.length) return `${c.toUpperCase()} (0)\n  -`
          const rows = cards
            .map((p) => {
              const who = p.agentName ? ` [with ${p.agentName}]` : ''
              const by = p.createdBy && p.createdBy !== 'human' ? ` (added by ${p.createdBy})` : ''
              const res = p.result ? `\n      result: ${clip(p.result, 300)}` : ''
              /* The question IS the card once it is awaiting input, so it
                 prints above the result rather than being folded into it. */
              const q = p.question ? `\n      asks: ${clip(p.question, 300)}` : ''
              const lost = p.sessionLost ? ' [its chat died — re-assign it]' : ''
              return `  - ${clip(p.text, 240)}${who}${by} [${p.priority}] id ${p.id}${lost}${q}${res}`
            })
            .join('\n')
          return `${c.toUpperCase()} (${cards.length})\n${rows}`
        })
        .join('\n')
      const roster = r.agents
        .map((a) => `  - ${a.name}${a.role ? ' — ' + a.role : ''}${a.isBoss ? ' (the boss)' : ''}${a.isYou ? ' <- you' : ''}`)
        .join('\n')
      return (
        `Prompt board for "${r.floor.name}" — ${r.board.total} card(s).\n\n${cols}\n\n` +
        `Agents on this floor (hand cards out by name):\n${roster}`
      )
    }
    case 'prompt_assign': {
      const out = await apiPost('/api/orchestrator/floor/prompt-assign', {
        prompt: String(a.prompt || ''),
        agent: String(a.agent || ''),
        task: typeof a.task === 'string' && a.task.trim() ? a.task : undefined,
      })
      const started = out.created ? 'started its chat' : 'woke its existing chat'
      const warn = out.moveError
        ? ` NOTE: ${out.agent.name} is working, but the card could not be moved (${out.moveError}) — tell the human, and do not assign it again.`
        : ''
      return (
        `Gave "${clip(out.prompt.text, 120)}" to ${out.agent.name} — ${started} ${out.sessionId}, ` +
        `and the card is ${out.prompt.status}.${warn} ` +
        `read_chat on ${out.sessionId} to look in on it; prompt_status when you have seen the work.`
      )
    }
    case 'prompt_add': {
      const out = await apiPost('/api/orchestrator/floor/prompt-add', {
        text: String(a.text || ''),
        priority: typeof a.priority === 'string' ? a.priority : undefined,
      })
      return (
        `Added a card to the prompt board (id ${out.prompt.id}, ${out.prompt.status}, ${out.prompt.priority}). ` +
        `It shows on the human's board as written by you. Hand it out with prompt_assign when it is ready to be worked.`
      )
    }
    case 'prompt_ask': {
      const out = await apiPost('/api/orchestrator/floor/prompt-ask', {
        question: String(a.question || ''),
      })
      return (
        'Marked "' + clip(out.prompt.text, 100) + '" as awaiting input on the prompt board, with your question written on it. ' +
        'It survives a restart of the app, so the human will still see what you need even if this chat does not. Stop here and wait.'
      )
    }
    case 'prompt_status': {
      const out = await apiPost('/api/orchestrator/floor/prompt-status', {
        prompt: String(a.prompt || ''),
        status: String(a.status || ''),
        result: typeof a.result === 'string' ? a.result : undefined,
        question: typeof a.question === 'string' ? a.question : undefined,
      })
      return `"${clip(out.prompt.text, 100)}" is now ${out.prompt.status} on the prompt board.`
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Newline-delimited JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

// In-flight async tool calls — stdin EOF must not kill the process mid-call.
let pending = 0
let stdinClosed = false
function maybeExit() {
  // deferred so undici's pooled sockets settle first (avoids a libuv assert on win32)
  if (stdinClosed && pending === 0) setImmediate(() => process.exit(0))
}

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // not JSON — ignore
  }
  const { id, method, params } = msg

  // Notifications (no id) need no response.
  if (id === undefined || id === null) return

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS })
    } else if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments
      pending++
      try {
        const text = await callTool(name, args)
        reply(id, { content: [{ type: 'text', text }] })
      } catch (err) {
        const hint = /fetch failed|ECONNREFUSED/i.test(String(err?.message))
          ? `Christopher OS server is not reachable on port ${PORT} — is the app running?`
          : err?.message || 'Tool call failed'
        reply(id, { content: [{ type: 'text', text: `Error: ${hint}` }], isError: true })
      } finally {
        pending--
        maybeExit()
      }
    } else if (method === 'ping') {
      reply(id, {})
    } else {
      replyError(id, -32601, `Method not found: ${method}`)
    }
  } catch (err) {
    replyError(id, -32603, err?.message || 'Internal error')
  }
})

// Exit cleanly when claude closes our stdin — after in-flight calls drain.
rl.on('close', () => {
  stdinClosed = true
  maybeExit()
})
