import { Router, type NextFunction, type Request, type Response } from "express"
import { and, asc, eq, gt } from "drizzle-orm"
import { z } from "zod"
import { searchRunEvents, searchRuns, withWorkspace, type Database } from "@alg/db"
import { AppError, PROBLEM_TYPES } from "@alg/shared"
import { requireContext } from "../middleware/auth.js"

/**
 * Server-sent progress for a run.
 *
 * Events are read from search_run_events rather than pushed from the worker, for
 * two reasons: the worker is a separate process, and a client that reconnects
 * needs the events it missed. `Last-Event-ID` carries the sequence number, so a
 * dropped connection resumes exactly where it left off.
 *
 * SSE rather than WebSockets because the traffic is one-way and SSE survives
 * proxies without extra configuration.
 */

const IdParamSchema = z.object({ runId: z.uuid() })

const POLL_INTERVAL_MS = 1000
/** Proxies close idle connections; a comment line keeps them open. */
const HEARTBEAT_MS = 15_000
/** A run that produces nothing for this long is treated as gone. */
const MAX_DURATION_MS = 30 * 60 * 1000

export interface StreamsRouterOptions {
  db: Database
}

export function createStreamsRouter(options: StreamsRouterOptions): Router {
  const router = Router()

  router.get("/streams/:runId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = requireContext(req)
      const { runId } = IdParamSchema.parse(req.params)

      const [run] = await withWorkspace(
        ctx,
        async ({ tx, scope }) =>
          tx
            .select()
            .from(searchRuns)
            .where(scope(searchRuns, eq(searchRuns.id, runId)))
            .limit(1),
        options.db
      )

      if (!run) {
        throw new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "Run not found." })
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Traefik and nginx buffer by default, which would hold events back
        // until the response ends - defeating the point of streaming.
        "x-accel-buffering": "no",
      })

      const resumeFrom = Number(req.header("last-event-id") ?? "0")
      let lastSequence = Number.isFinite(resumeFrom) && resumeFrom > 0 ? resumeFrom : 0
      let closed = false

      const send = (event: { sequence: number; type: string; payload: unknown }): void => {
        if (closed) return
        res.write(`id: ${event.sequence}\n`)
        res.write(`event: ${event.type}\n`)
        res.write(`data: ${JSON.stringify(event.payload ?? {})}\n\n`)
      }

      // Tell the client where the run stands before streaming increments.
      send({
        sequence: lastSequence,
        type: "state",
        payload: {
          run_id: run.id,
          status: run.status,
          entities_found: run.entitiesFound,
          entities_new: run.entitiesNew,
          entities_duplicate: run.entitiesDuplicate,
        },
      })

      const heartbeat = setInterval(() => {
        if (!closed) res.write(": keepalive\n\n")
      }, HEARTBEAT_MS)

      const startedAt = Date.now()

      const cleanup = (): void => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        clearInterval(poller)
        res.end()
      }

      const poller = setInterval(() => {
        void (async () => {
          if (closed) return

          try {
            const events = await withWorkspace(
              ctx,
              async ({ tx, scope }) =>
                tx
                  .select()
                  .from(searchRunEvents)
                  .where(
                    scope(
                      searchRunEvents,
                      and(
                        eq(searchRunEvents.runId, runId),
                        gt(searchRunEvents.sequence, lastSequence)
                      )
                    )
                  )
                  .orderBy(asc(searchRunEvents.sequence))
                  .limit(100),
              options.db
            )

            for (const event of events) {
              send({ sequence: event.sequence, type: event.type, payload: event.payload })
              lastSequence = event.sequence

              if (event.type === "completed" || event.type === "failed") {
                cleanup()
                return
              }
            }

            if (Date.now() - startedAt > MAX_DURATION_MS) {
              send({
                sequence: lastSequence + 1,
                type: "timeout",
                payload: { reason: "stream_duration_exceeded" },
              })
              cleanup()
            }
          } catch {
            // A transient database error should not tear down the stream; the
            // next tick retries.
          }
        })()
      }, POLL_INTERVAL_MS)

      req.on("close", cleanup)
      res.on("close", cleanup)
    } catch (error) {
      next(error)
    }
  })

  return router
}
