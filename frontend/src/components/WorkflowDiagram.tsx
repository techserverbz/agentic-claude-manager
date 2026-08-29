import { useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Crown, FileText, Layers, User } from 'lucide-react'
import type { DispatchEdge, Workflow, WorkflowStep } from '../lib/api'

/**
 * WorkflowDiagram — the workflow as a chart instead of a list.
 *
 * The list above it answers "what are the steps, and what does each one say".
 * This answers a different question the list genuinely cannot: **what is the
 * shape of the work** — how deep the nesting goes, which stage owns which
 * steps, and where the father sits relative to all of it. On the Feasibility
 * SOP that is the difference between reading seventeen rows and seeing that
 * twelve of them hang off one stage.
 *
 * Three things this deliberately does NOT do:
 *
 *  · It is not editable. The floor canvas is an editor because a floor IS its
 *    layout; a workflow's shape comes from its parentId tree, so dragging a box
 *    here would either be a lie or a second source of truth. Positions are
 *    computed, every time, from the tree.
 *
 *  · It does not invent a node per attachment or reference. Those belong to a
 *    step and are read in the step's own row.
 *
 *  · When a RUN is passed, the arrows come from the run's DISPATCH LOG — one
 *    recorded edge per movement of work, stamped server-side (plan item 12). So
 *    a step that messaged another step directly is drawn as exactly that, and
 *    the human who clicked dispatch on the board is drawn as the human rather
 *    than credited to the father.
 *
 *    A run whose log is empty — one started before the log existed — falls back
 *    to the old INFERRED arrows: father to every step that has a session. That
 *    reconstruction is why the log had to exist. It cannot tell a step that was
 *    dispatched, blocked, re-dispatched by a peer and finished apart from one
 *    the father drove straight through, because it only ever sees the end state.
 */

// The tree is drawn LEFT-TO-RIGHT: depth runs across, siblings stack down.
//
// Top-down is the obvious choice and it is the wrong one here. A real SOP is
// one stage with a dozen steps under it, and top-down turns that into a
// twelve-node-wide row that only fits on screen at a zoom where no label is
// readable. Left-to-right turns the same data into a column you can read at
// 1:1, and it is how everyone already reads a file tree or a table of contents.
const NODE_W = 210
const NODE_H = 62
const GAP_X = 78 // between depth levels (horizontal)
const GAP_Y = 18 // between siblings (vertical)

type StepNodeData = {
  title: string
  kind: 'step' | 'stage'
  hasBrief: boolean
  status: string | null
  live: boolean
  childCount: number
}
type StepNode = Node<StepNodeData, 'step'>

type FatherNodeData = { title: string; live: boolean }
type FatherNode = Node<FatherNodeData, 'father'>

/** The person at the keyboard. Drawn only when the log actually records them
 *  giving an order — a run the father drove alone does not grow a stray node. */
type HumanNode = Node<Record<string, never>, 'human'>

const FATHER_ID = '__father__'
const HUMAN_ID = '__human__'

/** status -> the one colour that carries meaning. Everything else stays in the
    neutral palette so that colour always means "state", never "decoration". */
const STATUS_TINT: Record<string, string> = {
  done: 'var(--color-brass)',
  'in-progress': 'var(--color-brass)',
  review: 'var(--color-brass)',
  dispatched: 'var(--color-brass)',
  blocked: '#cf6b52',
}

