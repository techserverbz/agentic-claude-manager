// FLOORS — an org chart of agent ROLES, in the Munder Difflin sense: a boss at
// the top, workers reporting to it, and a markdown brief (the agent's `.md`)
// carried on every node. A floor is a BLUEPRINT, not a set of live processes:
// you design who reports to whom and what each one is for, and later spawn real
// sessions from it. That is why nothing here touches node-pty or a session id.
//
// Persisted on THIS computer in server/data/floors.json (same reasoning as
// views.js: survives a cache clear, lives beside the projects) with an atomic
// temp+rename write so a crash mid-save cannot truncate the store.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const FLOORS_FILE = path.join(DATA_DIR, 'floors.json')

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* best effort */
  }
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// The models a spawned session may be pinned to. A closed set on purpose: this
// value becomes a --model flag on a real command line, so an arbitrary string
// would be both a spawn failure and an injection surface.
const MODELS = new Set(['opus', 'sonnet', 'haiku'])

// The shape of a session id we are willing to hand back to a spawn. Restated
// here rather than imported for the same reason MODELS is: this value ends up
// on a real command line (ensureSession interpolates it into --session-id), so
// the allow-list has to be enforced where the value is STORED and not left to
// whoever happened to write it. Same charset briefs.js gates its filenames on.
/** how much floor preamble is worth carrying in front of every instruction */
const GLOBAL_PROMPT_MAX = 8000

const SESSION_ID_RE = /^[0-9a-zA-Z-]{8,64}$/

/** de-duped list of plain names, bounded — these come from a client */
function strList(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.trim()
    if (t && t.length <= 200 && !out.includes(t)) out.push(t)
    if (out.length >= 50) break
  }
  return out
}

/** one node on the floor — a role, not a running process */
function hydrateAgent(a, i) {
  if (!a || typeof a !== 'object') return null
  if (typeof a.id !== 'string' || !a.id) return null
  return {
    id: a.id,
    name: typeof a.name === 'string' && a.name.trim() ? a.name : 'Untitled',
    role: typeof a.role === 'string' ? a.role : '',
    isBoss: a.isBoss === true,
    // who this reports to; null = top of the chart. Cycles are broken on read.
    reportsTo: typeof a.reportsTo === 'string' && a.reportsTo ? a.reportsTo : null,
    md: typeof a.md === 'string' ? a.md : '',
    // The CRM person this agent IS the AI for. Optional and null by default, so
    // every floor written before the CRM link loads unchanged. This one field is
    // what makes "each user has an AI" real: the CRM's own goal assignment then
    // picks which person's agent does the work, with no second roster to keep.
    crmUserId: /^[0-9a-fA-F-]{8,64}$/.test(String(a.crmUserId ?? '')) ? String(a.crmUserId) : null,
    // The chat this agent is bound to — the ONE field on a floor that points at
    // something live. Absent on every floor written before agent chats existed,
    // which is why it defaults to null ("no chat yet") and an old floors.json
    // loads exactly as it did. Anything that is not a plausible session id is
    // read as unbound rather than kept: see SESSION_ID_RE above.
    sessionId: SESSION_ID_RE.test(String(a.sessionId ?? '')) ? a.sessionId : null,
    // What the agent is EQUIPPED with. All three are absent on every floor
    // written before this existed, so each defaults to "inherit whatever the
    // session would have used anyway" rather than to a guess.
    //
    // model: '' means do not pass --model at all and let the CLI pick. Storing
    // a concrete default here would silently pin every existing agent to
    // whatever was current on the day this shipped.
    model: MODELS.has(a.model) ? a.model : '',
    // Names, not objects: skills and MCP servers are discovered from disk on
    // every request (the user edits them outside this app), so storing a copy
    // would go stale. A name that no longer resolves is dropped at read.
    skills: strList(a.skills),
    mcpServers: strList(a.mcpServers),
    x: num(a.x, 40 + (i % 3) * 260),
    y: num(a.y, 40 + Math.floor(i / 3) * 200),
  }
}

/** Drop reportsTo links that point nowhere, at self, or form a cycle. A cycle
 *  would make the chart unrenderable, and it is cheaper to repair on read than
 *  to trust every client that ever writes here. */
function repairLinks(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  for (const a of agents) {
    if (a.reportsTo === a.id || (a.reportsTo && !byId.has(a.reportsTo))) a.reportsTo = null
  }
  for (const a of agents) {
    const seen = new Set([a.id])
    let cur = a.reportsTo
    while (cur) {
      if (seen.has(cur)) {
        a.reportsTo = null // cycle — cut it at the node we came in on
        break
      }
      seen.add(cur)
      cur = byId.get(cur)?.reportsTo ?? null
    }
  }
  return agents
}

