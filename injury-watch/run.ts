import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const FEED = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'
const FUNCTION_NAME = 'injury-watch'
const LOOK_AHEAD_MIN = 110   // watch games kicking off within this many minutes
const POLL_EVERY_MIN = 3     // how often to check ESPN during a watch
const MAX_RUNTIME_MIN = 120  // safety stop
const MIN_FEED_SIZE = 100    // fewer entries than this = ESPN hiccup, don't trust it
const SUMMARY_HOUR_CT = 8    // daily summary goes out at the first run after 8 AM Central

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Email (same Resend setup as the other jobs) ──
async function sendEmail(subject: string, body: string): Promise<void> {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) {
    console.error('RESEND_API_KEY not set - skipping email')
    return
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Ladder League <notifications@ladderleague.us>',
        to: ['andrewjkinn@gmail.com', 'lucastopolie@gmail.com', 'ladderleaguefb@gmail.com'],
        subject,
        text: body,
      }),
    })
  } catch (err) {
    console.error('Failed to send email:', err)
  }
}

// Log a failed check. Email only when this is the first failure in a row,
// so an outage sends one alert instead of one every few minutes.
async function recordError(error: unknown): Promise<void> {
  const { data: last } = await supabase
    .from('espn_injury_runs')
    .select('error')
    .order('id', { ascending: false })
    .limit(1)
  const alreadyFailing = !!(last && last.length > 0 && last[0].error)

  await supabase.from('espn_injury_runs').insert({ error: String(error) })

  if (!alreadyFailing) {
    await sendEmail(
      '❌ injury-watch: checks are failing',
      `The injury check failed:\n\n${String(error)}\n\n` +
      `You'll get this email once per outage. The daily summary will show when checks are back to normal.`
    )
  }
}

// ── ESPN ──
async function fetchFeed(): Promise<any> {
  const out = await new Deno.Command('curl', {
    args: [
      '-sS', '--fail', '--compressed', '--max-time', '30',
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      FEED,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!out.success) throw new Error(`curl failed: ${new TextDecoder().decode(out.stderr)}`)
  return JSON.parse(new TextDecoder().decode(out.stdout))
}

function athleteIdFrom(inj: any): string | null {
  const a = inj.athlete ?? {}
  if (a.id) return String(a.id)
  const urls = [...(a.links ?? []).map((l: any) => l.href), a.headshot?.href].filter(Boolean)
  for (const u of urls) {
    const m = String(u).match(/\/id\/(\d+)/) ?? String(u).match(/\/full\/(\d+)\.png/)
    if (m) return m[1]
  }
  return null
}

// When to stop: the latest kickoff among games starting soon (null = no games soon).
async function getStopAt(): Promise<number | null> {
  const now = Date.now()
  const { data, error } = await supabase
    .from('matchups')
    .select('kickoff_time')
    .gte('kickoff_time', new Date(now - 10 * 60000).toISOString())
    .lte('kickoff_time', new Date(now + LOOK_AHEAD_MIN * 60000).toISOString())
  if (error) throw error
  if (!data || data.length === 0) return null
  return Math.max(...data.map((m: any) => new Date(m.kickoff_time).getTime()))
}

// Every active player we track, keyed by ESPN ID.
async function loadPlayers(): Promise<Map<string, any>> {
  const players = new Map<string, any>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('players')
      .select('id, espn_id, full_name, injury_status')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    for (const p of data ?? []) if (p.espn_id) players.set(String(p.espn_id), p)
    if (!data || data.length < 1000) break
  }
  return players
}

async function checkOnce(players: Map<string, any>): Promise<void> {
  const data = await fetchFeed()

  // What ESPN says right now. "Active" (or not listed at all) = healthy = null.
  const statusByEspnId = new Map<string, string>()
  let feedSize = 0
  for (const team of data.injuries ?? []) {
    for (const inj of team.injuries ?? []) {
      const id = athleteIdFrom(inj)
      if (!id) continue
      feedSize++
      const status = (inj.status ?? '').trim()
      if (status && status !== 'Active') statusByEspnId.set(id, status)
    }
  }

  if (feedSize < MIN_FEED_SIZE) {
    throw new Error(`ESPN feed only had ${feedSize} entries; skipping this check`)
  }

  const changes: any[] = []
  for (const [espnId, p] of players) {
    const newStatus = statusByEspnId.get(espnId) ?? null
    if (newStatus === (p.injury_status ?? null)) continue

    const { error } = await supabase
      .from('players')
      .update({ injury_status: newStatus, injury_updated_at: new Date().toISOString() })
      .eq('id', p.id)
    if (error) {
      console.error(`Update failed for ${p.full_name}:`, error)
      continue
    }

    changes.push({ player_id: p.id, kind: 'injury', old_value: p.injury_status ?? null, new_value: newStatus })
    console.log(`${p.full_name}: ${p.injury_status ?? 'healthy'} -> ${newStatus ?? 'healthy'}`)
    p.injury_status = newStatus
  }

  for (let i = 0; i < changes.length; i += 500) {
    const { error } = await supabase.from('player_status_changes').insert(changes.slice(i, i + 500))
    if (error) throw error
  }

  await supabase.from('espn_injury_runs').insert({ players_seen: feedSize, changes: changes.length })
  console.log(`${new Date().toISOString()} feed=${feedSize} changes=${changes.length}`)
}

// ── Daily summary ──
function centralHour(d: Date): number {
  return parseInt(d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }), 10) % 24
}

