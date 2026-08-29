import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Globe, KeyRound, Plug, RotateCw, Terminal } from 'lucide-react'
import { api } from '../lib/api'
import type { McpServer } from '../lib/api'

/**
 * McpPanel — the MCP servers configured on this machine, read-only.
 *
 * The server re-reads the config files on every request (they are edited
 * outside the app, so a cached list would go stale silently); this panel
 * fetches on mount, offers a retry, and never writes.
 *
 * SECRETS: `envKeys` carries the NAMES of the env vars a server is configured
 * with — never the values, which the server strips before anything reaches the
 * wire. The env row below therefore renders names only and says so in plain
 * text, so no chip can be misread as "the value is available here". Do not add
 * a reveal affordance: there is nothing behind it to reveal.
 */

/** hairline chip — the shared shape for transport / scope / env-key marks */
function Chip({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={`shrink-0 border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${
        accent ? 'border-brass/40 text-brass' : 'border-hairline-s text-sand-dim'
      }`}
    >
      {children}
    </span>
  )
}

function ServerRow({ server }: { server: McpServer }) {
  /* for sse/http the contract puts the URL in `command`, so the glyph — and the
     reader's expectation of what that line is — follows the transport */
  const remote = server.transport === 'sse' || server.transport === 'http'
  const argv = server.args.join(' ')

  return (
    <li className="border border-hairline bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        <h3 className="min-w-0 max-w-full truncate font-display text-[15px] font-medium leading-tight text-parchment">
          {server.name}
        </h3>
        <Chip accent>{server.transport}</Chip>
        <Chip>{server.scope}</Chip>
        {/* which project a project-scoped server belongs to — pushed right and
            truncated: these are absolute paths and would otherwise set the width */}
        {server.project !== undefined && server.project !== '' && (
          <span
            className="ml-auto min-w-0 max-w-full truncate font-mono text-[10px] text-sand-dim"
            title={server.project}
          >
            {server.project}
          </span>
        )}
      </div>

      {/* Command line: one row, ellipsised, full value in the title. Nothing here
          may widen the panel — an unbounded argv would push the whole body
          sideways, and the page must never scroll horizontally. */}
      <div className="mt-2 flex items-center gap-2">
        {remote ? (
          <Globe className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
        ) : (
          <Terminal className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
        )}
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-sand"
          title={server.command}
        >
          {server.command}
        </code>
      </div>
      {argv !== '' && (
        /* padding matches the icon (14px) + gap (8px) above, so the argv hangs
           under the command rather than under the glyph */
        <p className="mt-1 truncate pl-[1.375rem] font-mono text-[10px] text-sand-dim" title={argv}>
          {argv}
        </p>
      )}

      {server.envKeys.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
            <KeyRound className="h-3 w-3" aria-hidden="true" />
            env
          </span>
          {server.envKeys.map((key) => (
            <Chip key={key}>{key}</Chip>
          ))}
          <span className="font-display text-[11px] italic text-sand-dim">
            names only — values are never shown
          </span>
        </div>
      )}
    </li>
  )
}

function Group({ label, servers }: { label: string; servers: McpServer[] }) {
  if (servers.length === 0) return null
  return (
    <section>
      <h2 className="flex items-baseline gap-2 border-b border-hairline-s pb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-sand">
        <span>{label}</span>
        <span className="tabular-nums text-sand-dim">{servers.length}</span>
      </h2>
      <ul className="mt-2.5 space-y-1.5">
        {servers.map((s) => (
          <ServerRow key={`${s.scope}:${s.project ?? ''}:${s.name}`} server={s} />
        ))}
      </ul>
    </section>
  )
}

export function McpPanel() {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /* bumped by Try again — re-runs the fetch effect instead of a second code path */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setServers(null)
    setError(null)
    api
      .getMcpServers()
      .then((list) => {
        if (!cancelled) setServers(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not read the MCP config.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  /* User servers first: they are on for every project, so they are the standing
     set; project servers are contextual and read as the exception. Anything the
     server did not mark 'user' falls into the project group rather than being
     dropped — an unlisted server would be worse than a mislabelled one. */
  const userServers = servers?.filter((s) => s.scope === 'user') ?? []
  const projectServers = servers?.filter((s) => s.scope !== 'user') ?? []

  return (
    <section
      aria-label="MCP servers"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-midnight"
    >
      <header className="flex shrink-0 items-center gap-3.5 border-b border-hairline px-5 py-3 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
        <span className="h-px w-6 bg-hairline" aria-hidden="true" />
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        <span>MCP Servers</span>
        <span
          aria-live="polite"
          className="ml-auto shrink-0 border border-hairline px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] tabular-nums text-sand-dim"
        >
          {servers === null ? '—' : `${servers.length} configured`}
        </span>
      </header>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {error !== null ? (
          <div className="mx-auto flex max-w-2xl flex-col items-center py-10 text-center">
            <p role="alert" className="font-display text-[14px] italic text-[#cf6b52]">
              {error}
            </p>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="mo-ticks mt-5 flex cursor-pointer items-center gap-1.5 border border-hairline px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
            >
              <RotateCw className="h-3 w-3" aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : servers === null ? (
          <p className="py-10 text-center font-display text-[14px] italic text-sand">
            Reading the MCP config…
          </p>
        ) : servers.length === 0 ? (
          <div className="mx-auto flex max-w-2xl flex-col items-center py-10 text-center">
            <Plug className="mb-5 h-8 w-8 text-sand-dim" aria-hidden="true" />
            <h2 className="font-display text-[24px] font-medium leading-tight text-parchment">
              No MCP servers <em className="mo-halo font-normal italic text-brass">configured</em>
            </h2>
            <p className="mt-4 max-w-md font-display text-[15px] italic leading-relaxed text-sand">
              Servers added for your user or inside a project appear here — the
              command or endpoint each one runs on, and the names of the env vars
              it carries. This tab only reads the config; it never edits it.
            </p>
            <span className="mo-rule" aria-hidden="true" />
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <Group label="User" servers={userServers} />
            <Group label="Project" servers={projectServers} />
          </div>
        )}
      </div>
    </section>
  )
}
