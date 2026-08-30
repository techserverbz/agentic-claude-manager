import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import { api, type Floor } from '../lib/api'

/**
 * FloorGoals — what this workflow is trying to achieve, and the steps under it.
 *
 * OFFLINE FIRST, and that is the whole design. The Goal Kanban beside this tab
 * reads the CRM directly, so it shows nothing when the CRM is down, and a floor
 * whose goals vanish with another service is a floor you cannot plan on. These
 * goals live in this app's own store. The CRM is somewhere they can be SENT,
 * not somewhere they are read from.
 *
 * Sync is therefore a button, never a page load. It appears only once the floor
 * is attached to a product, service or project, because before that there is no
 * answer to "synced with what".
 *
 * Sub-goals are one level deep on purpose. Two levels is a tree, a tree needs
 * an outliner, and an outliner is a different feature from "what are we doing
 * and what does it break into".
 */

const STATUSES = ['todo', 'in-progress', 'review', 'done', 'abandoned'] as const
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

type Status = (typeof STATUSES)[number]
type Priority = (typeof PRIORITIES)[number]

interface Goal {
  id: string
  parentId: string | null
  title: string
  description: string
  status: Status
  priority: Priority
  servicePillar: string | null
  dueDate: string | null
  agentName: string | null
  crmGoalId: string | null
  syncedAt: string | null
  children?: Goal[]
}

const STATUS_TONE: Record<Status, string> = {
  todo: 'border-hairline text-sand-dim',
  'in-progress': 'border-brass text-brass',
  review: 'border-hairline text-sand',
  done: 'border-emerald-700 text-emerald-400',
  abandoned: 'border-hairline text-sand-dim line-through',
}

const PRIORITY_TONE: Record<Priority, string> = {
  low: 'text-sand-dim',
  medium: 'text-sand',
  high: 'text-brass',
  urgent: 'text-[#cf6b52]',
}

const FIELD =
  'w-full border border-hairline bg-midnight px-2.5 py-1.5 font-display text-[13px] text-parchment outline-none transition-colors duration-200 focus:border-brass'

/** the add form, used for both a goal and a sub-goal — the only difference is
 *  the parent it is given, which is the point of modelling them the same way */