function hydrateFloor(f) {
  if (!f || typeof f !== 'object') return null
  if (typeof f.id !== 'string' || typeof f.name !== 'string') return null
  const agents = repairLinks((Array.isArray(f.agents) ? f.agents : []).map(hydrateAgent).filter(Boolean))
  return {
    id: f.id,
    name: f.name,
    // Which canvas this floor belongs to. Two separate charts, one store: the
    // designer, the repair rules and the persistence are identical, so a second
    // store would be the same code twice and a second place to fix a bug.
    // Anything but the literal 'workflow' is 'agents', so every floor written
    // before this split stays exactly where the user left it.
    kind: f.kind === 'workflow' ? 'workflow' : 'agents',
    // What this floor is working ON, in the CRM's own terms. targetType mirrors
    // goals.target_type exactly ('organization' = general/org-wide, and then
    // targetId is null). null crmScope = attached to nothing, which is the
    // state every floor written before this loads in.
    crmScope:
      f.crmScope && typeof f.crmScope === 'object' &&
      ['mine', 'organization', 'service', 'project'].includes(f.crmScope.targetType)
        ? {
            targetType: f.crmScope.targetType,
            targetId:
              f.crmScope.targetType === 'organization' || f.crmScope.targetType === 'mine'
                ? null
                : (/^[0-9a-fA-F-]{8,64}$/.test(String(f.crmScope.targetId ?? ''))
                    ? String(f.crmScope.targetId)
                    : null),
          }
        : null,
    /* THE FLOOR PREAMBLE — what every agent on this floor is told before
       anything else, and the place to say WHICH CODEBASE they work in.
       Capped well below an agent brief (20k): this rides in front of every
       instruction to every agent, so its length is paid many times over.
       Clamped HERE, not only at the route, so no write path can store more. */
    globalPrompt:
      typeof f.globalPrompt === 'string' ? f.globalPrompt.slice(0, GLOBAL_PROMPT_MAX) : '',
    /* THE WORKSPACE. The project this floor's chats run in — which is two
       facts at once: the directory the work is IN (the project's fileDir,
       the pty's cwd) and the .claude folder the CLI reads its settings and
       HOOKS from (the project's claudeDir, passed as CLAUDE_CONFIG_DIR).

       null means "whatever project the caller happened to be in", which is
       how every floor behaved before this and is why a CRM agent could be
       started inside the orchestrator's own folder. */
    workspaceProjectId:
      typeof f.workspaceProjectId === 'string' && f.workspaceProjectId ? f.workspaceProjectId : null,
    createdAt: typeof f.createdAt === 'string' ? f.createdAt : new Date().toISOString(),
    updatedAt: typeof f.updatedAt === 'string' ? f.updatedAt : new Date().toISOString(),
    agents,
  }
}

function coerce(list) {
  return (Array.isArray(list) ? list : []).map(hydrateFloor).filter(Boolean)
}

function loadStore() {
  ensureDataDir()
  let raw
  try {
    raw = fs.readFileSync(FLOORS_FILE, 'utf8')
  } catch {
    return [] // no store yet — first run
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.floors) ? parsed.floors : []
    return coerce(list)
  } catch (err) {
    // Same discipline as projects.js: keep the bad file instead of silently
    // returning [] and letting the next save erase every floor.
    const backup = `${FLOORS_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(FLOORS_FILE, backup)
      console.error(`floors.json is corrupt (${err?.message}); moved it to ${backup}`)
    } catch {
      /* ignore */
    }
    return []
  }
}

let floors = loadStore()

function saveStore() {
  ensureDataDir()
  const tmp = `${FLOORS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ floors }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FLOORS_FILE)
}

function clone(f) {
  // The equipment arrays are copied, not aliased: a caller mutating what
  // listFloors() handed back would otherwise reach into the store.
  return {
    ...f,
    // Defensive spread: hydrate fills these, but clone() is on the READ path and
    // a read must never throw — that is the whole discipline of this file.
    agents: f.agents.map((a) => ({
      ...a,
      skills: [...(a.skills ?? [])],
      mcpServers: [...(a.mcpServers ?? [])],
    })),
  }
}

export function listFloors(kind = null) {
  return floors.filter((f) => !kind || f.kind === kind).map(clone)
}

