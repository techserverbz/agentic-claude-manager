import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * goals.js — a floor's own goals, and the sub-goals under them.
 *
 * THE POINT OF THIS FILE IS THAT IT WORKS WITH THE CRM SWITCHED OFF.
 *
 * The Goal Kanban already existed and read straight from the CRM, which made
 * every goal on this app conditional on another service being up, reachable and
 * logged in. That is a bad trade for a floor: the goals ARE the work, and a
 * floor with no goals visible is a floor you cannot plan. So goals live here,
 * on disk, and the CRM is something they can be SYNCED with rather than
 * something they are read from.
 *
 * A goal that has been synced remembers its `crmGoalId`. That single field is
 * what makes the sync idempotent — a goal with an id is updated, a goal without
 * one is created, and nothing is duplicated by pressing the button twice.
 *
 * Sub-goals are goals with a `parentId`. Not a separate record type: a sub-goal
 * gets a title, a status and an owner for the same reasons a goal does, and
 * modelling it as a lesser thing would mean rewriting all of that the first
 * time somebody wanted to assign one.
 */

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const STORE = path.join(DATA_DIR, 'goals.json')

/** Mirrors the CRM's own vocabulary so a sync is a copy, not a translation. */
export const GOAL_STATUSES = ['todo', 'in-progress', 'review', 'done', 'abandoned']
export const GOAL_PRIORITIES = ['low', 'medium', 'high', 'urgent']

const MAX_PER_FLOOR = 500
const TITLE_MAX = 300
const BODY_MAX = 10_000

let goals = []

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* the write below will report it */
  }
}

function clone(g) {
  return { ...g }
}

function hydrate(g) {
  if (!g || typeof g !== 'object') return null
  if (typeof g.id !== 'string' || typeof g.floorId !== 'string') return null
  const title = typeof g.title === 'string' ? g.title.trim().slice(0, TITLE_MAX) : ''
  if (!title) return null
  return {
    id: g.id,
    floorId: g.floorId,
    /* null = a top-level goal. A parent that no longer exists is repaired to
       null by repairParents() rather than dropped: losing the goal because its
       parent was deleted would be a worse answer than promoting it. */
    parentId: typeof g.parentId === 'string' && g.parentId ? g.parentId : null,
    title,
    description: typeof g.description === 'string' ? g.description.slice(0, BODY_MAX) : '',
    status: GOAL_STATUSES.includes(g.status) ? g.status : 'todo',
    priority: GOAL_PRIORITIES.includes(g.priority) ? g.priority : 'medium',
    servicePillar: typeof g.servicePillar === 'string' && g.servicePillar ? g.servicePillar : null,
    dueDate: typeof g.dueDate === 'string' && g.dueDate ? g.dueDate : null,
    /* who on the floor is carrying it — an agent NAME, because that is what the
       prompt board and the briefs already use to talk about people */
    agentName: typeof g.agentName === 'string' && g.agentName ? g.agentName : null,
    /* set once this goal exists in the CRM too; the whole sync turns on it */
    crmGoalId: typeof g.crmGoalId === 'string' && g.crmGoalId ? g.crmGoalId : null,
    syncedAt: typeof g.syncedAt === 'string' ? g.syncedAt : null,
    createdAt: typeof g.createdAt === 'string' ? g.createdAt : new Date().toISOString(),
    updatedAt: typeof g.updatedAt === 'string' ? g.updatedAt : new Date().toISOString(),
  }
}

/** A parent must exist, be on the same floor, and not be a sub-goal itself —
 *  one level of nesting, so a "sub-sub-goal" cannot quietly appear and break
 *  every renderer that assumes two levels. */
function repairParents(list) {
  const byId = new Map(list.map((g) => [g.id, g]))
  for (const g of list) {
    if (!g.parentId) continue
    const p = byId.get(g.parentId)
    if (!p || p.floorId !== g.floorId || p.parentId || p.id === g.id) g.parentId = null
  }
  return list
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE, 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.goals) ? parsed.goals : []
    goals = repairParents(list.map(hydrate).filter(Boolean))
  } catch (err) {
    if (err?.code === 'ENOENT') {
      goals = []
      return
    }
    /* Same rescue the other stores use: a file we cannot parse is renamed, not
       deleted and not silently emptied. Losing goals to a bad write is the one
       outcome worth spending a filename on. */
    try {
      const quarantine = `${STORE}.corrupt-${Date.now()}`
      fs.renameSync(STORE, quarantine)
      console.error(`[goals] could not parse the store; moved it to ${quarantine}`)
    } catch {
      console.error(`[goals] could not parse or move the store: ${err?.message}`)
    }
    goals = []
  }
}

function saveStore() {
  ensureDataDir()
  const tmp = `${STORE}.tmp`
  /* temp + rename: a crash mid-write leaves the previous file intact rather
     than a half-written one that loadStore would then quarantine. */
  fs.writeFileSync(tmp, JSON.stringify({ goals }, null, 2), 'utf8')
  fs.renameSync(tmp, STORE)
}

loadStore()

/** Every goal on one floor, parents first, each with its children attached. */
export function goalTree(floorId) {
  const mine = goals.filter((g) => g.floorId === floorId)
  const tops = mine.filter((g) => !g.parentId)
  const byParent = new Map()
  for (const g of mine) {
    if (!g.parentId) continue
    if (!byParent.has(g.parentId)) byParent.set(g.parentId, [])
    byParent.get(g.parentId).push(clone(g))
  }
  const byCreated = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  return tops.sort(byCreated).map((g) => ({
    ...clone(g),
    children: (byParent.get(g.id) ?? []).sort(byCreated),
  }))
}

