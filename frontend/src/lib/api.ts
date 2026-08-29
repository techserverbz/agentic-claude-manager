/**
 * api — typed REST client for the Christopher OS server (port 4000,
 * proxied through Vite at /api). Mirrors the locked API contract.
 */

export interface AppConfig {
  globalClaudeDir: string
  home: string
}

export interface SessionMeta {
  id: string
  summary: string
  lastActive: string
  messageCount: number
}

export interface Project {
  id: string
  name: string
  fileDir: string
  claudeDir: string
  isDefaultClaudeDir: boolean
  createdAt: string
  /** hidden "loose" project — opened from the global list, not shown under Projects */
  ephemeral: boolean
  /** sorted newest first by the server */
  sessions: SessionMeta[]
}

/** one Claude session JSONL anywhere on the machine (the "This computer" tab) */
export interface ComputerSession {
  sessionId: string
  summary: string
  lastActive: string
  messageCount: number
  /** the real working directory this session ran in (recovered from the JSONL) */
  cwd: string
  folder: string
  /** the registered project that owns this cwd, or null if the session is "loose" */
  projectId: string | null
  projectName: string | null
}

/** result of checking GitHub for a newer version of the app */
export interface UpdateCheck {
  ok: boolean
  /** present when ok: true */
  upToDate?: boolean
  behind?: number
  ahead?: number
  branch?: string
  localCommit?: string
  remoteCommit?: string
  latestSubject?: string
  remoteUrl?: string
  checkedAt?: string
  /** present when ok: false (not a git repo, offline, etc.) */
  error?: string
}

/** a chat reference inside a Project group — keeps its OWN claude cwd */
export interface GroupChat {
  sessionId: string
  cwd: string
}

/** a reference working directory on a project — NOT the Claude config dir.
    `commands` are zero or more terminal quick-launches runnable in this directory. */
export interface GroupDirectory {
  path: string
  commands: string[]
}

/** a listening TCP port in use, with its owning process (Settings → Ports) */
export interface PortInfo {
  port: number
  pid: number
  name: string
  address: string
  /** true when this is Christopher's own server process (stop is disabled) */
  isSelf: boolean
}

/** a "Project" in the new model: a dir-less named collection of chats, plus its
    own optional reference metadata (one or more working `directories` that are
    NOT the Claude config dir, a free-text `description`, and a `color` label) */
export interface ChatGroup {
  id: string
  name: string
  createdAt: string
  /** which of the two SEPARATE lists this belongs to. A workflow-project's chats
      are private to the Project Workflows view — a run's father and step sessions
      must never surface in the ordinary Projects list or open a workspace tab —
      so the split is carried by a field rather than left to a naming convention
      the user would have to keep. Groups written before the split have no kind on
      disk and the server hydrates them as 'project', which is why every existing
      project stays exactly where its owner left it. */
  kind: 'project' | 'workflow'
  chats: GroupChat[]
  directories: GroupDirectory[]
  description: string
  color: string
  /** the workflow TEMPLATES this project carries. A template is reusable across
      projects — the same Feasibility SOP hangs off two sites — so attachment is
      a list of ids here rather than a groupId on the workflow. (Workflow.groupId
      still exists, but it records where an import came FROM, nothing more.) */
  workflowIds: string[]
}

/** one Excalidraw canvas file (from the canvas app's file API) */
export interface CanvasFile {
  name: string
  modified: string
  size: number
}

/** a canvas file group (collapsible colored section), mirroring the canvas app */
export interface CanvasGroup {
  id: string
  name: string
  color: string
  collapsed: boolean
  files: string[]
}

export interface ToolUse {
  name: string
  input: unknown
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  toolUse?: ToolUse[]
}

export interface CreateProjectInput {
  name: string
  fileDir: string
  claudeDir?: string
}

