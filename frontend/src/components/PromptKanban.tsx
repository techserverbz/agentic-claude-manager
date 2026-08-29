import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Clock,
  Crown,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
  Unplug,
  User,
  X,
} from 'lucide-react'

/**
 * PromptKanban — the queue of work you hand this floor.
 *
 * The problem it solves, stated plainly: in one chat you have to wait for a
 * prompt to finish before giving the next. Here you write all of them down at
 * once, the boss reads the board and hands them out, and several agents work in
 * parallel with each card carrying its own state.
 *
 * NOT the Goal Kanban. That board is the CRM's — live company goals, shared
 * with everyone, written straight to production. This one is local to this
 * floor and to this computer: it is how you talk to your agents. Nothing here
 * reaches the CRM.
 */

interface Prompt {
  id: string
  text: string
  status: string
  priority: string
  agentName: string | null
  sessionId: string | null
  result: string | null
  question: string | null
  sessionLost: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

interface Board {
  floorId: string
  total: number
  columns: Record<string, Prompt[]>
}

interface AgentRow {
  name: string
  role: string
  isBoss: boolean
}

const COLUMNS: { id: string; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  /* Between working and reviewed, because that is where it sits: the work
     started and stopped on something only the human can answer. */
  { id: 'awaiting-input', label: 'Awaiting input' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  /* Out of the flow, not a step in it — work you have deliberately set aside.
     It stays on the board rather than being deleted: a parked task you cannot
     see is a task you have forgotten. */
  { id: 'later', label: 'Do later' },
]

/* The same stripe the goal card uses, so priority reads identically on both
   boards rather than meaning one thing here and another there. */
const PRIORITY_STRIPE: Record<string, string> = {
  low: 'bg-gray-400',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-500',
}

const STATUS_COLOR: Record<string, string> = {
  todo: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  'in-progress': 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400',
  /* Amber, like Review — both mean "a person has to look at this". */
  'awaiting-input': 'bg-amber-100 text-amber-800 dark:bg-amber-900/20 dark:text-amber-400',
  review: 'bg-amber-100 text-amber-800 dark:bg-amber-900/20 dark:text-amber-400',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400',
  /* Deliberately the quietest of the six. Parked work should not draw the eye
     the way work in flight does. */
  later: 'bg-slate-200 text-slate-600 dark:bg-slate-800/60 dark:text-slate-400',
}

const PRIORITIES = ['low', 'medium', 'high', 'urgent']

function when(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString()
}

export function PromptKanban({
  floorId,
  refreshSignal,
  onGoToChat,
  onPush,
}: {
  floorId: string | null
  /** bumped when this tab becomes visible, so it reloads on open */
  refreshSignal: number
  /** jump to the chat of the agent holding a card, by that agent's NAME —
   *  the card stores the name, and the panel resolves it to the live agent. */
  onGoToChat: (agentName: string) => void
  /** push a card to an agent: starts or wakes their chat and types it in */
  onPush: (promptId: string, agentName: string) => Promise<void>
}) {
  const [board, setBoard] = useState<Board | null>(null)
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftPriority, setDraftPriority] = useState('medium')
  const [open, setOpen] = useState<Prompt | null>(null)
  /* right-click menu, positioned at the pointer */
  const [menu, setMenu] = useState<{ x: number; y: number; card: Prompt } | null>(null)
  /* the open card's text, while it is being edited */
  const [editText, setEditText] = useState<string | null>(null)
  /* the card currently being pushed, so the row can say so */
  const [pushing, setPushing] = useState<string | null>(null)
  /* — drag and drop, native HTML5, the same idiom the sidebar uses for groups
       rather than a drag library the app does not otherwise carry.
       `dragId` is a ref as well as state: the ref is what the drop handler
       reads, because dataTransfer.getData() is empty during dragover on some
       browsers and a stale closure would otherwise move the wrong card. — */
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const dragRef = useRef<string | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)

  const load = useCallback(
    (signal?: AbortSignal) => {
      setError(null)
      if (!floorId) return
      setLoading(true)
      fetch(`/api/floors/${floorId}/prompts`, { signal })
        .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
        .then((d) => {
          /* Guarded on the board's OWN floorId. Without it a slow response for the
             floor you just left lands after the one you switched to, and the
             board silently shows another floor's cards under this floor's name.
             The server echoes floorId for exactly this check. */
          if (d?.board?.floorId === floorId) {
            setBoard(d.board)
            setAgents(Array.isArray(d.agents) ? d.agents : [])
          }
        })
        .catch((e) => {
          if (e?.name !== 'AbortError') {
            setError(e?.message || 'could not read the prompt board')
            /* A failed load must not leave the PREVIOUS floor's cards on
               screen: they stay clickable, and editing one would silently
               change a floor that is not the one named in the header. */
            setBoard(null)
            setAgents([])
          }
        })
        .finally(() => setLoading(false))
    },
    [floorId],
  )

