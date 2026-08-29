// PROMPT KANBAN — the queue of work the human hands a floor, one card per prompt.
//
// The problem it exists for, in the user's own words: "the biggest problem in a
// single session is we have to wait for one prompt to get over before we give
// [the next] — this solves that". You write every prompt down at once; the boss
// reads the board and hands them out; several agents work at the same time and
// each card carries its own state.
//
// NOT the same board as the Goal Kanban. That one is the CRM's — live company
// goals, shared with everyone, written straight to production. This one is
// LOCAL to this computer and to one floor: it is how you talk to your agents,
// not a record anybody else is meant to read. Keeping them apart is the whole
// point of there being two tabs, so nothing here ever writes to the CRM.
//
// Persisted per-floor in server/data/prompts.json with the same atomic
// temp+rename discipline as floors.js, so a crash mid-save cannot truncate it.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json')

/* The Goal Kanban's four columns, plus two this board needs and the CRM's does
   not — a card here is work handed to an agent, and that can stall on a
   question or be set aside, neither of which is a CRM goal status.

   'later' sits at the END, past done, because it is OUT of the flow rather
   than a step in it: work you have deliberately set aside. Keeping it on the
   board rather than deleting it is the point — a parked task you cannot see is
   a task you have forgotten. */
export const PROMPT_COLUMNS = [
  'todo',
  'in-progress',
  'awaiting-input',
  'review',
  'done',
  'later',
]

const MAX_TEXT = 8000
const MAX_RESULT = 4000
const MAX_PER_FLOOR = 500

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* best effort; the write surfaces real errors */
  }
}

function hydrate(p) {
  if (!p || typeof p !== 'object') return null
  if (typeof p.id !== 'string' || !p.id) return null
  const text = typeof p.text === 'string' ? p.text.slice(0, MAX_TEXT) : ''
  if (!text.trim()) return null
  return {
    id: p.id,
    floorId: typeof p.floorId === 'string' ? p.floorId : '',
    text,
    /* An unknown status reads as 'todo' rather than being dropped: a card whose
       column we cannot place is still work somebody wrote down. */
    status: PROMPT_COLUMNS.includes(p.status) ? p.status : 'todo',
    priority: ['low', 'medium', 'high', 'urgent'].includes(p.priority) ? p.priority : 'medium',
    /* Who it is with. Name, not id, because the boss addresses agents by name
       and an agent can be deleted from the floor while its card remains — a
       card that says "was with Dwight" is more use than a dangling id. */
    agentName: typeof p.agentName === 'string' ? p.agentName : null,
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
    /* What came back. Set when a card reaches review. */
    result: typeof p.result === 'string' ? p.result.slice(0, MAX_RESULT) : null,
    /* WHAT IT IS WAITING TO HEAR, when the card is awaiting-input.
       This is the whole point of the awaiting-input column. A question an agent
       asks lives only in that pty's scrollback, so when the app restarts and
       every session dies the question goes with it — leaving a card that
       stopped for no visible reason. Written down here it survives, because
       this store is a file on disk. */
    question: typeof p.question === 'string' ? p.question.slice(0, MAX_RESULT) : null,
    /* Set at boot on a card that was mid-flight when the app last stopped: its
       chat is gone, and whatever was on that screen went with it. The card has
       to be picked up again rather than left waiting on a session that is never
       coming back. */
    sessionLost: p.sessionLost === true,
    /* 'human' or the boss's name — the same human-vs-AI distinction the CRM
       sync needed, kept here so you can see which prompts you wrote and which
       the boss decomposed out of them. */
    createdBy: typeof p.createdBy === 'string' ? p.createdBy : 'human',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
  }
}

let prompts = loadStore()

function loadStore() {
  ensureDataDir()
  let raw
  try {
    raw = fs.readFileSync(PROMPTS_FILE, 'utf8')
  } catch {
    return [] // no store yet — first run
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.prompts) ? parsed.prompts : Array.isArray(parsed) ? parsed : []
    return list.map(hydrate).filter(Boolean)
  } catch (err) {
    /* Same discipline as floors.js, projects.js, views.js, groups.js and
       workflowRuns.js: a file that will not PARSE is kept, not silently read as
       an empty store. Collapsing both failures into `return []` is how a queue
       of everything the user wrote down disappears — the next card they add
       writes a one-card file over the real one, temp+rename makes that write
       perfectly clean, and nothing anywhere reports a loss, because nothing
       failed. The atomic write protects the write path; this protects the read
       path, which is where the truncation hazard actually is. */
    const backup = `${PROMPTS_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(PROMPTS_FILE, backup)
      console.error(`prompts.json is corrupt (${err?.message}); moved it to ${backup}`)
    } catch {
      /* ignore — the rename is a rescue, not a requirement */
    }
    return []
  }
}

function saveStore() {
  ensureDataDir()
  const tmp = `${PROMPTS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ prompts }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, PROMPTS_FILE)
}

const clone = (p) => ({ ...p })

/** Every prompt on one floor, newest first within each column. */
export function listPrompts(floorId) {
  return prompts.filter((p) => p.floorId === floorId).map(clone)
}

/** The board shape the UI and the boss's tool both read. */
export function promptBoard(floorId) {
  const mine = prompts.filter((p) => p.floorId === floorId)
  const columns = Object.fromEntries(PROMPT_COLUMNS.map((c) => [c, []]))
  for (const p of mine) columns[p.status].push(clone(p))
  for (const c of PROMPT_COLUMNS) {
    /* Oldest first: a queue is read top-down, and the thing written first is
       the thing that has been waiting longest. */
    columns[c].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }
  return { floorId, total: mine.length, columns }
}

