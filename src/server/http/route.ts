/**
 * The thin HTTP layer shared by every app/api route: parse → call a service → serialise, and one
 * place that turns any thrown error into an ApiError body with the right status.
 */
import type { NextRequest } from "next/server";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import { MAX_WINDOW_DAYS, type ISODate } from "@shared/contract";
import { UnknownEntityError } from "../domain/rules";
import { isISODate, spanDays } from "../domain/dates";
import { fromPgError } from "../db/errors";
import { ApiErr, badRequest, notFound } from "./api-error";

type Params = Record<string, string>;
type Handler<P extends Params> = (req: NextRequest, params: P) => Promise<unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wrap a handler. Return a plain value → 200 JSON (or `status`), `undefined` → 204, a Response → as-is.
 * Every dynamic param must be a UUID; anything else is a 404 (never let a bad id reach Postgres as a cast error).
 */
export function route<P extends Params = Params>(fn: Handler<P>, opts: { status?: number } = {}) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const params = ((await ctx?.params) ?? {}) as P;
      for (const [k, v] of Object.entries(params)) {
        if (!UUID_RE.test(v)) throw notFound(k === "pid" ? "Project" : "Record");
      }
      const out = await fn(req, params);
      if (out instanceof Response) return out;
      if (out === undefined) return new Response(null, { status: 204 });
      return Response.json(out, { status: opts.status ?? 200 });
    } catch (e) {
      return errorResponse(e);
    }
  };
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
