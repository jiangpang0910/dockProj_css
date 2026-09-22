"""Free-form tables → berths, vessels and stays. Any sheet that is "a header row, then one record per row".

How a sheet is read:
  1. find the header row: the row (within the first 30) whose cells look most like column names we know
  2. score every column for every field it could be, from three sides: the header's wording (synonyms),
     the VALUES in it (dates, feet, hull prefixes, berth-like names, how many distinct values), and position
     (a start column sits left of an end column). The best unique assignment wins; weak columns stay unmapped.
  3. decide what the table is: stays (has a name and dates), vessels (name + length, no dates) or berths
  4. read each record, cleaning every value with values.py; what can't be read becomes an INVALID_VALUE issue
A header-less block is tried on values alone. The ledger (audit.py) gets a disposition for every non-empty cell.
The user always sees the mapping (COLUMN_MAPPING) and every column that was left out (UNMAPPED_COLUMN).
"""
import collections
import re

from openpyxl.cell.cell import MergedCell
from openpyxl.utils import get_column_letter

from . import embed
from .classify import VESSEL_RE, classify, clean, vessel_display, vessel_key
from .grid import SECTION_RE
from .values import (berth_label, date_orders, feet, order_for, parse_date, parse_range, split_name_length)

FIELDS = {
    "berth": {"berth", "dock", "pier", "slip", "quay", "wharf", "where", "location", "mooring", "position", "place",
              "berth name", "dock name", "pier name", "berth / dock", "berthed at", "alongside", "moored at", "moored",
              "lying at", "tied up at", "jetty", "pontoon", "landing"},
    "vessel": {"vessel", "ship", "boat", "craft", "name", "hull", "vessel / title", "vessel/title", "title",
               "occupant", "vessel name", "boat name", "ship name", "who", "vessel (loa)", "yacht", "visitor"},
    "type": {"type", "kind", "category", "booking type", "occupant type", "use"},
    "start": {"start", "from", "in", "arrive", "arrival", "arrives", "arriving", "eta", "begin", "begins", "date in",
              "check in", "start date", "arrival date", "date from", "from date", "commence", "on", "arr", "in date",
              "arrived", "came in", "docked", "came alongside"},
    "end": {"end", "to", "out", "depart", "departure", "departs", "departing", "etd", "finish", "until", "till",
            "date out", "check out", "end date", "departure date", "date to", "to date", "leave", "leaves", "dep",
            "out date", "off", "cast off", "sailed", "sails", "left", "let go"},
    "dates": {"dates", "date", "period", "when", "range", "stay", "date range", "duration", "booking dates", "days"},
    "notes": {"notes", "note", "remarks", "remark", "comments", "comment", "memo", "description", "details", "status"},
    "length": {"length", "loa", "length (ft)", "ft", "feet", "size", "length ft", "loa (ft)", "l.o.a.", "len",
               "length feet", "overall length"},
    "draft": {"draft", "draught", "draft (ft)", "draught (ft)"},
    "operator": {"operator", "owner", "company", "agent", "contact", "organisation", "organization", "org", "affiliation"},
    "order": {"order", "sort", "sort order", "#", "no", "no.", "seq"},
}
_WORD_FIELDS = {w: f for f, ws in FIELDS.items() for w in ws if " " not in w and len(w) > 1}
TYPED_FIELDS = {"start", "end", "dates", "length", "draft", "order", "type"}   # their values have a recognisable shape
BERTH_WORDS = re.compile(r"\b(pier|float|slip|slips|dock|channel|wharf|quay|basin|berth|jetty|pontoon|finger|marina)\b", re.I)
TYPE_WORDS = {"vessel": "vessel", "boat": "vessel", "ship": "vessel", "event": "event", "closure": "closure",
              "closed": "closure", "maintenance": "closure", "repair": "closure", "block": "closure"}
HEADER_ROWS_SEARCHED = 30
MIN_HEADER_SCORE = 1.4       # at least two recognisable column names
MIN_COLUMN_SCORE = 0.3
SAMPLE = 300


def _blank(v):
    return v is None or (isinstance(v, str) and not v.strip())


def _norm_header(v):
    s = clean(v).lower().replace("_", " ").replace("\n", " ")
    bare = re.sub(r"\(.*?\)", " ", s)
    bare = re.sub(r"[^a-z0-9#./ ]", " ", bare)
    return s, clean(bare)


