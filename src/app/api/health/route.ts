import { getDb } from "@/server/db/pool";
import { ApiErr } from "@/server/http/api-error";
import { route } from "@/server/http/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + DB ping (the first call after Neon idles also wakes it). */
export const GET = route(async () => {
  try {
    await getDb().query("SELECT 1");
  } catch {
    throw new ApiErr("UNAVAILABLE", "The database is unreachable.");
  }
  return { ok: true };
}, { auth: "none" });
