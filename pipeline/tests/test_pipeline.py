"""Pipeline tests. Run from the repo root:  python3 -m unittest discover -s pipeline/tests -v

Standard library + openpyxl only. The model step is never called for real: it's replaced by a stub.
"""
import datetime
import io
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

import openpyxl
from openpyxl.styles import PatternFill

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
import dockparse  # noqa: E402
from dockparse import _merge, model  # noqa: E402

SAMPLE = ROOT / "sample_data" / "Dock Schedule - Synthetic Sample.xlsx"
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ISSUE_CODES = {"NO_BERTH", "OUTSIDE_MONTH_COLUMNS", "UNPARSEABLE_CELL", "HEADER_YEAR_MISMATCH", "DUPLICATE_CARRYOVER",
               "ANNOTATION_SKIPPED", "UNKNOWN_FORMAT", "TEMPLATE_BAD_HEADER", "INVALID_VALUE", "DUPLICATE_NAME",
               "MODEL_CLASSIFIED", "HEADER_AREA_TEXT", "UNLABELED_BAR"}


def check_shape(t, d):
    """The same shape shared/pipeline.ts (ParsedWorkbookSchema) enforces on the TS side."""
    t.assertEqual(d["version"], 1)
    t.assertIn(d["format"], ("template", "legacy_grid", None))
    t.assertEqual(set(d["stats"]), {"sheets", "cells", "modelCalls"})
    for b in d["berths"]:
        t.assertEqual(set(b), {"name", "kind", "lengthFt", "sortOrder"})
        t.assertIn(b["kind"], ("berth", "section"))
        t.assertTrue(b["lengthFt"] is None or b["lengthFt"] > 0)
    for v in d["vessels"]:
        t.assertEqual(set(v), {"name", "lengthFt", "draftFt", "operator", "notes"})
    rows = d["rows"] + [i["row"] for i in d["issues"] if i["row"]]
    for r in rows:
        t.assertEqual(set(r), {"berthLabel", "occupantType", "title", "startDate", "endDate", "notes", "sheet", "cell",
                               "classifiedBy"})
        t.assertIn(r["occupantType"], ("vessel", "event", "closure"))
        t.assertIn(r["classifiedBy"], ("regex", "template", "model"))
        t.assertRegex(r["startDate"], ISO)
        t.assertRegex(r["endDate"], ISO)
        t.assertTrue(r["title"])
    for i in d["issues"]:
        t.assertIn(i["code"], ISSUE_CODES)
        t.assertIn(i["severity"], ("error", "warning", "info"))
    json.dumps(d)  # serialisable


def xlsx(build) -> bytes:
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    build(wb)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


GREEN, BLUE = PatternFill("solid", fgColor="FF00B050"), PatternFill("solid", fgColor="FF0070C0")


def grid_sheet(wb, year, month, day1_col=2, labels=("North Pier West - 410'",), numbers=True):
    """A one-month block: header on row 1 (month in A, day numbers from day1_col), weekday row 2, berth rows from 3."""
    ws = wb["%s" % year] if str(year) in wb.sheetnames else wb.create_sheet(str(year))
    ws.cell(1, 1, datetime.date(int(year), month, 1).strftime("%B %Y").upper())
    for d in range(1, 32):
        if numbers:
            ws.cell(1, day1_col + d - 1, d)
        ws.cell(2, day1_col + d - 1, "M")
    for i, lab in enumerate(labels):
        if lab is not None:
            ws.cell(3 + i, 1, lab)
    return ws


def bar(ws, row, c0, c1, name=None, fill=GREEN, name_col=None):
    for c in range(c0, c1 + 1):
        ws.cell(row, c).fill = fill
    if name:
        ws.cell(row, name_col or c0, name)


def stays(d):
    return sorted((r["berthLabel"], r["title"], r["startDate"], r["endDate"]) for r in d["rows"])