def header_match(v):
    """One header cell → ({field: score}, by_meaning). Exact synonym 1.0; a known word inside it 0.7; otherwise the
    local embedding model (embed.py) rates the wording against every synonym: 0.4–0.8, never above a real synonym."""
    if not isinstance(v, str) or not v.strip():
        return {}, False
    s, bare = _norm_header(v)
    out = {}
    for f, syn in FIELDS.items():
        if s in syn or bare in syn or bare.rstrip("s") in syn:
            out[f] = 1.0
    if not out:
        for w in re.findall(r"[a-z.#]+", bare):
            f = _WORD_FIELDS.get(w) or _WORD_FIELDS.get(w.rstrip("s"))
            if f:
                out[f] = max(out.get(f, 0), 0.7)
    if out:
        return out, False
    sem = embed.semantic(bare or s, FIELDS)
    return {f: min(0.8, 0.5 + (c - embed.MIN_COSINE) * 1.5) for f, c in sem.items()}, bool(sem)


def header_scores(v):
    return header_match(v)[0]


def value_scores(values, known_berths, known_vessels):
    """A column's non-empty values → {field: 0..1} from what the values look like."""
    vals = values[:SAMPLE]
    n = len(vals)
    if not n:
        return {}
    texts = [clean(v) for v in vals if isinstance(v, str)]
    distinct = len({clean(v).lower() if isinstance(v, str) else v for v in vals})
    frac = lambda pred: sum(1 for v in vals if pred(v)) / n  # noqa: E731
    f_date = frac(lambda v: parse_date(v) is not None or (isinstance(v, str) and _day_month_only(v)))
    f_range = frac(lambda v: parse_range(v) is not None)
    f_feet = frac(lambda v: feet(v) is not None)
    f_type = frac(lambda v: isinstance(v, str) and clean(v).lower() in TYPE_WORDS)
    f_berth = frac(lambda v: isinstance(v, str) and (berth_label(v)[0].lower() in known_berths or BERTH_WORDS.search(v)))
    f_hull = frac(lambda v: isinstance(v, str) and (VESSEL_RE.match(v) or vessel_key(split_name_length(v)[0]) in known_vessels))
    f_text = frac(lambda v: isinstance(v, str) and not parse_date(v) and feet(v) is None)
    f_int = frac(lambda v: isinstance(v, int) and not isinstance(v, bool) and 0 < v < 10000)
    ratio = distinct / n
    out = {
        "start": f_date, "end": f_date, "dates": f_range,
        "length": f_feet * (0.6 if f_int == f_feet and ratio > 0.9 else 1.0),   # a 1,2,3… column is an order, not feet
        "draft": f_feet * 0.5, "order": f_int * (0.8 if ratio > 0.9 else 0.2),
        "type": f_type,
        "berth": f_berth * 0.8 + (0.2 if 2 <= distinct <= 40 and ratio < 0.3 else 0),
        "vessel": f_hull * 0.6 + f_text * 0.2 + (0.2 if ratio > 0.2 else 0),
        "notes": f_text * 0.15 if ratio > 0.05 else 0.1, "operator": f_text * 0.25,
    }
    if f_date > 0.5:
        out["vessel"] = out["berth"] = out["notes"] = 0
    return out


def _day_month_only(v):
    from .values import date_parts
    p = date_parts(v)
    return bool(p and p[1] and not p[0])


def map_columns(headers, columns, known_berths, known_vessels):
    """headers: {col: header text or None}; columns: {col: [values]} → {col: field}, {col: total score}."""
    scores = {}
    for c, vals in columns.items():
        hs = header_scores(headers.get(c))
        vs = value_scores([v for v in vals if not _blank(v)], known_berths, known_vessels)
        for f in FIELDS:
            h, v = hs.get(f, 0), vs.get(f, 0)
            if f in TYPED_FIELDS and v == 0 and h < 1.0:
                continue                             # a column with no dates in it isn't a date column, whatever its header hints
            # the header names the field; values decide among header candidates, or on their own when it names none
            scores[(c, f)] = 0.6 * h + 0.4 * v if h else 0.2 * v if hs else 0.9 * v
    taken_c, taken_f, mapping, total = set(), set(), {}, {}
    for (c, f), s in sorted(scores.items(), key=lambda kv: -kv[1]):
        if s < MIN_COLUMN_SCORE or c in taken_c or f in taken_f:
            continue
        mapping[c], total[c] = f, s
        taken_c.add(c)
        taken_f.add(f)
    # two date columns with weak headers: the left one starts the stay
    ds = [c for c, f in mapping.items() if f in ("start", "end")]
    if len(ds) == 2 and all(not header_scores(headers.get(c)).get(mapping[c]) for c in ds):
        a, b = sorted(ds)
        mapping[a], mapping[b] = "start", "end"
    return mapping, total


