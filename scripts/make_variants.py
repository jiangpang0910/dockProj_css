"""Build four test workbooks that all describe the SAME schedule, written four different ways.

    python3 scripts/make_variants.py           → sample_data/variants/{1..4}-*.xlsx + *.truth.json

One dataset (berths, vessels, stays, 2010–2020) is generated once with a fixed seed, then rendered as:
  1  legacy grid     — year per sheet, month blocks, coloured bars: the layout the parser knows today
  2  one tab         — every stay in a single table, plus a Vessels tab of names and lengths
  3  one tab, renamed — the same table with someone else's column names (Boat, Dock, In, Out)
  4  messy           — title rows, merged cells, mixed date spellings, length inside the vessel cell, notes

Each file ships a .truth.json: the stays and vessel lengths it is supposed to yield. A reader is correct when
what it returns equals the truth, so no test needs hand-written expectations.
"""
import datetime as dt
import json
import pathlib
import random

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

OUT = pathlib.Path(__file__).resolve().parent.parent / "sample_data" / "variants"
SEED = 20260922
START, END = dt.date(2010, 1, 1), dt.date(2020, 12, 31)
MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER",
          "NOVEMBER", "DECEMBER"]
WEEKDAY = "MTWTFSS"
BAR_FILLS = ["FFB7D7F0", "FFF6C9A8", "FFCDE6C4", "FFE7C9E7", "FFF4E1A0", "FFC9DCE8"]

BERTHS = [("North Pier West", 410), ("North Pier East", 250), ("North Pier Face", 75), ("South Float West", 180),
          ("South Float East", 120), ("Inner Channel", 90)]
SECTIONS = ["North Finger Piers", "Small Craft Slips"]
PREFIX = ["R/V", "F/V", "M/Y", "S/V", "OSV", "Barge", "Tug"]
ADJ = ["Blue", "Long", "Quiet", "Salt", "Northern", "Bright", "Deep", "Wild", "Golden", "Grey", "High", "Coral"]
NOUN = ["Current", "Horizon", "Petrel", "Sextant", "Wind", "Osprey", "Sound", "Star", "Tern", "Dory", "Ledge",
        "Voyager", "Compass", "Reef", "Marlin", "Lantern", "Skua", "Cove", "Drift", "Anchor"]


def build():
    """The canonical dataset: vessels with lengths, and stays that fit their berth and don't clash — except for
    ten deliberate conflicts at the end, which are what the rules are meant to catch."""
    rng = random.Random(SEED)
    vessels = {}
    while len(vessels) < 380:
        name = f"{rng.choice(PREFIX)} {rng.choice(ADJ)} {rng.choice(NOUN)}"
        if name not in vessels:
            vessels[name] = rng.choice([None, None, 24, 40, 52, 65, 85, 100, 120, 165, 240, 380])
    names = list(vessels)

    busy_berth: dict[str, list] = {b: [] for b, _ in BERTHS}
    busy_berth |= {s: [] for s in SECTIONS}
    busy_vessel: dict[str, list] = {n: [] for n in names}
    free = lambda seq, s, e: all(e < a or b < s for a, b in seq)  # noqa: E731

    stays, day, span = [], (END - START).days, None
    for _ in range(4000):
        if len(stays) >= 1800:
            break
        name = rng.choice(names)
        berth, blen = rng.choice(BERTHS + [(s, None) for s in SECTIONS])
        vlen = vessels[name]
        if blen is not None and vlen is not None and vlen > blen:
            continue                                   # a stay the harbour would never book
        s = START + dt.timedelta(days=rng.randrange(day))
        e = s + dt.timedelta(days=rng.choice([0, 1, 2, 3, 5, 7, 10, 14, 21]))
        if e > END or not free(busy_vessel[name], s, e):
            continue
        shared = berth in SECTIONS
        if not shared and not free(busy_berth[berth], s, e):
            continue
        stays.append({"berth": berth, "vessel": name, "start": s.isoformat(), "end": e.isoformat(), "conflict": None})
        busy_vessel[name].append((s, e))
        if not shared:
            busy_berth[berth].append((s, e))

    # ── ten deliberate conflicts ──
    def clash(kind, berth, name, s, e):
        stays.append({"berth": berth, "vessel": name, "start": s.isoformat(), "end": e.isoformat(), "conflict": kind})

    exclusive = [s for s in stays if s["berth"] not in SECTIONS]
    for base in rng.sample(exclusive, 4):                                   # two vessels on one berth
        s = dt.date.fromisoformat(base["start"]) + dt.timedelta(days=1)
        other = next(n for n in names if n != base["vessel"] and (vessels[n] or 0) <= 75)
        clash("OVERLAP", base["berth"], other, s, s + dt.timedelta(days=2))
    for base in rng.sample(exclusive, 3):                                   # the same vessel in two places
        s = dt.date.fromisoformat(base["start"])
        elsewhere = next(b for b, _ in BERTHS if b != base["berth"])
        clash("VESSEL_DOUBLE_BERTHED", elsewhere, base["vessel"], s, s + dt.timedelta(days=1))
    big = [n for n in names if (vessels[n] or 0) >= 240]
    for i in range(3):                                                      # too long for the berth
        s = dt.date(2013 + i, 6, 3 + i)
        clash("VESSEL_TOO_LONG", "North Pier Face", big[i], s, s + dt.timedelta(days=2))

    stays.sort(key=lambda r: (r["start"], r["berth"]))
    return {"berths": [{"name": b, "lengthFt": l, "kind": "berth"} for b, l in BERTHS]
                       + [{"name": s, "lengthFt": None, "kind": "section"} for s in SECTIONS],
            "vessels": [{"name": n, "lengthFt": l} for n, l in sorted(vessels.items())],
            "bookings": stays}


