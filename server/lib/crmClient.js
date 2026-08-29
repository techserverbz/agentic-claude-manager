// CRM CLIENT — V2's read side of the CRM.
//
// Auth, in order of preference:
//   1. An AGENT TOKEN (Bearer agent_...). This is the right long-term answer:
//      agent_tokens binds a token to a userId, so the CRM sees the request as
//      that person, sets req.isAgent = true, and records req.agentTokenId. That
//      is what makes "Shubham's agent did this" expressible without inventing a
//      bot user. Minting one is an INSERT into agent_tokens, which is a write to
//      production — so it is opt-in, never done automatically.
//   2. A username/password login, which is what a human does. Used only when no
//      token is configured, so reads work today without touching production.
//
// Credentials live in server/data/crm-auth.json (gitignored, mode 0600) and are
// never returned by any route. The session is cached in memory and re-acquired
// on a 401 — the CRM's cookie has a finite life and a stale one must not turn
// into a wall of failed reads.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTH_FILE = path.join(SERVER_ROOT, 'data', 'crm-auth.json')

const DEFAULT_BASE = 'http://localhost:8000'

/** { baseUrl, agentToken? , username?, password? } — or null when unconfigured. */
function readAuth() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    if (!cfg || typeof cfg !== 'object') return null
    return {
      baseUrl: typeof cfg.baseUrl === 'string' && cfg.baseUrl ? cfg.baseUrl : DEFAULT_BASE,
      agentToken: typeof cfg.agentToken === 'string' ? cfg.agentToken : '',
      username: typeof cfg.username === 'string' ? cfg.username : '',
      password: typeof cfg.password === 'string' ? cfg.password : '',
    }
  } catch {
    return null
  }
}

export function crmConfigured() {
  const a = readAuth()
  return !!(a && (a.agentToken || (a.username && a.password)))
}

/** How V2 is authenticating, for the UI to show. Never includes the secret. */
export function crmAuthMode() {
  const a = readAuth()
  if (!a) return 'unconfigured'
  if (a.agentToken) return 'agent-token'
  if (a.username && a.password) return 'password'
  return 'unconfigured'
}

let cachedCookie = null
/* The CRM guards every state-changing /org route with a double-submit cookie:
   `crm_csrf` must equal the x-csrf-token header (middleware/csrf.js). A GET
   mints the cookie when it is missing, which is why the write path always has a
   read in front of it. There is no agent-token bypass — a Bearer client needs
   this too. */
let cachedCsrf = null

