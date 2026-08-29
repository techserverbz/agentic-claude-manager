import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Plus, RefreshCw } from 'lucide-react'
import { GoalDialog, type GoalDraft, type Member } from './GoalDialog'
import { ScopePicker, type Scope } from './ScopePicker'

/**
 * CrmKanban — the CRM's own board for whatever this floor is attached to.
 *
 * The cards are live PRODUCTION goals. Add and edit write straight through to
 * the CRM, so every mutation here is a deliberate user action — nothing syncs
 * or reconciles in the background.
 *
 * `abandoned` is counted but has no column: it is an exit, not a stage, and a
 * lane for it invites dragging work into it.
 */

interface Card {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  ownerId: string | null
  ownerName: string | null
  assigneeNames: string[]
  parentGoalId: string | null
  parentTitle: string | null
  dueDate: string | null
  createdAt: string | null
  createdByName: string | null
  targetType: string | null
  servicePillar: string | null
  assigneeIds: string[]
}

/* ————————————————————————————————————————————————————————————————
   The CRM's own goal vocabulary, copied VERBATIM from
   sam-crm-fe/src/components/crm/goal-constants.ts.

   Not re-derived in this app's brass/parchment palette: the point is that a
   card here is the same card the user reads in the CRM, so a goal in review is
   the same amber in both and needs no second translation in the head. Copied
   rather than imported because the two apps are separate builds with no shared
   package — which means these five maps must be updated together, and that is
   the cost of the fidelity being asked for.

   The `dark:` halves work because index.css declares
   `@custom-variant dark (&:where(.dark, .dark *))`, binding them to this app's
   own theme class rather than to the OS preference.
   ———————————————————————————————————————————————————————————— */

const STATUS_LABEL: Record<string, string> = {
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
  abandoned: 'Abandoned',
}

const STATUS_COLOR: Record<string, string> = {
  todo: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  'in-progress': 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400',
  review: 'bg-amber-100 text-amber-800 dark:bg-amber-900/20 dark:text-amber-400',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400',
  abandoned: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-400',
}

/** Left-edge accent stripe on a goal card. */
const PRIORITY_STRIPE: Record<string, string> = {
  low: 'bg-gray-400',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-500',
}

/** Amber, not red: a missing due date is a gap to fill, not work that slipped. */
const NO_DUE_BADGE =
  'bg-amber-500/20 text-amber-700 dark:text-amber-400 ring-1 ring-inset ring-amber-500/40'

/* goalsController.js:35 GOAL_PILLARS — the six service pillars.
   Deliberately NEUTRAL, not coloured: in the CRM a goal's pillar is always a
   plain outline badge or muted text, while status and priority carry the
   colour. The blue/amber/pink/green/purple/red pillar palette that exists in
   that codebase belongs to other modules (wiki pages, SOPs, knowledge bank) —
   using it here would make a goal card louder than the CRM's own. */
const PILLAR_LABEL: Record<string, string> = {
  product: 'Product',
  operations: 'Operations',
  marketing: 'Marketing',
  sales: 'Sales',
  finance: 'Finance',
  management: 'Management',
}

/** the CRM's card date: "Mar 3" */
function fmtDate(s: string | null): string | null {
  if (!s) return null
  try {
    return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return null
  }
}

interface Board {
  targetType: string
  targetId: string | null
  total: number
  abandoned: number
  columns: Record<string, Card[]>
}

const COLUMNS: { id: string; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
]

/**
 * One goal card — a faithful copy of the CRM's own `GoalCardBody`
 * (sam-crm-fe/src/components/crm/goals2-board.tsx).
 *
 * Same structure, same order, same pills: priority stripe down the left edge,
 * title, two-line description, then the pill row (status · sub-goal of · people
 * · overdue / no due date), then the due date under a calendar glyph.
 *
 * The CRM's drag handles, edit/open/disable buttons and context menu are NOT
 * copied. They act on a board this panel only reads — dragging here would move
 * a production goal with no undo, so the whole card is the edit affordance and
 * the dialog is where a change is made deliberately.
 */
