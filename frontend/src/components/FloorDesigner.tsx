import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Crown, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, type Floor, type FloorAgent } from '../lib/api'
import { AgentModal } from './AgentModal'
import type { Theme } from '../App'

/**
 * FloorDesigner — the org chart for one floor, on a React Flow canvas.
 *
 * A floor is a BLUEPRINT of roles: who the boss is, who reports to whom, and
 * the markdown brief (`.md`) each agent carries. Nothing here is a live pty —
 * that is deliberate, and it is why a floor can be designed before any session
 * exists.
 *
 * Edges are DERIVED from each agent's `reportsTo`, never stored separately, so
 * the graph can never disagree with the data. Dragging a connection from a
 * manager to a report just sets `reportsTo`; the edge appears because of that.
 *
 * Saving is debounced and whole-array: the canvas owns the agent list and hands
 * the server the finished set, which validates it and repairs dangling links
 * and cycles on the way in (server/lib/floors.js).
 *
 * OPENING a chat is a separate act from SELECTING a desk, and stays separate.
 * `onOpenChat` is optional: without it this is exactly the floor tab it has
 * always been and a node grows no extra control. With it, each desk carries a
 * small chat button — a second target rather than an overload of the node
 * click, because clicking a node means "show me this in the inspector" and has
 * to keep meaning that even once a click can also start a real process.
 */

/** How a desk opens its agent's chat, when the surrounding panel offers one.
 *
 *  This travels by CONTEXT rather than through `node.data` on purpose. The node
 *  array is rebuilt in three places — initial state, floor switch, hiring — and
 *  threading a callback through all of them would put a function identity into
 *  diffed node data, churning every node on every parent render for a value
 *  that never varies per node. `null` is the standalone case: the node view
 *  then renders precisely as it did before the prop existed. */
const OpenChatContext = createContext<((agentId: string) => void) | null>(null)

type AgentNodeData = {
  name: string
  role: string
  isBoss: boolean
  md: string
}
type AgentNode = Node<AgentNodeData, 'agent'>

