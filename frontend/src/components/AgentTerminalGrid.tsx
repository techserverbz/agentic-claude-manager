import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BrainCircuit,
  KanbanSquare,
  LayoutGrid,
  ListTodo,
  Maximize2,
  MessageSquare,
  Network,
  Plug,
  Sparkles,
  SlidersHorizontal,
  TerminalSquare,
  Users2,
} from 'lucide-react'
import type { DefaultView, Theme } from '../App'
import type { Floor, FloorAgent, Project } from '../lib/api'
import { AgentPicker, type AgentOption } from './AgentPicker'
import { SessionPane } from './SessionPane'

/**
 * AgentTerminalGrid — every agent's LIVE chat, side by side.
 *
 * The whole floor at once: one real terminal per agent, so you can watch six
 * of them working without hopping between tabs.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THIS COMPONENT OWNS THE ONLY SessionPanes IN THE PANEL. Four rules follow
 * from that, and breaking any of them ends somebody's turn:
 *
 *  1. NEVER UNMOUNT A CELL. A SessionPane's unmount disposes its xterm and its
 *     /ws/terminal socket, which kills the server-side pty and the claude CLI
 *     inside it. Cells are hidden with `invisible` — never conditional
 *     rendering, never `display:none` (xterm needs real dimensions to lay out).
 *     That is why this grid stays mounted on every tab and in both modes, and
 *     merely changes how it is laid out.
 *
 *  2. ONE PANE PER SESSION. Two SessionPanes on one sessionId open two sockets
 *     to one pty and fight over it. Each cell binds strictly to its own
 *     `agent.sessionId` — there is deliberately no "last good session" fallback
 *     here, because that fallback is exactly what would put two cells on one id.
 *
 *  3. A CELL WITHOUT A CHAT MOUNTS NOTHING. SessionPane treats a null sessionId
 *     as "not yet minted" and will pool a terminal under a fresh `new:` key —
 *     which spawns a real pty. Six chatless agents would silently spawn six
 *     claudes. Chatless cells render a placeholder instead.
 *
 *  4. EXACTLY ONE CELL IS FOCUSED. `isFocused` gates the force-restart and
 *     reconnect signals inside TerminalPanel; handing it to every cell would
 *     force-restart every shell at once on a single refresh.
 * ────────────────────────────────────────────────────────────────────────
 */

/** the panel tabs a window can jump straight to */
export type GridTab = 'prompts' | 'kanban' | 'memory' | 'design' | 'agents' | 'skills' | 'mcp'


/** the App-level identity each cell reports live sessions under.
 *  MUST be unique per cell: App stores these in a Record keyed by this string,
 *  so two cells sharing one key means the last writer wins and the other
 *  agent's shells vanish from the live-session set. */
const cellKey = (floorId: string, agentId: string) => `agent-workflow:${floorId}:${agentId}`

/* The chat's name is no longer resolved here: SessionPane's own header shows
   it, and computing it twice was half of why the same words appeared three
   times on one window. */

/** The project this agent's chat actually runs in.
 *  Resolved from the session rather than assuming the selected project: an
 *  agent's chat was spawned in one specific directory, and binding its pane to
 *  a different project would make SessionPane drop its pool and reconnect
 *  against the wrong cwd. */
/**
 * Which project a pane runs in, most specific first.
 *
 * The FLOOR'S WORKSPACE wins. It is the only one of the three that states
 * where this floor's work actually lives; the other two are guesses, and
 * both guessed wrong in practice — session-ownership picks the first project
 * holding that id (which put a CRM agent in the orchestrator's folder when
 * one id existed in two projects), and the fallback is just whatever the
 * human last clicked in the sidebar.
 */
function projectOf(
  floor: Floor,
  agent: FloorAgent,
  projects: Project[],
  fallback: Project | null,
): Project | null {
  if (floor.workspaceProjectId) {
    const pinned = projects.find((p) => p.id === floor.workspaceProjectId)
    if (pinned) return pinned
  }
  if (agent.sessionId) {
    const owner = projects.find((p) => p.sessions.some((s) => s.id === agent.sessionId))
    if (owner) return owner
  }
  return fallback
}

