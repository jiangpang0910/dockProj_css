"""The legacy year-per-sheet grid → raw cells (grew out of backend/parse.py).

Layout: one sheet per year; month blocks start at a row whose column A is a month name; berth rows carry labels like
"North Pier West - 410'"; each day is a column; multi-day stays are merged cells. Quirks handled:
  - only day 1 is numbered in old sheets → day n = (column of the 1) + n − 1
  - month-header years can be wrong (the 2010 sheet says "NOVEMBER 2018") → year inferred by sequence
  - sheets 2002–04 open with a copy of the previous December → a (year, month) seen before is dropped
  - rows without a label → NO_BERTH; text left of day 1 → OUTSIDE_MONTH_COLUMNS
"""
import calendar
import datetime
import re

from openpyxl.utils import get_column_letter

from .classify import FT, WEEKDAY_LETTERS, clean, num

MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER",
          "NOVEMBER", "DECEMBER"]
MONTH_RE = re.compile(r"^\s*(%s)\b\s*(\d{4})?\s*$" % "|".join(MONTHS), re.I)
BERTH_RE = re.compile(rf"^\s*(?P<name>.+?)\s+-\s+{FT}\s*$")
SECTION_RE = re.compile(r"^\s*(North Finger Piers|Small craft slips)\b", re.I)
SECTION_NAMES = {"north finger piers": "North Finger Piers", "small craft slips": "Small Craft Slips"}
WEEKDAY_NUM = {"M": 0, "T": 1, "W": 2, "TR": 3, "F": 4}


def berth_from_label(label):
    """'North Pier West - 410'' → ('North Pier West', 'berth', 410); section labels → (name, 'section', None)."""
    if not isinstance(label, str):
        return None
    if (m := BERTH_RE.match(label)):
        name = clean(m["name"])
        return (name.title() if name.isupper() else name, "berth", num(m[2]))
    if (m := SECTION_RE.match(label)):
        return (SECTION_NAMES[m[1].lower()], "section", None)
    return None


def is_grid(wb) -> bool:
    return any(re.fullmatch(r"\d{4}", t) for t in wb.sheetnames)


def parse_grid(wb):
    """→ (cells, berths, issues, n_sheets, n_cells).

    cells:  [{sheet, cell, label, berth, text, start, end}]  (berth = (name, kind, len) or None; start/end = date)
    berths: {name: {"kind", "lengths": {len: count}, "order"}}
    """
    cells, issues, berths = [], [], {}
    seen_blocks = set()
    n_sheets = n_cells = 0

    for ws in wb.worksheets:
        if not re.fullmatch(r"\d{4}", ws.title):
            continue
        n_sheets += 1
        sheet_year = int(ws.title)

        merged_at, covered = {}, set()
        for rng in ws.merged_cells.ranges:
            merged_at[(rng.min_row, rng.min_col)] = rng
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    covered.add((r, c))

        heads = []
        for r in range(1, ws.max_row + 1):
            v = ws.cell(r, 1).value
            if isinstance(v, str) and (m := MONTH_RE.match(v)):
                heads.append((r, MONTHS.index(m[1].upper()) + 1, int(m[2]) if m[2] else None))

        prev = None
        for i, (hr, mon, label_year) in enumerate(heads):
            end_row = heads[i + 1][0] - 1 if i + 1 < len(heads) else ws.max_row

            # Year: trust the first label only if it's within a year of the sheet; after that, go by sequence.
            if prev is None:
                year = label_year if (label_year and abs(label_year - sheet_year) <= 1) else sheet_year
            else:
                year = prev[0] + (1 if mon < prev[1] else 0)
            prev = (year, mon)
            if label_year and label_year != year:
                issues.append(_issue("HEADER_YEAR_MISMATCH", "info", ws.title, f"A{hr}",
                                     f"Header says {MONTHS[mon - 1].title()} {label_year}; by sequence it is {year}. Used {year}."))

            # Day columns: the row (header or up to 2 below) with the most day numbers; anchor on the column holding 1.
            best = None
            for rr in range(hr, min(hr + 3, end_row) + 1):
                nums = {c: ws.cell(rr, c).value for c in range(2, ws.max_column + 1)
                        if isinstance(ws.cell(rr, c).value, int) and 1 <= ws.cell(rr, c).value <= 31}
                if best is None or len(nums) > len(best[1]):
                    best = (rr, nums)
            day_row, nums = best
            col1 = min((c for c, d in nums.items() if d == 1), default=min(nums) if nums else 2)
            ndays = calendar.monthrange(year, mon)[1]
            col2day = {col1 + k: k + 1 for k in range(ndays)}

            if (year, mon) in seen_blocks:
                issues.append(_issue("DUPLICATE_CARRYOVER", "info", ws.title, f"A{hr}",
                                     f"{MONTHS[mon - 1].title()} {year} already appeared on an earlier sheet; this copy was skipped."))
                continue
            seen_blocks.add((year, mon))

            for r in range(day_row + 1, end_row + 1):
                label = ws.cell(r, 1).value
                label = label if isinstance(label, str) and label.strip() else None
                berth = berth_from_label(label)
                if berth:
                    b = berths.setdefault(berth[0], {"kind": berth[1], "lengths": {}, "order": len(berths) + 1})
                    if berth[2] is not None:
                        b["lengths"][berth[2]] = b["lengths"].get(berth[2], 0) + 1
                for c in range(2, ws.max_column + 1):
                    v = ws.cell(r, c).value
                    if v is None or ((r, c) in covered and (r, c) not in merged_at):
                        continue
                    if isinstance(v, (int, float, datetime.date)) or not str(v).strip():
                        continue
                    text = clean(v)
                    if text.upper() in WEEKDAY_LETTERS:
                        continue
                    n_cells += 1
                    ref = f"{get_column_letter(c)}{r}"
                    rng = merged_at.get((r, c))
                    c0, c1 = (rng.min_col, rng.max_col) if rng else (c, c)
                    days = [col2day[cc] for cc in range(c0, c1 + 1) if cc in col2day]
                    if not days:
                        issues.append(_issue("OUTSIDE_MONTH_COLUMNS", "warning", ws.title, ref,
                                             f"\"{text}\" sits before day 1 of {MONTHS[mon - 1].title()} {year} "
                                             f"(probably carried over from the previous month); its days can't be read."))
                        continue
                    cells.append({"sheet": ws.title, "cell": ref, "label": label, "berth": berth, "text": text,
                                  "start": datetime.date(year, mon, min(days)), "end": datetime.date(year, mon, max(days))})
    return cells, berths, issues, n_sheets, n_cells


def _issue(code, severity, sheet, cell, message, row=None):
    return {"code": code, "severity": severity, "sheet": sheet, "cell": cell, "message": message, "row": row}
