// Shared PROJECT MEMORY — the persisted half of cross-chat context sharing.
//
// Model (distilled from claude-os's KB and claude-flow's .swarm/memory.db):
// every chat in a project reads AND writes the same store, so what one chat
// saves ("we decided X", "the bug was Y") any sibling chat can search later.
// Unlike a static CLAUDE.md (same INPUT loaded by every chat), this is a
// runtime read+write channel — the thing that makes chats actually share.
//
// Implementation: one append-only JSONL file per project under
// server/data/memory/<projectId>.jsonl — zero native deps (no sqlite, no
// embeddings), crash-safe appends, tolerant line-by-line parsing (same
// pattern as projects.js). Search is case-insensitive keyword scoring,
// which is plenty for a single-user local store of hundreds of notes.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEMORY_DIR = path.join(SERVER_ROOT, 'data', 'memory')

// Bounds: keep single entries and reads sane.
const MAX_TEXT_LENGTH = 4000
const MAX_TAGS = 8
const MAX_RESULTS = 50

// projectId comes from the validated project store (UUIDs), but never trust a
// path segment — strict charset before it touches the filesystem.
const PROJECT_ID_RE = /^[0-9a-fA-F-]{1,64}$/

function fileFor(projectId) {
  if (!PROJECT_ID_RE.test(String(projectId))) return null
  return path.join(MEMORY_DIR, `${projectId}.jsonl`)
}

/** Absolute path of a project's shared-memory file (null if id is invalid). */
export function memoryFilePath(projectId) {
  return fileFor(projectId)
}

/** Ensure the project's memory file exists on disk (so it can be opened/revealed
 *  even before the first note is saved); returns the path. */
export function ensureMemoryFile(projectId) {
  const file = fileFor(projectId)
  if (!file) throw new Error('invalid projectId')
  ensureDir()
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
  return file
}

/** Delete a scope's memory file. A run owns its own store (the run tier in
 *  resolveScope writes to server/data/memory/<runId>.jsonl), so deleting the run
 *  without this leaves a file nobody can trace back to anything — which is
 *  exactly the state server/data/memory was in before this existed. Best effort:
 *  a store that will not delete must never fail the delete of the run itself. */
export function deleteMemoryFile(scopeId) {
  const file = fileFor(scopeId)
  if (!file) return false
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch (err) {
    console.error(`[memory] could not delete the store for ${scopeId}: ${err?.message || err}`)
    return false
  }
}

function ensureDir() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
  } catch {
    /* best effort; the write will surface real errors */
  }
}

/** Parse a JSONL buffer tolerantly (torn/partial lines skipped). */
function parseLines(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed)
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') out.push(entry)
    } catch {
      /* skip torn line */
    }
  }
  return out
}

async function readAll(projectId) {
  const file = fileFor(projectId)
  if (!file) return []
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return [] // no memory yet
  }
  return parseLines(text)
}

/**
 * Save one memory entry to the project's shared store.
 * @param {string} projectId
 * @param {{ text: string, tags?: string[], sessionId?: string|null }} input
 * @returns {Promise<object>} the persisted entry
 */
export async function saveMemory(projectId, input) {
  const file = fileFor(projectId)
  if (!file) throw new Error('invalid projectId')
  const body = input && typeof input === 'object' ? input : {}
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new Error('text is required')
  const tags = Array.isArray(body.tags)
    ? body.tags
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().toLowerCase().slice(0, 40))
        .slice(0, MAX_TAGS)
    : []
  const entry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    sessionId:
      typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null,
    /* WHO wrote this — 'human' when a person typed it in the app, 'agent'
       otherwise. A closed pair, not free text: it is displayed as provenance,
       and provenance a caller can spell however it likes is not provenance.
       Absent on every note written before this field existed, which reads back
       as 'agent' — true of all of them, since only chats could write until now. */
    author: body.author === 'human' ? 'human' : 'agent',
    /* The agent's NAME, resolved when the note was written. sessionId alone was
       not enough: an agent is re-bound to a fresh chat whenever its old one
       cannot be resumed, so a note six restarts old could no longer be traced
       to whoever wrote it and read as 'Another chat'. The name is what a person
       actually wants to see, and it does not move. */
    authorName: typeof body.authorName === 'string' && body.authorName.trim()
      ? body.authorName.trim().slice(0, 60)
      : null,
    tags,
    text: text.slice(0, MAX_TEXT_LENGTH),
  }
  ensureDir()
  await fsp.appendFile(file, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

/**
 * Rewrite the whole store. The ONLY non-append write path.
 *
 * Appending is what makes this store crash-safe, so editing and deleting are
 * kept to one place and done atomically: build the new file beside the old one
 * and rename over it, so a crash mid-write leaves the previous store intact
 * rather than a half-written one. Same discipline as floors.js and prompts.js.
 */
async function rewriteAll(scopeId, entries) {
  const file = fileFor(scopeId)
  if (!file) throw new Error('invalid scope id')
  ensureDir()
  const tmp = `${file}.tmp`
  const body = entries.map((e) => JSON.stringify(e)).join('\n')
  await fsp.writeFile(tmp, body ? body + '\n' : '', 'utf8')
  await fsp.rename(tmp, file)
}

/** Change a note's text. Keeps its id, its timestamp and — deliberately — its
 *  AUTHOR: an agent's note stays that agent's note after you correct a typo in
 *  it, because who learned the thing is a fact about the past. `editedAt`
 *  records that it was touched, so a note that no longer matches what the agent
 *  actually wrote can be told apart from one that does. */
export async function updateMemory(scopeId, id, text) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) throw new Error('a note needs some text')
  const entries = await readAll(scopeId)
  const i = entries.findIndex((e) => e.id === id)
  if (i === -1) return null
  const next = { ...entries[i], text: t.slice(0, MAX_TEXT_LENGTH), editedAt: new Date().toISOString() }
  entries[i] = next
  await rewriteAll(scopeId, entries)
  return next
}

/** Remove a note. Gone, not disabled: this store is a notebook, not a record —
 *  a wrong note that agents keep finding is worse than no note. */
export async function deleteMemory(scopeId, id) {
  const entries = await readAll(scopeId)
  const kept = entries.filter((e) => e.id !== id)
  if (kept.length === entries.length) return false
  await rewriteAll(scopeId, kept)
  return true
}

/**
 * Keyword search across the project's shared memory.
 * Scores by per-term hits in text+tags; ties broken newest-first.
 * @param {string} projectId
 * @param {string} query
 * @param {number} [limit]
 */
export async function searchMemory(projectId, query, limit = 10) {
  const entries = await readAll(projectId)
  const q = String(query ?? '').trim().toLowerCase()
  const cap = Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS))
  if (!q) return entries.slice(-cap).reverse()
  const terms = q.split(/\s+/).filter(Boolean)
  const scored = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const haystack = `${entry.text} ${(entry.tags || []).join(' ')}`.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (haystack.includes(term)) score += 1
    }
    // exact-phrase bonus so multi-word queries rank tight matches first
    if (terms.length > 1 && haystack.includes(q)) score += terms.length
    if (score > 0) scored.push({ entry, score, i })
  }
  scored.sort((a, b) => b.score - a.score || b.i - a.i)
  return scored.slice(0, cap).map((s) => s.entry)
}

/**
 * The most recent entries (newest first) — "what has this project learned lately".
 * @param {string} projectId
 * @param {number} [limit]
 */
export async function recentMemory(projectId, limit = 10) {
  const entries = await readAll(projectId)
  const cap = Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS))
  return entries.slice(-cap).reverse()
}
