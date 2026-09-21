import { route } from "@/server/http/route";
import { runAudit } from "@/server/services/audit";

export const runtime = "nodejs";

export const GET = route<{ pid: string }>(async (_req, { pid }) => runAudit(pid));
