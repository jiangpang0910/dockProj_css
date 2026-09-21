"""Solver tests: small hand-built yards where the right answer is known. Run from the repo root:
    python3 -m unittest discover -s pipeline/tests -v
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from docksolve import solve  # noqa: E402

OPTS = {"maxDelayDays": 3, "maxEarlyDays": 0, "maxMoves": 1, "minSegmentDays": 2,
        "weights": {"delay": 2, "early": 3, "move": 3}, "timeLimitSec": 5}
A = {"id": "A", "name": "Berth A", "lengthFt": 90}
B = {"id": "B", "name": "Berth B", "lengthFt": 85}
C = {"id": "C", "name": "Berth C", "lengthFt": 100}


def day(n):  # day 1 = 2030-06-01
    return f"2030-06-{n:02d}"


def claim(cid="c1", s=1, e=5, berth="A", vessel="v1", length=80, kind="vessel"):
    return {"id": cid, "title": f"R/V {vessel}" if kind == "vessel" else cid, "occupantType": kind,
            "vesselId": vessel if kind == "vessel" else None, "vesselLengthFt": length if kind == "vessel" else None,
            "berthId": berth, "berthName": berth and f"Berth {berth}", "startDate": day(s), "endDate": day(e)}


def busy(berth, s, e):
    return {"berthId": berth, "startDate": day(s), "endDate": day(e)}


def run(conflicts, berths, berth_busy=(), vessel_busy=(), **opts):
    return solve({"options": {**OPTS, **opts}, "berths": list(berths), "conflicts": list(conflicts),
                  "berthBusy": list(berth_busy), "vesselBusy": list(vessel_busy)})


def plan(res, cid="c1"):
    """[(berth, start day, end day), ...] for one proposal."""
    p = next(p for p in res["proposals"] if p["conflictId"] == cid)
    return [(s["berthId"], int(s["startDate"][-2:]), int(s["endDate"][-2:])) for s in p["segments"]]


class Placement(unittest.TestCase):
    def test_free_elsewhere_takes_the_tightest_fit(self):
        r = run([claim()], [A, B, C], [busy("A", 4, 5)])
        self.assertEqual(r["status"], "OPTIMAL")
        self.assertEqual(plan(r), [("B", 1, 5)])           # B 85′ wastes 5′/day, C 100′ would waste 20′
        p = r["proposals"][0]
        self.assertEqual(p["cost"], {"delayDays": 0, "earlyDays": 0, "moves": 0, "slackFootDays": 25,
                                     "offRequestedDays": 5})
        self.assertEqual(p["segments"][0]["slackFt"], 5)
        self.assertEqual(p["requested"]["berthId"], "A")

    def test_split_beats_a_long_delay(self):
        # A free days 1–3 only, C free from day 4: whole-stay options need a 3-day delay (cost 6) > one move (3)
        r = run([claim()], [A, C], [busy("A", 4, 30), busy("C", 1, 3)])
        self.assertEqual(plan(r), [("A", 1, 3), ("C", 4, 5)])
        self.assertEqual(r["proposals"][0]["cost"]["moves"], 1)
        self.assertEqual(r["proposals"][0]["shiftDays"], 0)

    def test_one_day_late_beats_a_split(self):
        # A taken day 1 → 1 day late on A costs 2; split C 1–3 → A 4–5 costs 3
        r = run([claim()], [A, C], [busy("A", 1, 1), busy("C", 4, 30)])
        self.assertEqual(plan(r), [("A", 2, 6)])
        self.assertEqual(r["proposals"][0]["shiftDays"], 1)

    def test_weights_change_the_answer(self):
        r = run([claim()], [A, C], [busy("A", 1, 1), busy("C", 4, 30)], weights={"delay": 5, "early": 3, "move": 3})
        self.assertEqual(plan(r), [("C", 1, 2), ("A", 3, 5)])   # as few days as possible on the roomier C

    def test_never_earlier_by_default_but_can_be_allowed(self):
        blocked = [busy("A", 1, 5), busy("C", 1, 30)]
        r = run([claim(s=3, e=4)], [A, C], blocked + [busy("A", 5, 30)], maxDelayDays=0)
        self.assertEqual(r["unplaced"][0]["reason"], "NO_ROOM")
        r = run([claim(s=6, e=7)], [A, C], [busy("A", 6, 30), busy("C", 1, 30)], maxDelayDays=0, maxEarlyDays=2)
        self.assertEqual(plan(r), [("A", 4, 5)])
        self.assertEqual(r["proposals"][0]["cost"]["earlyDays"], 2)

    def test_back_to_back_is_allowed(self):
        r = run([claim(s=4, e=6)], [A], [busy("A", 1, 3), busy("A", 7, 9)])
        self.assertEqual(plan(r), [("A", 4, 6)])

    def test_segments_respect_min_length(self):
        # the only split would be A day 1, C days 2–5: a 1-day segment is not allowed
        r = run([claim()], [A, C], [busy("A", 2, 30), busy("C", 1, 1)], maxDelayDays=0)
        self.assertEqual(r["unplaced"][0]["reason"], "NO_ROOM")
        r = run([claim()], [A, C], [busy("A", 2, 30), busy("C", 1, 1)], maxDelayDays=0, minSegmentDays=1)
        self.assertEqual(plan(r), [("A", 1, 1), ("C", 2, 5)])

    def test_no_moves_when_moves_are_off(self):
        r = run([claim()], [A, C], [busy("A", 4, 30), busy("C", 1, 3)], maxMoves=0)
        self.assertEqual(plan(r), [("C", 4, 8)])                 # no split allowed → the 3-day delay is all that's left
        r = run([claim()], [A, C], [busy("A", 4, 30), busy("C", 1, 3)], maxMoves=0, maxDelayDays=2)
        self.assertEqual(r["unplaced"][0]["reason"], "NO_ROOM")

    def test_two_moves(self):
        r = run([claim(e=6)], [A, B, C], [busy("A", 3, 30), busy("B", 1, 2), busy("B", 5, 30), busy("C", 1, 4)],
                maxMoves=2, maxDelayDays=0)
        self.assertEqual(plan(r), [("A", 1, 2), ("B", 3, 4), ("C", 5, 6)])
        self.assertEqual(r["stats"]["moves"], 2)


class Hard(unittest.TestCase):
    def test_berth_must_be_long_enough(self):
        r = run([claim(length=95)], [A, B, C], [busy("C", 1, 30)])
        self.assertEqual(r["unplaced"][0]["reason"], "NO_ROOM")      # only C fits, and C is full
        r = run([claim(length=120)], [A, B, C])
        self.assertEqual(r["unplaced"][0]["reason"], "NO_BERTH_LONG_ENOUGH")
        self.assertIn("100", r["unplaced"][0]["detail"])

    def test_exact_fit_is_allowed(self):
        self.assertEqual(plan(run([claim(length=90)], [A])), [("A", 1, 5)])

    def test_vessel_is_in_one_place_at_a_time(self):
        # v1 sits on some section days 1–5 (fixed): the claim for days 4–5 must wait until day 6
        r = run([claim(s=4, e=5)], [A], vessel_busy=[{"vesselId": "v1", "startDate": day(1), "endDate": day(5)}])
        self.assertEqual(plan(r), [("A", 6, 7)])

    def test_two_claims_of_one_vessel_dont_overlap(self):
        r = run([claim("c1", 1, 3, "A"), claim("c2", 2, 4, "B")], [A, B, C], maxDelayDays=3)
        placed = sorted(plan(r, c) for c in ("c1", "c2"))
        (a,), (b,) = placed
        self.assertTrue(a[2] < b[1] or b[2] < a[1], placed)

    def test_selected_claims_dont_collide(self):
        r = run([claim("c1", vessel="v1"), claim("c2", vessel="v2")], [A], maxDelayDays=0)
        self.assertEqual(r["stats"]["placed"], 1)
        self.assertEqual(r["unplaced"][0]["reason"], "NO_ROOM")

    def test_places_as_many_as_possible_before_anything_else(self):
        # c1 asked for C, but c2 (95′) fits nowhere else: c1 goes to A so both are placed
        big = claim("c2", vessel="v2", length=95, berth="C")
        r = run([claim("c1", berth="C"), big], [A, C], maxDelayDays=0)
        self.assertEqual(r["stats"]["placed"], 2)
        self.assertEqual(plan(r, "c1"), [("A", 1, 5)])
        self.assertEqual(plan(r, "c2"), [("C", 1, 5)])


class Skips(unittest.TestCase):
    def test_closures_and_unknown_lengths_are_never_moved(self):
        r = run([claim("k", kind="closure"), claim("u", length=None)], [A])
        self.assertEqual({u["conflictId"]: u["reason"] for u in r["unplaced"]}, {"k": "CLOSURE", "u": "LENGTH_UNKNOWN"})
        self.assertEqual(r["proposals"], [])
        self.assertEqual(r["stats"]["considered"], 0)

    def test_events_fit_anywhere_with_no_slack_and_stay_put_if_they_can(self):
        r = run([claim("e", kind="event", berth="C")], [A, B, C])
        self.assertEqual(plan(r, "e"), [("C", 1, 5)])
        self.assertIsNone(r["proposals"][0]["segments"][0]["slackFt"])
        self.assertEqual(r["proposals"][0]["cost"]["slackFootDays"], 0)

    def test_no_berth_claim_gets_one(self):
        r = run([claim(berth=None)], [A, C])
        self.assertEqual(plan(r), [("A", 1, 5)])


class Shape(unittest.TestCase):
    def test_result_shape_and_cli(self):
        inp = {"options": OPTS, "berths": [A, C], "conflicts": [claim()], "berthBusy": [busy("A", 4, 5)],
               "vesselBusy": []}
        out = subprocess.run([sys.executable, "-m", "pipeline.solve_cli"], cwd=ROOT, input=json.dumps(inp),
                             capture_output=True, text=True, check=True)
        r = json.loads(out.stdout)
        self.assertEqual(set(r), {"status", "options", "stats", "proposals", "unplaced"})
        self.assertEqual(set(r["stats"]), {"selected", "considered", "placed", "unplaced", "moves", "delayDays",
                                           "slackFootDays", "solveMs"})
        self.assertEqual(set(r["proposals"][0]), {"conflictId", "title", "occupantType", "vesselLengthFt", "requested",
                                                  "segments", "shiftDays", "cost"})
        self.assertEqual(plan(r), [("C", 1, 5)])

    def test_many_claims_solve_fast(self):
        berths = [{"id": f"b{i}", "name": f"B{i}", "lengthFt": 60 + 20 * i} for i in range(6)]
        conflicts = [claim(f"c{i}", 1 + (i * 3) % 25, 3 + (i * 3) % 25, f"b{i % 6}", f"v{i}", 50 + (i * 7) % 100)
                     for i in range(120)]
        r = run(conflicts, berths, timeLimitSec=3)   # over-full on purpose: stops at the limit with a valid answer
        self.assertIn(r["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertLess(r["stats"]["solveMs"], 4_000)
        # no two placed segments share a berth-day
        taken = set()
        for p in r["proposals"]:
            for s in p["segments"]:
                for d in range(int(s["startDate"][-2:]), int(s["endDate"][-2:]) + 1):
                    key = (s["berthId"], s["startDate"][:7], d)
                    self.assertNotIn(key, taken)
                    taken.add(key)
                self.assertGreaterEqual(s["berthLengthFt"], p["vesselLengthFt"])


if __name__ == "__main__":
    unittest.main()
