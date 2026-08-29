import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Trash2, X } from 'lucide-react'

/**
 * GoalDialog — add or edit a CRM goal, laid out exactly as the CRM's own
 * GoalEditDialog (sam-crm-fe/src/components/crm/goal-row.tsx).
 *
 * Same fields in the same order: scope, Title, Description, then a two-column
 * grid of Status · Priority · Assigned to (full width) · Due date, with the
 * Pillar select appearing only for a product/service goal — the CRM's own rule,
 * enforced server-side as a (target_type, service_pillar) tuple.
 *
 * TWO DELIBERATE DEPARTURES from the CRM dialog, both because this board is
 * pinned to one floor:
 *
 *   1. THE SCOPE IS NOT EDITABLE. The CRM lets you repoint a goal at another
 *      project from this dialog. Here the floor is attached write-once to one
 *      board, so repointing a goal would delete it from the only board that
 *      shows it, with nothing on screen to say where it went. The scope is
 *      shown as context instead.
 *   2. DELETE ASKS TWICE. Every save here writes to the CRM's PRODUCTION
 *      database.
 *
 * Only fields the user actually changed are sent, so editing a title cannot
 * blank a description, and a goal edited in the CRM meanwhile keeps whatever
 * this dialog did not touch.
 */

export interface GoalDraft {
  id?: string
  title: string
  description?: string
  status: string
  priority: string
  /** null = the whole service; only meaningful when the scope is a service */
  servicePillar?: string | null
  assigneeIds?: string[]
  dueDate?: string | null
}

export interface Member {
  userId: string
  name: string
}

const STATUSES = ['todo', 'in-progress', 'review', 'done', 'abandoned']
const PRIORITIES = ['low', 'medium', 'high', 'urgent']

/* The CRM's own labels — goal-constants.ts STATUS_LABEL. */
const STATUS_LABEL: Record<string, string> = {
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
  abandoned: 'Abandoned',
}

/* goalsController.js:35 GOAL_PILLARS — the server's list, not one of the five
   frontend copies, because the server is what returns 400 on a bad value. */
const PILLARS = ['product', 'operations', 'marketing', 'sales', 'finance', 'management']
const PILLAR_LABEL: Record<string, string> = {
  product: 'Product',
  operations: 'Operations',
  marketing: 'Marketing',
  sales: 'Sales',
  finance: 'Finance',
  management: 'Management',
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const FIELD =
  'w-full border border-hairline bg-midnight px-2 py-1.5 font-display text-[13px] text-parchment outline-none transition-colors duration-200 focus:border-brass'
const LABEL = 'font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim'

/** A dropdown in this app's idiom, standing in for the CRM's SimpleSelect. */
function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  ariaLabel: string
}) {
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className={FIELD + ' cursor-pointer appearance-none pr-7'}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-midnight text-parchment">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-sand-dim"
        aria-hidden="true"
      />
    </div>
  )
}

