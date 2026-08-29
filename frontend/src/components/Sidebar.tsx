import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Variants } from 'framer-motion'
import {
  Check,
  Copy,
  Eye,
  FolderOpen,
  FolderGit2,
  FolderInput,
  FolderKanban,
  FolderSearch,
  Link2,
  Hash,
  Info,
  Laptop,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PenTool,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  Plug,
  Sparkles,
  Trash2,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { ScopePicker, type Scope } from './ScopePicker'
import { SidebarRow } from './SidebarRow'
import { ChatContentModal } from './ChatContentModal'
import { FolderPicker } from './FolderPicker'
import { CanvasFilesPanel } from './CanvasFilesPanel'
import { api, relativeTime } from '../lib/api'
import type { CanvasFile, ChatGroup, ComputerSession, Floor, GroupChat, PortInfo, Project, UpdateCheck } from '../lib/api'

/** "…\Desktop\trying2" — last two path segments, for compact cwd display */
function shortPath(p: string): string {
  if (!p) return ''
  const sep = p.includes('\\') ? '\\' : '/'
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return p
  return '…' + sep + parts.slice(-2).join(sep)
}

/** last path segment (the folder's own name) for a directory header */
function baseName(p: string): string {
  if (!p) return ''
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/** loose path equality — ignores trailing separators, slash style, and case */
function samePathLoose(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

interface DirGroup {
  key: string
  cwd: string
  folder: string
  sessions: ComputerSession[]
  lastActive: string
}

/** group the global session index by working directory, newest folder first */
function groupByDir(sessions: ComputerSession[] | null): DirGroup[] {
  const map = new Map<string, DirGroup>()
  for (const s of sessions ?? []) {
    const key = s.cwd || s.folder
    let g = map.get(key)
    if (g === undefined) {
      g = { key, cwd: s.cwd, folder: s.folder, sessions: [], lastActive: '' }
      map.set(key, g)
    }
    g.sessions.push(s)
    if (s.lastActive > g.lastActive) g.lastActive = s.lastActive
  }
  return [...map.values()].sort((a, b) =>
    a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0,
  )
}
import type { AppView, DefaultView } from '../App'

/**
 * Sidebar — the observatory's index cabinet.
 * Surface panel, hairline right border, square corners throughout.
 * Projects render as slim SidebarRow lines (selected = brass accent);
 * Chats lists the selected project's sessions, newest first. Empty
 * states stand in until rows exist.
 */

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.2, 0.6, 0.2, 1] } },
}

/**
 * The ordinary-projects half of the group list.
 *
 * Workflow-projects are a SEPARATE list: the chats a run spawns (the father and
 * one per step) belong to them, and those terminals are private to the Project
 * Workflows view. Letting one into the Projects list would put a run's plumbing
 * next to the user's real work and, worse, hand it a workspace tab.
 *
 * The test is "not a workflow" rather than "is a project" on purpose: groups
 * written before the kind split carry no kind at all, and a stale response held
 * from a server that predates it would otherwise vanish every project on screen.
 * Defaulting the unknown to 'project' is the same call the server's hydrate
 * makes, and it fails in the harmless direction.
 */
const isProjectGroup = (g: ChatGroup) => g.kind !== 'workflow'

