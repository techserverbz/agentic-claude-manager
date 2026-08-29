import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Check,
  Copy,
  Crown,
  FolderOpen,
  MessageSquare,
  Plug,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import {
  api,
  type ChatMessage,
  type Floor,
  type FloorAgent,
  type McpServer,
  type Skill,
} from '../lib/api'
import { ChatContentModal } from './ChatContentModal'

/**
 * FloorEquipment — two views over what this agent workflow is actually made of.
 *
 *   SKILLS: every skill equipped by any agent on these floors, and who has it.
 *   AGENTS: the roster, what each one owns, and what each is carrying.
 *
 * Deliberately NOT a copy of the sidebar's Skills and MCP tabs. Those list
 * everything installed on the machine — 70-odd skills, most of which no agent
 * here uses. These answer the question you actually have on a workflow floor:
 * *what is this team equipped with, and who has what.* An installed skill that
 * nobody has been given does not appear, because to this workflow it does not
 * exist.
 */

interface Holder {
  floorName: string
  agentName: string
  isBoss: boolean
}

/** name -> who has it, across every floor shown */
function holdersOf(floors: Floor[], key: 'skills' | 'mcpServers'): Map<string, Holder[]> {
  const out = new Map<string, Holder[]>()
  for (const f of floors) {
    for (const a of f.agents) {
      for (const n of a[key]) {
        if (!out.has(n)) out.set(n, [])
        out.get(n)!.push({ floorName: f.name, agentName: a.name, isBoss: a.isBoss })
      }
    }
  }
  return out
}