/** Several people, like the CRM's AssigneePicker: the first is the owner. */
function AssigneePicker({
  value,
  onChange,
  members,
}: {
  value: string[]
  onChange: (next: string[]) => void
  members: Member[]
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name ?? id

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          'flex w-full cursor-pointer items-center gap-2 border px-2 py-1.5 text-left transition-colors duration-200 ' +
          (open ? 'border-brass' : 'border-hairline hover:border-brass')
        }
      >
        <span
          className={
            'min-w-0 flex-1 truncate font-display text-[13px] ' +
            (value.length ? 'text-parchment' : 'text-sand-dim')
          }
        >
          {value.length === 0
            ? 'Unassigned'
            : value.map(nameOf).join(', ')}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
      </button>
      {value.length > 1 && (
        <p className="mt-1 font-display text-[11px] italic text-sand-dim">
          {nameOf(value[0])} is the owner — the CRM takes the first assignee.
        </p>
      )}
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto border border-hairline bg-surface shadow-lg shadow-black/40">
          {members.length === 0 ? (
            <p className="px-3 py-2 font-display text-[12px] italic text-sand-dim">
              No one to assign — the CRM roster could not be read.
            </p>
          ) : (
            members.map((m) => {
              const on = value.includes(m.userId)
              return (
                <button
                  key={m.userId}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(m.userId)}
                  className={
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-display text-[12px] transition-colors duration-100 ' +
                    (on ? 'text-brass' : 'text-sand hover:bg-surface-2/60')
                  }
                >
                  <Check
                    className={'h-3 w-3 shrink-0 ' + (on ? 'text-brass' : 'text-transparent')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

export function GoalDialog({
  initial,
  scope,
  scopeLabel,
  scopeTargetType,
  members,
  onClose,
  onSaved,
}: {
  /** an existing goal to edit, or a blank draft to create */
  initial: GoalDraft
  /** the board this goal belongs to. A CREATED goal carries it, or the CRM
   *  defaults the goal to organization-wide and it never appears on the board
   *  that created it. */
  scope: { targetType: string; targetId: string | null } | null
  /** what the goal is attached to, shown so it is never a surprise */
  scopeLabel: string
  /** the goal's own target type — 'service' is what unlocks the pillar select */
  scopeTargetType: string | null
  members: Member[]
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = Boolean(initial.id)
  const [title, setTitle] = useState(initial.title)
  const [description, setDescription] = useState(initial.description ?? '')
  const [status, setStatus] = useState(initial.status)
  const [priority, setPriority] = useState(initial.priority)
  const [pillar, setPillar] = useState(initial.servicePillar ?? '')
  const [assignees, setAssignees] = useState<string[]>(initial.assigneeIds ?? [])
  const [dueDate, setDueDate] = useState(initial.dueDate ? initial.dueDate.slice(0, 10) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)

  /* The CRM's rule, mirrored: a pillar exists only on a service goal. */
  const pillarApplies = scopeTargetType === 'service'

  useEffect(() => {
    const t = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const save = async () => {
    const t = title.trim()
    if (!t) {
      setError('A title is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const url = isEdit ? `/api/crm/goals/${initial.id}` : '/api/crm/goals'
      const sameList = (a: string[], b: string[]) =>
        a.length === b.length && a.every((x, i) => x === b[i])
      const initialDue = initial.dueDate ? initial.dueDate.slice(0, 10) : ''
      /* On edit send only what changed — a PATCH carrying every field would
         overwrite anything edited in the CRM since this dialog opened.
         `servicePillar` sends null, not '', to CLEAR a pillar: the two are
         different instructions to the CRM and '' would fail its tuple check. */
      const body: Record<string, unknown> = isEdit
        ? {
            ...(t !== initial.title ? { title: t } : {}),
            ...(description !== (initial.description ?? '') ? { description } : {}),
            ...(status !== initial.status ? { status } : {}),
            ...(priority !== initial.priority ? { priority } : {}),
            ...(pillarApplies && pillar !== (initial.servicePillar ?? '')
              ? { servicePillar: pillar === '' ? null : pillar }
              : {}),
            ...(!sameList(assignees, initial.assigneeIds ?? []) ? { assigneeIds: assignees } : {}),
            ...(dueDate !== initialDue ? { dueDate: dueDate === '' ? null : dueDate } : {}),
          }
        : {
            title: t,
            description,
            status,
            priority,
            assigneeIds: assignees,
            dueDate: dueDate || null,
            ...(pillarApplies && pillar ? { servicePillar: pillar } : {}),
            /* THE SCOPE. Without it crmCreateGoal defaults target_type to
               'organization', so a goal added from a project or service board
               was written org-wide and vanished from the board that created
               it — no error, just gone. */
            targetType: scope?.targetType ?? 'organization',
            targetId: scope?.targetId ?? null,
          }

      if (isEdit && Object.keys(body).length === 0) {
        onClose()
        return
      }
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parsed?.error || `HTTP ${res.status}`)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error)?.message || 'the CRM refused the change')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!initial.id) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/goals/${initial.id}`, { method: 'DELETE' })
      const parsed = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parsed?.error || `HTTP ${res.status}`)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error)?.message || 'the CRM refused the delete')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit goal' : 'Add goal'}
        style={{ background: 'var(--color-surface)' }}
        className="mo-card flex max-h-[85vh] w-full max-w-lg flex-col shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
              {isEdit ? 'Edit goal' : 'Add goal'}
            </p>
            {/* The CRM's own subtitle, verbatim. */}
            <p className="mt-1 font-display text-[12px] italic leading-relaxed text-sand-dim">
              {isEdit
                ? 'Changes apply everywhere this goal appears.'
                : 'This creates a real goal in the CRM, visible to everyone.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          {/* Scope, as context. The CRM puts an editable picker here; this board
              is pinned to one floor, so the scope is stated and left alone. */}
          <div className="flex flex-col gap-1">
            <span className={LABEL}>Scope</span>
            <p className="border border-hairline bg-midnight px-2 py-1.5 font-display text-[13px] text-sand">
              {scopeLabel}
              <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                fixed by this floor
              </span>
            </p>
          </div>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void save()
                }
              }}
              className={FIELD}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={FIELD + ' resize-none'}
            />
          </label>

          {/* The CRM's `grid grid-cols-2 gap-3`, with the same span rules. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className={LABEL}>Status</span>
              <Select
                ariaLabel="Status"
                value={status}
                onChange={setStatus}
                options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] ?? s }))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className={LABEL}>Priority</span>
              <Select
                ariaLabel="Priority"
                value={priority}
                onChange={setPriority}
                options={PRIORITIES.map((p) => ({ value: p, label: cap(p) }))}
              />
            </div>

            {/* Only for a product/service goal — the CRM refuses a pillar on any
                other scope, so offering one would be offering a 400. */}
            {pillarApplies && (
              <div className="col-span-2 flex flex-col gap-1">
                <span className={LABEL}>
                  Pillar of service <span className="normal-case tracking-normal">(optional)</span>
                </span>
                <Select
                  ariaLabel="Pillar of service"
                  value={pillar}
                  onChange={setPillar}
                  options={[
                    { value: '', label: '— Whole service (no specific pillar) —' },
                    ...PILLARS.map((p) => ({ value: p, label: PILLAR_LABEL[p] })),
                  ]}
                />
                <p className="font-display text-[11px] italic leading-relaxed text-sand-dim">
                  Leave blank for a goal across the whole service.
                </p>
              </div>
            )}

            <div className="col-span-2 flex flex-col gap-1">
              <span className={LABEL}>Assigned to</span>
              <AssigneePicker value={assignees} onChange={setAssignees} members={members} />
            </div>

            <div className="flex flex-col gap-1">
              <span className={LABEL}>Due date</span>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                aria-label="Due date"
                className={FIELD + ' [color-scheme:dark]'}
              />
            </div>
          </div>

          {error !== null && (
            <p className="border border-hairline bg-midnight px-3 py-2 font-display text-[12.5px] leading-relaxed text-sand">
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-hairline px-5 py-3">
          {isEdit &&
            (confirmDelete ? (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="flex cursor-pointer items-center gap-1.5 border border-brass px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Really delete
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="flex cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete
              </button>
            ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || title.trim() === ''}
            className="cursor-pointer border border-brass bg-brass/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Saving…' : isEdit ? 'Save to CRM' : 'Create in CRM'}
          </button>
        </footer>
      </div>
    </div>
  )
}