export function getPrompt(id) {
  const p = prompts.find((x) => x.id === id)
  return p ? clone(p) : null
}

export function createPrompt(floorId, { text, priority, status, createdBy } = {}) {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, reason: 'A prompt needs some text' }
  if (prompts.filter((p) => p.floorId === floorId).length >= MAX_PER_FLOOR) {
    return { ok: false, reason: `This floor already has ${MAX_PER_FLOOR} prompts, which is the limit.` }
  }
  const now = new Date().toISOString()
  const p = hydrate({
    id: randomUUID(),
    floorId,
    text: t,
    status: PROMPT_COLUMNS.includes(status) ? status : 'todo',
    priority,
    createdBy: createdBy || 'human',
    createdAt: now,
    updatedAt: now,
  })
  if (!p) return { ok: false, reason: 'Could not build that prompt' }
  prompts = [...prompts, p]
  persist('create', p.id)
  return { ok: true, prompt: clone(p) }
}

export function updatePrompt(id, patch = {}) {
  const i = prompts.findIndex((p) => p.id === id)
  if (i === -1) return { ok: false, reason: 'No such prompt' }
  const cur = prompts[i]
  const next = { ...cur }

  if (patch.text !== undefined) {
    const t = String(patch.text).trim()
    if (!t) return { ok: false, reason: 'A prompt needs some text' }
    next.text = t.slice(0, MAX_TEXT)
  }
  if (patch.status !== undefined) {
    if (!PROMPT_COLUMNS.includes(patch.status)) {
      return { ok: false, reason: `status must be one of: ${PROMPT_COLUMNS.join(', ')}` }
    }
    next.status = patch.status
  }
  if (patch.priority !== undefined) {
    if (!['low', 'medium', 'high', 'urgent'].includes(patch.priority)) {
      return { ok: false, reason: 'priority must be one of: low, medium, high, urgent' }
    }
    next.priority = patch.priority
  }
  /* null clears; undefined leaves alone. Same rule as the goal dialog's pillar,
     for the same reason: "unassign this" and "do not touch this" are different
     instructions and collapsing them makes one of them impossible. */
  if (patch.agentName !== undefined) {
    next.agentName = patch.agentName === null ? null : String(patch.agentName).slice(0, 60)
  }
  if (patch.sessionId !== undefined) {
    next.sessionId = patch.sessionId === null ? null : String(patch.sessionId)
  }
  if (patch.result !== undefined) {
    next.result = patch.result === null ? null : String(patch.result).slice(0, MAX_RESULT)
  }
  if (patch.question !== undefined) {
    next.question = patch.question === null ? null : String(patch.question).slice(0, MAX_RESULT)
  }
  if (patch.sessionLost !== undefined) next.sessionLost = patch.sessionLost === true
  /* Moving OFF awaiting-input answers the question, and moving anywhere at all
     means somebody has picked the card up — so the lost-session flag stops
     being true the moment it is acted on. Leaving either behind would show a
     stale 'waiting for you' on a card already back in flight. */
  if (patch.status !== undefined && patch.status !== 'awaiting-input') {
    next.question = null
    next.sessionLost = false
  }
  /* Parking a card RELEASES it. A card that reads 'with Dwight' while sitting in
     Do later is a contradiction: you have set the work aside, so it is with
     nobody. The agent's chat is left alone — stopping somebody mid-turn is a
     destructive act and belongs to a deliberate click, not to filing a card. */
  if (patch.status === 'later') {
    next.agentName = null
    next.sessionId = null
  }
  next.updatedAt = new Date().toISOString()
  prompts = prompts.map((p, j) => (j === i ? next : p))
  persist('update', id)
  return { ok: true, prompt: clone(next) }
}

export function deletePrompt(id) {
  const before = prompts.length
  prompts = prompts.filter((p) => p.id !== id)
  if (prompts.length === before) return { ok: false, reason: 'No such prompt' }
  persist('delete', id)
  return { ok: true }
}

/**
 * Flag every card that was still with an agent when the app last stopped.
 *
 * Called ONCE at boot, before anything can be dispatched. Every pty dies with
 * the server, so a card left in `in-progress` or `awaiting-input` is now
 * waiting on a chat that no longer exists — and if it was awaiting-input, the
 * question was on a screen that is gone. Without this the board would keep
 * showing "with Dwight" for a Dwight who is not there, and the human would wait
 * on an answer nobody is going to give.
 *
 * The card is NOT moved back to to-do: where it got to is real information, and
 * silently rewinding somebody's work is worse than showing it stalled.
 */
export function markSessionsLostAtBoot() {
  let n = 0
  prompts = prompts.map((p) => {
    if ((p.status === 'in-progress' || p.status === 'awaiting-input') && p.sessionId) {
      n++
      return { ...p, sessionLost: true }
    }
    return p
  })
  if (n > 0) {
    persist('boot-sweep', 'all')
    console.log(`[prompts] ${n} card(s) were mid-flight when the app last stopped — their chats are gone`)
  }
  return n
}

/** Drop a floor's prompts when the floor goes. Called by deleteFloor's route —
 *  without it the store keeps cards nobody can reach or see. */
export function deletePromptsForFloor(floorId) {
  const before = prompts.length
  prompts = prompts.filter((p) => p.floorId !== floorId)
  if (prompts.length !== before) persist('delete-floor', floorId)
  return before - prompts.length
}

/** One place the disk write is attempted, and one place its failure is
 *  reported. In memory the change stands either way: the caller has usually
 *  already acted on it, and reporting a failure would invite a retry that
 *  creates a second card. */
function persist(what, id) {
  try {
    saveStore()
  } catch (err) {
    console.error(`[prompts] could not persist ${what} for ${id}: ${err?.message || err}`)
  }
}