function EquipList({
  kind,
  floors,
  installed,
  installedNames,
  describe,
}: {
  kind: 'skills' | 'mcpServers'
  floors: Floor[]
  installed: boolean
  installedNames: Set<string>
  describe: (name: string) => string | null
}) {
  const [q, setQ] = useState('')
  const holders = useMemo(() => holdersOf(floors, kind), [floors, kind])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return [...holders.entries()]
      .filter(([n]) => n.toLowerCase().includes(needle))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [holders, q])

  const noun = kind === 'skills' ? 'skill' : 'MCP server'

  if (holders.size === 0) {
    return (
      <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
        No {noun}s are equipped on this workflow yet. Open an agent on the Design
        tab and pick some on its {kind === 'skills' ? 'Skills' : 'MCP'} tab — an agent
        only reaches for what it has been given.
      </p>
    )
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline-s px-4 py-2">
        <Search className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${holders.size} equipped ${noun}${holders.size === 1 ? '' : 's'}…`}
          aria-label={`Search equipped ${noun}s`}
          className="min-w-0 flex-1 bg-transparent py-1 font-display text-[12px] text-parchment outline-none placeholder:text-sand-dim"
        />
        {q !== '' && (
          <button
            type="button"
            onClick={() => setQ('')}
            aria-label="Clear the search"
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>

      <ul className="no-scrollbar min-h-0 flex-1 list-none overflow-y-auto p-3">
        {rows.length === 0 ? (
          <li className="px-3 py-3 font-display text-[12px] italic text-sand-dim">
            Nothing matches “{q}”.
          </li>
        ) : (
          rows.map(([name, who]) => {
            const desc = describe(name)
            /* An equipped name that is NOT installed is the failure mode worth
               surfacing: the agent will be briefed that it has it, reach for it,
               and find nothing. It happens when a skill is renamed or removed on
               disk after an agent was equipped with it. */
            const missing = installed && !installedNames.has(name)
            return (
              <li key={name} className="mb-2 border border-hairline bg-surface p-3 last:mb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-[12px] text-parchment">{name}</span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                    {who.length} agent{who.length === 1 ? '' : 's'}
                  </span>
                  {missing && (
                    <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                      not installed on this machine
                    </span>
                  )}
                </div>
                {desc && (
                  <p className="mt-1 line-clamp-2 font-display text-xs leading-relaxed text-sand">
                    {desc}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {who.map((h, i) => (
                    <span
                      key={h.floorName + h.agentName + i}
                      className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand"
                      title={`${h.agentName} on ${h.floorName}`}
                    >
                      {h.isBoss && <Crown className="h-2.5 w-2.5 text-brass" aria-hidden="true" />}
                      {h.agentName}
                    </span>
                  ))}
                </div>
              </li>
            )
          })
        )}
      </ul>
    </>
  )
}

function Roster({
  floors,
  liveSessionIds,
  onSelectAgent,
  onOpenChat,
}: {
  floors: Floor[]
  liveSessionIds: string[]
  onSelectAgent: (floorId: string, agentId: string) => void
  onOpenChat: (floorId: string, agentId: string) => void
}) {
  const live = useMemo(() => new Set(liveSessionIds), [liveSessionIds])
  /* which transcript is open, if any. Held here rather than per row so there
     is exactly one modal in the tree no matter how many agents are listed. */
  /** what the last open-location click reported, if anything */
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (notice === null) return
    const t = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [notice])

  const [reading, setReading] = useState<{
    floorId: string
    agentId: string
    name: string
    sessionId: string
  } | null>(null)

  /* exists-on-disk per agent. A chat can be online with no transcript —
     claude writes the .jsonl on the first exchange — and without this the
     folder button silently opens a directory instead of selecting a file. */
  const [onDisk, setOnDisk] = useState<Record<string, { exists: boolean; bytes: number }>>({})
  const floorIds = floors.map((f) => f.id).join('|')
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      floors.map((f) =>
        api.getFloorTranscripts(f.id).then(
          (r) => r.transcripts,
          () => ({}),
        ),
      ),
    ).then((all) => {
      if (cancelled) return
      setOnDisk(Object.assign({}, ...all))
    })
    return () => {
      cancelled = true
    }
    /* floorIds, not floors: the array identity changes on every render of
       the parent and would refetch this in a loop. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorIds])

  const total = floors.reduce((n, f) => n + f.agents.length, 0)

  if (total === 0) {
    return (
      <p className="px-6 py-8 font-display text-[13px] italic leading-relaxed text-sand">
        No agents yet. Add a floor from the sidebar and draw one on the Design tab.
      </p>
    )
  }

  return (
    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
      {floors.map((f) => (
        <section key={f.id} className="mb-4 last:mb-0">
          <div className="mb-2 flex items-baseline gap-2 px-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand">
              {f.name}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
              {f.agents.length} agent{f.agents.length === 1 ? '' : 's'}
              {f.crmScope
                ? ' · ' + (f.crmScope.targetType === 'mine' ? 'my tasks' : f.crmScope.targetType)
                : ' · not attached'}
            </span>
          </div>
          <ul className="list-none">
            {f.agents.map((a: FloorAgent) => {
              const isLive = a.sessionId != null && live.has(a.sessionId)
              return (
                <li key={a.id} className="mb-2 last:mb-0">
                  <div className="group flex items-start gap-2 border border-hairline bg-surface p-3 transition-colors duration-150 hover:border-brass">
                    <button
                      type="button"
                      onClick={() => onSelectAgent(f.id, a.id)}
                      title={`Open ${a.name} on the floor`}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {a.isBoss && (
                          <Crown className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
                        )}
                        <span className="font-display text-[13.5px] text-parchment">{a.name}</span>
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                          {a.role.trim() || (a.isBoss ? 'boss' : 'no role')}
                        </span>
                        {isLive ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400">
                            online
                          </span>
                        ) : a.sessionId ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            offline
                          </span>
                        ) : (
                          <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium text-sand-dim">
                            never opened
                          </span>
                        )}
                      </div>
                      {/* The first line of the brief — what this agent is for,
                          without opening it. Headings are stripped so a brief
                          that starts "# Oscar" shows its second line instead. */}
                      <p className="mt-1 line-clamp-2 font-display text-xs leading-relaxed text-sand">
                        {a.md
                          .split('\n')
                          .map((l) => l.replace(/^#+\s*/, '').trim())
                          .filter((l) => l && !/^#/.test(l))
                          .slice(1, 3)
                          .join(' ') || 'No brief written yet.'}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {a.skills.length > 0 && (
                          <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand">
                            <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                            {a.skills.length} skill{a.skills.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {a.mcpServers.length > 0 && (
                          <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand">
                            <Plug className="h-2.5 w-2.5" aria-hidden="true" />
                            {a.mcpServers.length} server{a.mcpServers.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {a.model && (
                          <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium text-sand-dim">
                            {a.model}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* The chat id, because everything you might want to do
                        with somebody else's conversation — read their
                        transcript, hand them a card, point a hook at their
                        .jsonl — needs it, and it was previously only
                        discoverable by opening the chat. */}
                    <SessionId sessionId={a.sessionId ?? null} />

                    {a.sessionId !== null && a.sessionId !== undefined && (
                      <>
                        {onDisk[a.id]?.exists === false && (
                          <span
                            title="This chat has not written its .jsonl yet — claude creates it on the first exchange."
                            className="shrink-0 self-start border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim"
                          >
                            no transcript yet
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            void api
                              .revealFloorPath(f.id, { what: 'transcript', sessionId: a.sessionId as string })
                              .then(
                                (r) => {
                                  /* The server falls back to the folder when the
                                     file is not there yet and SAYS so — passing
                                     that on is the difference between "opened the
                                     wrong thing" and "there is nothing to open". */
                                  if (r.note) setNotice(r.note)
                                },
                                (err) => setNotice(err instanceof Error ? err.message : null),
                              )
                          }}
                          title={
                            onDisk[a.id]?.exists === false
                              ? `${a.name} has no .jsonl yet — this opens the folder it will appear in`
                              : `Show ${a.name}'s .jsonl in Explorer`
                          }
                          aria-label={`Open file location for ${a.name}`}
                          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-start border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                        >
                          <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setReading({ floorId: f.id, agentId: a.id, name: a.name, sessionId: a.sessionId as string })
                          }
                          title={
                            onDisk[a.id]?.exists === false
                              ? `${a.name} has not written a transcript yet`
                              : `Read ${a.name}’s transcript`
                          }
                          aria-label={`Read ${a.name}’s transcript`}
                          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-start border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                        >
                          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenChat(f.id, a.id)}
                      title={`Open ${a.name}'s chat`}
                      aria-label={`Open ${a.name}'s chat`}
                      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
                    >
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {notice !== null && (
        <p
          aria-live="polite"
          className="sticky bottom-0 border border-hairline bg-surface px-3 py-2 font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-sand-dim"
        >
          {notice}
        </p>
      )}

      {/* The transcript reader. Same modal the sidebar uses for any chat — it
          only needed telling WHERE to read from, because a floor with its own
          config folder keeps its .jsonl there rather than in the global one. */}
      <ChatContentModal
        target={
          reading === null
            ? null
            : { sessionId: reading.sessionId, cwd: '', title: reading.name + ' · transcript' }
        }
        load={
          reading === null
            ? undefined
            : () =>
                api
                  .getFloorAgentMessages(reading.floorId, reading.agentId)
                  .then((r): ChatMessage[] => r.messages)
        }
        onClose={() => setReading(null)}
      />
    </div>
  )
}

