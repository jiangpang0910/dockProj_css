import { ApplyProposalsInputSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { applyProposals } from "@/server/services/solve";

export const runtime = "nodejs";

/** The proposals the user confirmed: booked through the normal rules, all or nothing. */
export const POST = route<{ pid: string }>(async (req, { pid }) => applyProposals(pid, await readJson(req, ApplyProposalsInputSchema)));
