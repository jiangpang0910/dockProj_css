// Mock fixtures: the real default fleet (backend/seed/defaults.json) plus a generated busy 2019 season,
// so the sample project looks like the real one. Deterministic (seeded) so screenshots are stable.
import type { Berth, Booking, ISODate, Vessel } from "@shared/contract";
import defaults from "../../../../backend/seed/defaults.json";
import { addDays, overlaps } from "@/lib/dates";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededUuid(r: () => number): string {
  const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
  h[12] = "4";
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : seededUuid(Math.random);

type DefaultsFile = {
  berths: { name: string; lengthFt: number | null; kind: "berth" | "section"; sortOrder: number }[];
  vessels: { name: string; lengthFt: number; draftFt: number | null }[];
};
const D = defaults as unknown as DefaultsFile;

export function defaultBerths(): Berth[] {
  return D.berths.map((b) => ({ id: newId(), name: b.name, lengthFt: b.lengthFt, kind: b.kind, active: true, sortOrder: b.sortOrder }));
}

export function defaultVessels(): Vessel[] {
  return D.vessels.map((v) => ({ id: newId(), name: v.name, lengthFt: v.lengthFt, draftFt: v.draftFt, operator: null, notes: null }));
}

const EVENTS = ["Community sail day", "Campus open house", "Sea Scouts overnight", "Harbor stroll", "Film night on the pier", "Regatta staging"];
const CLOSURES = ["Maintenance — bollard repair", "Crane inspection", "Float rebuild", "Utility work", "No docking — dredging survey"];
const UNKNOWN_LENGTH = ["M/V Sea Lark", "S/V Kittiwake", "R/V Tern", "F/V Morning Star"];

const nowIso = "2019-06-01T12:00:00Z";

/** The sample project: default fleet + a few legacy vessels with no length + a busy Apr–Oct 2019. */
export function sampleProject(): { berths: Berth[]; vessels: Vessel[]; bookings: Booking[]; asOfDate: ISODate } {
  const r = rng(20190701);
  const berths = defaultBerths();
  const vessels = [
    ...defaultVessels(),
    ...UNKNOWN_LENGTH.map((name) => ({ id: newId(), name, lengthFt: null, draftFt: null, operator: null, notes: "Imported from the legacy workbook" })),
  ];
  const bookings: Booking[] = [];
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const mk = (b: Omit<Booking, "id" | "status" | "source" | "version" | "createdAt" | "updatedAt" | "notes"> & { notes?: string | null }): Booking =>
    ({ notes: null, ...b, id: seededUuid(r), status: "confirmed", source: "import", version: 1, createdAt: nowIso, updatedAt: nowIso });
  const vesselFree = (vid: string, s: ISODate, e: ISODate) =>
    !bookings.some((b) => b.vesselId === vid && overlaps(b.startDate, b.endDate, s, e));

  for (const berth of berths) {
    const exclusive = berth.kind === "berth";
    const fits = vessels.filter((v) => v.lengthFt != null && (!exclusive || v.lengthFt <= (berth.lengthFt ?? 0)) && (exclusive || v.lengthFt <= 60));
    if (exclusive) {
      let d: ISODate = addDays("2019-04-01", Math.floor(r() * 4));
      while (d < "2019-10-31") {
        const roll = r();
        let len: number;
        if (roll < 0.1) {
          len = 1;
          bookings.push(mk({ berthId: berth.id, occupantType: "event", vesselId: null, title: pick(EVENTS), startDate: d, endDate: d }));
        } else if (roll < 0.15) {
          len = 2 + Math.floor(r() * 4);
          bookings.push(mk({ berthId: berth.id, occupantType: "closure", vesselId: null, title: pick(CLOSURES), startDate: d, endDate: addDays(d, len - 1) }));
        } else {
          len = 1 + Math.floor(r() * (r() < 0.6 ? 3 : 10));
          const e = addDays(d, len - 1);
          const candidates = fits.filter((v) => vesselFree(v.id, d, e));
          if (candidates.length) {
            const v = pick(candidates);
            bookings.push(mk({ berthId: berth.id, occupantType: "vessel", vesselId: v.id, title: v.name, startDate: d, endDate: e,
                               notes: r() < 0.15 ? "ETA 0900, shore power requested" : null }));
          }
        }
        d = addDays(d, len + Math.floor(r() * (r() < 0.5 ? 1 : 5)));
      }
    } else {
      // shared sections: many small boats, overlapping freely
      for (let i = 0; i < 38; i++) {
        const s = addDays("2019-05-01", Math.floor(r() * 170));
        const e = addDays(s, Math.floor(r() * 6));
        const candidates = fits.filter((v) => vesselFree(v.id, s, e));
        if (!candidates.length) continue;
        const v = pick(candidates);
        bookings.push(mk({ berthId: berth.id, occupantType: "vessel", vesselId: v.id, title: v.name, startDate: s, endDate: e }));
      }
    }
  }
  return { berths, vessels, bookings, asOfDate: "2019-07-01" };
}
