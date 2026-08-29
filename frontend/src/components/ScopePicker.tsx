import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Lock, Search, X } from 'lucide-react'

/**
 * ScopePicker — what a floor is attached to, in two steps.
 *
 *   1. the KIND:  My tasks · Product/Service · Project
 *   2. WHICH one, when the kind needs it (My tasks spans every scope, so it
 *      needs no second step)
 *
 * WRITE-ONCE. Once a floor is attached it shows what it is attached to and
 * nothing else: no control to change it, because the server will not accept a
 * change either (setFloorScope). Agents are briefed on the board their floor
 * carries, so re-pointing it would leave running sessions working a list that
 * is no longer on screen. A different board means a different floor.
 *
 * The second step is a searchable combobox rather than a <select> because there
 * are 531 projects: a native dropdown of that length is a scroll-hunt, and its
 * type-ahead only matches from the first character, so "Martins Road" cannot be
 * found by typing "martins". Filtering on a substring is the whole point.
 *
 * Hand-rolled rather than pulled from a library: the app has no combobox
 * dependency and adding one for a single control would bring a second set of
 * styling conventions into a codebase with a strict one.
 */

export interface Scope {
  targetType: string
  targetId: string | null
  name: string
}

/* 'mine' is V2's own filter, not a CRM target_type — the CRM has no such scope,
   so the server resolves it against goals.ownerId across every scope. It sits
   here because it is the same question the other two answer: what should this
   floor be looking at. */
type Kind = 'mine' | 'service' | 'project'

const KINDS: { id: Kind; label: string }[] = [
  { id: 'mine', label: 'My tasks' },
  { id: 'service', label: 'Product / Service' },
  { id: 'project', label: 'Project' },
]

