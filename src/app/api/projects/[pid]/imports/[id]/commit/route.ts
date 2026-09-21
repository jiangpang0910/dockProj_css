import { route } from "@/server/http/route";
import { commitImport } from "@/server/services/imports";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = route<{ pid: string; id: string }>(async (_req, { pid, id }) => commitImport(pid, id));
