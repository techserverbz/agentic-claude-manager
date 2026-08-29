// The CRM SOP importer, tested against a fixture CRM rather than a live one.
//
// The point of these tests is the three things that are easy to get silently
// wrong and impossible to notice later: the ORDER (chain, not sortOrder), the
// TUTORIAL (body_markdown must survive), and REFERENCE expansion (the id on a
// reference node is a family id, so a naive fetch 404s and the branch vanishes).
//
// `fetch` is stubbed, so this runs with the CRM switched off.

import test from 'node:test'
import assert from 'node:assert/strict'

// Set before the import: the module reads credentials lazily, but being
// explicit here documents that every test below runs on the AGENT TOKEN path.
// The two tests that exercise username/password login clear it themselves.
process.env.MDV2_CRM_AGENT_TOKEN = 'agent_test_token'

const { importCrmSop, __test } = await import('../server/lib/crmSop.js')

const BASE = 'http://crm.test'

// --- fixture ---------------------------------------------------------------
// A SOP whose sortOrder DISAGREES with its prev/next chain, so a sortOrder
// flatten and a chain walk produce visibly different orders. The chain is what
// the author sees, so the chain is what we must follow.
const MAIN_SOP = {
  id: 'sop-main',
  familyId: 'fam-main',
  name: 'Feasibility',
  description: 'The first workflow',
  extras_markdown: '# House rules\nEverything the father should know.',
  version: 3,
}

const MAIN_NODES = [
  // chain: intro -> stage -> outro.  sortOrder says the opposite.
  { id: 'n-intro', title: 'Kickoff', type: 'task', sort_order: 90, next_node_id: 'n-stage', body_markdown: '# Kickoff\nCall the client.', category: 'call' },
  { id: 'n-stage', title: 'Site work', type: 'group', sort_order: 50, next_node_id: 'n-outro' },
  { id: 'n-outro', title: 'Report', type: 'task', sort_order: 10, body_markdown: '# Report\nWrite it up.', category: 'doc' },
  // children of the stage, chained a.1 -> a.2
  { id: 'n-a1', parent_node_id: 'n-stage', title: 'Measure plot', type: 'task', sort_order: 2, next_node_id: 'n-a2', body_markdown: '# Measure\nTape and drone.', estimated_minutes: 45 },
  { id: 'n-a2', parent_node_id: 'n-stage', title: 'Photograph', type: 'task', sort_order: 1, body_markdown: '# Photos' },
  // a disabled node must not appear at all
  { id: 'n-dead', title: 'Retired step', type: 'task', sort_order: 99, disabled: true, body_markdown: 'should never appear' },
  // a reference node: the id is a FAMILY id
  { id: 'n-ref', parent_node_id: 'n-stage', title: 'Liaisoning', type: 'reference', sort_order: 3, referenced_sop_id: 'fam-liaison' },
]

const LIAISON_SOP = { id: 'sop-liaison-v2', familyId: 'fam-liaison', name: 'Liaisoning', version: 2 }
const LIAISON_NODES = [
  { id: 'l-1', title: 'File application', type: 'task', sort_order: 1, next_node_id: 'l-2', body_markdown: '# File it' },
  { id: 'l-2', title: 'Follow up', type: 'task', sort_order: 2, body_markdown: '# Chase it' },
]

const FILES = [
  { id: 'file-1', source: 'sop-node:n-a1', name: 'plot-survey.pdf', url: 'http://crm.test/f/1' },
  { id: 'file-2', source: 'sop-node:n-other', name: 'unrelated.pdf' },
]

function installFetch({ failFiles = false } = {}) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const u = String(url)
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (u.endsWith('/v1/org/sops/sop-main')) return json({ sop: MAIN_SOP, nodes: MAIN_NODES })
    if (u.endsWith('/v1/org/sops/sop-liaison-v2')) return json({ sop: LIAISON_SOP, nodes: LIAISON_NODES })
    if (u.endsWith('/v1/org/sops')) {
      return json({
        sops: [
          { id: 'sop-liaison-v1', familyId: 'fam-liaison', isCurrent: false },
          { id: 'sop-liaison-v2', familyId: 'fam-liaison', isCurrent: true },
        ],
      })
    }
    if (u.endsWith('/v1/org/files')) {
      if (failFiles) return { ok: false, status: 500, json: async () => ({}) }
      return json({ files: FILES })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return calls
}