  useEffect(() => {
    const ac = new AbortController()
    load(ac.signal)
    return () => ac.abort()
  }, [load, refreshSignal])

  useEffect(() => {
    if (adding) draftRef.current?.focus()
  }, [adding])

  /* Leaving a card drops the edit. Carrying a half-typed prompt into the NEXT
     card you open would offer to save one card's words onto another. */
  useEffect(() => {
    setEditText(null)
  }, [open?.id])

  /* Close the composer when the floor changes. It posts to whatever floorId is
     current at the moment you press Add, so a draft left open across a floor
     switch would quietly queue your words onto the wrong floor. */
  useEffect(() => {
    setAdding(false)
    setDraft('')
    setOpen(null)
    setBoard(null)
  }, [floorId])

  const add = () => {
    const text = draft.trim()
    if (!text || !floorId) return
    fetch(`/api/floors/${floorId}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, priority: draftPriority }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then(() => {
        setDraft('')
        setAdding(false)
        load()
      })
      .catch((e) => setError(e?.message || 'could not add that prompt'))
  }

  const patch = (id: string, body: Record<string, unknown>) => {
    fetch(`/api/prompts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then(() => {
        setOpen(null)
        load()
      })
      .catch((e) => setError(e?.message || 'could not change that prompt'))
  }

  const remove = (id: string) => {
    fetch(`/api/prompts/${id}`, { method: 'DELETE' })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
      .then(() => {
        setOpen(null)
        load()
      })
      .catch((e) => setError(e?.message || 'could not delete that prompt'))
  }

  const boss = agents.find((a) => a.isBoss)

  /* Whoever the card is already with goes to the TOP of the push list.
     Re-pushing a card is almost always to the same person — you read what they
     came back with and send it on again — so making that the first name turns
     the commonest action into no hunting at all. Everyone else keeps roster
     order behind them. */
  const pushOrder = (card: Prompt) =>
    card.agentName
      ? [
          ...agents.filter((a) => a.name === card.agentName),
          ...agents.filter((a) => a.name !== card.agentName),
        ]
      : agents

  /* close the context menu the way every other menu in the app closes */
  useEffect(() => {
    if (menu === null) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  return (
    <section aria-label="Prompt board" className="flex h-full min-h-0 w-full flex-col bg-midnight">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">Prompts</span>
        <span className="min-w-0 flex-1 truncate font-display text-[12px] italic text-sand-dim">
          {boss
            ? `Write work down here — ${boss.name} reads this board and hands it out.`
            : 'Write work down here; the floor’s boss reads this board.'}
        </span>
        {board && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-sand-dim">
            {board.total} card{board.total === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          disabled={!floorId}
          title="Add a prompt to this floor's queue"
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 border border-hairline px-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          Add prompt
        </button>
        <button
          type="button"
          onClick={() => load()}
          aria-label="Reload the prompt board"
          title="Reload"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
      </header>

      {adding && (
        <div className="shrink-0 border-b border-hairline bg-surface px-4 py-3">
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              /* Enter alone must not submit — a prompt is usually several
                 sentences, and one cut off at the first line break is worse
                 than none. */
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                add()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setAdding(false)
              }
            }}
            rows={3}
            placeholder="What needs doing? Write it as you would say it to an agent."
            className="w-full resize-none border border-hairline bg-midnight px-2.5 py-2 font-display text-[13px] leading-relaxed text-parchment outline-none placeholder:text-sand-dim focus:border-brass"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
              Priority
            </span>
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={draftPriority === p}
                onClick={() => setDraftPriority(p)}
                className={
                  'cursor-pointer border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 ' +
                  (draftPriority === p
                    ? 'border-brass bg-brass/10 text-brass'
                    : 'border-hairline text-sand hover:border-brass hover:text-brass')
                }
              >
                {p}
              </button>
            ))}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={add}
              disabled={draft.trim() === ''}
              className="cursor-pointer border border-brass bg-brass/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add to queue
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          className="shrink-0 border-b border-hairline-s px-4 py-2 font-display text-[12px] italic text-[#cf6b52]"
        >
          {error}
        </p>
      )}

