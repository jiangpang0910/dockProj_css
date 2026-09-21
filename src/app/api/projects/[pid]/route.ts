import { ProjectPatchSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { deleteProject, getProject, renameProject } from "@/server/services/projects";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (_req, { pid }) => getProject(pid));
export const PATCH = route<P>(async (req, { pid }) => renameProject(pid, (await readJson(req, ProjectPatchSchema)).name));
export const DELETE = route<P>(async (_req, { pid }) => { await deleteProject(pid); });