function StepNodeView({ data }: NodeProps<StepNode>) {
  const tint = data.status ? STATUS_TINT[data.status] : undefined
  return (
    <div
      className="border bg-surface"
      style={{
        width: NODE_W,
        borderColor: tint ?? 'var(--color-hairline)',
        borderStyle: data.kind === 'stage' ? 'dashed' : 'solid',
      }}
    >
      {/* Two kinds of incoming edge, and they mean different things, so they
          arrive on different sides: CONTAINMENT enters from the left (the stage
          this belongs to), SEQUENCE enters from the top (the step before it). */}
      <Handle
        id="nest-in"
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-brass"
      />
      <Handle
        id="seq-in"
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-brass"
      />
      <div className="flex items-center gap-2 px-2.5 py-2">
        {data.kind === 'stage' ? (
          <Layers className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate font-display text-[12px] text-parchment">
          {data.title}
        </span>
        {data.live && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#6fbf73]"
            title="session is live"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-hairline-s px-2.5 py-1.5 font-mono text-[8px] uppercase tracking-[0.16em]">
        {data.kind === 'stage' ? (
          <span className="text-sand-dim">
            stage · {data.childCount} inside
          </span>
        ) : (
          <span className={data.hasBrief ? 'text-sand-dim' : 'text-[#cf6b52]'}>
            {data.hasBrief ? 'has tutorial' : 'no tutorial'}
          </span>
        )}
        {data.status && (
          <span className="ml-auto" style={{ color: tint ?? 'var(--color-sand-dim)' }}>
            {data.status.replace('_', ' ')}
          </span>
        )}
      </div>
      <Handle
        id="nest-out"
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-brass"
      />
      <Handle
        id="seq-out"
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-brass"
      />
    </div>
  )
}

function FatherNodeView({ data }: NodeProps<FatherNode>) {
  return (
    <div className="border border-brass bg-surface" style={{ width: NODE_W }}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Crown className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-display text-[12px] text-parchment">
          {data.title}
        </span>
        {data.live && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#6fbf73]" aria-hidden="true" />
        )}
      </div>
      <div className="border-t border-hairline-s px-2.5 py-1.5 font-mono text-[8px] uppercase tracking-[0.16em] text-brass">
        father · dispatches
      </div>
      {/* Work comes BACK to the father — a step reporting done, a step saying it
          is blocked — so the root needs an incoming side of its own. Without it
          those edges would have nowhere to land and the tree would stay the
          one-directional picture the log exists to replace. */}
      <Handle
        id="father-in"
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-brass"
      />
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-brass" />
    </div>
  )
}

function HumanNodeView() {
  return (
    <div className="border border-hairline bg-surface" style={{ width: NODE_W }}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <User className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-display text-[12px] text-parchment">You</span>
      </div>
      <div className="border-t border-hairline-s px-2.5 py-1.5 font-mono text-[8px] uppercase tracking-[0.16em] text-sand-dim">
        at the keyboard
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-brass" />
    </div>
  )
}

/* module-level: a fresh object identity would remount every node each render */
const nodeTypes = { step: StepNodeView, father: FatherNodeView, human: HumanNodeView }

/**
 * Re-fit whenever the canvas changes size.
 *
 * `fitView` on its own fires once, on mount — and on mount this panel is
 * frequently still 0×0, because it lives inside a pane whose width is settled
 * by a layout pass that has not run yet. React Flow then clamps to `minZoom`
 * and the whole tree renders as unreadable specks in a corner. Opening a
 * session tab beside the panel reproduces it every time.
 *
 * So: watch the wrapper and re-fit on any resize. Cheap, and it also handles
 * the sidebar collapsing and the pane being split.
 */
function RefitOnResize({
  hostRef,
  watch,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>
  watch: unknown
}) {
  const { fitView } = useReactFlow()
  const frame = useRef(0)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const refit = () => {
      // rAF: fit AFTER the browser has finished the layout that triggered this,
      // otherwise we measure the size we are being told is changing.
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        void fitView({ padding: 0.2, duration: 0 })
      })
    }
    const ro = new ResizeObserver(refit)
    ro.observe(el)
    refit()
    return () => {
      cancelAnimationFrame(frame.current)
      ro.disconnect()
    }
  }, [fitView, hostRef, watch])

  return null
}

/** Per-step run state, when the diagram is showing a run rather than a template. */
export type RunOverlay = {
  fatherTitle: string
  fatherLive: boolean
  /** the father's session id — how an edge addressed to the father in the log
   *  finds its way back to the root node */
  fatherSessionId?: string | null
  /** stepId -> its state in the run. `sessionId` is what maps a logged edge,
   *  which addresses SESSIONS, onto the step nodes drawn here. */
  byStep: Map<
    string,
    { status: string; live: boolean; dispatched: boolean; sessionId?: string | null }
  >
  /** the recorded history, oldest first. Absent or empty falls back to the
   *  inferred arrows, so a run that predates the log still renders. */
  edges?: DispatchEdge[]
}