export function getFloor(id) {
  const f = floors.find((x) => x.id === id)
  return f ? clone(f) : null
}

/** A new floor starts with its boss already seated — an empty canvas gives you
 *  nothing to attach the first report to, and every floor has exactly one top. */
export function createFloor(name, kind = 'agents') {
  const now = new Date().toISOString()
  const bossId = randomUUID()
  const floor = {
    id: randomUUID(),
    name: typeof name === 'string' && name.trim() ? name.trim() : 'New floor',
    kind: kind === 'workflow' ? 'workflow' : 'agents',
    createdAt: now,
    updatedAt: now,
    // Explicitly null, not absent. setFloorScope treats "already attached" as
    // "crmScope is set", and an undefined field is not null — leaving it out
    // made every brand-new floor refuse its FIRST attachment. Exactly the trap
    // the note below describes, one field further along.
    crmScope: null,
    // Same reason as crmScope above: createFloor writes a bare literal, so a
    // field only added to hydrateFloor would be absent until the first save.
    globalPrompt: '',
    // Same bare-literal trap as crmScope and globalPrompt above.
    workspaceProjectId: null,
    // Built through hydrateAgent, NOT as a bare literal. A literal has to be
    // remembered every time a field is added to an agent, and the first thing
    // that forgot was this one: clone() spread `[...a.skills]` on a boss that
    // had no skills array and every read of the store threw.
    agents: [
      hydrateAgent({
        id: bossId,
        name: 'Michael',
        role: 'Orchestrator',
        isBoss: true,
        reportsTo: null,
        md:
          '# Michael\n\n' +
          'The boss of this floor. Runs the work, does not do the work.\n\n' +
          '- Keeps an accurate picture of every agent and what they are on.\n' +
          '- Decomposes incoming work and hands it to the right owner.\n' +
          '- Owns only the high-leverage calls: sign-offs, conflicts, integration.\n' +
          '- Escalates to the human only for spend, destructive actions, or scope changes.\n',
        x: 320,
        y: 40,
      }, 0),
    ],
  }
  floors = [floor, ...floors]
  saveStore()
  return clone(floor)
}

/** Carry each agent's chat binding across a whole-array replace.
 *
 *  The client owns the canvas, but it does not own the binding: sessionId is
 *  written by the SERVER when a chat is opened for an agent, and a designer
 *  that fetched the floor before that happened would post the node back without
 *  it. Dropping it here would silently unbind a live chat, and the next click
 *  on that node would spawn a SECOND claude for the same agent. An incoming
 *  sessionId still wins, so a client that does track the field is unaffected. */
function keepSessions(next, prev) {
  const before = new Map(prev.map((a) => [a.id, a.sessionId ?? null]))
  for (const a of next) {
    if (!a.sessionId) a.sessionId = before.get(a.id) ?? null
  }
  return next
}

/** Patch a floor. `agents` is a whole-array replace — the client owns the
 *  canvas, the server validates and repairs it. */
export function updateFloor(id, patch) {
  const i = floors.findIndex((f) => f.id === id)
  if (i === -1) return null
  const cur = floors[i]
  const next = {
    ...cur,
    name:
      typeof patch?.name === 'string' && patch.name.trim() ? patch.name.trim() : cur.name,
    /* WRITE-ONCE. A floor is attached to one project, service, or "my tasks",
       and after that it is fixed.
       Enforced here rather than in the UI because it is a rule about the data,
       not about a screen: agents are briefed on the board their floor is
       attached to, so silently re-pointing it would leave every running session
       working a list nobody can see any more. Changing it means a new floor.
       The store IGNORES the change rather than throwing — updateFloor also
       carries agent edits, and a rejected re-attach must not take an unrelated
       canvas edit down with it. setFloorScope() is the checked path. */
    crmScope:
      cur.crmScope == null && patch?.crmScope !== undefined
        ? hydrateFloor({ ...cur, crmScope: patch.crmScope }).crmScope
        : cur.crmScope,
    /* `!== undefined`, not a truthy test: the floor NAME uses truthy-trim
       above, which quietly makes blanking impossible. A preamble must be
       clearable — an out-of-date working directory is worse than none. */
    /* Not write-once, unlike crmScope: a floor can be re-pointed at a
       different checkout, and refusing that would mean rebuilding the floor
       every time a codebase moves. Clearing it is allowed too — null just
       returns the floor to the old "use the caller's project" behaviour. */
    workspaceProjectId:
      patch?.workspaceProjectId !== undefined
        ? (typeof patch.workspaceProjectId === 'string' && patch.workspaceProjectId
            ? patch.workspaceProjectId
            : null)
        : cur.workspaceProjectId,
    globalPrompt:
      patch?.globalPrompt !== undefined
        ? String(patch.globalPrompt).slice(0, GLOBAL_PROMPT_MAX)
        : cur.globalPrompt,
    agents: Array.isArray(patch?.agents)
      ? keepSessions(repairLinks(patch.agents.map(hydrateAgent).filter(Boolean)), cur.agents)
      : cur.agents,
    updatedAt: new Date().toISOString(),
  }
  floors[i] = next
  saveStore()
  return clone(next)
}

