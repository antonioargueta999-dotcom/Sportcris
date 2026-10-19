// Reto Escalera: roll a $10 bank toward $1000 one pick at a time; any loss restarts the ladder at day 1.
import type { Config } from '@netlify/functions'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { ladderAttempts, ladderSteps } from '../../db/schema.js'

const START = 10
const GOAL = 1000
const SPORTS = ['NHL', 'NBA', 'NFL', 'NCAAF', 'MLB']
const MARKETS = ['ML', 'Spread', 'Total']
const SIDES = ['A', 'B', 'over', 'under']
const RESULTS = ['win', 'loss', 'push']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type Step = typeof ladderSteps.$inferSelect

const cents = (v: number) => Math.round(v * 100) / 100
const validOdds = (o: unknown): o is number => typeof o === 'number' && Number.isFinite(o) && (o <= -100 || o >= 100)
const profitPerDollar = (odds: number) => odds > 0 ? odds / 100 : 100 / -odds

// Bank once a step is settled (a pending step keeps its stake on the table)
function bankAfter(s: Step) {
  const odds = (s.pick as any).odds
  if (s.result === 'win') return cents(s.bankBefore + s.stake * profitPerDollar(odds))
  if (s.result === 'loss') return cents(s.bankBefore - s.stake)
  return s.bankBefore
}

const currentBank = (steps: Step[]) => steps.length ? bankAfter(steps[steps.length - 1]) : START

// Stake the whole bank, but never more than what's needed to land exactly on the goal
function stakeFor(bank: number, odds: number) {
  const needed = (GOAL - bank) / profitPerDollar(odds)
  return cents(Math.max(0.01, Math.min(bank, Math.ceil(needed * 100) / 100)))
}

const text = (v: unknown, max = 120) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const team = (t: any) => ({ name: text(t?.name, 80), abbr: text(t?.abbr, 10) })

function cleanPick(p: any) {
  if (!p || !SPORTS.includes(p.sport) || !MARKETS.includes(p.market) || !SIDES.includes(p.side) || !validOdds(p.odds)) return null
  const label = text(p.label)
  const teamA = team(p.teamA)
  const teamB = team(p.teamB)
  if (!label || !teamA.name || !teamB.name) return null
  const line = typeof p.line === 'number' && Number.isFinite(p.line) ? p.line : null
  if (p.market !== 'ML' && line === null) return null
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null
  return {
    sport: p.sport, market: p.market, side: p.side, line, odds: p.odds, label,
    matchup: text(p.matchup) ?? `${teamB.name} @ ${teamA.name}`,
    teamA, teamB, prob: num(p.prob), edge: num(p.edge)
  }
}

async function activeAttempt() {
  const [row] = await db.select().from(ladderAttempts).where(eq(ladderAttempts.status, 'active')).orderBy(desc(ladderAttempts.id)).limit(1)
  return row ?? (await db.insert(ladderAttempts).values({}).returning())[0]
}

const stepsOf = (attemptId: number) =>
  db.select().from(ladderSteps).where(eq(ladderSteps.attemptId, attemptId)).orderBy(asc(ladderSteps.id))

async function state() {
  // The current attempt plus up to 30 past ones, with all their steps in a single follow-up query
  const recent = await db.select().from(ladderAttempts).orderBy(desc(ladderAttempts.id)).limit(31)
  const allSteps = recent.length
    ? await db.select().from(ladderSteps).where(inArray(ladderSteps.attemptId, recent.map(a => a.id))).orderBy(asc(ladderSteps.id))
    : []
  const stepsBy = new Map<number, Step[]>()
  for (const s of allSteps) {
    const list = stepsBy.get(s.attemptId)
    if (list) list.push(s)
    else stepsBy.set(s.attemptId, [s])
  }

  // A won ladder stays on screen until a new one is started
  const latest = recent[0]
  const attempt = (latest?.status === 'won' ? latest : recent.find(a => a.status === 'active'))
    ?? (await db.insert(ladderAttempts).values({}).returning())[0]
  const steps = stepsBy.get(attempt.id) ?? []

  const past = recent.filter(a => a.id !== attempt.id).slice(0, 30)
  const history = past.map(a => {
    const own = stepsBy.get(a.id) ?? []
    return {
      id: a.id, status: a.status, startedAt: a.startedAt, endedAt: a.endedAt,
      days: own.length,
      wins: own.filter(s => s.result === 'win').length,
      peak: Math.max(START, ...own.map(bankAfter)),
      lastPick: own.length ? (own[own.length - 1].pick as any).label : null
    }
  }).filter(a => a.days)

  return {
    start: START, goal: GOAL,
    attempt, bank: currentBank(steps),
    steps: steps.map(s => ({ ...s, bankAfter: s.result ? bankAfter(s) : null })),
    history
  }
}

