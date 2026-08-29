import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

/**
 * ToolsInfoModal — every tool an agent in this app can actually call.
 *
 * The list comes from the SERVER, which reads the same `toolCatalog.js` the MCP
 * shim serves to claude. A hand-maintained list in the UI would drift the first
 * time a tool was added, and drift silently: nothing would fail, the panel would
 * just quietly stop being true.
 *
 * Grouped by what the tool is FOR rather than alphabetically, because the
 * question this panel answers is "what can I ask an agent to do", not "does a
 * tool with this exact name exist".
 */

interface Tool {
  name: string
  description: string
  params: string[]
  required: string[]
}

/** Prefix → the job it belongs to. First match wins, so order matters. */
const GROUPS: { label: string; blurb: string; match: (n: string) => boolean }[] = [
  {
    label: 'Talking to other chats',
    blurb: 'How one agent reaches another that is running right now.',
    match: (n) => n.includes('chat'),
  },
  {
    label: 'The floor',
    blurb: 'Who exists, and whether their chat is running.',
    match: (n) => n.startsWith('floor'),
  },
  {
    label: 'Shared memory',
    blurb: 'What every agent on the same scope can read back later.',
    match: (n) => n.startsWith('memory'),
  },
  {
    label: 'Workflow runs',
    blurb: 'Dispatching a step, and reporting back on one.',
    match: (n) => n.startsWith('workflow') || n.startsWith('step') || n.startsWith('dispatch'),
  },
]

export function ToolsInfoModal({ onClose }: { onClose: () => void }) {
  const [tools, setTools] = useState<Tool[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/tools')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!cancelled) setTools(Array.isArray(d.tools) ? d.tools : [])
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'could not load the tool list')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* every tool lands in exactly one group; anything unmatched falls to Other so a
     newly added tool is never silently dropped from the list */
  const grouped = (tools ?? []).reduce<Record<string, Tool[]>>((acc, t) => {
    const g = GROUPS.find((x) => x.match(t.name))?.label ?? 'Other'
    ;(acc[g] = acc[g] ?? []).push(t)
    return acc
  }, {})
  const order = [...GROUPS.map((g) => g.label), 'Other'].filter((l) => grouped[l]?.length)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Tools in this application"
        style={{ background: 'var(--color-surface)' }}
        className="mo-card flex max-h-[80vh] w-full max-w-2xl flex-col shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3.5">
          <span className="text-brass" aria-hidden="true">
            ✦
          </span>
          <span className="min-w-0 flex-1 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
            Tools
          </span>
          <span className="shrink-0 border border-hairline px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
            {tools?.length ?? '—'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-5 max-w-prose font-display text-[13px] italic leading-relaxed text-sand">
            What an agent running in this app can call. Every chat gets these
            automatically — you do not have to tell it they exist.
          </p>

          {error !== null ? (
            <p className="font-display text-[13px] italic text-sand">
              Could not load the tools — {error}.
            </p>
          ) : tools === null ? (
            <p className="font-display text-[13px] italic text-sand-dim">Loading…</p>
          ) : tools.length === 0 ? (
            <p className="font-display text-[13px] italic text-sand">No tools are registered.</p>
          ) : (
            order.map((label) => {
              const blurb = GROUPS.find((g) => g.label === label)?.blurb
              return (
                <section key={label} className="mb-6">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                    {label}
                  </h3>
                  {blurb && (
                    <p className="mt-1 font-display text-[12px] italic text-sand-dim">{blurb}</p>
                  )}
                  <ul className="mt-2.5 list-none border-t border-hairline-s">
                    {grouped[label].map((t) => (
                      <li key={t.name} className="border-b border-hairline-s py-2.5">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <code className="font-mono text-[12px] text-brass">{t.name}</code>
                          {t.params.length > 0 && (
                            <span className="font-mono text-[10px] text-sand-dim">
                              (
                              {t.params
                                .map((p) => (t.required.includes(p) ? p : p + '?'))
                                .join(', ')}
                              )
                            </span>
                          )}
                        </div>
                        <p className="mt-1 max-w-prose font-display text-[12.5px] leading-relaxed text-sand">
                          {t.description}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