async function maybeSendDailySummary(): Promise<void> {
  const now = new Date()
  if (centralHour(now) < SUMMARY_HOUR_CT) return

  // Already sent one in the last 20 hours?
  const since20h = new Date(now.getTime() - 20 * 3600000).toISOString()
  const { data: sent } = await supabase
    .from('function_run_log')
    .select('id')
    .eq('function_name', FUNCTION_NAME)
    .gte('completed_at', since20h)
    .limit(1)
  if (sent && sent.length > 0) return

  const since24h = new Date(now.getTime() - 24 * 3600000).toISOString()

  const { data: runs } = await supabase
    .from('espn_injury_runs')
    .select('error')
    .gte('checked_at', since24h)
  const checks = runs?.length ?? 0
  const errors = (runs ?? []).filter((r: any) => r.error).length

  const { data: watches } = await supabase
    .from('injury_watch_dispatches')
    .select('id')
    .gte('dispatched_at', since24h)

  const { data: changes } = await supabase
    .from('player_status_changes')
    .select('old_value, new_value, changed_at, players(full_name, team_name, position)')
    .eq('kind', 'injury')
    .gte('changed_at', since24h)
    .order('changed_at', { ascending: true })

  const all = changes ?? []
  const notable = all.filter((c: any) => c.new_value === 'Out' || c.new_value === 'Doubtful')
  const line = (c: any) =>
    `${c.players?.full_name ?? 'Unknown'} (${c.players?.team_name ?? '?'} ${c.players?.position ?? ''}): ` +
    `${c.old_value ?? 'healthy'} -> ${c.new_value ?? 'healthy'}`

  const healthy = errors === 0 && checks > 0
  await sendEmail(
    `${healthy ? '✅' : '🟡'} injury-watch: daily summary`,
    `Last 24 hours:\n\n` +
    `Checks run: ${checks}\n` +
    `Failed checks: ${errors}\n` +
    `Game-day watches started: ${watches?.length ?? 0}\n` +
    `Player status changes: ${all.length}\n` +
    (notable.length > 0 ? `\nNow Out or Doubtful:\n  → ${notable.map(line).join('\n  → ')}\n` : '')
  )

  await supabase.from('function_run_log').insert({
    function_name: FUNCTION_NAME,
    scheduled_for: now.toISOString(),
    status: 'success',
    completed_at: now.toISOString(),
    summary: { checks, errors, watches: watches?.length ?? 0, changes: all.length },
  })
}

// ── Main ──
async function main() {
  const players = await loadPlayers()
  const stopAt = await getStopAt()

  if (!stopAt) {
    // No games soon: one check (hourly runs pick up weekday injury reports).
    try {
      await checkOnce(players)
    } catch (error) {
      console.error('check failed:', error)
      await recordError(error)
    }
  } else {
    // Games soon: keep checking until they kick off.
    console.log(`Watching until ${new Date(stopAt).toISOString()}`)
    const started = Date.now()
    while (true) {
      try {
        await checkOnce(players)
      } catch (error) {
        console.error('check failed:', error)
        await recordError(error)
      }
      const now = Date.now()
      if (now >= stopAt || now - started >= MAX_RUNTIME_MIN * 60000) break
      await sleep(Math.min(POLL_EVERY_MIN * 60000, stopAt - now))
    }
  }

  await maybeSendDailySummary()
  console.log('Done.')
}

try {
  await main()
} catch (error) {
  console.error('injury-watch error:', error)
  await recordError(error)
  Deno.exit(1)
}