/** How each kind of edge is drawn, and what it is called in plain words. The
 *  raw enum is never shown: "block" is a state, "said it was blocked" is what
 *  happened. */
const EDGE_STYLE: Record<
  string,
  { label: string; stroke: string; dash?: string; returns?: boolean }
> = {
  spawn: { label: 'started', stroke: 'var(--color-brass)' },
  dispatch: { label: 'dispatched', stroke: 'var(--color-brass)', dash: '4 3' },
  message: { label: 'messaged', stroke: 'var(--color-sand-dim)', dash: '1 4' },
  report: { label: 'reported back', stroke: 'var(--color-sand-dim)', returns: true },
  block: { label: 'said it was blocked', stroke: '#cf6b52', returns: true },
  note: { label: 'left a note', stroke: 'var(--color-hairline)', dash: '1 4', returns: true },
}

const EDGE_LABEL = {
  fill: 'var(--color-sand-dim)',
  fontSize: 8,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.16em',
}

/**
 * The arrowhead is what makes a MOVEMENT read as a third kind of line.
 *
 * The other two are structure — containment says a stage owns these steps,
 * sequence says this step comes after that one — and both are facts about the
 * template that are true before anybody does anything. A logged edge is the one
 * relationship here that somebody CHOSE, at a moment, in a direction, so it is
 * the one that gets a head. It also earns its keep on the edge the whole log
 * exists for: a step -> step dispatch can run right to left across the tree, and
 * a headless line there does not say which of the two gave the order.
 *
 * Colour goes through React's `style`, not an SVG fill attribute, so the theme
 * variable resolves the same way it does on the stroke it has to match.
 */
const movementMarker = (color: string) => ({
  type: MarkerType.ArrowClosed,
  width: 12,
  height: 12,
  color,
})

/**
 * Lay the tree out, left to right.
 *
 * A tidy-tree layout computed bottom-up: a leaf claims one row, and a parent is
 * centred vertically on the block its children occupy. Bottom-up is what stops
 * sibling subtrees overlapping — the naive "y = index * height" collapses the
 * moment one sibling has children and the next does not.
 */
function layout(steps: WorkflowStep[], hasFather: boolean) {
  const children = new Map<string, WorkflowStep[]>()
  const roots: WorkflowStep[] = []
  for (const s of [...steps].sort((a, b) => a.ord - b.ord)) {
    if (s.parentId === null) roots.push(s)
    else {
      if (!children.has(s.parentId)) children.set(s.parentId, [])
      children.get(s.parentId)!.push(s)
    }
  }

  const pos = new Map<string, { x: number; y: number }>()
  let cursor = 0 // the next free row, in node-heights

  const place = (step: WorkflowStep, depth: number): { top: number; bottom: number } => {
    const kids = children.get(step.id) ?? []
    const x = depth * (NODE_W + GAP_X)
    if (kids.length === 0) {
      const y = cursor * (NODE_H + GAP_Y)
      cursor += 1
      pos.set(step.id, { x, y })
      return { top: y, bottom: y }
    }
    const spans = kids.map((k) => place(k, depth + 1))
    const top = spans[0].top
    const bottom = spans[spans.length - 1].bottom
    pos.set(step.id, { x, y: (top + bottom) / 2 })
    return { top, bottom }
  }

  // The father owns column 0, so the tree starts one column right of it.
  const baseDepth = hasFather ? 1 : 0
  for (const r of roots) place(r, baseDepth)

  const height = Math.max(cursor, 1) * (NODE_H + GAP_Y)
  return { pos, children, roots, height }
}