# ───────────────────────── renderings ─────────────────────────

def variant1_grid(data, path):
    """The legacy layout: one sheet per year, month blocks, a coloured bar per stay, plus Science/Yachts registry tabs."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    by_year: dict[int, list] = {}
    for s in data["bookings"]:
        a, b = dt.date.fromisoformat(s["start"]), dt.date.fromisoformat(s["end"])
        cur = a
        while cur <= b:                                  # a stay crossing a month is drawn in each month block
            last = min(b, dt.date(cur.year, cur.month, 28) + dt.timedelta(days=4))
            last = min(b, last.replace(day=1) - dt.timedelta(days=1)) if last.month != cur.month else last
            by_year.setdefault(cur.year, []).append((cur.month, s, cur, last))
            cur = last + dt.timedelta(days=1)
    fill_of = {}
    for year in sorted(by_year):
        ws = wb.create_sheet(str(year))
        ws.column_dimensions["A"].width = 26
        r = 1
        for mon in range(1, 13):
            ndays = (dt.date(mon // 12 + year, mon % 12 + 1, 1) - dt.timedelta(days=1)).day
            ws.cell(r, 1, f"{MONTHS[mon - 1]} {year}").font = Font(bold=True)
            for d in range(1, ndays + 1):
                ws.cell(r + 1, 1 + d, d)
                ws.cell(r + 2, 1 + d, WEEKDAY[dt.date(year, mon, d).weekday()])
            rows = [x for x in by_year[year] if x[0] == mon]
            row_at = r + 3
            for berth in data["berths"]:
                mine = [x for x in rows if x[1]["berth"] == berth["name"]]
                lanes: list[list] = []
                for x in sorted(mine, key=lambda x: x[2]):
                    lane = next((l for l in lanes if l[-1][3] < x[2]), None)
                    (lane if lane is not None else lanes.setdefault(len(lanes), []) if False else None)
                    if lane is None:
                        lanes.append([x])
                    else:
                        lane.append(x)
                for lane in lanes or [[]]:
                    label = f"{berth['name']} - {berth['lengthFt']}'" if berth["kind"] == "berth" else berth["name"]
                    ws.cell(row_at, 1, label)
                    for _, stay, a, b in lane:
                        colour = fill_of.setdefault(stay["vessel"], BAR_FILLS[len(fill_of) % len(BAR_FILLS)])
                        fill = PatternFill("solid", fgColor=colour)
                        for d in range(a.day, b.day + 1):
                            ws.cell(row_at, 1 + d).fill = fill
                        ws.cell(row_at, 1 + a.day, stay["vessel"]).alignment = Alignment(horizontal="left")
                    row_at += 1
            r = row_at + 1
    sci = wb.create_sheet("Science")
    yac = wb.create_sheet("Yachts")
    for v in data["vessels"]:
        if v["lengthFt"] is None:
            continue
        ws = yac if v["name"].startswith(("M/Y", "S/V")) else sci
        ws.append([f"{v['name']} {v['lengthFt']}'"])
        ws.append([f"LOA: {v['lengthFt']}', Draft: {round(v['lengthFt'] / 9)}'"])
        ws.append([])
    wb.save(path)


def variant2_one_tab(data, path):
    """Everything in one tab, with a separate tab listing vessels and their lengths."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws = wb.create_sheet("Schedule")
    ws.append(["Berth", "Vessel", "Start", "End"])
    for s in data["bookings"]:
        ws.append([s["berth"], s["vessel"], dt.date.fromisoformat(s["start"]), dt.date.fromisoformat(s["end"])])
    v = wb.create_sheet("Vessels")
    v.append(["Vessel", "Length (ft)"])
    for x in data["vessels"]:
        v.append([x["name"], x["lengthFt"]])
    b = wb.create_sheet("Berths")
    b.append(["Berth", "Length (ft)"])
    for x in data["berths"]:
        b.append([x["name"], x["lengthFt"]])
    wb.save(path)


