// The HTTP layer: status codes and ApiError bodies, calling the route handlers directly (no server).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { freshDb } from "./helpers/db";
import { makeProject } from "./helpers/seed";
import { cookieFor, installAccounts } from "./helpers/auth";
import { getDb } from "@/server/db/pool";
import * as projects from "@/app/api/projects/route";
import * as project from "@/app/api/projects/[pid]/route";
import * as bookings from "@/app/api/projects/[pid]/bookings/route";
import * as validateRoute from "@/app/api/projects/[pid]/bookings/validate/route";
import * as schedule from "@/app/api/projects/[pid]/schedule/route";
import * as berth from "@/app/api/projects/[pid]/berths/[id]/route";
import * as cleanup from "@/app/api/cron/cleanup/route";

let F: Awaited<ReturnType<typeof makeProject>>;
const COOKIE: Record<string, string> = {};
beforeAll(async () => {
  installAccounts();
  for (const u of ["admin", "editor", "other", "viewer"] as const) COOKIE[u] = await cookieFor(u);
  await freshDb();
}, 60_000);
beforeEach(async () => {
  await getDb().query("TRUNCATE project CASCADE");
  F = await makeProject();
  await getDb().query("UPDATE project SET owner = 'editor' WHERE id = $1", [F.pid]);
});

type Who = "admin" | "editor" | "other" | "viewer" | "nobody";
/** A request as `as` (default: the editor who owns F). */
const req = (url: string, init?: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; as?: Who }) =>
  new NextRequest(new URL(url, "http://test"), {
    method: init?.method ?? "GET",
    headers: {
      ...(init?.as === "nobody" ? {} : { cookie: COOKIE[init?.as ?? "editor"] }),
      ...(init?.json !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const noParams = ctx({});

describe("routes", () => {
  it("POST booking → 201; overlap → 409 CONFLICT with violations", async () => {
    const body = { berthId: F.NPW, occupantType: "vessel", vesselId: F.BIG, startDate: "2027-03-05", endDate: "2027-03-09" };
    const ok = await bookings.POST(req(`/api/projects/${F.pid}/bookings`, { method: "POST", json: body }), ctx({ pid: F.pid }));
    expect(ok.status).toBe(201);
    const clash = await bookings.POST(req(`/api/projects/${F.pid}/bookings`, { method: "POST", json: body }), ctx({ pid: F.pid }));
    expect(clash.status).toBe(409);
    const err = await clash.json();
    expect(err.error.code).toBe("CONFLICT");
    expect(err.error.violations.map((v: { code: string }) => v.code)).toEqual(["OVERLAP", "VESSEL_DOUBLE_BERTHED"]);
  });

  it("malformed body → 400 VALIDATION; bad JSON → 400", async () => {
    const r = await bookings.POST(req(`/x`, { method: "POST", json: { berthId: "nope" } }), ctx({ pid: F.pid }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("VALIDATION");
    const r2 = await bookings.POST(req(`/x`, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }), ctx({ pid: F.pid }));
    expect(r2.status).toBe(400);
  });

  it("validate is always 200, even with violations", async () => {
    const body = { berthId: F.SFE, occupantType: "vessel", vesselId: F.BIG, startDate: "2027-03-09", endDate: "2027-03-05" };
    const r = await validateRoute.POST(req(`/x`, { method: "POST", json: body }), ctx({ pid: F.pid }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(false);
  });

  it("a non-UUID or unknown project id → 404", async () => {
    expect((await project.GET(req("/x"), ctx({ pid: "not-a-uuid" }))).status).toBe(404);
    expect((await project.GET(req("/x"), ctx({ pid: crypto.randomUUID() }))).status).toBe(404);
  });

  it("schedule window: > MAX_WINDOW_DAYS or reversed → 400; missing params → 400", async () => {
    const s = (q: string) => schedule.GET(req(`/api/projects/${F.pid}/schedule?${q}`), ctx({ pid: F.pid }));
    expect((await s("from=2027-01-01&to=2027-12-31")).status).toBe(200);
    expect((await s("from=2027-01-01&to=2028-01-02")).status).toBe(400);
    expect((await s("from=2027-02-01&to=2027-01-01")).status).toBe(400);
    expect((await s("from=2027-01-01")).status).toBe(400);
  });

  it("DELETE → 204; a referenced berth → 409", async () => {
    const del = await berth.DELETE(req("/x", { method: "DELETE" }), ctx({ pid: F.pid, id: F.SLIPS }));
    expect(del.status).toBe(204);
    await bookings.POST(req(`/x`, { method: "POST",
      json: { berthId: F.NPW, occupantType: "event", title: "Sail day", startDate: "2027-03-05", endDate: "2027-03-05" } }), ctx({ pid: F.pid }));
    expect((await berth.DELETE(req("/x", { method: "DELETE" }), ctx({ pid: F.pid, id: F.NPW }))).status).toBe(409);
  });

  it("projects: GET lists only the caller's (admin: everyone's)", async () => {
    const mine = await makeProject();
    await getDb().query("UPDATE project SET owner = 'editor' WHERE id = $1", [mine.pid]);
    const ids = async (as: Who) => (await (await projects.GET(req("/api/projects", { as }), noParams)).json()).map((p: { id: string }) => p.id).sort();
    expect(await ids("editor")).toEqual([F.pid, mine.pid].sort());
    expect(await ids("other")).toEqual([]);
    expect(await ids("admin")).toEqual([F.pid, mine.pid].sort());
  });

  it("no session → 401 on every route; a viewer → 403 on writes, 200 on reads", async () => {
    expect((await projects.GET(req("/api/projects", { as: "nobody" }), noParams)).status).toBe(401);
    expect((await project.GET(req("/x", { as: "nobody" }), ctx({ pid: F.pid }))).status).toBe(401);
    expect((await (await projects.GET(req("/api/projects", { as: "nobody" }), noParams)).json()).error.code).toBe("UNAUTHORIZED");
    await getDb().query("UPDATE project SET owner = 'viewer' WHERE id = $1", [F.pid]);
    expect((await project.GET(req("/x", { as: "viewer" }), ctx({ pid: F.pid }))).status).toBe(200);
    expect((await project.PATCH(req("/x", { method: "PATCH", json: { name: "Nope" }, as: "viewer" }), ctx({ pid: F.pid }))).status).toBe(403);
  });

  it("another account's project → 403 (admins get in); a template is readable by anyone", async () => {
    expect((await project.GET(req("/x", { as: "other" }), ctx({ pid: F.pid }))).status).toBe(403);
    expect((await project.GET(req("/x", { as: "admin" }), ctx({ pid: F.pid }))).status).toBe(200);
    expect((await project.GET(req("/x", { as: "editor" }), ctx({ pid: F.pid }))).status).toBe(200);
    const t = await makeProject({ template: "defaults" });
    expect((await project.GET(req("/x", { as: "other" }), ctx({ pid: t.pid }))).status).toBe(200);
    expect((await project.PATCH(req("/x", { method: "PATCH", json: { name: "Nope" }, as: "admin" }), ctx({ pid: t.pid }))).status).toBe(403);
  });

  it("cron cleanup requires the secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await cleanup.GET(req("/api/cron/cleanup"), noParams)).status).toBe(403);
    const ok = await cleanup.GET(req("/api/cron/cleanup", { headers: { authorization: "Bearer s3cret" } }), noParams);
    expect(await ok.json()).toEqual({ deleted: 0 });
  });
});