export function AgentTerminalGrid({
  floors,
  projects,
  fallbackProject,
  theme,
  defaultView,
  shellRefresh,
  reconnectAllSignal,
  resizeSignal,
  liveSessionIds,
  selFloorId,
  selAgentId,
  agentCommand,
  /** 'grid' shows every cell; 'single' shows only the selected one, full size */
  layout,
  /** whether this whole surface is on screen at all */
  visible,
  windowCount,
  slots,
  onSlotsChange,
  onSelectAgent,
  onOpenChat,
  onOpenDetails,
  onOpenTab,
  onEditAgent,
  onSessionIdChange,
  onActiveSessionsChange,
}: {
  floors: Floor[]
  projects: Project[]
  fallbackProject: Project | null
  theme: Theme
  defaultView: DefaultView
  shellRefresh: number
  reconnectAllSignal: number
  resizeSignal: number
  liveSessionIds: string[]
  selFloorId: string | null
  selAgentId: string | null
  /** applied to the pane matching the selection; every other pane ignores it */
  agentCommand: { kind: 'terminal' | 'chat' | 'reconnect'; nonce: number } | null
  layout: 'grid' | 'single'
  visible: boolean
  windowCount: number
  /** CONTROLLED. The slot list lives in App so a saved view can capture it;
   *  this component decides what belongs in it and reports changes upward. */
  slots: (string | null)[]
  onSlotsChange: (slots: (string | null)[]) => void
  onSelectAgent: (floorId: string, agentId: string) => void
  onOpenChat: (floorId: string, agentId: string) => void
  onOpenDetails: (floorId: string, agentId: string) => void
  /** jump straight to one of the floor's boards for this agent's floor */
  onOpenTab: (floorId: string, agentId: string, tab: GridTab) => void
  /** open the agent's details modal — name, brief, skills, MCP */
  onEditAgent: (floorId: string, agentId: string) => void
  onSessionIdChange: (key: string, sessionId: string) => void
  onActiveSessionsChange: (key: string, ids: string[]) => void
}) {
  const live = new Set(liveSessionIds)
  /* Flattened once, in a stable order. Every cell is keyed on the agent's id —
     never on an index and never on anything containing sessionId, either of
     which would remount (and kill) a live pane when the roster shifts. */
  const cells = floors.flatMap((f) => f.agents.map((a) => ({ floor: f, agent: a })))

  /* WINDOWS ARE SLOTS YOU FILL, exactly like the workspace's: the toolbar says
     how many, and you choose which agent goes in each. Paging through in a
     fixed order was the wrong model — the two agents you want side by side are
     rarely adjacent on the roster.
     `slots` holds one agent key per window. Everyone else stays MOUNTED and
     running; they are simply not placed in the row. */
  const slotCount = Math.max(1, windowCount)
  const keyOf = (floorId: string, agentId: string) => `${floorId}:${agentId}`
  /* The current slots, read through a ref. The owner passes a NEW array on
     every change, so depending on `slots` directly would re-run these effects
     each time one of them reported a change — a loop. */
  const slotsRef = useRef(slots)
  slotsRef.current = slots

  /* Keep the slot list the length the toolbar asks for, filling new windows
     with agents that are not already on screen. Runs on the count AND on the
     roster, so hiring somebody does not leave a window empty for ever. */
  useEffect(() => {
    const prev = slotsRef.current
    /* Any agent that no longer exists is dropped — a view saved before somebody
       was removed from the floor restores as an empty window rather than a
       dangling key. */
    const valid = new Set(cells.map((c) => keyOf(c.floor.id, c.agent.id)))
    const next = prev.slice(0, slotCount).map((k) => (k && valid.has(k) ? k : null))
    while (next.length < slotCount) next.push(null)
    const taken = new Set(next.filter(Boolean) as string[])
    for (let i = 0; i < next.length; i++) {
      if (next[i]) continue
      const free = cells.find((c) => !taken.has(keyOf(c.floor.id, c.agent.id)))
      if (!free) break
      const k = keyOf(free.floor.id, free.agent.id)
      next[i] = k
      taken.add(k)
    }
    /* Report only a real change: this is a controlled value, and echoing an
       identical array back to the owner would re-render on every pass. */
    const same = next.length === prev.length && next.every((k, i) => k === prev[i])
    if (!same) onSlotsChange(next)
  }, [slotCount, cells.map((c) => keyOf(c.floor.id, c.agent.id)).join('|'), onSlotsChange])

  /* Selecting an agent anywhere else — the sidebar, a prompt card, the canvas —
     must bring them ON SCREEN. They take the focused window if they are not
     already in one, rather than silently doing nothing. */
  const selKey = selFloorId && selAgentId ? keyOf(selFloorId, selAgentId) : null
  const [focusedSlot, setFocusedSlot] = useState(0)
  useEffect(() => {
    const key = slots[focusedSlot]
    if (!key) return
    const [floorId, agentId] = key.split(':')
    if (!floorId || !agentId) return
    if (floorId === selFloorId && agentId === selAgentId) return
    onSelectAgent(floorId, agentId)
    /* onSelectAgent is an inline arrow from the panel — a new function every
       render — so it stays out of the deps on purpose. The guard above makes
       this a no-op once the two agree, so it cannot loop with the effect
       below (which writes the selection INTO the focused slot). */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, focusedSlot, selFloorId, selAgentId])

  useEffect(() => {
    if (!selKey) return
    const prev = slotsRef.current
    if (prev.includes(selKey)) return
    const at = Math.min(focusedSlot, prev.length - 1)
    if (at < 0) return
    const next = [...prev]
    next[at] = selKey
    onSlotsChange(next)
  }, [selKey, focusedSlot, onSlotsChange])

  /** the picker's options — built once, not once per window */
  const pickerOptions: AgentOption[] = cells.map((c) => ({
    key: keyOf(c.floor.id, c.agent.id),
    name: c.agent.name,
    floorName: c.floor.name,
    isBoss: c.agent.isBoss,
    live: c.agent.sessionId != null && live.has(c.agent.sessionId),
    hasChat: c.agent.sessionId != null,
  }))

  /** put an agent in one window; if they are already in another, swap the two */
  const assign = (slotIndex: number, key: string) => {
    const next = [...slotsRef.current]
    const already = next.indexOf(key)
    if (already !== -1 && already !== slotIndex) next[already] = next[slotIndex]
    next[slotIndex] = key
    onSlotsChange(next)
  }

  if (cells.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="max-w-md text-center font-display text-[14px] italic leading-relaxed text-sand">
          No agents yet. Add a floor from the sidebar, then draw your team on the
          Design tab — each one gets a live pane here.
        </p>
      </div>
    )
  }

  return (
    /* VERTICAL COLUMNS, one row. Each pane is full height and they sit side by
       side — the same shape the workspace uses for its split, so a terminal
       here is as tall as a terminal there. A row of tall panes also suits what
       a terminal actually is: long output read downward, not a squat tile. */
    <div
      className={
        layout === 'grid'
          ? /* One row of full-height vertical columns, shrinking to share the
                 width so every selected window stays visible (no side-scroll).
                 The hairline gap is the only thing between two terminals. */
            'no-scrollbar relative flex h-full min-h-0 w-full gap-px overflow-x-auto overflow-y-hidden bg-hairline'
          : 'relative h-full min-h-0 w-full'
      }
    >
      {cells.map(({ floor, agent }) => {
        const isSel = agent.id === selAgentId && floor.id === selFloorId
        const myKey = keyOf(floor.id, agent.id)
        /* Which window this agent is in, or -1 for nobody's window. Hidden,
           never removed — an unplaced pane keeps its socket and keeps running.
           CSS `order` puts it in the slot you chose rather than in roster
           order, so the DOM order (which React needs stable) and the visual
           order stay independent. */
        const slotIndex = slots.indexOf(myKey)
        const shown = layout === 'grid' ? slotIndex !== -1 : isSel
        const isFocusedSlot = shown && layout === 'grid' && slotIndex === focusedSlot
        const proj = projectOf(floor, agent, projects, fallbackProject)
        /* Narrowed once. `sessionId` is optional on FloorAgent (absent on every
           floor written before agent chats existed), so `!== null` alone would
           let `undefined` through — and an undefined sessionId reaching
           SessionPane is the "mints a new pty" hazard, not a no-op. */
        const sid: string | null = agent.sessionId ?? null
        const key = cellKey(floor.id, agent.id)

        return (
          <section
            key={agent.id}
            aria-label={`${agent.name} — chat`}
            aria-hidden={visible && shown ? undefined : true}
            className={
              layout === 'single'
                ? `absolute inset-0 flex flex-col bg-surface ${
                    shown ? 'z-10' : 'invisible pointer-events-none z-0'
                  }`
                : shown
                  ? /* min-w-0 alone let a fourth window squeeze the others until
                       the header controls overlapped the agent name. A floor of
                       14rem keeps every pane readable and lets the row scroll
                       rather than crushing what is already there. */
                    'relative flex min-h-0 min-w-[14rem] flex-1 basis-0 flex-col bg-surface'
                  : /* in nobody's window: still mounted and still running,
                       parked out of the row rather than deleted from it */
                    'invisible pointer-events-none absolute inset-0 flex flex-col bg-surface'
            }
            style={shown && layout === 'grid' ? { order: slotIndex } : undefined}
            onPointerDownCapture={() => {
              if (!shown || layout !== 'grid') return
              /* Selects as well as focuses. The ring, the pane that takes
                 keystrokes, and the app's idea of the current agent are three
                 things that must never disagree — clicking a window is the one
                 gesture that sets all three. */
              setFocusedSlot(slotIndex)
              if (!isSel) onSelectAgent(floor.id, agent.id)
            }}
          >
            {/* THE FOCUS RING, drawn as an overlay ABOVE the pane rather than
                as a border on it. A terminal fills its box edge to edge and
                paints its own background, so a ring on the container is covered
                on the inside edges — this sits over the top and reaches all four
                sides. Same treatment the workspace gives its focused window. */}
            {isFocusedSlot && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-brass"
              />
            )}

            <div className="relative min-h-0 flex-1">
              {sid !== null && proj !== null ? (
                <SessionPane
                  /* The floor label and the agent picker go INTO the pane's own
                     header row. A second header stacked above it wrote the
                     agent's name a third time on the same window. */
                  hideTitle
                  headerLead={
                    /* basis-full below 26rem: the name takes the whole first
                       row and the controls drop to a second one. Above that
                       the original single-row layout returns untouched. */
                    <div className="flex min-w-0 flex-1 basis-full flex-col gap-0.5 @[26rem]:basis-auto">
                      {/* Hidden when the pane is tight: the picker itself names
                          the floor whenever there is more than one, so this line
                          is the cheapest thing to give back to the name. */}
                      <span className="hidden truncate font-mono text-[8.5px] uppercase tracking-[0.22em] text-sand-dim @[20rem]:block">
                        {floor.name}
                      </span>
                      <AgentPicker
                        value={myKey}
                        options={pickerOptions}
                        showFloor={floors.length > 1}
                        onChange={(k) => {
                          setFocusedSlot(slotIndex)
                          assign(slotIndex, k)
                        }}
                      />
                    </div>
                  }
                  /* ALL FOUR STAY, at every width. An earlier version dropped
                     them as the pane narrowed and that was the wrong trade: a
                     control you cannot find is worse than one that is merely
                     tight. The space comes from the CHAT/TERMINAL words and the
                     agent name, neither of which loses meaning by shrinking. */
                  headerActions={
                    <>
                      <button
                        type="button"
                        onClick={() => onEditAgent(floor.id, agent.id)}
                        title={`Edit ${agent.name} — brief, skills, MCP`}
                        aria-label={`Edit ${agent.name}`}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                      >
                        <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenTab(floor.id, agent.id, 'prompts')}
                        title="Prompt Kanban for this floor"
                        aria-label="Open the Prompt Kanban"
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                      >
                        <ListTodo className="h-3 w-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenChat(floor.id, agent.id)}
                        title={`Open ${agent.name}'s chat on its own`}
                        aria-label={`Open ${agent.name}'s chat full screen`}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                      >
                        <Maximize2 className="h-3 w-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenDetails(floor.id, agent.id)}
                        title="Design, Goal Kanban, Prompt Kanban, Memory…"
                        aria-label={`Open the ${floor.name} floor details`}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                      >
                        <LayoutGrid className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </>
                  }
                  project={proj}
                  sessionId={sid}
                  theme={theme}
                  defaultView={defaultView}
                  shellRefresh={shellRefresh}
                  resizeSignal={resizeSignal}
                  reconnectAllSignal={reconnectAllSignal}
                  /* ONE focused cell. isFocused gates force-restart and
                     reconnect inside TerminalPanel — true everywhere would
                     restart every shell at once on a single refresh. */
                  /* In the row it is the focused WINDOW that is live; in the
                     single layout there is only one pane and it is the selected
                     agent's. Exactly one cell is ever true either way. */
                  isFocused={visible && shown && (layout === 'grid' ? isFocusedSlot : isSel)}
                  /* Only the selected pane hears it. Handing the same
                     command to every pane would reconnect eight shells
                     because somebody asked about one. */
                  command={isSel ? agentCommand : null}
                  onSessionIdChange={(sid) => onSessionIdChange(key, sid)}
                  onActiveSessionsChange={(ids) => onActiveSessionsChange(key, ids)}
                />
              ) : (
                /* No chat: mount NOTHING. A SessionPane with a null sessionId
                   mints a `new:` key and spawns a real pty — six chatless
                   agents would quietly start six claudes. */
                <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                  <span className="font-mono text-[8.5px] uppercase tracking-[0.22em] text-sand-dim">
                    {floor.name}
                  </span>
                  <p className="font-display text-[12.5px] italic leading-relaxed text-sand">
                    {agent.name} has no chat yet.
                  </p>
                  {/* the picker still belongs on an empty window — it is how you
                      put somebody else in it without starting a chat you did
                      not want */}
                  <div className="border border-hairline">
                    <AgentPicker
                      value={myKey}
                      options={pickerOptions}
                      showFloor={floors.length > 1}
                      onChange={(k) => {
                        setFocusedSlot(slotIndex)
                        assign(slotIndex, k)
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenChat(floor.id, agent.id)}
                    disabled={proj === null}
                    title={proj === null ? 'No project to run it in' : `Start ${agent.name}'s chat`}
                    className="flex cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <MessageSquare className="h-3 w-3" aria-hidden="true" />
                    Start chat
                  </button>
                </div>
              )}
            </div>
          </section>
        )
      })}
      {/* EMPTY WINDOWS: when the toolbar asks for more windows than there are
          agents to fill them, the leftover slots show as empty placeholders —
          the same idea as the workspace's empty slots — so the number you pick
          is the number you see. Each carries a picker, so it is also how you
          drop an agent into that window. */}
      {layout === 'grid' &&
        Array.from({ length: slotCount }, (_, i) => i)
          .filter((i) => !slots[i])
          .map((i) => (
            <section
              key={`empty-${i}`}
              aria-label={`Empty window ${i + 1}`}
              className="relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-3 bg-surface px-4 text-center"
              style={{ order: i }}
              onPointerDownCapture={() => setFocusedSlot(i)}
            >
              {focusedSlot === i && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-brass"
                />
              )}
              <TerminalSquare className="h-5 w-5 text-sand-dim" aria-hidden="true" />
              <p className="max-w-[14rem] font-display text-[12.5px] italic leading-relaxed text-sand-dim">
                Empty window — pick an agent to place here.
              </p>
              <div className="border border-hairline">
                <AgentPicker
                  value=""
                  options={pickerOptions}
                  showFloor={floors.length > 1}
                  onChange={(k) => {
                    setFocusedSlot(i)
                    assign(i, k)
                  }}
                />
              </div>
            </section>
          ))}
    </div>
  )
}
