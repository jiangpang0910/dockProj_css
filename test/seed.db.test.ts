// db:seed on PGlite: the two templates, idempotence, and clones of each. Runs the real pipeline (slow).
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { seedTemplates } from "../db/seed";
import { createProject } from "@/server/services/projects";
import { getSettings } from "@/server/services/settings";
import { runAudit } from "@/server/services/audit";
import type { Db } from "@/server/db/types";

let db: Db;
beforeAll(async () => { ({ db } = await freshDb()); }, 60_000);

describe.skipIf(!fs.existsSync("pipeline/cli.py"))("seed templates (slow)", () => {
  it("builds defaults + sample, is idempotent, and both clone cleanly", async () => {
    const first = await seedTemplates(db, { noModel: true });
    const again = await seedTemplates(db, { noModel: true });
    expect(again).toEqual(first);

    const fleet = await createProject({ name: "Fleet", start: "defaults" });
    expect(fleet.counts).toEqual({ berths: 8, vessels: 164, bookings: 0 });

    const sample = await createProject({ name: "Sample", start: "sample" });
    expect(sample.counts.berths).toBe(8);
    expect(sample.counts.bookings).toBeGreaterThan(1500);
    expect((await getSettings(sample.id)).asOfDate).toBe("2019-07-01");
    expect((await runAudit(sample.id)).violations).toEqual([]);
  }, 120_000);
});
