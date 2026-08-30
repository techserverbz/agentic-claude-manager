import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BrainCircuit,
  Crown,
  FolderTree,
  Plug,
  Webhook,
  Sparkles,
  Users2,
  KanbanSquare,
  Target,
  ListTodo,
  MessageSquare,
  Network,
  Users,
  X,
} from 'lucide-react'
import { api, type Floor, type FloorAgent, type Project } from '../lib/api'
import type { DefaultView, PaneMode, Theme } from '../App'
import { CrmKanban } from './CrmKanban'
import { FloorMemory } from './FloorMemory'
import { FloorPreamble } from './FloorPreamble'
import { FloorHooks } from './FloorHooks'
import { FloorGoals } from './FloorGoals'
import { PromptKanban } from './PromptKanban'
import { FloorEquipment } from './FloorEquipment'
import { AgentTerminalGrid, type GridTab } from './AgentTerminalGrid'
import { AgentModal } from './AgentModal'
import { FloorDesigner } from './FloorDesigner'

/**
 * AgentWorkflowPanel — the Agents Workflow view: a roster on the left, the
 * floor it belongs to (or that agent's live chat) on the right.
 *
 * The idea the layout is built around: on a WORKFLOW floor an agent is not a
 * drawing, it is somebody you can talk to. So the chart and the chat are two
 * views of the SAME selection — clicking a desk on the canvas and clicking a
 * name in the rail land in the same place, and opening a chat hops you to it.
 *
 * Three decisions worth stating:
 *
 *  · The rail lists every agent on every `kind: 'workflow'` floor, GROUPED by
 *    floor rather than filtered to one. The floors on this canvas are teams of
 *    one workflow, not separate worlds, and hiding the others behind a picker
 *    would make "who else is live right now" a two-click question.
 *
 *  · The live chats are a GRID (AgentTerminalGrid) — one terminal per agent,
 *    all of them running at once. It is built once and placed in exactly one
 *    spot in the tree; the overview and the Session tab are two LAYOUTS of that
 *    same grid, never two copies of it. Unmounting a pane disposes its xterm
 *    and /ws/terminal socket, which kills the server-side pty and the claude
 *    running in it, so nothing here may ever be conditionally rendered away —
 *    panes are hidden with `invisible`, never removed.
 *
 *  · An agent's chat is opened by the SHELL (`onOpenAgentChat`), not here. That
 *    call spawns a real process and persists the minted id onto the agent, so
 *    it belongs to the loopback-guarded server route; this panel only knows
 *    that the agent afterwards carries a `sessionId` to bind a pane to.
 */

/* Live-session identity now belongs to each GRID CELL, not to this panel:
   see cellKey() in AgentTerminalGrid. The old single `PANE_KEY` constant would
   have made every cell report under one key, and App stores those in a Record —
   so the last cell to report would erase every other agent's shells. */

type PanelTab =
  | 'design'
  | 'preamble'
  | 'hooks'
  | 'goals'
  | 'session'
  | 'kanban'
  | 'prompts'
  | 'memory'
  | 'agents'
  | 'skills'
  | 'mcp'

const TABS: { id: PanelTab; label: string; icon: typeof Network }[] = [
  /* Session leads. Clicking an agent lands in its chat, so the conversation
     is what you arrive at; the chart sits beside it for when you want the
     shape of the floor rather than a conversation with one of it. */
  { id: 'session', label: 'Session', icon: MessageSquare },
  { id: 'design', label: 'Design', icon: Network },
  /* Next to Design because it is the same kind of thing: what this floor IS,
     as opposed to what it is doing. It also sits ahead of both boards on
     purpose — work handed out before the floor says where the work lives is
     work done in the wrong directory. */
  { id: 'preamble', label: 'Preamble', icon: FolderTree },
  /* Next to the folder it writes into — a hook is a property of the
     workspace, and it reads as one only when the two sit together. */
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  /* Two boards, named apart. 'Kanban' alone stopped being a name the moment
     there were two of them — and they are genuinely different things: one is
     the company's live CRM goals, the other is this floor's own queue. */
  /* Ahead of the CRM board on purpose: these are the floor's OWN goals and
     they are readable with the CRM switched off, which the board beside
     them is not. */
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'kanban', label: 'Goal Kanban', icon: KanbanSquare },
  { id: 'prompts', label: 'Prompt Kanban', icon: ListTodo },
  { id: 'memory', label: 'Memory', icon: BrainCircuit },
  /* What the workflow IS made of, as opposed to what it is doing. These three
     read the floors themselves — they are not a second copy of the sidebar's
     machine-wide Skills and MCP lists, which show everything installed rather
     than everything equipped. */
  { id: 'agents', label: 'Agents', icon: Users2 },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Plug },
]