def variant3_renamed(data, path):
    """The same single table, with someone else's words for the columns and the columns in a different order."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws = wb.create_sheet("Sheet1")
    ws.append(["Boat", "In", "Out", "Dock", "Remarks"])
    for s in data["bookings"]:
        ws.append([s["vessel"], dt.date.fromisoformat(s["start"]), dt.date.fromisoformat(s["end"]), s["berth"], None])
    f = wb.create_sheet("Fleet")
    f.append(["Boat", "LOA (ft)"])
    for x in data["vessels"]:
        f.append([x["name"], x["lengthFt"]])
    wb.save(path)
    # this file never says how long any berth is: only the shared sections, known by name, can be expected back
    return {"berths": [b for b in data["berths"] if b["kind"] == "section"]}


def variant4_messy(data, path):
    """Everything a person does to a spreadsheet: a title, blank rows, dates typed three ways, the length written
    into the vessel cell, a merged banner, notes, and a second tab holding part of the same year."""
    rng = random.Random(SEED + 4)
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws = wb.create_sheet("DOCK BOOK (master)")
    ws["B2"] = "HARBOUR DOCK BOOK — please do not edit without asking Sam"
    ws.merge_cells("B2:F2")
    ws["B3"] = "printed 12 Jan"
    ws.append([])
    head_row = 6
    for c, h in enumerate(["", "VESSEL (LOA)", "WHERE", "FROM", "TO", "NOTES"], start=1):
        ws.cell(head_row, c, h).font = Font(bold=True)

    def spell(d: dt.date, how: int):
        return {0: d, 1: d.strftime("%d/%m/%Y"), 2: d.strftime("%d %b %Y"), 3: d.strftime("%m-%d-%y")}[how]

    r = head_row + 1
    split_year = 2016
    stated = set()                                     # vessels whose length this file actually writes down
    for s in data["bookings"]:
        a, b = dt.date.fromisoformat(s["start"]), dt.date.fromisoformat(s["end"])
        if a.year == split_year:
            continue                                   # that year lives on the second tab
        if rng.random() < 0.04:
            r += 1                                     # a blank row, for no reason
        length = next((v["lengthFt"] for v in data["vessels"] if v["name"] == s["vessel"]), None)
        vessel = f"{s['vessel']} ({length}')" if length and rng.random() < 0.5 else s["vessel"]
        if vessel != s["vessel"]:
            stated.add(s["vessel"])
        berth = s["berth"].upper() if rng.random() < 0.3 else s["berth"]
        ws.cell(r, 2, vessel)
        ws.cell(r, 3, berth)
        ws.cell(r, 4, spell(a, rng.randrange(4)))
        ws.cell(r, 5, spell(b, rng.randrange(4)))
        if rng.random() < 0.08:
            ws.cell(r, 6, rng.choice(["confirmed", "TBC", "waiting on fuel", "see email"]))
        r += 1

    ws2 = wb.create_sheet(f"{split_year} only")
    ws2["A1"] = f"{split_year}"
    ws2.append([])
    ws2.append(["Dock", "Boat", "Dates"])
    for s in data["bookings"]:
        a, b = dt.date.fromisoformat(s["start"]), dt.date.fromisoformat(s["end"])
        if a.year != split_year:
            continue
        ws2.append([s["berth"], s["vessel"], f"{a.strftime('%-d %b')} - {b.strftime('%-d %b %Y')}"])
    notes = wb.create_sheet("notes")
    notes["A1"] = "berth lengths"
    for i, x in enumerate(data["berths"], start=2):
        notes.cell(i, 1, x["name"])
        notes.cell(i, 2, f"{x['lengthFt']} ft" if x["lengthFt"] else "various")
    wb.save(path)
    # the truth is what the file SAYS: this file has no vessel list, so a vessel that is never booked isn't in it,
    # and a length it never wrote down can't be expected back
    booked = {s["vessel"] for s in data["bookings"]}
    return {"vessels": [dict(v, lengthFt=v["lengthFt"] if v["name"] in stated else None)
                        for v in data["vessels"] if v["name"] in booked]}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    data = build()
    files = [("1-grid-clone", variant1_grid), ("2-one-tab", variant2_one_tab),
             ("3-renamed-columns", variant3_renamed), ("4-messy", variant4_messy)]
    for name, render in files:
        path = OUT / f"{name}.xlsx"
        truth = dict(data, **(render(data, path) or {}))
        (OUT / f"{name}.truth.json").write_text(json.dumps(truth, indent=1))
        print(f"{path.name:<24} {path.stat().st_size // 1024:>5} KB")
    n = len(data["bookings"])
    print(f"\n{n} stays, {len(data['vessels'])} vessels, {len(data['berths'])} berths, "
          f"{sum(1 for s in data['bookings'] if s['conflict'])} deliberate conflicts, {START}..{END}")


if __name__ == "__main__":
    main()
