// WORKFLOW RUNS - one RUN of a workflow: the father chat, the per-step
// sessions, and their status.
//
// This is the ONLY place a workflow step is bound to a real sessionId, which
// makes it also the index that answers the question the MCP layer needs to ask
// on every call: "this token belongs to session X - which run and which step is
// that?" The model is never asked to assert its own identity; it is derived
// from the token, so a session cannot claim to be a step it is not.
//
// A run SNAPSHOTS what it needs from the template at start (title, kind, ord,
// version). That is what makes "template edits never touch a live run" true in
// practice rather than by convention - a step deleted from the template still
// renders on the board of a run that is going.
//
// Store discipline is floors.js's, again: hydrate/repair on read, never throw,
// atomic tmp+rename, corrupt file rescued rather than silently emptied.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const RUNS_FILE = path.join(DATA_DIR, 'workflow-runs.json')

const RESULT_MAX = 20_000
const TITLE_MAX = 400

const RUN_STATUSES = new Set(['running', 'paused', 'done', 'cancelled'])
const STEP_STATUSES = new Set([
  'pending',
  'dispatched',
  // Hyphen, matching the CRM's goals.status exactly. V2 used 'in_progress'
  // until the CRM sync landed; a literal pass-through of the underscore is
  // rejected by GOAL_STATUSES, and translating at the boundary would leave two
  // spellings of one state to keep straight forever.
  'in-progress',
  // The CRM has 'review' and the user asked for it by name. Without it the two
  // boards disagree about a state that exists on one of them.
  'review',
  'done',
  'blocked',
  'skipped',
])

/** The old spelling, mapped forward on read so runs written before the CRM
 *  alignment keep working. Nothing writes 'in_progress' any more. */
const LEGACY_STEP_STATUS = { in_progress: 'in-progress' }

/** Statuses a step may be dispatched FROM without `force`. Re-dispatching a
 *  step that is already working, or already done, is nearly always a mistake
 *  the father made from a stale board - so it needs saying twice. */
const DISPATCHABLE_FROM = new Set(['pending', 'blocked'])

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* best effort */
  }
}

function str(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback
  return v.length > max ? v.slice(0, max) : v
}

function uuidish(v) {
  return typeof v === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(v) ? v : null
}

function sessionish(v) {
  return typeof v === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(v) ? v : null
}

function iso(v) {
  return typeof v === 'string' && v.length >= 8 ? v : null
}

// ---------------------------------------------------------------------------
// hydrate
// ---------------------------------------------------------------------------

function hydrateStep(s) {
  if (!s || typeof s !== 'object') return null
  const stepId = uuidish(s.stepId)
  if (!stepId) return null
  /* Map the pre-CRM spelling forward before validating, so a run written as
     'in_progress' reads back as 'in-progress' instead of silently resetting to
     'pending' — which would look like the step un-started itself. */
  const rawStatus = LEGACY_STEP_STATUS[s.status] ?? s.status
  const status = STEP_STATUSES.has(rawStatus) ? rawStatus : 'pending'
  return {
    stepId,
    title: str(s.title, TITLE_MAX, 'Untitled step') || 'Untitled step',
    ord: Number.isFinite(Number(s.ord)) ? Math.floor(Number(s.ord)) : 0,
    parentId: uuidish(s.parentId),
    kind: s.kind === 'stage' ? 'stage' : 'step',
    status,
    sessionId: sessionish(s.sessionId),
    briefPath: typeof s.briefPath === 'string' ? s.briefPath : null,
    dispatchedBy: sessionish(s.dispatchedBy),
    dispatchedAt: iso(s.dispatchedAt),
    startedAt: iso(s.startedAt),
    // A step marked done with no timestamp is repaired rather than left odd -
    // the board sorts by it.
    // doneAt is when the WORK finished (set at review), acceptedAt is when a
    // person signed it off. Keeping both is what lets "how long did the step
    // take" stay honest when a card sits in review over a weekend.
    doneAt:
      status === 'done' || status === 'review'
        ? (iso(s.doneAt) ?? new Date().toISOString())
        : iso(s.doneAt),
    acceptedAt: iso(s.acceptedAt),
    result: s.result === null || s.result === undefined ? null : str(s.result, RESULT_MAX),
    blockedReason:
      s.blockedReason === null || s.blockedReason === undefined
        ? null
        : str(s.blockedReason, 2000),
  }
}

