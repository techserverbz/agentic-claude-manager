import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Crown, Search } from 'lucide-react'

/**
 * AgentPicker — which agent a window is showing.
 *
 * A combobox, not a <select>: it filters as you type, it is keyboard-driven,
 * it groups by floor, and it shows whether each agent is actually running —
 * none of which a native select can do.
 *
 * Hand-rolled rather than pulled from a component library because this app has
 * one design system (brass on midnight, hairline rules, mono labels) and no
 * shadcn anywhere; importing a second set of conventions for one dropdown
 * would show. Same reasoning as the scope and assignee pickers already here.
 *
 * The menu is positioned FIXED from the trigger's rect rather than absolutely
 * inside it: the window it lives in clips its overflow, and an absolutely
 * positioned menu would be cut off at the pane edge — the one thing a picker
 * must never be.
 */

export interface AgentOption {
  key: string
  name: string
  floorName: string
  isBoss: boolean
  live: boolean
  hasChat: boolean
}

/** first letters of a name — "Angela" → A, "Jim Halpert" → JH */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0] ?? '').join('').toUpperCase() || '?'
}

export function AgentPicker({
  value,
  options,
  showFloor,
  onChange,
}: {
  value: string
  options: AgentOption[]
  /** only worth the room when more than one floor is on screen */
  showFloor: boolean
  onChange: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const current = options.find((o) => o.key === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.floorName.toLowerCase().includes(q),
    )
  }, [options, query])

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const width = Math.max(r.width, 232)
    setPos({
      left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8),
      top: r.bottom + 4,
      width,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(Math.max(0, options.findIndex((o) => o.key === value)))
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, options, value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    /* The menu is fixed, so it would hang in mid-air if what is under it moved. */
    const close = () => setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const choose = (k: string) => {
    setOpen(false)
    onChange(k)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      btnRef.current?.focus()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => {
        const n = e.key === 'ArrowDown' ? c + 1 : c - 1
        return Math.max(0, Math.min(filtered.length - 1, n))
      })
      return
    }
    if (e.key === 'Enter' && filtered[cursor]) {
      e.preventDefault()
      choose(filtered[cursor].key)
    }
  }

  /* Grouped by floor, in the order the floors arrive. A flat list of eight
     names on two floors makes you read every row to find the one you mean. */
  const groups = useMemo(() => {
    const out: { floor: string; items: AgentOption[] }[] = []
    for (const o of filtered) {
      const g = out.find((x) => x.floor === o.floorName)
      if (g) g.items.push(o)
      else out.push({ floor: o.floorName, items: [o] })
    }
    return out
  }, [filtered])

  let flatIndex = -1

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Which agent this window shows"
        title="Show a different agent in this window"
        onClick={() => setOpen((o) => !o)}
        className={
          'group flex min-w-0 max-w-[13rem] cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 transition-colors duration-200 ' +
          (open
            ? 'border-brass bg-brass/10'
            : 'border-transparent hover:border-hairline hover:bg-white/[0.03]')
        }
      >
        {/* a small monogram, so a window is identifiable at a glance even when
            the name is truncated */}
        <span
          className={
            'flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[9px] font-semibold ' +
            (current?.isBoss ? 'bg-brass/20 text-brass' : 'bg-surface-2 text-sand')
          }
          aria-hidden="true"
        >
          {current ? initials(current.name) : '?'}
        </span>
        <span className="min-w-0 flex-1 truncate text-left font-display text-[13px] leading-tight text-parchment">
          {current?.name ?? 'Pick an agent'}
        </span>
        {current?.live && <span className="mo-live-dot shrink-0" role="img" aria-label="running" />}
        <ChevronDown
          className={
            'h-3 w-3 shrink-0 transition-[transform,color] duration-200 ' +
            (open ? 'rotate-180 text-brass' : 'text-sand-dim group-hover:text-brass')
          }
          aria-hidden="true"
        />
      </button>

      {open &&
        pos !== null &&
        /* PORTALLED TO <body>. Each window is a positioned, z-indexed section, and
           a z-index only ever competes INSIDE its own stacking context — so a
           menu rendered in place, however high its z-index, still painted behind
           the next window along. A portal is the only thing that escapes that. */
        createPortal(
        <div
          ref={menuRef}
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className="fixed z-50 overflow-hidden rounded-lg border border-hairline bg-surface shadow-2xl shadow-black/60"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 border-b border-hairline-s px-2.5">
            <Search className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
              placeholder="Search agents…"
              aria-label="Search agents"
              className="min-w-0 flex-1 bg-transparent py-2 font-display text-[12.5px] text-parchment outline-none placeholder:text-sand-dim"
            />
          </div>

          <div role="listbox" aria-label="Agents" className="no-scrollbar max-h-[46vh] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 font-display text-[12px] italic text-sand-dim">
                Nobody matches “{query}”.
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.floor}>
                  {showFloor && (
                    <p className="px-2.5 pb-0.5 pt-1.5 font-mono text-[8.5px] uppercase tracking-[0.22em] text-sand-dim">
                      {g.floor}
                    </p>
                  )}
                  {g.items.map((o) => {
                    flatIndex += 1
                    const idx = flatIndex
                    const on = o.key === value
                    const hot = idx === cursor
                    return (
                      <button
                        key={o.key}
                        type="button"
                        role="option"
                        aria-selected={on}
                        onPointerEnter={() => setCursor(idx)}
                        onClick={() => choose(o.key)}
                        className={
                          'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-100 ' +
                          (hot ? 'bg-surface-2/70' : '')
                        }
                      >
                        <Check
                          className={'h-3 w-3 shrink-0 ' + (on ? 'text-brass' : 'text-transparent')}
                          aria-hidden="true"
                        />
                        <span
                          className={
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[9px] font-semibold ' +
                            (o.isBoss ? 'bg-brass/20 text-brass' : 'bg-surface-2 text-sand')
                          }
                          aria-hidden="true"
                        >
                          {initials(o.name)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={
                              'flex items-center gap-1 truncate font-display text-[12.5px] leading-tight ' +
                              (on ? 'text-brass' : 'text-parchment')
                            }
                          >
                            {o.name}
                            {o.isBoss && (
                              <Crown className="h-2.5 w-2.5 shrink-0 text-brass" aria-hidden="true" />
                            )}
                          </span>
                        </span>
                        {o.live ? (
                          <span className="mo-live-dot shrink-0" role="img" aria-label="running" />
                        ) : (
                          /* said out loud rather than left blank — "no chat" is
                             the difference between an agent you can watch and
                             one you have to start */
                          !o.hasChat && (
                            <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.14em] text-sand-dim">
                              no chat
                            </span>
                          )
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>,
          document.body,
        )}
    </>
  )
}