export default async (req: Request) => {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean) // ['api', 'ladder', ...]
  const [, , resource, rawId] = parts

  try {
    if (!resource) {
      if (req.method !== 'GET') return Response.json({ error: 'Método no permitido' }, { status: 405 })
      return Response.json(await state())
    }

    // Abandon the current ladder (if it was started) and begin again at day 1
    if (resource === 'reset' && req.method === 'POST') {
      const [latest] = await db.select().from(ladderAttempts).orderBy(desc(ladderAttempts.id)).limit(1)
      if (latest?.status === 'active') {
        const steps = await stepsOf(latest.id)
        if (steps.length) {
          await db.update(ladderAttempts).set({ status: 'abandoned', endedAt: new Date() }).where(eq(ladderAttempts.id, latest.id))
          await db.insert(ladderAttempts).values({})
        }
      } else {
        await db.insert(ladderAttempts).values({})
      }
      return Response.json(await state())
    }

    if (resource !== 'steps') return Response.json({ error: 'No encontrado' }, { status: 404 })

    // Play today's rung with the recommended pick
    if (!rawId && req.method === 'POST') {
      const body = await req.json().catch(() => null)
      const pick = cleanPick(body?.pick)
      if (!pick || !DATE_RE.test(body?.date ?? '')) return Response.json({ error: 'Pick no válido' }, { status: 400 })
      const [latest] = await db.select().from(ladderAttempts).orderBy(desc(ladderAttempts.id)).limit(1)
      if (latest?.status === 'won') return Response.json({ error: 'La escalera ya llegó a la meta. Empieza una nueva.' }, { status: 409 })
      const attempt = await activeAttempt()
      const steps = await stepsOf(attempt.id)
      if (steps.some(s => !s.result)) return Response.json({ error: 'Ya hay un pick pendiente en la escalera' }, { status: 409 })
      const bank = currentBank(steps)
      await db.insert(ladderSteps).values({ attemptId: attempt.id, date: body.date, bankBefore: bank, stake: stakeFor(bank, pick.odds), pick })
      return Response.json(await state())
    }

    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: 'Paso no válido' }, { status: 400 })
    const [step] = await db.select().from(ladderSteps).where(eq(ladderSteps.id, id))
    const [attempt] = step ? await db.select().from(ladderAttempts).where(eq(ladderAttempts.id, step.attemptId)) : []
    if (!step || attempt?.status !== 'active') return Response.json({ error: 'Paso no encontrado' }, { status: 404 })
    if (step.result) return Response.json({ error: 'Ese pick ya está liquidado' }, { status: 409 })

    // Cancel a pending pick that hasn't been settled
    if (req.method === 'DELETE') {
      await db.delete(ladderSteps).where(eq(ladderSteps.id, id))
      return Response.json(await state())
    }

    // Settle the pending pick: a loss ends the attempt and opens a fresh one at $10
    if (req.method === 'PATCH') {
      const body = await req.json().catch(() => null)
      if (!RESULTS.includes(body?.result)) return Response.json({ error: 'Resultado no válido' }, { status: 400 })
      const [updated] = await db.update(ladderSteps).set({ result: body.result })
        .where(and(eq(ladderSteps.id, id), isNull(ladderSteps.result))).returning()
      if (!updated) return Response.json(await state())
      const bank = bankAfter(updated)
      if (body.result === 'loss' || bank >= GOAL) {
        await db.update(ladderAttempts).set({ status: body.result === 'loss' ? 'lost' : 'won', endedAt: new Date() })
          .where(eq(ladderAttempts.id, attempt.id))
        if (body.result === 'loss') await db.insert(ladderAttempts).values({})
      }
      return Response.json(await state())
    }

    return Response.json({ error: 'Método no permitido' }, { status: 405 })
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'No se pudo acceder al Reto Escalera' }, { status: 500 })
  }
}

export const config: Config = {
  path: ['/api/ladder', '/api/ladder/:resource', '/api/ladder/:resource/:id']
}