def _cells(ws):
    """→ {row: {col: value}} for non-empty, non-merged-continuation cells; merged ranges report their anchor."""
    rows: dict = collections.defaultdict(dict)
    for row in ws.iter_rows():
        for c in row:
            if isinstance(c, MergedCell) or _blank(c.value):
                continue
            rows[c.row][c.column] = c.value
    return rows


def find_header(rows, known_berths, known_vessels):
    """→ (header_row, {col: header}) or (None, {}) — the row within the first 30 that best names known fields
    and is followed by at least one data row."""
    best = (0, None, {})
    for r in sorted(rows):
        if r > HEADER_ROWS_SEARCHED:
            break
        cells = rows[r]
        texts = {c: v for c, v in cells.items() if isinstance(v, str)}
        if len(texts) < 2 or len(texts) < len(cells) * 0.8:
            continue
        if any(feet(v) is not None or parse_date(v) is not None for v in cells.values()):
            continue                                 # a row holding a length or a date is data, never a header
        score = sum(max(header_scores(v).values(), default=0) for v in texts.values())
        if score > best[0] and any(rr > r for rr in rows):
            best = (score, r, {c: clean(v) for c, v in texts.items()})
    return (best[1], best[2]) if best[0] >= MIN_HEADER_SCORE else (None, {})


class Sheet:
    """One sheet read as a table. .kind ∈ {"stays", "vessels", "berths", None}; None = nothing recognisable."""

    def __init__(self, ws, known_berths, known_vessels, spec=None):
        self.ws, self.title = ws, ws.title
        self.rows = _cells(ws)
        self.reason = None
        if spec:                                     # a layout the model proposed (validated by the caller)
            self.header_row, self.headers = spec.get("headerRow"), {}
            self.mapping = spec["columns"]
            if self.header_row:
                self.headers = {c: clean(v) for c, v in self.rows.get(self.header_row, {}).items() if isinstance(v, str)}
        else:
            self.header_row, self.headers = find_header(self.rows, known_berths, known_vessels)
            data_rows = [r for r in self.rows if r > (self.header_row or 0)]
            columns = collections.defaultdict(list)
            for r in data_rows:
                for c, v in self.rows[r].items():
                    columns[c].append(v)
            if self.header_row is None and (len(data_rows) < 3 or len(columns) < 2):
                self.reason = "no header row with column names we recognise, and too little data to read by values alone"
                self.mapping, self.kind = {}, None
                return
            self.mapping, _ = map_columns(self.headers, dict(columns), known_berths, known_vessels)
        self.fields = {f: c for c, f in self.mapping.items()}
        has_name = "vessel" in self.fields or "berth" in self.fields
        has_dates = ("start" in self.fields) or ("dates" in self.fields)
        if "vessel" in self.fields and has_dates:
            self.kind = "stays"
        elif has_name and "length" in self.fields and not has_dates:
            self.kind = "entities"                   # berths or vessels: decided once the stays are known
        elif "berth" in self.fields and "type" in self.fields and not has_dates:
            self.kind = "entities"
        else:
            self.kind = None
            self.reason = ("columns found (%s) don't make a schedule: it needs a vessel column and dates"
                           % (", ".join(f"{get_column_letter(c)}={f}" for c, f in sorted(self.mapping.items())) or "none"))

    def data_rows(self):
        rows = [r for r in sorted(self.rows) if r > (self.header_row or 0)]
        if self.header_row is None and self.mapping:   # a header-less table starts at its first complete row
            full = next((i for i, r in enumerate(rows) if all(c in self.rows[r] for c in self.mapping)), 0)
            self.banner_rows, rows = rows[:full], rows[full:]
        else:
            self.banner_rows = []
        return rows

    def ref(self, r, field):
        c = self.fields.get(field)
        return f"{get_column_letter(c)}{r}" if c else None

    def describe(self):
        def how(c):
            h = self.headers.get(c)
            scores, by_meaning = header_match(h)
            return " [by meaning]" if by_meaning and self.mapping[c] in scores else " [by its values]" if not scores else ""
        return ", ".join(f"{get_column_letter(c)} ({self.headers.get(c) or 'no header'}) → {f}{how(c)}"
                         for c, f in sorted(self.mapping.items()))


