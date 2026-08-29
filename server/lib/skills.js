// SKILLS — read-only discovery of the Claude Code SKILLS installed on this
// machine, so a chat's available skills can be shown next to its sessions.
//
// A skill is a folder holding a SKILL.md whose YAML frontmatter carries the
// `name` + `description` the CLI matches against. Three places install them:
//   user    <homedir>/.claude/skills/<slug>/SKILL.md
//   project <project.claudeDir>/skills/<slug>/SKILL.md   (per registered project)
//   plugin  <homedir>/.claude/plugins/**/skills/<slug>/SKILL.md
// The plugin tree needs a walk rather than a fixed path: a plugin lands under
// plugins/<name>/skills, plugins/cache/<marketplace>/<name>/<version>/skills,
// plugins/marketplaces/<mp>/plugins/<name>/skills, and some ship their skills
// one level deeper under a nested .claude/ — all real layouts on disk.
//
// Everything here is SYNCHRONOUS and NEVER throws (the HTTP layer wants a
// plain array), and nothing is cached: the user edits these folders outside
// the app, so a stale list would be worse than a re-scan of a few hundred
// directories on a local disk.

import fs from 'node:fs'
import path from 'node:path'
import { GLOBAL_CLAUDE_DIR, listProjects, normalizeFsPath, samePath } from './projects.js'

// Keep the API response small: descriptions are prose paragraphs meant for the
// model's skill matcher and routinely run past 1 KB.
const DESCRIPTION_MAX = 400
const NAME_MAX = 120

// Only the head of SKILL.md is frontmatter; the body can be tens of KB of
// instructions we have no use for. 64 KB clears the longest real frontmatter
// by orders of magnitude.
const HEAD_BYTES = 64 * 1024

// Depth of the plugins walk, counted in folders below plugins/. The deepest
// real layout is cache/<marketplace>/<plugin>/<version>/.claude/skills = 6;
// the extra level is headroom, and the cap is what stops a symlink loop.
const MAX_PLUGIN_DEPTH = 7

const SKIP_DIRS = new Set(['node_modules', '.git', '.bin', 'marketplaces'])

