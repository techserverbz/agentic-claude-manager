import { useEffect, useRef, useState } from 'react'
import { FolderTree, Terminal } from 'lucide-react'
import { api, type Floor, type Project } from '../lib/api'

/**
 * FloorWorkspace — the folder a workflow lives in.
 *
 * Two directories, and the distinction is the whole point:
 *
 *  · CODE — what the agents work on. It becomes the pty's working directory, so
 *    it is what "read that file" and "run the tests" resolve against. Getting
 *    this wrong is not a small thing: the floor's agents were starting inside
 *    the orchestrator's own folder, so an agent asked to change a label in the
 *    CRM went and edited the orchestrator's source instead, correctly following
 *    an instruction into the wrong repository.
 *
 *  · CONFIG — this workflow's own `.claude` folder, passed to the CLI as
 *    CLAUDE_CONFIG_DIR. Its `settings.json` supplies the HOOKS for this floor
 *    and no other, which is why a workflow needs a folder of its own rather
 *    than sharing the machine-wide one. It also gives the floor its own session
 *    namespace, so two floors on the same codebase can never collide.
 *
 * Both are stored on a PROJECT record, because a project is already exactly
 * this pair. The floor just remembers which one is its.
 */

const FIELD =
  'w-full border border-hairline bg-midnight px-3 py-2 font-mono text-[11px] text-parchment outline-none transition-colors duration-200 placeholder:text-sand-dim/60 focus:border-brass'
const LABEL = 'font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim'

export function FloorWorkspace({
  floor,
  projects,
  onChanged,
}: {
  floor: Floor
  projects: Project[]
  /** the floor and the project list both changed — refetch them */
  onChanged: () => void
}) {
  const pinned = projects.find((p) => p.id === floor.workspaceProjectId) ?? null

  const [codeDir, setCodeDir] = useState(pinned?.fileDir ?? '')
  const [configDir, setConfigDir] = useState(pinned?.claudeDir ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'failed'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  /* Re-seed on the FLOOR changing, not on every render — the parent re-renders
     while you are typing and would fight the cursor otherwise. */
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (seeded.current === floor.id) return
    seeded.current = floor.id
    setCodeDir(pinned?.fileDir ?? '')
    setConfigDir(pinned?.claudeDir ?? '')
    setState('idle')
    setMessage(null)
  }, [floor.id, pinned])

  const save = async () => {
    setState('saving')
    setMessage(null)
    try {
      const out = await api.setFloorWorkspace(floor.id, {
        codeDir: codeDir.trim(),
        configDir: configDir.trim() || undefined,
      })
      setCodeDir(out.project.fileDir)
      setConfigDir(out.project.claudeDir)
      setState('done')
      setMessage(`Hooks for this workflow go in ${out.settingsPath}`)
      onChanged()
    } catch (err) {
      setState('failed')
      setMessage(err instanceof Error ? err.message : 'Could not set the workspace')
    }
  }

  const dirty =
    codeDir.trim() !== (pinned?.fileDir ?? '') || configDir.trim() !== (pinned?.claudeDir ?? '')

  return (
    <div className="shrink-0 border-b border-hairline px-5 py-4">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim">
          Workspace
        </span>
        <span className="min-w-0 flex-1 font-display text-[12.5px] italic leading-relaxed text-sand">
          Where {floor.name}&rsquo;s agents actually run — and the <code>.claude</code> folder they
          read hooks from, which is this workflow&rsquo;s alone.
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Code directory — the pty&rsquo;s cwd</span>
          <input
            value={codeDir}
            spellCheck={false}
            onChange={(e) => setCodeDir(e.target.value)}
            placeholder="C:\Users\you\Desktop\Github\28.SCRM\1.4 AIO CRM"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Config directory — hooks live here</span>
          <input
            value={configDir}
            spellCheck={false}
            onChange={(e) => setConfigDir(e.target.value)}
            placeholder="blank → V2\workflows\<floor>\.claude"
            className={FIELD}
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={state === 'saving' || codeDir.trim() === ''}
          className="mo-ticks flex cursor-pointer items-center gap-2 border border-hairline px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FolderTree className="h-3 w-3" aria-hidden="true" />
          {pinned === null ? 'Create workspace' : dirty ? 'Repoint workspace' : 'Workspace set'}
        </button>

        {pinned !== null && !dirty && state !== 'failed' && (
          <span className="flex min-w-0 items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-sand-dim">
            <Terminal className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{pinned.name}</span>
          </span>
        )}
      </div>

      {message !== null && (
        <p
          role={state === 'failed' ? 'alert' : undefined}
          className={`mt-2.5 break-all font-mono text-[9.5px] leading-relaxed tracking-[0.06em] ${
            state === 'failed' ? 'text-[#cf6b52]' : 'text-sand-dim'
          }`}
        >
          {message}
        </p>
      )}

      {pinned === null && message === null && (
        <p className="mt-2.5 font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-sand-dim">
          No workspace yet — this floor&rsquo;s chats run wherever the sidebar happens to be
          pointed, and share the machine-wide hooks.
        </p>
      )}
    </div>
  )
}