export function ScopePicker({
  scopes,
  value,
  onChange,
  readOnly = false,
}: {
  scopes: Scope[]
  value: { targetType: string; targetId: string | null } | null
  onChange: (next: { targetType: string; targetId: string | null }) => void
  /** Show the attachment without offering to set it. The board uses this: a
   *  floor is attached from its row in the sidebar, and one action in two
   *  places is what made the attachment look like it belonged to the agent. */
  readOnly?: boolean
}) {
  /* The kind follows the current value, but is also independently selectable —
     picking "Project" before choosing which one has to be a legal state, or the
     second step could never appear. */
  const [kind, setKind] = useState<Kind>((value?.targetType as Kind) ?? 'mine')
  useEffect(() => {
    if (value?.targetType) setKind(value.targetType as Kind)
  }, [value?.targetType])

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const options = useMemo(
    () => scopes.filter((s) => s.targetType === kind),
    [scopes, kind],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((s) => s.name.toLowerCase().includes(q))
  }, [options, query])

  const selected = useMemo(
    () =>
      value && value.targetId
        ? scopes.find((s) => s.targetId === value.targetId) ?? null
        : null,
    [scopes, value],
  )

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      /* focus after paint, or the click that opened it steals it back */
      const t = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
  }, [open])

  /** The one place an attachment is committed. Only ever reached while the
      floor is unattached — the attached case returns far above. */
  const commit = (next: { targetType: string; targetId: string | null }) => {
    onChange(next)
  }

  const choose = (s: Scope) => {
    setOpen(false)
    commit({ targetType: s.targetType, targetId: s.targetId })
  }

  const pickKind = (k: Kind) => {
    setKind(k)
    /* My tasks needs no second step, so selecting it IS the choice. The other
       two wait for a specific item rather than guessing one. */
    if (k === 'mine') commit({ targetType: 'mine', targetId: null })
    else setOpen(true)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => {
        const next = e.key === 'ArrowDown' ? c + 1 : c - 1
        return Math.max(0, Math.min(filtered.length - 1, next))
      })
      return
    }
    if (e.key === 'Enter' && filtered[cursor]) {
      e.preventDefault()
      choose(filtered[cursor])
    }
  }

  const label =
    kind === 'mine'
      ? 'Everything assigned to you'
      : selected
        ? selected.name
        : `Choose a ${kind === 'service' ? 'product or service' : 'project'}…`

  /* Unattached, and this instance is only here to report — say where to do it
     rather than leaving an empty space that looks broken. */
  if (value === null && readOnly) {
    return (
      <span className="min-w-0 flex-1 truncate font-display text-[13px] italic text-sand">
        Not attached — right-click this floor in the sidebar to attach it.
      </span>
    )
  }

  /* Already attached: show it, and offer nothing to change. Rendering a control
     the server would refuse is worse than rendering none — the user would learn
     the rule only by hitting a 409. */
  if (value !== null) {
    const attachedName =
      value.targetType === 'mine'
        ? (scopes.find((s) => s.targetType === 'mine')?.name ?? 'My tasks')
        : (selected?.name ?? 'a scope that is no longer listed')
    const kindLabel =
      value.targetType === 'mine'
        ? 'My tasks'
        : value.targetType === 'service'
          ? 'Product / Service'
          : value.targetType === 'project'
            ? 'Project'
            : value.targetType
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
          {kindLabel}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-display text-[13px] text-parchment"
          title={attachedName}
        >
          {attachedName}
        </span>
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim"
          title="A floor keeps the board it was attached to. Make a new floor for different work."
        >
          <Lock className="h-3 w-3" aria-hidden="true" />
          Fixed
        </span>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="flex min-w-0 flex-1 items-center gap-2">
      {/* — step 1: the kind, as a segmented control — */}
      <div
        role="group"
        aria-label="What this floor is attached to"
        className="flex shrink-0 items-stretch border border-hairline"
      >
        {KINDS.map((k) => {
          const on = kind === k.id
          return (
            <button
              key={k.id}
              type="button"
              aria-pressed={on}
              onClick={() => pickKind(k.id)}
              className={
                'cursor-pointer whitespace-nowrap px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 ' +
                (on ? 'bg-brass/10 text-brass' : 'text-sand hover:text-brass')
              }
            >
              {k.label}
            </button>
          )
        })}
      </div>

      {/* — step 2: which one. Absent for General, which is the whole org. — */}
      {kind !== 'mine' && (
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={
              'flex w-full min-w-0 cursor-pointer items-center gap-2 border px-2 py-1.5 text-left transition-colors duration-200 ' +
              (open ? 'border-brass' : 'border-hairline hover:border-brass')
            }
          >
            <span
              className={
                'min-w-0 flex-1 truncate font-display text-[12px] ' +
                (selected ? 'text-parchment' : 'text-sand-dim')
              }
            >
              {label}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
          </button>

          {open && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 border border-hairline bg-surface shadow-lg shadow-black/40">
              <div className="flex items-center gap-2 border-b border-hairline-s px-2">
                <Search className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setCursor(0)
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={`Search ${options.length} ${
                    kind === 'service' ? 'services' : 'projects'
                  }…`}
                  className="min-w-0 flex-1 bg-transparent py-2 font-display text-[12px] text-parchment outline-none placeholder:text-sand-dim"
                />
                {query !== '' && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear the search"
                    className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>

              <ul role="listbox" className="no-scrollbar max-h-[16rem] list-none overflow-y-auto">
                {filtered.length === 0 ? (
                  <li className="px-3 py-3 font-display text-[12px] italic text-sand-dim">
                    Nothing matches “{query}”.
                  </li>
                ) : (
                  filtered.slice(0, 200).map((s, i) => {
                    const isSel = selected?.targetId === s.targetId
                    return (
                      <li key={s.targetId ?? s.name}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSel}
                          onPointerEnter={() => setCursor(i)}
                          onClick={() => choose(s)}
                          className={
                            'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-display text-[12px] transition-colors duration-100 ' +
                            (i === cursor ? 'bg-surface-2/60 text-brass' : 'text-sand')
                          }
                        >
                          <Check
                            className={
                              'h-3 w-3 shrink-0 ' + (isSel ? 'text-brass' : 'text-transparent')
                            }
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        </button>
                      </li>
                    )
                  })
                )}
                {filtered.length > 200 && (
                  /* a cap, said out loud — a silently truncated list is how you
                     conclude a project does not exist when it is simply row 240 */
                  <li className="border-t border-hairline-s px-3 py-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                    {filtered.length - 200} more — keep typing to narrow
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
