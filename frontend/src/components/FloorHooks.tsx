import { useCallback, useEffect, useState } from 'react'
import { Webhook, Users2, RotateCcw } from 'lucide-react'
import { api, type Floor } from '../lib/api'

/**
 * FloorHooks — the hooks that belong to THIS workflow and no other.
 *
 * They live in the floor's own `.claude/settings.json`, which the CLI reads
 * because every chat on this floor is spawned with CLAUDE_CONFIG_DIR pointed at
 * that folder. That is the whole reason a workflow needs a folder: hooks in the
 * machine-wide config fire for everything you run, including the floors this
 * one knows nothing about.
 *
 * The roster hook is the one worth shipping ready-made. Every agent here has
 * its own chat and every chat is a .jsonl on disk, so one agent CAN read what
 * another has been doing — but only if it knows the id, and an id is precisely
 * what a chat cannot discover about anybody else. The hook closes that gap at
 * SessionStart: it prints the floor's roster, each colleague's chat id, and the
 * path to their transcript, into the context of every chat as it boots.
 */

export function FloorHooks({ floor }: { floor: Floor | null }) {
  const [state, setState] = useState<{
    configDir: string | null
    settingsPath: string | null
    settings: { hooks?: Record<string, unknown> } | null
    rosterHookInstalled: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    if (floor === null) return
    void api.getFloorHooks(floor.id).then(
      (r) => setState(r),
      () => setState(null),
    )
  }, [floor])

  useEffect(load, [load])

  if (floor === null) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="max-w-md font-display text-[14px] italic leading-relaxed text-sand">
          Pick a floor to see its hooks.
        </p>
      </div>
    )
  }

  const install = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const out = await api.installRosterHook(floor.id)
      setNote(`Installed. ${out.scriptPath}`)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not install the hook')
    } finally {
      setBusy(false)
    }
  }

  const events = Object.keys(state?.settings?.hooks ?? {})

  return (
    <div className="no-scrollbar h-full overflow-y-auto px-5 py-4">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim">Hooks</span>
        <span className="min-w-0 flex-1 font-display text-[12.5px] italic leading-relaxed text-sand">
          Hooks that fire for {floor.name}&rsquo;s agents only — they live in this workflow&rsquo;s
          own <code>.claude/settings.json</code>, not the machine-wide one.
        </span>
      </div>

      {state?.configDir == null ? (
        <p className="border border-hairline px-3 py-2.5 font-mono text-[10px] leading-relaxed tracking-[0.06em] text-sand-dim">
          This floor has no workspace yet, so it has nowhere to put a hook and shares the
          machine-wide settings. Give it a folder on the Preamble tab first.
        </p>
      ) : (
        <>
          <p className="mb-4 break-all font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-sand-dim">
            {state.settingsPath}
          </p>

          {/* — the roster hook — */}
          <div className="mb-5 border border-hairline p-4">
            <div className="mb-2 flex items-center gap-2">
              <Users2 className="h-3.5 w-3.5 shrink-0 text-brass" aria-hidden="true" />
              <span className="font-display text-[13.5px] text-parchment">
                Know the other chats on this floor
              </span>
              {state.rosterHookInstalled && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400">
                  installed
                </span>
              )}
            </div>
            <p className="mb-3 font-display text-[12.5px] leading-relaxed text-sand">
              At the start of every chat on this floor, print the roster: each colleague&rsquo;s
              name, role, whether they are online, their <strong>chat id</strong>, and the path to
              their <code>.jsonl</code> transcript. Without it an agent can see six names and read
              none of their work — the id is the one thing a chat cannot find out about anybody
              else.
            </p>
            <button
              type="button"
              onClick={() => void install()}
              disabled={busy}
              className="mo-ticks flex cursor-pointer items-center gap-2 border border-hairline px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state.rosterHookInstalled ? (
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Webhook className="h-3 w-3" aria-hidden="true" />
              )}
              {busy ? 'Writing…' : state.rosterHookInstalled ? 'Regenerate' : 'Install this hook'}
            </button>
            <p className="mt-2.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
              Applies to chats started after this — reopen an agent to give it the roster.
            </p>
          </div>

          {note !== null && (
            <p className="mb-3 break-all border border-hairline px-3 py-2 font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-sand-dim">
              {note}
            </p>
          )}
          {error !== null && (
            <p
              role="alert"
              className="mb-3 border border-hairline px-3 py-2 font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-[#cf6b52]"
            >
              {error}
            </p>
          )}

          {/* — what the file actually says — */}
          <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
            settings.json {events.length > 0 && `· ${events.join(', ')}`}
          </p>
          <pre className="overflow-x-auto border border-hairline bg-midnight px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-sand">
            {state.settings === null
              ? '(could not read this file)'
              : JSON.stringify(state.settings, null, 2)}
          </pre>
          <p className="mt-2 font-display text-[12px] italic leading-relaxed text-sand">
            Edit that file directly to add your own hooks — regenerating the roster hook replaces
            only its own entry and leaves everything else alone.
          </p>
        </>
      )}
    </div>
  )
}
