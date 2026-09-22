import { route } from "@/server/http/route";
import { listProjects } from "@/server/services/projects";

export const runtime = "nodejs";

// Read-only: there is one workspace, seeded from the workbook (npm run db:seed). Nothing creates projects over HTTP.
export const GET = route(async (_req, _params, session) => listProjects(session));
