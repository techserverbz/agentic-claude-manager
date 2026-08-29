import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Ban,
  Check,
  Columns3,
  Crown,
  FileText,
  Layers,
  List,
  Network,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Zap,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import type { DispatchEdge, Workflow, WorkflowRun, WorkflowRunStep } from '../lib/api'
import { WorkflowDiagram } from './WorkflowDiagram'
import type { RunOverlay } from './WorkflowDiagram'

/**
 * RunBoard — one run of one workflow: what every step is doing and who is on it.
 *
 * This is the father's desk. A run is a dozen Claude sessions started minutes
 * apart, each holding one step of an SOP, and the only place their state is
 * gathered is here. Four decisions carry the whole design:
 *
 *  · It POLLS. Every fact on this board is about processes that move without
 *    being asked — a step marks itself done through MCP, a pty gets reaped — so
 *    a board that only updated when you clicked would be quietly wrong most of
 *    the time. It stops polling once the run is done or cancelled, because then
 *    nothing can change on its own again.
 *
 *  · DEPENDENCIES ARE READ FROM THE TEMPLATE, not the run. A run snapshots the
 *    shape of its steps but not their dependsOn, and the server's readySteps()
 *    reads the template too. Deriving them from anywhere else here would give
 *    the board an opinion the dispatcher does not share.
 *
 *  · A REFUSED DISPATCH IS SHOWN, NOT SWALLOWED. The server answers 409 when a
 *    step is already working or already finished, and it is usually right: that
 *    order was given from a board you had been staring at for ten minutes. So
 *    its own words go under the row, and only then is a force retry offered.
 *
 *  · STAGES CARRY NO CONTROLS. A stage is a container whose status is derived
 *    from its children on every write; offering "mark done" on one would hand
 *    you a button whose effect is silently undone on the next read.
 */

/** Slow enough to be invisible, fast enough that a dispatch you just ordered
    turns up before you start wondering whether it worked. */
const POLL_MS = 5000

const STATUS_CLASS: Record<WorkflowRunStep['status'], string> = {
  pending: 'text-sand-dim',
  dispatched: 'text-brass',
  'in-progress': 'text-brass',
  review: 'text-brass',
  done: 'text-brass',
  blocked: 'text-[#cf6b52]',
  skipped: 'text-sand-dim',
}

const RUN_STATUS_CLASS: Record<WorkflowRun['status'], string> = {
  running: 'text-brass',
  paused: 'text-sand',
  done: 'text-sand-dim',
  cancelled: 'text-[#cf6b52]',
}

/** shared by every small text control in a row */
const ACTION =
  'cursor-pointer font-mono text-[9px] uppercase tracking-[0.2em] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40'

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

/**
 * Indent depth, walked up the parent chain rather than taken from the order of
 * the array. The run's steps are a snapshot and a step whose parent was later
 * dropped from the template still stands here, so "my parent came just before
 * me" is not safe to assume. The hop limit is the cycle guard.
 */
function depthsOf(steps: WorkflowRunStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.stepId, s]))
  const out = new Map<string, number>()
  for (const s of steps) {
    let depth = 0
    let parent = s.parentId
    while (parent !== null && depth < 16) {
      const up = byId.get(parent)
      if (!up) break
      depth += 1
      parent = up.parentId
    }
    out.set(s.stepId, depth)
  }
  return out
}

// ---------------------------------------------------------------------------

