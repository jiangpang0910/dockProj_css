/**
 * npm run db:seed [-- --force] — build the two read-only template projects (infrastructure.md §4, backend.md §9):
 *   defaults: backend/seed/defaults.json (6 berths + 2 sections + 164 vessels), no bookings
 *   sample:   a clone of defaults + the sample workbook through the REAL importer (full window, committed),
 *             "today" = 2019-07-01. If the importer breaks, the seed fails — an end-to-end test for free.
 * Idempotent: existing templates are left alone unless --force. User projects are never touched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Db } from "../src/server/db/types";
import { setDb } from "../src/server/db/pool";
import { normalizeName } from "../src/server/services/mappers";
import { commitImport, uploadImport } from "../src/server/services/imports";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULTS_JSON = path.join(ROOT, "backend/seed/defaults.json");
export const SAMPLE_XLSX = path.join(ROOT, "sample_data/Dock Schedule - Synthetic Sample.xlsx");
export const SAMPLE_AS_OF = "2019-07-01";

interface Defaults {
  berths: { name: string; kind?: string; lengthFt: number | null; sortOrder: number }[];   // kind: older defaults.json, ignored
  vessels: { name: string; lengthFt: number; draftFt: number | null }[];
}

export interface SeedOpts { force?: boolean; noModel?: boolean; log?: (s: string) => void; sampleXlsx?: string }

export async function seedTemplates(db: Db, opts: SeedOpts = {}): Promise<{ defaults: string; sample: string }> {
  const log = opts.log ?? (() => {});
  setDb(db); // the importer services use getDb()
  const existing = async (key: string) =>
    (await db.query<{ id: string }>("SELECT id FROM project WHERE template_key = $1", [key])).rows[0]?.id;

  if (opts.force) {
    await db.query("DELETE FROM project WHERE template_key IS NOT NULL");
    log("removed existing templates");
  }

  // ── defaults ──
  let defaults = await existing("defaults");
  if (!defaults) {
    const d: Defaults = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    defaults = await db.tx(async (q) => {
      const { rows: [p] } = await q.query<{ id: string }>(
        "INSERT INTO project (name, origin, template_key) VALUES ('Default fleet', 'defaults', 'defaults') RETURNING id");
      await q.query(
        `INSERT INTO berth (project_id, name, length_ft, sort_order)
         SELECT $1, x.name, x.length_ft, x.sort_order
         FROM jsonb_to_recordset($2::jsonb) AS x(name text, length_ft numeric, sort_order int)`,
        [p.id, JSON.stringify(d.berths.map((b) => ({ name: normalizeName(b.name), length_ft: b.lengthFt, sort_order: b.sortOrder })))]);
      const seen = new Set<string>();
      const vessels = d.vessels.filter((v) => { const k = normalizeName(v.name).toLowerCase(); return !seen.has(k) && !!seen.add(k); });
      await q.query(
        `INSERT INTO vessel (project_id, name, length_ft, draft_ft)
         SELECT $1, x.name, x.length_ft, x.draft_ft FROM jsonb_to_recordset($2::jsonb) AS x(name text, length_ft numeric, draft_ft numeric)`,
        [p.id, JSON.stringify(vessels.map((v) => ({ name: normalizeName(v.name), length_ft: v.lengthFt, draft_ft: v.draftFt })))]);
      return p.id;
    });
    log(`defaults template: ${defaults}`);
  } else log("defaults template exists, kept");

  // ── sample ──
  let sample = await existing("sample");
  if (!sample) {
    const { rows: [c] } = await db.query<{ id: string }>("SELECT clone_project($1, 'Sample — WHOI dock', 'sample') AS id", [defaults]);
    try {
      const file = opts.sampleXlsx ?? SAMPLE_XLSX;
      const run = await uploadImport(c.id, path.basename(file), new Uint8Array(fs.readFileSync(file)),
        { fullWindow: true, noModel: opts.noModel });
      log(`sample import staged: ${run.counts.bookings} bookings, ${run.counts.issues} issues`);
      await commitImport(c.id, run.id);
      await db.query("UPDATE project SET template_key = 'sample', as_of_date = $2 WHERE id = $1", [c.id, SAMPLE_AS_OF]);
      sample = c.id;
      log(`sample template: ${sample}`);
    } catch (e) {
      await db.query("DELETE FROM project WHERE id = $1", [c.id]); // no half-built template
      throw e;
    }
  } else log("sample template exists, kept");

  return { defaults, sample };
}

async function main() {
  const { pgDb } = await import("../src/server/db/pool");
  const db = pgDb(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, 1);
  const force = process.argv.includes("--force");
  const ids = await seedTemplates(db, { force, noModel: !process.env.ANTHROPIC_API_KEY, log: console.log });
  console.log("done", ids);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