/** A stage's status is ALWAYS derived, never stored authoritatively:
 *    done      every child done or skipped (and it has children)
 *    blocked   any child blocked
 *    in-progress  any child dispatched or working
 *    pending   otherwise
 *  This is the deliberate correction of the CRM's behaviour, where a container
 *  node counts toward the total but nobody can ever complete it, so a run can
 *  never reach 100%. */
function deriveStageStatuses(steps) {
  const kids = new Map()
  for (const s of steps) {
    if (!s.parentId) continue
    if (!kids.has(s.parentId)) kids.set(s.parentId, [])
    kids.get(s.parentId).push(s)
  }
  // Deepest first, so a stage of stages sees its children already derived.
  const byDepth = [...steps].sort((a, b) => b.ord - a.ord)
  for (const s of byDepth) {
    if (s.kind !== 'stage') continue
    const children = kids.get(s.stepId) ?? []
    if (children.length === 0) {
      s.status = 'skipped' // an empty stage has nothing to wait for
      continue
    }
    if (children.some((c) => c.status === 'blocked')) s.status = 'blocked'
    else if (children.every((c) => c.status === 'done' || c.status === 'skipped')) s.status = 'done'
    else if (children.some((c) => c.status === 'dispatched' || c.status === 'in-progress'))
      s.status = 'in-progress'
    else s.status = 'pending'
  }
  return steps
}

function hydrateRun(r) {
  if (!r || typeof r !== 'object') return null
  const id = uuidish(r.id)
  if (!id) return null
  const now = new Date().toISOString()
  const steps = deriveStageStatuses(
    (Array.isArray(r.steps) ? r.steps : [])
      .map(hydrateStep)
      .filter(Boolean)
      .sort((a, b) => a.ord - b.ord),
  )
  return {
    id, // ALSO the memory scope id -> server/data/memory/<id>.jsonl. Item 9.
    workflowId: uuidish(r.workflowId),
    workflowVersion: Number.isFinite(Number(r.workflowVersion)) ? Number(r.workflowVersion) : 1,
    groupId: uuidish(r.groupId),
    projectId: uuidish(r.projectId),
    name: str(r.name, TITLE_MAX, 'Untitled run') || 'Untitled run',
    status: RUN_STATUSES.has(r.status) ? r.status : 'running',
    fatherSessionId: sessionish(r.fatherSessionId),
    fatherBriefPath: typeof r.fatherBriefPath === 'string' ? r.fatherBriefPath : null,
    startedAt: iso(r.startedAt) ?? now,
    endedAt: iso(r.endedAt),
    steps,
  }
}

function coerce(list) {
  return (Array.isArray(list) ? list : []).map(hydrateRun).filter(Boolean)
}

function loadStore() {
  ensureDataDir()
  let raw
  try {
    raw = fs.readFileSync(RUNS_FILE, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.runs) ? parsed.runs : []
    return coerce(list)
  } catch (err) {
    const backup = `${RUNS_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(RUNS_FILE, backup)
      console.error(`workflow-runs.json is corrupt (${err?.message}); moved it to ${backup}`)
    } catch {
      /* ignore */
    }
    return []
  }
}

let runs = loadStore()

// ---------------------------------------------------------------------------
// derived index: sessionId -> {runId, stepId, role}
//
// Rebuilt on every mutation, never persisted. This is how the MCP layer answers
// "which workflow am I in?" from a token alone.
// ---------------------------------------------------------------------------

let bySession = new Map()

function reindex() {
  const next = new Map()
  for (const run of runs) {
    if (run.fatherSessionId) {
      next.set(run.fatherSessionId, { runId: run.id, stepId: null, role: 'father' })
    }
    for (const s of run.steps) {
      if (s.sessionId) next.set(s.sessionId, { runId: run.id, stepId: s.stepId, role: 'step' })
    }
  }
  bySession = next
}
reindex()

function saveStore() {
  ensureDataDir()
  const tmp = `${RUNS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ runs }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, RUNS_FILE)
  reindex()
}