/** one step of the run: what it is, who is on it, and what can be done to it */
function StepRow({
  step,
  depth,
  waitingOn,
  busy,
  refusal,
  canOpen,
  onDispatch,
  onOpen,
  onStatus,
}: {
  step: WorkflowRunStep
  depth: number
  /** titles of the dependencies that have not finished — empty when ready */
  waitingOn: string[]
  busy: boolean
  /** the server's own words, when it refused the last dispatch of THIS step */
  refusal: string | null
  canOpen: boolean
  onDispatch: (step: WorkflowRunStep, force?: boolean) => void
  onOpen: (step: WorkflowRunStep) => void
  onStatus: (
    step: WorkflowRunStep,
    status: 'in-progress' | 'review' | 'done' | 'blocked' | 'skipped',
    extra?: { result?: string; reason?: string },
  ) => void
}) {
  /** null while the row is not asking for a reason; a string once it is */
  const [reason, setReason] = useState<string | null>(null)

  const isStage = step.kind === 'stage'
  const live = step.live === true
  const waiting = waitingOn.length > 0 && step.status !== 'done' && step.status !== 'skipped'

  return (
    <li className="border-b border-hairline-s last:border-b-0">
      <div style={{ paddingLeft: `${20 + depth * 18}px` }} className="py-2.5 pr-5">
        <div className="flex items-start gap-2.5">
          <span className="mt-[2px] shrink-0" aria-hidden="true">
            {isStage ? (
              <Layers className="h-3.5 w-3.5 text-brass" />
            ) : (
              <FileText className="h-3.5 w-3.5 text-sand-dim" />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
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
              <span
                className={`font-mono text-[9px] uppercase tracking-[0.16em] ${STATUS_CLASS[step.status]}`}
              >
                {step.status.replace('_', ' ')}
              </span>
              {live && (
                <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[#6fbf73]"
                    aria-hidden="true"
                  />
                  chat live
                </span>
              )}
              {step.sessionId !== null && !live && (
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                  chat asleep
                </span>
              )}
            </div>

            {waiting && (
              /* The SOP is a chain. Firing step seven before step six is the
                 mistake this board exists to prevent, so the wait is stated in
                 the row rather than left for the reader to work out. */
              <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                waiting on {waitingOn.join(' · ')}
              </p>
            )}

            {step.status === 'blocked' && step.blockedReason !== null && step.blockedReason !== '' && (
              <p className="mt-1.5 max-w-[68ch] font-display text-[12px] italic leading-relaxed text-[#cf6b52]">
                {step.blockedReason}
              </p>
            )}

            {step.status === 'done' && step.result !== null && step.result.trim() !== '' && (
              <>
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
                  Reported back {step.doneAt !== null ? `· ${relTime(step.doneAt)}` : ''}
                </p>
                <pre className="no-scrollbar mt-1.5 max-h-[180px] max-w-[80ch] overflow-auto border border-hairline bg-black/20 px-3 py-2 font-mono text-[10px] leading-relaxed text-sand">
                  {step.result}
                </pre>
              </>
            )}

            {!isStage && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {/* Named for what it actually does. This button starts a real
                    Claude process; calling it "run" would hide that. */}
                <button
                  type="button"
                  onClick={() => onDispatch(step)}
                  disabled={busy}
                  title={
                    waiting
                      ? `Waiting on ${waitingOn.join(', ')} — dispatching now runs the SOP out of order`
                      : 'Writes the step brief and starts a Claude session on it'
                  }
                  className={`${ACTION} ${
                    waiting ? 'text-sand-dim opacity-60 hover:text-sand' : 'text-sand hover:text-brass'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Zap className="h-3 w-3" aria-hidden="true" />
                    {busy
                      ? 'Dispatching…'
                      : step.sessionId === null
                        ? 'Dispatch · spawns a chat'
                        : 'Dispatch · wakes its chat'}
                  </span>
                </button>

                {step.sessionId !== null && (
                  <button
                    type="button"
                    onClick={() => onOpen(step)}
                    disabled={!canOpen}
                    title={
                      canOpen
                        ? 'Open this step’s chat in a pane'
                        : 'The directory this run started in is no longer registered'
                    }
                    className={`${ACTION} text-sand-dim hover:text-brass`}
                  >
                    Open chat
                  </button>
                )}

                {step.status === 'dispatched' && (
                  <button
                    type="button"
                    onClick={() => onStatus(step, 'in-progress')}
                    disabled={busy}
                    className={`${ACTION} text-sand-dim hover:text-brass`}
                  >
                    Mark started
                  </button>
                )}

                {step.status !== 'done' && (
                  <button
                    type="button"
                    onClick={() => onStatus(step, 'done')}
                    disabled={busy}
                    className={`${ACTION} text-sand-dim hover:text-brass`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Check className="h-3 w-3" aria-hidden="true" />
                      Done
                    </span>
                  </button>
                )}

                {step.status !== 'blocked' && (
                  <button
                    type="button"
                    onClick={() => setReason((cur) => (cur === null ? '' : null))}
                    disabled={busy}
                    aria-expanded={reason !== null}
                    className={`${ACTION} text-sand-dim hover:text-[#cf6b52]`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Ban className="h-3 w-3" aria-hidden="true" />
                      Blocked
                    </span>
                  </button>
                )}

                {step.status !== 'skipped' && (
                  <button
                    type="button"
                    onClick={() => onStatus(step, 'skipped')}
                    disabled={busy}
                    title="Skipped steps stay in the denominator — the run does not pretend they never existed"
                    className={`${ACTION} text-sand-dim hover:text-brass`}
                  >
                    <span className="flex items-center gap-1.5">
                      <SkipForward className="h-3 w-3" aria-hidden="true" />
                      Skip
                    </span>
                  </button>
                )}
              </div>
            )}

            {reason !== null && (
              <div className="mt-2 flex items-center gap-2 border border-hairline px-3 transition-colors duration-200 focus-within:border-brass">
                <input
                  type="text"
                  value={reason}
                  autoFocus
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setReason(null)
                    if (e.key === 'Enter' && reason.trim() !== '') {
                      onStatus(step, 'blocked', { reason: reason.trim() })
                      setReason(null)
                    }
                  }}
                  placeholder="What is holding this step up…"
                  aria-label={`Why ${step.title} is blocked`}
                  className="w-full bg-transparent py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (reason.trim() === '') return
                    onStatus(step, 'blocked', { reason: reason.trim() })
                    setReason(null)
                  }}
                  disabled={reason.trim() === ''}
                  className={`${ACTION} shrink-0 text-sand hover:text-brass`}
                >
                  Save
                </button>
              </div>
            )}

            {refusal !== null && (
              /* The refusal, in the server's words. It knows why — already
                 dispatched, already done, is a stage — and paraphrasing it here
                 would eventually say something the server no longer means. */
              <div className="mt-2 max-w-[80ch] border border-[#cf6b52] px-3 py-2">
                <p
                  role="alert"
                  className="font-mono text-[10px] leading-relaxed tracking-[0.08em] text-[#cf6b52]"
                >
                  {refusal}
                </p>
                <button
                  type="button"
                  onClick={() => onDispatch(step, true)}
                  disabled={busy}
                  className={`${ACTION} mt-1.5 text-sand hover:text-brass`}
                >
                  Dispatch anyway
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------

/** What each kind of edge is CALLED. The raw enum never reaches the screen:
 *  "block" is a STATE a step sits in, "reported a block to the father" is the
 *  thing that happened at 14:02, and this list is a list of things that
 *  happened. Each verb is written to complete the sentence "<who> ... <whom>". */
const EVENT_VERB: Record<DispatchEdge['kind'], string> = {
  spawn: 'started the father chat',
  dispatch: 'dispatched',
  message: 'messaged',
  broadcast: 'broadcast to the whole run',
  report: 'reported back to',
  block: 'reported a block to',
  note: 'left a note for',
  complete: 'closed the run',
}

/** Verbs that already NAME what they acted on. Every other line reads
 *  "<who> <verb> <whom>", and these three would then say it twice: the spawn
 *  edge is addressed to the father, so printing the target after "started the
 *  father chat" gives "You started the father chat The father". */
const EVENT_NAMES_ITS_OWN_TARGET = new Set<DispatchEdge['kind']>(['spawn', 'broadcast', 'complete'])

/** The one event that carries meaning in colour; everything else stays neutral. */
const EVENT_TINT: Partial<Record<DispatchEdge['kind'], string>> = {
  block: 'text-[#cf6b52]',
  dispatch: 'text-brass',
}

function clockOf(iso: string): string {
  const t = new Date(iso)
  return Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The dispatch tree AS A LIST, in the order it happened.
 *
 * The tree beside it cannot carry all of this, and that is the reason both are
 * here rather than one. A broadcast has no single target, so it is an event with
 * no arrow at all. Two dispatches of one step are one arrow and two events. And
 * an arrow has no time on it, so a tree alone can never say whether the peer
 * message came before or after the block it looks like a response to.
 */
function EventList({
  edges,
  nameFor,
}: {
  edges: DispatchEdge[]
  /** a session id rendered as who it is on this board */
  nameFor: (sessionId: string | null) => string
}) {
  if (edges.length === 0) {
    return (
      <p className="px-5 py-4 font-display text-[13px] italic leading-relaxed text-sand-dim">
        Nothing has moved in this run yet. Every dispatch, message and report back is recorded here
        as it happens — a run started before this log existed keeps its tree, but has no history to
        show.
      </p>
    )
  }
  return (
    <ol className="list-none">
      {[...edges].reverse().map((e) => (
        /* NEWEST FIRST on screen, oldest first on the wire. The log is written
           forwards because that is what a history is; it is read backwards
           because the thing you came to find out is what just happened. */
        <li key={e.id} className="border-b border-hairline-s px-5 py-2 last:border-b-0">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[9px] uppercase tracking-[0.16em]">
            <span className="text-sand-dim">{clockOf(e.ts)}</span>
            <span className="text-sand">{nameFor(e.fromSessionId)}</span>
            <span className={EVENT_TINT[e.kind] ?? 'text-sand-dim'}>{EVENT_VERB[e.kind]}</span>
            {EVENT_NAMES_ITS_OWN_TARGET.has(e.kind) ? null : e.toSessionId !== null ? (
              <span className="text-sand">{nameFor(e.toSessionId)}</span>
            ) : (
              /* A kind that is genuinely addressed to nobody in particular has
                 already been handled above. Reaching here with no target means
                 it went to a terminal that had not minted an id yet, and saying
                 so beats an event that trails off mid-sentence. */
              <span className="text-sand-dim">a chat with no id yet</span>
            )}
            {e.kind === 'broadcast' && Array.isArray(e.meta?.sentTo) && (
              <span className="text-sand-dim">
                · {(e.meta.sentTo as unknown[]).length} chat
                {(e.meta.sentTo as unknown[]).length === 1 ? '' : 's'} heard it
              </span>
            )}
            {e.meta?.force === true && <span className="text-[#cf6b52]">· forced</span>}
          </p>
          {e.text.trim() !== '' && (
            <p className="mt-1 max-w-[80ch] truncate font-display text-[12px] italic text-sand-dim">
              {e.text}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------------------

export function RunBoard({
  runId,
  onOpenSession,
  onBack,
}: {
  runId: string
  onOpenSession: (sessionId: string, cwd: string) => void
  onBack: () => void
}) {
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  /** the recorded dispatch tree, oldest first. Empty for a run started before
      the log existed, which is exactly when the diagram falls back to inference. */
  const [edges, setEdges] = useState<DispatchEdge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** rows to read, or the tree to see the shape of. Rows are the default: you
      open a board to act on a step far more often than to study the tree. */
  const [view, setView] = useState<'list' | 'diagram'>('list')
  /** the cwd the sessions of this run live in; null when it cannot be resolved */
  const [cwd, setCwd] = useState<string | null>(null)
  const [busyStep, setBusyStep] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ stepId: string; message: string } | null>(null)

  /** `quiet` is the polling read: it must never blank the board or take over
      the error line, because one dropped request is not news. */
  const refresh = useCallback(
    (quiet = false): Promise<void> =>
      // Both reads on the SAME poll, so the tree and the rows can never be one
      // tick out of step with each other. The history is settled with allSettled
      // rather than awaited alongside: a run whose log could not be read is
      // still a run, and losing the board over a missing history would be the
      // logging failure breaking the thing being logged, one layer up.
      Promise.allSettled([api.getWorkflowRun(runId), api.getRunDispatch(runId)])
        .then(([runRes, edgeRes]) => {
          if (runRes.status === 'fulfilled') {
            setRun(runRes.value.run)
            setWorkflow(runRes.value.workflow)
            setError(null)
          } else if (!quiet) {
            const err = runRes.reason
            setError(err instanceof Error ? err.message : 'Could not read this run.')
          }
          if (edgeRes.status === 'fulfilled') setEdges(edgeRes.value)
        })
        .then(() => undefined),
    [runId],
  )

  useEffect(() => {
    // A different run: drop the old board rather than show its name over the
    // new one's numbers for a beat.
    setRun(null)
    setWorkflow(null)
    setEdges([])
    setRefusal(null)
    setNotice(null)
    setLoading(true)
    void refresh().finally(() => setLoading(false))
  }, [refresh])

  const hasRun = run !== null
  const settled = run?.status === 'done' || run?.status === 'cancelled'
  useEffect(() => {
    // Nothing moves on its own once a run is done or cancelled, so the timer is
    // not merely wasteful then — it is a promise of freshness with nothing behind it.
    if (!hasRun || settled) return
    const timer = window.setInterval(() => void refresh(true), POLL_MS)
    return () => window.clearInterval(timer)
  }, [hasRun, settled, refresh])

  /* A session is opened by (id, cwd), and the run stores only the id of the
     directory project. The path cannot change under a running run, so this is
     keyed on that id and not re-fetched on every poll. */
  const projectId = run?.projectId ?? null
  useEffect(() => {
    if (projectId === null) {
      setCwd(null)
      return
    }
    let dropped = false
    void api
      .getProjects()
      .then((projects) => {
        if (!dropped) setCwd(projects.find((p) => p.id === projectId)?.fileDir ?? null)
      })
      .catch(() => {
        /* the open controls stay disabled and say why — no error line for this */
      })
    return () => {
      dropped = true
    }
  }, [projectId])

  const steps = useMemo(
    () => (run === null ? [] : [...run.steps].sort((a, b) => a.ord - b.ord)),
    [run],
  )
  const depths = useMemo(() => depthsOf(steps), [steps])
  const statusById = useMemo(() => new Map(steps.map((s) => [s.stepId, s.status])), [steps])
  const titleById = useMemo(() => new Map(steps.map((s) => [s.stepId, s.title])), [steps])

  /** dependsOn belongs to the TEMPLATE — the run never snapshots it — so the
      board and the server's readySteps() are reading the same one fact. */
  const dependsOn = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const s of workflow?.steps ?? []) map.set(s.id, s.dependsOn)
    return map
  }, [workflow])

  const waitingOn = useCallback(
    (stepId: string): string[] =>
      (dependsOn.get(stepId) ?? [])
        .filter((dep) => {
          const st = statusById.get(dep)
          // A dependency that is not in this run at all counts as satisfied,
          // which is exactly what the server does — otherwise a step deleted
          // from the template would wedge every step downstream of it.
          return st !== undefined && st !== 'done' && st !== 'skipped'
        })
        .map((dep) => titleById.get(dep) ?? 'a step no longer in this run'),
    [dependsOn, statusById, titleById],
  )

  const progress = useMemo(() => {
    if (run === null) return { done: 0, total: 0 }
    if (run.progress) return run.progress
    // Fallback mirrors the server's progressOf(): stages are not work, and a
    // skipped step counts as done while STAYING in the denominator.
    const workable = run.steps.filter((s) => s.kind !== 'stage')
    return {
      done: workable.filter((s) => s.status === 'done' || s.status === 'skipped').length,
      total: workable.length,
    }
  }, [run])

  const liveSteps = useMemo(
    () => steps.filter((s) => s.kind !== 'stage' && s.live === true && s.sessionId !== null),
    [steps],
  )

  /** The dispatch tree (plan item 12). The ARROWS come from the log, which is
      the record of what happened; the run supplies only the state each node is
      in and the session ids that let a logged edge find its node. */
  const overlay = useMemo<RunOverlay | null>(() => {
    if (run === null) return null
    const byStep = new Map<
      string,
      { status: string; live: boolean; dispatched: boolean; sessionId: string | null }
    >()
    for (const s of run.steps) {
      byStep.set(s.stepId, {
        status: s.status,
        live: s.live === true,
        // Only the FALLBACK reads this. A step has been dispatched exactly when
        // it has a session; reading the status instead would lose the ones that
        // have since gone done.
        dispatched: s.sessionId !== null,
        sessionId: s.sessionId,
      })
    }
    return {
      fatherTitle: run.name,
      fatherLive: run.fatherLive === true,
      fatherSessionId: run.fatherSessionId,
      byStep,
      edges,
    }
  }, [run, edges])

  /** A session id as who it is on this board. Falls back to the short id: a
      chat that has left the run, or one that was never a step, is still a real
      party to the event and must not be rendered as a blank. */
  const nameFor = useCallback(
    (sessionId: string | null): string => {
      if (sessionId === null) return 'You'
      if (run !== null && sessionId === run.fatherSessionId) return 'The father'
      const step = run?.steps.find((s) => s.sessionId === sessionId)
      return step ? step.title : `chat ${sessionId.slice(0, 8)}`
    },
    [run],
  )

  const handleDispatch = useCallback(
    (step: WorkflowRunStep, force = false) => {
      setBusyStep(step.stepId)
      setError(null)
      setNotice(null)
      setRefusal(null)
      void api
        .dispatchStep(runId, step.stepId, force ? { force: true } : undefined)
        .then(({ sessionId, created }) => {
          // Opening it is the point: a chat you spawned and cannot see is
          // indistinguishable from one that never started.
          const opened = cwd !== null
          if (cwd !== null) onOpenSession(sessionId, cwd)
          setNotice(
            `${
              created
                ? `Spawned a chat for “${step.title}”. It is reading its brief now.`
                : `Woke the chat already sitting on “${step.title}”.`
            }${opened ? ' Opened it in a pane.' : ''}`,
          )
          return refresh()
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 409) {
            // The server refuses a step that is already working or finished.
            // Keep its wording, put it under the row it belongs to, and re-read
            // — the board that produced this order was out of date.
            setRefusal({ stepId: step.stepId, message: err.message })
            void refresh(true)
            return
          }
          setError(err instanceof Error ? err.message : 'The dispatch failed.')
        })
        .finally(() => setBusyStep(null))
    },
    [runId, cwd, onOpenSession, refresh],
  )

  const handleStatus = useCallback(
    (
      step: WorkflowRunStep,
      status: 'in-progress' | 'review' | 'done' | 'blocked' | 'skipped',
      extra?: { result?: string; reason?: string },
    ) => {
      setBusyStep(step.stepId)
      setError(null)
      setNotice(null)
      // A refusal was about dispatching this step from the state it was in a
      // moment ago; moving it on makes that answer stale, so it goes.
      setRefusal(null)
      void api
        .setRunStepStatus(runId, step.stepId, status, extra)
        // The status routes answer with the BARE stored run — no progress, no
        // liveness — so the reply is dropped and the computed one re-read.
        // Splicing the poorer object into state blanks the live dots.
        .then(() => refresh())
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not update the step.'),
        )
        .finally(() => setBusyStep(null))
    },
    [runId, refresh],
  )

  const handleRunStatus = useCallback(
    (status: 'running' | 'paused' | 'done' | 'cancelled') => {
      setError(null)
      setNotice(null)
      void api
        .setRunStatus(runId, status)
        .then(() => refresh())
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not update the run.'),
        )
    },
    [runId, refresh],
  )

  const handleOpenFather = useCallback(() => {
    const sessionId = run?.fatherSessionId ?? null
    if (sessionId === null || cwd === null) return
    onOpenSession(sessionId, cwd)
  }, [run, cwd, onOpenSession])

  /* Plan item 5: chat 1 | chat 2 | chat 3. One call per live step, in step
     order, so the panes land in the order the SOP reads. */
  const handleOpenSideBySide = useCallback(() => {
    if (cwd === null) return
    for (const s of liveSteps) {
      if (s.sessionId !== null) onOpenSession(s.sessionId, cwd)
    }
  }, [cwd, liveSteps, onOpenSession])

  const dispatchable = steps.filter((s) => s.kind !== 'stage').length

  return (
    <section
      aria-label="Workflow run"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-midnight"
    >
      <header className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-5 py-3 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
        <span className="h-px w-6 bg-hairline" aria-hidden="true" />
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 uppercase tracking-[0.3em] text-sand transition-colors duration-150 hover:text-brass"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate text-sand-dim">{run?.name ?? 'Run'}</span>

        {run !== null && (
          <span className="flex items-center border border-hairline">
            {(
              [
                ['list', List, 'Steps as a list'],
                ['diagram', Network, 'The dispatch tree'],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-label={label}
                title={label}
                aria-pressed={view === mode}
                className={`cursor-pointer px-2 py-1 transition-colors duration-150 ${
                  view === mode ? 'bg-white/[0.06] text-brass' : 'text-sand-dim hover:text-sand'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ))}
          </span>
        )}

        <span
          aria-live="polite"
          className="border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim"
        >
          {progress.done}/{progress.total} done
        </span>
        <button
          type="button"
          onClick={() => {
            setLoading(true)
            void refresh().finally(() => setLoading(false))
          }}
          disabled={loading}
          aria-label="Reload this run"
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

      {run === null ? (
        <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
          {loading ? 'Reading the run…' : 'This run could not be read.'}
        </p>
      ) : (
        <div
          className={
            /* The diagram lays out into its container, so a zero-height parent
               draws nothing. In diagram mode this column stops scrolling and
               hands the remaining height to the canvas, which pans instead. */
            view === 'diagram'
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
              : 'no-scrollbar min-h-0 flex-1 overflow-y-auto'
          }
        >
          {/* — the masthead: what this run is, and the father who is running it — */}
          <div className="shrink-0 border-b border-hairline-s px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
              <h2 className="font-display text-[22px] font-medium leading-tight text-parchment">
                {run.name}
              </h2>
              <span
                className={`border border-hairline px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.2em] ${RUN_STATUS_CLASS[run.status]}`}
              >
                {run.status}
              </span>
            </div>
            <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
              {progress.done} of {progress.total} steps done · started {relTime(run.startedAt)} ·
              template v{run.workflowVersion}
              {run.endedAt !== null ? ` · ended ${relTime(run.endedAt)}` : ''}
            </p>

            <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
              {run.fatherSessionId !== null ? (
                <button
                  type="button"
                  onClick={handleOpenFather}
                  disabled={cwd === null}
                  title={
                    cwd === null
                      ? 'The directory this run started in is no longer registered'
                      : 'Open the father chat in a pane'
                  }
                  className="flex cursor-pointer items-center gap-2 border border-hairline px-2.5 py-1.5 transition-colors duration-150 hover:border-brass disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Crown className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-sand">
                    Father chat
                  </span>
                  {run.fatherLive === true ? (
                    <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#6fbf73]" aria-hidden="true" />
                      live
                    </span>
                  ) : (
                    <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                      asleep
                    </span>
                  )}
                </button>
              ) : (
                <p className="font-display text-[13px] italic text-sand-dim">
                  No father chat on this run — it was never spawned.
                </p>
              )}

              <button
                type="button"
                onClick={handleOpenSideBySide}
                disabled={liveSteps.length === 0 || cwd === null}
                title={
                  liveSteps.length === 0
                    ? 'No step chat is live at the moment'
                    : `Opens ${liveSteps.length} pane${liveSteps.length === 1 ? '' : 's'}, one per live step chat, in step order`
                }
                className="flex cursor-pointer items-center gap-2 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
                {liveSteps.length === 0
                  ? 'No step chat is live'
                  : `Open ${liveSteps.length} live step chat${liveSteps.length === 1 ? '' : 's'} side by side`}
              </button>

              {run.status === 'running' && (
                <button
                  type="button"
                  onClick={() => handleRunStatus('paused')}
                  className={`${ACTION} ml-auto text-sand-dim hover:text-brass`}
                >
                  <span className="flex items-center gap-1.5">
                    <Pause className="h-3 w-3" aria-hidden="true" />
                    Pause the run
                  </span>
                </button>
              )}
              {run.status !== 'running' && (
                <button
                  type="button"
                  onClick={() => handleRunStatus('running')}
                  className={`${ACTION} ml-auto text-sand-dim hover:text-brass`}
                >
                  <span className="flex items-center gap-1.5">
                    <Play className="h-3 w-3" aria-hidden="true" />
                    {run.status === 'paused' ? 'Resume the run' : 'Reopen the run'}
                  </span>
                </button>
              )}
              {!settled && (
                <button
                  type="button"
                  onClick={() => handleRunStatus('cancelled')}
                  title="Stops the board following it. The chats themselves are left alone."
                  className={`${ACTION} text-sand-dim hover:text-[#cf6b52]`}
                >
                  Cancel the run
                </button>
              )}
            </div>

            {cwd === null && run.projectId !== null && (
              <p className="mt-2.5 font-display text-[12px] italic text-sand-dim">
                The directory this run started in is no longer registered, so its chats cannot be
                opened from here.
              </p>
            )}
            {settled && (
              <p className="mt-2.5 font-display text-[12px] italic text-sand-dim">
                This run is {run.status}, so the board has stopped following it. Reload it by hand
                if you go back to work on it.
              </p>
            )}
          </div>

          {view === 'diagram' ? (
            /* THE TREE AND THE LIST TOGETHER, because neither answers "who gave
               tasks to who" alone. The tree shows the shape; the list shows the
               order, the broadcasts that have no single target, and the second
               dispatch of a step that the tree draws as one arrow. */
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {workflow === null ? (
                  <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
                    The template this run was cut from has been deleted, so its tree cannot be
                    drawn. The list still stands — a run keeps its own snapshot of the steps, and
                    the events below are its own record.
                  </p>
                ) : (
                  /* Drawn from the TEMPLATE with the run laid over it, and the
                     arrows taken from the recorded log rather than guessed from
                     which steps happen to have a session. */
                  <WorkflowDiagram workflow={workflow} run={overlay} className="min-h-0 flex-1" />
                )}
              </div>

              <div className="no-scrollbar flex min-h-0 shrink-0 flex-col overflow-y-auto border-t border-hairline xl:w-[380px] xl:border-l xl:border-t-0">
                <div className="flex shrink-0 items-center gap-3.5 border-b border-hairline-s px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="h-px w-6 bg-hairline" aria-hidden="true" />
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>
                  <span>Who gave what to whom</span>
                  <span className="ml-auto border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
                    {edges.length} event{edges.length === 1 ? '' : 's'}
                  </span>
                </div>
                <EventList edges={edges} nameFor={nameFor} />
              </div>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-3.5 border-b border-hairline-s px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                <span className="h-px w-6 bg-hairline" aria-hidden="true" />
                <span className="text-brass" aria-hidden="true">
                  ✦
                </span>
                <span>Steps</span>
                <span className="ml-auto border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
                  {dispatchable} dispatchable
                </span>
              </div>

              {steps.length === 0 ? (
                <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
                  This run has no steps — the template it was cut from was empty.
                </p>
              ) : (
                <>
                  <p className="max-w-[68ch] px-5 pt-3 font-display text-[12px] italic leading-relaxed text-sand-dim">
                    A stage is a container: it is never dispatched, and its status comes from the
                    steps inside it.
                  </p>
                  <ul className="mt-2 list-none">
                    {steps.map((s) => (
                      <StepRow
                        key={s.stepId}
                        step={s}
                        depth={depths.get(s.stepId) ?? 0}
                        waitingOn={waitingOn(s.stepId)}
                        busy={busyStep === s.stepId}
                        refusal={refusal?.stepId === s.stepId ? refusal.message : null}
                        canOpen={cwd !== null}
                        onDispatch={handleDispatch}
                        onOpen={(step) => {
                          if (step.sessionId !== null && cwd !== null) {
                            onOpenSession(step.sessionId, cwd)
                          }
                        }}
                        onStatus={handleStatus}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
