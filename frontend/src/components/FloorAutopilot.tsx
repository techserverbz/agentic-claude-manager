import { useCallback, useEffect, useState } from 'react'
import { Bot, Eye, PowerOff } from 'lucide-react'
import { api, type Floor } from '../lib/api'

/**
 * FloorAutopilot — let the floor watch itself while you are not looking.
 *
 * Every minute the server asks one question about this floor: is anything
 * actually stuck? Cards waiting on a human, chats that died, agents holding
 * work in silence. If the answer is no — the normal case — it does nothing at
 * all. If the answer is yes, it writes ONE card to the prompt board saying so.
 *
 * Three decisions worth knowing, because they are what make this safe to leave
 * on:
 *
 *  · It writes a CARD; it never types into a terminal. Typing into a live
 *    session means sending a newline, and a newline lands on whatever is on
 *    screen — including a permission prompt, where the highlighted answer is
 *    Yes. A card cannot press anything, and it is still there in the morning.
 *
 *  · It is armed UNTIL A TIME, not switched on. A switch left on is a switch
 *    nobody remembers turning on. This lapses by itself.
 *
 *  · A quiet floor costs nothing — no card, no model, no tokens. Which is why
 *    the preview below is worth reading before you arm it: if it says nothing
 *    is stuck, arming it changes nothing today.
 */

const HOUR_CHOICES = [1, 4, 8, 24]
const EVERY_CHOICES = [5, 15, 30, 60]

interface Preview {
  armed: boolean
  stuck: number
  asking: number
  lost: number
  stalled: number
  wouldSay: string | null
  autopilot: {
    untilMs: number | null
    everyMinutes: number
    lastRunAt: string | null
    runsToday: number
  }
  limits: { maxHours: number; minMinutes: number; maxRunsPerDay: number }
}

function untilLabel(untilMs: number | null): string {
  if (!untilMs) return 'off'
  const mins = Math.round((untilMs - Date.now()) / 60000)
  if (mins <= 0) return 'lapsed'
  if (mins < 60) return `${mins} min left`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m left`
}

export function FloorAutopilot({ floor }: { floor: Floor | null }) {
  const [p, setP] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [every, setEvery] = useState(30)

  const load = useCallback(() => {
    if (floor === null) return
    void api.autopilotPreview(floor.id).then(
      (r) => {
        setP(r)
        setEvery(r.autopilot.everyMinutes)
      },
      () => setP(null),
    )
  }, [floor])

  useEffect(load, [load])

  /* while armed, keep the countdown honest without hammering the server */
  useEffect(() => {
    if (!p?.armed) return
    const t = window.setInterval(load, 30_000)
    return () => window.clearInterval(t)
  }, [p?.armed, load])

  if (floor === null) return null

  const arm = async (hours: number) => {
    setBusy(true)
    setError(null)
    try {
      await api.setAutopilot(floor.id, { hours, everyMinutes: every })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change autopilot')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-hairline px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim">
          Autopilot
        </span>
        <span className="min-w-0 flex-1 font-display text-[12.5px] italic leading-relaxed text-sand">
          Watches {floor.name} for stuck work — cards waiting on you, chats that died, agents
          silent while holding a job — and writes what it finds to the prompt board. It never
          types into a chat.
        </span>
        {p !== null && (
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] ${
              p.armed ? 'border-brass text-brass' : 'border-hairline text-sand-dim'
            }`}
          >
            {p.armed ? untilLabel(p.autopilot.untilMs) : 'off'}
          </span>
        )}
      </div>

      {/* What it would say RIGHT NOW — the honest way to judge it before
          trusting it to run unattended. */}
      <div className="mb-3 border border-hairline bg-midnight px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <Eye className="h-3 w-3 shrink-0 text-sand-dim" aria-hidden="true" />
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sand-dim">
            Right now
          </span>
        </div>
        {p === null ? (
          <p className="font-mono text-[10px] text-sand-dim">…</p>
        ) : p.stuck === 0 ? (
          <p className="font-display text-[12.5px] italic leading-relaxed text-sand">
            Nothing is stuck, so autopilot would say nothing and cost nothing.
          </p>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-parchment">
            {p.wouldSay}
          </pre>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
          Check every
        </span>
        <select
          value={every}
          onChange={(e) => setEvery(Number(e.target.value))}
          className="cursor-pointer border border-hairline bg-midnight px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-sand outline-none"
        >
          {EVERY_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>

        <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.16em] text-sand-dim">
          Run for
        </span>
        {HOUR_CHOICES.map((h) => (
          <button
            key={h}
            type="button"
            disabled={busy}
            onClick={() => void arm(h)}
            className="mo-ticks cursor-pointer border border-hairline px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
          >
            {h}h
          </button>
        ))}

        {p?.armed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void arm(0)}
            className="mo-ticks ml-auto flex cursor-pointer items-center gap-2 border border-hairline px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-sand transition-colors duration-200 hover:border-[#cf6b52] hover:text-[#cf6b52] disabled:opacity-40"
          >
            <PowerOff className="h-3 w-3" aria-hidden="true" />
            Stop now
          </button>
        )}
      </div>

      {p !== null && (p.autopilot.lastRunAt !== null || p.autopilot.runsToday > 0) && (
        <p className="mt-2.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sand-dim">
          <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
          {p.autopilot.runsToday} report{p.autopilot.runsToday === 1 ? '' : 's'} today
          {p.autopilot.lastRunAt !== null &&
            ` · last ${new Date(p.autopilot.lastRunAt).toLocaleTimeString()}`}
          {` · max ${p.limits.maxRunsPerDay}/day`}
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          className="mt-2 font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-[#cf6b52]"
        >
          {error}
        </p>
      )}
    </div>
  )
}