// ---------------------------------------------------------------------------
// fs helpers — every call is wrapped; a missing directory is simply no skills
// ---------------------------------------------------------------------------

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// Dirent.isDirectory() is false for a symlinked folder, and people do symlink
// skills in from a dotfiles repo — resolve those before writing them off.
function isDirEntry(entry, parent) {
  try {
    if (entry.isDirectory()) return true
    if (!entry.isSymbolicLink()) return false
    return fs.statSync(path.join(parent, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** First HEAD_BYTES of a file as utf8, '' on any failure. */
function readHead(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.toString('utf8', 0, read)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

// YAML-ish, deliberately: we want two scalars out of a file we do not control,
// not a parser. Values in the wild are bare, single-quoted, double-quoted, or
// a `|` / `>` block — all four appear in the skills shipped with the CLI.
function unquote(value) {
  if (value.length < 2) return value
  const q = value[0]
  if (q !== '"' && q !== "'") return value
  if (value[value.length - 1] !== q) return value
  const inner = value.slice(1, -1)
  return q === '"' ? inner.replace(/\\(["\\/])/g, '$1') : inner.replace(/''/g, "'")
}

// One line of display, always: literal blocks keep their newlines and folded
// blocks their wrapping, and neither survives a JSON list in a side panel.
function flatten(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value, max) {
  if (value.length <= max) return value
  return value.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Pull `name` / `description` out of the leading `---` block.
 * Returns empty strings when there is no frontmatter, when it never closes, or
 * when the keys are absent — the caller falls back to the folder name.
 */
function parseFrontmatter(text) {
  const result = { name: '', description: '' }
  if (!text) return result
  // A BOM would hide the opening fence.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split(/\r?\n/)
  if (lines[0].trim() !== '---') return result

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---' || t === '...') {
      end = i
      break
    }
  }
  if (end === -1) return result // unterminated (or truncated by HEAD_BYTES)

  for (let i = 1; i < end; i++) {
    // Column 0 only: anything indented belongs to the value above it, which is
    // exactly what keeps block-scalar text from being read as a key.
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]?(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1].toLowerCase()
    if (key !== 'name' && key !== 'description') continue

    let value = match[2]
    if (/^[|>][-+]?\d*[ \t]*$/.test(value.trim())) {
      const chunk = []
      let j = i + 1
      for (; j < end; j++) {
        const line = lines[j]
        if (!line.trim()) {
          chunk.push('')
          continue
        }
        if (!/^[ \t]/.test(line)) break // dedent ends the block
        chunk.push(line.trim())
      }
      value = chunk.join(' ')
      i = j - 1
    }
    result[key] = flatten(unquote(value.trim()))
  }
  return result
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** One skill folder -> a Skill, or null when it holds no SKILL.md. */
function readSkill(dir, slug, scope, project) {
  const file = path.join(dir, 'SKILL.md')
  if (!isFile(file)) return null
  const front = parseFrontmatter(readHead(file))
  const skill = {
    name: clip(front.name || slug, NAME_MAX),
    description: clip(front.description, DESCRIPTION_MAX),
    scope,
    dir,
  }
  if (project) skill.project = project
  return skill
}

/** Every <root>/<slug>/SKILL.md under one skills root. */
function scanSkillsRoot(root, scope, project, out) {
  for (const entry of readDirSafe(root)) {
    // A slug never starts with a dot; what does is editor/VCS debris.
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    if (!isDirEntry(entry, root)) continue
    const skill = readSkill(path.join(root, entry.name), entry.name, scope, project)
    if (skill) out.push(skill)
  }
}

/** Collect every folder literally named `skills` below the plugins root. */
function collectPluginSkillRoots(dir, depth, out) {
  if (depth > MAX_PLUGIN_DEPTH) return
  for (const entry of readDirSafe(dir)) {
    if (SKIP_DIRS.has(entry.name)) continue
    if (!isDirEntry(entry, dir)) continue
    const child = path.join(dir, entry.name)
    if (entry.name === 'skills') {
      out.push(child) // its children are slugs, not more plugin tree
      continue
    }
    collectPluginSkillRoots(child, depth + 1, out)
  }
}

function rootKey(dir) {
  const norm = normalizeFsPath(dir)
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every installed skill, sorted by name. Never throws; returns [] if nothing
 * is readable. Not cached — see the note at the top of the file.
 */
export function listSkills() {
  const found = []
  try {
    const seenRoots = new Set()

    // user
    const userRoot = path.join(GLOBAL_CLAUDE_DIR, 'skills')
    seenRoots.add(rootKey(userRoot))
    scanSkillsRoot(userRoot, 'user', null, found)

    // project — only for projects pointed at their OWN claudeDir. Most inherit
    // the global one, and scanning that again would re-list the whole user set
    // once per registered project.
    let projects = []
    try {
      projects = listProjects()
    } catch {
      projects = []
    }
    for (const project of projects) {
      if (!project?.claudeDir || samePath(project.claudeDir, GLOBAL_CLAUDE_DIR)) continue
      const root = path.join(project.claudeDir, 'skills')
      const key = rootKey(root)
      if (seenRoots.has(key)) continue // two projects sharing one claudeDir
      seenRoots.add(key)
      scanSkillsRoot(root, 'project', project.fileDir, found)
    }

    // plugin
    const pluginRoots = []
    collectPluginSkillRoots(path.join(GLOBAL_CLAUDE_DIR, 'plugins'), 1, pluginRoots)
    for (const root of pluginRoots) {
      const key = rootKey(root)
      if (seenRoots.has(key)) continue
      seenRoots.add(key)
      scanSkillsRoot(root, 'plugin', null, found)
    }
  } catch {
    // Any surprise (permissions, a hostile symlink loop) leaves whatever we
    // already collected rather than failing the whole request.
  }

  // The same plugin sits on disk several times over — one copy per cached
  // version, again under its marketplace — so collapse by (scope, name), and
  // let a user-installed skill hide the plugin copy of the same name.
  const userNames = new Set()
  for (const skill of found) {
    if (skill.scope === 'user') userNames.add(skill.name.toLowerCase())
  }
  // Deterministic order BEFORE dedupe, so which duplicate survives is stable
  // across runs rather than whatever readdir happened to yield first.
  found.sort((a, b) => a.dir.localeCompare(b.dir))

  const seen = new Set()
  const skills = []
  for (const skill of found) {
    const lower = skill.name.toLowerCase()
    if (skill.scope === 'plugin' && userNames.has(lower)) continue
    // project is part of the identity: two projects may each ship a skill of the
    // same name, and both are real.
    const key = `${skill.scope} ${skill.project || ''} ${lower}`
    if (seen.has(key)) continue
    seen.add(key)
    skills.push(skill)
  }

  skills.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    // Stable order when two scopes carry the same name (user before plugin).
    return byName !== 0 ? byName : a.scope.localeCompare(b.scope) || a.dir.localeCompare(b.dir)
  })
  return skills
}
