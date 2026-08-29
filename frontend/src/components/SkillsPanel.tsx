import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpen, ChevronDown, RefreshCw, Search, X } from 'lucide-react'
import { api } from '../lib/api'
import type { Skill } from '../lib/api'

/**
 * SkillsPanel — a browsable list of the SKILL.md folders Claude has installed.
 *
 * The design problem here is the descriptions. Skill frontmatter is written to
 * be matched by a model, not read by a person, so a description is routinely
 * sixty-plus words of trigger phrases. Rendered raw, this panel is a wall of
 * prose nobody can scan. Three decisions below exist only to fix that:
 *   · the NAME is the row and the description sits under it, clamped to three
 *     lines — you scan names, then read the one you stopped on;
 *   · the prose is held to a ~72ch measure, so a wide pane can't stretch a line
 *     out to two hundred characters;
 *   · a search hit that lands past the clamp slides the visible window down to
 *     the match (see `excerpt`), so a row always shows WHY it matched.
 *
 * Scope is a per-row chip, NOT a group header — the list is sorted
 * user → project → plugin, so like still sits with like without spending
 * vertical space on section labels.
 *
 * The server re-reads the skill folders on every request (the user edits them
 * outside this app), so the header carries a reload rather than a cache.
 */

/** default sort order — the ones you installed by hand read first */
const SCOPE_RANK: Record<Skill['scope'], number> = { user: 0, project: 1, plugin: 2 }

/** Roughly where a description outgrows the three-line clamp at this type size.
    A heuristic on purpose: it only decides whether a row offers "Read more", so
    getting it slightly wrong costs a no-op toggle, never a hidden line. */
const CLAMP_CHARS = 190

/** how much of the sentence BEFORE a deep search hit to keep, so an excerpt
    opens with context instead of starting mid-match */
const EXCERPT_LEAD = 48

/**
 * The slice of a description to show while it is clamped. Normally that is the
 * description itself (the clamp takes the head), but when the query matches
 * only deep in the body — past the three visible lines — the head shows nothing
 * relevant and the row reads as a false positive. In that case start the text
 * just before the hit and mark the cut with an ellipsis.
 */
function excerpt(text: string, q: string): string {
  if (q === '') return text
  const at = text.toLowerCase().indexOf(q)
  // -1 (this row matched on its name) or already inside the head: leave it be
  if (at <= EXCERPT_LEAD) return text
  let start = at - EXCERPT_LEAD
  const space = text.indexOf(' ', start)
  if (space !== -1 && space < at) start = space + 1 // don't open mid-word
  return `…${text.slice(start)}`
}

/** brass-ink the query inside a string, so the eye lands on the hit instead of
    hunting for it through a paragraph of trigger phrases */
function highlight(text: string, q: string): ReactNode {
  if (q === '') return text
  const hay = text.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  for (;;) {
    const at = hay.indexOf(q, i)
    if (at === -1) break
    if (at > i) out.push(text.slice(i, at))
    out.push(
      <mark key={at} className="bg-transparent text-brass">
        {text.slice(at, at + q.length)}
      </mark>,
    )
    i = at + q.length
  }
  if (i === 0) return text // no hit in this field — the other one matched
  out.push(text.slice(i))
  return out
}