/** a directory Claude already has sessions for (under ~/.claude/projects) */
export interface DiscoveredProject {
  fileDir: string
  name: string
  sessionCount: number
  lastActive: string
  registered: boolean
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError('The observatory is unreachable — is the server lit?', 0)
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body — fall through to status handling */
  }

  if (!res.ok) {
    const message =
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${res.status})`
    throw new ApiError(message, res.status)
  }

  return body as T
}

/** one installed Claude Code skill, discovered on disk */
export interface Skill {
  name: string
  description: string
  scope: 'user' | 'project' | 'plugin'
  /** absolute path to the skill folder */
  dir: string
  /** for scope 'project', the project it belongs to */
  project?: string
}

/** one configured MCP server. Env VALUES never cross this boundary — only names. */
export interface McpServer {
  name: string
  transport: string
  command: string
  args: string[]
  scope: 'user' | 'project'
  project?: string
  /** the NAMES of configured env vars; values are never sent to the browser */
  envKeys: string[]
}

/** one node on a floor — a ROLE you define, not a running session */
export interface FloorAgent {
  id: string
  name: string
  role: string
  /** the top of the chart; a floor has exactly one */
  isBoss: boolean
  /** who this reports to; null = top. The server repairs dangling links + cycles. */
  reportsTo: string | null
  /** the agent brief, markdown — the .md each agent carries */
  md: string
  /** the CRM user this agent is the AI for; null when it maps to nobody */
  crmUserId?: string | null
  /** the chat this agent is bound to. Absent on every floor written before
      agent chats existed, so it is optional and reads as "no chat yet". */
  sessionId?: string | null
  /** pin a model for sessions spawned as this agent; '' inherits the CLI default */
  model: '' | 'opus' | 'sonnet' | 'haiku'
  /** skill NAMES this agent may use (resolved against the installed skills) */
  skills: string[]
  /** MCP server NAMES this agent may reach */
  mcpServers: string[]
  x: number
  y: number
}

/** an org chart of agent roles — a blueprint, not a set of live processes */
/** One note in a floor's shared memory, as the server attributes it. */
export interface MemoryEntry {
  id: string
  ts: string
  text: string
  tags: string[]
  sessionId: string | null
  /** display name of whoever saved it: an agent, "You", or "Another chat" */
  author: string
  /** when the note has been edited since it was written; null otherwise */
  editedAt: string | null
  /** the floor agent that saved it, when it was one of this floor's */
  byAgent: string | null
  isHuman: boolean
}

export interface Floor {
  id: string
  name: string
  /** which canvas it belongs to: the Agents chart, or the Agents Workflow one.
      Two separate lists over one store — a floor written before the split reads
      back as 'agents', so nothing moves. */
  kind: 'agents' | 'workflow'
  /** what this floor is working on, in the CRM's own terms. null = unattached. */
  crmScope?: { targetType: string; targetId: string | null } | null
  /** What every agent on this floor is told before anything else — added
      after the first release, so a floor written before it reads back as an
      empty string rather than being absent. Typically: which codebase this
      floor works in. */
  globalPrompt?: string
  /** the project this floor's chats run in: its code directory (the pty's
      cwd) and its own .claude folder (CLAUDE_CONFIG_DIR, so per-workflow
      hooks). null = fall back to whatever project is selected, which is the
      old behaviour and the reason agents could start in the wrong repo. */
  workspaceProjectId?: string | null
  createdAt: string
  updatedAt: string
  agents: FloorAgent[]
}

/** where a step's work came from, when it was imported rather than authored */
export interface WorkflowStepSource {
  nodeId: string | null
  /** the SOP the step came from — differs from the workflow's own for expanded references */
  originSopId: string | null
}

/** one step of a workflow.
 *
 *  `kind: 'stage'` is a container: it is never dispatched to a session and its
 *  status is derived from its children. The server forces any step that has
 *  children to be a stage, so this is never something the UI has to police. */
export interface WorkflowStep {
  id: string
  /** position in the depth-first pre-order walk; the server renumbers it */
  ord: number
  parentId: string | null
  kind: 'step' | 'stage'
  title: string
  summary: string
  /** THE TUTORIAL — the markdown a spawned session is briefed with */
  brief: string
  category: string
  estimatedMinutes: number | null
  /** step ids that must finish first; the server cuts cycles */
  dependsOn: string[]
  /** which floor agent does this — the persona the session wears */
  agentRef: { floorId: string; agentId: string } | null
  crmAssignee: { type: string; id: string | null } | null
  refs: {
    kind: string
    wpageId: string | null
    headingId: string | null
    headingText: string
    pageSlug: string
    capturedAt: string | null
  }[]
  attachments: { fileId: string; name: string; url: string }[]
  source: WorkflowStepSource | null
}

/** a workflow TEMPLATE: an ordered tree of steps, each with its tutorial.
 *  Instantiate it into a run to get real sessions. */
export interface Workflow {
  id: string
  /** the chat group this belongs to — the user-facing "project" */
  groupId: string | null
  name: string
  description: string
  /** context for the father chat (Michael) — knowledge that belongs to no step */
  brief: string
  /** bumped by a step edit or a re-import; a run pins the version it started from */
  version: number
  source: {
    kind: 'crm-sop'
    baseUrl: string
    sopId: string | null
    familyId: string | null
    sopVersion: number | null
    importedAt: string
  } | null
  defaultFloorId: string | null
  createdAt: string
  updatedAt: string
  steps: WorkflowStep[]
}

/** one step of a RUN. It is a SNAPSHOT of the template step taken at start —
 *  title, kind, ord and all — plus the binding to the real session doing it.
 *  That snapshot is what makes "template edits never touch a live run" true:
 *  a step deleted from the template still stands on the board of a run that is
 *  going. */
export interface WorkflowRunStep {
  stepId: string
  title: string
  ord: number
  parentId: string | null
  kind: 'step' | 'stage'
  /** a stage's status is DERIVED from its children on every read, never set
   *  directly — a container nobody can complete is how the CRM ends up with
   *  runs that can never reach 100% */
  status: 'pending' | 'dispatched' | 'in-progress' | 'review' | 'done' | 'blocked' | 'skipped'
  /** when a person signed the step off; null while it sits in review */
  acceptedAt?: string | null
  /** the chat doing this step; null until it is dispatched */
  sessionId: string | null
  /** the markdown brief written for that session */
  briefPath: string | null
  /** the session that ordered this step — the father, usually */
  dispatchedBy: string | null
  dispatchedAt: string | null
  startedAt: string | null
  doneAt: string | null
  /** what the step reported back when it finished */
  result: string | null
  blockedReason: string | null
  /** computed per request, never stored: a pty can be reaped while the
   *  transcript lives on, so liveness is a fact about right now rather than
   *  about the run. Absent on the envelopes that do not compute it (the two
   *  status routes return the bare stored run), hence optional. */
  live?: boolean
}

/**
 * One recorded movement of work inside a run — the dispatch tree as HISTORY
 * rather than as current state (plan item 12).
 *
 * `WorkflowRunStep.dispatchedBy` is the same question asked of the present: it
 * says who most recently dispatched a step and is overwritten the next time
 * anyone does. These edges are append-only, so they keep the ORDER, they keep a
 * step messaging another step directly, and they keep both dispatches of a step
 * that was handed out twice. Every one is stamped server-side from the caller's
 * derived identity — a session cannot write an edge crediting somebody else.
 */
export interface DispatchEdge {
  id: string
  ts: string
  kind: 'dispatch' | 'message' | 'broadcast' | 'report' | 'block' | 'note' | 'spawn' | 'complete'
  /** who moved the work; null means the human, or the server itself */
  fromSessionId: string | null
  /** who received it; null for a broadcast, which has no single target */
  toSessionId: string | null
  /** the step this concerns, when it concerns one */
  stepId: string | null
  text: string
  /** kind-specific extras — `sentTo` on a broadcast, `force` on a dispatch */
  meta: Record<string, unknown>
}

/** one RUN of a workflow template: the father chat, the per-step sessions and
 *  where each of them has got to. */
export interface WorkflowRun {
  id: string
  workflowId: string
  /** the template version pinned at start; later edits to the template do not
      reach a run that is already going */
  workflowVersion: number
  /** the PROJECT (chat group) this run belongs to — also its sibling-visibility
      scope, so two runs of one template cannot see into each other */
  groupId: string | null
  /** the DIRECTORY project the sessions cwd into — not the same thing as groupId */
  projectId: string | null
  name: string
  status: 'running' | 'paused' | 'done' | 'cancelled'
  fatherSessionId: string | null
  fatherBriefPath: string | null
  startedAt: string
  endedAt: string | null
  steps: WorkflowRunStep[]
  /** computed per request. Stages are left out of both numbers, and a skipped
   *  step counts as done while STAYING in the denominator — one pair of numbers
   *  that cannot disagree with itself the way the CRM's "3/7 · 80%" does.
   *  Optional because the status routes return the run without it. */
  progress?: { done: number; total: number }
  /** computed per request, exactly like step.live */
  fatherLive?: boolean
}

export const api = {
  getConfig(): Promise<AppConfig> {
    return request<AppConfig>('/api/config')
  },

  async getProjects(): Promise<Project[]> {
    const { projects } = await request<{ projects: Project[] }>('/api/projects')
    return projects
  },

  /** directories Claude has worked in (for the "pick existing project" picker) */
  async discoverProjects(): Promise<DiscoveredProject[]> {
    const { discovered } = await request<{ discovered: DiscoveredProject[] }>(
      '/api/discover-projects',
    )
    return discovered
  },

  /** list the Excalidraw canvas files (proxied from the canvas app on 4811);
      `running` is false when the canvas app isn't up yet */
  async getCanvasFiles(): Promise<{ running: boolean; files: CanvasFile[] }> {
    const res = await request<{ running?: boolean; files?: CanvasFile[] }>('/api/canvas/files')
    return { running: res.running === true, files: Array.isArray(res.files) ? res.files : [] }
  },

  /** launch the bundled Excalidraw canvas app (when it isn't running) */
  async startCanvas(): Promise<void> {
    await request('/api/canvas/start', { method: 'POST' })
  },

  /** create a new (empty) canvas file; returns the sanitized name the server used */
  async createCanvasFile(name: string): Promise<string> {
    const res = await request<{ name?: string }>(
      `/api/canvas/files/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      },
    )
    return res.name || name
  },

  /** canvas file groups (collapsible sections), mirroring the canvas app sidebar */
  async getCanvasGroups(): Promise<CanvasGroup[]> {
    const { groups } = await request<{ groups?: CanvasGroup[] }>('/api/canvas/groups')
    return Array.isArray(groups) ? groups : []
  },
  /** search canvas files by their TYPED CONTENT (text elements, bound labels,
      frame names); returns the names of files whose content contains the query */
  async searchCanvasContent(q: string): Promise<string[]> {
    const res = await request<{ matches?: string[] }>(
      `/api/canvas/file-search?q=${encodeURIComponent(q)}`,
    )
    return Array.isArray(res.matches) ? res.matches : []
  },
  /** persist the global canvas file order after a drag-reorder */
  async reorderCanvasFiles(order: string[]): Promise<void> {
    await request('/api/canvas/files/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
  },
  /** rename a canvas file; carries its order position, group membership and the
      MCP active-file pointer forward. Returns the sanitized name the server used */
  async renameCanvasFile(oldName: string, newName: string): Promise<string> {
    const res = await request<{ name?: string }>(
      `/api/canvas/files/${encodeURIComponent(oldName)}/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      },
    )
    return res.name || newName
  },
  /** delete a canvas file (the canvas server auto-backs it up first) */
  async deleteCanvasFile(name: string): Promise<void> {
    await request(`/api/canvas/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
  },
  /** set the MCP-active canvas file (what the canvas MCP tools operate on) */
  async setCanvasActive(name: string): Promise<void> {
    await request('/api/canvas/active-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  },
  async createCanvasGroup(name: string, color?: string): Promise<void> {
    await request('/api/canvas/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(color ? { name, color } : { name }),
    })
  },
  async updateCanvasGroup(
    id: string,
    input: { name?: string; color?: string; collapsed?: boolean },
  ): Promise<void> {
    await request(`/api/canvas/groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  },
  async deleteCanvasGroup(id: string): Promise<void> {
    await request(`/api/canvas/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  async moveCanvasFileToGroup(groupId: string, fileName: string): Promise<void> {
    await request(`/api/canvas/groups/${encodeURIComponent(groupId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName }),
    })
  },
  async removeCanvasFileFromGroup(groupId: string, fileName: string): Promise<void> {
    await request(
      `/api/canvas/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(fileName)}`,
      { method: 'DELETE' },
    )
  },

  /** every Claude session jsonl on this machine, newest first ("This computer") */
  async getAllSessions(): Promise<ComputerSession[]> {
    const { sessions } = await request<{ sessions: ComputerSession[] }>('/api/all-sessions')
    return sessions
  },

  /** check GitHub for a newer version of the app (git fetch + compare HEADs) */
  async checkUpdates(): Promise<UpdateCheck> {
    return request<UpdateCheck>('/api/updates/check')
  },

  /** search transcript CONTENT (reads the jsonl). Pass sessionIds to restrict the
      scan (Projects tab members); omit to search every session on the machine. */
  async searchContent(
    query: string,
    sessionIds?: string[],
  ): Promise<{ sessionId: string; snippet: string }[]> {
    const params = new URLSearchParams({ q: query })
    if (sessionIds && sessionIds.length > 0) params.set('sessionIds', sessionIds.join(','))
    const { matches } = await request<{ matches: { sessionId: string; snippet: string }[] }>(
      `/api/search-content?${params.toString()}`,
    )
    return matches
  },

  /** ensure a hidden "loose" project for a session's cwd; returns it (with sessions) */
  async openLooseSession(cwd: string): Promise<Project> {
    const { project } = await request<{ project: Project }>('/api/sessions/open-loose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    return project
  },

  // — Projects (dir-less chat groups) —

  /** Pass `kind` for one list only; omitting it returns both, which is what every
      caller written before the split does and must keep doing. */
  async getGroups(kind?: 'project' | 'workflow'): Promise<ChatGroup[]> {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : ''
    const { groups } = await request<{ groups: ChatGroup[] }>(`/api/groups${qs}`)
    return groups
  },
  /** `kind` is left OUT of the body when not given rather than sent as null, so
      the server's own 'project' default decides — the single-arg callers go on
      making ordinary projects. */
  async createGroup(name: string, kind?: 'project' | 'workflow'): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kind ? { name, kind } : { name }),
    })
    return group
  },
  async renameGroup(id: string, name: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return group
  },
  /** update a project's editable fields (name / directories / description / color) */
  async updateGroup(
    id: string,
    input: {
      name?: string
      directories?: GroupDirectory[]
      description?: string
      color?: string
    },
  ): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return group
  },
  deleteGroup(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  /** reorder projects (drag up/down) */
  async reorderGroups(order: string[]): Promise<void> {
    await request('/api/groups/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
  },
  async addChatToGroup(id: string, sessionId: string, cwd: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(
      `/api/groups/${encodeURIComponent(id)}/chats`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cwd }),
      },
    )
    return group
  },
  async removeChatFromGroup(id: string, sessionId: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(
      `/api/groups/${encodeURIComponent(id)}/chats/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    )
    return group
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { project } = await request<{ project: Project }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return project
  },

  /** unregisters only — never touches files on disk */
  deleteProject(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  async renameProject(id: string, name: string): Promise<Project> {
    const { project } = await request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    )
    return project
  },

  /** edit a project's name / file directory / Claude directory */
  async updateProject(
    id: string,
    input: { name?: string; fileDir?: string; claudeDir?: string },
  ): Promise<Project> {
    const { project } = await request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
    return project
  },

  /** sets a custom session title (empty string clears it) */
  async renameSession(projectId: string, sessionId: string, title: string): Promise<string> {
    const res = await request<{ title: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    )
    return res.title
  },

  /** rename a session by id alone (no project needed — used by Project chats) */
  async renameSessionById(sessionId: string, title: string): Promise<string> {
    const res = await request<{ title: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    )
    return res.title
  },

  /** terminate a chat's live shell by cwd (Project/Directory chats, no project id) */
  async terminateSessionByCwd(cwd: string, sessionId: string): Promise<boolean> {
    const res = await request<{ killed: boolean }>('/api/sessions/terminate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId }),
    })
    return res.killed
  },

  /** terminate a session's live shell (kills the pty + claude process) */
  async terminateSession(projectId: string, sessionId: string): Promise<boolean> {
    const res = await request<{ killed: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/terminate`,
      { method: 'POST' },
    )
    return res.killed
  },

  /** delete a session (soft delete — kills its shell, hides the transcript) */
  deleteSession(projectId: string, sessionId: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    )
  },

  /** open this project's working directory in the OS file manager */
  async revealProjectDir(id: string): Promise<string> {
    const res = await request<{ path: string }>(
      `/api/projects/${encodeURIComponent(id)}/reveal-dir`,
      { method: 'POST' },
    )
    return res.path
  },

  /** run a project directory's saved command in a new terminal window at that dir */
  async runCommand(dir: string, command: string): Promise<void> {
    await request('/api/run-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, command }),
    })
  },

  /** listening TCP ports in use, with the owning process (Settings → Ports) */
  async listPorts(): Promise<PortInfo[]> {
    const { ports } = await request<{ ports?: PortInfo[] }>('/api/ports')
    return Array.isArray(ports) ? ports : []
  },
  /** stop the process holding a port, by PID (refused for this app / system) */
  async killPort(pid: number): Promise<void> {
    await request('/api/ports/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
  },

  /** list sub-directories of a path (empty = drive list / root) — powers the
      in-app folder browser */
  async listDir(
    path: string,
  ): Promise<{ path: string; parent: string | null; entries: { name: string; path: string }[] }> {
    const params = new URLSearchParams({ path })
    return request(`/api/list-dir?${params.toString()}`)
  },

  /** create ONE folder inside `parent` and return its absolute path. The server
      validates the name and refuses anything that would land outside `parent`;
      the browser deliberately does not duplicate those rules, so there is one
      place they can be wrong rather than two. */
  async makeDir(parent: string, name: string): Promise<{ path: string }> {
    return request<{ path: string }>('/api/make-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name }),
    })
  },

  /** open a native folder picker (Windows) and return the chosen path (null if
      cancelled) — legacy fallback */
  async pickDirectory(initial?: string): Promise<string | null> {
    const { path } = await request<{ path: string | null }>('/api/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial: initial ?? '' }),
    })
    return path
  },

  /** open a chat's transcript (.jsonl) in the OS file manager, selected */
  async revealSessionJsonl(cwd: string, sessionId: string): Promise<string> {
    const res = await request<{ path: string }>('/api/sessions/reveal-jsonl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId }),
    })
    return res.path
  },

  /** open an arbitrary folder (e.g. a project's reference directory) in the OS */
  async revealPath(path: string): Promise<string> {
    const res = await request<{ path: string }>('/api/reveal-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    return res.path
  },

  async getMessages(projectId: string, sessionId: string): Promise<ChatMessage[]> {
    const { messages } = await request<{ messages: ChatMessage[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    )
    return messages
  },

  /** locate a session by id under a Claude projects dir (default global) + recover
      its cwd — powers "Add chat → By ID" */
  async resolveSession(
    sessionId: string,
    projectsDir?: string,
  ): Promise<{ sessionId: string; cwd: string; folder: string }> {
    const params = new URLSearchParams({ sessionId })
    if (projectsDir) params.set('projectsDir', projectsDir)
    const { session } = await request<{
      session: { sessionId: string; cwd: string; folder: string }
    }>(`/api/resolve-session?${params.toString()}`)
    return session
  },

  /** move a session transcript to another working directory (relocates the .jsonl
      so it resumes in the new dir) — powers per-chat "Change directory" */
  async moveSession(
    sessionId: string,
    fromCwd: string,
    toCwd: string,
  ): Promise<{ sessionId: string; cwd: string; folder: string }> {
    const { session } = await request<{
      session: { sessionId: string; cwd: string; folder: string }
    }>('/api/sessions/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, fromCwd, toCwd }),
    })
    return session
  },

  /** read a transcript by its cwd (no registered project) — the "View" quick-look */
  async getMessagesByCwd(cwd: string, sessionId: string): Promise<ChatMessage[]> {
    const params = new URLSearchParams({ cwd, sessionId })
    const { messages } = await request<{ messages: ChatMessage[] }>(
      `/api/session-messages?${params.toString()}`,
    )
    return messages
  },

  /** saved multipane layouts, persisted on this computer (server/data/views.json) */
  async getViews<T = unknown>(): Promise<T[]> {
    const { views } = await request<{ views: T[] }>('/api/views')
    return Array.isArray(views) ? views : []
  },

  async getSkills(): Promise<Skill[]> {
    const { skills } = await request<{ skills: Skill[] }>('/api/skills')
    return Array.isArray(skills) ? skills : []
  },

  async getMcpServers(): Promise<McpServer[]> {
    const { servers } = await request<{ servers: McpServer[] }>('/api/mcp')
    return Array.isArray(servers) ? servers : []
  },

  async getFloors(kind?: 'agents' | 'workflow'): Promise<Floor[]> {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : ''
    const { floors } = await request<{ floors: Floor[] }>(`/api/floors${qs}`)
    return Array.isArray(floors) ? floors : []
  },

  /** create a floor; it comes back with its boss already seated */
  async createFloor(name: string, kind?: 'agents' | 'workflow'): Promise<Floor> {
    const { floor } = await request<{ floor: Floor }>('/api/floors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // omit `kind` entirely when unset, so the server default decides
      body: JSON.stringify(kind ? { name, kind } : { name }),
    })
    return floor
  },

  /** The shared memory this floor's agents read and write. Scoped by project
   *  (that is the store their chats save into), attributed by floor. */
  async floorMemory(
    floorId: string,
    projectId: string,
    q = '',
  ): Promise<{ entries: MemoryEntry[]; project: { id: string; name: string } }> {
    const qs = new URLSearchParams({ projectId })
    if (q.trim() !== '') qs.set('q', q.trim())
    return request(`/api/floors/${floorId}/memory?${qs.toString()}`)
  },

  /** Add a note as the HUMAN — every agent on the floor finds it with
   *  memory_search, and it reads back attributed to you rather than to a chat. */
  async addFloorMemory(
    floorId: string,
    projectId: string,
    text: string,
    tags: string[] = [],
  ): Promise<MemoryEntry> {
    const { entry } = await request<{ entry: MemoryEntry }>(`/api/floors/${floorId}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, text, tags }),
    })
    return entry
  },

  /** Change a note's text. The author is preserved server-side — correcting an
   *  agent's note does not make it yours. */
  async editFloorMemory(
    floorId: string,
    projectId: string,
    id: string,
    text: string,
  ): Promise<MemoryEntry> {
    const { entry } = await request<{ entry: MemoryEntry }>(
      `/api/floors/${floorId}/memory/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, text }),
      },
    )
    return entry
  },

  /** Remove a note. Gone, not disabled — a wrong note agents keep finding is
   *  worse than no note. */
  async deleteFloorMemory(floorId: string, projectId: string, id: string): Promise<void> {
    await request(
      `/api/floors/${floorId}/memory/${id}?projectId=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    )
  },

  /** patch a floor; `agents` is a whole-array replace (the canvas owns it) */
  async updateFloor(
    id: string,
    patch: { name?: string; globalPrompt?: string; agents?: FloorAgent[] },
  ): Promise<Floor> {
    const { floor } = await request<{ floor: Floor }>(`/api/floors/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return floor
  },

  /** Which agents on this floor have actually written a .jsonl. claude
   *  creates one on the first exchange, not at spawn, so a freshly opened
   *  chat is online with nothing on disk behind it. */
  async getFloorTranscripts(
    floorId: string,
  ): Promise<{
    dir: string | null
    transcripts: Record<string, { exists: boolean; bytes: number; path: string | null }>
  }> {
    return request(`/api/floors/${floorId}/transcripts`)
  },

  /** Read one agent's transcript out of its FLOOR'S workspace. Not the same
   *  as getMessagesByCwd, which resolves against the global .claude — a
   *  workflow with its own config folder keeps its transcripts there. */
  async getFloorAgentMessages(
    floorId: string,
    agentId: string,
  ): Promise<{ messages: ChatMessage[]; sessionId: string; empty?: boolean }> {
    return request(`/api/floors/${floorId}/agents/${agentId}/messages`)
  },

  /** Open one of a floor's own paths in the OS file manager. The client names
   *  a KIND, never a path — the server derives every location from the
   *  floor's workspace. */
  async revealFloorPath(
    floorId: string,
    body: { what: 'code' | 'config' | 'settings' | 'hooks' | 'transcript'; sessionId?: string },
  ): Promise<{ path: string; note?: string }> {
    return request(`/api/floors/${floorId}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  /** What this workflow's own settings.json says, and whether the roster
   *  hook is in it. */
  async getFloorHooks(floorId: string): Promise<{
    configDir: string | null
    settingsPath: string | null
    settings: { hooks?: Record<string, unknown> } | null
    rosterHookInstalled: boolean
  }> {
    return request(`/api/floors/${floorId}/hooks`)
  },

  /** Write the SessionStart hook that tells every chat on this floor who
   *  its colleagues are, what their chat ids are, and where their .jsonl
   *  transcripts live. Replaces only its own entry. */
  async installRosterHook(
    floorId: string,
  ): Promise<{ settingsPath: string; scriptPath: string }> {
    return request(`/api/floors/${floorId}/hooks/roster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  },

  /** Give a floor its own folder: `codeDir` is what its agents work IN,
   *  `configDir` (default V2/workflows/<slug>/.claude) is where that
   *  workflow's settings.json and hooks live. Idempotent — call it again to
   *  repoint the floor. */
  async setFloorWorkspace(
    floorId: string,
    body: { codeDir: string; configDir?: string },
  ): Promise<{ floor: Floor; project: Project; settingsPath: string }> {
    return request<{ floor: Floor; project: Project; settingsPath: string }>(
      `/api/floors/${floorId}/workspace`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  },

  /** Open (or reuse) the chat bound to one agent on a floor. The server spawns
   *  it with that agent's brief when there isn't one yet. */
  async openAgentChat(
    floorId: string,
    agentId: string,
    projectId: string,
  ): Promise<{ sessionId: string; projectId: string; created: boolean }> {
    return request<{ sessionId: string; projectId: string; created: boolean }>(
      `/api/floors/${floorId}/agents/${agentId}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    )
  },

  /** Attach a floor to a CRM scope. WRITE-ONCE — the server answers 409 if the
   *  floor already carries one, and the message explains why. */
  async attachFloorScope(
    id: string,
    crmScope: { targetType: string; targetId: string | null },
  ): Promise<Floor> {
    const { floor } = await request<{ floor: Floor }>(`/api/floors/${id}/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crmScope }),
    })
    return floor
  },

  async deleteFloor(id: string): Promise<void> {
    await request<{ ok: true }>(`/api/floors/${id}`, { method: 'DELETE' })
  },

  // — WORKFLOWS: templates. Runs are a separate resource. —

  async getWorkflows(groupId?: string | null): Promise<Workflow[]> {
    const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''
    const { workflows } = await request<{ workflows: Workflow[] }>(`/api/workflows${qs}`)
    return Array.isArray(workflows) ? workflows : []
  },

  async getWorkflow(id: string): Promise<Workflow> {
    const { workflow } = await request<{ workflow: Workflow }>(`/api/workflows/${id}`)
    return workflow
  },

  async createWorkflow(input: {
    name: string
    description?: string
    brief?: string
    groupId?: string | null
    defaultFloorId?: string | null
    steps?: Partial<WorkflowStep>[]
  }): Promise<Workflow> {
    const { workflow } = await request<{ workflow: Workflow }>('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return workflow
  },

  /** patch a workflow; `steps` is a whole-array replace and bumps the version */
  async updateWorkflow(
    id: string,
    patch: {
      name?: string
      description?: string
      brief?: string
      groupId?: string | null
      defaultFloorId?: string | null
      steps?: Partial<WorkflowStep>[]
    },
  ): Promise<Workflow> {
    const { workflow } = await request<{ workflow: Workflow }>(`/api/workflows/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return workflow
  },

  async deleteWorkflow(id: string): Promise<void> {
    await request<{ ok: true }>(`/api/workflows/${id}`, { method: 'DELETE' })
  },

  /** Import a CRM SOP as a snapshot. Re-importing the same SOP family into the
   *  same group bumps that workflow's version instead of duplicating it —
   *  `reimported` says which happened. Slow: it calls another app's API. */
  async importCrmSop(input: {
    sopId: string
    groupId?: string | null
    baseUrl?: string
  }): Promise<{ workflow: Workflow; reimported: boolean }> {
    return request<{ workflow: Workflow; reimported: boolean }>(
      '/api/workflows/import/crm-sop',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
  },

  // — ATTACHMENT: which templates a project carries. Lives on the group because
  //   one template serves many projects. —

  /** idempotent — attaching the same template twice leaves one entry, so the UI
      never has to check first */
  async attachWorkflowToGroup(groupId: string, workflowId: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(
      `/api/groups/${encodeURIComponent(groupId)}/workflows`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      },
    )
    return group
  },

  /** detach only — the template itself, and any runs already started from it,
      are left standing */
  async detachWorkflowFromGroup(groupId: string, workflowId: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(
      `/api/groups/${encodeURIComponent(groupId)}/workflows/${encodeURIComponent(workflowId)}`,
      { method: 'DELETE' },
    )
    return group
  },

  // — RUNS: a template bound to real sessions. —

  /** both filters are AND-ed; omit them for every run on the machine */
  async getWorkflowRuns(params?: {
    workflowId?: string
    groupId?: string
  }): Promise<WorkflowRun[]> {
    const qs = new URLSearchParams()
    if (params?.workflowId) qs.set('workflowId', params.workflowId)
    if (params?.groupId) qs.set('groupId', params.groupId)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const { runs } = await request<{ runs: WorkflowRun[] }>(`/api/workflow-runs${suffix}`)
    return Array.isArray(runs) ? runs : []
  },

  /** the run plus the template it was cut from — `workflow` is null when that
      template has since been deleted, which the board must survive */
  async getWorkflowRun(id: string): Promise<{ run: WorkflowRun; workflow: Workflow | null }> {
    return request<{ run: WorkflowRun; workflow: Workflow | null }>(`/api/workflow-runs/${id}`)
  },

  /** Every edge of a run's dispatch tree, OLDEST FIRST — who gave work to whom,
   *  and in what order. `limit` takes the most recent N, still chronological.
   *  An empty array is a normal answer: a run in which nothing has moved yet,
   *  and a run started before this log existed, both read as no history. */
  async getRunDispatch(runId: string, limit?: number): Promise<DispatchEdge[]> {
    const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : ''
    const { edges } = await request<{ edges: DispatchEdge[] }>(
      `/api/workflow-runs/${encodeURIComponent(runId)}/dispatch${qs}`,
    )
    return Array.isArray(edges) ? edges : []
  },

  /** Start a run. `groupId` is the project the run belongs to and is required.
   *  `projectId` is the DIRECTORY the sessions cwd into — leave it out and the
   *  server takes the group's first directory; a group with no directory at all
   *  is refused rather than guessed at. Slow: it spawns the father chat. */
  async startWorkflowRun(input: {
    workflowId: string
    groupId: string
    projectId?: string
  }): Promise<WorkflowRun> {
    const { run } = await request<{ run: WorkflowRun }>('/api/workflow-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return run
  },

  /** Spawn — or wake — the session for one step. `force` re-dispatches a step
   *  that is already working or already done; without it the server answers 409,
   *  because that order is nearly always given from a stale board. */
  async dispatchStep(
    runId: string,
    stepId: string,
    opts?: { force?: boolean },
  ): Promise<{ run: WorkflowRun; sessionId: string; created: boolean }> {
    return request<{ run: WorkflowRun; sessionId: string; created: boolean }>(
      `/api/workflow-runs/${runId}/dispatch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId, force: opts?.force === true }),
      },
    )
  },

  /** `extra.result` is kept for 'done', `extra.reason` for 'blocked'; the other
      two statuses ignore both. Stages are not settable — their status derives. */
  async setRunStepStatus(
    runId: string,
    stepId: string,
    status: 'in-progress' | 'review' | 'done' | 'blocked' | 'skipped',
    extra?: { result?: string; reason?: string },
  ): Promise<WorkflowRun> {
    const { run } = await request<{ run: WorkflowRun }>(
      `/api/workflow-runs/${runId}/steps/${stepId}/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...extra }),
      },
    )
    return run
  },

  async setRunStatus(
    runId: string,
    status: 'running' | 'paused' | 'done' | 'cancelled',
  ): Promise<WorkflowRun> {
    const { run } = await request<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    return run
  },

  /** removes the run's bookkeeping and its briefs. The sessions are real chats
      with real transcripts and are deliberately left alone. */
  async deleteWorkflowRun(id: string): Promise<void> {
    await request<{ ok: true }>(`/api/workflow-runs/${id}`, { method: 'DELETE' })
  },

  /** replace the whole set of saved views; returns the stored (validated) set */
  async saveViews<T = unknown>(views: T[]): Promise<T[]> {
    const res = await request<{ views: T[] }>('/api/views', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views }),
    })
    return res.views
  },
}

/** "3m ago" style relative timestamps for session plates */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  if (diffMs < 60_000) return 'just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}