function rememberCookies(res) {
  const set = res.headers.getSetCookie?.() ?? []
  if (set.length === 0) return
  const pairs = set.map((c) => c.split(';')[0])
  for (const p of pairs) {
    const [k, v] = p.split('=')
    if (k === 'crm_csrf') cachedCsrf = v
  }
  /* merge rather than replace: the CSRF cookie often arrives on a response that
     does NOT re-issue the session cookie, and dropping the session would log us
     out on the next call */
  const merged = new Map()
  for (const p of (cachedCookie ?? '').split('; ').filter(Boolean)) {
    const i = p.indexOf('=')
    merged.set(p.slice(0, i), p.slice(i + 1))
  }
  for (const p of pairs) {
    const i = p.indexOf('=')
    merged.set(p.slice(0, i), p.slice(i + 1))
  }
  cachedCookie = [...merged].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function login(auth) {
  const res = await fetch(`${auth.baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: auth.username, password: auth.password, portal: 'crm' }),
  })
  if (!res.ok) throw new Error(`CRM login failed (HTTP ${res.status})`)
  cachedCookie = null
  rememberCookies(res)
  if (!cachedCookie) throw new Error('CRM login returned no session cookie')
  return cachedCookie
}

/**
 * GET a CRM path (e.g. '/v1/org/goals'). Retries ONCE on 401 after
 * re-authenticating, because a cached cookie expiring is ordinary and should
 * not surface as an error the user has to act on.
 */
export async function crmGet(pathname) {
  const auth = readAuth()
  if (!auth) throw new Error('CRM is not configured (server/data/crm-auth.json is missing)')

  const attempt = async (fresh) => {
    const headers = {}
    if (auth.agentToken) {
      headers.authorization = `Bearer ${auth.agentToken}`
    } else {
      headers.cookie = fresh || cachedCookie || (await login(auth))
    }
    return fetch(`${auth.baseUrl}${pathname}`, { headers })
  }

  let res = await attempt(null)
  if (res.status === 401 && !auth.agentToken) {
    cachedCookie = null
    res = await attempt(await login(auth))
  }
  rememberCookies(res) // a GET is where the crm_csrf cookie comes from
  if (!res.ok) throw new Error(`CRM ${pathname} failed (HTTP ${res.status})`)
  return res.json()
}

/**
 * WRITE to the CRM. This touches PRODUCTION data — every caller should be
 * something the user asked for explicitly, not a background reconciliation.
 *
 * Ensures a CSRF token first: the cookie is only minted on a safe request, so a
 * cold process posting straight away would take a 403 that reads like an auth
 * failure rather than a missing handshake.
 */
export async function crmWrite(method, pathname, body) {
  const auth = readAuth()
  if (!auth) throw new Error('CRM is not configured (server/data/crm-auth.json is missing)')

  if (!cachedCsrf || (!auth.agentToken && !cachedCookie)) {
    // cheap, always-allowed read purely to obtain the handshake
    await crmGet('/v1/org/members').catch(() => {})
  }

  const send = async () => {
    const headers = { 'Content-Type': 'application/json' }
    if (auth.agentToken) headers.authorization = `Bearer ${auth.agentToken}`
    if (cachedCookie) headers.cookie = cachedCookie
    if (cachedCsrf) headers['x-csrf-token'] = cachedCsrf
    return fetch(`${auth.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  let res = await send()
  if ((res.status === 401 || res.status === 403) && !auth.agentToken) {
    // stale session or stale token — re-handshake once, then give up honestly
    cachedCookie = null
    cachedCsrf = null
    await login(auth)
    await crmGet('/v1/org/members').catch(() => {})
    res = await send()
  }
  rememberCookies(res)

  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    throw new Error(parsed?.error || `CRM ${method} ${pathname} failed (HTTP ${res.status})`)
  }
  return parsed
}

/* The CRM's own vocabulary, restated so V2 validates before it ever reaches
   production. Mirrors GOAL_STATUSES / GOAL_PRIORITIES in goalsController.js. */
export const GOAL_STATUSES = ['todo', 'in-progress', 'review', 'done', 'abandoned']
export const GOAL_PRIORITIES = ['low', 'medium', 'high', 'urgent']

/**
 * The six service pillars, and their labels.
 *
 * Copied from the CRM's OWN authority — goalsController.js:35 GOAL_PILLARS —
 * not from any of the five frontend copies, because the server is what rejects
 * a bad value with 400 `service_pillar must be one of: ...`.
 *
 * Two rules the CRM enforces as a TUPLE (validateScope, goalsController.js:47):
 *   - a pillar is only legal when target_type is 'service'
 *   - even then it is OPTIONAL — null means "the whole service"
 * Both are mirrored here so a bad combination is refused before it becomes a
 * production 400 the user has to interpret.
 */
export const GOAL_PILLARS = [
  'product',
  'operations',
  'marketing',
  'sales',
  'finance',
  'management',
]

export const PILLAR_LABEL = {
  product: 'Product',
  operations: 'Operations',
  marketing: 'Marketing',
  sales: 'Sales',
  finance: 'Finance',
  management: 'Management',
}

/** The (targetType, pillar) tuple rule, stated once. Returns an error or null. */
function pillarError(targetType, pillar) {
  if (!pillar) return null
  if (targetType !== 'service') {
    return 'a pillar only applies to a product/service goal'
  }
  if (!GOAL_PILLARS.includes(pillar)) {
    return 'Unknown pillar: ' + pillar + ' — it is one of: ' + GOAL_PILLARS.join(', ')
  }
  return null
}

/** Create a goal in the scope this floor is attached to. `title` is the only
 *  field the CRM requires (goalsController.js:424). */
export async function crmCreateGoal({
  title,
  description,
  status,
  priority,
  targetType,
  targetId,
  ownerId,
  assigneeIds,
  servicePillar,
  dueDate,
}) {
  const t = String(title ?? '').trim()
  if (!t) throw new Error('A title is required')
  if (status && !GOAL_STATUSES.includes(status)) throw new Error('Unknown status: ' + status)
  if (priority && !GOAL_PRIORITIES.includes(priority)) throw new Error('Unknown priority: ' + priority)
  const pErr = pillarError(targetType, servicePillar)
  if (pErr) throw new Error(pErr)

  /* Resolved BEFORE the literal. This used to be two `owner_id` keys in the
     same object — the second silently won, so the 'mine' branch never ran and a
     goal created from the My tasks board came back with no owner. crmBoard
     filters that board on ownerId, so the goal was written to the CRM and then
     was invisible on the board that created it. */
  const resolvedOwner =
    ownerId || (targetType === 'mine' ? (await crmMe().catch(() => null))?.id : undefined)

  const body = {
    title: t,
    description: description ? String(description) : undefined,
    status: status || 'todo',
    priority: priority || 'medium',
    // snake_case: createGoal destructures the body in the CRM's own casing
    // 'mine' is a V2 filter, not a CRM target_type. A goal created from that
    // board is org-wide and owned by us, which is what makes it show up there.
    target_type: !targetType || targetType === 'mine' ? 'organization' : targetType,
    target_id:
      targetType && targetType !== 'organization' && targetType !== 'mine' ? targetId : undefined,
    owner_id: resolvedOwner || undefined,
    /* The CRM derives ownerId from the first assignee, so sending both would let
       them disagree. assignee_ids wins when given. */
    assignee_ids: Array.isArray(assigneeIds) && assigneeIds.length ? assigneeIds : undefined,
    service_pillar: servicePillar || undefined,
    due_date: dueDate || undefined,
  }
  const out = await crmWrite('POST', '/v1/org/goals', body)
  return out?.goal ?? out?.data ?? out
}

/** Edit an existing goal. Only the fields given are sent, so a partial edit
 *  cannot blank a field the dialog did not show. */
export async function crmUpdateGoal(id, patch) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(String(id ?? ''))) throw new Error('Bad goal id')
  const body = {}
  if (patch.title !== undefined) {
    const t = String(patch.title).trim()
    if (!t) throw new Error('Title cannot be empty')
    body.title = t
  }
  if (patch.description !== undefined) body.description = patch.description
  if (patch.status !== undefined) {
    if (!GOAL_STATUSES.includes(patch.status)) throw new Error('Unknown status: ' + patch.status)
    body.status = patch.status
  }
  if (patch.priority !== undefined) {
    if (!GOAL_PRIORITIES.includes(patch.priority)) {
      throw new Error('Unknown priority: ' + patch.priority)
    }
    body.priority = patch.priority
  }
  if (patch.ownerId !== undefined) body.owner_id = patch.ownerId
  if (patch.assigneeIds !== undefined) {
    if (!Array.isArray(patch.assigneeIds)) throw new Error('assigneeIds must be a list')
    body.assignee_ids = patch.assigneeIds
  }
  /* Explicit undefined-vs-null: undefined means "leave the pillar alone", null
     means "clear it" (the goal covers the whole service). Collapsing the two
     would make clearing a pillar impossible. The (targetType, pillar) tuple is
     re-validated CRM-side against the goal's stored targetType — which is why
     a lone service_pillar PATCH is safe (goalsController.js:674). */
  if (patch.servicePillar !== undefined) {
    const p = patch.servicePillar
    if (p !== null && !GOAL_PILLARS.includes(p)) {
      throw new Error('Unknown pillar: ' + p + ' — it is one of: ' + GOAL_PILLARS.join(', '))
    }
    body.service_pillar = p
  }
  if (patch.dueDate !== undefined) body.due_date = patch.dueDate
  if (Object.keys(body).length === 0) throw new Error('Nothing to change')

  const out = await crmWrite('PATCH', `/v1/org/goals/${id}`, body)
  return out?.goal ?? out?.data ?? out
}

