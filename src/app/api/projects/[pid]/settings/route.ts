import { SettingsPatchSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { getSettings, putSettings } from "@/server/services/settings";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (_req, { pid }) => getSettings(pid));
export const PUT = route<P>(async (req, { pid }) => putSettings(pid, await readJson(req, SettingsPatchSchema)));