      {!floorId ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          Pick a floor to see its prompt queue.
        </p>
      ) : board === null ? (
        <p className="px-6 py-8 font-display text-[13px] italic text-sand-dim">Loading…</p>
      ) : board.total === 0 ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          Nothing queued. Write down everything you want done — you do not have to
          wait for one to finish before adding the next, which is the whole point
          of this board.
        </p>
      ) : (
        <div className="no-scrollbar flex min-h-0 flex-1 gap-px overflow-x-auto bg-hairline">
          {COLUMNS.map((col) => {
            const cards = board.columns[col.id] ?? []
            return (
              <div
                key={col.id}
                /* The WHOLE column is the drop target, header and empty space
                   included — aiming at the little stack of cards would make an
                   empty column the hardest one to drop into, which is exactly
                   the one you most often want. */
                onDragOver={(e) => {
                  if (!dragRef.current) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOverCol !== col.id) setDragOverCol(col.id)
                }}
                onDragLeave={(e) => {
                  /* Only when the pointer has really left this column — moving
                     over a child fires dragleave on the parent too. */
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverCol((c) => (c === col.id ? null : c))
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const id = dragRef.current
                  dragRef.current = null
                  setDragId(null)
                  setDragOverCol(null)
                  if (!id) return
                  /* A drop into the column it came from is not a change — and
                     patching anyway would bump updatedAt and re-sort the board
                     under the user's hand for nothing. */
                  const from = Object.entries(board.columns).find(([, list]) =>
                    list.some((p) => p.id === id),
                  )?.[0]
                  if (from === col.id) return
                  patch(id, { status: col.id })
                }}
                className={
                  'flex min-h-0 min-w-[220px] flex-1 flex-col transition-colors duration-150 ' +
                  (dragOverCol === col.id ? 'bg-brass/5 ring-1 ring-inset ring-brass/40' : 'bg-midnight')
                }
              >
                <div className="flex shrink-0 items-baseline gap-2 border-b border-hairline-s px-3 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-sand">
                    {col.label}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-sand-dim">
                    {cards.length}
                  </span>
                </div>
                <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
                  {cards.length === 0 ? (
                    <p className="px-1 py-2 font-display text-[12px] italic text-sand-dim">
                      nothing here
                    </p>
                  ) : (
                    <ul className="flex list-none flex-col gap-2">
                      {cards.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => setOpen(p)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setMenu({ x: e.clientX, y: e.clientY, card: p })
                            }}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = 'move'
                              e.dataTransfer.setData('text/plain', p.id)
                              dragRef.current = p.id
                              setDragId(p.id)
                              setMenu(null)
                            }}
                            onDragEnd={() => {
                              dragRef.current = null
                              setDragId(null)
                              setDragOverCol(null)
                            }}
                            title="Open this prompt · drag to move it · right-click for more"
                            className={
                              'group relative w-full cursor-pointer overflow-hidden rounded-lg border bg-surface text-left transition-all duration-150 hover:border-brass hover:shadow-md ' +
                              /* The card being dragged fades in place rather than
                                 vanishing, so the column it came from keeps its
                                 shape and the eye follows the cursor. */
                              (dragId === p.id ? 'border-brass opacity-40' : 'border-hairline')
                            }
                          >
                            <span
                              className={`absolute bottom-0 left-0 top-0 w-1 ${
                                PRIORITY_STRIPE[p.priority] ?? 'bg-blue-400'
                              }`}
                            />
                            <div className="p-3.5 pl-4">
                              <p className="line-clamp-3 font-display text-[13px] leading-snug text-parchment">
                                {p.text}
                              </p>
                              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                {p.agentName && (
                                  <span className="max-w-[130px] truncate rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand">
                                    {p.agentName}
                                  </span>
                                )}
                                {/* Who wrote it. 'human' is you and needs no
                                    label; anything else is the boss having
                                    broken your prompt into pieces, which you
                                    should be able to see at a glance. */}
                                {p.createdBy !== 'human' && (
                                  <span className="max-w-[130px] truncate rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium text-sand-dim">
                                    by {p.createdBy}
                                  </span>
                                )}
                                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                                  {when(p.createdAt)}
                                </span>
                              </div>
                              {/* The question, on the card. This is the thing
                                  that used to be lost: it was only ever in the
                                  agent's terminal, so a restart took it and
                                  left a card stopped for no visible reason. */}
                              {p.question && (
                                <p className="mt-2 border-t border-hairline-s pt-2 font-display text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-400">
                                  {p.question}
                                </p>
                              )}
                              {p.sessionLost && (
                                <p className="mt-2 flex items-start gap-1.5 border-t border-hairline-s pt-2 font-display text-[11px] leading-relaxed text-sand-dim">
                                  <Unplug className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                                  Its chat did not survive the last restart — hand it out again to
                                  pick it up.
                                </p>
                              )}
                              {p.result && (
                                <p className="mt-2 line-clamp-2 border-t border-hairline-s pt-2 font-display text-[11.5px] italic leading-relaxed text-sand">
                                  {p.result}
                                </p>
                              )}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {menu !== null && (
        <div
          role="menu"
          className="fixed z-50 min-w-[12rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40"
          style={{
            /* clamped so a right-click near the bottom or right edge does not
               run the menu off-page — same rule the sidebar's menu follows */
            left: Math.min(menu.x, window.innerWidth - 210),
            top: Math.min(menu.y, window.innerHeight - 150),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Go to the chat that is holding this card. Offered only when a card
              HAS an agent: a card in to-do has never been handed out, so there
              is no chat to go to and a dead menu item would only mislead. */}
          {menu.card.agentName ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const name = menu.card.agentName!
                setMenu(null)
                onGoToChat(name)
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
            >
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              Go to {menu.card.agentName}’s chat
            </button>
          ) : (
            <p className="px-3 py-2 font-display text-[12px] italic leading-relaxed text-sand-dim">
              Not with anyone yet — no chat to go to.
            </p>
          )}
          {/* Push the work to somebody, straight from the board. The agents are
              listed inline rather than behind a submenu: a floor has a handful
              of them, and one click should be one click. */}
          <div className="border-t border-hairline-s pt-1">
            <p className="px-3 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
              Push to agent
            </p>
            {agents.length === 0 ? (
              <p className="px-3 py-1.5 font-display text-[12px] italic text-sand-dim">
                No agents on this floor.
              </p>
            ) : (
              pushOrder(menu.card).map((a) => {
                const holder = menu.card.agentName === a.name
                return (
                  <button
                    key={a.name}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const id = menu.card.id
                      setMenu(null)
                      setPushing(id)
                      onPush(id, a.name)
                        .then(() => load())
                        .catch((e: Error) => setError(e?.message || 'could not push that prompt'))
                        .finally(() => setPushing(null))
                    }}
                    className={
                      'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass ' +
                      (holder ? 'border-b border-hairline-s text-brass' : 'text-sand')
                    }
                  >
                    {a.isBoss ? (
                      <Crown className="h-3 w-3 text-brass" aria-hidden="true" />
                    ) : (
                      <Send className="h-3 w-3" aria-hidden="true" />
                    )}
                    {a.name}
                    {/* Says WHY it is first, so the reordering reads as
                        deliberate rather than as an arbitrary roster order. */}
                    {holder && <span className="ml-auto text-sand-dim">has it</span>}
                  </button>
                )
              })
            )}
          </div>

          {/* Park it. One click, because deciding "not now" is a snap judgement
              you make while looking at the board, not something you open a card
              to do. Hidden on a card already parked — there is nowhere to send
              it, and a no-op menu item only misleads. */}
          {menu.card.status !== 'later' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = menu.card.id
                setMenu(null)
                patch(id, { status: 'later' })
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
            >
              <Clock className="h-3 w-3" aria-hidden="true" />
              Do later
            </button>
          )}
          {menu.card.status === 'later' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = menu.card.id
                setMenu(null)
                patch(id, { status: 'todo' })
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
            >
              <Undo2 className="h-3 w-3" aria-hidden="true" />
              Back to to-do
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const card = menu.card
              setMenu(null)
              setOpen(card)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Open · edit
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = menu.card.id
              setMenu(null)
              remove(id)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Delete
          </button>
        </div>
      )}

      {open !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={() => setOpen(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Prompt"
            style={{ background: 'var(--color-surface)' }}
            className="mo-card flex max-h-[85vh] w-full max-w-lg flex-col shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3.5">
              <span className="min-w-0 flex-1 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                Prompt
              </span>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label="Close"
                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </header>
            <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
              {/* The prompt itself, editable in place. It is the one field worth
                  changing after the fact — you write a card quickly, then want
                  to sharpen it before handing it to somebody. */}
              {editText !== null ? (
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                    Prompt
                  </span>
                  <textarea
                    value={editText}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        if (editText.trim()) patch(open.id, { text: editText.trim() })
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditText(null)
                      }
                    }}
                    rows={6}
                    className="w-full resize-none border border-brass bg-midnight px-3 py-2.5 font-display text-[13px] leading-relaxed text-parchment outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                      Ctrl+Enter saves
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditText(null)}
                      className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={editText.trim() === ''}
                      onClick={() => patch(open.id, { text: editText.trim() })}
                      className="cursor-pointer border border-brass bg-brass/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Save prompt
                    </button>
                  </div>
                </div>
              ) : (
                <div className="group flex items-start gap-2">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap font-display text-[13px] leading-relaxed text-parchment">
                    {open.text}
                  </p>
                  <button
                    type="button"
                    onClick={() => setEditText(open.text)}
                    title="Edit this prompt"
                    aria-label="Edit this prompt"
                    className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}

              {/* Hand it to somebody. Same act as the right-click push — this is
                  where you land when you opened the card to read it first. */}
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                  {open.agentName ? `With ${open.agentName} — push again to reassign` : 'Push to'}
                </span>
                <div className="flex flex-wrap gap-1">
                  {agents.length === 0 ? (
                    <p className="font-display text-[12px] italic text-sand-dim">
                      No agents on this floor yet.
                    </p>
                  ) : (
                    pushOrder(open).map((a) => (
                      <button
                        key={a.name}
                        type="button"
                        disabled={pushing !== null}
                        onClick={() => {
                          setPushing(open.id)
                          onPush(open.id, a.name)
                          .then(() => {
                            setOpen(null)
                            load()
                          })
                          .catch((e: Error) => setError(e?.message || 'could not push that prompt'))
                          .finally(() => setPushing(null))
                        }}
                        className={
                          'flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ' +
                          (open.agentName === a.name
                            ? 'border-brass bg-brass/10 text-brass'
                            : 'border-hairline text-sand hover:border-brass hover:text-brass')
                        }
                      >
                        {a.isBoss && <Crown className="h-3 w-3" aria-hidden="true" />}
                        {a.name}
                      </button>
                    ))
                  )}
                </div>
                <p className="mt-1 font-display text-[11px] italic leading-relaxed text-sand-dim">
                  Pushing starts or wakes that agent’s chat, types the prompt in, and moves
                  the card to In progress.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-hairline-s pt-3">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLOR[open.status] ?? ''}`}>
                  {COLUMNS.find((c) => c.id === open.status)?.label ?? open.status}
                </span>
                {open.agentName && (
                  <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand">
                    <User className="h-2.5 w-2.5" aria-hidden="true" />
                    {open.agentName}
                  </span>
                )}
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                  {open.createdBy === 'human' ? 'written by you' : `written by ${open.createdBy}`} ·{' '}
                  {when(open.createdAt)}
                </span>
              </div>

              {open.question !== null && (
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                    Waiting on you
                  </span>
                  <p className="whitespace-pre-wrap border border-amber-500/40 bg-amber-500/5 px-3 py-2 font-display text-[12.5px] leading-relaxed text-parchment">
                    {open.question}
                  </p>
                </div>
              )}

              {open.result && (
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                    What came back
                  </span>
                  <p className="whitespace-pre-wrap border border-hairline bg-midnight px-3 py-2 font-display text-[12.5px] leading-relaxed text-sand">
                    {open.result}
                  </p>
                </div>
              )}

              {error !== null && (
                /* Shown INSIDE the dialog. The page-level banner is a sibling of the
                   board, so while this modal is open its scrim covers it — a
                   failed move would otherwise read as nothing happening. */
                <p
                  role="alert"
                  className="border border-hairline bg-midnight px-3 py-2 font-display text-[12.5px] leading-relaxed text-[#cf6b52]"
                >
                  {error}
                </p>
              )}

              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                  Move to
                </span>
                <div className="flex flex-wrap gap-1">
                  {COLUMNS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={open.status === c.id}
                      disabled={open.status === c.id}
                      onClick={() => patch(open.id, { status: c.id })}
                      className={
                        'cursor-pointer border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 disabled:cursor-default ' +
                        (open.status === c.id
                          ? 'border-brass bg-brass/10 text-brass'
                          : 'border-hairline text-sand hover:border-brass hover:text-brass')
                      }
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                  Priority
                </span>
                <div className="flex flex-wrap gap-1">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={open.priority === p}
                      disabled={open.priority === p}
                      onClick={() => patch(open.id, { priority: p })}
                      className={
                        'cursor-pointer border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 disabled:cursor-default ' +
                        (open.priority === p
                          ? 'border-brass bg-brass/10 text-brass'
                          : 'border-hairline text-sand hover:border-brass hover:text-brass')
                      }
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <footer className="flex shrink-0 items-center gap-2 border-t border-hairline px-5 py-3">
              <button
                type="button"
                onClick={() => remove(open.id)}
                className="flex cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete
              </button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Close
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  )
}
