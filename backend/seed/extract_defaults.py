"""Extract default berths and vessels (with lengths) from the legacy workbook via regex.

Output: backend/seed/defaults.json — the starting berth + vessel registry the app seeds on first run.
After seeding, users create / edit / delete berths and vessels themselves; this file is only the default.

Sources:
  berths  — column A of every year sheet:  "North Pier West - 410'"
  vessels — "Science" and "Yachts" tabs: records start with "R/V High Drift 120'" in column A and run
            until a blank row; the record may also contain "LOA: 65', Draft: 4'".
            A name length and an LOA that disagree (or two records that disagree) → VESSEL_LENGTH_CONFLICT;
            an LOA in a block with no vessel name → LENGTH_WITHOUT_VESSEL. Both are reported, never guessed silently.

Run:  python3 backend/seed/extract_defaults.py [path/to/workbook.xlsx]
"""
import collections, json, re, sys
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parents[2]
WORKBOOK = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "sample_data" / "Dock Schedule - Synthetic Sample.xlsx"
OUT = Path(__file__).resolve().parent / "defaults.json"

FT = r"(\d+(?:\.\d+)?)\s*['’′]"                       # 410'  410’  410′
BERTH_RE = re.compile(rf"^\s*(?P<name>.+?)\s+-\s+{FT}\s*$")
SECTION_RE = re.compile(r"^\s*(North Finger Piers|Small craft slips)\b", re.I)
PREFIX = r"(?:R/V|M/V|M/Y|S/V|S/Y|F/V|OSV|OS/V|TUG|BARGE)"
VESSEL_RE = re.compile(rf"^\s*(?P<name>{PREFIX}\s+.+?)\s+{FT}\s*$", re.I)
LOA_RE = re.compile(rf"LOA:\s*{FT}", re.I)
DRAFT_RE = re.compile(rf"Draft:\s*{FT}", re.I)
SECTION_NAMES = {"north finger piers": "North Finger Piers", "small craft slips": "Small Craft Slips"}


def num(s):
    f = float(s)
    return int(f) if f.is_integer() else f


def name_key(s):
    return re.sub(r"\s+", " ", s.strip()).upper().replace("OS/V ", "OSV ")


def display(s):
    """'R/V HIGH DRIFT' -> 'R/V High Drift'; keeps the prefix upper-case."""
    s = re.sub(r"\s+", " ", s.strip()).replace("OS/V ", "OSV ")
    prefix, _, rest = s.partition(" ")
    prefix = prefix.upper() if "/" in prefix or prefix.upper() == "OSV" else prefix.title()
    return f"{prefix} {rest.title()}"


def extract_berths(wb):
    lengths = collections.defaultdict(collections.Counter)   # name -> {length: times seen}
    order, sections = [], []
    for ws in wb.worksheets:
        if not ws.title.isdigit():
            continue
        for (a,) in ws.iter_rows(min_col=1, max_col=1, values_only=True):
            if not isinstance(a, str):
                continue
            if m := BERTH_RE.match(a):
                name = m["name"].strip()
                lengths[name][num(m[2])] += 1
                if name not in order:
                    order.append(name)
            elif m := SECTION_RE.match(a):
                name = SECTION_NAMES[m[1].lower()]
                if name not in sections:
                    sections.append(name)
    berths, issues = [], []
    for i, name in enumerate(order + sections, 1):
        if name in lengths:
            seen = lengths[name]
            length = seen.most_common(1)[0][0]
            if len(seen) > 1:
                issues.append({"code": "BERTH_LENGTH_CONFLICT", "berth": name, "seen": dict(seen), "chosen": length})
            berths.append({"name": name, "lengthFt": length, "kind": "berth", "sortOrder": i, "timesSeen": sum(seen.values())})
        else:
            berths.append({"name": name, "lengthFt": None, "kind": "section", "sortOrder": i})
    return berths, issues


def extract_vessels(wb):
    records, issues = [], []
    for tab in ("Science", "Yachts"):
        ws = wb[tab]
        cur = None
        for r, row in enumerate(ws.iter_rows(values_only=True), 1):
            cells = [v.strip() for v in row if isinstance(v, str) and v.strip()]
            if not cells:                                   # blank row ends a record
                cur = None
                continue
            if m := VESSEL_RE.match(cells[0]):
                cur = {"tab": tab, "row": r, "name": m["name"], "nameFt": num(m[2]), "loaFt": None, "draftFt": None}
                records.append(cur)
            for c in cells:
                loa, draft = LOA_RE.search(c), DRAFT_RE.search(c)
                if not (loa or draft):
                    continue
                if cur is None:
                    issues.append({"code": "LENGTH_WITHOUT_VESSEL", "tab": tab, "row": r, "text": c})
                    continue
                if loa: cur["loaFt"] = num(loa[1])
                if draft: cur["draftFt"] = num(draft[1])

    by_key = collections.OrderedDict()
    for rec in records:
        by_key.setdefault(name_key(rec["name"]), []).append(rec)

    vessels = []
    for key, recs in by_key.items():
        lengths = {r["nameFt"] for r in recs} | {r["loaFt"] for r in recs if r["loaFt"] is not None}
        # Conflicting lengths → keep the largest: a fit check on the larger value can never let a too-long vessel through.
        length = max(lengths)
        if len(lengths) > 1:
            issues.append({"code": "VESSEL_LENGTH_CONFLICT", "vessel": display(recs[0]["name"]),
                           "seen": sorted(lengths), "chosen": length, "sources": [f'{r["tab"]}!A{r["row"]}' for r in recs]})
        drafts = [r["draftFt"] for r in recs if r["draftFt"] is not None]
        vessels.append({"name": display(recs[0]["name"]), "lengthFt": length, "draftFt": max(drafts) if drafts else None,
                        "sources": [f'{r["tab"]}!A{r["row"]}' for r in recs]})
    vessels.sort(key=lambda v: v["name"])
    return vessels, issues


def main():
    wb = openpyxl.load_workbook(WORKBOOK, data_only=True)
    berths, b_issues = extract_berths(wb)
    vessels, v_issues = extract_vessels(wb)
    longest = max(b["lengthFt"] for b in berths if b["lengthFt"])
    too_long = [v["name"] for v in vessels if v["lengthFt"] > longest]
    out = {"source": WORKBOOK.name, "berths": berths, "vessels": vessels, "issues": b_issues + v_issues,
           "summary": {"berths": sum(b["kind"] == "berth" for b in berths), "sections": sum(b["kind"] == "section" for b in berths),
                       "vessels": len(vessels), "issues": len(b_issues) + len(v_issues),
                       "vesselsLongerThanEveryBerth": too_long}}
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")

    print(f"wrote {OUT.relative_to(ROOT)}")
    print("\nBERTHS")
    for b in berths:
        print(f"  {b['sortOrder']}. {b['name']:<20} {str(b['lengthFt']) + chr(39) if b['lengthFt'] else '—':>6}  {b['kind']}")
    print(f"\nVESSELS: {len(vessels)}  (lengths {min(v['lengthFt'] for v in vessels)}'–{max(v['lengthFt'] for v in vessels)}')")
    print("  length distribution:", dict(sorted(collections.Counter(v["lengthFt"] for v in vessels).items())))
    print("  longer than every berth:", too_long or "none")
    print(f"\nISSUES: {len(out['issues'])}")
    for i in out["issues"]:
        print("  ", i)


if __name__ == "__main__":
    main()
