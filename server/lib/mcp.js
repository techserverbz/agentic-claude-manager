// Configured MCP SERVERS — a read-only mirror of what Claude Code itself will
// connect to, parsed from <home>/.claude.json (the file `claude mcp add`
// writes). We read the JSON instead of shelling out to `claude mcp list` so the
// panel stays instant, works offline, and never spawns a process per refresh.
//
// SECURITY — the reason this file is so careful: an MCP entry carries an `env`
// block that in practice holds API keys and tokens. Those values MUST NOT leave
// this module. Callers get env KEY NAMES only, and every string we do emit
// (command, argv, url) is scrubbed first: anything that equals or contains a
// configured env value, follows a --token/--key/--secret/--password style flag,
// or simply looks like an opaque credential becomes '<redacted>'. The trade is
// deliberate — a hidden argument is a cosmetic annoyance, a leaked token is not
// — so ambiguous values are redacted rather than shown.
//
// Nothing is cached: `claude mcp add` and hand edits rewrite the config behind
// our back, so every call re-reads from disk. Nothing throws either — a missing
// or corrupt config just means "no servers to show" ([]).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REDACTED = '<redacted>'

// .claude.json also stores per-project history, so it grows; well past this it
// is not something we can afford to parse synchronously inside a request.
const MAX_CONFIG_BYTES = 32 * 1024 * 1024

// Env values shorter than this are things like "1", "true" or "dev" — matching
// those as substrings would shred harmless argv, and they are not credentials.
const MIN_ENV_VALUE_LENGTH = 6

// Flag names whose VALUE is a credential by definition. Tested against the flag
// with punctuation stripped, so --key, --api-key, --authToken and --password
// all hit while --transport, --browserUrl and --user-data-dir do not.
const SECRET_FLAG_RE = /(?:key|token|secret|password|passwd|pwd|auth|bearer|credential|pat)s?$/

// A credential carried INSIDE one argument, where the flag rules cannot see it:
// `--header "Authorization: Bearer sk-..."`, `--set token=abc`. Everything from
// the label to the end of the argument goes, so a value with spaces in it (or a
// scheme word like "Bearer" in front) cannot leave a tail behind; the label is
// kept so the argument still says which header/field it set.
const INLINE_SECRET_RE =
  /((?:authorization|(?:api[-_ ]?)?key|(?:access[-_ ]?)?token|secret|password|passwd|pwd|credential)["'\s]*[:=]\s*)[\s\S]+$/i
const BEARER_RE = /(\bBearer\s+)\S+/i

// Credential shapes that announce themselves regardless of length.
const SECRET_PREFIX_RE =
  /^(?:sk-|sk_|pk_live|rk_live|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abeoprs]-|AKIA|ASIA|AIza|ya29\.|glpat-|npm_|dckr_pat_|hf_|Bearer\s|eyJ[A-Za-z0-9_-]{8,}\.)/

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const warned = new Set()
function warnOnce(message) {
  // The panel polls this endpoint; log each distinct problem once so a broken
  // config stays discoverable without flooding the server log.
  if (warned.has(message)) return
  warned.add(message)
  console.error(message)
}

// CLAUDE_CONFIG_DIR relocates Claude Code's whole config directory and the JSON
// moves with it; the home-directory copy stays the normal case.
function configCandidates() {
  const dir = process.env.CLAUDE_CONFIG_DIR
  const paths = []
  if (typeof dir === 'string' && dir.trim()) paths.push(path.join(dir.trim(), '.claude.json'))
  paths.push(path.join(os.homedir(), '.claude.json'))
  return paths
}

// The first readable candidate decides — if it is corrupt we show nothing
// rather than quietly listing some other file's servers.
function readConfig() {
  for (const file of configCandidates()) {
    let raw
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > MAX_CONFIG_BYTES) {
        warnOnce(`${file} is ${stat.size} bytes — too large to parse for the MCP panel; skipping`)
        continue
      }
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue // not installed / unreadable — try the next candidate, else none
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch (err) {
      // Claude Code rewrites this file constantly, so a torn read is plausible
      // and transient — report once and show nothing rather than erroring.
      warnOnce(`${file} is not valid JSON (${err?.message}); MCP servers unavailable`)
    }
    return null
  }
  return null
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

function isSecretFlag(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('-')) return false
  const name = arg.replace(/^-+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  return name.length > 0 && SECRET_FLAG_RE.test(name)
}

// Paths and URLs are long and opaque-looking, but they are exactly what the
// panel exists to show — clear them before the entropy heuristics run.
function looksLikePathOrUrl(v) {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v) || // scheme://host
    /^[A-Za-z]:[\\/]/.test(v) || // C:\Users\...
    /^[.~]{0,2}[\\/]/.test(v) || // /abs, ./rel, ../rel, ~/rel
    (/[\\/]/.test(v) && /\.[A-Za-z0-9]{1,8}$/.test(v)) // dist/server/entry.mjs
  )
}