export function WorkflowDiagram({
  workflow,
  run = null,
  className = '',
}: {
  workflow: Workflow
  run?: RunOverlay | null
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const { nodes, edges } = useMemo(() => {
    const { pos, children, roots, height } = layout(workflow.steps, run !== null)

    const stepNodes: (StepNode | FatherNode | HumanNode)[] = workflow.steps.map((s) => ({
      id: s.id,
      type: 'step' as const,
      position: pos.get(s.id) ?? { x: 0, y: 0 },
      draggable: false,
      data: {
        title: s.title,
        kind: s.kind,
        hasBrief: s.brief.trim() !== '',
        status: run?.byStep.get(s.id)?.status ?? null,
        live: run?.byStep.get(s.id)?.live ?? false,
        childCount: children.get(s.id)?.length ?? 0,
      },
    }))

    // TWO kinds of edge, because the data has two kinds of relationship and
    // collapsing them into one is what made the first version of this diagram
    // wrong. A stage does not have twelve parallel children; it CONTAINS a
    // sequence. Drawing a fan said "do these twelve in any order", which is the
    // opposite of what the SOP says.
    //
    //   containment (faint, into the left edge) — the stage owns this run of
    //     steps, drawn once, to the FIRST step only.
    //   sequence (brass, top to bottom) — this step comes after that one. It is
    //     `dependsOn`, so the picture and the dispatch order are the same fact.
    const byId = new Map(workflow.steps.map((s) => [s.id, s]))
    const firstChildOf = new Map<string, string>()
    for (const s of [...workflow.steps].sort((a, b) => a.ord - b.ord)) {
      if (s.parentId !== null && !firstChildOf.has(s.parentId)) {
        firstChildOf.set(s.parentId, s.id)
      }
    }

    const nestEdges: Edge[] = [...firstChildOf.entries()].map(([parentId, childId]) => ({
      id: `nest:${parentId}->${childId}`,
      source: parentId,
      sourceHandle: 'nest-out',
      target: childId,
      targetHandle: 'nest-in',
      style: { stroke: 'var(--color-hairline)', strokeWidth: 1.5 },
    }))

    // Sequence edges come straight off dependsOn — no re-derivation, so the
    // arrows can never disagree with what a run will actually wait for.
    const seqEdges: Edge[] = workflow.steps.flatMap((s) =>
      s.dependsOn
        .filter((d) => byId.has(d))
        .map((d) => ({
          id: `seq:${d}->${s.id}`,
          source: d,
          sourceHandle: 'seq-out',
          target: s.id,
          targetHandle: 'seq-in',
          style: { stroke: 'var(--color-brass)', strokeWidth: 1.5 },
        })),
    )

    if (run === null) return { nodes: stepNodes, edges: [...nestEdges, ...seqEdges] }

    const fatherY = Math.max(0, height / 2 - NODE_H / 2)
    const father: FatherNode = {
      id: FATHER_ID,
      type: 'father' as const,
      // column 0, centred on the whole tree it dispatches into
      position: { x: 0, y: fatherY },
      draggable: false,
      data: { title: run.fatherTitle, live: run.fatherLive },
    }

    // The log addresses SESSIONS; the canvas draws STEPS. This is the map
    // between them, and it is why the overlay carries session ids at all.
    const nodeForSession = new Map<string, string>()
    if (run.fatherSessionId) nodeForSession.set(run.fatherSessionId, FATHER_ID)
    for (const [stepId, state] of run.byStep) {
      if (state.sessionId) nodeForSession.set(state.sessionId, stepId)
    }

    const logged = run.edges ?? []

    // ONE arrow per (kind, from, to), carrying a count. Two dispatches of the
    // same step are two events but one relationship — the event list beside this
    // tree is where their ORDER is read, and React Flow drops duplicate edge ids
    // silently, so merging is the honest version of what would happen anyway.
    const merged = new Map<string, { kind: string; source: string; target: string; n: number }>()
    let humanActed = false
    for (const e of logged) {
      // A broadcast has no single target, so it is an event and not an arrow.
      if (!EDGE_STYLE[e.kind]) continue
      const source = e.fromSessionId === null ? HUMAN_ID : nodeForSession.get(e.fromSessionId)
      const target = e.toSessionId === null ? undefined : nodeForSession.get(e.toSessionId)
      // A session with no node — a step dropped from the template since, or an
      // edge whose other end never got one — is left to the event list rather
      // than drawn to nowhere. A self-addressed edge (the father noting for the
      // run) is not a movement between two parties, so it is not an arrow.
      if (!source || !target || source === target) continue
      if (source === HUMAN_ID) humanActed = true
      const key = `${e.kind}:${source}->${target}`
      const hit = merged.get(key)
      if (hit) hit.n += 1
      else merged.set(key, { kind: e.kind, source, target, n: 1 })
    }

    const loggedEdges: Edge[] = [...merged.entries()].map(([key, m]) => {
      const style = EDGE_STYLE[m.kind]
      return {
        id: key,
        source: m.source,
        target: m.target,
        // An answer must not look like another order: returns leave from the
        // bottom of the step and arrive on the father's own left-hand side,
        // while orders run left to right along the nesting handles.
        sourceHandle:
          m.source === FATHER_ID || m.source === HUMAN_ID
            ? undefined
            : style.returns
              ? 'seq-out'
              : 'nest-out',
        targetHandle: m.target === FATHER_ID ? 'father-in' : 'nest-in',
        animated: m.kind === 'dispatch' && run.byStep.get(m.target)?.status === 'in-progress',
        label: m.n > 1 ? `${style.label} ×${m.n}` : style.label,
        labelStyle: EDGE_LABEL,
        labelBgStyle: { fill: 'var(--color-midnight)' },
        markerEnd: movementMarker(style.stroke),
        // above the structural lines: when a dispatch runs back along a stage's
        // own containment edge, the one that says what HAPPENED is the one to
        // keep on top.
        zIndex: 1,
        style: { stroke: style.stroke, strokeWidth: 1.5, strokeDasharray: style.dash },
      }
    })

    // THE FALLBACK, and only that: a run with no log is one started before the
    // log existed, and inferring father -> every step with a session is the best
    // that can be reconstructed from end state alone. Every arrow it draws
    // starts at the father, because that is all inference can ever say.
    const inferredEdges: Edge[] =
      logged.length > 0
        ? []
        : workflow.steps
            .filter((s) => run.byStep.get(s.id)?.dispatched === true)
            .map((s) => ({
              id: `dispatch:${s.id}`,
              source: FATHER_ID,
              target: s.id,
              targetHandle: 'nest-in',
              animated: run.byStep.get(s.id)?.status === 'in-progress',
              label: 'dispatched',
              labelStyle: EDGE_LABEL,
              labelBgStyle: { fill: 'var(--color-midnight)' },
              markerEnd: movementMarker('var(--color-brass)'),
              zIndex: 1,
              style: { stroke: 'var(--color-brass)', strokeWidth: 1.5, strokeDasharray: '4 3' },
            }))

    // A root step with nothing above it would otherwise float unattached once
    // the father exists, which reads as "not part of this run".
    const attached = new Set([...merged.values()].map((m) => m.target))
    const rootEdges: Edge[] = roots
      .filter((r) =>
        logged.length > 0 ? !attached.has(r.id) : run.byStep.get(r.id)?.dispatched !== true,
      )
      .map((r) => ({
        id: `owns:${r.id}`,
        source: FATHER_ID,
        target: r.id,
        targetHandle: 'nest-in',
        style: { stroke: 'var(--color-hairline)', strokeWidth: 1, strokeDasharray: '2 4' },
      }))

    const human: HumanNode = {
      id: HUMAN_ID,
      type: 'human' as const,
      // one column LEFT of the father: the orders you gave yourself start
      // outside the run, and crediting them to the father would be the exact
      // fiction this log was built to end.
      position: { x: -(NODE_W + GAP_X), y: fatherY },
      draggable: false,
      data: {},
    }

    return {
      nodes: [...(humanActed ? [human] : []), father, ...stepNodes],
      edges: [...nestEdges, ...seqEdges, ...loggedEdges, ...inferredEdges, ...rootEdges],
    }
  }, [workflow, run])

  if (workflow.steps.length === 0) {
    return (
      <p className={`px-5 py-5 font-display text-[13px] italic text-sand-dim ${className}`}>
        Nothing to draw — this workflow has no steps yet.
      </p>
    )
  }

  return (
    <div ref={hostRef} className={className}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <RefitOnResize hostRef={hostRef} watch={workflow.id} />
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--color-hairline)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
