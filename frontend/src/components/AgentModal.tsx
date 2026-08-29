import { useEffect, useState } from 'react'
import { Crown, FileText, Plug, Sparkles, Trash2, User, X } from 'lucide-react'
import type { FloorAgent } from '../lib/api'

/**
 * AgentModal — everything about one agent, in four tabs.
 *
 * Replaces the 300px inspector rail that used to sit beside the canvas. The
 * rail had to show name, role, model, skills, MCP servers and the whole brief
 * at once, so the brief — the field that actually matters, and the longest —
 * was squeezed into a 220px-tall box at the bottom of a narrow column.
 *
 * A modal also removes the rail's other cost: it was 300px of the canvas gone
 * whenever an agent was selected, which on a floor of seven agents meant the
 * chart reflowed every time you clicked somebody.
 *
 * Edits are LIVE — every keystroke goes straight to the floor through
 * `onPatch`, exactly as the rail did. There is no Save button because there was
 * never a save step: the canvas owns the agent array and persists it. Closing
 * is therefore never destructive.
 */

type Tab = 'basic' | 'brief' | 'skills' | 'mcp'

const TABS: { id: Tab; label: string; icon: typeof User }[] = [
  { id: 'basic', label: 'Basic details', icon: User },
  { id: 'brief', label: 'Brief', icon: FileText },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Plug },
]

const FIELD =
  'w-full border border-hairline bg-midnight px-2 py-1.5 font-display text-[13px] text-parchment outline-none transition-colors duration-200 focus:border-brass'
const LABEL = 'font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim'

/** A bounded checkbox list. Names, not free text: a skill or server is invoked
 *  by its exact name, so letting one be typed would mean an agent could be
 *  equipped with something that does not exist and only find out at spawn. */