class GridRules(unittest.TestCase):
    def test_a_coloured_bar_is_one_stay(self):
        d = dockparse.run(xlsx(lambda wb: bar(grid_sheet(wb, "2030", 3), 3, 5, 9, "R/V Bar")), use_model=False)
        self.assertEqual(stays(d), [("North Pier West", "R/V Bar", "2030-03-04", "2030-03-08")])

    def test_two_names_in_one_run_split_it(self):
        def build(wb):
            ws = grid_sheet(wb, "2030", 3)
            bar(ws, 3, 2, 10, "R/V One")
            ws.cell(3, 7, "R/V Two")
        self.assertEqual(stays(dockparse.run(xlsx(build), use_model=False)),
                         [("North Pier West", "R/V One", "2030-03-01", "2030-03-05"),
                          ("North Pier West", "R/V Two", "2030-03-06", "2030-03-09")])

    def test_name_in_a_differently_coloured_first_cell_still_owns_the_bar(self):
        def build(wb):
            ws = grid_sheet(wb, "2030", 3)
            bar(ws, 3, 2, 2, "Barge Salt Dory", fill=BLUE)
            bar(ws, 3, 3, 8)
        self.assertEqual(stays(dockparse.run(xlsx(build), use_model=False)),
                         [("North Pier West", "Barge Salt Dory", "2030-03-01", "2030-03-07")])

    def test_colour_names_an_unnamed_bar_on_the_same_row(self):
        def build(wb):
            ws = grid_sheet(wb, "2030", 3)
            bar(ws, 3, 2, 4)                      # unnamed, green
            bar(ws, 3, 10, 12, "R/V Green")       # the row's only green name
        d = dockparse.run(xlsx(build), use_model=False)
        self.assertEqual(stays(d), [("North Pier West", "R/V Green", "2030-03-01", "2030-03-03"),
                                    ("North Pier West", "R/V Green", "2030-03-09", "2030-03-11")])

    def test_unnamed_bar_continues_last_months_stay_or_is_flagged(self):
        def build(wb):
            ws = grid_sheet(wb, "2030", 1)
            bar(ws, 3, 30, 32, "R/V Long")        # Jan 29–31
            ws.cell(8, 1, "FEBRUARY 2030")
            for d in range(1, 29):
                ws.cell(8, 1 + d, d)
            ws.cell(9, 1, "North Pier West - 410'")
            bar(ws, 9, 2, 4)                      # Feb 1–3, no name → continues R/V Long
            ws.cell(10, 1, "Inner Channel - 55'")
            bar(ws, 10, 6, 7, fill=BLUE)          # nothing to continue → flagged
        d = dockparse.run(xlsx(build), use_model=False)
        self.assertEqual(stays(d), [("North Pier West", "R/V Long", "2030-01-29", "2030-02-03")])
        flagged = [i for i in d["issues"] if i["code"] == "UNLABELED_BAR"]
        self.assertEqual([(i["cell"], i["row"]["berthLabel"], i["row"]["startDate"]) for i in flagged],
                         [("F10", "Inner Channel", "2030-02-05")])

    def test_weekday_aligned_month_dates_the_spill_columns(self):
        # March 2030 starts on a Friday: day 1 in column F, so B..E are 25–28 February
        def build(wb):
            ws = grid_sheet(wb, "2030", 3, day1_col=6)
            ws.cell(3, 3, "R/V Early")
        self.assertEqual(stays(dockparse.run(xlsx(build), use_model=False)),
                         [("North Pier West", "R/V Early", "2030-02-26", "2030-02-26")])

    def test_day_one_is_found_by_majority_even_in_a_damaged_header(self):
        def build(wb):
            ws = grid_sheet(wb, "2030", 3)
            for c in range(2, 8):
                ws.cell(1, c, "R/V Debris")       # days 1–6 overwritten by text
            ws.cell(3, 10, "R/V Real")            # column J = day 9
        d = dockparse.run(xlsx(build), use_model=False)
        self.assertEqual(stays(d), [("North Pier West", "R/V Real", "2030-03-09", "2030-03-09")])
        self.assertEqual(sum(i["code"] == "HEADER_AREA_TEXT" for i in d["issues"]), 6)

    def test_unlabeled_rows_under_a_section_belong_to_it_but_under_a_berth_are_overflow(self):
        def build(wb):
            ws = grid_sheet(wb, "2030", 3, labels=("South Float East - 90'", None, "Small craft slips (institution)", None))
            ws.cell(4, 3, "R/V Overflow")
            ws.cell(6, 4, "S/V Slip")
        d = dockparse.run(xlsx(build), use_model=False)
        self.assertEqual(stays(d), [("Small Craft Slips", "S/V Slip", "2030-03-03", "2030-03-03")])
        self.assertEqual([i["row"]["title"] for i in d["issues"] if i["code"] == "NO_BERTH"], ["R/V Overflow"])

    def test_ledger_has_no_holes_on_a_small_grid(self):
        from dockparse.audit import audit
        def build(wb):
            ws = grid_sheet(wb, "2030", 3)
            bar(ws, 3, 2, 5, "R/V A")
            ws.cell(3, 9, 1400)
        self.assertEqual(audit(xlsx(build))["unaccounted"], [])