/** a centred notice — every dead end in this panel says what to do next */
function Blank({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: typeof Users
  title: string
  body: string
  action?: { label: string; disabled: boolean; onClick: () => void }
}) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-8 py-12 text-center">
      <Icon className="mb-5 h-7 w-7 text-sand-dim" aria-hidden="true" />
      <h2 className="font-display text-[20px] font-medium leading-tight text-parchment">{title}</h2>
      <p className="mt-3.5 font-display text-[14px] italic leading-relaxed text-sand">{body}</p>
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className="mo-ticks mt-6 flex cursor-pointer items-center gap-2 border border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          {action.label}
        </button>
      )}
      <span className="mo-rule mt-7" aria-hidden="true" />
    </div>
  )
}

/** one name in the rail — who they are, what they do, and whether they answer */
function AgentRow({
  agent,
  live,
  selected,
  onSelect,
}: {
  agent: FloorAgent
  live: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li className="border-b border-hairline-s last:border-b-0">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-white/[0.03] ${
          selected ? 'bg-white/[0.06]' : ''
        }`}
      >
        {agent.isBoss && <Crown className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-display text-[13px] ${
              selected ? 'text-brass' : 'text-parchment'
            }`}
          >
            {agent.name}
          </span>
          <span className="block truncate font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
            {agent.role.trim() !== '' ? agent.role : 'no role'}
          </span>
        </span>
        {live && <span className="mo-live-dot" role="img" aria-label="Live shell running" />}
      </button>
    </li>
  )
}