/** Remove a goal. Used by the test round-trip and by an explicit delete. */
export async function crmDeleteGoal(id) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(String(id ?? ''))) throw new Error('Bad goal id')
  return crmWrite('DELETE', `/v1/org/goals/${id}`)
}

/* ------------------------------------------------------------------ goals -- */

/** The board columns, in the order a card moves through them. `abandoned` is a
 *  real CRM status but is deliberately NOT a column: it is an exit, not a
 *  stage, and giving it a lane invites dragging things into it. */
export const BOARD_COLUMNS = ['todo', 'in-progress', 'review', 'done']

/**
 * The goals for one scope, bucketed into board columns.
 *
 * The CRM's own list route filters by parentGoalId only — no scope or status
 * filter exists (goalsController.js:242) — so the filtering happens here. At 94
 * goals and 78KB that is cheaper than adding a route to a production API.
 *
 * @param {'organization'|'service'|'project'} targetType
 * @param {string|null} targetId  null for organization-wide ("general")
 */
/** Everyone in the org, by userId. Cached like crmMe: the card only needs a
 *  display name, and the roster does not change inside a session. */
let cachedMembers = null
export async function crmMembers() {
  if (cachedMembers) return cachedMembers
  const body = await crmGet('/v1/org/members')
  const arr = Array.isArray(body?.members)
    ? body.members
    : Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : []
  /* userId, NOT id — the members route names it that way, and reading `id` here
     is what left every crmUserId null the first time this was wired. */
  cachedMembers = new Map(arr.map((m) => [String(m.userId), m]))
  return cachedMembers
}

/** The name the CRM's own card shows for a person: full name, else username. */
function memberLabel(members, userId) {
  if (!userId) return null
  const m = members.get(String(userId))
  if (!m) return null
  const full = typeof m.fullName === 'string' ? m.fullName.trim() : ''
  return full || m.username || null
}