class SampleWorkbook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with mock.patch.object(model, "label", return_value=({}, 0)):
            cls.d = dockparse.run(SAMPLE.read_bytes())

    def test_shape(self):
        check_shape(self, self.d)

    def test_berths_match_the_default_fleet(self):
        got = [(b["name"], b["kind"], b["lengthFt"]) for b in self.d["berths"]]
        defaults = json.loads((ROOT / "backend" / "seed" / "defaults.json").read_text())["berths"]
        self.assertEqual(got, [(b["name"], b["kind"], b["lengthFt"]) for b in defaults])

    def test_golden_counts(self):
        from collections import Counter
        codes = Counter(i["code"] for i in self.d["issues"])
        self.assertEqual(self.d["format"], "legacy_grid")
        self.assertEqual(self.d["stats"]["sheets"], 23)
        self.assertTrue(1900 <= len(self.d["rows"]) <= 2300, len(self.d["rows"]))
        self.assertTrue(100 <= codes["NO_BERTH"] <= 140, codes["NO_BERTH"])        # overflow rows under South Float East
        self.assertEqual(codes["DUPLICATE_CARRYOVER"], 3)
        self.assertEqual(codes["HEADER_YEAR_MISMATCH"], 2)
        self.assertTrue(100 <= codes["ANNOTATION_SKIPPED"] <= 130)
        self.assertEqual(codes["OUTSIDE_MONTH_COLUMNS"], 0)    # weekday-aligned spill columns are dated now
        self.assertEqual(codes["UNPARSEABLE_CELL"], 0)         # "Bunker barge" is a fuelling note
        self.assertTrue(50 <= codes["HEADER_AREA_TEXT"] <= 70)  # the corrupted Nov/Dec 2010 headers
        self.assertTrue(180 <= codes["UNLABELED_BAR"] <= 260)

    def test_bars_are_read_as_stays(self):
        # 2006 North Pier West: "R/V CLEAR SEXTANT" in U8, green through AF8 (Jan 20–31), named again on Feb 1–3 → one stay
        r = next(r for r in self.d["rows"] if r["sheet"] == "2006" and r["cell"] == "U8")
        self.assertEqual((r["title"], r["startDate"], r["endDate"]), ("R/V Clear Sextant", "2006-01-20", "2006-02-03"))
        days = sum((datetime.date.fromisoformat(r["endDate"]) - datetime.date.fromisoformat(r["startDate"])).days + 1
                   for r in self.d["rows"])
        self.assertTrue(10_000 <= days <= 12_500, days)

    def test_corrupted_2010_november_header_is_voted_right(self):
        # day numbers are partly overwritten/shifted; the majority says day 1 is column C → C119.. are November days
        self.assertFalse([r for r in self.d["rows"] if r["sheet"] == "2010" and r["cell"] in ("C118", "I118")])
        nov = [r for r in self.d["rows"] if r["sheet"] == "2010" and r["startDate"].startswith("2010-11")]
        self.assertTrue(nov)

    def test_small_craft_slip_rows_keep_their_section(self):
        slips = [r for r in self.d["rows"] if r["berthLabel"] == "Small Craft Slips"]
        self.assertTrue(any(r["sheet"] == "2011" and r["cell"].endswith("104") for r in slips))

    def test_every_cell_is_accounted_for(self):
        from dockparse.audit import audit
        self.assertEqual(audit(SAMPLE.read_bytes())["unaccounted"], [])

    def test_2010_sheet_years_inferred_not_trusted(self):
        # the 2010 sheet labels its last blocks "NOVEMBER 2018" / "DECEMBER 2018"
        on_2010 = [r for r in self.d["rows"] if r["sheet"] == "2010"]
        self.assertTrue(on_2010)
        self.assertTrue(all(r["startDate"].startswith("2010") for r in on_2010))

    def test_registry_lengths_attached(self):
        with_len = [v for v in self.d["vessels"] if v["lengthFt"] is not None]
        self.assertEqual(len(with_len), 164)          # the registry size (defaults.json)
        self.assertLessEqual(max(v["lengthFt"] for v in with_len), 410)

    def test_no_duplicate_stays(self):
        keys = [(r["berthLabel"], r["title"].upper(), r["startDate"]) for r in self.d["rows"]]
        self.assertEqual(len(keys), len(set(keys)))