export function AgentWorkflowPanel({
  floors,
  projects,
  selectedProjectId,
  liveSessionIds,
  selFloorId,
  selAgentId,
  onSelectAgent,
  openChatSignal,
  agentCommand,
  theme,
  onOpenAgentChat,
  onAttachScope,
  defaultView,
  shellRefresh,
  reconnectAllSignal,
  onSessionIdChange,
  onActiveSessionsChange,
  windowCount,
  paneMode,
  agentSlots,
  onAgentSlotsChange,
  onPatchAgent,
  onRemoveAgent,
  onSetFloorPrompt,
  onRefreshFloors,
}: {
  /** ALL floors — the workflow ones are picked out here */
  floors: Floor[]
  projects: Project[]
  selectedProjectId: string | null
  /** the session ids whose shell is connected, merged across the app */
  liveSessionIds: string[]
  /** the current agent, owned by App because the SIDEBAR lists them */
  selFloorId: string | null
  selAgentId: string | null
  onSelectAgent: (floorId: string, agentId: string, openChat?: boolean) => void
  /** bumped when a selection asked to land in the chat rather than just select */
  openChatSignal: number
  /** a verb for the selected agent's pane — see App.handleAgentCommand */
  agentCommand: { kind: 'terminal' | 'chat' | 'reconnect'; nonce: number } | null
  theme: Theme
  /** spawn-or-reuse this agent's chat; resolves once the agent carries a sessionId */
  onOpenAgentChat: (floorId: string, agentId: string) => Promise<void>
  /** attach this floor to a CRM project / service / the organisation */
  onAttachScope: (
    floorId: string,
    scope: { targetType: string; targetId: string | null },
  ) => Promise<void>
  defaultView: DefaultView
  shellRefresh: number
  reconnectAllSignal: number
  onSessionIdChange: (key: string, sessionId: string) => void
  onActiveSessionsChange: (key: string, ids: string[]) => void
  /** how many chats the toolbar says to show at once — the SAME control that
   *  governs the workspace's windows, because "2 windows" must mean two panes
   *  wherever you are looking. */
  windowCount: number
  /** the toolbar's single/multi toggle. Folded into the window COUNT rather
   *  than into a second layout flag — the panel already learned once that two
   *  knobs for one layout is how you get eight panes when the toolbar says 2. */
  paneMode: PaneMode
  /** which agent is in which window; owned by App so a saved view can hold it */
  agentSlots: (string | null)[]
  onAgentSlotsChange: (slots: (string | null)[]) => void
  onPatchAgent: (floorId: string, agentId: string, patch: Partial<FloorAgent>) => void
  onRemoveAgent: (floorId: string, agentId: string) => void
  onSetFloorPrompt: (floorId: string, globalPrompt: string) => Promise<void>
  /** re-read floors and projects from the server */
  onRefreshFloors: () => void
}) {
  const [tab, setTab] = useState<PanelTab>('design')
  /* MULTIPANE is where you land: every agent at once, with their chat names.
     Opening one takes the detail view full screen; its ✕ comes back here.
     Both are kept MOUNTED and toggled by visibility — unmounting the detail
     side would dispose the SessionPane's xterm and socket, which kills the pty
     and the claude running in it. Going back to an overview must never be able
     to end somebody's turn. */
  const [mode, setMode] = useState<'multipane' | 'detail'>('multipane')
  /* Selection is CONTROLLED by App. The list of agents lives in the app
     sidebar, not in this panel, so the panel cannot own which one is current —
     it would be a second source of truth for the same choice. */
  /* One call, both halves. Never split this into a floor setter and an agent
     setter: they would each have to re-send the other half from the current
     render, and two calls in a row would make the second overwrite the first
     with a stale value. A floor and an agent are one choice. */
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const workflowFloors = useMemo(() => floors.filter((f) => f.kind === 'workflow'), [floors])

  /* the floor on show: the selected one, else simply the first — an empty canvas
     would make an existing floor look like no floors at all */
  const selectedFloor = useMemo<Floor | null>(
    () => workflowFloors.find((f) => f.id === selFloorId) ?? workflowFloors[0] ?? null,
    [workflowFloors, selFloorId],
  )
  const selectedAgent = useMemo(
    () => selectedFloor?.agents.find((a) => a.id === selAgentId) ?? null,
    [selectedFloor, selAgentId],
  )

  /* land on somebody. Runs when the panel opens and whenever the selection stops
     resolving — the floor was deleted, or the agent was removed on the canvas. */
  useEffect(() => {
    if (selectedFloor === null || selectedFloor.agents.length === 0) return
    if (selectedFloor.agents.some((a) => a.id === selAgentId)) return
    const boss = selectedFloor.agents.find((a) => a.isBoss)
    onSelectAgent(selectedFloor.id, (boss ?? selectedFloor.agents[0]).id)
    /* onSelectAgent comes down as an inline arrow, so it is a new function
       every render and cannot be a dependency without re-running this on
       every pass. The guards above make it a no-op once it resolves. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFloor, selAgentId])

  const project = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const agentSessionId = selectedAgent?.sessionId ?? null

  /* No "last good session" fallback any more, deliberately. It existed because
     ONE pane had to stay bound to something while a chatless agent was selected.
     Every agent now has its own cell bound strictly to its own session, so that
     fallback would only ever put two cells on one session id — two sockets on
     one pty, fighting. A chatless agent's cell shows a Start chat button
     instead. */

  /* The store the floor's memory lives in. An agent chat saves into the project
     it runs in, so that project IS the floor's memory scope. Falls back to the
     first real project when nothing is selected — the Agent WF view never sets
     selectedProjectId (only opening a session does), so reading it alone would
     leave the panel permanently empty on a floor whose chats run fine. */
  const memoryProjectId = useMemo(
    () => project?.id ?? projects.find((p) => !p.ephemeral)?.id ?? null,
    [project, projects],
  )

  /* Reload when the tab comes back into view: the panel stays mounted, so
     without this it would show whatever it fetched the first time — and agents
     write to this store continuously while the human is on another tab. */
  const [memoryRefresh, setMemoryRefresh] = useState(0)
  useEffect(() => {
    if (tab === 'memory') setMemoryRefresh((n) => n + 1)
  }, [tab])

  /* Same reason as memory: the panel stays mounted, and the boss moves cards on
     this board while the human is looking at another tab.
     Keyed on  ALONE — the board already refetches on a floor change of its
     own accord (its loader is memoised on floorId), so including selFloorId
     here fired a second request that immediately aborted the first. */
  const [promptRefresh, setPromptRefresh] = useState(0)
  useEffect(() => {
    if (tab === 'prompts') setPromptRefresh((n) => n + 1)
  }, [tab])

  /* An xterm refits on its own element resize, but not on a VISIBILITY flip —
     and every pane in the grid is hidden rather than removed, so most layout
     changes here are visibility flips. The signal is deliberately keyed on
     everything that changes a pane's box: the mode (grid ↔ single), the tab
     (the grid is only on screen on Session), the column count, and how many
     cells there are. Missing any of these leaves those terminals wrapped at
     the width they first measured. Not `active`-gated inside TerminalPanel, so
     one counter correctly resizes every mounted pane. */
  /* The toolbar's canonical single↔multi collapse, mirroring Workspace's own
     `const cols = paneMode === 'single' ? 1 : windowCount`. Feeding the COUNT is
     the right lever: one slot already renders as a single full-width column, so
     nothing needs a second layout mode. */
  const effectiveWindows = paneMode === 'single' ? 1 : windowCount

  const cellCount = useMemo(
    () => workflowFloors.reduce((n, f) => n + f.agents.length, 0),
    [workflowFloors],
  )
  const [resizeNonce, setResizeNonce] = useState(0)
  useEffect(() => {
    setResizeNonce((n) => n + 1)
  }, [mode, tab, effectiveWindows, cellCount])

  const selectAgent = useCallback(
    (floorId: string, agentId: string) => onSelectAgent(floorId, agentId),
    [onSelectAgent],
  )

  /* select, open (spawn or reuse), and land on the chat — the one move that both
     the empty state and a click on a desk in the canvas make */
  const openChat = useCallback(
    async (floorId: string, agentId: string) => {
      onSelectAgent(floorId, agentId)
      /* Only meaningful in the detail view; harmless in the overview, where
         `mode` decides what is on screen rather than `tab`. */
      setTab('session')
      setOpeningAgentId(agentId)
      setError(null)
      try {
        await onOpenAgentChat(floorId, agentId)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not open that agent’s chat.')
      } finally {
        setOpeningAgentId(null)
      }
    },
    [onOpenAgentChat],
  )

  /* A click on a name in the sidebar asked to land in the chat, not merely to
     select. Keyed on the SIGNAL rather than on the selection itself, so the
     panel's own selections — a desk on the canvas, a row in the roster, the
     landing effect above — never spawn a process behind the user's back.
     The ref makes the first render inert: mounting is not a click. */
  const lastOpenSignal = useRef(openChatSignal)
  useEffect(() => {
    if (openChatSignal === lastOpenSignal.current) return
    lastOpenSignal.current = openChatSignal
    if (selFloorId && selAgentId) {
      /* Selecting an agent SWITCHES THE FOCUSED WINDOW, it does not leave the
         overview. Forcing 'detail' here meant every sidebar click threw away
         the wall of terminals you were watching to show one of them full
         screen — the opposite of what a multipane is for. The grid places the
         newly selected agent in the focused window on its own.
         From the detail view the same click still just swaps which agent the
         single pane shows. Going full screen is its own gesture: the ⤢ on a
         window, or Details. */
      void openChat(selFloorId, selAgentId)
    }
  }, [openChatSignal, selFloorId, selAgentId, openChat])

  /* Escape closes the detail view, the way it closes every dialog in this app.
     Ignored while focus is in the terminal: Escape there is the CLI's own
     interrupt, and stealing it would make a running turn impossible to stop. */
  useEffect(() => {
    if (mode !== 'detail') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = document.activeElement
      if (el && el.classList.contains('xterm-helper-textarea')) return
      setMode('multipane')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  /* Remount the designer when a floor's chat bindings change. The canvas owns
     its agent array while you edit it and saves the WHOLE array, so a snapshot
     taken before an agent was given a sessionId would write that binding back
     out as absent. Re-seeding costs nothing visible here — opening a chat has
     already moved you to the Session tab, so the re-fit happens off-screen. */
  const chatSignature = useMemo(
    () =>
      selectedFloor === null
        ? ''
        : selectedFloor.agents.map((a) => `${a.id}:${a.sessionId ?? ''}`).join('|'),
    [selectedFloor],
  )

  const totalAgents = useMemo(
    () => workflowFloors.reduce((n, f) => n + f.agents.length, 0),
    [workflowFloors],
  )

  /** the grid is on screen as the overview, or as the Session tab's content */
  const gridOnScreen = mode === 'multipane' || tab === 'session'

  /** jump straight to one of the floor's boards for a given agent */
  const openTab = useCallback(
    (floorId: string, agentId: string, t: GridTab) => {
      selectAgent(floorId, agentId)
      setTab(t)
      setMode('detail')
    },
    [selectAgent],
  )

  /* PROMPT KANBAN SHORTCUT — Alt+X, or Ctrl/Cmd + Shift + P.

     Captured at the window, before the terminal sees it: an agent's chat has
     keyboard focus most of the time here, and a shortcut you can only use by
     clicking away from what you are watching is not a shortcut. That capture is
     also why Alt+X never reaches the pty as the ESC x it would otherwise send.

     It toggles against the FOCUSED window, so the board you land on belongs to
     the agent you were just watching — selection follows focus, and pressing it
     again puts the wall of chats back exactly as it was.

     Shift is in the Ctrl/Cmd variant so it cannot collide with the browser's
     Ctrl+P. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const altX = e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyX'
      const ctrlShiftP =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p'
      if (!altX && !ctrlShiftP) return
      e.preventDefault()
      e.stopPropagation()
      if (tab === 'prompts' && mode === 'detail') {
        /* pressed again on the board itself — go back to the wall of chats */
        setMode('multipane')
        return
      }
      setTab('prompts')
      setMode('detail')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tab, mode])

  /** non-null while an agent's details modal is open */
  const [editing, setEditing] = useState<{ floorId: string; agentId: string } | null>(null)
  const editingAgent = useMemo(() => {
    if (!editing) return null
    const f = floors.find((x) => x.id === editing.floorId)
    const a = f?.agents.find((x) => x.id === editing.agentId)
    return f && a ? { floor: f, agent: a } : null
  }, [editing, floors])

  /* the installed kit, for the modal's pick lists. Loaded once, and only when a
     modal is actually opened — most sessions never open one. */
  const [skillNames, setSkillNames] = useState<string[]>([])
  const [mcpNames, setMcpNames] = useState<string[]>([])
  useEffect(() => {
    if (!editing || skillNames.length > 0 || mcpNames.length > 0) return
    let cancelled = false
    void api.getSkills().then(
      (l) => !cancelled && setSkillNames([...new Set(l.map((x) => x.name))].sort()),
      () => {},
    )
    void api.getMcpServers().then(
      (l) => !cancelled && setMcpNames([...new Set(l.map((x) => x.name))].sort()),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [editing, skillNames.length, mcpNames.length])

  /* THE ONE SET OF LIVE PANES in this panel, built once as a value and placed
     in exactly one spot in the tree. Two JSX call sites — one for the overview
     and one for the Session tab — would be two React subtrees, and moving
     between them would unmount every terminal and kill every pty. It changes
     LAYOUT instead, and never moves. */
  const terminalGrid = (
    <AgentTerminalGrid
      floors={workflowFloors}
      projects={projects}
      fallbackProject={project}
      theme={theme}
      defaultView={defaultView}
      shellRefresh={shellRefresh}
      reconnectAllSignal={reconnectAllSignal}
      resizeSignal={resizeNonce}
      liveSessionIds={liveSessionIds}
      selFloorId={selFloorId}
      selAgentId={selAgentId}
      agentCommand={agentCommand}
      layout={mode === 'multipane' ? 'grid' : 'single'}
      visible={mode === 'multipane' || tab === 'session'}
      windowCount={effectiveWindows}
      slots={agentSlots}
      onSlotsChange={onAgentSlotsChange}
      onSelectAgent={selectAgent}
      onOpenChat={(floorId, agentId) => {
        setMode('detail')
        void openChat(floorId, agentId)
      }}
      onOpenTab={openTab}
      onEditAgent={(floorId, agentId) => setEditing({ floorId, agentId })}
      onOpenDetails={(floorId, agentId) => {
        selectAgent(floorId, agentId)
        setTab('design')
        setMode('detail')
      }}
      onSessionIdChange={onSessionIdChange}
      onActiveSessionsChange={onActiveSessionsChange}
    />
  )

  return (
    <section
      aria-label="Agent workflow"
      className="relative flex h-full min-h-0 w-full overflow-hidden bg-midnight"
    >
      {/* — the right side: the chart, or the chat — */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The OVERVIEW's own header: no tabs, because the overview is not one
             of them — it is the floor itself. */}
        {mode === 'multipane' && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-midnight-2 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">Floor</span>
            <span className="min-w-0 flex-1 truncate font-display text-[12px] italic text-sand-dim">
              Every agent's chat, live and side by side.
            </span>
            {/* No count control here: the toolbar's "N windows" already decides,
                 and two knobs for one layout is what made 8 panes appear when
                 the toolbar said 2. */}
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
              {effectiveWindows} window{effectiveWindows === 1 ? '' : 's'}
            </span>
          </div>
        )}

        <div
          className={`shrink-0 items-center gap-2 border-b border-hairline bg-midnight-2 px-3 py-2 ${
            mode === 'detail' ? 'flex' : 'hidden'
          }`}
        >
          <nav className="flex shrink-0 items-center gap-1" aria-label="Agent workflow view">
            {TABS.map(({ id, label, icon: Icon }) => {
              const isActive = tab === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTab(id)
                    /* Leave the wall of terminals when a tab is picked. The
                       grid paints above every tab panel in multipane, so
                       clicking Hooks or Memory from there looked like a dead
                       button — the panel HAD switched, you just could not see
                       it. Session is the exception: that tab IS the grid. */
                    if (id !== 'session') setMode('detail')
                  }}
                  aria-current={isActive ? 'true' : undefined}
                  className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 ${
                    isActive
                      ? 'border-brass bg-brass/10 text-brass'
                      : 'border-hairline text-sand hover:border-brass hover:text-brass'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              )
            })}
          </nav>
          <div className="min-w-0 flex-1 truncate text-right font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
            {selectedFloor === null
              ? 'No floor'
              : selectedAgent === null
                ? selectedFloor.name
                : `${selectedFloor.name} · ${selectedAgent.name}`}
          </div>
          {/* Back to the overview. A ✕ rather than a "back" arrow because the
              detail view arrived over the top of the multipane — closing it is
              what you are doing, not navigating somewhere new. */}
          <button
            type="button"
            onClick={() => setMode('multipane')}
            title="Close — back to the floor"
            aria-label="Close details and go back to the floor"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {error !== null && (
          <p
            role="alert"
            className="shrink-0 border-b border-hairline-s px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-[#cf6b52]"
          >
            {error}
          </p>
        )}

        <div className="relative min-h-0 flex-1">
          {/* — Kanban: the CRM's own board for whatever this floor is attached
               to. Read-only; the cards are live production goals. — */}
          <section
            aria-label="CRM board"
            aria-hidden={tab === 'kanban' ? undefined : true}
            /* All three panels are absolute siblings kept MOUNTED, so paint
               order is DOM order and `invisible` alone is not enough: a child
               may re-declare visibility (React Flow's nodes do), and an inert
               later sibling would then draw over the active earlier one. The
               active panel therefore claims the top layer explicitly, and the
               inactive ones drop behind it and stop taking clicks. */
            className={`absolute inset-0 ${
              tab === 'kanban' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            <CrmKanban
              scope={selectedFloor?.crmScope ?? null}
              onChangeScope={(next) => {
                if (!selectedFloor) return
                void onAttachScope(selectedFloor.id, next)
              }}
            />
          </section>

          {/* — Prompt Kanban: the floor's own queue of work, local to this
               machine. Separate from the Goal Kanban above on purpose — that
               one is the company's live CRM. — */}
          <section
            aria-label="Prompt board"
            aria-hidden={tab === 'prompts' ? undefined : true}
            className={`absolute inset-0 ${
              tab === 'prompts' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            <PromptKanban
              floorId={selectedFloor?.id ?? null}
              refreshSignal={promptRefresh}
              /* The card stores the agent's NAME, so resolve it against the floor
                 the board belongs to. A name that no longer matches an agent —
                 one removed since the card was handed out — simply does
                 nothing rather than opening somebody else's chat. */
              /* Push the card to an agent: the server starts or wakes that
                 agent's chat, types the prompt in, and moves the card. The
                 project is the one the floor's chats run in — an agent needs a
                 directory to work in, and this panel already knows which. */
              onPush={async (promptId, agentName) => {
                if (!selectedFloor) return
                const res = await fetch(
                  `/api/floors/${selectedFloor.id}/prompts/${promptId}/push`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agent: agentName, projectId: memoryProjectId }),
                  },
                )
                if (!res.ok) {
                  const b = await res.json().catch(() => ({}))
                  throw new Error(b.error || `HTTP ${res.status}`)
                }
              }}
              onGoToChat={(agentName) => {
                const a = selectedFloor?.agents.find(
                  (x) => x.name.trim().toLowerCase() === agentName.trim().toLowerCase(),
                )
                if (a && selectedFloor) void openChat(selectedFloor.id, a.id)
              }}
            />
          </section>

          {/* — Agents / Skills / MCP: what this workflow is made of. One
               component, three views — they share the same floors data and the
               same empty states, and splitting them into three files would put
               the same roster logic in three places. — */}
          {(['agents', 'skills', 'mcp'] as const).map((v) => (
            <section
              key={v}
              aria-label={`Workflow ${v}`}
              aria-hidden={tab === v ? undefined : true}
              className={`absolute inset-0 ${
                tab === v ? 'z-20' : 'invisible pointer-events-none z-0'
              }`}
            >
              <FloorEquipment
                view={v}
                /* THIS floor, not every workflow floor. Every other tab in
                   this panel — Preamble, Hooks, Memory, both boards — is scoped
                   to the selected floor, and Agents listing all of them made it
                   the odd one out: you click into the CRM workflow and are shown
                   people who work somewhere else. */
                floors={selectedFloor === null ? [] : [selectedFloor]}
                liveSessionIds={liveSessionIds}
                onSelectAgent={(floorId, agentId) => {
                  selectAgent(floorId, agentId)
                  setTab('design')
                }}
                onOpenChat={(floorId, agentId) => void openChat(floorId, agentId)}
              />
            </section>
          ))}

          {/* — Memory: the shared notebook the floor's agents read and write.
               Same mounting rule as the others (kept alive, layered, inert when
               inactive) so switching tabs never remounts and re-fetches. — */}
          <section
            aria-label="Floor memory"
            aria-hidden={tab === 'memory' ? undefined : true}
            className={`absolute inset-0 ${
              tab === 'memory' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            <FloorMemory
              floorId={selectedFloor?.id ?? null}
              projectId={memoryProjectId}
              refreshSignal={memoryRefresh}
            />
          </section>

          {/* — Preamble: what this floor tells every agent first. Same mounting
               rule as the rest — kept alive and layered, never remounted, so an
               unsaved edit survives a tab switch. — */}
          <section
            aria-label="Floor preamble"
            aria-hidden={tab === 'preamble' ? undefined : true}
            className={`absolute inset-0 bg-surface ${
              tab === 'preamble' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            <FloorPreamble
              floor={selectedFloor}
              projects={projects}
              onSave={onSetFloorPrompt}
              onWorkspaceChanged={onRefreshFloors}
            />
          </section>

          {/* — Hooks: this workflow's own settings.json. Same mounting rule
               as the rest — layered and inert, never unmounted. — */}
          {/* — Goals: this floor's own, offline. Same mounting rule as the
               rest — layered and inert, never unmounted. — */}
          <section
            aria-label="Floor goals"
            aria-hidden={tab === 'goals' ? undefined : true}
            className={`absolute inset-0 bg-surface ${
              tab === 'goals' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            <FloorGoals floor={selectedFloor} />
          </section>

          <section
            aria-label="Floor hooks"
            aria-hidden={tab === 'hooks' ? undefined : true}
            className={`absolute inset-0 bg-surface ${
              tab === 'hooks' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            <FloorHooks floor={selectedFloor} />
          </section>

          {/* — Design: the floor's org chart. A desk opens that agent's chat. — */}
          <section
            aria-label="Floor design"
            aria-hidden={tab === 'design' ? undefined : true}
            className={`absolute inset-0 bg-surface ${
              tab === 'design' ? 'z-20' : 'invisible pointer-events-none z-0'
            }`}
          >
            {selectedFloor === null ? (
              <Blank
                icon={Users}
                title="No workflow floors yet"
                body="A workflow floor is the org chart of one workflow: who the boss is, who reports to whom, and the brief each agent carries into its chat. Add a floor from the sidebar to start drawing one."
              />
            ) : (
              <FloorDesigner
                key={`${selectedFloor.id}::${chatSignature}`}
                floor={selectedFloor}
                theme={theme}
                onOpenChat={(agentId: string) => {
                  void openChat(selectedFloor.id, agentId)
                }}
              />
            )}
          </section>

          {/* — Session: the SAME grid as the overview, laid out for one agent.
               One set of panes exists in this panel and this is it: a second
               SessionPane on the same session id would put two sockets on one
               pty. The grid moves between layouts; it is never rebuilt. — */}
          <section
            aria-label="Agent session"
            aria-hidden={gridOnScreen ? undefined : true}
            className={`absolute inset-0 ${
              gridOnScreen
                ? mode === 'multipane'
                  ? 'z-30'
                  : 'z-20'
                : 'invisible pointer-events-none z-0'
            }`}
          >
            {terminalGrid}
          </section>

        </div>
      </div>

      {/* — Edit an agent from anywhere: a right-click on its window, the
           canvas. Same modal the designer opens, so there is one place
           that knows what an agent is made of. — */}
      {editingAgent !== null && (
        <AgentModal
          agent={editingAgent.agent}
          managerName={
            editingAgent.floor.agents.find((a) => a.id === editingAgent.agent.reportsTo)?.name ??
            null
          }
          skillNames={skillNames}
          mcpNames={mcpNames}
          onPatch={(patch) => onPatchAgent(editingAgent.floor.id, editingAgent.agent.id, patch)}
          onRemove={() => {
            onRemoveAgent(editingAgent.floor.id, editingAgent.agent.id)
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
