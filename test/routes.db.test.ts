// The HTTP layer: status codes and ApiError bodies, calling the route handlers directly (no server).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { freshDb } from "./helpers/db";
import { makeProject } from "./helpers/seed";
import { getDb } from "@/server/db/pool";
import * as projects from "@/app/api/projects/route";
import * as project from "@/app/api/projects/[pid]/route";
import * as bookings from "@/app/api/projects/[pid]/bookings/route";
import * as validateRoute from "@/app/api/projects/[pid]/bookings/validate/route";
import * as schedule from "@/app/api/projects/[pid]/schedule/route";
import * as berth from "@/app/api/projects/[pid]/berths/[id]/route";
import * as imports from "@/app/api/projects/[pid]/imports/route";
import * as cleanup from "@/app/api/cron/cleanup/route";

let F: Awaited<ReturnType<typeof makeProject>>;
beforeAll(async () => { await freshDb(); }, 60_000);
beforeEach(async () => {
  await getDb().query("TRUNCATE project CASCADE");
  F = await makeProject();
});

const req = (url: string, init?: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> }) =>
  new NextRequest(new URL(url, "http://test"), {
    method: init?.method ?? "GET",
    headers: init?.json !== undefined ? { "content-type": "application/json", ...init?.headers } : init?.headers,
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

  it("projects: POST empty → 201; GET ?ids returns only known, non-template ids", async () => {
    const r = await projects.POST(req("/api/projects", { method: "POST", json: { name: "Mine", start: "empty" } }), noParams);
    expect(r.status).toBe(201);
    const { id } = await r.json();
    const list = await projects.GET(req(`/api/projects?ids=${id},${crypto.randomUUID()}`), noParams);
    expect((await list.json()).map((p: { id: string }) => p.id)).toEqual([id]);
  });

  it("import upload: missing file → 400", async () => {
    const form = new FormData();
    form.set("planTo", "2028-01-01");
    const r = await imports.POST(req(`/x`, { method: "POST", body: form }), ctx({ pid: F.pid }));
    expect(r.status).toBe(400);
  });

  it("cron cleanup requires the secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await cleanup.GET(req("/api/cron/cleanup"), noParams)).status).toBe(403);
    const ok = await cleanup.GET(req("/api/cron/cleanup", { headers: { authorization: "Bearer s3cret" } }), noParams);
    expect(await ok.json()).toEqual({ deleted: 0 });
  });
});
