/**
 * The thin HTTP layer shared by every app/api route: session → authorization → parse → call a service → serialise,
 * and one place that turns any thrown error into an ApiError body with the right status.
 */
import type { NextRequest } from "next/server";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { MAX_WINDOW_DAYS, type ISODate, type Session } from "@shared/contract";
import { SESSION_COOKIE, readSession } from "../auth/session";
import { getDb } from "../db/pool";
import { requestProject } from "./request-context";
import type { ProjectRow } from "../services/projects";
import { UnknownEntityError } from "../domain/rules";
import { isISODate, spanDays } from "../domain/dates";
import { fromPgError } from "../db/errors";
import { ApiErr, badRequest, forbidden, notFound, unauthorized } from "./api-error";

type Params = Record<string, string>;
type Handler<P extends Params> = (req: NextRequest, params: P, session: Session) => Promise<unknown>;
interface Opts {
  status?: number;
  /** "none": no session needed (health, cron — they guard themselves). Default: a valid session cookie, else 401. */
  auth?: "session" | "none";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ANON: Session = { user: "", role: "viewer" };

/**
 * Wrap a handler. Return a plain value → 200 JSON (or `status`), `undefined` → 204, a Response → as-is.
 * Every dynamic param must be a UUID; anything else is a 404 (never let a bad id reach Postgres as a cast error).
 *
 * Authorization (infrastructure.md §5) happens here, once, for every route:
 *   - no valid session cookie → 401;
 *   - a write (anything but GET/HEAD) from a viewer → 403;
 *   - a `pid` route: the project must be the caller's own, or the caller an admin → else 403. Templates are readable
 *     by everyone (services reject writes to them with 403).
 */
export function route<P extends Params = Params>(fn: Handler<P>, opts: Opts = {}) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const params = ((await ctx?.params) ?? {}) as P;
      for (const [k, v] of Object.entries(params)) {
        if (!UUID_RE.test(v)) throw notFound(k === "pid" ? "Project" : "Record");
      }
      let session = ANON;
      if (opts.auth !== "none") {
        session = (await readSession(req.cookies.get(SESSION_COOKIE)?.value)) ?? (() => { throw unauthorized(); })();
        const write = !READ_METHODS.has(req.method);
        if (write && session.role === "viewer") throw forbidden("This account is read-only.");
        if (params.pid) {
          const row = await authorizeProject(session, params.pid);
          // reads reuse this row (see requireProject); writes re-read it inside their transaction
          if (READ_METHODS.has(req.method)) return respond(await requestProject.run({ pid: params.pid, row }, () => fn(req, params, session)));
        }
      }
      return respond(await fn(req, params, session));
    } catch (e) {
      return errorResponse(e);
    }
    function respond(out: unknown): Response {
      if (out instanceof Response) return out;
      if (out === undefined) return new Response(null, { status: 204 });
      return Response.json(out, { status: opts.status ?? 200 });
    }
  };
}

/** Owner or admin, or 403. Unknown id → 404 (same as the service would say). Returns the row so reads can reuse it. */
export async function authorizeProject(session: Session, pid: string): Promise<ProjectRow> {
  const { rows: [p] } = await getDb().query<ProjectRow>("SELECT * FROM project WHERE id = $1", [pid]);
  if (!p) throw notFound("Project");
  if (p.template_key || session.role === "admin" || p.owner === session.user) return p;
  throw forbidden("This project belongs to another account.");
}

export function errorResponse(e: unknown): Response {
  const err = toApiErr(e);
  return Response.json(err.body(), { status: err.status });
}

export function toApiErr(e: unknown): ApiErr {
  if (e instanceof ApiErr) return e;
  if (e instanceof UnknownEntityError) return notFound(e.entity === "berth" ? "Berth" : "Vessel");
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return badRequest(msg);
  }
  const pgErr = fromPgError(e);
  if (pgErr) return pgErr;
  console.error("[api] unexpected error", e);
  return new ApiErr("INTERNAL", "Something went wrong on our side. Try again.");
}

export async function readJson<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  return schema.parse(body);
}

export function readQuery<T>(req: NextRequest, schema: ZodType<T, ZodTypeDef, unknown>): T {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams));
}

/** A read window: real dates, from ≤ to, at most MAX_WINDOW_DAYS long. */
export function checkWindow(from: ISODate, to: ISODate): void {
  if (!isISODate(from) || !isISODate(to)) throw badRequest("from/to must be real dates (YYYY-MM-DD).");
  if (to < from) throw badRequest("`to` is before `from`.");
  if (spanDays(from, to) > MAX_WINDOW_DAYS) throw badRequest(`A window can be at most ${MAX_WINDOW_DAYS} days.`);
}
