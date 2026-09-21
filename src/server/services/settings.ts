import type { Settings, SettingsPatch } from "@shared/contract";
import { getDb } from "../db/pool";
import { asOfDate, requireProject } from "./projects";

export async function getSettings(pid: string): Promise<Settings> {
  const p = await requireProject(getDb(), pid);
  return { asOfDate: asOfDate(p), asOfSource: p.as_of_date ? "override" : "system" };
}

export async function putSettings(pid: string, patch: SettingsPatch): Promise<Settings> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  await q.query("UPDATE project SET as_of_date = $2 WHERE id = $1", [pid, patch.asOfDate]);
  return getSettings(pid);
}
