import { IssuesQuerySchema } from "@shared/contract";
import { readQuery, route } from "@/server/http/route";
import { listIssues } from "@/server/services/imports";

export const runtime = "nodejs";

export const GET = route<{ pid: string; id: string }>(async (req, { pid, id }) =>
  listIssues(pid, id, readQuery(req, IssuesQuerySchema)));
