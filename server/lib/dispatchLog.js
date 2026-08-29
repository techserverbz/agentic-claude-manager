// DISPATCH LOG — the append-only record of who gave work to whom (plan item 12).
//
// The run record already carries `dispatchedBy` on every step, and that field
// is NOT this. It is current state: it says who most recently dispatched a step
// and it is overwritten the next time anyone dispatches it again. It cannot say
// that step 1 messaged step 3 directly, that step 3 reported back, or the ORDER
// any of it happened in — so a run that was dispatched, blocked, re-dispatched
// by a peer and finally finished is indistinguishable from one the father drove
// straight through. This file is the history that tells those two apart.
//
// Every edge is written SERVER-SIDE from the DERIVED identity of the caller (the
// token -> runs index path, never a `from` in a request body). That is the whole
// reason the tree is evidence rather than decoration: a session cannot write an
// edge claiming somebody else gave the order.
//
// Store shape: one JSONL per run under server/data/dispatch/<runId>.jsonl —
// per-run rather than one global log, so it stays small and is deleted with its
// run. Discipline is memory.js's, deliberately: strict id charset before the
// path is built, appends that survive a crash, a tolerant line-by-line parse
// that skips a torn last line instead of taking the whole log down with it.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DISPATCH_DIR = path.join(SERVER_ROOT, 'data', 'dispatch')

// Bounds. The text is the message body a model wrote, so it is capped for the
// same reason memory.js caps its entries: nothing model-authored grows a file
// without a ceiling.
const MAX_TEXT_LENGTH = 2000
const MAX_SESSION_ID_LENGTH = 64
const MAX_RESULTS = 5000
const DEFAULT_LIMIT = 500

/** The closed set of things that can move work. Anything else is a programming
 *  mistake at the call site, and is refused rather than coerced — the frontend
 *  types this as an exhaustive union, and one stray kind written today is a
 *  label nobody can render for the life of the file. */
const KINDS = new Set([
  'dispatch', // somebody spawned or woke a step's session
  'message', // one run member typed into another's terminal
  'broadcast', // one run member typed into every sibling at once
  'report', // a step told the father it had finished
  'block', // a step told the father it could not finish
  'note', // a step left a progress note for the run
  'spawn', // the server started the father of a run
  'complete', // reserved: a run reaching its end
])

// runId comes from the validated run store (UUIDs), but a path segment is never
// trusted on its word — strict charset BEFORE it is joined onto a directory, so
// a traversal attempt is rejected without touching the filesystem at all.
const RUN_ID_RE = /^[0-9a-fA-F-]{1,64}$/

function fileFor(runId) {
  if (!RUN_ID_RE.test(String(runId))) return null
  return path.join(DISPATCH_DIR, `${runId}.jsonl`)
}

function ensureDir() {
  try {
    fs.mkdirSync(DISPATCH_DIR, { recursive: true })
  } catch {
    /* best effort; the append below swallows what this could not fix */
  }
}

/** A session id, or null for "the human, or the server itself".
 *  Deliberately loose: an over-strict regex that rejected an unfamiliar id
 *  would silently rewrite it to null, and null MEANS the human — misattributing
 *  a model's order to a person is worse than storing an id we cannot parse. */
function sessionish(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, MAX_SESSION_ID_LENGTH)
}

/**
 * Does the log already end on a line boundary?
 *
 * Closes the ONE trap a naive JSONL append still has after a crash. A torn write
 * leaves a fragment with no trailing newline; the next append then lands on the
 * SAME line, and the tolerant parser drops both — so a crash costs not just the
 * half-written edge but the next good one after it. A one-byte read before each
 * append buys a leading newline exactly when it is needed, and this log writes a
 * handful of lines a minute, not thousands a second.
 *
 * Answers true when it cannot tell (no file, unreadable): the plain append is
 * the right move in both of those cases.
 */
function endsOnNewline(file) {
  let fd
  try {
    const size = fs.statSync(file).size
    if (size === 0) return true
    fd = fs.openSync(file, 'r')
    const tail = Buffer.alloc(1)
    fs.readSync(fd, tail, 0, 1, size - 1)
    return tail[0] === 0x0a
  } catch {
    return true
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing left to do about it */
      }
    }
  }
}

/**
 * Append one edge to a run's dispatch log.
 *
 * BEST EFFORT AND SILENT. Every call site is a real operation — a dispatch, a
 * relayed message, a step reporting done — and a run whose log cannot be written
 * must still run. So nothing here throws: a bad id, a full disk or a read-only
 * data directory costs the log line and nothing else.
 *
 * @param {string} runId
 * @param {{ kind: string, fromSessionId?: string|null, toSessionId?: string|null,
 *           stepId?: string|null, text?: string, meta?: object }} edge
 * @returns {void}
 */
export function appendEdge(runId, edge) {
  try {
    const file = fileFor(runId)
    if (!file) {
      console.error(`[dispatch] refusing to log against an invalid runId: ${String(runId)}`)
      return
    }
    const body = edge && typeof edge === 'object' ? edge : {}
    const kind = typeof body.kind === 'string' ? body.kind : ''
    if (!KINDS.has(kind)) {
      console.error(`[dispatch] refusing to log unknown edge kind "${kind}" on run ${runId}`)
      return
    }
    const row = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind,
      fromSessionId: sessionish(body.fromSessionId),
      toSessionId: sessionish(body.toSessionId),
      stepId: sessionish(body.stepId),
      text: typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_LENGTH) : '',
      meta: body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : {},
    }
    ensureDir()
    // One write of one line ending in \n. A crash mid-write costs the tail of
    // that single line, which readEdges skips — it can never corrupt a line that
    // was already on disk, which is the whole argument for JSONL over a JSON
    // array that has to be rewritten whole on every event.
    const heal = endsOnNewline(file) ? '' : '\n'
    fs.appendFileSync(file, heal + JSON.stringify(row) + '\n', 'utf8')
  } catch (err) {
    console.error(`[dispatch] could not log an edge on run ${runId}: ${err?.message || err}`)
  }
}

/**
 * Read a run's edges, OLDEST FIRST.
 *
 * Never throws. A run with no log yet is not an error — it is a run in which
 * nothing has moved, and it answers [].
 *
 * @param {string} runId
 * @param {number} [limit] how many of the MOST RECENT edges to return; they are
 *   still handed back in chronological order, because the question this answers
 *   ("who gave work to whom, and then what") only reads forwards.
 * @returns {Array<object>}
 */
export function readEdges(runId, limit = DEFAULT_LIMIT) {
  const file = fileFor(runId)
  if (!file) return []
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return [] // nothing has moved in this run yet
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed)
      // A row is only an edge if it has an id and a kind we can label. Anything
      // else is a torn write or a hand-edit, and is dropped rather than handed
      // to a UI that would render it as an unlabelled arrow.
      if (row && typeof row === 'object' && typeof row.id === 'string' && KINDS.has(row.kind)) {
        out.push(row)
      }
    } catch {
      /* torn line — skip it, never fail the read */
    }
  }
  const cap = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_RESULTS))
  return out.length > cap ? out.slice(-cap) : out
}

/**
 * Delete a run's log. Called when the run itself is deleted — the log is
 * meaningless without the run, and leaving it behind is how server/data fills
 * with files nobody can trace back to anything.
 * @returns {void}
 */
export function deleteLog(runId) {
  try {
    const file = fileFor(runId)
    if (!file) return
    fs.rmSync(file, { force: true })
  } catch (err) {
    console.error(`[dispatch] could not delete the log for run ${runId}: ${err?.message || err}`)
  }
}
