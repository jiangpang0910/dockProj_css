"""The legacy workbook's Science / Yachts tabs: a contact list of vessels, one record per boat.

A record starts at a cell like "R/V High Drift 120'" in column A and runs to the next blank row. The other cells of
the record are read by what they contain, not where they sit (the columns drift from row to row in the real file):
  "LOA: 65', Draft: 4'"          → length / draft (if the name's length and the LOA disagree, the LARGER wins: a fit
                                   check on the larger value can never let a too-long vessel through)
  something@somewhere            → email
  "Cell: 555-0134", "Work: …"    → phone
  "Capt. Dana Everly", or any name in the CONTACT column → contact person
  an organisation ("Harbor Institute", "… University", "… Partners") → operator
  anything else                  → a note
Everything but length/draft/operator is folded into the vessel's notes, so nothing the tab says is lost.
"""
import re

from .classify import FT, NAME_WITH_LENGTH_RE, num, vessel_display, vessel_key

LOA_RE = re.compile(rf"LOA:\s*{FT}", re.I)
DRAFT_RE = re.compile(rf"Draft:\s*{FT}", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE_RE = re.compile(r"^(?:(?:cell|work|office|phone|tel|mobile|fax)\s*[:#]?\s*)?[\d][\d\s().+-]{5,}$", re.I)
CAPTAIN_RE = re.compile(r"^(?:capt\.?|captain|skipper|master)\b", re.I)
PERSON_RE = re.compile(r"^(?:[A-Z][a-z'’.-]+\s){1,2}[A-Z][a-z'’-]+$")     # "Rowan Thorne": a person, on a tab with no header
ORG_RE = re.compile(r"\b(institute|university|college|agency|partners|trust|school|charters?|foundation|society|"
                    r"laboratory|labs?|inc\.?|llc|ltd|co\.|company|corp\.?|council|authority|department|centre|center|"
                    r"museum|survey|fisheries|marine|maritime|oceanographic|research)\b", re.I)
HEADERS = {"vessel", "operator", "contact", "work#", "cell#", "email", "notes", "phone", "name", "loa", "draft"}


def read_registry(wb, ledger=None) -> dict:
    """→ {vessel_key: {"name", "lengthFt", "draftFt", "operator", "notes"}} for every vessel record found.
    ledger (optional, see audit.py) gets what was done with every non-empty cell of the registry tabs."""
    out: dict = {}
    mark = (lambda tab, cell, what: ledger.setdefault((tab, cell.coordinate), what)) if ledger is not None \
        else (lambda *_: None)
    for tab in ("Science", "Yachts"):
        if tab not in wb.sheetnames:
            continue
        ws = wb[tab]
        columns: dict = {}                  # column index → header word, when the tab has a header row
        cur = None
        rec = None
        for row in ws.iter_rows():
            cells = [(c, c.value.strip()) for c in row if isinstance(c.value, str) and c.value.strip()]
            if not cells:
                cur = None
                continue
            if not columns and not out and all(v.lower() in HEADERS for _, v in cells) and len(cells) >= 3:
                columns = {c.column: v.lower() for c, v in cells}
                for c, _ in cells:
                    mark(tab, c, "registry header")
                continue
            m = NAME_WITH_LENGTH_RE.match(cells[0][1])
            if m:
                key = vessel_key(m["name"])
                cur = out.setdefault(key, {"name": vessel_display(m["name"]), "lengthFt": None, "draftFt": None})
                rec = _details.setdefault(key, {"operator": None, "contacts": [], "phones": [], "emails": [], "notes": [], "tabs": set()})
                rec["tabs"].add(tab)
                cur["lengthFt"] = max(filter(None, [cur["lengthFt"], num(m[2])]))
                mark(tab, cells[0][0], "registry vessel + length")
                cells = cells[1:]
            for cell, v in cells:
                loa, draft = LOA_RE.search(v), DRAFT_RE.search(v)
                if cur is None:
                    mark(tab, cell, "REGISTRY_ORPHAN_SPECS" if (loa or draft) else "registry header / stray text")
                    continue
                if loa or draft:
                    if loa:
                        cur["lengthFt"] = max(filter(None, [cur["lengthFt"], num(loa[1])]))
                    if draft:
                        cur["draftFt"] = max(filter(None, [cur["draftFt"], num(draft[1])]))
                    mark(tab, cell, "registry LOA/draft")
                    continue
                what = _classify(v, columns.get(cell.column), rec)
                mark(tab, cell, f"registry {what}")
    for key, rec in _details.items():
        if key in out:
            out[key]["operator"] = rec["operator"]
            out[key]["notes"] = _notes(rec)
    _details.clear()
    return out


_details: dict = {}


def _classify(v: str, header, rec) -> str:
    """File one cell of a record under operator / contact / phone / email / note; returns which."""
    emails = EMAIL_RE.findall(v)
    if emails:
        rest = EMAIL_RE.sub("", v).strip(" ,;:-")
        for e in emails:
            if e.lower() not in (x.lower() for x in rec["emails"]):
                rec["emails"].append(e)
        if rest and not PHONE_RE.match(rest):
            _classify(rest, header, rec)
        return "email"
    if PHONE_RE.match(v):
        if v not in rec["phones"]:
            rec["phones"].append(v)
        return "phone"
    if CAPTAIN_RE.match(v) or header == "contact" or (header is None and PERSON_RE.match(v) and not ORG_RE.search(v)):
        if v not in rec["contacts"]:
            rec["contacts"].append(v)
        return "contact"
    if header == "operator" or (header is None and ORG_RE.search(v)):
        if rec["operator"] is None:
            rec["operator"] = v
        elif v != rec["operator"] and v not in rec["notes"]:
            rec["notes"].append(f"Also listed under {v}")
        return "operator"
    if header in ("work#", "cell#", "phone"):            # a name in a phone column: still a person
        if v not in rec["contacts"]:
            rec["contacts"].append(v)
        return "contact"
    if v not in rec["notes"]:
        rec["notes"].append(v)
    return "note"


def _notes(rec) -> str | None:
    parts = []
    if rec["contacts"]:
        parts.append("Contact: " + "; ".join(rec["contacts"]))
    if rec["phones"]:
        parts.append("Phone: " + "; ".join(rec["phones"]))
    if rec["emails"]:
        parts.append("Email: " + "; ".join(rec["emails"]))
    if rec["notes"]:
        parts.append("; ".join(rec["notes"]))
    parts.append("From the " + " and ".join(sorted(rec["tabs"])) + (" tabs." if len(rec["tabs"]) > 1 else " tab."))
    return " · ".join(parts)