let seq = 0
const makeId = () => `step-${String(++seq).padStart(3, '0')}`

test('orderSiblings follows the prev/next chain, not sortOrder', () => {
  const ordered = __test.orderSiblings(MAIN_NODES.filter((n) => !n.parent_node_id && !n.disabled))
  assert.deepEqual(
    ordered.map((n) => n.id),
    ['n-intro', 'n-stage', 'n-outro'],
    'the chain order must win over sort_order, which says the reverse',
  )
})

test('orderSiblings still places nodes the chain never reaches', () => {
  const orphaned = [
    { id: 'a', sort_order: 2, next_node_id: 'b' },
    { id: 'b', sort_order: 3 },
    { id: 'c', sort_order: 1 }, // no chain link at all
  ]
  const ids = __test.orderSiblings(orphaned).map((n) => n.id)
  assert.ok(ids.includes('c'), 'an unchained node must not be dropped')
  assert.equal(ids.length, 3)
})

test('import maps a SOP into ordered steps, keeping every tutorial', async (t) => {
  installFetch()
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId })

  assert.equal(wf.name, 'Feasibility')
  assert.equal(wf.source.kind, 'crm-sop')
  assert.equal(wf.source.familyId, 'fam-main')
  assert.equal(wf.source.sopVersion, 3)
  assert.match(wf.brief, /House rules/, 'extras_markdown becomes the father chat brief')

  const titles = wf.steps.map((s) => s.title)
  assert.deepEqual(titles, [
    'Kickoff',
    'Site work',
    'Measure plot',
    'Photograph',
    'Liaisoning',
    'File application',
    'Follow up',
    'Report',
  ], 'depth-first pre-order following the chain at every level')

  const disabled = wf.steps.find((s) => s.title === 'Retired step')
  assert.equal(disabled, undefined, 'a disabled node must not be imported')

  // The tutorial is the whole point of the feature.
  const measure = wf.steps.find((s) => s.title === 'Measure plot')
  assert.equal(measure.brief, '# Measure\nTape and drone.')
  assert.equal(measure.estimatedMinutes, 45)
  const kickoff = wf.steps.find((s) => s.title === 'Kickoff')
  assert.equal(kickoff.category, 'call')
  for (const s of wf.steps) {
    if (s.kind === 'step') assert.ok(typeof s.brief === 'string', `${s.title} lost its brief`)
  }
})

// The chain is not just display order — it is the authored SEQUENCE. Losing it
// makes a run dispatch every step in a stage at once, which for a 12-step SOP
// is twelve sessions all starting on work that was meant to happen in order.
test('the prev/next chain becomes a dependsOn chain, per sibling group', async () => {
  installFetch()
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId })
  const byTitle = Object.fromEntries(wf.steps.map((s) => [s.title, s]))

  // top level: Kickoff -> Site work -> Report
  assert.deepEqual(byTitle['Kickoff'].dependsOn, [], 'the first step waits on nothing')
  assert.deepEqual(byTitle['Site work'].dependsOn, [byTitle['Kickoff'].id])
  assert.deepEqual(byTitle['Report'].dependsOn, [byTitle['Site work'].id])

  // inside the stage, the chain restarts — a child does not depend on its uncle
  assert.deepEqual(
    byTitle['Measure plot'].dependsOn,
    [],
    'the first child of a stage starts the stage, it does not wait on a sibling of its parent',
  )
  assert.deepEqual(byTitle['Photograph'].dependsOn, [byTitle['Measure plot'].id])
  assert.deepEqual(byTitle['Liaisoning'].dependsOn, [byTitle['Photograph'].id])

  // and again one level deeper, inside the expanded reference
  assert.deepEqual(byTitle['File application'].dependsOn, [])
  assert.deepEqual(byTitle['Follow up'].dependsOn, [byTitle['File application'].id])
})

