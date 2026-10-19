// Daily log of analyzed slates: one record per day, listed per year for the calendar view.
import type { Config } from '@netlify/functions'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { dailyAnalyses } from '../../db/schema.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_GAMES = 100

export default async (req: Request) => {
  const url = new URL(req.url)
  const date = url.pathname.split('/')[3]

  try {
    // Calendar summary: which days of the year have saved analyses
    if (!date) {
      if (req.method !== 'GET') return Response.json({ error: 'Método no permitido' }, { status: 405 })
      // Full slates for a date range, used to grade the picks against final scores
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      if (from || to) {
        if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '') || from! > to!) {
          return Response.json({ error: 'Rango no válido' }, { status: 400 })
        }
        const rows = await db
          .select({ date: dailyAnalyses.date, games: dailyAnalyses.games })
          .from(dailyAnalyses)
          .where(and(gte(dailyAnalyses.date, from!), lte(dailyAnalyses.date, to!)))
          .orderBy(asc(dailyAnalyses.date))
        return Response.json({ days: rows })
      }
      const year = url.searchParams.get('year') ?? ''
      if (!/^\d{4}$/.test(year)) return Response.json({ error: 'Año no válido' }, { status: 400 })
      const days = await db
        .select({ date: dailyAnalyses.date, count: dailyAnalyses.gameCount, games: dailyAnalyses.games })
        .from(dailyAnalyses)
        .where(and(gte(dailyAnalyses.date, `${year}-01-01`), lte(dailyAnalyses.date, `${year}-12-31`)))
        .orderBy(asc(dailyAnalyses.date))
      return Response.json({
        days: days.map(d => ({
          date: d.date,
          count: d.count,
          sports: [...new Set((d.games as any[]).map(g => g?.sport).filter(Boolean))]
        }))
      })
    }

    if (!DATE_RE.test(date)) return Response.json({ error: 'Fecha no válida' }, { status: 400 })

    if (req.method === 'GET') {
      const [row] = await db.select().from(dailyAnalyses).where(eq(dailyAnalyses.date, date))
      return Response.json({ date, games: row?.games ?? [], updatedAt: row?.updatedAt ?? null })
    }

    if (req.method === 'PUT') {
      const body = await req.json().catch(() => null)
      const games = body?.games
      if (!Array.isArray(games) || games.length > MAX_GAMES) {
        return Response.json({ error: 'Datos no válidos' }, { status: 400 })
      }
      if (!games.length) {
        await db.delete(dailyAnalyses).where(eq(dailyAnalyses.date, date))
        return Response.json({ date, games: [] })
      }
      const values = { games, gameCount: games.length, updatedAt: new Date() }
      await db
        .insert(dailyAnalyses)
        .values({ date, ...values })
        .onConflictDoUpdate({ target: dailyAnalyses.date, set: values })
      return Response.json({ date, games })
    }

    return Response.json({ error: 'Método no permitido' }, { status: 405 })
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'No se pudo acceder al historial' }, { status: 500 })
  }
}

export const config: Config = {
  path: ['/api/analyses', '/api/analyses/:date']
}