/** last segment of a project dir — the whole absolute path is noise inside a row */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? p : parts[parts.length - 1]
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** which rows are open, keyed by `dir` (the one field unique per skill) */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void api
      .getSkills()
      .then((list) => setSkills(list))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not read the installed skills.'),
      )
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const q = query.trim().toLowerCase()

  /* the sort IS the grouping: scope rank first, then name. Recomputed on the
     fetch, not on every keystroke — the filter below is the per-keystroke pass. */
  const sorted = useMemo(
    () =>
      [...skills].sort(
        (a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || a.name.localeCompare(b.name),
      ),
    [skills],
  )
  const visible = useMemo(
    () =>
      q === ''
        ? sorted
        : sorted.filter(
            (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
          ),
    [sorted, q],
  )

  const total = skills.length
  const count =
    loading && total === 0
      ? 'Reading…'
      : visible.length !== total
        ? `${visible.length} of ${total}`
        : `${total} skill${total === 1 ? '' : 's'}`

  return (
    <section
      aria-label="Skills"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-midnight"
    >
      <header className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-5 py-3 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
        <span className="h-px w-6 bg-hairline" aria-hidden="true" />
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        <span>Skills</span>
        <span
          aria-live="polite"
          className="ml-auto border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim"
        >
          {count}
        </span>
        {/* the folders are edited on disk, outside this app — so a reload is the
            whole refresh story; there is nothing cached here to invalidate */}
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label="Reload skills"
          title="Reload — skills are edited on disk, outside this app"
          className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </header>

      {/* search sits outside the scroll container so it stays put, and is drawn
          only once there is something to search — no dead control on a fresh
          machine, and none while the first read is still in flight */}
      {total > 0 && (
        <div className="shrink-0 border-b border-hairline-s px-5 py-3">
          <div className="flex items-center gap-2 border border-hairline px-3 transition-colors duration-200 focus-within:border-brass">
            <Search className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
              placeholder="Search skills by name & description…"
              spellCheck={false}
              aria-label="Search skills"
              className="w-full bg-transparent py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none"
            />
            {query !== '' && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        {error !== null && (
          <p
            role="alert"
            className="mx-5 mt-4 border border-[#cf6b52] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#cf6b52]"
          >
            {error}
          </p>
        )}

        {loading && total === 0 ? (
          <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
            Reading the skill folders…
          </p>
        ) : total === 0 ? (
          /* a failed read already said so above — don't also claim "none installed" */
          error === null && (
            <div className="mx-auto flex max-w-md flex-col items-center px-8 py-12 text-center">
              <BookOpen className="mb-5 h-7 w-7 text-sand-dim" aria-hidden="true" />
              <h2 className="font-display text-[20px] font-medium leading-tight text-parchment">
                No skills <em className="font-normal italic text-brass">installed</em>
              </h2>
              <p className="mt-3.5 font-display text-[14px] italic leading-relaxed text-sand">
                A skill is a folder with a{' '}
                <span className="font-mono not-italic text-sand-dim">SKILL.md</span> inside it. Put
                one in <span className="font-mono not-italic text-sand-dim">~/.claude/skills</span>{' '}
                to have it everywhere, or in a project’s{' '}
                <span className="font-mono not-italic text-sand-dim">.claude/skills</span> to keep
                it to that project — either way it shows up here.
              </p>
              <span className="mo-rule mt-7" aria-hidden="true" />
            </div>
          )
        ) : visible.length === 0 ? (
          <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
            No skill matches “{query.trim()}”.
          </p>
        ) : (
          <ul className="divide-y divide-hairline-s">
            {visible.map((s) => {
              const open = expanded[s.dir] === true
              // `|| open` keeps a way back out of a row that was expanded before
              // a reload shortened its description
              const toggleable = s.description.length > CLAMP_CHARS || open
              const body = open ? s.description : excerpt(s.description, q)
              return (
                <li key={s.dir} className="px-5 py-4">
                  <div className="flex items-baseline gap-3">
                    <h3 className="min-w-0 flex-1 truncate font-display text-[15px] font-medium leading-snug text-parchment">
                      {highlight(s.name, q)}
                    </h3>
                    {/* which project lends this skill — only project scope has one */}
                    {s.scope === 'project' && s.project !== undefined && s.project !== '' && (
                      <span
                        title={s.project}
                        className="max-w-[10rem] shrink-0 truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim"
                      >
                        {basename(s.project)}
                      </span>
                    )}
                    <span className="shrink-0 border border-hairline-s px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                      {s.scope}
                    </span>
                  </div>

                  {s.description === '' ? (
                    <p className="mt-1.5 font-display text-[13px] italic leading-relaxed text-sand-dim">
                      No description in this skill’s frontmatter.
                    </p>
                  ) : (
                    <p
                      className={`mt-1.5 max-w-[72ch] font-display text-[13px] leading-relaxed text-sand ${
                        open ? '' : 'line-clamp-3'
                      }`}
                    >
                      {highlight(body, q)}
                    </p>
                  )}

                  {toggleable && (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Read the full description of'} ${s.name}`}
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [s.dir]: !(prev[s.dir] === true) }))
                      }
                      className="mt-2 flex cursor-pointer items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim transition-colors duration-150 hover:text-brass"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                      {open ? 'Less' : 'Read more'}
                    </button>
                  )}

                  {/* the path only earns its line once you've opened the row */}
                  {open && (
                    <p
                      title={s.dir}
                      className="mt-2.5 truncate font-mono text-[10px] tracking-[0.04em] text-sand-dim"
                    >
                      {s.dir}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
