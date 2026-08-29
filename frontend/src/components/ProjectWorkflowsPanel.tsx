import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Crown,
  FolderOpen,
  Info,
  Link2Off,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { api } from '../lib/api'
import type { ChatGroup, Project, Workflow, WorkflowRun } from '../lib/api'
import type { Theme } from '../App'
import { RunBoard } from './RunBoard'
import { WorkflowHelp } from './WorkflowHelp'
import { FolderPicker } from './FolderPicker'
import { SessionPane } from './SessionPane'

/**
 * ProjectWorkflowsPanel — where a workflow TEMPLATE meets a real project.
 *
 * The sibling panel (WorkflowsPanel) is the library: every template on the
 * machine, and the tutorial inside each step. This one is the shop floor. It
 * answers a different question — for the workflow-project I am standing in,
 * which SOPs are we running here, and how far has each got. One project
 * routinely carries two or three: architecture and liaisoning are separate
 * workflows on the same site, each with its own father chat.
 *
 * Four decisions worth stating, because each one is a fork someone will
 * reasonably want to take the other way:
 *
 *  · ONE PROJECT AT A TIME, chosen in the SIDEBAR. This panel used to list every
 *    project and every run on the machine at once, which made it a second
 *    Projects view wearing a different hat. The selection lives on the left with
 *    the rest of the navigation, exactly as a floor does, and the right side is
 *    the work — so the two lists (ordinary projects, workflow projects) never
 *    have to share a column and can never be confused for each other.
 *
 *  · CHATS OPEN HERE, NOT IN THE TAB STRIP. A run's father and its step sessions
 *    belong to this view; opening them through the workspace's loose-open path
 *    dropped them into the main tab strip, mixed in with ordinary work, and left
 *    the user hunting for them in the Projects view. The pane is embedded on the
 *    right of this panel instead, which is also why the panel takes no
 *    onOpenSession prop any more — there is deliberately no route out.
 *
 *  · ATTACHING DOES NOT START ANYTHING. Attach puts the template on the
 *    project's shelf; Start Run spawns a father chat and real ptys. Merging
 *    them into one gesture would mean a mis-click costs you a process and a
 *    transcript, and it would make "which templates does this project use"
 *    unanswerable without reading the run history. They stay two verbs.
 *
 *  · RUNS OF A DETACHED TEMPLATE STILL SHOW, under a muted heading. Detaching
 *    is bookkeeping about the shelf; it does not end a run that is going, and a
 *    panel that hid a live father chat because someone tidied the shelf would
 *    be lying about what is running on this machine. That is also why detach
 *    needs no confirmation: nothing is destroyed, and re-attach is one click.
 *
 * A project with no directory cannot start a run, and this panel says so before
 * the click rather than after it — the server refuses (there is no cwd to put
 * the sessions in), and a disabled control with the reason beside it beats a red
 * banner that appears a second after you act.
 *
 * Liveness and progress are computed by the server per request, so they are
 * true at fetch time and not after. Like the other panels here, the answer to
 * that is an explicit reload in the header rather than a poll — this is a pane
 * you come to, act in, and leave.
 */

/** the run's own numbers when the envelope carried them (the list route always
    does), else the same sum done locally — stages excluded from both halves,
    a skipped step counted as done but kept in the denominator */
function progressOf(run: WorkflowRun): { done: number; total: number } {
  if (run.progress) return run.progress
  const steps = run.steps.filter((s) => s.kind !== 'stage')
  return {
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
  }
}

/** status -> the one colour that carries meaning. Everything else stays neutral
    so colour never reads as decoration. */
const RUN_TINT: Record<WorkflowRun['status'], string> = {
  running: 'var(--color-brass)',
  done: 'var(--color-brass)',
  paused: 'var(--color-sand-dim)',
  cancelled: 'var(--color-sand-dim)',
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

/** last segment of a directory — the absolute path is noise inside a meta line */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? p : parts[parts.length - 1]
}

// Two tiers now that the project name has moved to the sidebar: workflow, and
// the runs under it. The run indent lines up with the text of the workflow row
// above it, not with the panel edge. Hard numbers rather than nested padding
// because the rows are siblings in one flat list — nesting divs here would put a
// border on every tier and turn the panel into a grid.
const PAD_WORKFLOW = 'px-5'
const PAD_RUN = 'pl-[34px] pr-5'

// ---------------------------------------------------------------------------

/** one run of one template. The row opens the board; the father chip is a
 *  second, separate target — hence a div of two buttons rather than one button
 *  (a button inside a button is invalid and un-clickable). */
