"""dockparse — the Python parse pipeline. `run(xlsx_bytes)` → a ParsedWorkbook dict (shared/pipeline.ts, version 1).

    bytes ─► detect format ─► template.py | grid.py ─► classify (regex, then model.py for leftovers)
          ─► normalise names, attach registry lengths, merge touching day ranges ─► ParsedWorkbook

It answers "what does the file say?" only. It never decides whether a booking is allowed: overlaps, fit and
double-berthing are judged by rules.ts in the TS importer, along with the planning window.
"""
import io
import warnings

import openpyxl

from . import model
from .classify import classify, vessel_display, vessel_key
from .grid import is_grid, parse_grid
from .registry import read_registry
from .template import is_template, parse_template

VERSION = 1


def run(data: bytes, use_model: bool = True) -> dict:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")      # openpyxl warns about data validations / extensions it drops
        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
        except Exception as e:
            return _unknown(f"Couldn't open the file as an .xlsx workbook ({type(e).__name__}).")

    if is_template(wb):
        berths, vessels, rows, issues, n_sheets, n_cells = parse_template(wb)
        return _out("template", n_sheets, n_cells, 0, berths, vessels, rows, issues)
    if is_grid(wb):
        return _run_grid(wb, use_model)
    return _unknown("This file is neither our template (sheets Berths / Vessels / Bookings) nor the year-per-sheet "
                    "schedule grid. Download the template from the import page and fill it in.")


def _run_grid(wb, use_model):
    cells, grid_berths, issues, n_sheets, n_cells = parse_grid(wb)
    registry = read_registry(wb)

    # 1. classify: regex first, the model only for what regex can't place
    kinds = {c["text"]: classify(c["text"]) for c in cells}
    unknown = [t for t, k in kinds.items() if k == "unknown"]
    labels, calls = model.label(unknown) if use_model else ({}, 0)

    candidates = []
    for c in cells:
        kind, by = kinds[c["text"]], "regex"
        if kind == "unknown" and c["text"] in labels:
            kind, by = labels[c["text"]], "model"
        berth_name = c["berth"][0] if c["berth"] else None
        if kind == "vessel":
            key = vessel_key(c["text"])
            title = registry[key]["name"] if key in registry else vessel_display(c["text"])
        else:
            title = c["text"]
        row = {"berthLabel": berth_name, "occupantType": kind if kind in ("vessel", "event", "closure") else "event",
               "title": title, "startDate": c["start"].isoformat(), "endDate": c["end"].isoformat(), "notes": c.get("note"),
               "sheet": c["sheet"], "cell": c["cell"], "classifiedBy": by}
        if kind == "note":
            issues.append(_issue("ANNOTATION_SKIPPED", "info", c, f"\"{c['text']}\" reads as an operational note, not an "
                                 f"occupant, so it was skipped. Create it as a booking if it was one.", row))
        elif kind == "unknown":
            issues.append(_issue("UNPARSEABLE_CELL", "warning", c, f"Couldn't tell what \"{c['text']}\" is. Create it as "
                                 f"a booking (it defaults to an event) or dismiss it.", row))
        else:
            candidates.append(row)

    # 2. merge touching/overlapping stays of the same occupant on the same berth (merged cells split by month blocks)
    merged = _merge(candidates)

    # 3. rows need a berth; the rest become NO_BERTH issues carrying the row
    rows = []
    for row in merged:
        if row["berthLabel"] is None:
            issues.append({"code": "NO_BERTH", "severity": "error", "sheet": row["sheet"], "cell": row["cell"],
                           "message": f"\"{row['title']}\" is on an unlabeled row, so its berth is unknown. "
                                      f"Choose a berth to create it, or dismiss it.", "row": row})
        else:
            rows.append(row)
        if row["classifiedBy"] == "model":
            issues.append({"code": "MODEL_CLASSIFIED", "severity": "info", "sheet": row["sheet"], "cell": row["cell"],
                           "message": f"\"{row['title']}\" was classified as {row['occupantType']} by the language model. "
                                      f"Check it.", "row": None})

    # 4. berths from the labels (most common length wins), vessels from the registry + the schedule
    berths = [{"name": name, "kind": b["kind"],
               "lengthFt": max(b["lengths"], key=b["lengths"].get) if b["lengths"] else None,
               "sortOrder": b["order"]} for name, b in grid_berths.items()]
    vessels = {k: {"name": v["name"], "lengthFt": v["lengthFt"], "draftFt": v["draftFt"], "operator": None, "notes": None}
               for k, v in registry.items()}
    for row in rows + [i["row"] for i in issues if i["code"] == "NO_BERTH"]:
        if row["occupantType"] == "vessel":
            vessels.setdefault(vessel_key(row["title"]), {"name": row["title"], "lengthFt": None, "draftFt": None,
                                                          "operator": None, "notes": None})
    return _out("legacy_grid", n_sheets, n_cells, calls, berths, sorted(vessels.values(), key=lambda v: v["name"]),
                rows, issues)


def _merge(rows):
    """Same berth + same occupant + ranges touching or overlapping (≤ 1 day apart) → one stay."""
    import datetime as dt
    groups = {}
    for r in rows:
        groups.setdefault((r["berthLabel"], r["occupantType"], vessel_key(r["title"])), []).append(r)
    out = []
    for grp in groups.values():
        grp.sort(key=lambda r: r["startDate"])
        cur = dict(grp[0])
        for r in grp[1:]:
            next_day = (dt.date.fromisoformat(cur["endDate"]) + dt.timedelta(days=1)).isoformat()
            if r["startDate"] <= next_day:
                cur["endDate"] = max(cur["endDate"], r["endDate"])
                if r["classifiedBy"] == "model":
                    cur["classifiedBy"] = "model"
            else:
                out.append(cur)
                cur = dict(r)
        out.append(cur)
    return sorted(out, key=lambda r: (r["startDate"], r["berthLabel"] or "", r["title"]))


def _issue(code, severity, cell, message, row=None):
    return {"code": code, "severity": severity, "sheet": cell["sheet"], "cell": cell["cell"], "message": message, "row": row}


def _unknown(message):
    return _out(None, 0, 0, 0, [], [], [], [{"code": "UNKNOWN_FORMAT", "severity": "error", "sheet": "", "cell": None,
                                             "message": message, "row": None}])


def _out(fmt, n_sheets, n_cells, calls, berths, vessels, rows, issues):
    return {"version": VERSION, "format": fmt, "stats": {"sheets": n_sheets, "cells": n_cells, "modelCalls": calls},
            "berths": berths, "vessels": vessels, "rows": rows, "issues": issues}
