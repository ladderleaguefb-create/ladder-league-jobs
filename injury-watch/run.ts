import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const FEED = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'
const LOOK_AHEAD_MIN = 110   // watch games kicking off within this many minutes
const POLL_EVERY_MIN = 3     // how often to check ESPN
const MAX_RUNTIME_MIN = 120  // safety stop

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

// When to stop: the latest kickoff among games starting soon.
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

// The last thing we logged for each player (loaded once, then kept up to date).
async function loadLast(): Promise<Map<string, any>> {
  const last = new Map<string, any>()
  for (let from = 0; ; from += 1000) {
    const { data: rows, error } = await supabase
      .from('espn_injury_log')
      .select('espn_athlete_id, player_name, team, position, status, status_code, espn_updated_at')
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    for (const r of rows ?? []) last.set(r.espn_athlete_id, r)
    if (!rows || rows.length < 1000) break
  }
  return last
}

async function checkOnce(last: Map<string, any>): Promise<void> {
  const data = await fetchFeed()

  const current = new Map<string, any>()
  for (const team of data.injuries ?? []) {
    for (const inj of team.injuries ?? []) {
      const id = athleteIdFrom(inj)
      if (!id) continue
      current.set(id, {
        espn_athlete_id: id,
        player_name: inj.athlete?.displayName ?? null,
        team: team.displayName ?? null,
        position: inj.athlete?.position?.abbreviation ?? null,
        status: inj.status ?? null,
        status_code: inj.type?.abbreviation ?? null,
        espn_updated_at: inj.date ?? null,
        comment: inj.shortComment || null,
      })
    }
  }

  // Safety: an empty feed is almost certainly an ESPN hiccup, not "everyone healthy".
  if (current.size === 0) throw new Error('ESPN feed returned no players')

  const toInsert: any[] = []
  for (const [id, now] of current) {
    const prev = last.get(id)
    const prevTime = prev?.espn_updated_at ? new Date(prev.espn_updated_at).getTime() : null
    const nowTime = now.espn_updated_at ? new Date(now.espn_updated_at).getTime() : null
    if (!prev || prev.status !== now.status || prev.status_code !== now.status_code || prevTime !== nowTime) {
      toInsert.push(now)
    }
  }
  for (const [id, prev] of last) {
    if (!current.has(id) && prev.status !== 'Not listed') {
      toInsert.push({
        espn_athlete_id: id, player_name: prev.player_name, team: prev.team,
        position: prev.position, status: 'Not listed', status_code: null,
        espn_updated_at: null, comment: null,
      })
    }
  }

  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await supabase.from('espn_injury_log').insert(toInsert.slice(i, i + 500))
    if (error) throw error
  }
  for (const row of toInsert) last.set(row.espn_athlete_id, row)

  await supabase.from('espn_injury_runs').insert({ players_seen: current.size, changes: toInsert.length })
  console.log(`${new Date().toISOString()} players_seen=${current.size} changes=${toInsert.length}`)
}

async function main() {
  const stopAt = await getStopAt()
  if (!stopAt) {
    console.log('No games kicking off soon. Nothing to watch.')
    return
  }
  console.log(`Watching until ${new Date(stopAt).toISOString()}`)

  const started = Date.now()
  const last = await loadLast()

  while (true) {
    try {
      await checkOnce(last)
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

await main()