function RunRow({
  run,
  cwd,
  fatherOpen,
  onOpen,
  onOpenFather,
  onDelete,
}: {
  run: WorkflowRun
  /** the working directory of the run's DIRECTORY project, or null when it
      cannot be resolved — see the note at the call site */
  cwd: string | null
  /** true when this run's father is the chat already showing on the right */
  fatherOpen: boolean
  onOpen: () => void
  onDelete: () => void
  onOpenFather: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const { done, total } = progressOf(run)
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  const blocked = run.steps.some((s) => s.status === 'blocked')
  const father = run.fatherSessionId

  return (
    <div className={`group flex items-center gap-2.5 border-t border-hairline-s py-2 ${PAD_RUN}`}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left transition-colors duration-150 hover:bg-white/[0.02]"
      >
        <span
          aria-hidden="true"
          style={{ background: blocked ? '#cf6b52' : RUN_TINT[run.status] }}
          className="h-1.5 w-1.5 shrink-0 rounded-full"
        />
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
          {run.status}
        </span>

        {/* progress as a number AND a rule: the number is the fact, the rule is
            what lets you compare four runs down a column without reading any */}
        <span className="shrink-0 font-mono text-[10px] tabular-nums tracking-[0.08em] text-sand">
          {done}/{total}
        </span>
        <span className="hidden h-[3px] w-12 shrink-0 bg-hairline sm:block" aria-hidden="true">
          <span
            className="block h-[3px]"
            style={{ width: `${pct}%`, background: 'var(--color-brass)' }}
          />
        </span>

        {blocked && (
          <span
            className="shrink-0 font-mono text-[9px] uppercase tracking-[0.16em]"
            style={{ color: '#cf6b52' }}
          >
            blocked
          </span>
        )}

        <span className="min-w-0 truncate font-display text-[12px] italic text-sand-dim">
          started {relTime(run.startedAt)}
          {run.endedAt !== null && ` · ended ${relTime(run.endedAt)}`}
        </span>
      </button>

      {/* The father chat opens whenever we know WHERE to open it. Liveness only
          tints the dot: a finished run's transcript is still worth reading, and
          refusing the click on a dead pty would hide it for good. A cwd we
          cannot resolve is the one case that removes the affordance — passing a
          guessed directory would open the session against the wrong repo. */}
      {father !== null && cwd !== null && (
        <button
          type="button"
          onClick={onOpenFather}
          title={`Open the father chat for this run · ${cwd}`}
          aria-pressed={fatherOpen}
          className={`flex shrink-0 cursor-pointer items-center gap-1.5 border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] transition-colors duration-150 ${
            fatherOpen
              ? 'border-brass text-brass'
              : 'border-hairline text-sand-dim hover:border-brass hover:text-brass'
          }`}
        >
          <Crown className="h-3 w-3" aria-hidden="true" />
          father
          {run.fatherLive === true && (
            <span
              aria-hidden="true"
              className="h-1 w-1 rounded-full"
              style={{ background: 'var(--color-brass)' }}
            />
          )}
        </button>
      )}

      {/* Two-step rather than a modal. Deleting a run destroys its board, its
          history and its shared memory — enough to be worth a deliberate second
          click — but the CHATS survive, so this is not the kind of loss that
          warrants stopping everything with a dialog. The second click is the
          confirmation, and moving the pointer away cancels it. */}
      <button
        type="button"
        onClick={() => {
          if (confirming) onDelete()
          else setConfirming(true)
        }}
        onMouseLeave={() => setConfirming(false)}
        onBlur={() => setConfirming(false)}
        title={
          confirming
            ? 'Click again to delete this run — its chats are kept'
            : 'Delete this run (its chats are kept)'
        }
        aria-label={confirming ? 'Confirm deleting this run' : 'Delete this run'}
        className={`shrink-0 cursor-pointer px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.2em] transition-colors duration-150 ${
          confirming ? 'text-[#cf6b52]' : 'text-sand-dim opacity-0 group-hover:opacity-100 hover:text-[#cf6b52]'
        }`}
      >
        {confirming ? 'sure?' : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** what the project shows: its attached templates, then any template that has
 *  runs here but is no longer on the shelf */
type WorkflowRowView = {
  workflowId: string
  /** null when the template has been deleted since it was attached or run */
  workflow: Workflow | null
  runs: WorkflowRun[]
  attached: boolean
}

/** the chat showing in the embedded pane. Stored as run + session rather than as
    a resolved Project, because the run is what knows which DIRECTORY project the
    session lives in, and that mapping is refetched behind the panel. */
type OpenChat = { runId: string; sessionId: string }

export function ProjectWorkflowsPanel({
  selectedProjectId,
  theme,
}: {
  /** the workflow-project chosen in the sidebar, or null when none is */
  selectedProjectId: string | null
  theme: Theme
}) {
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  /** every DIRECTORY project, for resolving a run's cwd and for the Project the
      embedded pane needs. Fetched apart from the main load because listing
      projects walks every transcript on the machine, and this panel must paint
      before that finishes; until it lands, a run simply does not offer its
      father chat. */
  const [dirProjects, setDirProjects] = useState<Project[]>([])
  /** every group of BOTH kinds, used only to answer "who else holds this
      template". Deleting a template is global, so the confirm has to be able to
      say what else loses it — and a list filtered to workflow projects cannot
      see an ordinary group that also has it attached. */
  const [allGroups, setAllGroups] = useState<ChatGroup[]>([])
  /** workflowId currently awaiting a second delete click */
  const [confirmDeleteWf, setConfirmDeleteWf] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** the attach picker, open or shut. One project means one picker. */
  const [pickerOpen, setPickerOpen] = useState(false)
  /** the (i) reference sheet — an overlay, so it never unmounts the board behind it */
  const [helpOpen, setHelpOpen] = useState(false)
  /** the directory setter. It lives HERE rather than behind a settings modal
      because a workflow project has no settings screen — its sidebar row offers
      select, rename and delete and nothing else. Telling the user to go
      somewhere that does not exist is how a panel strands somebody.
      A browse dialog rather than a text field: this is an absolute path on
      Windows, and typing one by hand is both tedious and the easiest way to
      point a whole SOP at a folder that does not exist. */
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  const [savingDir, setSavingDir] = useState(false)
  /** the workflow id whose run is being started — starting spawns a father chat,
      which is slow enough that the button must say so */
  const [starting, setStarting] = useState<string | null>(null)
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [openChat, setOpenChat] = useState<OpenChat | null>(null)
  /** bumped whenever the embedded pane's box changes, so its xterm refits
      instead of staying at the width it first measured */
  const [paneResize, setPaneResize] = useState(0)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    // 'workflow' only: an ordinary project must never appear here, and filtering
    // on the server rather than in the client means a future list route change
    // cannot leak one in through a forgotten predicate.
    void Promise.all([api.getGroups('workflow'), api.getWorkflows(), api.getWorkflowRuns()])
      .then(([g, w, r]) => {
        setGroups(g)
        setWorkflows(w)
        setRuns(r)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not read the workflow projects.'),
      )
      .finally(() => setLoading(false))

    // Separate and deliberately unguarded: a failure here costs the father-chat
    // click, not the panel, so it must not be able to turn the whole pane red.
    void api
      .getProjects()
      .then(setDirProjects)
      .catch(() => {
        /* leave the list as it is — sessions just stay un-clickable */
      })

    // Unfiltered ON PURPOSE, and never rendered: this is the impact count for
    // deleting a template. The list above stays server-filtered so a forgotten
    // predicate cannot leak an ordinary group into this view.
    void api
      .getGroups()
      .then(setAllGroups)
      .catch(() => {
        /* the confirm just falls back to the generic warning */
      })
  }, [])
  useEffect(() => {
    load()
  }, [load])

  /* Switching project drops whatever was open under the old one. Leaving the run
     board or a father chat from another project on screen would attribute one
     project's work to another — the one thing this split of the two lists exists
     to prevent. */
  useEffect(() => {
    setOpenRunId(null)
    setOpenChat(null)
    setPickerOpen(false)
    setNotice(null)
    // Refetch, do not just reset. A project created a second ago by the + on the
    // left is NOT in this panel's `groups` — that list was fetched before it
    // existed — so the lookup below misses and the panel announces that the
    // project is "no longer on this machine", about a project the user just
    // made. Reloading on every selection change is also simply correct: you are
    // asking to look at this project now, so read it now.
    if (selectedProjectId !== null) load()
  }, [selectedProjectId, load])

  const group = useMemo(
    () => (selectedProjectId === null ? null : (groups.find((g) => g.id === selectedProjectId) ?? null)),
    [groups, selectedProjectId],
  )

  const workflowById = useMemo(() => {
    const map = new Map<string, Workflow>()
    for (const w of workflows) map.set(w.id, w)
    return map
  }, [workflows])

  const dirProjectById = useMemo(() => {
    const map = new Map<string, Project>()
    for (const p of dirProjects) map.set(p.id, p)
    return map
  }, [dirProjects])

  /** the run's DIRECTORY project — the thing SessionPane and the father chip both
      need. A run carries projectId (where its sessions cwd into), which is NOT
      the same id as its groupId (the workflow-project it belongs to); resolving
      through the group instead would put a session in the wrong repository. */
  const dirProjectOf = useCallback(
    (run: WorkflowRun | null): Project | null =>
      run === null || run.projectId === null ? null : (dirProjectById.get(run.projectId) ?? null),
    [dirProjectById],
  )

  /* One fetch of every run, filtered here, rather than one request per attached
     template. The filtered call exists and is what a single workflow's runs
     would use, but this panel wants N of those at once and N round-trips on
     mount is the wrong trade for a list that is small either way. */
  const runsHere = useMemo(
    () =>
      group === null
        ? []
        : runs
            .filter((r) => r.groupId === group.id)
            .slice()
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs, group],
  )

  const rows = useMemo<WorkflowRowView[]>(() => {
    if (group === null) return []

    // Defensive read, not paranoia: a server older than this field — or one
    // still running from before a restart — returns a group with no
    // workflowIds at all, and a bare .map() there white-screens the whole
    // panel over one absent key. The empty list is the honest reading.
    const list: WorkflowRowView[] = (group.workflowIds ?? []).map((id) => ({
      workflowId: id,
      workflow: workflowById.get(id) ?? null,
      runs: runsHere.filter((r) => r.workflowId === id),
      attached: true,
    }))

    // runs whose template has since been detached (or deleted) — kept visible
    // on purpose, in the order their newest run started
    const seen = new Set(group.workflowIds ?? [])
    for (const run of runsHere) {
      if (seen.has(run.workflowId)) continue
      seen.add(run.workflowId)
      list.push({
        workflowId: run.workflowId,
        workflow: workflowById.get(run.workflowId) ?? null,
        runs: runsHere.filter((r) => r.workflowId === run.workflowId),
        attached: false,
      })
    }

    return list
  }, [group, runsHere, workflowById])

  const applyGroup = useCallback((next: ChatGroup) => {
    setGroups((prev) => prev.map((g) => (g.id === next.id ? next : g)))
  }, [])

  const handleAttach = useCallback(
    (g: ChatGroup, workflow: Workflow) => {
      setError(null)
      setNotice(null)
      void api
        .attachWorkflowToGroup(g.id, workflow.id)
        .then((next) => {
          applyGroup(next)
          setPickerOpen(false)
          setNotice(
            `${workflow.name} is on ${g.name}. Nothing is running yet — start a run when you want its father chat.`,
          )
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not attach that workflow.'),
        )
    },
    [applyGroup],
  )

  const handleDetach = useCallback(
    (g: ChatGroup, workflowId: string) => {
      setError(null)
      setNotice(null)
      void api
        .detachWorkflowFromGroup(g.id, workflowId)
        .then((next) => {
          applyGroup(next)
          setNotice('Detached. The template and any runs already going are untouched.')
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not detach that workflow.'),
        )
    },
    [applyGroup],
  )

  /** point the embedded pane at a session. Never routes outward: the whole point
      of this panel is that a run's terminals stay inside it. */
  const showChat = useCallback((runId: string, sessionId: string) => {
    setOpenChat({ runId, sessionId })
    setPaneResize((n) => n + 1)
  }, [])

  const handleStart = useCallback(
    (g: ChatGroup, workflow: Workflow) => {
      setStarting(workflow.id)
      setError(null)
      setNotice(null)
      // projectId is left out on purpose: the server takes the group's first
      // directory, which keeps one rule about where sessions run instead of two.
      void api
        .startWorkflowRun({ workflowId: workflow.id, groupId: g.id })
        .then(async (run) => {
          setRuns((prev) => [run, ...prev])
          // Refetch the DIRECTORY projects. Starting the first run in a project
          // whose directory was just set makes the server call
          // ensureProjectForCwd, which CREATES a directory project — one this
          // panel has never seen, because its list was fetched before the run
          // existed. Without this the chat opens against a projectId absent
          // from dirProjects and the pane reports that the working directory
          // could not be resolved, which reads as "you gave me no directory"
          // to someone who just gave one.
          // AWAITED, not fired alongside: showChat runs on the next lines, and
          // a pane that mounts before the list arrives renders the
          // "could not resolve the working directory" state for a beat. It
          // heals itself on the next render, but the user has already read a
          // sentence telling them to do the thing they just did.
          try {
            setDirProjects(await api.getProjects())
          } catch {
            /* the run is already going; the chat just stays un-openable */
          }
          // straight to the board AND to the father chat: the father is up, it
          // greets and asks for the documents it needs, and the next thing
          // anyone does is answer it — so put it on screen rather than making
          // the user find the chip that opens it.
          setOpenRunId(run.id)
          if (run.fatherSessionId !== null) showChat(run.id, run.fatherSessionId)
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not start the run.'),
        )
        .finally(() => setStarting(null))
    },
    [showChat],
  )

  /* — the embedded chat, built once and placed in the split below. It is kept in
       ONE subtree across the overview/board hop on purpose: SessionPane owns a
       live xterm and its /ws/terminal socket, and unmounting it disposes both,
       which kills the server-side pty and the claude CLI running in it. Moving
       it between two branches of the render would do exactly that on every
       Back click. — */
  const openRun = useMemo(
    () => (openChat === null ? null : (runs.find((r) => r.id === openChat.runId) ?? null)),
    [runs, openChat],
  )
  const openProject = dirProjectOf(openRun)
  /** what the pane is showing, in words — the father, or the step that owns the
      session. SessionPane's own header names the transcript, which for a session
      minted seconds ago is just its short id. */
  const openLabel = useMemo(() => {
    if (openChat === null || openRun === null) return ''
    if (openRun.fatherSessionId === openChat.sessionId) return `Father · ${openRun.name}`
    const step = openRun.steps.find((s) => s.sessionId === openChat.sessionId)
    return step ? `${step.title} · ${openRun.name}` : openRun.name
  }, [openChat, openRun])

  const chatPane =
    openChat === null ? null : (
      <aside
        aria-label="Workflow chat"
        className="flex min-w-[320px] shrink-0 basis-[46%] flex-col overflow-hidden border-l border-hairline bg-surface"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-3 py-2 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
          <Crown className="h-3 w-3 shrink-0 text-brass" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{openLabel}</span>
          <span className="shrink-0 border border-hairline px-1.5 py-px text-[8px] tracking-[0.2em]">
            in this view only
          </span>
        </div>
        {openProject === null ? (
          <p className="px-5 py-5 font-display text-[13px] italic leading-relaxed text-sand-dim">
            This chat's working directory could not be resolved, so there is nothing to open it
            against. Give the project a directory, reload, and the chat opens here.
          </p>
        ) : (
          <div className="min-h-0 flex-1">
            <SessionPane
              project={openProject}
              sessionId={openChat.sessionId}
              theme={theme}
              /* chat, always: a father greets and asks for its documents the
                 moment it comes up, and landing on the raw shell would hide
                 that behind a terminal the user did not ask for */
              defaultView="chat"
              shellRefresh={0}
              resizeSignal={paneResize}
              reconnectAllSignal={0}
              isFocused
              onClose={() => setOpenChat(null)}
            />
          </div>
        )}
      </aside>
    )

  const count =
    loading && groups.length === 0
      ? 'Reading…'
      : group === null
        ? 'no project'
        : `${runsHere.length} run${runsHere.length === 1 ? '' : 's'}`

  /** Delete a run: its board, its step bookkeeping, its dispatch log and its
   *  shared memory. The CHATS are deliberately kept — they are real sessions
   *  with real transcripts, and tidying a board must never quietly destroy
   *  someone's work. If the deleted run is the one on screen, drop back to the
   *  project so the panel is not left pointing at something gone. */
  const deleteRun = useCallback(
    (runId: string) => {
      setError(null)
      void api
        .deleteWorkflowRun(runId)
        .then(() => {
          setRuns((prev) => prev.filter((r) => r.id !== runId))
          setOpenRunId((cur) => (cur === runId ? null : cur))
          setOpenChat((cur) => (cur?.runId === runId ? null : cur))
          setNotice('Run deleted. Its chats are still in your session list.')
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not delete the run.'),
        )
    },
    [],
  )

  /** Delete a TEMPLATE outright. This is global: it removes the workflow from
   *  every project that holds it, not just this one, which is why the control
   *  says how many others lose it before the second click.
   *
   *  RUNS ARE LEFT ALONE. A run snapshots its own steps at start, so it keeps
   *  working and its board still renders — it simply loses the ability to look
   *  its template up. Cascading the delete into live runs would destroy work
   *  that is still going, which is never what "tidy the shelf" means. */
  const deleteWorkflowTemplate = useCallback(
    (workflowId: string) => {
      setError(null)
      setConfirmDeleteWf(null)
      void api
        .deleteWorkflow(workflowId)
        .then(() => {
          setWorkflows((prev) => prev.filter((w) => w.id !== workflowId))
          // The attachment lists on every group are now stale — the server drops
          // the id lazily, so re-read rather than patching them here.
          load()
          setNotice('Template deleted. Runs already going keep working.')
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not delete the workflow.'),
        )
    },
    [load],
  )

  /** how many OTHER projects hold this template — the sentence the confirm needs */
  const alsoAttachedCount = useCallback(
    (workflowId: string, exceptGroupId: string) =>
      allGroups.filter((g) => g.id !== exceptGroupId && (g.workflowIds ?? []).includes(workflowId))
        .length,
    [allGroups],
  )

  /** Point this project at a working directory. The server validates the path
   *  shape; it does NOT require the folder to exist yet, which matches how the
   *  ordinary project editor behaves. */
  const saveDirectory = useCallback(
    (picked: string) => {
    const path = picked.trim()
    if (path === '' || group === null || savingDir) return
    setSavingDir(true)
    setError(null)
    void api
      .updateGroup(group.id, { directories: [{ path, commands: [] }] })
      .then((updated) => {
        setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)))
        setDirPickerOpen(false)
        setNotice(`Runs will work in ${path}`)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not set the directory.'),
      )
      .finally(() => setSavingDir(false))
    },
    [group, savingDir],
  )

  const dir = group?.directories[0] ?? null
  const canStart = dir !== null
  const available = workflows.filter((w) => !(group?.workflowIds ?? []).includes(w.id))

  /* — the left half: the run board when a run is open, otherwise the project's
       shelf. The board keeps its own header and Back, exactly as before. — */
  const left =
    openRunId !== null ? (
      <RunBoard
        runId={openRunId}
        onOpenSession={(sessionId) => showChat(openRunId, sessionId)}
        onBack={() => {
          setOpenRunId(null)
          load()
        }}
      />
    ) : (
      <section
        aria-label="Project workflows"
        className="relative flex h-full min-h-0 flex-col overflow-hidden bg-midnight"
      >
        {helpOpen && <WorkflowHelp onClose={() => setHelpOpen(false)} />}
        <FolderPicker
          open={dirPickerOpen}
          initialPath={dir?.path}
          onPick={saveDirectory}
          onClose={() => setDirPickerOpen(false)}
        />
        <header className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-5 py-3 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
          <span className="h-px w-6 bg-hairline" aria-hidden="true" />
          <span className="text-brass" aria-hidden="true">
            ✦
          </span>
          <span className="min-w-0 flex-1 truncate">{group?.name ?? 'Project Workflows'}</span>
          <span
            aria-live="polite"
            className="shrink-0 border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim"
          >
            {count}
          </span>
          {/* The reference sits BEFORE reload: it is the thing you reach for when
              you do not yet know what a control does, and that is exactly when
              hunting for it costs the most. */}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            aria-label="What this view does, and the tools each session gets"
            title="What this view does, and the tools each session gets"
            className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Reload this project and its runs"
            className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
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

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
          {selectedProjectId === null ? (
            <div className="mx-auto flex max-w-md flex-col items-center px-8 py-12 text-center">
              <WorkflowIcon className="mb-5 h-7 w-7 text-sand-dim" aria-hidden="true" />
              <h2 className="font-display text-[20px] font-medium leading-tight text-parchment">
                Pick a workflow <em className="font-normal italic text-brass">project</em>
              </h2>
              <p className="mt-3.5 font-display text-[14px] italic leading-relaxed text-sand">
                Workflow projects live in their own list on the left, apart from your groups.
                Choose one to see the SOPs it carries, or add one with the plus above the list —
                then attach a workflow and start a run.
              </p>
              <span className="mo-rule mt-7" aria-hidden="true" />
            </div>
          ) : group === null ? (
            loading ? (
              <p className="px-5 py-5 font-display text-[13px] italic text-sand-dim">
                Reading the project…
              </p>
            ) : (
              error === null && (
                <p className="px-5 py-5 font-display text-[13px] italic leading-relaxed text-sand-dim">
                  That workflow project is no longer on this machine. Pick another on the left, or
                  add one.
                </p>
              )
            )
          ) : (
            <div className="pb-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline-s px-5 py-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                {/* The directory decides WHERE every session of every run works,
                    so it is named as a directory and carries its full path on
                    hover. Showing only the basename read as a stray word — "V2"
                    beside two counts looks like anything but a folder. */}
                {dir !== null ? (
                  <>
                    <span title={dir.path}>
                      Works in <span className="text-sand">{basename(dir.path)}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setDirPickerOpen(true)}
                      className="cursor-pointer underline decoration-hairline underline-offset-2 transition-colors duration-150 hover:text-brass"
                    >
                      change
                    </button>
                  </>
                ) : (
                  <span style={{ color: '#cf6b52' }}>no directory</span>
                )}
                <span aria-hidden="true">·</span>
                <span>
                  {(group.workflowIds ?? []).length} workflow
                  {(group.workflowIds ?? []).length === 1 ? '' : 's'}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {runsHere.length} run{runsHere.length === 1 ? '' : 's'}
                </span>
              </p>

              {/* said once, above the rows whose Start Run is dead, rather than
                  repeated on every one of them */}
              {!canStart && (
                <div className={`${PAD_WORKFLOW} border-b border-hairline-s py-2.5`}>
                  <p className="max-w-[68ch] font-display text-[12px] italic leading-relaxed text-sand-dim">
                    This project has no directory, so a run has nowhere to work — every session it
                    spawns needs a folder to run in, and guessing one would work an SOP against the
                    wrong repository.
                  </p>
                  <button
                    type="button"
                    onClick={() => setDirPickerOpen(true)}
                    disabled={savingDir}
                    className="mt-2 flex cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <FolderOpen className="h-3 w-3" aria-hidden="true" />
                    {savingDir ? 'Setting…' : 'Choose a directory'}
                  </button>
                </div>
              )}

              {rows.length === 0 ? (
                <p
                  className={`${PAD_WORKFLOW} border-b border-hairline-s py-2.5 font-display text-[12px] italic leading-relaxed text-sand-dim`}
                >
                  No workflows attached. Attaching one puts an SOP on this project — the same
                  template can sit on several projects at once. Starting a run then spawns that
                  workflow's father chat and the sessions under it.
                </p>
              ) : (
                rows.map((row) => {
                  const isStarting = starting === row.workflowId
                  /* bound to a const so the null check below still holds inside
                     the click handlers — a narrowed object PROPERTY does not
                     survive into a closure */
                  const wf = row.workflow
                  const name = wf?.name ?? (row.attached ? 'Template missing' : 'Template deleted')
                  const dispatchable = wf?.steps.filter((s) => s.kind === 'step').length ?? 0

                  return (
                    <div key={row.workflowId}>
                      <div
                        className={`group flex items-start gap-3 border-t border-hairline-s py-2.5 ${PAD_WORKFLOW}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                            <span
                              className="font-display text-[14px]"
                              style={{
                                color: wf === null ? '#cf6b52' : 'var(--color-parchment)',
                              }}
                            >
                              {name}
                            </span>
                            {wf !== null && (
                              <>
                                <span className="font-mono text-[9px] tracking-[0.12em] text-sand-dim">
                                  v{wf.version}
                                </span>
                                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                                  {dispatchable} step{dispatchable === 1 ? '' : 's'}
                                </span>
                              </>
                            )}
                            {!row.attached && (
                              <span className="border border-hairline px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim">
                                not attached
                              </span>
                            )}
                          </span>
                          {wf !== null && wf.description.trim() !== '' && (
                            <span className="mt-1 block max-w-[68ch] font-display text-[12px] italic leading-relaxed text-sand-dim">
                              {wf.description}
                            </span>
                          )}
                          {wf === null && (
                            <span className="mt-1 block max-w-[68ch] font-display text-[12px] italic leading-relaxed text-sand-dim">
                              {row.attached
                                ? 'This template has been deleted from the library. Detach it — the runs below keep working.'
                                : 'The template these runs were cut from is gone. The runs themselves still stand.'}
                            </span>
                          )}
                        </span>

                        {/* Start Run spawns a father chat and real ptys, so it is
                            bordered and named rather than being one more faint
                            link in a row of faint links. */}
                        {row.attached && wf !== null && (
                          <button
                            type="button"
                            onClick={() => handleStart(group, wf)}
                            disabled={!canStart || isStarting}
                            title={
                              canStart
                                ? 'Start a run — spawns the father chat for this workflow'
                                : 'This project needs a directory before a run can start'
                            }
                            className="flex shrink-0 cursor-pointer items-center gap-1.5 border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-sand"
                          >
                            <Play className="h-3 w-3" aria-hidden="true" />
                            {isStarting ? 'Starting…' : 'Start run'}
                          </button>
                        )}

                        {/* DELETE the template, as opposed to detaching it. Two
                            different verbs with very different blast radii, so
                            they are labelled by what they destroy rather than
                            sitting side by side as twin icons. */}
                        {wf !== null && (
                          <button
                            type="button"
                            onClick={() => {
                              if (confirmDeleteWf === row.workflowId)
                                deleteWorkflowTemplate(row.workflowId)
                              else setConfirmDeleteWf(row.workflowId)
                            }}
                            onMouseLeave={() => setConfirmDeleteWf(null)}
                            onBlur={() => setConfirmDeleteWf(null)}
                            aria-label={`Delete the ${name} template everywhere`}
                            title={(() => {
                              const others = alsoAttachedCount(row.workflowId, group.id)
                              const tail =
                                others > 0
                                  ? ` ${others} other project${others === 1 ? '' : 's'} also lose${others === 1 ? 's' : ''} it.`
                                  : ''
                              return confirmDeleteWf === row.workflowId
                                ? `Click again to delete this template everywhere.${tail} Runs already going keep working.`
                                : `Delete this template everywhere — not just here.${tail}`
                            })()}
                            className={`mt-1 shrink-0 cursor-pointer px-1 font-mono text-[9px] uppercase tracking-[0.18em] transition-all duration-150 ${
                              confirmDeleteWf === row.workflowId
                                ? 'text-[#cf6b52]'
                                : 'text-sand-dim opacity-0 hover:text-[#cf6b52] group-hover:opacity-100'
                            }`}
                          >
                            {confirmDeleteWf === row.workflowId ? (
                              (() => {
                                const others = alsoAttachedCount(row.workflowId, group.id)
                                return others > 0 ? `delete from ${others + 1}?` : 'delete?'
                              })()
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                          </button>
                        )}

                        {row.attached ? (
                          <button
                            type="button"
                            onClick={() => handleDetach(group, row.workflowId)}
                            aria-label={`Detach ${name} from ${group.name}`}
                            title="Detach — the template and any runs already going are kept"
                            className="mt-1 shrink-0 cursor-pointer text-sand-dim opacity-0 transition-all duration-150 hover:text-[#cf6b52] group-hover:opacity-100"
                          >
                            <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : (
                          wf !== null && (
                            <button
                              type="button"
                              onClick={() => handleAttach(group, wf)}
                              className="shrink-0 cursor-pointer border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim transition-colors duration-150 hover:border-brass hover:text-brass"
                            >
                              Re-attach
                            </button>
                          )
                        )}
                      </div>

                      {row.runs.map((run) => (
                        <RunRow
                          key={run.id}
                          run={run}
                          cwd={dirProjectOf(run)?.fileDir ?? null}
                          fatherOpen={
                            openChat !== null && openChat.sessionId === run.fatherSessionId
                          }
                          onOpen={() => setOpenRunId(run.id)}
                          onOpenFather={() => {
                            if (run.fatherSessionId !== null) showChat(run.id, run.fatherSessionId)
                          }}
                          onDelete={() => deleteRun(run.id)}
                        />
                      ))}

                      {row.attached && row.runs.length === 0 && (
                        <p
                          className={`${PAD_RUN} border-t border-hairline-s py-2 font-display text-[12px] italic text-sand-dim`}
                        >
                          No runs of this workflow here yet.
                        </p>
                      )}
                    </div>
                  )
                })
              )}

              {/* — attach, at the foot of the project it acts on — */}
              <div className={`${PAD_WORKFLOW} border-t border-hairline-s pt-2.5`}>
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  aria-expanded={pickerOpen}
                  className="flex cursor-pointer items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim transition-colors duration-150 hover:text-brass"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Attach a workflow
                </button>

                {pickerOpen && (
                  <div className="mt-2 border border-hairline">
                    {workflows.length === 0 ? (
                      <p className="px-3 py-2.5 font-display text-[12px] italic leading-relaxed text-sand-dim">
                        There are no workflow templates on this machine yet. Import a CRM SOP or
                        write one in the Workflows panel, then come back.
                      </p>
                    ) : available.length === 0 ? (
                      <p className="px-3 py-2.5 font-display text-[12px] italic text-sand-dim">
                        Every workflow is already attached to this project.
                      </p>
                    ) : (
                      <ul className="list-none">
                        {available.map((w) => (
                          <li key={w.id} className="border-b border-hairline-s last:border-b-0">
                            <button
                              type="button"
                              onClick={() => handleAttach(group, w)}
                              className="flex w-full cursor-pointer items-baseline gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-white/[0.02]"
                            >
                              <span className="min-w-0 flex-1 truncate font-display text-[13px] text-parchment">
                                {w.name}
                              </span>
                              <span className="shrink-0 font-mono text-[9px] tracking-[0.12em] text-sand-dim">
                                v{w.version}
                              </span>
                              <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
                                {w.steps.filter((s) => s.kind === 'step').length} steps
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    )

  /* Steps on the left, the open chat on the right, both on screen at once:
     deciding what to dispatch next and watching what the last dispatch said are
     one activity, and alternating views would make the user close the transcript
     to read the list that explains it. */
  return (
    <div className="flex h-full min-h-0 bg-midnight">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{left}</div>
      {chatPane}
    </div>
  )
}