test('a node with children becomes a stage; leaves stay steps', async () => {
  installFetch()
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId })
  const byTitle = Object.fromEntries(wf.steps.map((s) => [s.title, s]))
  assert.equal(byTitle['Site work'].kind, 'stage', 'a group node is a stage')
  assert.equal(byTitle['Liaisoning'].kind, 'stage', 'an expanded reference is a stage')
  assert.equal(byTitle['Measure plot'].kind, 'step')
  assert.equal(byTitle['Report'].kind, 'step')
  assert.equal(byTitle['Measure plot'].parentId, byTitle['Site work'].id)
  assert.equal(byTitle['File application'].parentId, byTitle['Liaisoning'].id)
})

test('a reference node resolves its id as a FAMILY id and expands inline', async () => {
  const calls = installFetch()
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId })

  assert.ok(
    calls.some((u) => u.endsWith('/v1/org/sops')),
    'must list sops to resolve the family id',
  )
  assert.ok(
    calls.some((u) => u.endsWith('/v1/org/sops/sop-liaison-v2')),
    'must fetch the CURRENT family member by its own id',
  )
  assert.ok(
    !calls.some((u) => u.endsWith('/v1/org/sops/fam-liaison')),
    'must never fetch the family id as if it were a sop id - that 404s',
  )
  const filed = wf.steps.find((s) => s.title === 'File application')
  assert.equal(filed.brief, '# File it', 'referenced steps keep their tutorials')
  assert.equal(filed.source.originSopId, 'sop-liaison-v2', 'provenance points at the referenced sop')
})

test('attachments are found by the sop-node:<id> source convention', async () => {
  installFetch()
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId })
  const measure = wf.steps.find((s) => s.title === 'Measure plot')
  assert.equal(measure.attachments.length, 1)
  assert.equal(measure.attachments[0].name, 'plot-survey.pdf')
  const report = wf.steps.find((s) => s.title === 'Report')
  assert.equal(report.attachments.length, 0, 'another node’s file must not leak in')
})

test('a failing files endpoint degrades to no attachments, not a failed import', async () => {
  installFetch({ failFiles: true })
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId })
  assert.equal(wf.steps.length, 8, 'every step still imported')
  assert.ok(wf.steps.every((s) => s.attachments.length === 0))
})

test('an unreachable CRM fails with a message that says what to do', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  await assert.rejects(
    () => importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId }),
    /CRM unreachable/,
  )
})

test('a 401 tells you the token is the problem', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
  await assert.rejects(
    () => importCrmSop({ sopId: 'sop-main', baseUrl: BASE, makeId }),
    /MDV2_CRM_AGENT_TOKEN/,
  )
})

// The API is mounted at BOTH /v1/org and /org, and deployments disagree about
// which they actually serve: the hosted CRM answers /org/sops/:id and 404s the
// /v1 one. Assuming either prefix breaks half the deployments.
test('falls back from /v1/org to /org when /v1 is not mounted', async () => {
  const NO_V1 = 'http://crm-nov1.test' // fresh base — the prefix cache is per-URL
  const calls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/v1/')) return { ok: false, status: 404, json: async () => ({}) }
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (u.endsWith('/org/sops/sop-main')) return json({ sop: MAIN_SOP, nodes: MAIN_NODES })
    if (u.endsWith('/org/sops/sop-liaison-v2')) return json({ sop: LIAISON_SOP, nodes: LIAISON_NODES })
    if (u.endsWith('/org/sops')) return json({ sops: [{ id: 'sop-liaison-v2', familyId: 'fam-liaison', isCurrent: true }] })
    if (u.endsWith('/org/files')) return json({ files: FILES })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  seq = 0
  const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: NO_V1, makeId })
  assert.equal(wf.name, 'Feasibility', 'the import must succeed on the /org mount')
  assert.ok(calls.some((u) => u === `${NO_V1}/v1/org/sops/sop-main`), 'it should probe /v1 first')
  assert.ok(
    calls.some((u) => u === `${NO_V1}/org/sops/sop-main`),
    'and then fall back to the bare /org mount',
  )
})