def read_tables(wb, sheets, known_berths=(), known_vessels=(), ledger=None, specs=None):
    """sheets: worksheets to try. → dict(berths, vessels, rows, issues, n_sheets, n_cells, skipped: [(title, reason)]).
    known_*: names already established by other readers (grid labels, registry), lower-cased / keyed."""
    mark = (lambda ws, r, c, what: ledger.setdefault((ws.title, f"{get_column_letter(c)}{r}"), what)) \
        if ledger is not None else (lambda *_: None)
    issues, skipped, stays, entity_sheets = [], [], [], []
    n_sheets = n_cells = 0
    known_b = {b.lower() for b in known_berths}
    known_v = set(known_vessels)

    def issue(code, severity, sheet, cell, message, row=None):
        issues.append({"code": code, "severity": severity, "sheet": sheet, "cell": cell, "message": message, "row": row})

    parsed = [Sheet(ws, known_b, known_v, (specs or {}).get(ws.title)) for ws in sheets]
    for sh in parsed:                                # stays first: their berth/vessel names classify entity tables
        if sh.kind is None:
            skipped.append((sh.title, sh.reason))
            for r, cells in sh.rows.items():
                for c in cells:
                    mark(sh.ws, r, c, "SHEET_SKIPPED")
            continue
        n_sheets += 1
        sh.data_rows()
        for r in sh.rows:
            if (sh.header_row and r < sh.header_row) or r in sh.banner_rows:
                for c in sh.rows[r]:
                    mark(sh.ws, r, c, "sheet title / banner (not imported)")
        if sh.header_row:
            for c in sh.rows[sh.header_row]:
                mark(sh.ws, sh.header_row, c, "table header")
        for r in sh.data_rows():
            for c in sh.rows[r]:
                if c not in sh.mapping:
                    mark(sh.ws, r, c, f"UNMAPPED_COLUMN {get_column_letter(c)}")
        unmapped = sorted({c for r in sh.data_rows() for c in sh.rows[r] if c not in sh.mapping})
        issue("COLUMN_MAPPING", "info", sh.title, f"A{sh.header_row}" if sh.header_row else None,
              f"Read as a {'schedule' if sh.kind == 'stays' else 'list'}: {sh.describe()}.")
        for c in unmapped:
            n = sum(1 for r in sh.data_rows() if c in sh.rows[r])
            issue("UNMAPPED_COLUMN", "info", sh.title, f"{get_column_letter(c)}{sh.header_row or 1}",
                  f"Column {get_column_letter(c)} (\"{sh.headers.get(c, 'no header')}\", {n} cells) wasn't used: "
                  f"nothing told us what it means.")
        if sh.kind == "stays":
            stays.append(sh)
        else:
            entity_sheets.append(sh)

    # ── stays ──
    rows, berth_lengths, vessel_lengths = [], {}, {}
    for sh in stays:
        f = sh.fields
        col = lambda name, r: sh.rows[r].get(f[name]) if name in f else None  # noqa: E731
        vcol = [sh.rows[r].get(f["vessel"]) for r in sh.data_rows()]
        marked = sum(1 for v in vcol if isinstance(v, str) and split_name_length(v)[1] is not None)
        bare_ok = marked >= 0.25 * max(1, sum(1 for v in vcol if not _blank(v)))
        orders = {name: date_orders([sh.rows[r].get(f[name]) for r in sh.data_rows()]) for name in ("start", "end", "dates") if name in f}
        for name, o in orders.items():
            for sep, order in o.items():
                if order is None:
                    issue("AMBIGUOUS_VALUE", "info", sh.title, sh.ref(sh.data_rows()[0], name),
                          f"Dates written like 03{sep}05{sep}2015 in column {get_column_letter(f[name])} were read as "
                          f"month{sep}day{sep}year; nothing in the column showed which comes first.")
        for r in sh.data_rows():
            cells = sh.rows[r]
            if not any(c in sh.mapping for c in cells):
                continue
            vtext = col("vessel", r)
            if _blank(vtext):
                for c in cells:
                    if c in sh.mapping:
                        mark(sh.ws, r, c, "INVALID_VALUE (row without a name)")
                issue("INVALID_VALUE", "error", sh.title, f"{get_column_letter(f['vessel'])}{r}", "No vessel or title on this row; row skipped.")
                continue
            title, length, ambiguous = split_name_length(str(vtext), bare_ok)
            if ambiguous:
                issue("AMBIGUOUS_VALUE", "warning", sh.title, sh.ref(r, "vessel"),
                      f"\"{clean(vtext)}\" ends in a number: a {title.rsplit(' ', 1)[-1]}′ length, or part of the name? "
                      f"It was kept as the name. Edit the vessel if it's a length.")
            ttext = col("type", r)
            if ttext is not None and not _blank(ttext):
                kind = TYPE_WORDS.get(clean(str(ttext)).lower())
                if kind is None:
                    issue("INVALID_VALUE", "error", sh.title, sh.ref(r, "type"), f"Type must be vessel, event or closure (got \"{ttext}\"); row skipped.")
                    continue
            else:
                k = classify(title)
                kind = k if k in ("closure", "event") else "vessel"
            if kind == "vessel":
                title = vessel_display(title) if re.match(r"^\S+/\S+\s", title) or title.isupper() else title
            btext = col("berth", r)
            bname = blen = None
            if not _blank(btext):
                bname, blen = berth_label(str(btext))
                if blen:
                    berth_lengths[bname] = max(berth_lengths.get(bname, 0), blen)
            if "dates" in f and not _blank(col("dates", r)):
                dv = col("dates", r)
                rng = parse_range(dv, order_for(dv, orders["dates"]))
                if rng is None:
                    d = parse_date(dv, order_for(dv, orders["dates"]))
                    rng = (d, d) if d else None
                if rng is None:
                    issue("INVALID_VALUE", "error", sh.title, sh.ref(r, "dates"), f"Couldn't read \"{dv}\" as dates; row skipped.")
                    continue
                start, end = rng
            else:
                sv, ev = col("start", r), col("end", r)
                start = parse_date(sv, order_for(sv, orders.get("start", {})))
                end = parse_date(ev, order_for(ev, orders.get("end", {}))) if "end" in f else start
                if end is None and not _blank(ev) and isinstance(ev, str):
                    p = parse_range(ev)             # "3 - 7 Mar" in the end column, start empty
                    start, end = (p if p else (start, None))
                if start is None or end is None:
                    which, val = ("start", sv) if start is None else ("end", ev)
                    issue("INVALID_VALUE", "error", sh.title, sh.ref(r, which) or sh.ref(r, "vessel"),
                          f"Couldn't read \"{val}\" as a {which} date; row skipped.")
                    continue
            if start > end:
                issue("INVALID_VALUE", "error", sh.title, sh.ref(r, "start"),
                      f"\"{title}\": {start} is after {end}; row skipped.")
                continue
            notes = col("notes", r)
            for c in cells:
                if c in sh.mapping:
                    mark(sh.ws, r, c, f"table: {sh.mapping[c]}")
            n_cells += sum(1 for c in cells if c in sh.mapping)
            if kind == "vessel":
                key = vessel_key(title)
                if length:
                    vessel_lengths[key] = max(vessel_lengths.get(key) or 0, length)
                vessel_lengths.setdefault(key, None)
            rows.append({"berthLabel": bname, "occupantType": kind, "title": title, "startDate": start.isoformat(),
                         "endDate": end.isoformat(), "notes": clean(str(notes)) if not _blank(notes) else None,
                         "sheet": sh.title, "cell": sh.ref(r, "vessel"), "classifiedBy": "template"})

    # ── entity tables: berths or vessels? ──
    stay_berths = {r["berthLabel"].lower() for r in rows if r["berthLabel"]} | known_b
    stay_vessels = {vessel_key(r["title"]) for r in rows if r["occupantType"] == "vessel"} | known_v
    berths, vessels = [], {}
    for sh in entity_sheets:
        f = sh.fields
        name_col = f.get("berth") or f.get("vessel")
        names = [clean(str(sh.rows[r][name_col])) for r in sh.data_rows() if name_col in sh.rows[r]]
        votes = collections.Counter()
        votes["berths"] += 2 * bool(re.search(r"berth|dock|pier|slip|quay|wharf", sh.title, re.I)) + ("kind" in f and "berth" in f)
        votes["vessels"] += 2 * bool(re.search(r"vessel|fleet|boat|ship|yacht|craft", sh.title, re.I)) + ("draft" in f) + ("operator" in f)
        votes["berths"] += sum(1 for n in names if berth_label(n)[0].lower() in stay_berths or BERTH_WORDS.search(n)) / max(1, len(names)) * 3
        votes["vessels"] += sum(1 for n in names if vessel_key(split_name_length(n)[0]) in stay_vessels or VESSEL_RE.match(n)) / max(1, len(names)) * 3
        votes["berths"] += ("berth" in f) * 0.5
        votes["vessels"] += ("vessel" in f) * 0.5
        what = "berths" if votes["berths"] >= votes["vessels"] else "vessels"
        for r in sh.data_rows():
            cells = sh.rows[r]
            if name_col not in cells:
                continue
            for c in cells:
                if c in sh.mapping:
                    mark(sh.ws, r, c, f"{what} list: {sh.mapping[c]}")
            n_cells += sum(1 for c in cells if c in sh.mapping)
            raw = clean(str(cells[name_col]))
            length = feet(cells.get(f["length"])) if "length" in f else None
            if what == "berths":
                name, inline = berth_label(raw)
                length = length or inline
                kind = None
                if "type" in f and not _blank(cells.get(f["type"])):
                    kind = {"berth": "berth", "section": "section", "shared": "section", "exclusive": "berth"}.get(clean(str(cells[f["type"]])).lower())
                if kind is None:
                    kind = "section" if (SECTION_RE.match(name) or length is None) else "berth"
                if kind == "berth" and length is None:
                    issue("INVALID_VALUE", "error", sh.title, sh.ref(r, "length") or sh.ref(r, "berth"),
                          f"Berth \"{name}\" has no length; row skipped.")
                    continue
                if name.lower() in {b["name"].lower() for b in berths}:
                    issue("DUPLICATE_NAME", "warning", sh.title, f"{get_column_letter(name_col)}{r}", f"Berth \"{name}\" appears twice; the first one was kept.")
                    continue
                order = cells.get(f["order"]) if "order" in f else None
                berths.append({"name": name, "lengthFt": length if kind == "berth" else None,
                               "sortOrder": order if isinstance(order, int) else len(berths) + 1})
            else:
                name, inline, _ = split_name_length(raw, True)
                length = max(filter(None, [length, inline]), default=None)
                name = vessel_display(name) if re.match(r"^\S+/\S+\s", name) or name.isupper() else name
                key = vessel_key(name)
                if key in vessels:
                    issue("DUPLICATE_NAME", "warning", sh.title, f"{get_column_letter(name_col)}{r}", f"Vessel \"{name}\" appears twice; the first one was kept.")
                    continue
                draft = feet(cells.get(f["draft"])) if "draft" in f else None
                op = cells.get(f["operator"]) if "operator" in f else None
                nt = cells.get(f["notes"]) if "notes" in f else None
                vessels[key] = {"name": name, "lengthFt": length, "draftFt": draft,
                                "operator": clean(str(op)) if not _blank(op) else None, "notes": clean(str(nt)) if not _blank(nt) else None}

    # berths named in stays with a length in their label, e.g. "North Pier West (410 ft)"
    have = {b["name"].lower() for b in berths}
    for name, length in berth_lengths.items():
        if name.lower() not in have and name.lower() not in known_b:
            berths.append({"name": name, "lengthFt": length, "sortOrder": len(berths) + 1})
            have.add(name.lower())
    for r in rows:                                   # shared sections are known by name
        b = r["berthLabel"]
        if b and b.lower() not in have and b.lower() not in known_b and SECTION_RE.match(b):
            berths.append({"name": b, "lengthFt": None, "sortOrder": len(berths) + 1})
            have.add(b.lower())
    # vessels seen in stays that no list mentioned, with any length their cells carried
    for key, length in vessel_lengths.items():
        if key in vessels:
            if length and (vessels[key]["lengthFt"] or 0) < length:
                vessels[key]["lengthFt"] = length
        elif key not in known_v:
            title = next(r["title"] for r in rows if r["occupantType"] == "vessel" and vessel_key(r["title"]) == key)
            vessels[key] = {"name": title, "lengthFt": length, "draftFt": None, "operator": None, "notes": None}

    return {"berths": berths, "vessels": vessels, "rows": rows, "issues": issues, "n_sheets": n_sheets,
            "n_cells": n_cells, "skipped": skipped}