function clone(r) {
  return { ...r, steps: r.steps.map((s) => ({ ...s })) }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function listRuns(filter = {}) {
  const { workflowId = null, groupId = null, status = null } = filter ?? {}
  return runs
    .filter(
      (r) =>
        (!workflowId || r.workflowId === workflowId) &&
        (!groupId || r.groupId === groupId) &&
        (!status || r.status === status),
    )
    .map(clone)
}

export function getRun(id) {
  const r = runs.find((x) => x.id === id)
  return r ? clone(r) : null
}

/** Which run and step a session belongs to, or null. Derived from the session
 *  id - never from anything the model said about itself. */
export function runContextForSession(sessionId) {
  const hit = bySession.get(sessionId)
  if (!hit) return null
  const run = runs.find((r) => r.id === hit.runId)
  if (!run) return null
  return {
    ...hit,
    run: clone(run),
    step: hit.stepId ? (run.steps.find((s) => s.stepId === hit.stepId) ?? null) : null,
  }
}

/** Every session id in a run - father first. The scope a run's memory and
 *  sibling visibility are built from. */
export function sessionIdsForRun(id) {
  const run = runs.find((r) => r.id === id)
  if (!run) return []
  const out = run.fatherSessionId ? [run.fatherSessionId] : []
  for (const s of run.steps) if (s.sessionId) out.push(s.sessionId)
  return out
}

/** The steps that could be dispatched right now: not a stage, not already
 *  working or finished, and with every dependency satisfied.
 *
 *  `dependsOn` lives on the TEMPLATE, so the caller passes it in rather than
 *  this store reaching across to workflows.js and coupling the two. */
export function readySteps(id, dependsOnByStepId = new Map()) {
  const run = runs.find((r) => r.id === id)
  if (!run) return []
  const status = new Map(run.steps.map((s) => [s.stepId, s.status]))
  return run.steps
    .filter((s) => s.kind !== 'stage' && DISPATCHABLE_FROM.has(s.status))
    .filter((s) => {
      const deps = dependsOnByStepId.get(s.stepId) ?? []
      return deps.every((d) => {
        const st = status.get(d)
        return st === undefined || st === 'done' || st === 'skipped'
      })
    })
    .map((s) => ({ ...s }))
}

/** Progress as ONE pair of numbers. Skipped steps stay in the denominator -
 *  the CRM shows "3/7" next to "80%" because its two counts disagree about
 *  whether skipped work counts, and that is a bug worth not copying. */
export function progressOf(run) {
  const workable = run.steps.filter((s) => s.kind !== 'stage')
  const done = workable.filter((s) => s.status === 'done' || s.status === 'skipped').length
  return { done, total: workable.length }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

/**
 * Create a run from a workflow, snapshotting the shape of its steps.
 * Sessions are attached later (createRun does not spawn anything).
 */
export function createRun({ workflow, projectId, groupId, name } = {}) {
  if (!workflow || !Array.isArray(workflow.steps)) {
    throw new Error('createRun: a workflow with steps is required')
  }
  const now = new Date().toISOString()
  const run = hydrateRun({
    id: randomUUID(),
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    groupId: groupId ?? workflow.groupId ?? null,
    projectId: projectId ?? null,
    name: workflow.name,
    status: 'running',
    fatherSessionId: null,
    startedAt: now,
    endedAt: null,
    steps: workflow.steps.map((s) => ({
      stepId: s.id,
      title: s.title,
      ord: s.ord,
      parentId: s.parentId,
      kind: s.kind,
      status: 'pending',
      sessionId: null,
      briefPath: null,
      dispatchedBy: null,
      dispatchedAt: null,
      startedAt: null,
      doneAt: null,
      result: null,
      blockedReason: null,
    })),
  })
  if (name) run.name = str(name, TITLE_MAX, run.name)
  runs = [run, ...runs]
  saveStore()
  return clone(run)
}

function mutate(runId, fn) {
  const i = runs.findIndex((r) => r.id === runId)
  if (i === -1) return null
  const next = { ...runs[i], steps: runs[i].steps.map((s) => ({ ...s })) }
  const ok = fn(next)
  if (ok === false) return null
  runs[i] = hydrateRun(next) // re-derives stage statuses on every write
  saveStore()
  return clone(runs[i])
}

export function setFatherSession(runId, sessionId, briefPath = null) {
  return mutate(runId, (run) => {
    run.fatherSessionId = sessionId
    run.fatherBriefPath = briefPath
  })
}

/** Bind a step to a session and mark it dispatched. `force` is required to
 *  re-dispatch a step that is already working or finished. */
export function dispatchStep(runId, stepId, { sessionId, briefPath, by = null, force = false } = {}) {
  let refused = null
  const out = mutate(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) {
      refused = 'No such step in this run'
      return false
    }
    if (step.kind === 'stage') {
      refused = 'A stage is never dispatched — dispatch the steps inside it'
      return false
    }
    if (!force && !DISPATCHABLE_FROM.has(step.status)) {
      refused = `Step is already ${step.status}; pass force to dispatch it again`
      return false
    }
    const now = new Date().toISOString()
    step.sessionId = sessionId ?? step.sessionId
    step.briefPath = briefPath ?? step.briefPath
    step.status = 'dispatched'
    step.dispatchedBy = by
    step.dispatchedAt = now
    step.blockedReason = null
  })
  if (out === null && refused) throw new Error(refused)
  return out
}

