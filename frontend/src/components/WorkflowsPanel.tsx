import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Layers,
  List,
  Network,
  Plus,
  RefreshCw,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { api } from '../lib/api'
import type { Workflow, WorkflowStep } from '../lib/api'
import { WorkflowDiagram } from './WorkflowDiagram'

/**
 * WorkflowsPanel — the workflow TEMPLATES on this machine.
 *
 * A workflow is an ordered tree of steps, and the payload of each step is its
 * markdown tutorial: the thing a spawned Claude session is briefed with. So the
 * tutorial is what this panel is built to show. Everything else — the badges,
 * the counts — is chrome around getting you to the .md of one step.
 *
 * Three decisions worth stating:
 *
 *  · The tutorial renders as PREFORMATTED TEXT, not prettified markdown. What a
 *    session receives is these exact bytes, so showing them rendered would put
 *    a layer of interpretation between you and the prompt you are debugging.
 *    (It also keeps a markdown dependency out of the bundle for one panel.)
 *
 *  · STAGES look different from steps and cannot be opened for a tutorial the
 *    same way. A stage is a container — never dispatched, its status derived
 *    from its children — and drawing it identically to a step is exactly how
 *    the CRM ends up with container rows nobody can ever complete.
 *
 *  · An IMPORT is a snapshot, and the panel says so. Re-importing bumps the
 *    version rather than editing what a run already pinned, so the header
 *    carries the version and where it came from rather than pretending the
 *    workflow is a live view of the CRM.
 */

/** depth is derived, not stored: the server guarantees a valid pre-order tree,
    so a parent is always already seen by the time its child is reached */
function depthsOf(steps: WorkflowStep[]): Map<string, number> {
  const depth = new Map<string, number>()
  for (const s of steps) {
    depth.set(s.id, s.parentId === null ? 0 : (depth.get(s.parentId) ?? 0) + 1)
  }
  return depth
}

function firstLine(md: string): string {
  const line = md
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '')
  return line ?? ''
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// ---------------------------------------------------------------------------

