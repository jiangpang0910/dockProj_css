import { ProjectInputSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { createProject, listProjects } from "@/server/services/projects";

export const runtime = "nodejs";
export const maxDuration = 60; // cloning the sample (~2,100 bookings) + a possibly cold DB

export const GET = route(async (_req, _params, session) => listProjects(session));
export const POST = route(async (req, _params, session) => createProject(await readJson(req, ProjectInputSchema), session.user), { status: 201 });
