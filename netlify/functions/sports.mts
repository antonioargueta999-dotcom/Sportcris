// Proxy to ESPN's public site API: team lists, last-10 completed games per team, head-to-head meetings, injury reports, scoreboards and DraftKings odds.
const LEAGUES: Record<string, string> = {
  NHL: 'hockey/nhl',
  NBA: 'basketball/nba',
  NFL: 'football/nfl',
  MLB: 'baseball/mlb',
  NCAAF: 'football/college-football'
}

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
// ESPN's core API carries the DraftKings lines (provider 100) for every event
const CORE = 'https://sports.core.api.espn.com/v2/sports'
const DRAFTKINGS = '100'

const json = (body: unknown, status = 200, maxAge = 0) =>
  Response.json(body, {
    status,
    headers: maxAge
      ? { 'Cache-Control': `public, max-age=${Math.min(maxAge, 300)}`, 'Netlify-CDN-Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}` }
      : {}
  })

async function fetchJson(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ESPN ${res.status}`)
  return res.json()
}

// Prefer the dark-background crest variant, falling back to the default one
const pickLogo = (logos: any[] | undefined) =>
  logos?.find(l => l.rel?.includes('dark') && !l.rel?.includes('scoreboard'))?.href ?? logos?.[0]?.href ?? null

// College football lists every division (~760 teams); keep only FBS programs, taken from the FBS standings
async function getFbsIds(): Promise<Set<string> | null> {
  try {
    const data = await fetchJson('https://site.api.espn.com/apis/v2/sports/football/college-football/standings?group=80')
    const ids = new Set<string>()
    const walk = (node: any) => {
      node.children?.forEach(walk)
      node.standings?.entries?.forEach((e: any) => e.team?.id && ids.add(String(e.team.id)))
    }
    walk(data)
    return ids.size ? ids : null
  } catch {
    return null
  }
}

async function getTeams(league: string) {
  const isCollege = league === LEAGUES.NCAAF
  const [data, fbs] = await Promise.all([
    fetchJson(`${ESPN}/${league}/teams${isCollege ? '?limit=1000' : ''}`),
    isCollege ? getFbsIds() : null
  ])
  const teams = data.sports[0].leagues[0].teams.filter(({ team }: any) => !fbs || fbs.has(String(team.id)))
  return teams.map(({ team }: any) => ({
    id: team.id,
    name: team.displayName,
    short: team.shortDisplayName,
    abbr: team.abbreviation,
    location: team.location,
    nickname: team.name,
    logo: pickLogo(team.logos),
    color: team.color ? `#${team.color}` : null,
    altColor: team.alternateColor ? `#${team.alternateColor}` : null
  }))
}

const scoreOf = (c: any) => Number(c.score?.value ?? c.score)

async function getLast10(league: string, teamId: string) {
  const base = `${ESPN}/${league}/teams/${encodeURIComponent(teamId)}/schedule`
  const current = await fetchJson(base)
  const year = current.requestedSeason?.year ?? current.season?.year
  const team = current.team

  // Regular season + postseason for the current and previous season (preseason is skipped)
  const schedules = await Promise.all(
    [year, year - 1].flatMap(y => [2, 3].map(t => fetchJson(`${base}?season=${y}&seasontype=${t}`).catch(() => ({ events: [] }))))
  )

  const seen = new Set<string>()
  const games = schedules
    .flatMap(s => s.events ?? [])
    .filter(e => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return e.competitions?.[0]?.status?.type?.completed
    })
    .map(e => {
      const comp = e.competitions[0]
      const us = comp.competitors.find((c: any) => c.id === String(teamId))
      const them = comp.competitors.find((c: any) => c.id !== String(teamId))
      if (!us || !them) return null
      return {
        date: e.date,
        home: us.homeAway === 'home',
        opp: them.team?.abbreviation ?? them.team?.displayName ?? '',
        oppLogo: pickLogo(them.team?.logos) ?? them.team?.logo ?? null,
        att: scoreOf(us),
        def: scoreOf(them)
      }
    })
    .filter((g): g is NonNullable<typeof g> => !!g && Number.isFinite(g.att) && Number.isFinite(g.def))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10)
    .reverse() // oldest first, most recent last

  return { team: { id: team?.id, name: team?.displayName, abbr: team?.abbreviation, logo: pickLogo(team?.logos) ?? team?.logo ?? null }, games }
}