/** the agent's chat id, with a copy button — the file it names is
 *  <config>/projects/<encoded code dir>/<id>.jsonl */
function SessionId({ sessionId }: { sessionId: string | null }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(t)
  }, [copied])

  if (sessionId === null) {
    return (
      <span className="shrink-0 self-start font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
        no chat id
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => {
        /* Optional chaining, not a bare call: navigator.clipboard is
           undefined outside a secure context, and a LAN visitor on
           http://192.168.x.x would otherwise get a TypeError. */
        void navigator.clipboard?.writeText(sessionId).then(
          () => setCopied(true),
          () => {},
        )
      }}
      title={`Copy ${sessionId}`}
      aria-label={`Copy chat id ${sessionId}`}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 self-start border border-hairline px-2 py-1 font-mono text-[9.5px] tracking-[0.06em] text-sand-dim transition-colors duration-150 hover:border-brass hover:text-brass"
    >
      {copied ? (
        <Check className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      ) : (
        <Copy className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      )}
      {copied ? 'copied' : sessionId}
    </button>
  )
}

export function FloorEquipment({
  view,
  floors,
  liveSessionIds,
  onSelectAgent,
  onOpenChat,
}: {
  view: 'skills' | 'mcp' | 'agents'
  /** the workflow floors this panel covers */
  floors: Floor[]
  liveSessionIds: string[]
  onSelectAgent: (floorId: string, agentId: string) => void
  onOpenChat: (floorId: string, agentId: string) => void
}) {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [servers, setServers] = useState<McpServer[] | null>(null)

  /* What is installed on this machine — used only to DESCRIBE an equipped name
     and to flag one that no longer resolves. A failure here is silent: not
     knowing what a skill does must not stop the roster rendering. */
  useEffect(() => {
    let cancelled = false
    void api.getSkills().then(
      (l) => !cancelled && setSkills(l),
      () => !cancelled && setSkills([]),
    )
    void api.getMcpServers().then(
      (l) => !cancelled && setServers(l),
      () => !cancelled && setServers([]),
    )
    return () => {
      cancelled = true
    }
  }, [])

  const skillDesc = useMemo(() => {
    const m = new Map((skills ?? []).map((s) => [s.name, s.description]))
    return (n: string) => m.get(n) ?? null
  }, [skills])
  const serverDesc = useMemo(() => {
    const m = new Map((servers ?? []).map((s) => [s.name, `${s.transport} · ${s.command}`]))
    return (n: string) => m.get(n) ?? null
  }, [servers])

  const label =
    view === 'agents' ? 'Agents' : view === 'skills' ? 'Skills' : 'MCP servers'
  const strap =
    view === 'agents'
      ? 'Everyone on this workflow, what they own, and what they are carrying.'
      : view === 'skills'
        ? 'The skills this workflow is equipped with — and who has each one.'
        : 'The MCP servers this workflow is equipped with — and who has each one.'

  return (
    <section
      aria-label={`Workflow ${label.toLowerCase()}`}
      className="flex h-full min-h-0 w-full flex-col bg-midnight"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">{label}</span>
        <span className="min-w-0 flex-1 truncate font-display text-[12px] italic text-sand-dim">
          {strap}
        </span>
      </header>

      {view === 'agents' ? (
        <Roster
          floors={floors}
          liveSessionIds={liveSessionIds}
          onSelectAgent={onSelectAgent}
          onOpenChat={onOpenChat}
        />
      ) : view === 'skills' ? (
        <EquipList
          kind="skills"
          floors={floors}
          installed={skills !== null}
          installedNames={new Set((skills ?? []).map((s) => s.name))}
          describe={skillDesc}
        />
      ) : (
        <EquipList
          kind="mcpServers"
          floors={floors}
          installed={servers !== null}
          installedNames={new Set((servers ?? []).map((s) => s.name))}
          describe={serverDesc}
        />
      )}
    </section>
  )
}
