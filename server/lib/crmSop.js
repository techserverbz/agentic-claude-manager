// CRM SOP IMPORT - turn a SOP authored in the CRM (a separate app on :8000,
// with its own Postgres) into a V2 workflow.
//
// SNAPSHOT, NOT LIVE LINK. Two reasons, and the second is the decisive one:
//   1. V2 is a single-user local app that persists JSON under server/data and
//      must be able to run a workflow with the CRM switched off entirely.
//   2. The CRM itself already made this call - startExecution -> snapshotTree
//      flattens the template into sop_execution_nodes precisely so that editing
//      a template cannot mutate a run in flight. A step whose tutorial changes
//      while a Claude session is mid-task is a correctness bug.
// So we copy, we record provenance in workflow.source, and a re-import produces
// a new workflow VERSION rather than mutating the one a run pinned.
//
// Three details here are not guesses, they are corrections of things that are
// easy to get wrong against this API:
//
//   * body_markdown IS the tutorial. It is the single field V2 must not lose -
//     and it is exactly what the CRM's own run layer drops (sop_execution_nodes
//     has no body_markdown column, so its ExecutionPanel hardcodes
//     bodyMarkdown: null and re-fetches the template to show it).
//   * Order comes from the prev/next CHAIN, with sortOrder only as a fallback.
//     The authoring UI walks the chain; snapshotTree sorts by sortOrder. Those
//     two visibly disagree today, and the chain is what the human authored and
//     sees on screen.
//   * referenced_sop_id on a type:'reference' node is a FAMILY id, not a sop
//     id. Fetching it directly 404s. Resolve it by listing sops and matching
//     familyId + isCurrent.
//
// Everything is best-effort and never throws past the caller: if the CRM is
// down, the import fails with a clear message and the existing workflows are
// untouched.

import { randomUUID } from 'node:crypto'

// The hosted CRM is the default: the local :8000 backend is usually off, and
// the SOPs the user actually authors live on the deployed one.
//
// This is the backend the DEPLOYED front end at scrm.bhole.co actually calls —
// confirmed from its own network traffic, not from the repo's .env, which
// carries a stale `aiocrm-be.vercel.app` that answers /auth but has no /org/sops
// at all. Getting this wrong produces a 404 that reads like a missing SOP.
const DEFAULT_BASE = process.env.MDV2_CRM_BASE || 'https://sam-crm-be.vercel.app'

// Depth cap on expanding reference nodes, matching the CRM's own snapshotTree.
// A SOP that references a SOP that references the first would otherwise recurse
// until the process dies.
const MAX_REF_DEPTH = 8

const REQUEST_TIMEOUT_MS = 20_000

/** Categories V2 knows. Anything else lands as 'generic' rather than being
 *  invented, so the badge never lies about what kind of work a step is. */
const KNOWN_CATEGORIES = new Set([
  'call',
  'email',
  'doc',
  'approval',
  'site-visit',
  'payment',
  'meeting',
  'generic',
])

// --- auth --------------------------------------------------------------
//
// The CRM accepts two credentials, and which one you have decides the shape:
//
//   MDV2_CRM_AGENT_TOKEN   -> Authorization: Bearer <token>. Preferred: it is
//                             scoped to a machine, and nothing here has to hold
//                             a human's password.
//   MDV2_CRM_USER + _PASS  -> POST /auth/login, which replies with an httpOnly
//                             `crm_token` JWT cookie that every later GET must
//                             carry. Used when no agent token has been issued.
//
// The session cookie is cached in memory for the life of the process and never
// written to disk: it is a bearer credential for a real human account, and
// server/data is a directory the user syncs and copies around.
//
// Only GETs are ever sent, which is why CSRF is not in the picture — the CRM's
// csrfProtection skips safe methods.

const sessionCookies = new Map() // baseUrl -> "crm_token=..."