// No agent token issued? Then it is username/password, and the CRM replies with
// an httpOnly crm_token cookie that every later GET has to carry.
test('logs in with username/password and carries the cookie on every GET', async () => {
  const LOGIN_BASE = 'http://crm-login.test'
  const saved = process.env.MDV2_CRM_AGENT_TOKEN
  delete process.env.MDV2_CRM_AGENT_TOKEN
  process.env.MDV2_CRM_USER = 'someone'
  process.env.MDV2_CRM_PASS = 'secret'

  const seen = []
  let logins = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/auth/login')) {
      logins++
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { username: 'someone', password: 'secret' })
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => ['crm_token=jwt123; Path=/; HttpOnly'], get: () => null },
        json: async () => ({ ok: true }),
        _shape: 'cookie',
      }
    }
    seen.push(init?.headers?.Cookie ?? null)
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (u.endsWith('/org/sops/sop-main')) return json({ sop: MAIN_SOP, nodes: [] })
    if (u.endsWith('/org/files')) return json({ files: [] })
    return { ok: false, status: 404, json: async () => ({}) }
  }

  try {
    seq = 0
    const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: LOGIN_BASE, makeId })
    assert.equal(wf.name, 'Feasibility')
    assert.equal(logins, 1, 'it must log in exactly once, not per request')
    assert.ok(seen.length > 0)
    assert.ok(
      seen.every((c) => typeof c === 'string' && c.includes('crm_token=jwt123')),
      'every data GET must carry the session cookie',
    )
  } finally {
    delete process.env.MDV2_CRM_USER
    delete process.env.MDV2_CRM_PASS
    if (saved) process.env.MDV2_CRM_AGENT_TOKEN = saved
  }
})

// A CRM backend deployed on a different origin from its front end often cannot
// set a usable cookie on an API client, and hands back the JWT in the body
// instead. Accepting only the cookie shape would make the import impossible
// against exactly the deployment the user actually has.
test('accepts a login that returns the JWT in the body instead of a cookie', async () => {
  const BODY_BASE = 'http://crm-bodytoken.test'
  const saved = process.env.MDV2_CRM_AGENT_TOKEN
  delete process.env.MDV2_CRM_AGENT_TOKEN
  process.env.MDV2_CRM_USER = 'someone'
  process.env.MDV2_CRM_PASS = 'secret'

  const auths = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/auth/login')) {
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [], get: () => null },
        json: async () => ({ token: 'a'.repeat(40) }),
      }
    }
    auths.push(init?.headers?.Authorization ?? null)
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (u.endsWith('/org/sops/sop-main')) return json({ sop: MAIN_SOP, nodes: [] })
    if (u.endsWith('/org/files')) return json({ files: [] })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  try {
    seq = 0
    const wf = await importCrmSop({ sopId: 'sop-main', baseUrl: BODY_BASE, makeId })
    assert.equal(wf.name, 'Feasibility')
    assert.ok(
      auths.every((a) => a === `Bearer ${'a'.repeat(40)}`),
      'the body token must be sent as a Bearer header',
    )
  } finally {
    delete process.env.MDV2_CRM_USER
    delete process.env.MDV2_CRM_PASS
    if (saved) process.env.MDV2_CRM_AGENT_TOKEN = saved
  }
})

test('a login that returns nothing usable names what it saw', async () => {
  const EMPTY = 'http://crm-empty.test'
  const saved = process.env.MDV2_CRM_AGENT_TOKEN
  delete process.env.MDV2_CRM_AGENT_TOKEN
  process.env.MDV2_CRM_USER = 'someone'
  process.env.MDV2_CRM_PASS = 'secret'
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { getSetCookie: () => ['other=1'], get: () => null },
    json: async () => ({ user: { id: 1 } }),
  })
  try {
    await assert.rejects(
      () => importCrmSop({ sopId: 'sop-main', baseUrl: EMPTY, makeId }),
      /Set-Cookie carried: other.*Body keys: user/s,
    )
  } finally {
    delete process.env.MDV2_CRM_USER
    delete process.env.MDV2_CRM_PASS
    if (saved) process.env.MDV2_CRM_AGENT_TOKEN = saved
  }
})

test('with no credentials at all, it says exactly which vars to set', async () => {
  const BARE = 'http://crm-bare.test'
  const saved = process.env.MDV2_CRM_AGENT_TOKEN
  delete process.env.MDV2_CRM_AGENT_TOKEN
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  try {
    await assert.rejects(
      () => importCrmSop({ sopId: 'sop-main', baseUrl: BARE, makeId }),
      /MDV2_CRM_USER and MDV2_CRM_PASS/,
    )
  } finally {
    if (saved) process.env.MDV2_CRM_AGENT_TOKEN = saved
  }
})
