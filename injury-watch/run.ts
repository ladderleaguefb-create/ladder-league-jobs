import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const FEED = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'
const LOOK_AHEAD_MIN = 110   // watch games kicking off within this many minutes
const POLL_EVERY_MIN = 3     // how often to check ESPN during a watch
const MAX_RUNTIME_MIN = 120  // safety stop
const MIN_FEED_SIZE = 100    // fewer entries than this = ESPN hiccup, don't trust it

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Download the ESPN feed with curl (ESPN blocks Supabase's servers, not GitHub's).
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

  // A tiny feed is almost certainly an ESPN hiccup, not "everyone is healthy".
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

async function main() {
  const players = await loadPlayers()
  const stopAt = await getStopAt()

  // No games soon: one check (hourly runs pick up weekday injury reports).
  if (!stopAt) {
    await checkOnce(players)
    return
  }

  // Games soon: keep checking until they kick off.
  console.log(`Watching until ${new Date(stopAt).toISOString()}`)
  const started = Date.now()
  while (true) {
    try {
      await checkOnce(players)
    } catch (error) {
      // One bad check shouldn't end the watch; log it and try again next time.
      console.error('check failed:', error)
      await supabase.from('espn_injury_runs').insert({ error: String(error) })
    }

    const now = Date.now()
    if (now >= stopAt || now - started >= MAX_RUNTIME_MIN * 60000) break
    await sleep(Math.min(POLL_EVERY_MIN * 60000, stopAt - now))
  }
  console.log('Done.')
}

try {
  await main()
} catch (error) {
  console.error('injury-watch error:', error)
  await supabase.from('espn_injury_runs').insert({ error: String(error) })
  Deno.exit(1)
}