function credentials() {
  return {
    token: process.env.MDV2_CRM_AGENT_TOKEN || '',
    user: process.env.MDV2_CRM_USER || '',
    pass: process.env.MDV2_CRM_PASS || '',
  }
}

/** Log in and cache the session cookie. Only called when there is no agent
 *  token, and only once per base URL per process. */
async function login(baseUrl) {
  const { user, pass } = credentials()
  if (!user || !pass) {
    throw new Error(
      'No CRM credentials. Set MDV2_CRM_AGENT_TOKEN, or MDV2_CRM_USER and MDV2_CRM_PASS, then restart the server.',
    )
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/auth/login`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
      signal: ctl.signal,
      redirect: 'manual',
    })
  } catch (err) {
    const why = err?.name === 'AbortError' ? 'timed out' : err?.message
    throw new Error(`Could not reach the CRM to log in at ${url} (${why}).`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('The CRM rejected MDV2_CRM_USER / MDV2_CRM_PASS.')
  }
  if (!res.ok) throw new Error(`CRM login returned ${res.status}.`)

  // Two shapes in the wild, and a cross-origin deployment often only manages
  // the second: the JWT as a Set-Cookie, or the JWT in the response body. A
  // browser on the same site gets the cookie; an API client on another origin
  // frequently does not, because the cookie is SameSite-scoped to the CRM's own
  // front end. So take whichever actually arrived.
  //
  // getSetCookie() is the only way to see multiple Set-Cookie headers; older
  // runtimes fold them into one string, so fall back to that.
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || '']
  const seen = raw
    .join(',')
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
  const jar = seen.filter((c) => /^(crm_token|csrf_token)=/.test(c))
  if (jar.length > 0) {
    const creds = { kind: 'cookie', value: jar.join('; ') }
    sessionCookies.set(baseUrl, creds)
    return creds
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const bearer =
    body?.token ?? body?.accessToken ?? body?.access_token ?? body?.jwt ?? body?.data?.token ?? null
  if (typeof bearer === 'string' && bearer.length > 20) {
    const creds = { kind: 'bearer', value: bearer }
    sessionCookies.set(baseUrl, creds)
    return creds
  }

  // Say exactly what came back — "no cookie" alone gives the user nothing to
  // act on, and this is the one failure they cannot debug from the outside.
  const cookieNames = seen.map((c) => c.split('=')[0]).join(', ') || 'none'
  const bodyKeys = body && typeof body === 'object' ? Object.keys(body).join(', ') : 'no JSON body'
  throw new Error(
    `CRM login succeeded but returned no usable credential. Set-Cookie carried: ${cookieNames}. Body keys: ${bodyKeys}. Issue an agent token and set MDV2_CRM_AGENT_TOKEN instead.`,
  )
}

async function authHeaders(baseUrl) {
  const h = { Accept: 'application/json' }
  const { token } = credentials()
  if (token) {
    h.Authorization = `Bearer ${token}`
    return h
  }
  const creds = sessionCookies.get(baseUrl) ?? (await login(baseUrl))
  if (creds.kind === 'bearer') h.Authorization = `Bearer ${creds.value}`
  else h.Cookie = creds.value
  return h
}

// --- path prefix -------------------------------------------------------
//
// The API is mounted twice: `app.use("/v1", v1)` and `app.use("/", v1)` as
// backward compat. Deployments differ in which they actually serve — the hosted
// one answers /org/sops/:id and 404s /v1/org/sops/:id — so the prefix is probed
// once per base URL rather than assumed.

const pathPrefixes = new Map() // baseUrl -> '/v1' | ''

async function resolvePrefix(baseUrl, probePath) {
  const cached = pathPrefixes.get(baseUrl)
  if (cached !== undefined) return cached
  for (const prefix of ['/v1', '']) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${prefix}${probePath}`, {
        headers: await authHeaders(baseUrl),
      })
      // Anything but 404 means this prefix is mounted — 401 still tells us the
      // route exists, and is a credentials problem crmGet will report properly.
      if (res.status !== 404) {
        pathPrefixes.set(baseUrl, prefix)
        return prefix
      }
    } catch {
      /* try the next prefix; crmGet reports the real failure */
    }
  }
  pathPrefixes.set(baseUrl, '')
  return ''
}