export async function crmBoard(targetType, targetId) {
  const body = await crmGet('/v1/org/goals')
  const all = Array.isArray(body?.goals) ? body.goals : Array.isArray(body) ? body : []

  /* "My tasks" is not a CRM target type — it is a filter across every scope, so
     it is resolved here rather than pretending goals.target_type has a value it
     does not. Ownership follows the CRM's own definition: goals.ownerId is the
     first assignee, and the schema notes that every existing "assigned to me"
     query reads it. */
  let me = null
  if (targetType === 'mine') me = await crmMe()

  const inScope = all.filter((g) => {
    if (g.isDisabled) return false
    if (targetType === 'mine') return me !== null && String(g.ownerId ?? '') === String(me.id)
    if (g.targetType !== targetType) return false
    // organization-wide goals carry a null targetId; everything else must match
    if (targetType === 'organization') return true
    return String(g.targetId ?? '') === String(targetId ?? '')
  })

  /* The card is a faithful copy of the CRM's own, so it needs what that card
     reads: the owner's NAME (not id), and the parent goal's TITLE for the
     "sub-goal of X" pill. Both are resolved here, against the full goal list and
     the org roster, because the browser has neither and one round-trip per card
     would be 90+ requests. */
  const members = await crmMembers().catch(() => new Map())
  const titleById = new Map(all.map((g) => [g.id, g.title]))

  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, []]))
  let abandoned = 0
  for (const g of inScope) {
    if (g.status === 'abandoned') {
      abandoned++
      continue
    }
    const col = columns[g.status] ? g.status : 'todo'
    /* Everyone on the goal, owner first — the CRM falls back to ownerId for
       rows written before assigneeIds existed, so this does too. */
    const assignees = Array.isArray(g.assigneeIds) && g.assigneeIds.length
      ? g.assigneeIds
      : g.ownerId
        ? [g.ownerId]
        : []
    columns[col].push({
      id: g.id,
      title: g.title,
      description: g.description ?? null,
      status: g.status,
      priority: g.priority,
      ownerId: g.ownerId ?? null,
      ownerName: memberLabel(members, g.ownerId),
      assigneeNames: assignees.map((id) => memberLabel(members, id)).filter(Boolean),
      parentGoalId: g.parentGoalId ?? null,
      /* null when the parent is outside this scope — the CRM shows a bare
         "sub-goal" pill in exactly that case rather than inventing a title. */
      parentTitle: g.parentGoalId ? (titleById.get(g.parentGoalId) ?? null) : null,
      dueDate: g.dueDate ?? null,
      createdAt: g.createdAt ?? null,
      createdByName: g.createdByName ?? null,
      projectId: g.projectId ?? null,
      /* Per-card, not per-board: the "My tasks" board mixes scopes, so a card
         cannot infer its own targetType from the board it is sitting on — and
         the pillar badge is guarded on it. */
      targetType: g.targetType ?? null,
      targetId: g.targetId ?? null,
      servicePillar: g.servicePillar ?? null,
      assigneeIds: assignees,
      updatedAt: g.updatedAt ?? null,
    })
  }
  for (const c of BOARD_COLUMNS) {
    columns[c].sort((a, b) => String(a.title).localeCompare(String(b.title)))
  }
  return { targetType, targetId: targetId ?? null, total: inScope.length, abandoned, columns }
}

/** Who V2 is signed in to the CRM as. Cached: it is asked on every "My tasks"
 *  read and never changes within a session. */
let cachedMe = null
export async function crmMe() {
  if (cachedMe) return cachedMe
  const body = await crmGet('/v1/auth/me')
  const u = body?.user ?? body?.data ?? body
  if (!u?.id) throw new Error('the CRM did not say who we are signed in as')
  cachedMe = { id: u.id, name: u.fullName || u.username || 'me' }
  return cachedMe
}

/** What a floor can be attached to: my own work, every service, every project. */
export async function crmScopes() {
  const out = []
  try {
    const me = await crmMe()
    out.push({ targetType: 'mine', targetId: null, name: `My tasks (${me.name})` })
  } catch {
    out.push({ targetType: 'mine', targetId: null, name: 'My tasks' })
  }
  for (const [pathname, type, key] of [
    ['/v1/org/services', 'service', 'services'],
    ['/v1/org/projects', 'project', 'projects'],
  ]) {
    try {
      const body = await crmGet(pathname)
      const arr = Array.isArray(body?.[key]) ? body[key] : Array.isArray(body) ? body : []
      for (const row of arr) {
        if (row?.isDisabled) continue
        out.push({
          targetType: type,
          targetId: row.id,
          name: row.name ?? row.title ?? '(unnamed)',
        })
      }
    } catch {
      /* one missing list must not empty the picker — the org row still stands */
    }
  }
  return out
}