// Last meetings between two teams (regular season + postseason, up to 5 seasons back), most recent first
async function getH2H(league: string, teamA: string, teamB: string) {
  const base = `${ESPN}/${league}/teams/${encodeURIComponent(teamA)}/schedule`
  const current = await fetchJson(base)
  const year = current.requestedSeason?.year ?? current.season?.year
  const schedules = await Promise.all(
    [0, 1, 2, 3, 4].flatMap(back => [2, 3].map(t => fetchJson(`${base}?season=${year - back}&seasontype=${t}`).catch(() => ({ events: [] }))))
  )
  const seen = new Set<string>()
  const games = schedules
    .flatMap(s => s.events ?? [])
    .filter(e => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      const comp = e.competitions?.[0]
      return comp?.status?.type?.completed && comp.competitors?.some((c: any) => c.id === String(teamB))
    })
    .map(e => {
      const comp = e.competitions[0]
      const a = comp.competitors.find((c: any) => c.id === String(teamA))
      const b = comp.competitors.find((c: any) => c.id === String(teamB))
      if (!a || !b) return null
      return {
        date: e.date,
        home: a.homeAway === 'home', // venue seen from team A
        neutral: !!comp.neutralSite,
        a: scoreOf(a),
        b: scoreOf(b)
      }
    })
    .filter((g): g is NonNullable<typeof g> => !!g && Number.isFinite(g.a) && Number.isFinite(g.b))
    .sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime())
    .slice(0, 10)
  return { games }
}

// Injury report of the requested teams, with whether each player is a starter on ESPN's depth chart
async function getDepth(league: string, teamId: string) {
  const starters = new Map<string, string>() // athlete id -> depth role (rank 1 slot or rotation spot)
  const backups = new Set<string>()
  try {
    const data = await fetchJson(`${ESPN}/${league}/teams/${encodeURIComponent(teamId)}/depthcharts`)
    for (const chart of data.depthchart ?? []) {
      for (const [slot, pos] of Object.entries<any>(chart.positions ?? {})) {
        // MLB lists the whole rotation under "p": the top five are the starting pitchers
        const top = slot === 'p' ? 5 : 1
        ;(pos.athletes ?? []).forEach((a: any, i: number) => {
          if (!a?.id) return
          if (i < top && !starters.has(a.id)) starters.set(a.id, slot === 'p' ? 'SP' : slot.toUpperCase())
          else if (i < top + 1) backups.add(a.id)
        })
      }
    }
  } catch { /* depth chart not published for every sport */ }
  return { starters, backups, available: starters.size > 0 }
}

async function getInjuries(league: string, teamIds: string[]) {
  const [data, ...depths] = await Promise.all([
    fetchJson(`${ESPN}/${league}/injuries`),
    ...teamIds.map(id => getDepth(league, id))
  ])
  const teams: Record<string, any> = {}
  teamIds.forEach((id, n) => {
    const depth = depths[n]
    const entry = (data.injuries ?? []).find((t: any) => String(t.id) === id)
    const players = (entry?.injuries ?? [])
      .filter((i: any) => i.status && !/^active$/i.test(i.status))
      .map((i: any) => {
        const a = i.athlete ?? {}
        const athleteId = a.links?.map((l: any) => /\/id\/(\d+)/.exec(l.href ?? '')?.[1]).find(Boolean) ?? null
        return {
          id: String(i.id ?? athleteId ?? a.displayName),
          name: a.displayName ?? '',
          pos: a.position?.abbreviation ?? '',
          status: i.status,
          detail: [i.details?.type, i.details?.detail !== i.details?.type ? i.details?.detail : null].filter(v => v && !/not specified/i.test(v)).join(' · '),
          comment: i.shortComment ?? '',
          date: i.date ?? null,
          returnDate: i.details?.returnDate ?? null,
          depth: !depth.available || !athleteId ? null : depth.starters.get(athleteId) ? 'starter' : depth.backups.has(athleteId) ? 'backup' : 'reserve',
          depthRole: athleteId ? depth.starters.get(athleteId) ?? null : null
        }
      })
    teams[id] = { players, depthChart: depth.available }
  })
  return { fetchedAt: new Date().toISOString(), teams }
}

