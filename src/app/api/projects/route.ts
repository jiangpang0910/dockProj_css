import { ProjectInputSchema, ProjectsQuerySchema } from "@shared/contract";
import { readJson, readQuery, route } from "@/server/http/route";
import { createProject, listProjects } from "@/server/services/projects";

export const runtime = "nodejs";
export const maxDuration = 60; // cloning the sample (~2,100 bookings) + a possibly cold DB

export const GET = route(async (req) => listProjects(readQuery(req, ProjectsQuerySchema).ids));
export const POST = route(async (req) => createProject(await readJson(req, ProjectInputSchema)), { status: 201 });
