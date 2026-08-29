import { Crown, LayoutGrid, MessageSquare, Sparkles, Plug } from 'lucide-react'
import type { Floor, FloorAgent, Project } from '../lib/api'

/**
 * AgentMultipane — the landing view of a workflow: every agent at once.
 *
 * One pane per agent. Each says who they are and what their chat is called,
 * which are the two things you want when you come back to a floor and need to
 * remember where everybody got to. Clicking a pane opens that agent's chat;
 * the Details button opens the floor's boards and chart.
 *
 * Deliberately NOT terminals. Six live xterms on one screen is six sockets and
 * six repainting canvases for panes too small to read, and it would make the
 * overview the most expensive screen in the app. The chat NAME is the summary
 * claude itself wrote for that conversation, which is a better answer to "what
 * is this one doing" than four visible lines of scrollback.
 */

/** The title claude gave this agent's conversation, or null if it has none. */
function chatNameOf(agent: FloorAgent, projects: Project[]): string | null {
  if (!agent.sessionId) return null
  for (const p of projects) {
    const s = p.sessions.find((x) => x.id === agent.sessionId)
    if (s) {
      const t = (s.summary ?? '').trim()
      /* A brand-new chat has no summary yet — claude writes one after the first
         exchange — so fall back to the id rather than showing an empty line. */
      return t || `chat ${agent.sessionId.slice(0, 8)}`
    }
  }
  return `chat ${agent.sessionId.slice(0, 8)}`
}

export function AgentMultipane({
  floors,
  projects,
  liveSessionIds,
  selAgentId,
  onOpenChat,
  onOpenDetails,
}: {
  /** the workflow floors this view covers */
  floors: Floor[]
  projects: Project[]
  liveSessionIds: string[]
  selAgentId: string | null
  /** open this agent's chat, full screen */
  onOpenChat: (floorId: string, agentId: string) => void
  /** open the floor's details (chart + boards), full screen */
  onOpenDetails: (floorId: string, agentId: string) => void
}) {
  const live = new Set(liveSessionIds)
  const total = floors.reduce((n, f) => n + f.agents.length, 0)

  if (total === 0) {
    return (
      <section
        aria-label="Agents"
        className="flex h-full min-h-0 w-full items-center justify-center bg-midnight px-8"
      >
        <p className="max-w-md text-center font-display text-[14px] italic leading-relaxed text-sand">
          No agents yet. Add a floor from the sidebar, then draw your team on the
          Design tab — each one gets a pane here.
        </p>
      </section>
    )
  }

  return (
    <section aria-label="Agents" className="flex h-full min-h-0 w-full flex-col bg-midnight">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-sand">Floor</span>
        <span className="min-w-0 flex-1 truncate font-display text-[12px] italic text-sand-dim">
          Everyone on this workflow. Open a pane for that agent’s chat, or its
          details for the chart and the boards.
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-sand-dim">
          {total} agent{total === 1 ? '' : 's'}
        </span>
      </header>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {floors.map((f) => (
          <section key={f.id} className="mb-6 last:mb-0">
            <div className="mb-2 flex items-baseline gap-2 px-0.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand">
                {f.name}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
                {f.agents.length} agent{f.agents.length === 1 ? '' : 's'}
                {f.crmScope
                  ? ' · ' + (f.crmScope.targetType === 'mine' ? 'my tasks' : f.crmScope.targetType)
                  : ' · not attached'}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => onOpenDetails(f.id, f.agents[0]?.id ?? '')}
                className="flex cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <LayoutGrid className="h-3 w-3" aria-hidden="true" />
                Floor details
              </button>
            </div>

            {/* Panes wrap rather than sitting in a fixed column count: a floor of
                two should not leave four empty cells, and a floor of nine should
                not force a horizontal scroll. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {f.agents.map((a) => {
                const isLive = a.sessionId != null && live.has(a.sessionId)
                const chatName = chatNameOf(a, projects)
                const selected = a.id === selAgentId
                return (
                  <article
                    key={a.id}
                    className={
                      'group relative flex min-h-[132px] flex-col overflow-hidden rounded-lg border bg-surface transition-all duration-150 hover:shadow-md ' +
                      (selected ? 'border-brass' : 'border-hairline hover:border-brass')
                    }
                  >
                    <button
                      type="button"
                      onClick={() => onOpenChat(f.id, a.id)}
                      title={`Open ${a.name}’s chat`}
                      className="flex min-h-0 flex-1 cursor-pointer flex-col p-3.5 text-left"
                    >
                      {/* — the agent — */}
                      <div className="flex items-center gap-2">
                        {a.isBoss && (
                          <Crown className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-display text-[15px] leading-tight text-parchment">
                          {a.name}
                        </span>
                        {isLive && (
                          <span className="mo-live-dot shrink-0" role="img" aria-label="Chat running" />
                        )}
                      </div>
                      <span className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
                        {a.role.trim() || (a.isBoss ? 'boss' : 'no role')}
                      </span>

                      {/* — its chat — */}
                      <div className="mt-3 min-h-0 flex-1 border-t border-hairline-s pt-2.5">
                        <span className="font-mono text-[8px] uppercase tracking-[0.2em] text-sand-dim">
                          Chat
                        </span>
                        <p
                          className={
                            'mt-1 line-clamp-3 font-display text-[12.5px] leading-snug ' +
                            (chatName ? 'text-sand' : 'italic text-sand-dim')
                          }
                          title={chatName ?? undefined}
                        >
                          {chatName ?? 'no chat yet — opening this pane starts one'}
                        </p>
                      </div>

                      {(a.skills.length > 0 || a.mcpServers.length > 0) && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {a.skills.length > 0 && (
                            <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand">
                              <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                              {a.skills.length}
                            </span>
                          )}
                          {a.mcpServers.length > 0 && (
                            <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-sand">
                              <Plug className="h-2.5 w-2.5" aria-hidden="true" />
                              {a.mcpServers.length}
                            </span>
                          )}
                        </div>
                      )}
                    </button>

                    {/* Actions sit OUTSIDE the pane button — nesting a button
                        inside a button is invalid HTML and the inner one stops
                        receiving clicks in some browsers. */}
                    <div className="flex shrink-0 items-stretch border-t border-hairline-s">
                      <button
                        type="button"
                        onClick={() => onOpenChat(f.id, a.id)}
                        className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 border-r border-hairline-s py-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:bg-surface-2/50 hover:text-brass"
                      >
                        <MessageSquare className="h-3 w-3" aria-hidden="true" />
                        Chat
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenDetails(f.id, a.id)}
                        title="Design, Goal Kanban, Prompt Kanban, Memory…"
                        className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 py-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand transition-colors duration-200 hover:bg-surface-2/50 hover:text-brass"
                      >
                        <LayoutGrid className="h-3 w-3" aria-hidden="true" />
                        Details
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}