/** one row of the step tree; opens to reveal the step's tutorial verbatim */
function StepRow({
  step,
  depth,
  open,
  onToggle,
}: {
  step: WorkflowStep
  depth: number
  open: boolean
  onToggle: () => void
}) {
  const isStage = step.kind === 'stage'
  const hasBrief = step.brief.trim() !== ''
  const preview = hasBrief ? firstLine(step.brief) : step.summary

  return (
    <li className="border-b border-hairline-s last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ paddingLeft: `${20 + depth * 18}px` }}
        className="flex w-full items-start gap-2.5 py-2.5 pr-5 text-left transition-colors duration-150 hover:bg-white/[0.02]"
      >
        <span className="mt-[3px] shrink-0 text-sand-dim" aria-hidden="true">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>

        <span className="mt-[2px] shrink-0" aria-hidden="true">
          {isStage ? (
            <Layers className="h-3.5 w-3.5 text-brass" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-sand-dim" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span
              className={
                isStage
                  ? 'font-mono text-[11px] uppercase tracking-[0.14em] text-parchment'
                  : 'font-display text-[14px] text-parchment'
              }
            >
              {step.title}
            </span>
            {isStage && (
              <span className="border border-hairline px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim">
                stage
              </span>
            )}
            {step.category !== 'generic' && !isStage && (
              <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                {step.category}
              </span>
            )}
            {step.estimatedMinutes !== null && (
              <span className="font-mono text-[9px] tracking-[0.1em] text-sand-dim">
                {step.estimatedMinutes}m
              </span>
            )}
            {/* a step with no tutorial is the one thing worth flagging: it is
                what makes a spawned session guess instead of follow */}
            {!isStage && !hasBrief && (
              <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#cf6b52]">
                no tutorial
              </span>
            )}
          </span>
          {preview !== '' && (
            <span className="mt-1 block max-w-[68ch] truncate font-display text-[12px] italic text-sand-dim">
              {preview}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div style={{ paddingLeft: `${52 + depth * 18}px` }} className="pb-4 pr-5">
          {hasBrief ? (
            <>
              <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
                Tutorial · .md · briefed verbatim into the session
              </p>
              <pre className="no-scrollbar max-h-[420px] overflow-auto border border-hairline bg-black/20 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-sand">
                {step.brief}
              </pre>
            </>
          ) : (
            <p className="font-display text-[13px] italic text-sand-dim">
              {isStage
                ? 'A stage groups the steps under it. It is never dispatched to a session, and its status comes from its children.'
                : 'No tutorial on this step yet — a session spawned for it would get the workflow goal and nothing more.'}
            </p>
          )}

          {step.attachments.length > 0 && (
            <p className="mt-3 font-mono text-[10px] tracking-[0.08em] text-sand-dim">
              {step.attachments.length} attachment{step.attachments.length === 1 ? '' : 's'}:{' '}
              {step.attachments.map((a) => a.name).join(', ')}
            </p>
          )}
          {step.refs.length > 0 && (
            <p className="mt-1.5 font-mono text-[10px] tracking-[0.08em] text-sand-dim">
              References: {step.refs.map((r) => r.headingText || r.pageSlug).join(', ')}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------

export function WorkflowsPanel() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  const [sopId, setSopId] = useState('')
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** how the detail view draws the steps: as rows you can read, or as the tree
      you can see the shape of. Rows are the default — you open a workflow to
      read a tutorial far more often than to study its shape. */
  const [detailView, setDetailView] = useState<'list' | 'diagram'>('list')

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void api
      .getWorkflows()
      .then(setWorkflows)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not read the workflows.'),
      )
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? null,
    [workflows, selectedId],
  )
  const depths = useMemo(() => (selected ? depthsOf(selected.steps) : new Map()), [selected])

  const handleImport = useCallback(() => {
    const id = sopId.trim()
    if (id === '' || importing) return
    setImporting(true)
    setError(null)
    setNotice(null)
    void api
      .importCrmSop({ sopId: id })
      .then(({ workflow, reimported }) => {
        setWorkflows((prev) => {
          const rest = prev.filter((w) => w.id !== workflow.id)
          return [workflow, ...rest]
        })
        setSelectedId(workflow.id)
        setSopId('')
        setNotice(
          reimported
            ? `Re-imported as version ${workflow.version} — any run already going keeps the version it started on.`
            : `Imported ${workflow.steps.length} steps as a snapshot.`,
        )
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'The import failed.'),
      )
      .finally(() => setImporting(false))
  }, [sopId, importing])

  const handleCreate = useCallback(() => {
    setError(null)
    void api
      .createWorkflow({
        name: 'New workflow',
        brief: '# Goal\n\nWhat this workflow is for.\n',
        steps: [{ title: 'First step', brief: '# First step\n\nHow to do it.\n' }],
      })
      .then((w) => {
        setWorkflows((prev) => [w, ...prev])
        setSelectedId(w.id)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not create the workflow.'),
      )
  }, [])

  const handleDelete = useCallback(
    (id: string) => {
      setError(null)
      void api
        .deleteWorkflow(id)
        .then(() => {
          setWorkflows((prev) => prev.filter((w) => w.id !== id))
          setSelectedId((cur) => (cur === id ? null : cur))
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not delete the workflow.'),
        )
    },
    [],
  )

  const count = loading && workflows.length === 0
    ? 'Reading…'
    : `${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`

  return (
    <section
      aria-label="Workflows"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-midnight"
    >
      <header className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-5 py-3 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
        <span className="h-px w-6 bg-hairline" aria-hidden="true" />
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        {selected === null ? (
          <span>Workflows</span>
        ) : (
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="cursor-pointer uppercase tracking-[0.3em] text-sand transition-colors duration-150 hover:text-brass"
          >
            ← Workflows
          </button>
        )}
        {selected !== null && (
          /* the toggle lives beside the title, not above the content: it
             changes how this workflow is drawn, not what the panel is showing */
          <span className="ml-auto flex items-center border border-hairline">
            {(
              [
                ['list', List, 'Steps as a list'],
                ['diagram', Network, 'Steps as a diagram'],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDetailView(mode)}
                aria-label={label}
                title={label}
                aria-pressed={detailView === mode}
                className={`cursor-pointer px-2 py-1 transition-colors duration-150 ${
                  detailView === mode ? 'bg-white/[0.06] text-brass' : 'text-sand-dim hover:text-sand'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ))}
          </span>
        )}
        <span
          aria-live="polite"
          className={`border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim ${
            selected === null ? 'ml-auto' : ''
          }`}
        >
          {selected === null ? count : `v${selected.version}`}
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label="Reload workflows"
          className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </header>

      {(error !== null || notice !== null) && (
        <div className="shrink-0 px-5 pt-3">
          {error !== null && (
            <p
              role="alert"
              className="border border-[#cf6b52] px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-[#cf6b52]"
            >
              {error}
            </p>
          )}
          {notice !== null && error === null && (
            <p className="border border-hairline px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-sand-dim">
              {notice}
            </p>
          )}
        </div>
      )}

      {selected === null ? (
        <>
          {/* — import + create, above the scroll so they stay reachable — */}
          <div className="shrink-0 border-b border-hairline-s px-5 py-3">
            <div className="flex items-center gap-2 border border-hairline px-3 transition-colors duration-200 focus-within:border-brass">
              <Download className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
              <input
                type="text"
                value={sopId}
                onChange={(e) => setSopId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleImport()
                }}
                placeholder="Import a CRM SOP by id…"
                spellCheck={false}
                aria-label="CRM SOP id"
                className="w-full bg-transparent py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none"
              />
              <button
                type="button"
                onClick={handleImport}
                disabled={importing || sopId.trim() === ''}
                className="shrink-0 cursor-pointer font-mono text-[9px] uppercase tracking-[0.2em] text-sand transition-colors duration-150 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
            </div>
            <button
              type="button"
              onClick={handleCreate}
              className="mt-2.5 flex cursor-pointer items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim transition-colors duration-150 hover:text-brass"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              New workflow
            </button>
          </div>

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
            {loading && workflows.length === 0 ? (
              <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
                Reading the workflows…
              </p>
            ) : workflows.length === 0 ? (
              error === null && (
                <div className="mx-auto flex max-w-md flex-col items-center px-8 py-12 text-center">
                  <WorkflowIcon className="mb-5 h-7 w-7 text-sand-dim" aria-hidden="true" />
                  <h2 className="font-display text-[20px] font-medium leading-tight text-parchment">
                    No workflows <em className="font-normal italic text-brass">yet</em>
                  </h2>
                  <p className="mt-3.5 font-display text-[14px] italic leading-relaxed text-sand">
                    A workflow is an ordered tree of steps, and every step carries the markdown
                    tutorial a Claude session gets briefed with when it runs that step. Import one
                    from a CRM SOP above, or start an empty one and write the steps yourself.
                  </p>
                  <span className="mo-rule mt-7" aria-hidden="true" />
                </div>
              )
            ) : (
              <ul className="list-none">
                {workflows.map((w) => {
                  const dispatchable = w.steps.filter((s) => s.kind === 'step').length
                  return (
                    <li key={w.id} className="border-b border-hairline-s">
                      <div className="group flex items-start gap-3 px-5 py-3.5">
                        <button
                          type="button"
                          onClick={() => setSelectedId(w.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                            <span className="font-display text-[15px] text-parchment">{w.name}</span>
                            <span className="border border-hairline px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim">
                              {w.source === null ? 'authored' : 'crm snapshot'}
                            </span>
                            <span className="font-mono text-[9px] tracking-[0.12em] text-sand-dim">
                              v{w.version}
                            </span>
                          </span>
                          <span className="mt-1 block max-w-[68ch] font-display text-[12px] italic leading-relaxed text-sand-dim">
                            {w.description.trim() !== ''
                              ? w.description
                              : `${dispatchable} dispatchable step${dispatchable === 1 ? '' : 's'}`}
                          </span>
                          <span className="mt-1.5 block font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                            {w.steps.length} step{w.steps.length === 1 ? '' : 's'} · updated{' '}
                            {relTime(w.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(w.id)}
                          aria-label={`Delete ${w.name}`}
                          className="mt-1 shrink-0 cursor-pointer text-sand-dim opacity-0 transition-all duration-150 hover:text-[#cf6b52] group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      ) : (
        /* — detail: the father's context, then the step tree —
             The diagram needs a HEIGHT to lay out in, so in diagram mode the
             container stops scrolling and the canvas takes the remaining space;
             React Flow pans and zooms instead. — */
        <div
          className={
            detailView === 'diagram'
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
              : 'no-scrollbar min-h-0 flex-1 overflow-y-auto'
          }
        >
          <div className="shrink-0 border-b border-hairline-s px-5 py-4">
            <h2 className="font-display text-[22px] font-medium leading-tight text-parchment">
              {selected.name}
            </h2>
            {selected.description.trim() !== '' && (
              <p className="mt-2 max-w-[68ch] font-display text-[14px] italic leading-relaxed text-sand">
                {selected.description}
              </p>
            )}
            <p className="mt-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
              {selected.source === null
                ? 'Authored here'
                : `Snapshot of CRM SOP ${selected.source.sopId ?? ''} v${
                    selected.source.sopVersion ?? '?'
                  }`}
              {' · '}
              {selected.steps.filter((s) => s.kind === 'step').length} dispatchable ·{' '}
              {selected.steps.filter((s) => s.kind === 'stage').length} stages
            </p>
          </div>

          {selected.brief.trim() !== '' && detailView === 'list' && (
            <div className="border-b border-hairline-s px-5 py-4">
              <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
                Father chat context · the knowledge that belongs to no single step
              </p>
              <pre className="no-scrollbar max-h-[240px] overflow-auto border border-hairline bg-black/20 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-sand">
                {selected.brief}
              </pre>
            </div>
          )}

          {selected.steps.length === 0 ? (
            <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
              This workflow has no steps yet.
            </p>
          ) : detailView === 'diagram' ? (
            <WorkflowDiagram workflow={selected} className="min-h-0 flex-1" />
          ) : (
            <ul className="list-none">
              {selected.steps.map((s) => (
                <StepRow
                  key={s.id}
                  step={s}
                  depth={depths.get(s.id) ?? 0}
                  open={openSteps[s.id] === true}
                  onToggle={() =>
                    setOpenSteps((prev) => ({ ...prev, [s.id]: !(prev[s.id] === true) }))
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