function AddGoal({
  parentId,
  placeholder,
  onAdd,
  onCancel,
}: {
  parentId: string | null
  placeholder: string
  onAdd: (title: string, parentId: string | null) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onAdd(t, parentId)
      setTitle('')
      onCancel()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 py-1.5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        className={FIELD}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || title.trim() === ''}
        className="mo-ticks shrink-0 cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        className="shrink-0 cursor-pointer p-1 text-sand-dim transition-colors duration-200 hover:text-brass"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

function GoalRow({
  goal,
  depth,
  onPatch,
  onDelete,
  onAddChild,
}: {
  goal: Goal
  depth: number
  onPatch: (id: string, patch: Partial<Goal>) => void
  onDelete: (id: string) => void
  onAddChild: null | (() => void)
}) {
  return (
    <div
      className={`flex items-center gap-2 border-b border-hairline-s px-3 py-2 ${
        depth > 0 ? 'pl-9' : ''
      }`}
    >
      <Target
        className={`h-3 w-3 shrink-0 ${depth > 0 ? 'text-sand-dim' : 'text-brass'}`}
        aria-hidden="true"
      />

      <input
        value={goal.title}
        onChange={(e) => onPatch(goal.id, { title: e.target.value })}
        className="min-w-0 flex-1 border border-transparent bg-transparent px-1 py-0.5 font-display text-[13.5px] text-parchment outline-none transition-colors duration-150 hover:border-hairline focus:border-brass"
      />

      {/* synced state, and only ever as a fact — never as a thing to fix. A goal
          that lives only here is not broken, it just has not been sent. */}
      {goal.crmGoalId !== null && (
        <span
          title={`In the CRM as ${goal.crmGoalId}`}
          className="shrink-0 rounded-full border border-hairline px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim"
        >
          synced
        </span>
      )}

      <select
        value={goal.priority}
        onChange={(e) => onPatch(goal.id, { priority: e.target.value as Priority })}
        className={`shrink-0 cursor-pointer border border-hairline bg-midnight px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] outline-none ${PRIORITY_TONE[goal.priority]}`}
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        value={goal.status}
        onChange={(e) => onPatch(goal.id, { status: e.target.value as Status })}
        className={`shrink-0 cursor-pointer border bg-midnight px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] outline-none ${STATUS_TONE[goal.status]}`}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {onAddChild !== null && (
        <button
          type="button"
          onClick={onAddChild}
          title="Add a sub-goal"
          aria-label={`Add a sub-goal under ${goal.title}`}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}

      <button
        type="button"
        onClick={() => onDelete(goal.id)}
        title={depth === 0 ? 'Delete this goal and its sub-goals' : 'Delete this sub-goal'}
        aria-label={`Delete ${goal.title}`}
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-[#cf6b52] hover:text-[#cf6b52]"
      >
        <Trash2 className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  )
}

export function FloorGoals({ floor }: { floor: Floor | null }) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [scope, setScope] = useState<{ targetType: string; targetId: string | null } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<string | null | 'root'>(null)
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    if (floor === null) return
    void api.getFloorGoals(floor.id).then(
      (r) => {
        setGoals(r.goals as Goal[])
        setScope(r.scope)
      },
      () => {},
    )
  }, [floor])

  useEffect(load, [load])

  if (floor === null) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="max-w-md font-display text-[14px] italic leading-relaxed text-sand">
          Pick a floor to see its goals.
        </p>
      </div>
    )
  }

  const add = async (title: string, parentId: string | null) => {
    await api.createFloorGoal(floor.id, { title, parentId: parentId ?? undefined })
    load()
  }

  /* Optimistic, because these are dropdowns and a text field: waiting on a
     round trip per keystroke would make the title unusable. */
  const patch = (id: string, p: Partial<Goal>) => {
    setGoals((prev) =>
      prev.map((g) =>
        g.id === id
          ? { ...g, ...p }
          : { ...g, children: (g.children ?? []).map((c) => (c.id === id ? { ...c, ...p } : c)) },
      ),
    )
    void api.updateFloorGoal(floor.id, id, p).catch(() => load())
  }

  const remove = (id: string) => {
    void api.deleteFloorGoal(floor.id, id).then(load, () => {})
  }

  const sync = async () => {
    setSyncing(true)
    setNote(null)
    try {
      const r = await api.syncFloorGoals(floor.id)
      setGoals(r.goals as Goal[])
      const bits = [
        r.pushed > 0 ? `${r.pushed} sent` : null,
        r.updated > 0 ? `${r.updated} updated` : null,
        r.pulled > 0 ? `${r.pulled} brought back` : null,
      ].filter(Boolean)
      setNote({
        ok: r.failed.length === 0,
        text:
          (bits.length > 0 ? bits.join(' · ') : 'Everything was already in step') +
          (r.failed.length > 0 ? ` · ${r.failed.length} failed: ${r.failed[0]}` : ''),
      })
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Sync failed' })
    } finally {
      setSyncing(false)
    }
  }

  const total = goals.reduce((n, g) => n + 1 + (g.children?.length ?? 0), 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-5 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim">Goals</span>
        <span className="min-w-0 flex-1 font-display text-[13px] italic text-sand">
          What {floor.name} is trying to achieve. Kept here, so they are still here when the CRM
          is not.
        </span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
          {total} {total === 1 ? 'goal' : 'goals'}
        </span>
        <button
          type="button"
          onClick={() => setAdding('root')}
          className="mo-ticks flex shrink-0 cursor-pointer items-center gap-2 border border-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          Add goal
        </button>
        {/* Only once attached: before that "sync" has no second party. */}
        {scope !== null && (
          <button
            type="button"
            onClick={() => void sync()}
            disabled={syncing}
            title={`Sync with the ${scope.targetType} this floor is attached to`}
            className="mo-ticks flex shrink-0 cursor-pointer items-center gap-2 border border-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw
              className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {syncing ? 'Syncing…' : 'Sync with CRM'}
          </button>
        )}
      </div>

      {note !== null && (
        <p
          role={note.ok ? undefined : 'alert'}
          className={`shrink-0 border-b border-hairline px-5 py-2 font-mono text-[9.5px] leading-relaxed tracking-[0.06em] ${
            note.ok ? 'text-sand-dim' : 'text-[#cf6b52]'
          }`}
        >
          {note.text}
        </p>
      )}

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        {adding === 'root' && (
          <div className="px-3">
            <AddGoal
              parentId={null}
              placeholder="What does this floor need to achieve?"
              onAdd={add}
              onCancel={() => setAdding(null)}
            />
          </div>
        )}

        {goals.length === 0 && adding !== 'root' ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-8 text-center">
            <Target className="mb-4 h-6 w-6 text-sand-dim" aria-hidden="true" />
            <p className="font-display text-[14px] italic leading-relaxed text-sand">
              No goals yet. Write what this floor is for, then break each one into the steps that
              get you there.
            </p>
          </div>
        ) : (
          goals.map((g) => {
            const isCollapsed = collapsed.has(g.id)
            const kids = g.children ?? []
            return (
              <div key={g.id}>
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.id)) next.delete(g.id)
                        else next.add(g.id)
                        return next
                      })
                    }
                    aria-label={isCollapsed ? 'Show sub-goals' : 'Hide sub-goals'}
                    className={`flex w-6 shrink-0 cursor-pointer items-center justify-center border-b border-hairline-s text-sand-dim transition-colors duration-150 hover:text-brass ${
                      kids.length === 0 ? 'invisible' : ''
                    }`}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-3 w-3" aria-hidden="true" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <GoalRow
                      goal={g}
                      depth={0}
                      onPatch={patch}
                      onDelete={remove}
                      onAddChild={() => setAdding(g.id)}
                    />
                  </div>
                </div>

                {!isCollapsed &&
                  kids.map((c) => (
                    <div key={c.id} className="flex items-stretch">
                      <span className="w-6 shrink-0 border-b border-hairline-s" />
                      <div className="min-w-0 flex-1">
                        <GoalRow
                          goal={c}
                          depth={1}
                          onPatch={patch}
                          onDelete={remove}
                          onAddChild={null}
                        />
                      </div>
                    </div>
                  ))}

                {adding === g.id && (
                  <div className="pl-9 pr-3">
                    <AddGoal
                      parentId={g.id}
                      placeholder={`A step towards "${g.title}"`}
                      onAdd={add}
                      onCancel={() => setAdding(null)}
                    />
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