function GoalCardBody({ card }: { card: Card }) {
  const due = fmtDate(card.dueDate)
  /* "Overdue" is a claim about work, not a date comparison: a goal that is done
     is not overdue however old its due date. Same rule as the CRM's card. */
  const overdue =
    !!card.dueDate && card.status !== 'done' && new Date(card.dueDate) < new Date()
  const pill = 'px-2 py-0.5 rounded-full text-[10px] font-medium'
  return (
    <>
      <span
        className={`absolute left-0 top-0 bottom-0 w-1 ${
          PRIORITY_STRIPE[card.priority] ?? 'bg-blue-400'
        }`}
      />
      <div className="p-3.5 pl-4">
        <p className="line-clamp-2 font-display text-sm font-semibold text-parchment">
          {card.title}
        </p>
        {card.description && (
          <p className="mt-1 line-clamp-2 font-display text-xs text-sand">{card.description}</p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className={`${pill} ${STATUS_COLOR[card.status] ?? ''}`}>
            {STATUS_LABEL[card.status] ?? card.status}
          </span>
          {/* The pillar, ONLY on a product/service goal. That is the CRM's own
              guard (`targetType === "service" && servicePillar`) and its own
              rule — the server refuses a pillar on any other scope. A service
              goal with no pillar shows nothing: it covers the whole service,
              which is a real and common state, not a missing value. */}
          {card.targetType === 'service' && card.servicePillar && (
            <span className={`${pill} border border-hairline text-sand`}>
              {PILLAR_LABEL[card.servicePillar] ?? card.servicePillar}
            </span>
          )}
          {card.parentGoalId && (
            <span
              className={`${pill} max-w-[190px] truncate bg-surface-2 text-sand`}
              title={card.parentTitle ?? undefined}
            >
              {card.parentTitle ? `sub-goal of ${card.parentTitle}` : 'sub-goal'}
            </span>
          )}
          {/* Everyone on the goal, owner first — the CRM shows them all. */}
          {card.assigneeNames.map((name, i) => (
            <span
              key={name + i}
              className={`${pill} max-w-[130px] truncate ${
                i === 0 ? 'bg-surface-2 text-sand' : 'bg-surface-2/60 text-sand'
              }`}
            >
              {name}
            </span>
          ))}
          {overdue && (
            <span className={`${pill} bg-red-500/20 text-red-600 dark:text-red-400`}>Overdue</span>
          )}
          {!card.dueDate && <span className={`${pill} ${NO_DUE_BADGE}`}>No due date</span>}
        </div>
        {due && (
          <div
            className={`mt-2 flex items-center gap-1 font-display text-xs ${
              overdue ? 'text-red-500' : 'text-sand'
            }`}
          >
            <CalendarDays className="h-3 w-3" aria-hidden="true" />
            {due}
          </div>
        )}
      </div>
    </>
  )
}

export function CrmKanban({
  scope,
  onChangeScope,
}: {
  /** what this floor is attached to; null until one is picked */
  scope: { targetType: string; targetId: string | null } | null
  onChangeScope: (next: { targetType: string; targetId: string | null }) => void
}) {
  const [board, setBoard] = useState<Board | null>(null)
  const [scopes, setScopes] = useState<Scope[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /* null = closed. Holds the draft being added or edited, so the dialog is a
     pure function of this and closing cannot strand a half-edited card. */
  const [editing, setEditing] = useState<GoalDraft | null>(null)

  /* the picker is a long list (every project is a scope), so it loads once */
  useEffect(() => {
    let cancelled = false
    fetch('/api/crm/scopes')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!cancelled) setScopes(Array.isArray(d.scopes) ? d.scopes : [])
      })
      .catch(() => {
        if (!cancelled) setScopes([])
      })
    /* The roster, for the dialog's assignee picker. Loaded here rather than
       inside the dialog so opening a goal does not wait on a network call —
       and an empty roster degrades to "Unassigned" rather than blocking a save. */
    fetch('/api/crm/members')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!cancelled) setMembers(Array.isArray(d.members) ? d.members : [])
      })
      .catch(() => {
        if (!cancelled) setMembers([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!scope) return
      setLoading(true)
      setError(null)
      const qs = new URLSearchParams({ targetType: scope.targetType })
      if (scope.targetId) qs.set('targetId', scope.targetId)
      fetch('/api/crm/board?' + qs.toString(), { signal })
        .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.error)))))
        .then((d) => setBoard(d))
        .catch((e) => {
          if (e?.name !== 'AbortError') setError(e?.message || 'could not read the CRM')
        })
        .finally(() => setLoading(false))
    },
    [scope],
  )

  useEffect(() => {
    const ac = new AbortController()
    load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <section aria-label="CRM board" className="flex h-full min-h-0 w-full flex-col bg-midnight">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">Board</span>

        {/* DISPLAY ONLY. Attaching is a floor action and lives on the floor's
            row in the sidebar — offering it here too was what made the
            attachment read as a property of the agent you happened to have
            selected, rather than of the floor. */}
        <ScopePicker scopes={scopes ?? []} value={scope} onChange={onChangeScope} readOnly />

        {board && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-sand-dim">
            {board.total} cards
            {board.abandoned > 0 ? ' · ' + board.abandoned + ' abandoned' : ''}
          </span>
        )}
        <button
          type="button"
          onClick={() =>
            setEditing({
              title: '',
              description: '',
              status: 'todo',
              priority: 'medium',
              servicePillar: null,
              assigneeIds: [],
              dueDate: null,
            })
          }
          disabled={!scope}
          title={scope ? 'Add a goal to this scope in the CRM' : 'Attach this floor to a scope first'}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 border border-hairline px-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          Add goal
        </button>
        <button
          type="button"
          onClick={() => load()}
          aria-label="Reload the board"
          title="Reload from the CRM"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
      </header>

      {!scope ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          This floor is not attached to anything yet. Right-click it in the sidebar
          and choose Attach to… — the board belongs to the floor, not to whichever
          agent you have open, and it is chosen once.
        </p>
      ) : error !== null ? (
        <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
          Could not read the CRM — {error}.
        </p>
      ) : board === null ? (
        <p className="px-6 py-8 font-display text-[13px] italic text-sand-dim">Loading…</p>
      ) : (
        <div className="no-scrollbar flex min-h-0 flex-1 gap-px overflow-x-auto bg-hairline">
          {COLUMNS.map((col) => {
            const cards = board.columns[col.id] ?? []
            return (
              <div
                key={col.id}
                /* The four columns SHARE the width rather than each taking a
                   fixed 260px and leaving the rest of the page empty. They stop
                   at a readable minimum, below which the row scrolls sideways
                   instead of crushing the cards. */
                className="flex min-h-0 min-w-[220px] flex-1 flex-col bg-midnight"
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
                      {cards.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() =>
                              setEditing({
                                id: c.id,
                                title: c.title,
                                /* The real description, now that the board
                                   carries it for the card. It used to be seeded
                                   as '' — safe only because the dialog PATCHes
                                   just what changed, but it meant opening a goal
                                   showed an empty description for one that had
                                   one. */
                                description: c.description ?? '',
                                status: c.status,
                                priority: c.priority,
                                servicePillar: c.servicePillar,
                                assigneeIds: c.assigneeIds,
                                dueDate: c.dueDate,
                              })
                            }
                            title={'Edit "' + c.title + '" in the CRM'}
                            className="group relative w-full cursor-pointer overflow-hidden rounded-lg border border-hairline bg-surface text-left transition-all duration-150 hover:border-brass hover:shadow-md"
                          >
                            <GoalCardBody card={c} />
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

      {editing !== null && (
        <GoalDialog
          initial={editing}
          scope={scope}
          scopeLabel={
            scope?.targetType === 'organization'
              ? 'the organisation'
              : scope?.targetType === 'mine'
                ? 'your own tasks'
                : ((scopes ?? []).find((x) => x.targetId === scope?.targetId)?.name ?? 'this scope')
          }
          /* The GOAL's own target type, not the board's. On "My tasks" the two
             differ — that board mixes scopes, and a service goal sitting on it
             still gets its pillar select. Falls back to the board's scope for a
             goal being created, which has no type of its own yet. */
          scopeTargetType={
            editing.id
              ? (Object.values(board?.columns ?? {})
                  .flat()
                  .find((c) => c.id === editing.id)?.targetType ?? null)
              : (scope?.targetType ?? null)
          }
          members={members}
          onClose={() => setEditing(null)}
          onSaved={() => load()}
        />
      )}
    </section>
  )
}
