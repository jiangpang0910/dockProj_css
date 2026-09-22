import { route } from "@/server/http/route";
import { openSample } from "@/server/services/projects";

export const runtime = "nodejs";
export const maxDuration = 60; // first open clones the sample (~2,100 bookings) + a possibly cold DB

/** The account's copy of the sample: reused if it exists, cloned once if not. */
export const POST = route(async (_req, _params, session) => openSample(session));
