import { ResolveIssueInputSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { resolveIssue } from "@/server/services/imports";

export const runtime = "nodejs";

export const POST = route<{ pid: string; id: string; issueId: string }>(async (req, { pid, id, issueId }) =>
  resolveIssue(pid, id, issueId, await readJson(req, ResolveIssueInputSchema)));