class ModelStep(unittest.TestCase):
    def test_model_labels_only_leftovers_and_is_flagged(self):
        seen = {}

        def fake(texts, api_key=None):
            seen["texts"] = list(texts)
            return {"Big Blue Thing": "vessel"}, 1
        def build(wb):
            ws = grid_sheet(wb, "2030", 1)
            ws["B3"] = "Big Blue Thing"
            ws["D3"] = "R/V Known"
        with mock.patch.object(model, "label", side_effect=fake):
            d = dockparse.run(xlsx(build))
        self.assertEqual(seen["texts"], ["Big Blue Thing"])     # regex placed everything else
        self.assertEqual(d["stats"]["modelCalls"], 1)
        by_model = [r for r in d["rows"] if r["classifiedBy"] == "model"]
        self.assertTrue(by_model and all(r["occupantType"] == "vessel" for r in by_model))
        self.assertFalse(any(i["code"] == "UNPARSEABLE_CELL" for i in d["issues"]))
        self.assertTrue(any(i["code"] == "MODEL_CLASSIFIED" for i in d["issues"]))

    def test_no_key_means_no_call(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(model.label(["anything"]), ({}, 0))


class Template(unittest.TestCase):
    def build(self, wb):
        b = wb.create_sheet("Berths")
        b.append(["Name", "Kind", "Length (ft)", "Order"])
        b.append(["e.g. Example Pier", "berth", 100, 1])
        b.append(["Main Pier", "berth", 300, 1])
        b.append(["Slips", "section", None, 2])
        b.append(["Bad", "dock", 10, 3])
        b.append(["main pier", "berth", 200, 4])
        b.append(["No Length", "berth", None, 5])
        v = wb.create_sheet("Vessels")
        v.append(["Name", "Length (ft)", "Draft (ft)", "Operator", "Notes"])
        v.append(["R/V SEA LION", "120'", 9, "WHOI", None])
        v.append(["Unknown Len", None, None, None, None])
        v.append(["Negative", -5, None, None, None])
        k = wb.create_sheet("Bookings")
        k.append(["Berth", "Type", "Vessel / Title", "Start", "End", "Notes"])
        k.append(["Main Pier", "vessel", "r/v sea lion", datetime.datetime(2027, 3, 5), datetime.datetime(2027, 3, 9), None])
        k.append(["Slips", "event", "Sail day", "2027-04-01", "2027-04-01", "bring flags"])
        k.append(["Main Pier", "vessel", "M/V Newcomer", "2027-05-01", "2027-05-03", None])
        k.append(["Main Pier", "party", "x", "2027-05-01", "2027-05-01", None])
        k.append(["Main Pier", "closure", "Crane", "2027-02-30", "2027-03-01", None])
        k.append([None, "event", "Nowhere", "2027-06-01", "2027-06-01", None])
        k.append(["Main Pier", "event", "Backwards", "2027-07-09", "2027-07-01", None])   # rules.ts judges this

    def setUp(self):
        self.d = dockparse.run(xlsx(self.build))

    def test_shape_and_format(self):
        check_shape(self, self.d)
        self.assertEqual(self.d["format"], "template")

    def test_berths(self):
        self.assertEqual([(b["name"], b["kind"], b["lengthFt"]) for b in self.d["berths"]],
                         [("Main Pier", "berth", 300), ("Slips", "section", None)])

    def test_vessels_incl_unlisted_booked_one(self):
        names = {v["name"]: v["lengthFt"] for v in self.d["vessels"]}
        self.assertEqual(names, {"R/V Sea Lion": 120, "Unknown Len": None, "M/V Newcomer": None})

    def test_rows(self):
        rows = {r["title"]: r for r in self.d["rows"]}
        self.assertEqual(set(rows), {"R/V Sea Lion", "Sail day", "M/V Newcomer", "Backwards"})
        self.assertEqual((rows["R/V Sea Lion"]["startDate"], rows["R/V Sea Lion"]["endDate"]), ("2027-03-05", "2027-03-09"))
        self.assertEqual(rows["Sail day"]["notes"], "bring flags")
        self.assertTrue(all(r["classifiedBy"] == "template" for r in rows.values()))

    def test_issues(self):
        got = sorted((i["code"], i["cell"]) for i in self.d["issues"])
        self.assertEqual(got, sorted([
            ("INVALID_VALUE", "B5"),     # kind "dock"
            ("DUPLICATE_NAME", "A6"),    # "main pier" again
            ("INVALID_VALUE", "C7"),     # berth without length
            ("INVALID_VALUE", "B4"),     # negative vessel length
            ("INVALID_VALUE", "B5"),     # type "party"  (Bookings!B5)
            ("INVALID_VALUE", "D6"),     # 2027-02-30
            ("NO_BERTH", "A7"),          # empty berth → issue with row
        ]))
        no_berth = next(i for i in self.d["issues"] if i["code"] == "NO_BERTH")
        self.assertEqual(no_berth["row"]["title"], "Nowhere")

    def test_bad_header_skips_only_that_sheet(self):
        def build(wb):
            self.build(wb)
            ws = wb["Vessels"]
            ws["B1"] = "LOA"
        d = dockparse.run(xlsx(build))
        self.assertEqual([i["sheet"] for i in d["issues"] if i["code"] == "TEMPLATE_BAD_HEADER"], ["Vessels"])
        self.assertEqual(len(d["berths"]), 2)


class Edges(unittest.TestCase):
    def test_unknown_format(self):
        d = dockparse.run(xlsx(lambda wb: wb.create_sheet("Stuff").append(["hello"])))
        check_shape(self, d)
        self.assertIsNone(d["format"])
        self.assertEqual([i["code"] for i in d["issues"]], ["UNKNOWN_FORMAT"])

    def test_not_an_xlsx(self):
        d = dockparse.run(b"definitely not a zip")
        self.assertEqual([i["code"] for i in d["issues"]], ["UNKNOWN_FORMAT"])

    def test_merge_joins_across_month_boundary_but_not_gaps(self):
        r = lambda s, e: {"berthLabel": "B", "occupantType": "vessel", "title": "R/V A", "startDate": s, "endDate": e,
                          "notes": None, "sheet": "2020", "cell": "B1", "classifiedBy": "regex"}
        out = _merge([r("2020-01-29", "2020-01-31"), r("2020-02-01", "2020-02-03"), r("2020-02-05", "2020-02-05")])
        self.assertEqual([(x["startDate"], x["endDate"]) for x in out],
                         [("2020-01-29", "2020-02-03"), ("2020-02-05", "2020-02-05")])

    def test_cli_stdin_roundtrip(self):
        p = subprocess.run([sys.executable, "-m", "pipeline.cli", "--stdin", "--no-model"], cwd=ROOT,
                           input=xlsx(lambda wb: wb.create_sheet("Berths").append(["Name", "Kind", "Length (ft)", "Order"])),
                           capture_output=True, check=True)
        self.assertEqual(json.loads(p.stdout)["format"], "template")


if __name__ == "__main__":
    unittest.main()
