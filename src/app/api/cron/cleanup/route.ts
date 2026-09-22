import type { NextRequest } from "next/server";
import { ApiErr } from "@/server/http/api-error";
import { route } from "@/server/http/route";
import { cleanupIdleProjects } from "@/server/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vercel Cron, daily: delete user projects idle for 14 days (infrastructure.md §5). */
export const GET = route(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    throw new ApiErr("FORBIDDEN", "Cron only.");
  }
  return { deleted: await cleanupIdleProjects() };
}, { auth: "none" });