export function Sidebar({
  projects,
  selectedProjectId,
  selectedSessionId,
  activeSessions,
  collapsed,
  onToggleCollapse,
  onSelectProject,
  onSelectSession,
  onOpenComputerSession,
  groups,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onShowGroup,
  onEditGroup,
  onMoveChat,
  onMoveChatToProject,
  onReorderGroups,
  onAddChatToGroup,
  onRemoveChatFromGroup,
  onOpenGroupChat,
  onChangeGroupChatSession,
  onTerminateChat,
  onNewChatInGroup,
  onNewProject,
  onNewSession,
  onRenameProject,
  onRenameSession,
  onSessionsChanged,
  onTerminateSession,
  onEditProject,
  onChangeSessionId,
  onRevealDir,
  onDeleteSession,
  onDeleteProject,
  defaultView,
  onDefaultViewChange,
  canvasFile,
  onOpenCanvas,
  appView,
  onSetAppView,
  floors,
  selFloorId,
  selAgentId,
  onSelectAgent,
  onRenameFloor,
  onAttachFloorScope,
  onAddFloor,
  onOpenFloor,
  onDeleteFloor,
  workflowProjects,
  selectedWorkflowProjectId,
  onSelectWorkflowProject,
  onNewWorkflowProject,
  onRenameWorkflowProject,
  onDeleteWorkflowProject,
}: {
  projects: Project[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  /** session ids with a live shell — render a green blinking marker */
  activeSessions: string[]
  /** folded away to a thin rail to give the floor more room */
  collapsed: boolean
  onToggleCollapse: () => void
  onSelectProject: (id: string) => void
  onSelectSession: (projectId: string, sessionId: string) => void
  /** open a session from the global "This computer" list (loose-aware); pass a
      view to force the pane onto it (right-click → "Chat view") */
  onOpenComputerSession: (session: ComputerSession, view?: 'chat' | 'terminals') => void
  /** Projects (dir-less chat groups) and their mutations */
  groups: ChatGroup[]
  /** create a new project; if a chat is given, the new project starts with it */
  onNewGroup: (chat?: { sessionId: string; cwd: string }) => void
  onRenameGroup: (id: string, name: string) => void
  onDeleteGroup: (id: string) => void
  /** right-click "Project details" — open the read-only details modal */
  onShowGroup: (id: string) => void
  /** right-click "Edit project…" — open the project edit modal */
  onEditGroup: (id: string) => void
  /** "Change directory" — move a chat's .jsonl to a new working dir + repoint it.
      groupId is null for loose (Recent/Directories) chats. Throws on failure. */
  onMoveChat: (
    groupId: string | null,
    sessionId: string,
    fromCwd: string,
    toCwd: string,
  ) => Promise<void>
  /** drag-and-drop a chat from one project to another (move across groups) */
  onMoveChatToProject: (
    fromGroupId: string,
    toGroupId: string,
    sessionId: string,
    cwd: string,
  ) => void
  /** drag-reorder projects (move up/down) — the new full id order */
  onReorderGroups: (orderedIds: string[]) => void
  onAddChatToGroup: (groupId: string, sessionId: string, cwd: string) => void
  onRemoveChatFromGroup: (groupId: string, sessionId: string) => void
  onOpenGroupChat: (chat: GroupChat, view?: 'chat' | 'terminals') => void
  /** open the change-session-id modal for a project chat (swaps the group member) */
  onChangeGroupChatSession: (groupId: string, cwd: string, sessionId: string) => void
  /** terminate a chat's live shell by its cwd (Project / Directory chats) */
  onTerminateChat: (cwd: string, sessionId: string) => void
  /** "Add chat → New chat": fresh session in a picked directory, auto-joins the
   *  group. Resolves false when the directory can't be opened. */
  onNewChatInGroup: (groupId: string, cwd: string) => Promise<boolean>
  onNewProject: () => void
  onNewSession: () => void
  /** right-click rename — project display name / session custom title */
  onRenameProject: (id: string, name: string) => void
  onRenameSession: (projectId: string, sessionId: string, title: string) => void
  /** nudge the parent to refetch the session catalog after a by-id rename, so
      open-tab titles pick up the new name without a page reload */
  onSessionsChanged?: () => void
  /** right-click "terminate terminal" — kill that session's live shell */
  onTerminateSession: (projectId: string, sessionId: string) => void
  /** right-click "edit project…" — open the full edit modal */
  onEditProject: (id: string) => void
  /** right-click "change session id…" — open the modal to load a session by id */
  onChangeSessionId: (projectId: string, sessionId: string) => void
  /** right-click "open project directory" — reveal the project's working folder */
  onRevealDir: (id: string) => void
  /** right-click "delete chat" — soft-delete the session */
  onDeleteSession: (projectId: string, sessionId: string) => void
  /** right-click "delete project" — unregister it (files left on disk) */
  onDeleteProject: (id: string) => void
  /** which view selecting a session lands on (the persisted preference) */
  defaultView: DefaultView
  onDefaultViewChange: (v: DefaultView) => void
  /** the canvas file currently open in the main area (null = not in canvas view) */
  canvasFile: string | null
  /** open an Excalidraw canvas file in the main area */
  onOpenCanvas: (name: string) => void
  /** the top-level MAIN-PANE view. Unlike the four tabs above, these do not
      change what the sidebar lists — they swap what the workspace renders. */
  appView: AppView
  onSetAppView: (v: AppView) => void
  /** org charts of agent roles — listed here in place of the projects */
  floors: Floor[]
  /* the agent the Agent WF view is showing. The sidebar LISTS the agents, so
     it needs to mark the current one; App owns the value. */
  selFloorId: string | null
  selAgentId: string | null
  onSelectAgent: (floorId: string, agentId: string, openChat?: boolean) => void
  /** rename a floor — the name is the only freely editable thing about one */
  onRenameFloor: (floorId: string, name: string) => void
  /** attach a floor to a CRM scope — write-once, enforced server-side */
  onAttachFloorScope: (
    floorId: string,
    scope: { targetType: string; targetId: string | null },
  ) => Promise<void>
  onAddFloor: (kind: 'agents' | 'workflow') => void
  onOpenFloor: (floor: Floor) => void
  onDeleteFloor: (id: string) => void
  /** the groups with kind 'workflow' — listed here in place of the projects
      while Project Workflows is the view, exactly as floors are for the floor.
      Already filtered by the parent; this component does not re-filter it. */
  workflowProjects: ChatGroup[]
  selectedWorkflowProjectId: string | null
  /** null deselects — picking the selected one again clears the right pane */
  onSelectWorkflowProject: (id: string | null) => void
  onNewWorkflowProject: () => void
  onRenameWorkflowProject: (id: string, name: string) => void
  onDeleteWorkflowProject: (id: string) => void
}) {
  const activeSet = new Set(activeSessions)
  // hidden "loose" projects never appear in the sidebar Projects list
  const visibleProjects = projects.filter((p) => !p.ephemeral)
  /* every LISTING of groups in this file reads this, never `groups` — see
     isProjectGroup. Lookups by id stay on the full array: they resolve a row
     the user already picked, so narrowing them would only make them fail. */
  const projectGroups = groups.filter(isProjectGroup)

  /* — three tabs over the session index —
       Projects: registered projects (directory-derived chats)
       Directories: every ~/.claude/projects folder, grouped + expandable
       Recent: a flat, newest-first list of every session on the machine
     The global index (Directories + Recent) is lazy-loaded on first open. */
  const [tab, setTab] = useState<'projects' | 'directories' | 'recent' | 'canvas'>('projects')
  /* which agent-workflow floors are disclosed. Expanded ids, the same way
     expandedGroups works, so the two lists behave identically. */
  const [expandedFloors, setExpandedFloors] = useState<Set<string>>(() => new Set())
  /* The floor waiting to be attached, plus the scope list the picker needs.
     Fetched lazily — 531 projects is not worth loading until someone asks. */
  const [attachFloorId, setAttachFloorId] = useState<string | null>(null)
  const [crmScopes, setCrmScopes] = useState<Scope[] | null>(null)
  /* why the last attach was refused — the dialog stays open showing it */
  const [attachError, setAttachError] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  useEffect(() => {
    if (attachFloorId === null || crmScopes !== null) return
    let cancelled = false
    fetch('/api/crm/scopes')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!cancelled) setCrmScopes(Array.isArray(d.scopes) ? d.scopes : [])
      })
      .catch(() => {
        if (!cancelled) setCrmScopes([])
      })
    return () => {
      cancelled = true
    }
  }, [attachFloorId, crmScopes])
  const [canvasFiles, setCanvasFiles] = useState<CanvasFile[] | null>(null)
  const [canvasRunning, setCanvasRunning] = useState(true)
  const [loadingCanvas, setLoadingCanvas] = useState(false)
  const [startingCanvas, setStartingCanvas] = useState(false)
  useEffect(() => {
    if (tab !== 'canvas' || canvasFiles !== null || loadingCanvas) return
    setLoadingCanvas(true)
    api
      .getCanvasFiles()
      .then((r) => {
        setCanvasFiles(r.files)
        setCanvasRunning(r.running)
      })
      .catch(() => {
        setCanvasFiles([])
        setCanvasRunning(false)
      })
      .finally(() => setLoadingCanvas(false))
  }, [tab, canvasFiles, loadingCanvas])
  const handleStartCanvas = async () => {
    setStartingCanvas(true)
    try {
      await api.startCanvas()
    } catch {
      /* surfaced by the reload below */
    }
    // give Vite + the API a few seconds to boot, then reload the list
    window.setTimeout(() => {
      setStartingCanvas(false)
      setCanvasFiles(null)
    }, 7000)
  }
  const [computerSessions, setComputerSessions] = useState<ComputerSession[] | null>(null)
  const [loadingComputer, setLoadingComputer] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  /* drag a project chat onto another project to move it there */
  const dragChatRef = useRef<{ groupId: string; sessionId: string; cwd: string } | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  /* drag a project header up/down to reorder projects */
  const dragGroupRef = useRef<string | null>(null)
  const reorderGroup = (fromId: string, toId: string) => {
    if (fromId === toId) return
    /* deliberately the FULL array, not projectGroups: onReorderGroups persists
       the order it is handed, so sending only the project ids would drop every
       workflow-project off the store. Both ends of a drag are project rows, so
       indexing into the full list still lands the row where it was dropped. */
    const ids = groups.map((g) => g.id)
    const fi = ids.indexOf(fromId)
    const ti = ids.indexOf(toId)
    if (fi < 0 || ti < 0) return
    ids.splice(fi, 1)
    ids.splice(ti, 0, fromId)
    onReorderGroups(ids)
  }
  // Projects (groups) resolve their member titles/times from the global index.
  const needsGlobalIndex = tab === 'directories' || tab === 'recent' || groups.length > 0
  useEffect(() => {
    if (!needsGlobalIndex || computerSessions !== null || loadingComputer) return
    setLoadingComputer(true)
    api
      .getAllSessions()
      .then((s) => setComputerSessions(s))
      .catch(() => setComputerSessions([]))
      .finally(() => setLoadingComputer(false))
  }, [needsGlobalIndex, computerSessions, loadingComputer])
  /* the global Claude working dir (the user's home) — pinned to the top of the
     Directories list since it's the default place Claude runs */
  const [homeDir, setHomeDir] = useState('')
  const dirGroups = (() => {
    const gs = groupByDir(computerSessions)
    const i = homeDir ? gs.findIndex((g) => samePathLoose(g.cwd, homeDir)) : -1
    if (i > 0) {
      const [home] = gs.splice(i, 1)
      gs.unshift(home)
    }
    return gs
  })()
  const sessionById = new Map((computerSessions ?? []).map((s) => [s.sessionId, s]))

  /* — per-tab search: name/path filters instantly (client-side); CONTENT matches
     come from the server, which reads the jsonl. The content search is debounced
     and server-cached, scoped to the project's chats on the Projects tab and to
     every session on Directories / Recent. The query clears on tab switch. — */
  const [query, setQuery] = useState('')
  const [contentHits, setContentHits] = useState<Map<string, string>>(new Map())
  const [contentSearching, setContentSearching] = useState(false)
  useEffect(() => {
    setQuery('')
  }, [tab])
  useEffect(() => {
    const term = query.trim()
    if (term.length < 2 || tab === 'canvas') {
      setContentHits(new Map())
      setContentSearching(false)
      return
    }
    setContentSearching(true)
    const handle = window.setTimeout(() => {
      /* scoped to the ordinary projects only. Searching a workflow-project's
         chats would put a run's private terminals into the Projects results by
         way of a content hit, which is the back door the kind split closes. */
      const ids =
        tab === 'projects'
          ? Array.from(
              new Set(
                groups.filter(isProjectGroup).flatMap((g) => g.chats.map((c) => c.sessionId)),
              ),
            )
          : undefined
      api
        .searchContent(term, ids)
        .then((matches) => setContentHits(new Map(matches.map((m) => [m.sessionId, m.snippet]))))
        .catch(() => setContentHits(new Map()))
        .finally(() => setContentSearching(false))
    }, 350)
    return () => window.clearTimeout(handle)
  }, [query, tab, groups])
  const q = query.trim().toLowerCase()
  /* substring test for name/path fields (only called when q is non-empty) */
  const inc = (s: string | undefined | null) => (s ?? '').toLowerCase().includes(q)

  /* — "Add chat" modal: attach an existing chat or start a new one in a group — */
  const [addChatFor, setAddChatFor] = useState<string | null>(null)
  const [addMode, setAddMode] = useState<'existing' | 'new' | 'byid'>('existing')
  const [addQuery, setAddQuery] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  /* content matches for the Add-chat "existing chat" search (reads the jsonl) */
  const [addContentHits, setAddContentHits] = useState<Set<string>>(new Set())
  const [addSearching, setAddSearching] = useState(false)
  /* right-click "View" → read-only transcript quick-look modal */
  const [viewContentFor, setViewContentFor] = useState<{
    sessionId: string
    cwd: string
    title: string
  } | null>(null)
  /* right-click "Change directory" → move a chat's .jsonl to a new working dir */
  const [moveDirFor, setMoveDirFor] = useState<{
    sessionId: string
    cwd: string
    groupId: string | null
    title: string
  } | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const [moveError, setMoveError] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [movePickerOpen, setMovePickerOpen] = useState(false)
  useEffect(() => {
    if (moveDirFor === null) {
      setMovePickerOpen(false)
      return
    }
    setMoveTo('')
    setMoveError(null)
    setMoving(false)
    // ensure the existing-directory list is loaded for the picker
    if (computerSessions === null) api.getAllSessions().then(setComputerSessions).catch(() => {})
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoveDirFor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveDirFor, computerSessions])
  const submitMove = async (dir: string) => {
    if (moveDirFor === null) return
    const to = dir.trim()
    if (to === '') {
      setMoveError('Enter a target directory.')
      return
    }
    setMoveError(null)
    setMoving(true)
    try {
      await onMoveChat(moveDirFor.groupId, moveDirFor.sessionId, moveDirFor.cwd, to)
      setComputerSessions(null) // re-scan so the new location shows
      setMoveDirFor(null)
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : 'Could not move the chat.')
    } finally {
      setMoving(false)
    }
  }
  // "By ID" mode: add a chat by pasting its session id + the Claude projects dir
  const [addSessionId, setAddSessionId] = useState('')
  const [addClaudeDir, setAddClaudeDir] = useState('')
  const [defaultProjectsDir, setDefaultProjectsDir] = useState('')
  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        const base = cfg.globalClaudeDir.replace(/[\\/]+$/, '')
        const sep = base.includes('\\') ? '\\' : '/'
        setDefaultProjectsDir(`${base}${sep}projects`)
        setHomeDir(cfg.home || '')
      })
      .catch(() => {})
  }, [])
  /* prefill the directory field with the global projects dir once known */
  useEffect(() => {
    if (addChatFor !== null && addClaudeDir === '' && defaultProjectsDir !== '') {
      setAddClaudeDir(defaultProjectsDir)
    }
  }, [addChatFor, defaultProjectsDir, addClaudeDir])
  const addChatGroup = addChatFor !== null ? groups.find((g) => g.id === addChatFor) ?? null : null
  // open a fresh session in `dir` and join it; keep the modal up on failure
  const startNewChatInDir = async (dir: string) => {
    if (addChatGroup === null) return
    setAddError(null)
    const ok = await onNewChatInGroup(addChatGroup.id, dir)
    if (ok) setAddChatFor(null)
    else setAddError(`Could not open that directory: ${dir}`)
  }
  // resolve a session by id under the chosen Claude projects dir, then join it
  const addBySessionId = async () => {
    if (addChatGroup === null) return
    const sid = addSessionId.trim()
    if (sid === '') {
      setAddError('Enter a session id.')
      return
    }
    setAddError(null)
    try {
      const session = await api.resolveSession(sid, addClaudeDir.trim() || undefined)
      if (!session.cwd) {
        setAddError('Found the session, but could not recover its directory from the transcript.')
        return
      }
      onAddChatToGroup(addChatGroup.id, session.sessionId, session.cwd)
      setAddChatFor(null)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not find that session.')
    }
  }
  useEffect(() => {
    if (addChatFor === null) return
    setAddError(null)
    setAddSessionId('')
    // refetch the machine-wide index so just-created chats show in the picker
    api.getAllSessions().then(setComputerSessions).catch(() => {})
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddChatFor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addChatFor])
  // the group was deleted while its Add-chat modal was open → close it
  useEffect(() => {
    if (addChatFor !== null && addChatGroup === null) setAddChatFor(null)
  }, [addChatFor, addChatGroup])
  /* Add-chat "existing chat" search ALSO matches transcript content (server reads
     the jsonl). Debounced, min 2 chars, scoped to every session on the machine. */
  useEffect(() => {
    if (addChatFor === null || addMode !== 'existing') {
      setAddContentHits(new Set())
      setAddSearching(false)
      return
    }
    const term = addQuery.trim()
    if (term.length < 2) {
      setAddContentHits(new Set())
      setAddSearching(false)
      return
    }
    setAddSearching(true)
    const handle = window.setTimeout(() => {
      api
        .searchContent(term)
        .then((matches) => setAddContentHits(new Set(matches.map((m) => m.sessionId))))
        .catch(() => setAddContentHits(new Set()))
        .finally(() => setAddSearching(false))
    }, 350)
    return () => window.clearTimeout(handle)
  }, [addChatFor, addMode, addQuery])

  /* — project expand/collapse (independent of selection) — */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  /* expand a project when it BECOMES selected (deep link / first open); a manual
     collapse afterwards sticks because this only fires on a selection change */
  useEffect(() => {
    if (selectedProjectId === null) return
    setExpandedIds((prev) => (prev.has(selectedProjectId) ? prev : new Set(prev).add(selectedProjectId)))
  }, [selectedProjectId])
  const toggleProject = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    onSelectProject(id)
  }

  /* — stable per-project session order + drag-to-reorder —
     the server lists sessions newest-active first, so a chat jumps to the top
     whenever it's used; we pin a USER order instead (persisted), so positions
     stick and can be dragged. New sessions go to the top; gone ones are pruned. */
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem('cos-session-order')
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    localStorage.setItem('cos-session-order', JSON.stringify(sessionOrder))
  }, [sessionOrder])
  useEffect(() => {
    setSessionOrder((prev) => {
      let changed = false
      const next: Record<string, string[]> = { ...prev }
      for (const p of projects) {
        const ids = (p.sessions ?? []).map((s) => s.id)
        const present = new Set(ids)
        const kept = (prev[p.id] || []).filter((id) => present.has(id)) // prune gone
        const keptSet = new Set(kept)
        const fresh = ids.filter((id) => !keptSet.has(id)) // new (server = newest first)
        const merged = [...fresh, ...kept]
        const old = prev[p.id] || []
        if (merged.length !== old.length || merged.some((id, i) => id !== old[i])) {
          next[p.id] = merged
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [projects])
  type SessionRow = Project['sessions'][number]
  const orderedSessions = (p: Project): SessionRow[] => {
    const sessions = p.sessions ?? []
    const order = sessionOrder[p.id]
    if (!order || order.length === 0) return sessions
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const ordered = order
      .map((id) => byId.get(id))
      .filter((s): s is SessionRow => s !== undefined)
    const known = new Set(order)
    const rest = sessions.filter((s) => !known.has(s.id))
    return [...ordered, ...rest]
  }
  /* ref (not state) for the in-flight drag — updates synchronously so the
     dragover/drop handlers see it without waiting for a re-render */
  const dragSessionRef = useRef<{ projectId: string; id: string } | null>(null)
  const [dragOverSession, setDragOverSession] = useState<string | null>(null)
  const reorderSession = (projectId: string, fromId: string, toId: string) => {
    if (fromId === toId) return
    setSessionOrder((prev) => {
      const cur = prev[projectId] || []
      const from = cur.indexOf(fromId)
      const to = cur.indexOf(toId)
      if (from === -1 || to === -1) return prev
      const next = [...cur]
      next.splice(from, 1)
      next.splice(to, 0, fromId)
      return { ...prev, [projectId]: next }
    })
  }

  /* — stable per-project (group) chat order + drag-to-reorder —
     same machinery as sessionOrder above, but keyed by groupId over a group's
     member chats: a USER order (persisted), new chats to the top, gone ones
     pruned. Lets a chat be dragged up/down WITHIN its project; dragging onto a
     DIFFERENT project falls through to the group-level cross-project move. */
  const [groupChatOrder, setGroupChatOrder] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem('cos-group-chat-order')
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    localStorage.setItem('cos-group-chat-order', JSON.stringify(groupChatOrder))
  }, [groupChatOrder])
  useEffect(() => {
    setGroupChatOrder((prev) => {
      let changed = false
      const next: Record<string, string[]> = { ...prev }
      for (const g of groups) {
        const ids = (g.chats ?? []).map((c) => c.sessionId)
        const present = new Set(ids)
        const kept = (prev[g.id] || []).filter((id) => present.has(id)) // prune gone
        const keptSet = new Set(kept)
        const fresh = ids.filter((id) => !keptSet.has(id)) // new chats first
        const merged = [...fresh, ...kept]
        const old = prev[g.id] || []
        if (merged.length !== old.length || merged.some((id, i) => id !== old[i])) {
          next[g.id] = merged
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [groups])
  const orderedChats = (g: ChatGroup): GroupChat[] => {
    const chats = g.chats ?? []
    const order = groupChatOrder[g.id]
    if (!order || order.length === 0) return chats
    const byId = new Map(chats.map((c) => [c.sessionId, c]))
    const ordered = order
      .map((id) => byId.get(id))
      .filter((c): c is GroupChat => c !== undefined)
    const known = new Set(order)
    const rest = chats.filter((c) => !known.has(c.sessionId))
    return [...ordered, ...rest]
  }
  /* the chat currently hovered as a within-project reorder drop target */
  const [dragOverChatId, setDragOverChatId] = useState<string | null>(null)
  const reorderGroupChat = (groupId: string, fromId: string, toId: string) => {
    if (fromId === toId) return
    setGroupChatOrder((prev) => {
      const cur = prev[groupId] || []
      const from = cur.indexOf(fromId)
      const to = cur.indexOf(toId)
      if (from === -1 || to === -1) return prev
      const next = [...cur]
      next.splice(from, 1)
      next.splice(to, 0, fromId)
      return { ...prev, [groupId]: next }
    })
  }

  /* — right-click context menu + inline rename — */
  type MenuTarget =
    | { kind: 'project'; projectId: string; current: string }
    | { kind: 'session'; projectId: string; sessionId: string; current: string }
    | { kind: 'group'; groupId: string; current: string }
    | { kind: 'group-chat'; groupId: string; sessionId: string; cwd: string; current: string }
    | { kind: 'add'; sessionId: string; cwd: string; current: string }
    | { kind: 'floor'; floorId: string; current: string }
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const [editing, setEditing] = useState<MenuTarget | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const openMenu = (e: ReactMouseEvent, target: MenuTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }
  const startRename = (target: MenuTarget) => {
    setMenu(null)
    setEditing(target)
    setEditValue(target.current)
  }
  /* rename a Project group chat — the title is keyed by sessionId, so no project
     is needed; reflect it optimistically in the global index the group reads. */
  const renameGroupChat = (sessionId: string, title: string) => {
    const t = title.trim()
    if (t !== '') {
      setComputerSessions((prev) =>
        prev === null ? prev : prev.map((s) => (s.sessionId === sessionId ? { ...s, summary: t } : s)),
      )
    }
    void api
      .renameSessionById(sessionId, t)
      .then(() => {
        /* the optimistic patch above only hits sessions ALREADY in the index; a
           brand-new chat isn't there yet, so re-scan the global index so its new
           title shows without a page reload. Also nudge the catalog so any open
           tab for this chat refreshes its title. */
        api.getAllSessions().then(setComputerSessions).catch(() => {})
        onSessionsChanged?.()
      })
      .catch(() => {})
  }
  const commitRename = () => {
    if (editing === null) return
    const value = editValue.trim()
    if (editing.kind === 'project') {
      if (value !== '' && value !== editing.current) onRenameProject(editing.projectId, value)
    } else if (editing.kind === 'group') {
      if (value !== '' && value !== editing.current) onRenameGroup(editing.groupId, value)
    } else if (editing.kind === 'group-chat') {
      if (value !== editing.current) renameGroupChat(editing.sessionId, value)
    } else if (editing.kind === 'floor') {
      /* A floor with no name is unfindable in the sidebar, so an emptied field
         is treated as a cancel — the same rule 'project' and 'group' follow. */
      if (value !== '' && value !== editing.current) onRenameFloor(editing.floorId, value)
    } else if (editing.kind === 'session') {
      /* empty clears the custom title (reverts to the derived summary) */
      if (value !== editing.current) onRenameSession(editing.projectId, editing.sessionId, value)
    }
    setEditing(null)
  }
  const isEditing = (t: MenuTarget): boolean => {
    if (editing === null || editing.kind !== t.kind) return false
    if (editing.kind === 'project' && t.kind === 'project') return editing.projectId === t.projectId
    if (editing.kind === 'group' && t.kind === 'group') return editing.groupId === t.groupId
    if (editing.kind === 'group-chat' && t.kind === 'group-chat')
      return editing.sessionId === t.sessionId
    if (editing.kind === 'session' && t.kind === 'session') return editing.sessionId === t.sessionId
    if (editing.kind === 'floor' && t.kind === 'floor') return editing.floorId === t.floorId
    return false
  }
  useEffect(() => {
    if (editing !== null) editInputRef.current?.select()
  }, [editing])
  useEffect(() => {
    if (menu === null) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  /* keep the context menu inside the viewport — a right-click near the bottom or
     right edge would otherwise run this menu off-page. Runs in a layout effect
     (before paint) so the first frame is already corrected — no visible jump.
     Mirrors the clamp in CanvasFilesPanel/TerminalPanel. */
  useLayoutEffect(() => {
    const el = menuRef.current
    if (menu === null || el === null) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    const x = Math.max(pad, Math.min(menu.x, window.innerWidth - rect.width - pad))
    const y = Math.max(pad, Math.min(menu.y, window.innerHeight - rect.height - pad))
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [menu])

  /* a compact inline rename field shown in place of a row's title */
  const renameField = (
    <div className="border-b border-hairline-s py-1.5 pl-2 pr-2">
      <input
        ref={editInputRef}
        value={editValue}
        autoFocus
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitRename()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(null)
          }
        }}
        className="w-full border border-brass bg-surface-2 px-2 py-1 font-mono text-[12px] uppercase tracking-[0.06em] text-parchment outline-none"
        aria-label="Rename"
      />
    </div>
  )

  /* chat details shown at the foot of a chat's context menu — the chat's Claude
     project directory (its cwd) and its session id, both selectable to copy */
  const chatDetails = (cwd: string, sessionId: string) => (
    <div className="select-text border-t border-hairline-s px-3 pb-1.5 pt-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim">
        Claude directory
      </div>
      <div className="break-all font-mono text-[9px] leading-snug text-sand">{cwd || '—'}</div>
      <div className="mt-1.5 font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim">
        Session id
      </div>
      <div className="break-all font-mono text-[9px] leading-snug text-sand">{sessionId}</div>
    </div>
  )

  /* coarse 60s ticker so the "3m ago" subtitles don't go stale between
     unrelated re-renders */
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  /* — settings modal (default-view toggle + ports) — */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'general' | 'ports'>('general')
  /* — "Check for updates": ask the server to compare against the GitHub repo — */
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null)
  const handleCheckUpdates = () => {
    setCheckingUpdate(true)
    setUpdateCheck(null)
    api
      .checkUpdates()
      .then(setUpdateCheck)
      .catch(() => setUpdateCheck({ ok: false, error: 'Could not reach the server.' }))
      .finally(() => setCheckingUpdate(false))
  }
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  /* — ports panel: listening ports in use + a stop action — */
  const [ports, setPorts] = useState<PortInfo[]>([])
  const [portsLoading, setPortsLoading] = useState(false)
  const [portsError, setPortsError] = useState<string | null>(null)
  const [killingPid, setKillingPid] = useState<number | null>(null)
  const loadPorts = useCallback(() => {
    setPortsLoading(true)
    setPortsError(null)
    void api
      .listPorts()
      .then((p) => setPorts(p))
      .catch((err: unknown) =>
        setPortsError(err instanceof Error ? err.message : 'Could not list ports.'),
      )
      .finally(() => setPortsLoading(false))
  }, [])
  /* fetch when the Ports tab is opened (and reset to General each time the modal opens) */
  useEffect(() => {
    if (settingsOpen && settingsTab === 'ports') loadPorts()
  }, [settingsOpen, settingsTab, loadPorts])
  useEffect(() => {
    if (!settingsOpen) setSettingsTab('general')
  }, [settingsOpen])
  const stopPort = async (p: PortInfo) => {
    if (p.isSelf) return
    if (!window.confirm(`Stop ${p.name || 'the process'} (PID ${p.pid}) on port ${p.port}?`)) return
    setKillingPid(p.pid)
    setPortsError(null)
    try {
      await api.killPort(p.pid)
      loadPorts()
    } catch (err) {
      setPortsError(err instanceof Error ? err.message : 'Could not stop the process.')
    } finally {
      setKillingPid(null)
    }
  }

  /* — workflow-project inline rename —
     kept apart from the `editing` machinery above rather than folded into it:
     that one commits every kind through onRenameGroup, and this list is the
     other half of the split, with a handler of its own. — */
  const [wfRenameId, setWfRenameId] = useState<string | null>(null)
  const [wfRenameValue, setWfRenameValue] = useState('')
  const startWfRename = (g: ChatGroup) => {
    setWfRenameId(g.id)
    setWfRenameValue(g.name)
  }
  const commitWfRename = () => {
    if (wfRenameId === null) return
    const value = wfRenameValue.trim()
    const current = workflowProjects.find((g) => g.id === wfRenameId)
    /* an empty field would leave an unnameable row, so it reverts instead */
    if (value !== '' && current !== undefined && value !== current.name) {
      onRenameWorkflowProject(wfRenameId, value)
    }
    setWfRenameId(null)
  }

  /* — folded: a thin rail with just the expand control — */
  if (collapsed) {
    return (
      <aside className="relative flex w-12 shrink-0 flex-col items-center border-r border-hairline bg-surface pt-6">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="mt-4 h-px w-5 bg-brass" aria-hidden="true" />

        {/* — the main-pane views stay reachable while collapsed. Without these
             you could switch to the floor, collapse the sidebar, and have no way
             back to the session panes without expanding again. — */}
        {(
          [
            /* same order as the expanded rows, so the collapsed rail is not a
               different mental map from the one you just used */
            ['floor', 'Agents', Users],
            ['skills', 'Skills', Sparkles],
            ['mcp', 'MCP', Plug],
            ['workflows', 'Workflows', Workflow],
            ['projectWorkflows', 'Project Workflows', FolderKanban],
            ['agentsWorkflow', 'Agents Workflow', Workflow],
          ] as const
        ).map(([value, label, Icon]) => {
          const on = appView === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => onSetAppView(on ? 'sessions' : value)}
              title={on ? label + ' — back to the sessions' : label}
              aria-label={label}
              className={`mt-3 flex h-10 w-10 cursor-pointer items-center justify-center border transition-colors duration-200 ${
                on
                  ? 'border-brass bg-brass/10 text-brass'
                  : 'border-transparent text-sand hover:border-brass hover:text-brass'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          )
        })}
      </aside>
    )
  }

  return (
    <motion.aside
      variants={listVariants}
      initial="hidden"
      animate="show"
      className="relative flex w-72 shrink-0 flex-col border-r border-hairline bg-surface"
    >
      {/* — wordmark + collapse — */}
      <motion.div variants={itemVariants} className="border-b border-hairline px-6 pb-5 pt-6">
        <div className="flex items-start justify-between gap-2">
          <h1 className="font-display text-[26px] font-medium leading-none tracking-[-0.005em] text-parchment">
            Christopher <em className="font-normal italic text-brass">OS</em>
          </h1>
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="mo-ticks -mr-2 -mt-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-3.5 h-px w-16 bg-brass" aria-hidden="true" />
      </motion.div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {/* — tab toggle: Projects | This computer — */}
        <div className="flex gap-1 px-4 pt-5">
          {(
            [
              ['projects', 'Groups'],
              ['directories', 'Directories'],
              ['recent', 'Recent'],
              ['canvas', 'Canvas'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={appView === 'sessions' && tab === value}
              onClick={() => {
                /* both rows are ONE group: picking a list view also drops
                   the main-pane view back to the sessions, so two never read as
                   selected at once */
                onSetAppView('sessions')
                setTab(value)
              }}
              className={`min-w-0 flex-1 cursor-pointer truncate border px-1 py-2 text-center font-mono text-[8px] uppercase tracking-[0.02em] transition-colors duration-200 ${
                appView === 'sessions' && tab === value
                  ? 'border-brass bg-brass/10 text-brass'
                  : 'border-hairline text-sand hover:border-brass hover:text-brass'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* — second row: the MAIN-PANE views. These are a different kind of
             switch from the four above — those filter what this sidebar lists,
             these replace what the workspace shows. Each is a toggle: pressing
             the active one drops you back on the session panes. — */}
        {/* WRAPS, deliberately. This row shares 240px between flex-1 chips, so a
             fifth one drops all five to ~48px and every label truncates to four
             characters — "WORKF…" next to "PROJE…" tells you nothing, and it
             degrades the four tabs that were already fine. Wrapping costs one
             line and buys a full-width chip on the second row, which is why the
             new tab can carry its real name instead of an abbreviation. */}
        {/* — isolation between the two groups. They are different KINDS of
             switch: the row above filters what this sidebar LISTS, the rows
             below replace what the main pane RENDERS. Without a rule they read
             as one six-item group and the distinction disappears. — */}
        <div aria-hidden="true" className="mx-4 mt-3 mb-2 h-px bg-hairline" />

        <div className="flex flex-wrap gap-1 px-4">
          {/* [value, chip label, full name] — the label and the full name differ
               only where a chip is too narrow for the name. */}
          {(
            [
              ['floor', 'Agents', 'Agents'],
              ['skills', 'Skills', 'Skills'],
              ['mcp', 'MCP', 'MCP'],
              ['workflows', 'Workflow', 'Workflows'],
              // second row — the two workflow views, side by side at half width
              ['projectWorkflows', 'Project WF', 'Project Workflows'],
              ['agentsWorkflow', 'Agent WF', 'Agents Workflow'],
            ] as const
          ).map(([value, label, full], i, all) => {
            const on = appView === value
            // Four to a row; a PARTIAL row divides its own width evenly rather
            // than leaving quarter-width chips against dead space. An explicit
            // basis is what makes flex-wrap actually wrap: `flex-1` alone is
            // basis-0, so every chip would shrink onto one line instead.
            const rowStart = Math.floor(i / 4) * 4
            const inThisRow = Math.min(4, all.length - rowStart)
            const basis =
              inThisRow === 1
                ? 'basis-full'
                : inThisRow === 2
                  ? 'basis-[calc(50%-2px)]'
                  : inThisRow === 3
                    ? 'basis-[calc(33.333%-3px)]'
                    : 'basis-[calc(25%-3px)]'
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                aria-label={full}
                onClick={() => onSetAppView(on ? 'sessions' : value)}
                title={on ? full + ' — back to the sessions' : full}
                className={`min-w-0 grow ${basis} cursor-pointer truncate border px-1 py-2 text-center font-mono text-[8px] uppercase tracking-[0.02em] transition-colors duration-200 ${
                  on
                    ? 'border-brass bg-brass/10 text-brass'
                    : 'border-hairline text-sand hover:border-brass hover:text-brass'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* — FLOORS: shown in place of the group list while either chart is the
             selected view. ONE section serving two lists, filtered by kind — the
             canvas, the rows and the affordances are identical, so forking it
             would be the same code twice and a second place to fix a bug.
             Opening one puts it in the workspace tab strip. — */}
        {/* The Agents chart keeps this flat list. Agent WF has its own
             disclosure list further down — rendering both showed every workflow
             floor twice. */}
        {appView === 'floor' && (
          <section aria-label="Floors" className="px-4 pt-5">
            <div className="flex items-center justify-between px-2">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                Agents
              </h2>
              <button
                type="button"
                onClick={() => onAddFloor('agents')}
                title="Add a floor"
                className="flex h-6 cursor-pointer items-center gap-1 border border-hairline px-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Add floor
              </button>
            </div>

            {(() => {
              // The two charts share this section, so each shows only its own.
              const shown = floors.filter((f) => f.kind !== 'workflow')
              return shown.length === 0 ? (
              <p className="mt-4 px-2 font-display text-[13px] italic leading-relaxed text-sand">
                No floors yet. Add one and it opens as a tab on the right, with
                its boss already seated.
              </p>
            ) : (
              <ul className="mt-3 list-none">
                {shown.map((f) =>
                  /* Renaming works on BOTH floor lists. This one is a plain row
                     rather than a SidebarRow, but a floor is a floor — offering
                     rename only on the other chart would make the same object
                     editable or not depending on which tab you found it in. */
                  isEditing({ kind: 'floor', floorId: f.id, current: f.name }) ? (
                    <li key={f.id}>{renameField}</li>
                  ) : (
                  <li key={f.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenFloor(f)}
                      onContextMenu={(e) =>
                        openMenu(e, { kind: 'floor', floorId: f.id, current: f.name })
                      }
                      title={`Open ${f.name}`}
                      className="min-w-0 flex-1 cursor-pointer truncate px-2 py-1.5 text-left font-display text-[13px] text-parchment transition-colors duration-200 hover:text-brass"
                    >
                      {f.name}
                      <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                        {f.agents.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteFloor(f.id)}
                      title={`Delete ${f.name}`}
                      aria-label={`Delete ${f.name}`}
                      className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-transparent transition-colors duration-200 group-hover:text-sand-dim hover:!text-brass"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                  ),
                )}
              </ul>
            )
            })()}

          </section>
        )}

            {/* — the agents, listed exactly as Groups lists its chats: a
                 SidebarRow you click to disclose, with the children indented
                 under the same rail. Same components, so the two lists cannot
                 drift apart visually. — */}
            {appView === 'agentsWorkflow' && (
              <div className="flex items-center justify-between px-2 pt-5">
                <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                  Agents Workflow
                </h2>
                <button
                  type="button"
                  onClick={() => onAddFloor('workflow')}
                  title="Add a workflow floor"
                  className="flex h-6 cursor-pointer items-center gap-1 border border-hairline px-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Add floor
                </button>
              </div>
            )}
            {appView === 'agentsWorkflow' && (
              <ul className="mt-3 space-y-0 border-t border-hairline-s">
                {floors
                  .filter((f) => f.kind === 'workflow')
                  .map((f, i) => {
                    const open = expandedFloors.has(f.id)
                    return (
                      <li key={f.id + '-agents'}>
                        {isEditing({ kind: 'floor', floorId: f.id, current: f.name }) ? (
                          renameField
                        ) : (
                        <SidebarRow
                          index={i}
                          title={f.name}
                          /* The attachment belongs to the FLOOR, so it is shown
                             on the floor's own row — not buried in a tab that
                             sits inside the per-agent panel, where it reads as
                             an agent setting. */
                          subtitle={
                            `${f.agents.length} agent${f.agents.length === 1 ? '' : 's'}` +
                            (f.crmScope
                              ? ' · ' +
                                (f.crmScope.targetType === 'mine'
                                  ? 'my tasks'
                                  : f.crmScope.targetType)
                              : ' · not attached')
                          }
                          expanded={open}
                          active={f.agents.some(
                            (a) => a.sessionId != null && activeSet.has(a.sessionId),
                          )}
                          onSelect={() =>
                            setExpandedFloors((prev) => {
                              const next = new Set(prev)
                              if (next.has(f.id)) next.delete(f.id)
                              else next.add(f.id)
                              return next
                            })
                          }
                          /* open the design as a workspace tab — the affordance
                             the flat list used to carry */
                          onDoubleClick={() => onOpenFloor(f)}
                          onContextMenu={(e) => openMenu(e, { kind: 'floor', floorId: f.id, current: f.name })}
                        />
                        )}
                        {open && (
                          <div className="ml-3 border-l border-hairline-s pl-1.5">
                            {f.agents.length === 0 ? (
                              <p className="px-2 py-3 font-display text-[13px] italic leading-relaxed text-sand">
                                No agents yet — draw one on the floor.
                              </p>
                            ) : (
                              <ul className="space-y-0">
                                {f.agents.map((a, ai) => (
                                  <li key={a.id}>
                                    <SidebarRow
                                      index={ai}
                                      nested
                                      title={a.isBoss ? a.name + ' ♔' : a.name}
                                      subtitle={
                                        (a.role || 'no role') +
                                        (a.sessionId == null ? ' · no chat yet' : '')
                                      }
                                      selected={selAgentId === a.id && selFloorId === f.id}
                                      active={a.sessionId != null && activeSet.has(a.sessionId)}
                                      /* Clicking a name lands you IN the
                                         conversation — that is what a person
                                         means by clicking an agent. It reuses a
                                         live chat and only starts one when the
                                         agent has none. */
                                      onSelect={() => onSelectAgent(f.id, a.id, true)}
                                    />
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
              </ul>
            )}

        {/* — WORKFLOW PROJECTS: shown in place of the project list while Project
             Workflows is the selected view — the floors arrangement, applied to
             the other half of the group split. Picking one drives the panel on
             the right; unlike a floor it opens no tab, because the chats a run
             spawns are private to that panel and stay inside it. — */}
        {appView === 'projectWorkflows' && (
          <section aria-label="Workflow projects" className="px-4 pt-5">
            <div className="flex items-center justify-between px-2">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                Workflow projects
              </h2>
              <button
                type="button"
                onClick={onNewWorkflowProject}
                title="Add a workflow project"
                aria-label="Add a workflow project"
                className="flex h-6 cursor-pointer items-center gap-1 border border-hairline px-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Add
              </button>
            </div>

            {workflowProjects.length === 0 ? (
              <p className="mt-4 px-2 font-display text-[13px] italic leading-relaxed text-sand">
                No workflow projects yet. Add one with <span className="text-brass">+</span>, then
                attach a workflow on the right and run it. Every chat the run opens stays in this
                view, apart from your projects.
              </p>
            ) : (
              <ul className="mt-3 list-none">
                {workflowProjects.map((g) => {
                  if (wfRenameId === g.id) {
                    return (
                      <li key={g.id} className="border-b border-hairline-s py-1.5 pl-2 pr-2">
                        <input
                          value={wfRenameValue}
                          autoFocus
                          onChange={(e) => setWfRenameValue(e.target.value)}
                          onBlur={commitWfRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitWfRename()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setWfRenameId(null)
                            }
                          }}
                          className="w-full border border-brass bg-surface-2 px-2 py-1 font-mono text-[12px] uppercase tracking-[0.06em] text-parchment outline-none"
                          aria-label="Rename workflow project"
                        />
                      </li>
                    )
                  }
                  const on = selectedWorkflowProjectId === g.id
                  return (
                    <li
                      key={g.id}
                      className={`group flex items-center gap-1 ${on ? 'bg-brass/10' : ''}`}
                    >
                      <button
                        type="button"
                        aria-current={on ? 'true' : undefined}
                        onClick={() => onSelectWorkflowProject(on ? null : g.id)}
                        onDoubleClick={() => startWfRename(g)}
                        title={on ? `${g.name} — pick it again to clear the panel` : `Open ${g.name}`}
                        className={`min-w-0 flex-1 cursor-pointer truncate px-2 py-1.5 text-left font-display text-[13px] transition-colors duration-200 ${
                          on ? 'text-brass' : 'text-parchment hover:text-brass'
                        }`}
                      >
                        {g.name}
                        <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                          {g.chats.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => startWfRename(g)}
                        title={`Rename ${g.name}`}
                        aria-label={`Rename ${g.name}`}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-transparent transition-colors duration-200 group-hover:text-sand-dim hover:!text-brass"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteWorkflowProject(g.id)}
                        title={`Delete ${g.name}`}
                        aria-label={`Delete ${g.name}`}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-transparent transition-colors duration-200 group-hover:text-sand-dim hover:!text-brass"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}

        {/* projectWorkflows is absent here on purpose: it now lists its own
             projects above, and a hint under the list would only repeat it. */}
        {(appView === 'workflows' || appView === 'skills' || appView === 'mcp') && (
          <p className="px-6 pt-6 font-display text-[13px] italic leading-relaxed text-sand">
            {appView === 'workflows'
              ? 'Workflows on the right — each step carries the tutorial its session gets briefed with.'
              : appView === 'skills'
                ? 'Skills installed on this machine, on the right.'
                : 'MCP servers configured for Claude Code, on the right.'}
          </p>
        )}

        {/* — search: name/path + transcript content (reads the jsonl) — */}
        {appView === 'sessions' && (
        <div className="px-4 pt-3">
          <div className="flex items-center gap-2 border border-hairline px-3 transition-colors duration-200 focus-within:border-brass">
            <Search className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === 'projects'
                  ? 'Search groups, chats & content…'
                  : tab === 'directories'
                    ? 'Search directories & content…'
                    : tab === 'canvas'
                      ? 'Search canvas files…'
                      : 'Search recent & content…'
              }
              spellCheck={false}
              aria-label="Search"
              className="w-full bg-transparent py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none"
            />
            {query !== '' && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          {query.trim().length >= 2 && tab !== 'canvas' && (
            <p className="mt-1.5 px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
              {contentSearching
                ? 'Searching content…'
                : `${contentHits.size} content match${contentHits.size === 1 ? '' : 'es'}`}
            </p>
          )}
        </div>
        )}

        {/* — Projects: dir-less chat groups; members open in their own cwd — */}
        {appView === 'sessions' && tab === 'projects' && (
        <motion.section variants={itemVariants} aria-label="Groups" className="px-4 pt-6">
          <div className="flex items-center justify-between px-2">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
              Projects
            </h2>
            <button
              type="button"
              aria-label="New group"
              onClick={() => onNewGroup()}
              className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {projectGroups.length === 0 ? (
            <div className="mt-3 border border-hairline px-4 py-6">
              <FolderGit2 className="h-4 w-4 text-sand-dim" aria-hidden="true" />
              <p className="mt-3 font-display text-[15px] italic leading-relaxed text-sand">
                No groups yet. Create one with <span className="text-brass">+</span>, then add chats
                from Directories or Recent (right-click → Add to project).
              </p>
            </div>
          ) : (() => {
            const groupMatches = (g: ChatGroup) =>
              inc(g.name) ||
              g.directories.some((d) => inc(d.path)) ||
              inc(g.description) ||
              g.chats.some(
                (c) =>
                  inc(sessionById.get(c.sessionId)?.summary) ||
                  inc(c.cwd) ||
                  contentHits.has(c.sessionId),
              )
            const visibleGroups = q === '' ? projectGroups : projectGroups.filter(groupMatches)
            if (visibleGroups.length === 0) {
              return (
                <p className="mt-3 px-2 py-3 font-display text-[14px] italic leading-relaxed text-sand">
                  No groups match “{query}”.
                </p>
              )
            }
            return (
            <ul className="mt-3 space-y-0 border-t border-hairline-s">
              {visibleGroups.map((g, i) => {
                const groupNameMatch =
                  q !== '' &&
                  (inc(g.name) || g.directories.some((d) => inc(d.path)) || inc(g.description))
                const chatsOrdered = orderedChats(g)
                const visibleChats =
                  q === '' || groupNameMatch
                    ? chatsOrdered
                    : chatsOrdered.filter(
                        (c) =>
                          inc(sessionById.get(c.sessionId)?.summary) ||
                          inc(c.cwd) ||
                          contentHits.has(c.sessionId),
                      )
                const open = q !== '' ? true : expandedGroups.has(g.id)
                return (
                  <li
                    key={g.id}
                    onDragOver={(e) => {
                      const chat = dragChatRef.current
                      const grp = dragGroupRef.current
                      if ((chat && chat.groupId !== g.id) || (grp && grp !== g.id)) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (dragOverGroupId !== g.id) setDragOverGroupId(g.id)
                      }
                    }}
                    onDragLeave={(e) => {
                      // Only clear when the cursor truly leaves this <li>, not when it
                      // enters a child row (which fires a spurious dragleave on the parent).
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        if (dragOverGroupId === g.id) setDragOverGroupId(null)
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const chat = dragChatRef.current
                      const grp = dragGroupRef.current
                      if (grp && grp !== g.id) reorderGroup(grp, g.id)
                      else if (chat && chat.groupId !== g.id)
                        onMoveChatToProject(chat.groupId, g.id, chat.sessionId, chat.cwd)
                      dragChatRef.current = null
                      dragGroupRef.current = null
                      setDragOverGroupId(null)
                      setDragOverChatId(null)
                    }}
                    className={
                      dragOverGroupId === g.id ? 'rounded-sm bg-brass/10 ring-1 ring-brass/40' : ''
                    }
                  >
                    {isEditing({ kind: 'group', groupId: g.id, current: g.name }) ? (
                      renameField
                    ) : (
                      <SidebarRow
                        index={i}
                        title={g.name}
                        color={g.color}
                        subtitle={`${g.chats.length} chat${g.chats.length === 1 ? '' : 's'}${
                          g.directories.length === 1
                            ? ` · ${shortPath(g.directories[0].path)}`
                            : g.directories.length > 1
                              ? ` · ${g.directories.length} dirs`
                              : ''
                        }`}
                        expanded={open}
                        active={g.chats.some((c) => activeSet.has(c.sessionId))}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', g.id)
                          dragGroupRef.current = g.id
                        }}
                        onDragEnd={() => {
                          dragGroupRef.current = null
                          setDragOverGroupId(null)
                        }}
                        onSelect={() =>
                          setExpandedGroups((prev) => {
                            const next = new Set(prev)
                            if (next.has(g.id)) next.delete(g.id)
                            else next.add(g.id)
                            return next
                          })
                        }
                        onDoubleClick={() =>
                          startRename({ kind: 'group', groupId: g.id, current: g.name })
                        }
                        onContextMenu={(e) =>
                          openMenu(e, { kind: 'group', groupId: g.id, current: g.name })
                        }
                      />
                    )}
                    {open && (
                      <div className="ml-3 border-l border-hairline-s pl-1.5">
                        {visibleChats.length === 0 ? (
                          <p className="px-2 py-3 font-display text-[13px] italic leading-relaxed text-sand">
                            {g.chats.length === 0 ? 'Empty — add a chat below.' : 'No chats match.'}
                          </p>
                        ) : (
                          <ul className="space-y-0">
                            {visibleChats.map((c) => {
                              const meta = sessionById.get(c.sessionId)
                              const cTitle = meta?.summary || `Session ${c.sessionId.slice(0, 8)}`
                              const cSub = meta
                                ? `${meta.messageCount} msg${
                                    meta.messageCount === 1 ? '' : 's'
                                  } · ${relativeTime(meta.lastActive)} · ${shortPath(c.cwd)}`
                                : shortPath(c.cwd)
                              const cTarget = {
                                kind: 'group-chat' as const,
                                groupId: g.id,
                                sessionId: c.sessionId,
                                cwd: c.cwd,
                                current: cTitle,
                              }
                              return (
                                <li
                                  key={c.sessionId}
                                  /* within-project reorder: a chat from THIS group
                                     dropped onto another chat reorders in place. A
                                     chat from a DIFFERENT group is ignored here and
                                     bubbles to the group <li> (cross-project move). */
                                  onDragOver={(e) => {
                                    const chat = dragChatRef.current
                                    if (
                                      chat &&
                                      chat.groupId === g.id &&
                                      chat.sessionId !== c.sessionId
                                    ) {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      e.dataTransfer.dropEffect = 'move'
                                      if (dragOverChatId !== c.sessionId)
                                        setDragOverChatId(c.sessionId)
                                    }
                                  }}
                                  onDragLeave={(e) => {
                                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                                      if (dragOverChatId === c.sessionId) setDragOverChatId(null)
                                    }
                                  }}
                                  onDrop={(e) => {
                                    const chat = dragChatRef.current
                                    if (
                                      chat &&
                                      chat.groupId === g.id &&
                                      chat.sessionId !== c.sessionId
                                    ) {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      reorderGroupChat(g.id, chat.sessionId, c.sessionId)
                                      dragChatRef.current = null
                                    }
                                    setDragOverChatId(null)
                                  }}
                                  className={
                                    dragOverChatId === c.sessionId
                                      ? 'rounded-sm bg-brass/10 ring-1 ring-brass/40'
                                      : ''
                                  }
                                >
                                  {isEditing(cTarget) ? (
                                    renameField
                                  ) : (
                                    <SidebarRow
                                      index={0}
                                      nested
                                      title={cTitle}
                                      subtitle={cSub}
                                      selected={c.sessionId === selectedSessionId}
                                      active={activeSet.has(c.sessionId)}
                                      draggable
                                      onDragStart={(e) => {
                                        e.dataTransfer.effectAllowed = 'move'
                                        e.dataTransfer.setData('text/plain', c.sessionId)
                                        dragChatRef.current = {
                                          groupId: g.id,
                                          sessionId: c.sessionId,
                                          cwd: c.cwd,
                                        }
                                      }}
                                      onDragEnd={() => {
                                        dragChatRef.current = null
                                        setDragOverGroupId(null)
                                        setDragOverChatId(null)
                                      }}
                                      onSelect={() => onOpenGroupChat(c)}
                                      onDoubleClick={() => startRename(cTarget)}
                                      onContextMenu={(e) => openMenu(e, cTarget)}
                                    />
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                        <button
                          type="button"
                          aria-label="Add chat"
                          onClick={() => {
                            setAddChatFor(g.id)
                            setAddMode('existing')
                            setAddQuery('')
                          }}
                          className="mo-ticks flex w-full cursor-pointer items-center gap-2 border-l-2 border-l-transparent py-2 pl-2 pr-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-sand-dim transition-colors duration-150 hover:border-l-brass hover:bg-surface-2/40 hover:text-brass"
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" />
                          Add chat
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            )
          })()}
        </motion.section>
        )}

        {appView === 'sessions' && tab === 'recent' && (
          <section aria-label="Recent sessions" className="px-4 pt-6">
            <div className="flex items-center justify-between px-2">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                Recent
              </h2>
              <button
                type="button"
                aria-label="Refresh sessions"
                title="Refresh"
                onClick={() => setComputerSessions(null)}
                className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingComputer ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            {loadingComputer && computerSessions === null ? (
              <p className="mt-3 px-2 py-3 font-display text-[13px] italic leading-relaxed text-sand">
                Scanning every session on this machine…
              </p>
            ) : (computerSessions ?? []).length === 0 ? (
              <div className="mt-3 border border-hairline px-4 py-6">
                <Laptop className="h-4 w-4 text-sand-dim" aria-hidden="true" />
                <p className="mt-3 font-display text-[15px] italic leading-relaxed text-sand">
                  No Claude sessions found on this computer.
                </p>
              </div>
            ) : (() => {
              const all = computerSessions ?? []
              const visible =
                q === ''
                  ? all
                  : all.filter(
                      (s) =>
                        inc(s.summary) ||
                        inc(s.cwd) ||
                        inc(s.folder) ||
                        contentHits.has(s.sessionId),
                    )
              return (
              <>
                <p className="mt-2 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                  {q === ''
                    ? `${all.length} sessions · newest first`
                    : `${visible.length} match${visible.length === 1 ? '' : 'es'}`}
                </p>
                {visible.length === 0 ? (
                  <p className="mt-3 px-2 py-3 font-display text-[14px] italic leading-relaxed text-sand">
                    No sessions match “{query}”.
                  </p>
                ) : (
                <ul className="mt-2 space-y-0 border-t border-hairline-s">
                  {visible.map((s, i) => (
                    <li key={`${s.folder}/${s.sessionId}`}>
                      <SidebarRow
                        index={i}
                        nested
                        title={s.summary !== '' ? s.summary : 'Untitled session'}
                        subtitle={`${s.messageCount} msg${s.messageCount === 1 ? '' : 's'} · ${relativeTime(
                          s.lastActive,
                        )} · ${shortPath(s.cwd) || s.folder}`}
                        selected={s.sessionId === selectedSessionId}
                        active={activeSet.has(s.sessionId)}
                        onSelect={() => onOpenComputerSession(s)}
                        onContextMenu={(e) =>
                          openMenu(e, {
                            kind: 'add',
                            sessionId: s.sessionId,
                            cwd: s.cwd,
                            current: s.summary,
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
                )}
              </>
              )
            })()}
          </section>
        )}

        {appView === 'sessions' && tab === 'directories' && (
          <section aria-label="Directories" className="px-4 pt-6">
            <div className="flex items-center justify-between px-2">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                Directories
              </h2>
              <button
                type="button"
                aria-label="Refresh directories"
                title="Refresh"
                onClick={() => setComputerSessions(null)}
                className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingComputer ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            {loadingComputer && computerSessions === null ? (
              <p className="mt-3 px-2 py-3 font-display text-[13px] italic leading-relaxed text-sand">
                Scanning ~/.claude/projects…
              </p>
            ) : dirGroups.length === 0 ? (
              <div className="mt-3 border border-hairline px-4 py-6">
                <FolderGit2 className="h-4 w-4 text-sand-dim" aria-hidden="true" />
                <p className="mt-3 font-display text-[15px] italic leading-relaxed text-sand">
                  No session directories found.
                </p>
              </div>
            ) : (() => {
              const visibleDirs =
                q === ''
                  ? dirGroups.map((g) => ({ g, sessions: g.sessions, dirMatch: false }))
                  : dirGroups
                      .map((g) => {
                        const dirMatch = inc(g.cwd) || inc(g.folder) || inc(baseName(g.cwd))
                        const sessions = dirMatch
                          ? g.sessions
                          : g.sessions.filter(
                              (s) => inc(s.summary) || inc(s.cwd) || contentHits.has(s.sessionId),
                            )
                        return { g, sessions, dirMatch }
                      })
                      .filter((x) => x.dirMatch || x.sessions.length > 0)
              if (visibleDirs.length === 0) {
                return (
                  <p className="mt-3 px-2 py-3 font-display text-[14px] italic leading-relaxed text-sand">
                    No directories match “{query}”.
                  </p>
                )
              }
              return (
              <>
                <p className="mt-2 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                  {q === ''
                    ? `${dirGroups.length} ${dirGroups.length === 1 ? 'directory' : 'directories'}`
                    : `${visibleDirs.length} match${visibleDirs.length === 1 ? '' : 'es'}`}
                </p>
                <ul className="mt-2 space-y-0 border-t border-hairline-s">
                  {visibleDirs.map(({ g, sessions }, i) => {
                    const open = q !== '' ? true : expandedDirs.has(g.key)
                    return (
                      <li key={g.key}>
                        <SidebarRow
                          index={i}
                          title={baseName(g.cwd) || g.folder}
                          subtitle={`${sessions.length} chat${
                            sessions.length === 1 ? '' : 's'
                          } · ${shortPath(g.cwd) || g.folder}`}
                          expanded={open}
                          active={sessions.some((s) => activeSet.has(s.sessionId))}
                          onSelect={() =>
                            setExpandedDirs((prev) => {
                              const next = new Set(prev)
                              if (next.has(g.key)) next.delete(g.key)
                              else next.add(g.key)
                              return next
                            })
                          }
                        />
                        {open && (
                          <div className="ml-3 border-l border-hairline-s pl-1.5">
                            <ul className="space-y-0">
                              {sessions.map((s) => (
                                <li key={s.sessionId}>
                                  <SidebarRow
                                    index={0}
                                    nested
                                    title={s.summary !== '' ? s.summary : 'Untitled session'}
                                    subtitle={`${s.messageCount} msg${
                                      s.messageCount === 1 ? '' : 's'
                                    } · ${relativeTime(s.lastActive)}`}
                                    selected={s.sessionId === selectedSessionId}
                                    active={activeSet.has(s.sessionId)}
                                    onSelect={() => onOpenComputerSession(s)}
                                    onContextMenu={(e) =>
                                      openMenu(e, {
                                        kind: 'add',
                                        sessionId: s.sessionId,
                                        cwd: s.cwd,
                                        current: s.summary,
                                      })
                                    }
                                  />
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
              )
            })()}
          </section>
        )}

        {appView === 'sessions' && tab === 'canvas' && (
          <section aria-label="Canvas files" className="px-4 pt-6">
            <div className="flex items-center justify-between px-2">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">Canvas</h2>
              <button
                type="button"
                aria-label="Refresh canvas files"
                title="Refresh"
                onClick={() => setCanvasFiles(null)}
                className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingCanvas ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            {loadingCanvas && canvasFiles === null ? (
              <p className="mt-3 px-2 py-3 font-display text-[13px] italic leading-relaxed text-sand">
                Loading canvas files…
              </p>
            ) : !canvasRunning ? (
              <div className="mt-3 border border-hairline px-4 py-6">
                <PenTool className="h-4 w-4 text-sand-dim" aria-hidden="true" />
                <p className="mt-3 font-display text-[15px] italic leading-relaxed text-sand">
                  The Excalidraw canvas isn’t running.
                </p>
                <button
                  type="button"
                  onClick={() => void handleStartCanvas()}
                  disabled={startingCanvas}
                  className="mo-button mt-4 flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <PenTool className="h-3.5 w-3.5" aria-hidden="true" />
                  {startingCanvas ? 'Starting…' : 'Start Excalidraw'}
                </button>
                {startingCanvas && (
                  <p className="mt-2 font-display text-[12px] italic leading-relaxed text-sand-dim">
                    Booting the canvas — files will appear in a few seconds.
                  </p>
                )}
              </div>
            ) : (
              <CanvasFilesPanel
                query={query}
                selectedCanvas={canvasFile}
                onOpenCanvas={onOpenCanvas}
              />
            )}
          </section>
        )}
      </div>

      {/* — settings — */}
      <motion.div variants={itemVariants} className="border-t border-hairline p-4">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(true)}
          className="mo-ticks flex min-h-10 w-full cursor-pointer items-center gap-3 border border-transparent px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.22em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          Settings
        </button>
      </motion.div>

      {/* — settings modal (centered dialog) — */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            key="settings-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.25, ease: 'easeOut' } }}
            exit={{ opacity: 0, transition: { duration: 0.18, ease: 'easeIn' } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
            onClick={() => setSettingsOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.2, 0.6, 0.2, 1] } }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.18, ease: 'easeIn' } }}
              role="dialog"
              aria-modal="true"
              aria-label="Settings"
              style={{ background: 'var(--color-surface)' }}
              className="mo-card w-full max-w-lg shadow-2xl shadow-black/50"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                    <span className="text-brass" aria-hidden="true">
                      ✦
                    </span>{' '}
                    Settings
                  </div>
                  <h2 className="mt-2 font-display text-[26px] font-medium leading-tight text-parchment">
                    Settings
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close"
                  className="mo-ticks flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              {/* — tabs: General | Ports — */}
              <div role="tablist" className="mt-5 flex border border-hairline">
                {(
                  [
                    ['general', 'General'],
                    ['ports', 'Ports'],
                  ] as const
                ).map(([value, label], i) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === value}
                    onClick={() => setSettingsTab(value)}
                    className={`flex-1 cursor-pointer px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200 ${
                      i === 1 ? 'border-l border-hairline' : ''
                    } ${settingsTab === value ? 'bg-brass text-midnight' : 'text-sand hover:text-brass'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {settingsTab === 'general' && (
                <>
              <div className="mt-6">
                <p
                  id="default-view-label"
                  className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand"
                >
                  Default View
                </p>
                <p className="mt-1.5 font-display text-[13px] italic leading-relaxed text-sand">
                  Which panel a chat opens to when you select it.
                </p>
                <div
                  role="group"
                  aria-labelledby="default-view-label"
                  className="mt-3 flex border border-hairline"
                >
                  {(
                    [
                      ['chat', 'Chat'],
                      ['terminals', 'Terminal'],
                    ] as const
                  ).map(([value, label], i) => {
                    const isSel = defaultView === value
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={isSel}
                        onClick={() => onDefaultViewChange(value)}
                        className={`flex-1 cursor-pointer px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200 ${
                          i === 1 ? 'border-l border-hairline' : ''
                        } ${isSel ? 'bg-brass text-midnight' : 'text-sand hover:text-brass'}`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="mt-6 border-t border-hairline-s pt-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                  Claude Terminal
                </p>
                <p className="mt-1.5 font-display text-[13px] italic leading-relaxed text-sand">
                  Open an external terminal running{' '}
                  <span className="font-mono not-italic text-sand-dim">
                    claude --dangerously-skip-permissions
                  </span>{' '}
                  in your home directory.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .runCommand(homeDir, 'claude --dangerously-skip-permissions')
                      .catch(() => {})
                    setSettingsOpen(false)
                  }}
                  disabled={homeDir === ''}
                  className="mo-button mt-3 flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <TerminalIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  New Claude terminal
                </button>
              </div>

              <div className="mt-6 border-t border-hairline-s pt-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                  Updates
                </p>
                <p className="mt-1.5 font-display text-[13px] italic leading-relaxed text-sand">
                  Check GitHub for a newer version of Claude Manager.
                </p>
                <button
                  type="button"
                  onClick={handleCheckUpdates}
                  disabled={checkingUpdate}
                  className="mo-button mt-3 flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${checkingUpdate ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  {checkingUpdate ? 'Checking…' : 'Check for Updates'}
                </button>
                {updateCheck !== null &&
                  (!updateCheck.ok ? (
                    <p className="mt-3 border border-[#cf6b52] px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.1em] text-[#cf6b52]">
                      Couldn't check: {updateCheck.error}
                    </p>
                  ) : updateCheck.upToDate ? (
                    <p className="mt-3 border border-hairline px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.1em] text-sand">
                      ✓ Up to date — running the latest ({updateCheck.localCommit}).
                    </p>
                  ) : (
                    <div className="mt-3 border border-brass px-3 py-2.5 font-mono text-[10px] leading-relaxed text-brass">
                      <div className="uppercase tracking-[0.16em]">
                        Update available · {updateCheck.behind} new commit
                        {updateCheck.behind === 1 ? '' : 's'}
                      </div>
                      {updateCheck.latestSubject !== undefined && updateCheck.latestSubject !== '' && (
                        <div className="mt-1.5 tracking-[0.02em] text-sand">
                          Latest: {updateCheck.latestSubject}
                        </div>
                      )}
                      <div className="mt-1.5 tracking-[0.02em] text-sand-dim">
                        {updateCheck.localCommit} → {updateCheck.remoteCommit} · pull with{' '}
                        <span className="text-sand">git pull</span>, then restart.
                      </div>
                    </div>
                  ))}
              </div>
                </>
              )}

              {settingsTab === 'ports' && (
                <div className="mt-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
                        Ports In Use
                      </p>
                      <p className="mt-1.5 font-display text-[13px] italic leading-relaxed text-sand">
                        Listening TCP ports and the process holding each. Stop one to free its port.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={loadPorts}
                      disabled={portsLoading}
                      aria-label="Refresh ports"
                      title="Refresh"
                      className="mo-ticks flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${portsLoading ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  {portsError !== null && (
                    <p
                      role="alert"
                      className="mt-3 border border-[#cf6b52] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#cf6b52]"
                    >
                      {portsError}
                    </p>
                  )}

                  <div className="mt-3 max-h-[52vh] overflow-y-auto border-t border-hairline-s">
                    {portsLoading && ports.length === 0 ? (
                      <p className="px-1 py-4 font-display text-[13px] italic text-sand-dim">
                        Scanning ports…
                      </p>
                    ) : ports.length === 0 ? (
                      <p className="px-1 py-4 font-display text-[13px] italic text-sand-dim">
                        {portsError === null ? 'No listening ports found.' : ''}
                      </p>
                    ) : (
                      <ul className="divide-y divide-hairline-s">
                        {ports.map((p) => (
                          <li key={`${p.port}-${p.pid}`} className="flex items-center gap-3 py-2.5">
                            <span className="w-14 shrink-0 font-mono text-[13px] tabular-nums text-brass">
                              {p.port}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-[11px] text-parchment">
                                {p.name || 'unknown'}
                                {p.isSelf && <span className="text-sand-dim"> · Christopher</span>}
                              </div>
                              <div className="font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                                PID {p.pid} · {p.address}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void stopPort(p)}
                              disabled={p.isSelf || killingPid === p.pid}
                              title={p.isSelf ? 'Cannot stop Christopher itself' : 'Stop this process'}
                              aria-label={`Stop process on port ${p.port}`}
                              className="mo-ticks flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border border-hairline px-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 hover:border-[#cf6b52] hover:text-[#cf6b52] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-sand"
                            >
                              <Power className="h-3 w-3" aria-hidden="true" />
                              {killingPid === p.pid ? 'Stopping…' : 'Stop'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* — read-only transcript quick-look (right-click → "View") — */}
      <ChatContentModal target={viewContentFor} onClose={() => setViewContentFor(null)} />

      {/* — "Change directory": move a chat's .jsonl to a new working directory — */}
      {moveDirFor !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={() => setMoveDirFor(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Change directory"
            style={{ background: 'var(--color-surface)' }}
            className="mo-card flex max-h-[85vh] w-full max-w-lg flex-col shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Change Directory
                </div>
                <h2 className="mt-2 truncate font-display text-[24px] font-medium leading-tight text-parchment">
                  {moveDirFor.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setMoveDirFor(null)}
                aria-label="Close"
                className="mo-ticks flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim">
                Current directory
              </span>
              <p className="mt-1 truncate font-mono text-[11px] text-sand">{moveDirFor.cwd}</p>
            </div>

            <div className="mt-4">
              <label
                htmlFor="move-to"
                className="block font-mono text-[10px] uppercase tracking-[0.22em] text-sand"
              >
                New working directory
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  id="move-to"
                  type="text"
                  autoFocus
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitMove(moveTo)
                  }}
                  placeholder="C:\Users\you\projects\survey"
                  spellCheck={false}
                  className="min-w-0 flex-1 border border-hairline bg-transparent px-3 py-2.5 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none transition-colors duration-200 focus:border-brass"
                />
                <button
                  type="button"
                  onClick={() => setMovePickerOpen(true)}
                  className="mo-ticks flex shrink-0 cursor-pointer items-center gap-1.5 border border-hairline px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                >
                  <FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />
                  Browse
                </button>
              </div>
              <p className="mt-1.5 font-display text-[12px] italic leading-relaxed text-sand">
                Moves this chat's transcript so it resumes in the new directory. Type a path, browse,
                or pick a directory Claude already knows below.
              </p>
            </div>

            {/* existing directories Claude already has sessions in */}
            <div className="no-scrollbar mt-2 min-h-[6rem] flex-1 overflow-y-auto border border-hairline-s">
              {dirGroups.filter((d) => d.cwd && !samePathLoose(d.cwd, moveDirFor.cwd)).length === 0 ? (
                <p className="px-3 py-3 font-display text-[13px] italic text-sand-dim">
                  No other known directories — type a path above.
                </p>
              ) : (
                dirGroups
                  .filter((d) => d.cwd && !samePathLoose(d.cwd, moveDirFor.cwd))
                  .map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => setMoveTo(d.cwd)}
                      className={`group flex w-full items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left transition-colors duration-150 last:border-b-0 hover:bg-surface-2/50 ${
                        moveTo.trim() === d.cwd ? 'bg-surface-2/40' : ''
                      }`}
                    >
                      <FolderGit2
                        className="h-3.5 w-3.5 shrink-0 text-sand-dim transition-colors duration-150 group-hover:text-brass"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11px] uppercase tracking-[0.06em] text-parchment">
                          {baseName(d.cwd) || d.folder}
                        </span>
                        <span className="block truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                          {d.cwd}
                        </span>
                      </span>
                    </button>
                  ))
              )}
            </div>

            {moveError !== null && (
              <p
                role="alert"
                className="mt-3 border border-brass px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-brass"
              >
                {moveError}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-3 border-t border-hairline-s pt-4">
              <button
                type="button"
                onClick={() => setMoveDirFor(null)}
                className="mo-ticks cursor-pointer border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitMove(moveTo)}
                disabled={moving || moveTo.trim() === ''}
                className="mo-button disabled:cursor-not-allowed disabled:opacity-50"
              >
                {moving ? 'Moving…' : 'Move here'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* folder browser for "Change directory" (sibling so its scrim click can't
          bubble to the change-directory modal behind it) */}
      <FolderPicker
        open={movePickerOpen && moveDirFor !== null}
        initialPath={moveTo || moveDirFor?.cwd || ''}
        onPick={(p) => {
          setMoveTo(p)
          setMovePickerOpen(false)
        }}
        onClose={() => setMovePickerOpen(false)}
      />

      {/* — "Add chat" modal: existing chat (search the whole machine) or a new
            chat started in a picked directory, auto-joined to the group — */}
      {addChatGroup !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={() => setAddChatFor(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Add chat to ${addChatGroup.name}`}
            style={{ background: 'var(--color-surface)' }}
            className="mo-card flex max-h-[85vh] w-full max-w-2xl flex-col shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Add Chat
                </div>
                <h2 className="mt-2 font-display text-[24px] font-medium leading-tight text-parchment">
                  Add to <em className="font-normal italic text-brass">{addChatGroup.name}</em>
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setAddChatFor(null)}
                aria-label="Close"
                className="mo-ticks flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* mode toggle */}
            <div className="mt-5 flex border border-hairline">
              {(
                [
                  ['existing', 'Existing'],
                  ['new', 'New'],
                  ['byid', 'By ID'],
                ] as const
              ).map(([value, label], i) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={addMode === value}
                  onClick={() => {
                    setAddMode(value)
                    setAddQuery('')
                  }}
                  className={`flex-1 cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200 ${
                    i > 0 ? 'border-l border-hairline' : ''
                  } ${addMode === value ? 'bg-brass text-midnight' : 'text-sand hover:text-brass'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* search (Existing / New modes) */}
            {addMode !== 'byid' && (
            <div className="mt-3 flex items-center gap-2 border border-hairline px-3">
              <Search className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
              <input
                type="text"
                value={addQuery}
                autoFocus
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder={
                  addMode === 'existing'
                    ? 'Search chats by name, path & content…'
                    : 'Search directories, or type a full path…'
                }
                spellCheck={false}
                className="w-full bg-transparent py-2 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none"
              />
            </div>
            )}

            {addMode === 'byid' ? (
              <div className="mt-4 space-y-4">
                <div>
                  <label
                    htmlFor="add-sid"
                    className="block font-mono text-[10px] uppercase tracking-[0.22em] text-sand"
                  >
                    Session ID
                  </label>
                  <input
                    id="add-sid"
                    type="text"
                    autoFocus
                    value={addSessionId}
                    onChange={(e) => setAddSessionId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addBySessionId()
                    }}
                    placeholder="0e1de3e8-b072-4a7a-ae5a-98ba4880bafa"
                    spellCheck={false}
                    className="mt-2 w-full border border-hairline bg-transparent px-3 py-2.5 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none transition-colors duration-200 focus:border-brass"
                  />
                </div>
                <div>
                  <label
                    htmlFor="add-cdir"
                    className="block font-mono text-[10px] uppercase tracking-[0.22em] text-sand"
                  >
                    Claude projects directory
                  </label>
                  <input
                    id="add-cdir"
                    type="text"
                    value={addClaudeDir}
                    onChange={(e) => setAddClaudeDir(e.target.value)}
                    placeholder={defaultProjectsDir || 'C:\\Users\\you\\.claude\\projects'}
                    spellCheck={false}
                    className="mt-2 w-full border border-hairline bg-transparent px-3 py-2.5 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none transition-colors duration-200 focus:border-brass"
                  />
                  <p className="mt-1.5 font-display text-[12px] italic leading-relaxed text-sand">
                    Where to look up the id — the folder that holds your session folders. Defaults to
                    the global <span className="font-mono not-italic text-sand-dim">.claude\projects</span>.
                  </p>
                </div>
                <button type="button" onClick={() => void addBySessionId()} className="mo-button w-full">
                  Add by ID
                </button>
              </div>
            ) : (
            <div className="no-scrollbar mt-1 min-h-[12rem] flex-1 overflow-y-auto border border-hairline-s">
              {addMode === 'existing' ? (
                (() => {
                  const q = addQuery.trim().toLowerCase()
                  const inGroup = new Set(addChatGroup.chats.map((c) => c.sessionId))
                  const list = (computerSessions ?? []).filter(
                    (s) =>
                      q === '' ||
                      s.summary.toLowerCase().includes(q) ||
                      s.cwd.toLowerCase().includes(q) ||
                      s.sessionId.startsWith(q) ||
                      addContentHits.has(s.sessionId),
                  )
                  if (list.length === 0)
                    return (
                      <p className="px-3 py-3 font-display text-[13px] italic text-sand-dim">
                        {addSearching ? 'Searching content…' : 'No matches.'}
                      </p>
                    )
                  return list.map((s) => {
                    const added = inGroup.has(s.sessionId)
                    return (
                      <button
                        key={`${s.folder}/${s.sessionId}`}
                        type="button"
                        disabled={added}
                        onClick={() => onAddChatToGroup(addChatGroup.id, s.sessionId, s.cwd)}
                        className="group flex w-full items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left transition-colors duration-150 last:border-b-0 enabled:cursor-pointer enabled:hover:bg-surface-2/50 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[11px] uppercase tracking-[0.06em] text-parchment">
                            {s.summary || 'Untitled session'}
                          </span>
                          <span className="block truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                            {s.messageCount} msg{s.messageCount === 1 ? '' : 's'} ·{' '}
                            {relativeTime(s.lastActive)} · {shortPath(s.cwd) || s.folder}
                          </span>
                        </span>
                        {added ? (
                          <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-brass">
                            <Check className="h-3 w-3" aria-hidden="true" />
                            added
                          </span>
                        ) : (
                          <Plus
                            className="h-3.5 w-3.5 shrink-0 text-sand-dim transition-colors duration-150 group-enabled:group-hover:text-brass"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    )
                  })
                })()
              ) : (
                (() => {
                  const q = addQuery.trim()
                  const ql = q.toLowerCase()
                  const list = dirGroups.filter(
                    (d) => ql === '' || d.cwd.toLowerCase().includes(ql),
                  )
                  // only offer "new chat here" for an absolute path (drive, UNC, posix, ~)
                  const typedPath = /^([A-Za-z]:[\\/]|\\\\|\/|~)/.test(q) ? q : ''
                  return (
                    <>
                      {typedPath !== '' && (
                        <button
                          type="button"
                          onClick={() => void startNewChatInDir(typedPath)}
                          className="flex w-full cursor-pointer items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left transition-colors duration-150 hover:bg-surface-2/50"
                        >
                          <Plus className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[11px] uppercase tracking-[0.06em] text-brass">
                              New chat in this path
                            </span>
                            <span className="block truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                              {typedPath}
                            </span>
                          </span>
                        </button>
                      )}
                      {list.length === 0 && typedPath === '' ? (
                        <p className="px-3 py-3 font-display text-[13px] italic text-sand-dim">
                          No known directories — type a full path above.
                        </p>
                      ) : (
                        list.map((d) => (
                          <button
                            key={d.key}
                            type="button"
                            onClick={() => void startNewChatInDir(d.cwd || d.folder)}
                            className="group flex w-full items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left transition-colors duration-150 last:border-b-0 hover:bg-surface-2/50"
                          >
                            <FolderGit2
                              className="h-3.5 w-3.5 shrink-0 text-sand-dim transition-colors duration-150 group-hover:text-brass"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-[11px] uppercase tracking-[0.06em] text-parchment">
                                {baseName(d.cwd) || d.folder}
                              </span>
                              <span className="block truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                                {d.cwd || d.folder}
                              </span>
                            </span>
                            <span className="shrink-0 font-mono text-[9px] text-sand-dim">
                              {d.sessions.length}
                            </span>
                          </button>
                        ))
                      )}
                    </>
                  )
                })()
              )}
            </div>
            )}

            {addError !== null ? (
              <p
                role="alert"
                className="mt-3 border border-brass px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-brass"
              >
                {addError}
              </p>
            ) : (
              <p className="mt-3 font-display text-[12px] italic leading-relaxed text-sand">
                {addMode === 'existing'
                  ? 'Pick any chat on this computer — it keeps its own directory.'
                  : addMode === 'new'
                    ? 'A fresh claude session starts in the picked directory and joins this project.'
                    : 'Paste a session id and the directory it lives in; it joins this project keeping its own cwd.'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* — right-click context menu (rename / copy id / terminate) — */}
      {/* — Attach a floor. A floor-level action, on the floor's own menu, in a
           dialog that says plainly it cannot be undone — because the server
           will not let it be. — */}
      {attachFloorId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={() => {
            setAttachFloorId(null)
            setAttachError(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Attach this floor"
            style={{ background: 'var(--color-surface)' }}
            className="mo-card w-full max-w-xl shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="border-b border-hairline px-5 py-3.5 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
              Attach “{floors.find((f) => f.id === attachFloorId)?.name ?? 'floor'}”
            </header>
            <div className="px-5 py-4">
              <p className="mb-4 font-display text-[13px] leading-relaxed text-sand">
                Pick what this floor works on. Its agents are briefed on this board, so
                it <strong className="text-parchment">cannot be changed afterwards</strong> —
                a different board means a different floor.
              </p>
              <ScopePicker
                scopes={crmScopes ?? []}
                value={null}
                onChange={(next) => {
                  const id = attachFloorId
                  setAttaching(true)
                  setAttachError(null)
                  onAttachFloorScope(id, next)
                    .then(() => setAttachFloorId(null))
                    .catch((e) =>
                      setAttachError(e?.message || 'the server refused the attachment'),
                    )
                    .finally(() => setAttaching(false))
                }}
              />
              {crmScopes === null && (
                <p className="mt-3 font-display text-[12px] italic text-sand-dim">
                  Loading what is available in the CRM…
                </p>
              )}
              {attaching && (
                <p className="mt-3 font-display text-[12px] italic text-sand-dim">Attaching…</p>
              )}
              {attachError !== null && (
                <p className="mt-3 border border-brass/40 bg-brass/5 px-3 py-2 font-display text-[12px] leading-relaxed text-parchment">
                  Not attached — {attachError}
                </p>
              )}
            </div>
            <footer className="flex justify-end border-t border-hairline px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  setAttachFloorId(null)
                  setAttachError(null)
                }}
                className="cursor-pointer border border-hairline px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Cancel
              </button>
            </footer>
          </div>
        </div>
      )}

      {menu !== null && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[12rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.target.kind === 'floor' && (
            <>
              {/* Attaching is a FLOOR action, so it lives on the floor's own
                  menu. Offered only while unattached — the attachment is
                  write-once and the server refuses a second one, so showing the
                  item on an attached floor would only teach the rule by 409. */}
              {(() => {
                const t = menu.target
                if (t.kind !== 'floor') return null
                const f = floors.find((x) => x.id === t.floorId)
                if (!f || f.crmScope) return null
                /* Workflow floors only. An agents-kind floor opens as a bare
                   design canvas with no Kanban tab, so a board attached to one
                   would be invisible — and the attachment is write-once, which
                   makes offering it there a trap rather than a spare option. */
                if (f.kind !== 'workflow') return null
                return (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAttachFloorId(t.floorId)
                      setMenu(null)
                    }}
                    className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
                  >
                    <Link2 className="h-3 w-3" aria-hidden="true" />
                    Attach to…
                  </button>
                )
              })()}
              <button
                type="button"
                role="menuitem"
                onClick={() => startRename(menu.target)}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Rename floor
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  /* narrow into a local: `menu` is state, so TS re-widens
                     menu.target on every access inside the closure */
                  const t = menu.target
                  if (t.kind === 'floor') {
                    const f = floors.find((x) => x.id === t.floorId)
                    if (f) onOpenFloor(f)
                  }
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <PenTool className="h-3 w-3" aria-hidden="true" />
                Open design
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'floor') onDeleteFloor(menu.target.floorId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete floor
              </button>
            </>
          )}
          {menu.target.kind === 'project' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'project') onEditProject(menu.target.projectId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Edit project…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'project') void navigator.clipboard?.writeText(menu.target.projectId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                Copy project id
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'project') onRevealDir(menu.target.projectId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <FolderOpen className="h-3 w-3" aria-hidden="true" />
                Open project directory
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'project') onDeleteProject(menu.target.projectId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-[#cf6b52]/12 hover:text-[#cf6b52]"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete project
              </button>
              <div className="mt-1 truncate px-3 pt-1 font-mono text-[9px] tracking-[0.08em] text-sand-dim">
                {menu.target.projectId}
              </div>
            </>
          )}
          {menu.target.kind === 'session' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => startRename(menu.target)}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Rename chat
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'session')
                    onChangeSessionId(menu.target.projectId, menu.target.sessionId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Hash className="h-3 w-3" aria-hidden="true" />
                Change session id…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const sid = menu.target.kind === 'session' ? menu.target.sessionId : ''
                  void navigator.clipboard?.writeText(sid)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                Copy session id
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'session') {
                    onTerminateSession(menu.target.projectId, menu.target.sessionId)
                  }
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Power className="h-3 w-3" aria-hidden="true" />
                Terminate terminal
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'session') {
                    onDeleteSession(menu.target.projectId, menu.target.sessionId)
                  }
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-[#cf6b52]/12 hover:text-[#cf6b52]"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete chat
              </button>
            </>
          )}
          {menu.target.kind === 'group' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group') onShowGroup(menu.target.groupId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Info className="h-3 w-3" aria-hidden="true" />
                Project details
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group') onEditGroup(menu.target.groupId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
                Edit project…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => startRename(menu.target)}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Rename project
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group') onDeleteGroup(menu.target.groupId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-[#cf6b52]/12 hover:text-[#cf6b52]"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete project
              </button>
            </>
          )}
          {menu.target.kind === 'group-chat' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    setViewContentFor({
                      sessionId: menu.target.sessionId,
                      cwd: menu.target.cwd,
                      title: menu.target.current,
                    })
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Eye className="h-3 w-3" aria-hidden="true" />
                View
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    onOpenGroupChat(
                      { sessionId: menu.target.sessionId, cwd: menu.target.cwd },
                      'chat',
                    )
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                Chat view
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => startRename(menu.target)}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Rename chat
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    onChangeGroupChatSession(
                      menu.target.groupId,
                      menu.target.cwd,
                      menu.target.sessionId,
                    )
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Hash className="h-3 w-3" aria-hidden="true" />
                Change session id…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    setMoveDirFor({
                      sessionId: menu.target.sessionId,
                      cwd: menu.target.cwd,
                      groupId: menu.target.groupId,
                      title: menu.target.current,
                    })
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <FolderInput className="h-3 w-3" aria-hidden="true" />
                Change directory…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const sid = menu.target.kind === 'group-chat' ? menu.target.sessionId : ''
                  void navigator.clipboard?.writeText(sid)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                Copy session id
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    void api
                      .revealSessionJsonl(menu.target.cwd, menu.target.sessionId)
                      .catch(() => {})
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <FolderOpen className="h-3 w-3" aria-hidden="true" />
                Open jsonl in file explorer
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    void api
                      .runCommand(
                      menu.target.cwd,
                      `claude --resume ${menu.target.sessionId} --dangerously-skip-permissions`,
                    )
                      .catch(() => {})
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <TerminalIcon className="h-3 w-3" aria-hidden="true" />
                Open in external terminal
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    onTerminateChat(menu.target.cwd, menu.target.sessionId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Power className="h-3 w-3" aria-hidden="true" />
                Terminate terminal
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'group-chat')
                    onRemoveChatFromGroup(menu.target.groupId, menu.target.sessionId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-[#cf6b52]/12 hover:text-[#cf6b52]"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Remove from project
              </button>
              {menu.target.kind === 'group-chat' &&
                chatDetails(menu.target.cwd, menu.target.sessionId)}
            </>
          )}
          {menu.target.kind === 'add' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add')
                    setViewContentFor({
                      sessionId: menu.target.sessionId,
                      cwd: menu.target.cwd,
                      title: menu.target.current || 'Untitled session',
                    })
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Eye className="h-3 w-3" aria-hidden="true" />
                View
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add') {
                    const sid = menu.target.sessionId
                    const full = sessionById.get(sid)
                    onOpenComputerSession(
                      full ?? {
                        sessionId: sid,
                        summary: menu.target.current,
                        lastActive: '',
                        messageCount: 0,
                        cwd: menu.target.cwd,
                        folder: '',
                        projectId: null,
                        projectName: null,
                      },
                      'chat',
                    )
                  }
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                Chat view
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add')
                    setMoveDirFor({
                      sessionId: menu.target.sessionId,
                      cwd: menu.target.cwd,
                      groupId: null,
                      title: menu.target.current || 'Untitled session',
                    })
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <FolderInput className="h-3 w-3" aria-hidden="true" />
                Change directory…
              </button>
              <div className="px-3 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
                Add to group
              </div>
              {/* ordinary projects only — a workflow-project's membership is
                  written by a run, never by hand from a loose chat */}
              {projectGroups.length === 0 && (
                <div className="px-3 py-2 font-display text-[12px] italic text-sand-dim">
                  No groups yet
                </div>
              )}
              {projectGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (menu.target.kind === 'add')
                      onAddChatToGroup(g.id, menu.target.sessionId, menu.target.cwd)
                    setMenu(null)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
                >
                  <FolderGit2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{g.name}</span>
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add')
                    onNewGroup({ sessionId: menu.target.sessionId, cwd: menu.target.cwd })
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-brass transition-colors duration-150 hover:bg-surface-2/50"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                New group
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add')
                    void api
                      .revealSessionJsonl(menu.target.cwd, menu.target.sessionId)
                      .catch(() => {})
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <FolderOpen className="h-3 w-3" aria-hidden="true" />
                Open jsonl in file explorer
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add')
                    void api
                      .runCommand(
                      menu.target.cwd,
                      `claude --resume ${menu.target.sessionId} --dangerously-skip-permissions`,
                    )
                      .catch(() => {})
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <TerminalIcon className="h-3 w-3" aria-hidden="true" />
                Open in external terminal
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (menu.target.kind === 'add')
                    onTerminateChat(menu.target.cwd, menu.target.sessionId)
                  setMenu(null)
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
              >
                <Power className="h-3 w-3" aria-hidden="true" />
                Terminate terminal
              </button>
              {menu.target.kind === 'add' && chatDetails(menu.target.cwd, menu.target.sessionId)}
            </>
          )}
          {menu.target.kind === 'session' && (
            <div className="mt-1 truncate border-t border-hairline-s px-3 pt-1.5 font-mono text-[9px] tracking-[0.08em] text-sand-dim">
              {menu.target.sessionId}
            </div>
          )}
        </div>
      )}
    </motion.aside>
  )
}