function looksLikeSecretValue(v) {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (SECRET_PREFIX_RE.test(s)) return true
  if (s.length < 20) return false
  if (/\s/.test(s) || looksLikePathOrUrl(s)) return false
  if (UUID_RE.test(s)) return true // as often a room/session key as a plain id
  if (/^[A-Fa-f0-9]{20,}$/.test(s)) return true // hex digest / raw key
  if (/^[a-z0-9]{28,}$/.test(s)) return true // long unbroken opaque id
  // base64 / base64url with genuine case mixing — a package spec like
  // "chrome-devtools-mcp@latest" never satisfies all three classes at once.
  return (
    /^[A-Za-z0-9_\-+=/.]{20,}$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)
  )
}

// The strongest rule we have: whatever the env block holds, that exact text can
// never appear in the output — people do paste the same token into both env and
// argv. The comparison happens here; the values themselves never escape.
function scrubEnvValues(value, envValues) {
  let out = value
  for (const secret of envValues) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

function redactInlineSecrets(value) {
  // Bearer first: "Authorization: Bearer x" must lose x even though the label
  // rule below would otherwise stop at the word "Bearer".
  return value
    .replace(BEARER_RE, (_m, label) => `${label}${REDACTED}`)
    .replace(INLINE_SECRET_RE, (_m, label) => `${label}${REDACTED}`)
}

function sanitizeUrl(url, envValues) {
  const cleaned = scrubEnvValues(url, envValues)
  let parsed
  try {
    parsed = new URL(cleaned)
  } catch {
    // Not parseable (a template, or already redacted) — give it the same
    // treatment argv gets.
    return looksLikeSecretValue(cleaned) ? REDACTED : cleaned
  }
  // https://user:token@host — credentials in the authority are still credentials.
  if (parsed.username || parsed.password) {
    parsed.username = REDACTED
    parsed.password = ''
  }
  for (const key of [...parsed.searchParams.keys()]) {
    const name = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
    if (SECRET_FLAG_RE.test(name) || looksLikeSecretValue(parsed.searchParams.get(key))) {
      parsed.searchParams.set(key, REDACTED)
    }
  }
  // The fragment is never needed to REACH an MCP endpoint — a server connects to
  // origin+path+query — but a token parked there (…/sse#tok_live_…) survived every
  // check above and reached the browser verbatim. Drop it wholesale rather than
  // trying to classify what is inside it.
  parsed.hash = ''
  // Some hosted MCP endpoints put the key in the path (…/mcp/<token>/sse).
  parsed.pathname = parsed.pathname
    .split('/')
    .map((segment) => (looksLikeSecretValue(segment) ? REDACTED : segment))
    .join('/')
  return parsed.toString().replace(/%3Credacted%3E/gi, REDACTED)
}

function sanitizeArgs(rawArgs, envValues, allEnvValues = new Set()) {
  if (!Array.isArray(rawArgs)) return []
  const out = []
  let afterSecretFlag = false
  for (const raw of rawArgs) {
    // argv is strings; tolerate a hand-written number/boolean, drop anything
    // else rather than stringifying an object into the response.
    let arg
    if (typeof raw === 'string') arg = raw
    else if (typeof raw === 'number' || typeof raw === 'boolean') arg = String(raw)
    else continue

    const eq = arg.startsWith('-') ? arg.indexOf('=') : -1
    if (eq > 0 && isSecretFlag(arg.slice(0, eq))) {
      // --token=abc keeps the flag (useful) and loses the value.
      out.push(`${arg.slice(0, eq)}=${REDACTED}`)
      afterSecretFlag = false
      continue
    }

    // A bare value right after --token/--key/... is the credential itself; a
    // following flag is not, so `--token --verbose` stays readable.
    if (afterSecretFlag && !arg.startsWith('-')) {
      out.push(REDACTED)
      afterSecretFlag = false
      continue
    }

    // Short env values are deliberately kept out of the substring blocklist (a
    // 3-char value would shred every command line), but an argv entry that is
    // EXACTLY an env value is that secret regardless of length — check equality
    // separately so {PIN:"a1b2c"} in ["--pin","a1b2c"] cannot slip through.
    if (allEnvValues.has(arg)) {
      out.push(REDACTED)
      afterSecretFlag = false
      continue
    }
    const scrubbed = redactInlineSecrets(scrubEnvValues(arg, envValues))
    out.push(scrubbed !== arg ? scrubbed : looksLikeSecretValue(arg) ? REDACTED : arg)
    afterSecretFlag = eq < 0 && isSecretFlag(arg)
  }
  return out
}

function toServer(name, config, scope, project) {
  if (!name || typeof name !== 'string') return null
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null

  const env =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {}
  // NAMES only. This is the one place env is read, and the values below leave
  // the module solely as a redaction blocklist.
  const envKeys = Object.keys(env)
    .filter((k) => typeof k === 'string' && k.trim())
    .sort((a, b) => a.localeCompare(b))
  const envValues = Object.values(env)
    .filter((v) => typeof v === 'string' && v.length >= MIN_ENV_VALUE_LENGTH)
    // longest first: a value that contains another still gets redacted whole
    .sort((a, b) => b.length - a.length)
  // EVERY value regardless of length, for exact-match argv comparison. Short
  // values are unusable as a substring blocklist (they would shred ordinary
  // command lines) but are still secrets when an argv entry IS one.
  const allEnvValues = new Set(Object.values(env).filter((v) => typeof v === 'string' && v))

  const transport = str(config.type).trim().toLowerCase() || 'stdio'
  // stdio spawns a binary, sse/http dial a URL. The cross fallback keeps a
  // legacy or mistyped entry from rendering as an empty row.
  const rawCommand =
    transport === 'stdio'
      ? str(config.command) || str(config.url)
      : str(config.url) || str(config.command)
  let command
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawCommand)) {
    command = sanitizeUrl(rawCommand, envValues)
  } else {
    // A real command is a binary name or a path, neither of which trips the
    // credential heuristics — so if this one does, it is not a command.
    const scrubbed = scrubEnvValues(rawCommand, envValues)
    command =
      scrubbed !== rawCommand ? scrubbed : looksLikeSecretValue(rawCommand) ? REDACTED : rawCommand
  }

  const server = {
    name,
    transport,
    command,
    args: sanitizeArgs(config.args, envValues, allEnvValues),
    scope,
    envKeys,
  }
  if (scope === 'project') server.project = project
  return server
}

function collect(map, scope, project, out) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return
  for (const [name, config] of Object.entries(map)) {
    const server = toServer(name, config, scope, project)
    if (server) out.push(server)
  }
}

const byName = (a, b) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
  a.name.localeCompare(b.name) ||
  String(a.project || '').localeCompare(String(b.project || ''))

/**
 * Every MCP server configured on this machine: user scope first, then project
 * scope, each alphabetical by name. Never throws; [] when there is no config.
 * @returns {Array<{name:string,transport:string,command:string,args:string[],scope:'user'|'project',project?:string,envKeys:string[]}>}
 */
export function listMcpServers() {
  try {
    const config = readConfig()
    if (!config) return []

    const user = []
    collect(config.mcpServers, 'user', undefined, user)

    const project = []
    const projects = config.projects
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [dir, entry] of Object.entries(projects)) {
        if (!dir || !entry || typeof entry !== 'object') continue
        collect(entry.mcpServers, 'project', dir, project)
      }
    }

    user.sort(byName)
    project.sort(byName)
    return [...user, ...project]
  } catch (err) {
    // A side panel is never worth a 500 — whatever broke, report nothing.
    warnOnce(`listMcpServers failed (${err?.message})`)
    return []
  }
}