export function markStepStarted(runId, stepId) {
  return mutate(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step || step.status === 'done') return false
    step.status = 'in-progress'
    step.startedAt = step.startedAt ?? new Date().toISOString()
  })
}

/**
 * An AGENT reporting its step finished.
 *
 * This lands the step in 'review', NOT 'done'. The four states the CRM models —
 * todo, in-progress, review, done — exist precisely so that finishing and
 * accepting are different acts, and an agent that could mark its own work done
 * would collapse them: nobody would ever see the work before the board said it
 * was complete. 'done' is set by markStepAccepted, from a human.
 *
 * doneAt is still stamped here: it records when the WORK finished, which is the
 * number you want for how long a step took, not when someone got round to
 * approving it.
 */
export function markStepDone(runId, stepId, result = null) {
  return mutate(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) return false
    step.status = 'review'
    step.doneAt = new Date().toISOString()
    step.result = result === null ? step.result : str(result, RESULT_MAX)
    step.blockedReason = null
  })
}

/** A HUMAN accepting a step that an agent put up for review. The only path to
 *  'done', which is what keeps 'done' meaning "a person looked at this". */
export function markStepAccepted(runId, stepId) {
  return mutate(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) return false
    step.status = 'done'
    step.acceptedAt = new Date().toISOString()
    step.blockedReason = null
  })
}

export function markStepBlocked(runId, stepId, reason = '') {
  return mutate(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) return false
    step.status = 'blocked'
    step.blockedReason = str(reason, 2000)
  })
}

export function markStepSkipped(runId, stepId) {
  return mutate(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) return false
    step.status = 'skipped'
    step.doneAt = step.doneAt ?? new Date().toISOString()
  })
}

export function setRunStatus(runId, status) {
  if (!RUN_STATUSES.has(status)) throw new Error(`Unknown run status ${status}`)
  return mutate(runId, (run) => {
    run.status = status
    run.endedAt = status === 'done' || status === 'cancelled' ? new Date().toISOString() : null
  })
}

export function deleteRun(id) {
  const before = runs.length
  runs = runs.filter((r) => r.id !== id)
  if (runs.length === before) return false
  saveStore()
  return true
}

/** Test seam: re-read from disk. */
export function _reload() {
  runs = loadStore()
  reindex()
  return runs.length
}
