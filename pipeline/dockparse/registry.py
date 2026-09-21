"""Vessel lengths from the legacy workbook's Science / Yachts tabs (same rules as backend/seed/extract_defaults.py).

A record starts at a cell like "R/V High Drift 120'" in column A and runs to the next blank row; it may also hold
"LOA: 65', Draft: 4'". If the name's length and the LOA disagree, the LARGER length wins: a fit check on the
larger value can never let a too-long vessel through.
"""
import re

from .classify import FT, NAME_WITH_LENGTH_RE, num, vessel_display, vessel_key

LOA_RE = re.compile(rf"LOA:\s*{FT}", re.I)
DRAFT_RE = re.compile(rf"Draft:\s*{FT}", re.I)


def read_registry(wb) -> dict:
    """→ {vessel_key: {"name", "lengthFt", "draftFt"}} for every vessel record found."""
    out: dict = {}
    for tab in ("Science", "Yachts"):
        if tab not in wb.sheetnames:
            continue
        cur = None
        for row in wb[tab].iter_rows(values_only=True):
            cells = [v.strip() for v in row if isinstance(v, str) and v.strip()]
            if not cells:
                cur = None
                continue
            m = NAME_WITH_LENGTH_RE.match(cells[0])
            if m:
                key = vessel_key(m["name"])
                cur = out.setdefault(key, {"name": vessel_display(m["name"]), "lengthFt": None, "draftFt": None})
                cur["lengthFt"] = max(filter(None, [cur["lengthFt"], num(m[2])]))
            if cur is None:
                continue
            for c in cells:
                if (loa := LOA_RE.search(c)):
                    cur["lengthFt"] = max(filter(None, [cur["lengthFt"], num(loa[1])]))
                if (draft := DRAFT_RE.search(c)):
                    cur["draftFt"] = max(filter(None, [cur["draftFt"], num(draft[1])]))
    return out
