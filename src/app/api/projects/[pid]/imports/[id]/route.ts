import { route } from "@/server/http/route";
import { discardImport, getImport } from "@/server/services/imports";

export const runtime = "nodejs";

type P = { pid: string; id: string };
export const GET = route<P>(async (_req, { pid, id }) => getImport(pid, id));
export const DELETE = route<P>(async (_req, { pid, id }) => { await discardImport(pid, id); });