export function deleteFloor(id) {
  const before = floors.length
  floors = floors.filter((f) => f.id !== id)
  if (floors.length === before) return false
  saveStore()
  return true
}

/** Bind an agent to the chat that was opened for it (null unbinds).
 *
 *  Returns the updated agent, or null when the floor or the agent is gone —
 *  which is also how a caller learns the node was deleted while its session was
 *  starting. Never throws: by the time this is called a real claude process is
 *  already running, and a store that cannot write must not be reported to the
 *  caller as a failed spawn — it would retry and start a second one. That is
 *  the one place this file guards saveStore(), and this is why: updateFloor's
 *  caller can retry harmlessly, this one cannot. */
/** The floor an agent chat belongs to, found by that chat's session id.
 *
 *  This is the reverse of setAgentSession: a live session knows its own id but
 *  nothing about the floor it was spawned from, and the roster it wants to read
 *  is keyed the other way round. Returns { floor, agent } or null when the
 *  session is not an agent chat at all (an ordinary terminal, say). */
export function findFloorBySession(sessionId) {
  const sid = String(sessionId || '')
  if (!sid) return null
  for (const floor of floors) {
    const agent = floor.agents.find((a) => a.sessionId === sid)
    if (agent) return { floor: clone(floor), agent: { ...agent } }
  }
  return null
}

/**
 * Attach a floor to a CRM scope. Write-once: succeeds only while the floor is
 * unattached.
 *
 * Returns { ok: true, floor } or { ok: false, reason } so the caller can say WHY
 * rather than reporting a silent no-op as success — the difference between "your
 * change was saved" and "this floor was already attached to something else" is
 * the whole point of the rule.
 */
export function setFloorScope(floorId, crmScope) {
  const floor = floors.find((f) => f.id === floorId)
  if (!floor) return { ok: false, reason: 'No such floor' }
  /* Loose null check on purpose: a floor written before crmScope existed has
     the field ABSENT, and treating undefined as "already attached" would lock
     every older floor out of ever being attached. */
  if (floor.crmScope != null) {
    return {
      ok: false,
      reason:
        'This floor is already attached, and an attachment cannot be changed. Create a new floor for different work.',
      floor: clone(floor),
    }
  }
  const next = hydrateFloor({ ...floor, crmScope }).crmScope
  if (next === null) return { ok: false, reason: 'That is not a scope this floor can attach to' }
  floor.crmScope = next
  floor.updatedAt = new Date().toISOString()
  try {
    saveStore()
  } catch (err) {
    console.error(`[floors] could not persist the attachment for ${floorId}: ${err?.message}`)
  }
  return { ok: true, floor: clone(floor) }
}

export function setAgentSession(floorId, agentId, sessionId) {
  const floor = floors.find((f) => f.id === floorId)
  if (!floor) return null
  const agent = floor.agents.find((a) => a.id === agentId)
  if (!agent) return null
  const next = SESSION_ID_RE.test(String(sessionId ?? '')) ? String(sessionId) : null
  if (agent.sessionId !== next) {
    agent.sessionId = next
    floor.updatedAt = new Date().toISOString()
    try {
      saveStore()
    } catch (err) {
      // In memory the binding stands; on disk it is stale until the next write.
      console.error(`[floors] could not persist the chat binding for ${agentId}: ${err?.message}`)
    }
  }
  // Cloned the way clone() does it, so a caller mutating what it got back
  // cannot reach into the store.
  return { ...agent, skills: [...(agent.skills ?? [])], mcpServers: [...(agent.mcpServers ?? [])] }
}

/** The most agents a boss may put on one floor. A cap because this is now
 *  reachable by a model in a loop, not only by a human clicking "add agent":
 *  every agent is a potential claude process, and an unbounded roster is an
 *  unbounded spawn surface. Generous enough that no real floor meets it. */