/* — one desk on the chart — */
function AgentNodeView({ id, data, selected }: NodeProps<AgentNode>) {
  const onOpenChat = useContext(OpenChatContext)
  const preview = data.md.trim().split('\n').filter(Boolean).slice(0, 3).join(' ')
  return (
    <div
      className={`w-[220px] border bg-surface transition-colors duration-150 ${
        selected ? 'border-brass' : 'border-hairline'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-brass" />
      <div className="flex items-center gap-2 border-b border-hairline-s px-3 py-2">
        {data.isBoss && <Crown className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate font-display text-[13px] text-parchment">
          {data.name}
        </span>
        {data.isBoss && (
          <span className="shrink-0 border border-brass px-1 font-mono text-[8px] uppercase tracking-[0.14em] text-brass">
            Boss
          </span>
        )}

        {/* — open this agent's chat —
             Only rendered when a panel above handed us a way to open one, so a
             floor shown as a plain design tab is untouched.

             `nodrag`/`nopan` are the load-bearing half. React Flow's drag and
             zoom behaviours listen NATIVELY on ancestor elements, so a
             React-synthetic stopPropagation runs too late to cancel either —
             their filters look for these class names on the press target
             instead. Without them this button drags the desk or pans the
             canvas and never reports a click at all.

             stopPropagation then handles the React side, where `onNodeClick`
             would otherwise also fire and select the desk: opening a chat and
             loading the inspector are different intents, and one press must
             not do both. */}
        {onOpenChat && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onOpenChat(id)
            }}
            title={`Open ${data.name}'s chat`}
            aria-label={`Open ${data.name}'s chat`}
            className="nodrag nopan flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-150 hover:border-brass hover:text-brass"
          >
            <MessageSquare className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
          {data.role || 'no role'}
        </div>
        <p className="mt-1.5 line-clamp-3 font-display text-[11px] leading-snug text-sand">
          {preview || 'No brief yet.'}
        </p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-brass" />
    </div>
  )
}

/* module-level: a fresh object identity here would remount every node each render */
const nodeTypes = { agent: AgentNodeView }

function toNodes(agents: FloorAgent[]): AgentNode[] {
  return agents.map((a) => ({
    id: a.id,
    type: 'agent' as const,
    position: { x: a.x, y: a.y },
    data: { name: a.name, role: a.role, isBoss: a.isBoss, md: a.md },
  }))
}

/** edges are a pure function of reportsTo — manager is the source, report the target */
function toEdges(agents: FloorAgent[]): Edge[] {
  return agents
    .filter((a) => a.reportsTo)
    .map((a) => ({
      id: `${a.reportsTo}->${a.id}`,
      source: a.reportsTo as string,
      target: a.id,
      /* Orthogonal, not bezier. A reporting line is a statement about
         STRUCTURE — who answers to whom — and a curve reads as a flow,
         something moving along it. Right angles also stay legible when six
         reports fan out of one boss: parallel runs separate cleanly where
         curves cross each other at shallow angles and smear together. */
      type: 'smoothstep',
      pathOptions: { borderRadius: 2 },
      style: { stroke: 'var(--color-brass)', strokeWidth: 1.5 },
    }))
}

function FloorCanvas({ floor, theme }: { floor: Floor; theme: Theme }) {
  /* the canvas owns the agent list while you edit; the server gets the result */
  const [agents, setAgents] = useState<FloorAgent[]>(floor.agents)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /* right-click menu on an agent node: {x,y} are viewport coords for a fixed
     overlay, agentId is what every item acts on */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; agentId: string } | null>(null)
  /* the same callback the desks read — the menu's Open chat item needs it too,
     and reading the context here keeps one source for "is opening even offered" */
  const onOpenChat = useContext(OpenChatContext)

  /* Dismiss the node menu the way the sidebar's does — plus on wheel, because
     this one is pinned to viewport coords and the canvas underneath it pans. */
  useEffect(() => {
    if (ctxMenu === null) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', close)
    }
  }, [ctxMenu])


  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(toNodes(floor.agents))
  const [edges, setEdges] = useEdgesState<Edge>(toEdges(floor.agents))
  const [saving, setSaving] = useState(false)
  /* What this machine actually has installed. Fetched once per canvas and never
     stored on the agent: skills and servers are edited on disk outside this app,
     so an agent holds NAMES and the truth is re-read here. A name that stops
     resolving simply stops appearing in the list. */
  const [skillNames, setSkillNames] = useState<string[]>([])
  const [mcpNames, setMcpNames] = useState<string[]>([])

  const floorIdRef = useRef(floor.id)
  const latest = useRef(agents)
  latest.current = agents

  /* a different floor was opened in this pane — reset the canvas to it */
  useEffect(() => {
    if (floorIdRef.current === floor.id) return
    floorIdRef.current = floor.id
    setAgents(floor.agents)
    latest.current = floor.agents
    setNodes(toNodes(floor.agents))
    setEdges(toEdges(floor.agents))
    setSelectedId(null)
  }, [floor, setNodes, setEdges])

  /* the installed skills / servers, for the inspector's pick lists. Failure is
     silent on purpose: an unreachable list costs the ability to EQUIP an agent,
     which must not stop you designing the chart. */
  useEffect(() => {
    let cancelled = false
    void api.getSkills().then(
      (list) => {
        if (!cancelled) setSkillNames([...new Set(list.map((x) => x.name))].sort())
      },
      () => {},
    )
    void api.getMcpServers().then(
      (list) => {
        if (!cancelled) setMcpNames([...new Set(list.map((x) => x.name))].sort())
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [])

  /* the rendered edges follow the agent list we own */
  useEffect(() => {
    setEdges(toEdges(agents))
  }, [agents, setEdges])

  /* — debounced whole-array save. The pending list lives in a ref so a save in
       flight never writes a stale array after a fast edit, and the timer is
       cleared on unmount so a closed pane cannot save over a newer one. — */
  const saveTimer = useRef<number | undefined>(undefined)
  const queueSave = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      setSaving(true)
      api
        .updateFloor(floorIdRef.current, { agents: latest.current })
        .catch(() => {
          /* server unreachable — the canvas keeps the edits; the next save retries */
        })
        .finally(() => setSaving(false))
    }, 600)
  }, [])
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const mutate = useCallback(
    (next: FloorAgent[]) => {
      latest.current = next
      setAgents(next)
      queueSave()
    },
    [queueSave],
  )

  /* dragging moves a node; persist where it comes to rest, not every frame */
  const handleNodesChange = useCallback(
    (changes: NodeChange<AgentNode>[]) => {
      onNodesChange(changes)
      const settled: { id: string; x: number; y: number }[] = []
      for (const c of changes) {
        if (c.type === 'position' && c.dragging === false && c.position) {
          settled.push({ id: c.id, x: c.position.x, y: c.position.y })
        }
      }
      if (settled.length === 0) return
      mutate(
        latest.current.map((a) => {
          const hit = settled.find((s) => s.id === a.id)
          return hit ? { ...a, x: Math.round(hit.x), y: Math.round(hit.y) } : a
        }),
      )
    },
    [onNodesChange, mutate],
  )

  /* connecting manager → report is just a reportsTo write */
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      mutate(latest.current.map((a) => (a.id === c.target ? { ...a, reportsTo: c.source } : a)))
    },
    [mutate],
  )

  const addAgent = useCallback(() => {
    const boss = latest.current.find((a) => a.isBoss)
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `a-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const n = latest.current.length
    const next: FloorAgent = {
      id,
      name: `Agent ${n}`,
      role: '',
      isBoss: false,
      /* new hires report to the boss by default — a floating node reads as a
         mistake, and re-parenting is one drag away */
      reportsTo: boss ? boss.id : null,
      md: `# Agent ${n}\n\nWhat this agent is for.\n`,
      /* equipment starts EMPTY, meaning "inherit". A new hire that silently
         arrived pinned to a model, or holding skills nobody granted it, would
         be a decision made on the user's behalf and invisible until it mattered. */
      model: '',
      skills: [],
      mcpServers: [],
      x: 80 + (n % 4) * 250,
      y: 240 + Math.floor(n / 4) * 190,
    }
    mutate([...latest.current, next])
    setNodes((nds) => [...nds, ...toNodes([next])])
    setSelectedId(id)
  }, [mutate, setNodes])

  const removeAgent = useCallback(
    (id: string) => {
      const target = latest.current.find((a) => a.id === id)
      if (!target || target.isBoss) return // the floor keeps its top
      /* re-parent the reports rather than deleting a whole branch under them */
      const next = latest.current
        .filter((a) => a.id !== id)
        .map((a) => (a.reportsTo === id ? { ...a, reportsTo: target.reportsTo } : a))
      mutate(next)
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setSelectedId((cur) => (cur === id ? null : cur))
    },
    [mutate, setNodes],
  )

  const patchAgent = useCallback(
    (id: string, patch: Partial<FloorAgent>) => {
      mutate(latest.current.map((a) => (a.id === id ? { ...a, ...patch } : a)))
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...(patch.name !== undefined ? { name: patch.name } : {}),
                  ...(patch.role !== undefined ? { role: patch.role } : {}),
                  ...(patch.md !== undefined ? { md: patch.md } : {}),
                },
              }
            : n,
        ),
      )
    },
    [mutate, setNodes],
  )

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  )
  const managerName = useMemo(() => {
    if (!selected || !selected.reportsTo) return null
    return agents.find((a) => a.id === selected.reportsTo)?.name ?? null
  }, [selected, agents])

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* — the canvas — */}
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          /* the same shape while you DRAG a new connection, so the line you
             are drawing looks like the line you will get */
          connectionLineType={ConnectionLineType.SmoothStep}
          defaultEdgeOptions={{ type: 'smoothstep' }}
          onNodesChange={handleNodesChange}
          onConnect={onConnect}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onNodeContextMenu={(e, n) => {
            e.preventDefault()
            /* select as well as open: every item acts on this agent, and an
               inspector showing someone else would misreport the target */
            setSelectedId(n.id)
            setCtxMenu({ x: e.clientX, y: e.clientY, agentId: n.id })
          }}
          onPaneClick={() => {
            setSelectedId(null)
            setCtxMenu(null)
          }}
          colorMode={theme === 'dark' ? 'dark' : 'light'}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {/* — floor toolbar — */}
        <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-center gap-2 p-3">
          <button
            type="button"
            onClick={addAgent}
            className="pointer-events-auto flex cursor-pointer items-center gap-1.5 border border-hairline bg-surface px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            Add agent
          </button>
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
            {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
            {saving ? ' · saving…' : ''}
          </span>
        </div>
      </div>

      {/* — right-click menu on an agent. Same chrome as the sidebar's menu, so
           it does not read as a second system. Dismissal is deliberately wider
           than click-outside: the menu is pinned to VIEWPORT coords, so a pan or
           zoom would otherwise leave it floating over unrelated canvas. — */}
      {ctxMenu !== null && (
        <div
          role="menu"
          className="fixed z-50 min-w-[12rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setSelectedId(ctxMenu.agentId)
              setCtxMenu(null)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Edit agent…
          </button>
          {onOpenChat && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = ctxMenu.agentId
                setCtxMenu(null)
                onOpenChat(id)
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
            >
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              Open chat
            </button>
          )}
          {/* the floor keeps its top — the boss has no delete, same rule the
              inspector enforces */}
          {!agents.find((a) => a.id === ctxMenu.agentId)?.isBoss && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = ctxMenu.agentId
                setCtxMenu(null)
                removeAgent(id)
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Remove agent
            </button>
          )}
        </div>
      )}

      {/* — the agent modal: everything about one agent, in tabs.
           Replaces the 300px inspector rail that used to live here. The rail
           had to show name, role, model, skills, servers AND the brief at once
           in a narrow column, and it took 300px of canvas away for as long as
           anybody was selected. — */}
      {selected && (
        <AgentModal
          agent={selected}
          managerName={managerName}
          skillNames={skillNames}
          mcpNames={mcpNames}
          onPatch={(patch) => patchAgent(selected.id, patch)}
          onRemove={() => removeAgent(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

/** React Flow needs its provider above any hook that touches the store.
 *
 *  `onOpenChat` is optional and is provided HERE rather than passed into
 *  FloorCanvas: the desks read it out of context, so the canvas never has to
 *  carry a prop it does not use. */
export function FloorDesigner({
  floor,
  theme,
  onOpenChat,
}: {
  floor: Floor
  theme: Theme
  /** open the chat bound to this agent. Omit it — as the standalone floor tab
      does — and the desks show no chat button at all. */
  onOpenChat?: (agentId: string) => void
}) {
  return (
    <ReactFlowProvider>
      <OpenChatContext.Provider value={onOpenChat ?? null}>
        <FloorCanvas floor={floor} theme={theme} />
      </OpenChatContext.Provider>
    </ReactFlowProvider>
  )
}