/** One CRM GET. Times out rather than hanging the import forever on a CRM that
 *  accepted the socket and then went quiet. */
async function crmGet(baseUrl, pathname) {
  const prefix = pathPrefixes.get(baseUrl) ?? ''
  const url = `${baseUrl.replace(/\/+$/, '')}${prefix}${pathname}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, { headers: await authHeaders(baseUrl), signal: ctl.signal })
  } catch (err) {
    const why = err?.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err?.message
    throw new Error(`CRM unreachable at ${url} (${why}). Is it running, and are the CRM credentials set?`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401 || res.status === 403) {
    // A cached cookie that has expired looks exactly like bad credentials, so
    // drop it — the next call logs in again rather than failing forever.
    sessionCookies.delete(baseUrl)
    throw new Error(
      `CRM refused the request (${res.status}) for ${pathname}. Check MDV2_CRM_AGENT_TOKEN, or MDV2_CRM_USER / MDV2_CRM_PASS.`,
    )
  }
  if (!res.ok) throw new Error(`CRM returned ${res.status} for ${pathname}`)
  try {
    return await res.json()
  } catch {
    throw new Error(`CRM returned non-JSON for ${pathname}`)
  }
}

/** The CRM is inconsistent about camelCase vs snake_case across its own
 *  endpoints, so read both rather than picking one and silently getting null. */
function pick(obj, ...names) {
  for (const n of names) {
    const v = obj?.[n]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return null
}

function unwrap(payload, ...keys) {
  if (!payload || typeof payload !== 'object') return null
  for (const k of keys) if (payload[k]) return payload[k]
  return payload.data ?? payload
}

// ---------------------------------------------------------------------------
// ordering: walk the prev/next chain the author actually sees
// ---------------------------------------------------------------------------

/** Order one set of siblings. The chain is authoritative; sortOrder breaks ties
 *  for anything the chain does not reach (a node whose prev pointer was lost by
 *  an earlier CRM bug still has to appear somewhere, and appearing in sortOrder
 *  position is the least surprising place). */
function orderSiblings(nodes) {
  if (nodes.length <= 1) return [...nodes]
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const hasPrev = new Set()
  for (const n of nodes) {
    const nx = pick(n, 'nextNodeId', 'next_node_id')
    if (nx && byId.has(nx)) hasPrev.add(nx)
  }
  // Heads: no incoming next-pointer. Usually exactly one; more than one means a
  // broken chain, and taking them all in sortOrder is how the authoring UI copes.
  const bySort = (a, b) =>
    (Number(pick(a, 'sortOrder', 'sort_order')) || 0) - (Number(pick(b, 'sortOrder', 'sort_order')) || 0)
  const heads = nodes.filter((n) => !hasPrev.has(n.id)).sort(bySort)

  const out = []
  const seen = new Set()
  for (const head of heads) {
    let cur = head
    let guard = 0
    while (cur && !seen.has(cur.id) && guard++ <= nodes.length) {
      seen.add(cur.id)
      out.push(cur)
      const nx = pick(cur, 'nextNodeId', 'next_node_id')
      cur = nx ? byId.get(nx) : null
    }
  }
  // Anything the chain never reached (orphaned by a broken pointer).
  for (const n of [...nodes].sort(bySort)) if (!seen.has(n.id)) out.push(n)
  return out
}

// ---------------------------------------------------------------------------
// field mapping
// ---------------------------------------------------------------------------

/** sop_nodes.metadata carries wpage-section blobs. Kept as structured refs so
 *  the brief can append a "reference" section, and kept opaque otherwise so a
 *  CRM-side addition does not silently vanish. */
function refsFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') return []
  const raw = Array.isArray(meta.references)
    ? meta.references
    : Array.isArray(meta.refs)
      ? meta.refs
      : meta.reference
        ? [meta.reference]
        : []
  return raw
    .map((r) => {
      if (!r || typeof r !== 'object') return null
      const snap = r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : {}
      return {
        kind: 'wpage-section',
        wpageId: pick(r, 'wpageId', 'wpage_id'),
        headingId: pick(r, 'headingId', 'heading_id'),
        headingText: pick(snap, 'headingText', 'heading_text') || pick(r, 'headingText', 'heading_text') || '',
        pageSlug: pick(snap, 'pageSlug', 'page_slug') || pick(r, 'pageSlug', 'page_slug') || '',
        capturedAt: pick(r, 'capturedAt', 'captured_at'),
      }
    })
    .filter(Boolean)
}

/** Attachments are NOT in a file_ids column. The CRM keys them by convention:
 *  a file whose `source` is `sop-node:<nodeId>` belongs to that node. We record
 *  the pointer only - downloading would make the import depend on the CRM
 *  staying up, which is the whole thing we are avoiding. */
function attachmentsFor(nodeId, allFiles, baseUrl) {
  const tag = `sop-node:${nodeId}`
  return allFiles
    .filter((f) => String(pick(f, 'source') || '') === tag)
    .map((f) => {
      const id = pick(f, 'id', 'fileId', 'file_id')
      if (!id) return null
      return {
        fileId: id,
        name: pick(f, 'name', 'filename', 'originalName', 'original_name') || 'attachment',
        url: pick(f, 'url', 'downloadUrl', 'download_url') || `${baseUrl}/v1/org/files/${id}`,
      }
    })
    .filter(Boolean)
}

function categoryOf(node) {
  const c = String(pick(node, 'category') || '').toLowerCase()
  return KNOWN_CATEGORIES.has(c) ? c : 'generic'
}

function assigneeOf(node) {
  const type = pick(node, 'assigneeType', 'assignee_type')
  const id = pick(node, 'assigneeId', 'assignee_id')
  if (!type && !id) return null
  return { type: String(type || 'none'), id: id ? String(id) : null }
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/** Resolve a reference node's target. referenced_sop_id is a FAMILY id: list
 *  the sops, find the current member of that family, then fetch it by its own
 *  id. Fetching the family id directly is the mistake this exists to avoid. */
async function resolveReferencedSop(baseUrl, familyId, sopIndexCache) {
  if (!sopIndexCache.list) {
    const payload = await crmGet(baseUrl, '/org/sops')
    const list = unwrap(payload, 'sops', 'items', 'results')
    sopIndexCache.list = Array.isArray(list) ? list : []
  }
  const match = sopIndexCache.list.find(
    (s) =>
      String(pick(s, 'familyId', 'family_id') || '') === String(familyId) &&
      (pick(s, 'isCurrent', 'is_current') === true || pick(s, 'isCurrent', 'is_current') === 1),
  )
  // Fall back to any member of the family - an SOP with no current flag set is
  // still better imported than dropped.
  const target =
    match ||
    sopIndexCache.list.find((s) => String(pick(s, 'familyId', 'family_id') || '') === String(familyId))
  if (!target) return null
  const id = pick(target, 'id', 'sopId', 'sop_id')
  return id ? await fetchSop(baseUrl, id) : null
}

async function fetchSop(baseUrl, sopId) {
  const payload = await crmGet(baseUrl, `/org/sops/${sopId}`)
  const sop = unwrap(payload, 'sop') || {}
  const nodes = Array.isArray(payload?.nodes)
    ? payload.nodes
    : Array.isArray(sop?.nodes)
      ? sop.nodes
      : []
  return { sop, nodes }
}

/** Depth-first over one SOP's node tree, emitting V2 steps.
 *
 *  - a node with children, or type 'group', becomes a STAGE: never dispatched,
 *    status derived from its children.
 *  - a node of type 'reference' is EXPANDED INLINE at import time, so the run
 *    has the referenced work as real steps rather than a pointer into an app
 *    that might be offline.
 */
async function walkNodes({
  baseUrl,
  nodes,
  parentStepId,
  originSopId,
  out,
  files,
  visited,
  depth,
  sopIndexCache,
  makeId,
}) {
  const byParent = new Map()
  for (const n of nodes) {
    if (pick(n, 'disabled', 'is_disabled') === true) continue
    const p = pick(n, 'parentNodeId', 'parent_node_id', 'parentId', 'parent_id') || null
    const key = p || ' root'
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(n)
  }

  const emit = async (siblings, parentId) => {
    // The prev/next chain is a SEQUENCE, not just a display order: the author
    // wrote "do this, then this, then this". Recording it as `dependsOn` on the
    // following step is what makes a run dispatch them in order instead of
    // firing all twelve at once — and it is the single piece of the SOP's
    // meaning that ordering alone throws away.
    let prevSiblingId = null

    for (const node of orderSiblings(siblings)) {
      const nodeId = String(pick(node, 'id') || '')
      const kids = byParent.get(nodeId) || []
      const type = String(pick(node, 'type', 'nodeType', 'node_type') || 'task').toLowerCase()

      if (type === 'reference') {
        const familyId = pick(node, 'referencedSopId', 'referenced_sop_id')
        // A reference expands into a STAGE carrying the referenced SOP's steps,
        // so the tree still shows where the borrowed work came from.
        const stageId = makeId()
        out.push({
          id: stageId,
          parentId,
          kind: 'stage',
          title: pick(node, 'title', 'name') || 'Referenced SOP',
          summary: pick(node, 'description') || '',
          brief: pick(node, 'bodyMarkdown', 'body_markdown') || '',
          category: categoryOf(node),
          estimatedMinutes: Number(pick(node, 'estimatedMinutes', 'estimated_minutes')) || null,
          crmAssignee: assigneeOf(node),
          refs: refsFromMetadata(pick(node, 'metadata')),
          attachments: attachmentsFor(nodeId, files, baseUrl),
          dependsOn: prevSiblingId ? [prevSiblingId] : [],
          source: { nodeId, originSopId },
        })
        prevSiblingId = stageId
        if (!familyId || depth >= MAX_REF_DEPTH || visited.has(String(familyId))) continue
        // Per-BRANCH visited set: the same SOP referenced from two different
        // branches is legitimate and should expand in both.
        const branchVisited = new Set(visited)
        branchVisited.add(String(familyId))
        let ref = null
        try {
          ref = await resolveReferencedSop(baseUrl, familyId, sopIndexCache)
        } catch {
          ref = null // a broken reference must not fail the whole import
        }
        if (!ref) continue
        await walkNodes({
          baseUrl,
          nodes: ref.nodes,
          parentStepId: stageId,
          originSopId: String(pick(ref.sop, 'id') || familyId),
          out,
          files,
          visited: branchVisited,
          depth: depth + 1,
          sopIndexCache,
          makeId,
        })
        continue
      }

      const isStage = type === 'group' || kids.length > 0
      const stepId = makeId()
      out.push({
        id: stepId,
        parentId,
        kind: isStage ? 'stage' : 'step',
        title: pick(node, 'title', 'name') || 'Untitled step',
        summary: pick(node, 'description') || '',
        // THE TUTORIAL. Plan item 4. Never dropped.
        brief: pick(node, 'bodyMarkdown', 'body_markdown') || '',
        category: categoryOf(node),
        estimatedMinutes: Number(pick(node, 'estimatedMinutes', 'estimated_minutes')) || null,
        crmAssignee: assigneeOf(node),
        refs: refsFromMetadata(pick(node, 'metadata')),
        attachments: attachmentsFor(nodeId, files, baseUrl),
        // the chain: this step waits on the one authored before it
        dependsOn: prevSiblingId ? [prevSiblingId] : [],
        source: { nodeId, originSopId },
      })
      prevSiblingId = stepId
      if (kids.length) await emit(kids, stepId)
    }
  }

  // Start at THIS node set's own roots. `parentStepId` is a V2 step id (the
  // stage a referenced SOP hangs under) and must never be looked up in
  // byParent, which is keyed by CRM node ids.
  await emit(byParent.get(' root') || [], parentStepId)
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

/** Fetch a SOP and map it to the fields createWorkflow/replaceImported want.
 *  Pure data - it does NOT touch the workflows store, so the caller decides
 *  whether this is a first import or a version bump.
 *
 *  @returns {Promise<{name, description, brief, source, steps}>}
 */
export async function importCrmSop({ sopId, baseUrl = DEFAULT_BASE, makeId } = {}) {
  if (!sopId) throw new Error('sopId is required')
  const newId = typeof makeId === 'function' ? makeId : () => randomUUID()

  // Which mount this deployment serves (/v1/org vs /org) is probed once, on the
  // very request we were going to make anyway.
  await resolvePrefix(baseUrl, `/org/sops/${sopId}`)

  // The id in a CRM URL (/sops/<id>) is not necessarily a sop id — the app
  // routes by FAMILY for the current version, which is the same trap the
  // reference nodes set. So: try it as a sop id, and if that 404s, resolve it
  // as a family id rather than telling the user their own URL is wrong.
  const sopIndexCache = {}
  let fetched = null
  try {
    fetched = await fetchSop(baseUrl, sopId)
  } catch (err) {
    if (!/returned 404/.test(err?.message || '')) throw err
    fetched = await resolveReferencedSop(baseUrl, sopId, sopIndexCache)
    if (!fetched) {
      const known = (sopIndexCache.list ?? [])
        .slice(0, 8)
        .map((s) => `${pick(s, 'name', 'title') || 'untitled'} (${pick(s, 'id')})`)
      throw new Error(
        `CRM has no SOP or SOP family ${sopId}.${
          known.length ? ` Available: ${known.join('; ')}` : ' The org has no SOPs visible to these credentials.'
        }`,
      )
    }
  }
  const { sop, nodes } = fetched
  if (!sop || !pick(sop, 'id')) throw new Error(`CRM had no SOP ${sopId}`)

  // Attachments are found by convention over the org's file list. If the file
  // endpoint is unavailable the import still succeeds, just without pointers.
  let files = []
  try {
    const payload = await crmGet(baseUrl, '/org/files')
    const list = unwrap(payload, 'files', 'items', 'results')
    files = Array.isArray(list) ? list : []
  } catch {
    files = []
  }

  const steps = []
  await walkNodes({
    baseUrl,
    nodes: Array.isArray(nodes) ? nodes : [],
    parentStepId: null,
    originSopId: String(pick(sop, 'id')),
    out: steps,
    files,
    visited: new Set([String(pick(sop, 'familyId', 'family_id') || sopId)]),
    depth: 0,
    sopIndexCache, // reuse the list already fetched if the id was a family id
    makeId: newId,
  })

  return {
    name: pick(sop, 'name', 'title') || 'Imported SOP',
    description: pick(sop, 'description') || '',
    // extras_markdown is the catch-all knowledge that belongs to no single
    // step - which makes it the FATHER chat's context, not a step's.
    brief: pick(sop, 'extrasMarkdown', 'extras_markdown') || '',
    source: {
      kind: 'crm-sop',
      baseUrl,
      sopId: String(pick(sop, 'id')),
      familyId: pick(sop, 'familyId', 'family_id') || null,
      sopVersion: Number(pick(sop, 'version')) || 1,
      importedAt: new Date().toISOString(),
    },
    steps,
  }
}

/** Exported for tests: the ordering rule and the node walk are the two places
 *  this file can silently disagree with what the CRM author sees on screen, so
 *  they are testable without a live CRM. */
export const __test = { orderSiblings, walkNodes, refsFromMetadata, attachmentsFor }