export function listGoals(floorId) {
  return goals.filter((g) => g.floorId === floorId).map(clone)
}

export function getGoal(id) {
  const g = goals.find((x) => x.id === id)
  return g ? clone(g) : null
}

export function createGoal(floorId, input = {}) {
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, reason: 'A goal needs a title' }
  if (goals.filter((g) => g.floorId === floorId).length >= MAX_PER_FLOOR) {
    return { ok: false, reason: `This floor already has ${MAX_PER_FLOOR} goals, which is the limit.` }
  }
  let parentId = typeof input.parentId === 'string' && input.parentId ? input.parentId : null
  if (parentId) {
    const p = goals.find((g) => g.id === parentId)
    if (!p || p.floorId !== floorId) {
      return { ok: false, reason: 'That parent goal is not on this floor' }
    }
    /* one level only — see repairParents */
    if (p.parentId) return { ok: false, reason: 'A sub-goal cannot have sub-goals of its own' }
  }
  const now = new Date().toISOString()
  const goal = hydrate({
    id: crypto.randomUUID(),
    floorId,
    parentId,
    title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    servicePillar: input.servicePillar,
    dueDate: input.dueDate,
    agentName: input.agentName,
    crmGoalId: null,
    syncedAt: null,
    createdAt: now,
    updatedAt: now,
  })
  goals.push(goal)
  saveStore()
  return { ok: true, goal: clone(goal) }
}

export function updateGoal(id, patch = {}) {
  const g = goals.find((x) => x.id === id)
  if (!g) return { ok: false, reason: 'No such goal' }

  if (patch.title !== undefined) {
    const t = String(patch.title).trim()
    if (!t) return { ok: false, reason: 'A goal needs a title' }
    g.title = t.slice(0, TITLE_MAX)
  }
  if (patch.description !== undefined) g.description = String(patch.description).slice(0, BODY_MAX)
  if (patch.status !== undefined) {
    if (!GOAL_STATUSES.includes(patch.status)) return { ok: false, reason: 'Unknown status' }
    g.status = patch.status
  }
  if (patch.priority !== undefined) {
    if (!GOAL_PRIORITIES.includes(patch.priority)) return { ok: false, reason: 'Unknown priority' }
    g.priority = patch.priority
  }
  /* `!== undefined` throughout, so clearing a field is possible. A truthy test
     would make "no due date" unsayable once one had been set. */
  if (patch.servicePillar !== undefined) g.servicePillar = patch.servicePillar || null
  if (patch.dueDate !== undefined) g.dueDate = patch.dueDate || null
  if (patch.agentName !== undefined) g.agentName = patch.agentName || null
  if (patch.crmGoalId !== undefined) g.crmGoalId = patch.crmGoalId || null
  if (patch.syncedAt !== undefined) g.syncedAt = patch.syncedAt || null

  g.updatedAt = new Date().toISOString()
  saveStore()
  return { ok: true, goal: clone(g) }
}

/** Deleting a parent takes its sub-goals with it — they describe a piece of the
 *  parent, so leaving them behind as orphans would be keeping a sentence with
 *  its subject removed. */
export function deleteGoal(id) {
  const g = goals.find((x) => x.id === id)
  if (!g) return { ok: false, reason: 'No such goal' }
  const doomed = new Set([id, ...goals.filter((x) => x.parentId === id).map((x) => x.id)])
  goals = goals.filter((x) => !doomed.has(x.id))
  saveStore()
  return { ok: true, removed: [...doomed] }
}

export function deleteGoalsForFloor(floorId) {
  const before = goals.length
  goals = goals.filter((g) => g.floorId !== floorId)
  if (goals.length !== before) saveStore()
  return before - goals.length
}

/** Adopt a CRM goal into this floor, or update the local copy of one we already
 *  hold. Keyed on crmGoalId, which is what stops a pull creating duplicates of
 *  goals we pushed a moment earlier. */
export function upsertFromCrm(floorId, crmGoal) {
  const crmId = String(crmGoal?.id ?? '')
  if (!crmId) return null
  const existing = goals.find((g) => g.floorId === floorId && g.crmGoalId === crmId)
  const now = new Date().toISOString()
  if (existing) {
    existing.title = String(crmGoal.title ?? existing.title).slice(0, TITLE_MAX)
    if (GOAL_STATUSES.includes(crmGoal.status)) existing.status = crmGoal.status
    if (GOAL_PRIORITIES.includes(crmGoal.priority)) existing.priority = crmGoal.priority
    if (typeof crmGoal.description === 'string') existing.description = crmGoal.description.slice(0, BODY_MAX)
    existing.syncedAt = now
    existing.updatedAt = now
    return clone(existing)
  }
  const goal = hydrate({
    id: crypto.randomUUID(),
    floorId,
    parentId: null,
    title: crmGoal.title,
    description: crmGoal.description,
    status: crmGoal.status,
    priority: crmGoal.priority,
    servicePillar: crmGoal.servicePillar,
    dueDate: crmGoal.dueDate,
    crmGoalId: crmId,
    syncedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  if (!goal) return null
  goals.push(goal)
  return clone(goal)
}

/** Called once after a batch of upserts, so a pull is one write not fifty. */
export function persist() {
  saveStore()
}