function PickList({
  empty,
  options,
  selected,
  onToggle,
}: {
  empty: string
  options: string[]
  selected: string[]
  onToggle: (name: string) => void
}) {
  const [q, setQ] = useState('')
  const filtered = options.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()))
  /* Chosen first, then the rest. On a machine with 70+ skills installed, what
     this agent HAS is the thing you came to check, and it would otherwise be
     scattered down a list you have to scroll. */
  const ordered = [
    ...filtered.filter((n) => selected.includes(n)),
    ...filtered.filter((n) => !selected.includes(n)),
  ]

  if (options.length === 0) {
    return <p className="font-display text-[12px] italic text-sand-dim">{empty}</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${options.length}…`}
        aria-label="Search"
        className={FIELD}
      />
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto border border-hairline">
        {ordered.length === 0 ? (
          <p className="px-3 py-3 font-display text-[12px] italic text-sand-dim">
            Nothing matches “{q}”.
          </p>
        ) : (
          ordered.map((name) => {
            const on = selected.includes(name)
            return (
              <button
                key={name}
                type="button"
                onClick={() => onToggle(name)}
                aria-pressed={on}
                className={`flex w-full cursor-pointer items-center gap-2 border-b border-hairline-s px-2.5 py-2 text-left font-mono text-[10.5px] transition-colors duration-150 last:border-b-0 hover:bg-white/[0.03] ${
                  on ? 'text-brass' : 'text-sand-dim'
                }`}
              >
                <span aria-hidden="true">{on ? '✓' : '·'}</span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export function AgentModal({
  agent,
  managerName,
  skillNames,
  mcpNames,
  onPatch,
  onRemove,
  onClose,
}: {
  agent: FloorAgent
  /** who this agent reports to, resolved by the canvas; null at the top */
  managerName: string | null
  skillNames: string[]
  mcpNames: string[]
  onPatch: (patch: Partial<FloorAgent>) => void
  onRemove: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('basic')
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (key: 'skills' | 'mcpServers', name: string) => {
    const cur = agent[key]
    onPatch({ [key]: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} — agent`}
        style={{ background: 'var(--color-surface)' }}
        className="mo-card flex h-[80vh] max-h-[720px] w-full max-w-3xl flex-col shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3.5">
          {agent.isBoss && <Crown className="h-4 w-4 shrink-0 text-brass" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-[16px] leading-tight text-parchment">
              {agent.name}
            </p>
            <p className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
              {agent.isBoss ? 'Boss' : (agent.role.trim() || 'no role')}
            </p>
          </div>
          {!agent.isBoss &&
            (confirmRemove ? (
              <button
                type="button"
                onClick={() => {
                  onRemove()
                  onClose()
                }}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 border border-brass px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Really remove
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                title="Remove this agent from the floor"
                className="flex shrink-0 cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Remove
              </button>
            ))}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </header>

        <div
          role="tablist"
          aria-label="Agent details"
          className="flex shrink-0 items-stretch gap-1 border-b border-hairline px-3 py-2"
        >
          {TABS.map((t) => {
            const Icon = t.icon
            const on = tab === t.id
            const count =
              t.id === 'skills'
                ? agent.skills.length
                : t.id === 'mcp'
                  ? agent.mcpServers.length
                  : 0
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.id)}
                className={
                  'flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 ' +
                  (on
                    ? 'border-brass bg-brass/10 text-brass'
                    : 'border-transparent text-sand hover:text-brass')
                }
              >
                <Icon className="h-3 w-3" aria-hidden="true" />
                {t.label}
                {count > 0 && <span className="text-brass">{count}</span>}
              </button>
            )
          })}
        </div>

        <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          {tab === 'basic' && (
            <>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Name</span>
                <input
                  value={agent.name}
                  onChange={(e) => onPatch({ name: e.target.value })}
                  className={FIELD}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className={LABEL}>Role</span>
                <input
                  value={agent.role}
                  onChange={(e) => onPatch({ role: e.target.value })}
                  placeholder="what they do"
                  className={FIELD}
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className={LABEL}>Reports to</span>
                <p className="border border-hairline bg-midnight px-2 py-1.5 font-display text-[13px] text-sand">
                  {agent.isBoss ? 'nobody — this is the top of the floor' : (managerName ?? 'nobody')}
                </p>
              </div>

              <label className="flex flex-col gap-1">
                <span className={LABEL}>Model</span>
                <select
                  value={agent.model}
                  onChange={(e) => onPatch({ model: e.target.value as FloorAgent['model'] })}
                  className={FIELD + ' cursor-pointer'}
                >
                  {/* "Inherit" is the default and is NOT a model name on purpose:
                      pinning every agent to whatever is current today would go
                      quietly wrong the first time the CLI's default moves on. */}
                  <option value="">Inherit (let the CLI choose)</option>
                  <option value="opus">Opus</option>
                  <option value="sonnet">Sonnet</option>
                  <option value="haiku">Haiku</option>
                </select>
              </label>

              <div className="flex flex-col gap-1">
                <span className={LABEL}>Chat</span>
                <p className="border border-hairline bg-midnight px-2 py-1.5 font-mono text-[11px] text-sand">
                  {agent.sessionId
                    ? agent.sessionId
                    : 'no chat yet — it starts the first time this agent is opened or given work'}
                </p>
              </div>
            </>
          )}

          {tab === 'brief' && (
            <label className="flex min-h-0 flex-1 flex-col gap-1">
              <span className={LABEL}>
                Brief · .md — this becomes {agent.name}’s system prompt when their chat starts
              </span>
              <textarea
                value={agent.md}
                onChange={(e) => onPatch({ md: e.target.value })}
                spellCheck={false}
                placeholder="What this agent owns, what it must not touch, and how it reports back."
                className="min-h-0 flex-1 resize-none border border-hairline bg-midnight px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-parchment outline-none transition-colors duration-200 focus:border-brass"
              />
            </label>
          )}

          {tab === 'skills' && (
            <>
              <p className="font-display text-[12px] italic leading-relaxed text-sand">
                The skills {agent.name} is equipped with. A skill is invoked by name, so an
                agent that has not been given one will never reach for it.
              </p>
              <PickList
                empty="No skills installed on this machine."
                options={skillNames}
                selected={agent.skills}
                onToggle={(n) => toggle('skills', n)}
              />
            </>
          )}

          {tab === 'mcp' && (
            <>
              <p className="font-display text-[12px] italic leading-relaxed text-sand">
                The MCP servers {agent.name}’s chat is started with. Christopher’s own
                orchestrator server is always present — these are in addition to it.
              </p>
              <PickList
                empty="No MCP servers configured."
                options={mcpNames}
                selected={agent.mcpServers}
                onToggle={(n) => toggle('mcpServers', n)}
              />
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-hairline px-5 py-3">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
            Changes save as you type
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