const MAX_AGENTS_PER_FLOOR = 24

/**
 * Hire one agent onto a floor.
 *
 * The canvas is normally the client's to own (updateFloor replaces the whole
 * array), but the boss adds agents from its chat where there is no canvas to
 * post back — so placement happens here. New hires are laid out in a grid
 * BELOW the boss rather than at the origin, which is where hydrateAgent's
 * index-based fallback would stack them on top of each other.
 *
 * `reportsTo` accepts an id or a name because the boss knows its reports by
 * name; an unrecognised one is refused rather than quietly re-parented to the
 * boss, since "who reports to whom" is the one thing a floor is for.
 */
export function addAgent(floorId, { name, role, md, reportsTo, model } = {}) {
  const floor = floors.find((f) => f.id === floorId)
  if (!floor) return { ok: false, reason: 'No such floor' }

  const n = String(name ?? '').trim()
  if (!n) return { ok: false, reason: 'An agent needs a name' }
  if (n.length > 60) return { ok: false, reason: 'That name is too long (60 characters max)' }
  if (floor.agents.length >= MAX_AGENTS_PER_FLOOR) {
    return {
      ok: false,
      reason: `This floor already has ${floor.agents.length} agents, which is the limit. Give work to one of them instead.`,
    }
  }
  /* Names are how the boss addresses an agent when assigning work, so two
     agents sharing one would make every assignment ambiguous. */
  if (floor.agents.some((a) => a.name.trim().toLowerCase() === n.toLowerCase())) {
    return { ok: false, reason: `There is already an agent called "${n}" on this floor` }
  }

  const boss = floor.agents.find((a) => a.isBoss) ?? null
  let parentId = boss?.id ?? null
  const want = String(reportsTo ?? '').trim()
  if (want) {
    const match =
      floor.agents.find((a) => a.id === want) ??
      floor.agents.find((a) => a.name.trim().toLowerCase() === want.toLowerCase())
    if (!match) {
      return {
        ok: false,
        reason:
          `No agent called "${want}" on this floor to report to — ` +
          `it is one of: ${floor.agents.map((a) => a.name).join(', ')}`,
      }
    }
    parentId = match.id
  }

  /* Placed relative to what is ALREADY on the canvas, not by a rank-based grid.
     A grid computed from "how many agents exist" ignores where the human has
     dragged them: the first version put a new hire at (340,300) on a floor whose
     existing agent sat at (330,240), so the two nodes overlapped on the human's
     floor the moment the boss hired anybody.
     Fill the bottom row until it holds four, then start a new row under it. */
  const COL_W = 300
  const ROW_H = 200
  /* The boss is excluded from the packing: it is the top of the chart, and a
     new hire filling the empty space beside it would sit on the boss's own row
     — reading as a peer on a canvas whose whole point is who reports to whom. */
  const reports = floor.agents.filter((a) => !a.isBoss)
  let x
  let y
  if (reports.length === 0) {
    x = 40
    y = num(boss?.y, 40) + ROW_H
  } else {
    const maxY = reports.reduce((m, a) => Math.max(m, num(a.y, 0)), 0)
    const bottomRow = reports.filter((a) => num(a.y, 0) >= maxY - 60)
    if (bottomRow.length < 4) {
      y = maxY
      x = bottomRow.reduce((m, a) => Math.max(m, num(a.x, 0)), 0) + COL_W
    } else {
      y = maxY + ROW_H
      x = 40
    }
  }

  const agent = hydrateAgent(
    {
      id: randomUUID(),
      name: n,
      role: typeof role === 'string' ? role.trim().slice(0, 120) : '',
      isBoss: false,
      reportsTo: parentId,
      md: typeof md === 'string' ? md.slice(0, 20_000) : '',
      model: typeof model === 'string' ? model : '',
      x,
      y,
    },
    floor.agents.length,
  )
  if (!agent) return { ok: false, reason: 'Could not build that agent' }

  floor.agents = [...floor.agents, agent]
  floor.updatedAt = new Date().toISOString()
  try {
    saveStore()
  } catch (err) {
    /* Same posture as setAgentSession: the hire stands in memory and the caller
       is about to act on it. Reporting a failure here would invite a retry that
       hires a SECOND agent with the same name. */
    console.error(`[floors] could not persist the new agent on ${floorId}: ${err?.message}`)
  }
  return { ok: true, agent: { ...agent }, floor: clone(floor) }
}