// All games of one day (YYYYMMDD) for a league, with live status and final scores
async function getScoreboard(league: string, date: string) {
  const extra = league === LEAGUES.NCAAF ? '&groups=80&limit=300' : '&limit=300'
  const data = await fetchJson(`${ESPN}/${league}/scoreboard?dates=${date}${extra}`)
  const side = (c: any) => ({
    id: c.team?.id ?? null,
    name: c.team?.displayName ?? '',
    short: c.team?.shortDisplayName ?? '',
    abbr: c.team?.abbreviation ?? '',
    location: c.team?.location ?? '',
    nickname: c.team?.name ?? '',
    logo: c.team?.logo ?? pickLogo(c.team?.logos) ?? null,
    color: c.team?.color ? `#${c.team.color}` : null,
    score: c.score === undefined || c.score === '' ? null : scoreOf(c),
    winner: !!c.winner,
    record: c.records?.[0]?.summary ?? null
  })
  const events = (data.events ?? [])
    .map((e: any) => {
      const comp = e.competitions?.[0]
      const home = comp?.competitors?.find((c: any) => c.homeAway === 'home')
      const away = comp?.competitors?.find((c: any) => c.homeAway === 'away')
      if (!home || !away) return null
      const st = comp.status?.type ?? e.status?.type ?? {}
      return {
        id: e.id,
        date: e.date,
        state: st.state ?? 'pre', // pre | in | post
        completed: !!st.completed,
        detail: st.shortDetail ?? st.detail ?? '',
        venue: comp.venue?.fullName ?? null,
        broadcast: comp.broadcasts?.[0]?.names?.[0] ?? null,
        home: side(home),
        away: side(away)
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
  return { date, events }
}

// "-1.5" / "+3" / "PK" -> number (spreads and totals)
const lineOf = (v: any) => {
  if (v === null || v === undefined || v === '') return null
  if (/^pk$/i.test(String(v).trim())) return 0
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}
// American price "-110" / "+180" / "EVEN" -> number, only when it is a valid American price
const priceOf = (v: any) => {
  if (v === null || v === undefined || v === '') return null
  if (/^even$/i.test(String(v).trim())) return 100
  const n = Math.round(parseFloat(v))
  return Number.isFinite(n) && (n <= -100 || n >= 100) ? n : null
}

// DraftKings line of one event: total, home spread and moneylines, with their prices and opening numbers
async function getEventOdds(league: string, eventId: string) {
  const [sport, lg] = league.split('/')
  const data = await fetchJson(`${CORE}/${sport}/leagues/${lg}/events/${eventId}/competitions/${eventId}/odds`)
  const dk = (data.items ?? []).find((o: any) => String(o.provider?.id) === DRAFTKINGS)
    ?? (data.items ?? []).find((o: any) => /draftkings/i.test(o.provider?.name ?? '') && !/live/i.test(o.provider?.name ?? ''))
  if (!dk) return null
  const home = dk.homeTeamOdds ?? {}
  const away = dk.awayTeamOdds ?? {}
  const odds = {
    total: lineOf(dk.current?.total?.american) ?? lineOf(dk.overUnder),
    over: priceOf(dk.current?.over?.american) ?? priceOf(dk.overOdds),
    under: priceOf(dk.current?.under?.american) ?? priceOf(dk.underOdds),
    spread: lineOf(home.current?.pointSpread?.american) ?? lineOf(dk.spread),
    spreadHome: priceOf(home.current?.spread?.american) ?? priceOf(home.spreadOdds),
    spreadAway: priceOf(away.current?.spread?.american) ?? priceOf(away.spreadOdds),
    mlHome: priceOf(home.current?.moneyLine?.american) ?? priceOf(home.moneyLine),
    mlAway: priceOf(away.current?.moneyLine?.american) ?? priceOf(away.moneyLine),
    open: {
      total: lineOf(dk.open?.total?.american),
      spread: lineOf(home.open?.pointSpread?.american),
      mlHome: priceOf(home.open?.moneyLine?.american),
      mlAway: priceOf(away.open?.moneyLine?.american)
    }
  }
  const values = [odds.total, odds.spread, odds.mlHome, odds.mlAway]
  return values.some(v => v !== null) ? odds : null
}

// DraftKings odds for every game of a day, fetched a few events at a time
async function getOdds(league: string, date: string) {
  const { events } = await getScoreboard(league, date)
  const out: any[] = new Array(events.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(8, events.length) }, async () => {
    while (i < events.length) {
      const n = i++
      const e = events[n]
      const odds = await getEventOdds(league, e.id).catch(() => null)
      out[n] = { id: e.id, date: e.date, state: e.state, detail: e.detail, home: e.home, away: e.away, odds }
    }
  }))
  return { date, provider: 'DraftKings', fetchedAt: new Date().toISOString(), events: out }
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const action = url.pathname.split('/').pop()
  const sport = (url.searchParams.get('sport') || '').toUpperCase()
  const league = LEAGUES[sport]
  if (!league) return json({ error: 'Deporte no válido' }, 400)

  try {
    if (action === 'teams') return json({ teams: await getTeams(league) }, 200, 86400)
    if (action === 'last10') {
      const team = url.searchParams.get('team')
      if (!team || !/^\d+$/.test(team)) return json({ error: 'Equipo no válido' }, 400)
      return json(await getLast10(league, team), 200, 1800)
    }
    if (action === 'h2h') {
      const a = url.searchParams.get('a')
      const b = url.searchParams.get('b')
      if (!a || !b || !/^\d+$/.test(a) || !/^\d+$/.test(b) || a === b) return json({ error: 'Equipos no válidos' }, 400)
      return json(await getH2H(league, a, b), 200, 21600)
    }
    if (action === 'injuries') {
      const ids = (url.searchParams.get('teams') ?? '').split(',').filter(Boolean)
      if (!ids.length || ids.length > 2 || !ids.every(id => /^\d+$/.test(id))) return json({ error: 'Equipos no válidos' }, 400)
      return json(await getInjuries(league, ids), 200, 600)
    }
    if (action === 'scoreboard') {
      const date = url.searchParams.get('date') ?? ''
      if (!/^\d{8}$/.test(date)) return json({ error: 'Fecha no válida' }, 400)
      const data = await getScoreboard(league, date)
      // Settled past days rarely change; live or upcoming days refresh every minute
      const settled = data.events.every((e: any) => e.state === 'post' || e.detail.match(/postponed|canceled|cancelled/i))
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      return json(data, 200, settled && date < today ? 21600 : 60)
    }
    if (action === 'odds') {
      const date = url.searchParams.get('date') ?? ''
      if (!/^\d{8}$/.test(date)) return json({ error: 'Fecha no válida' }, 400)
      const data = await getOdds(league, date)
      // Lines move constantly before kickoff: keep the shared cache very short
      const settled = data.events.every((e: any) => e.state === 'post')
      return json(data, 200, settled ? 3600 : 15)
    }
    return json({ error: 'Ruta no encontrada' }, 404)
  } catch {
    return json({ error: 'No se pudieron obtener los datos' }, 502)
  }
}

export const config = {
  path: ['/api/sports/teams', '/api/sports/last10', '/api/sports/h2h', '/api/sports/injuries', '/api/sports/scoreboard', '/api/sports/odds']
}
