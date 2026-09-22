"""Cell ledger: proof that the parser looked at every cell that holds something.

    python3 -m pipeline.audit <file.xlsx>

Every cell with a value, and every coloured cell on a year sheet, must end up with a disposition: a stay's name or
bar, a berth label, a day number, a registry field, an issue code, or "reference sheet (not imported)". A cell with no
disposition is a hole in the parser — the pipeline tests fail on any.
"""
import collections
import io
import warnings

import openpyxl
from openpyxl.cell.cell import MergedCell

from . import REFERENCE_SHEETS, _parse
from .grid import fill_of, is_grid_sheet


def audit(data: bytes) -> dict:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ledger: dict = {}
    _parse(wb, use_model=False, ledger=ledger)   # every reader marks the cells it touched
    counts, holes = collections.Counter(), []
    for ws in wb.worksheets:
        year_sheet = is_grid_sheet(ws)
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c, MergedCell):
                    continue  # covered by its range's anchor
                has_value = c.value is not None and not (isinstance(c.value, str) and not c.value.strip())
                if not has_value and not (year_sheet and fill_of(c) is not None):
                    continue
                what = ledger.get((ws.title, c.coordinate)) or REFERENCE_SHEETS.get(ws.title)
                if what is None and not has_value:
                    what = "coloured cell outside any stay row"  # e.g. shading in blank rows between months
                if what:
                    counts[f"{'grid' if year_sheet else ws.title}: {what}"] += 1
                else:
                    holes.append({"sheet": ws.title, "cell": c.coordinate, "value": c.value})
    return {"counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])), "unaccounted": holes}
