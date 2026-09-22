/**
 * npm run template:build → public/dock-template.xlsx, "our standard" upload format (backend.md §6).
 * Headers must match pipeline/dockparse/template.py HEADERS exactly. Each sheet gets one example row whose
 * first cell starts with "e.g." — the parser skips it — plus Kind/Type dropdowns and a frozen header row.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/dock-template.xlsx");
const ROWS = 500; // how far down the dropdowns reach

const SHEETS: { name: string; headers: string[]; widths: number[]; example: (string | number | Date | null)[];
  notes: string[]; lists?: Record<number, string[]> }[] = [
  {
    name: "Berths",
    headers: ["Name", "Length (ft)", "Order"],
    widths: [28, 13, 8],
    example: ["e.g. North Pier West", 410, 1],
    notes: ["Unique name", "Leave blank if it isn't on record — nothing booked there can be checked for fit", "Optional row order"],
  },
  {
    name: "Vessels",
    headers: ["Name", "Length (ft)", "Draft (ft)", "Operator", "Notes"],
    widths: [28, 13, 12, 20, 30],
    example: ["e.g. R/V High Drift", 120, 9.5, "WHOI", ""],
    notes: ["Unique name, with prefix (R/V, M/V…)", "Length overall. Blank = unknown (can't be booked by hand until filled)", "Optional", "Optional", "Optional"],
  },
  {
    name: "Bookings",
    headers: ["Berth", "Type", "Vessel / Title", "Start", "End", "Notes"],
    widths: [24, 10, 28, 13, 13, 30],
    example: ["e.g. North Pier West", "vessel", "R/V High Drift", new Date(Date.UTC(2027, 2, 5)), new Date(Date.UTC(2027, 2, 9)), ""],
    notes: ["A berth in this file or already in the project", "vessel, event or closure", "Vessel name, or the event/closure title",
      "First day (inclusive)", "Last day (inclusive)", "Optional"],
    lists: { 2: ["vessel", "event", "closure"] },
  },
];

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dock Scheduling System";
  for (const s of SHEETS) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = s.headers.map((h, i) => ({ header: h, width: s.widths[i] }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
    s.headers.forEach((_, i) => { head.getCell(i + 1).note = s.notes[i]; });
    const ex = ws.addRow(s.example);
    ex.font = { italic: true, color: { argb: "FF8A8F98" } };
    for (const [col, values] of Object.entries(s.lists ?? {})) {
      for (let r = 2; r <= ROWS; r++) {
        ws.getCell(r, Number(col)).dataValidation = {
          type: "list", allowBlank: true, formulae: [`"${values.join(",")}"`],
          showErrorMessage: true, errorTitle: "Not allowed", error: `Use one of: ${values.join(", ")}`,
        };
      }
    }
    if (s.name === "Bookings") {
      for (const c of [4, 5]) ws.getColumn(c).numFmt = "yyyy-mm-dd";
    }
  }
  await wb.xlsx.writeFile(OUT);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
