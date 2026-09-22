"""docksolve — CP-SAT auto-resolve for import conflicts (backend.md §6.6). `solve(input)` → a SolveResult dict.

Input (built by src/server/services/solve.ts, shape in shared/solver.ts):
    options      full SolveOptions (defaults already applied)
    berths       active exclusive berths: {id, name, lengthFt}
    conflicts    the selected open conflicts: {id, title, occupantType, vesselId, vesselLengthFt, berthId, berthName,
                 startDate, endDate}
    berthBusy    confirmed bookings on those berths: {berthId, startDate, endDate}   — fixed, never moved
    vesselBusy   confirmed bookings of those vessels, any berth: {vesselId, startDate, endDate}

Model (days are integers; a stay [s, e] inclusive is the interval [s, e + 1)):
    Each conflict is up to maxMoves + 1 consecutive SEGMENTS. Segment j has a start, a size and one berth chosen from
    the berths it fits on (an optional interval per berth). Segment 0 starts at requested start + shift, each next one
    starts where the previous ends, sizes add up to the stay's length. Every present segment of a split stay lasts at
    least minSegmentDays. NoOverlap per berth (with its fixed bookings) and per vessel (with its fixed bookings).

    Lexicographic, each stage solved then held while the next improves:
        1. max  placed
        2. min  delay·wDelay + early·wEarly + moves·wMove
        3. min  Σ (berth length − vessel length) · days          (foot-days; events count 0)
        4. min  days not on the berth the file asked for
It only proposes. Nothing is written until the user applies proposals through the normal booking rules.

`solve(inp, watch)` takes an optional watcher (see `Watch`) that sees every stage, solution and log line and can
stop the search. Only the live monitor (cpsat/) passes one; production runs unwatched.
"""
import datetime as dt
import time

from ortools.sat.python import cp_model

VERSION = 1
SCALE = 10  # lengths in tenths of a foot, so 42.5′ stays exact
STAGE_SHARE = (0.4, 0.3, 0.2, 1.0)  # of the time left when each stage starts; the last gets the rest
STAGES = ("placed", "cost", "slack", "offRequested")  # the lexicographic order below; cpsat/ labels them


class Watch:
    """Does nothing. The monitor subclasses it.

    stage_seconds  None: stages share options.timeLimitSec (production). A number: every stage gets that long.
    stop_all       set True to skip the stages not started yet (the running one is stopped with stop_search()).
    """
    stage_seconds = None
    stop_all = False

    def stage_start(self, k: int, maximize: bool, solver: cp_model.CpSolver):
        pass

    def callback(self, k: int):
        return None  # a CpSolverSolutionCallback, or None

    def stage_end(self, k: int, status: int, solver: cp_model.CpSolver):
        pass


def _d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def _tenths(ft):
    return None if ft is None else round(ft * SCALE)


def solve(inp: dict, watch: Watch | None = None) -> dict:
    t0 = time.monotonic()
    watch = watch or Watch()
    o = inp["options"]
    E, L, M, MIN_SEG = o["maxEarlyDays"], o["maxDelayDays"], o["maxMoves"], o["minSegmentDays"]
    w = o["weights"]
    berths = {b["id"]: b for b in inp["berths"]}

    # ── 0. what can't be solved at all, and why ──
    unplaced, todo = [], []
    for c in inp["conflicts"]:
        skip = None
        if c["occupantType"] == "closure":
            skip = ("CLOSURE", "A closure marks that berth unusable. Moving it elsewhere means nothing.")
        elif c["occupantType"] == "vessel" and c.get("vesselLengthFt") is None:
            skip = ("LENGTH_UNKNOWN", "No length on record, so no berth can be proven to fit. Add its length first.")
        else:
            cands = [b for b in inp["berths"] if _fits(c, b)]
            if not cands:
                longest = max((b["lengthFt"] or 0 for b in inp["berths"]), default=0)
                skip = ("NO_BERTH_LONG_ENOUGH",
                        f"{c['vesselLengthFt']}′ is longer than every active berth (longest {longest}′).")
        if skip:
            unplaced.append({"conflictId": c["id"], "title": c["title"], "reason": skip[0], "detail": skip[1]})
        else:
            todo.append((c, cands))

    if not todo:
        return _result("OPTIMAL", o, inp, [], unplaced, t0)

    # ── 1. day axis ──
    base = min(_d(c["startDate"]) for c, _ in todo) - dt.timedelta(days=E)
    day = lambda s: (_d(s) - base).days  # noqa: E731
    hi = max(day(c["endDate"]) for c, _ in todo) + L + 1  # exclusive end of the latest possible stay

    m = cp_model.CpModel()
    by_berth = {bid: [] for bid in berths}
    by_vessel = {}
    for f in inp["berthBusy"]:
        s, e = max(day(f["startDate"]), 0), min(day(f["endDate"]) + 1, hi)
        if f["berthId"] in by_berth and s < e:
            by_berth[f["berthId"]].append(m.new_fixed_size_interval_var(s, e - s, "busy"))
    vessel_fixed = {}
    for f in inp["vesselBusy"]:
        s, e = max(day(f["startDate"]), 0), min(day(f["endDate"]) + 1, hi)
        if s < e:
            vessel_fixed.setdefault(f["vesselId"], []).append(m.new_fixed_size_interval_var(s, e - s, "vbusy"))

    placed, delay_terms, slack_terms, off_terms, cvars = [], [], [], [], []
    for c, cands in todo:
        cid = c["id"]
        rs, D = day(c["startDate"]), day(c["endDate"]) - day(c["startDate"]) + 1
        nseg = max(1, min(M + 1, D // MIN_SEG)) if M > 0 else 1

        p = m.new_bool_var(f"p[{cid}]")
        dly = m.new_int_var(0, L, f"delay[{cid}]")
        erl = m.new_int_var(0, E, f"early[{cid}]")
        late = m.new_bool_var("late")
        m.add(dly <= L * late)
        m.add(erl <= E * (1 - late))
        m.add(dly <= L * p)
        m.add(erl <= E * p)

        pres, start, size, end, x = [], [], [], [], []
        for j in range(nseg):
            pres.append(p if j == 0 else m.new_bool_var("pres"))
            start.append(m.new_int_var(0, hi, "start"))
            size.append(m.new_int_var(0, D, "size"))
            end.append(m.new_int_var(0, hi, "end"))
            m.add(end[j] == start[j] + size[j])
        m.add(start[0] == rs + dly - erl)
        for j in range(nseg):
            if j + 1 < nseg:
                m.add(start[j + 1] == end[j])
                m.add_implication(pres[j + 1], pres[j])
            m.add(size[j] == 0).only_enforce_if(~pres[j])
            m.add(size[j] >= (MIN_SEG if nseg > 1 else 1)).only_enforce_if(pres[j])
        m.add(sum(size) == D * p)

        for j in range(nseg):
            xj = {}
            for b in cands:
                bid = b["id"]
                xb = m.new_bool_var(f"x[{cid},{j},{bid}]")
                sb = m.new_int_var(0, D, "sz")
                m.add(sb == size[j]).only_enforce_if(xb)
                m.add(sb == 0).only_enforce_if(~xb)
                iv = m.new_optional_interval_var(start[j], sb, end[j], xb, "iv")
                by_berth[bid].append(iv)
                if c["occupantType"] == "vessel" and c.get("vesselId"):
                    by_vessel.setdefault(c["vesselId"], []).append(iv)
                xj[bid] = xb
                slack = _slack(c, b)
                if slack:
                    slack_terms.append(slack * sb)
                if bid != c.get("berthId"):
                    off_terms.append(sb)
            m.add_exactly_one(list(xj.values()) + [~pres[j]])
            if j > 0:
                for bid in xj:  # a move goes somewhere else
                    m.add_bool_or([~xj[bid], ~x[j - 1][bid]])
            x.append(xj)

        moves = sum(pres[1:]) if nseg > 1 else 0
        placed.append(p)
        delay_terms += [w["delay"] * dly, w["early"] * erl] + ([w["move"] * moves] if nseg > 1 else [])
        cvars.append((c, cands, p, dly, erl, pres, start, size, x))

    for ivs in by_berth.values():
        if len(ivs) > 1:
            m.add_no_overlap(ivs)
    for vid, ivs in by_vessel.items():
        ivs = ivs + vessel_fixed.get(vid, [])
        if len(ivs) > 1:
            m.add_no_overlap(ivs)

    # ── 2. lexicographic stages ──
    deadline = t0 + o["timeLimitSec"]
    stages = [(sum(placed), True), (sum(delay_terms), False), (sum(slack_terms), False), (sum(off_terms), False)]
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 8
    all_optimal, have = True, False
    for k, ((expr, maximize), share) in enumerate(zip(stages, STAGE_SHARE)):
        if isinstance(expr, int):  # nothing to optimise at this stage (e.g. only events: no slack)
            continue
        if have and watch.stop_all:
            all_optimal = False
            break
        if watch.stage_seconds is None:
            left = deadline - time.monotonic()
            if have and left <= 0.05:
                all_optimal = False
                break
            solver.parameters.max_time_in_seconds = max(left * share, 0.2)
        else:
            solver.parameters.max_time_in_seconds = watch.stage_seconds
        (m.maximize if maximize else m.minimize)(expr)
        watch.stage_start(k, maximize, solver)
        st = solver.solve(m, watch.callback(k))
        watch.stage_end(k, st, solver)
        if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            if not have:
                return _result("NO_SOLUTION", o, inp, [], unplaced + [
                    {"conflictId": c["id"], "title": c["title"], "reason": "NO_ROOM",
                     "detail": "The solver found no answer in the time allowed. Try fewer conflicts or more time."}
                    for c, _ in todo], t0)
            all_optimal = False
            break
        have = True
        all_optimal &= st == cp_model.OPTIMAL
        best = round(solver.objective_value)
        m.add(expr >= best) if maximize else m.add(expr <= best)
        m.clear_hints()
        for v in _hint_vars(cvars):
            m.add_hint(v, solver.value(v))
        final = {id(v): solver.value(v) for v in _hint_vars(cvars)}

    # ── 3. read the answer ──
    proposals = []
    for c, cands, p, dly, erl, pres, start, size, x in cvars:
        if not final[id(p)]:
            unplaced.append({"conflictId": c["id"], "title": c["title"], "reason": "NO_ROOM",
                             "detail": _no_room_detail(c, cands, o)})
            continue
        segs = []
        for j in range(len(pres)):
            if not final[id(pres[j])]:
                break
            bid = next(b for b, xb in x[j].items() if final[id(xb)])
            s0, n = final[id(start[j])], final[id(size[j])]
            b = berths[bid]
            segs.append({"berthId": bid, "berthName": b["name"], "berthLengthFt": b["lengthFt"],
                         "startDate": (base + dt.timedelta(days=s0)).isoformat(),
                         "endDate": (base + dt.timedelta(days=s0 + n - 1)).isoformat(),
                         "slackFt": _slack_ft(c, b), "_days": n})
        d_, e_ = final[id(dly)], final[id(erl)]
        slack_fd = sum((_slack(c, berths[s["berthId"]]) or 0) * s["_days"] for s in segs) / SCALE
        off = sum(s["_days"] for s in segs if s["berthId"] != c.get("berthId"))
        for s in segs:
            del s["_days"]
        proposals.append({
            "conflictId": c["id"], "title": c["title"], "occupantType": c["occupantType"],
            "vesselLengthFt": c.get("vesselLengthFt"),
            "requested": {"berthId": c.get("berthId"), "berthName": c.get("berthName"),
                          "startDate": c["startDate"], "endDate": c["endDate"]},
            "segments": segs, "shiftDays": d_ - e_,
            "cost": {"delayDays": d_, "earlyDays": e_, "moves": len(segs) - 1,
                     "slackFootDays": _num(slack_fd), "offRequestedDays": off},
        })
    proposals.sort(key=lambda p: (p["requested"]["startDate"], p["title"]))
    return _result("OPTIMAL" if all_optimal else "FEASIBLE", o, inp, proposals, unplaced, t0)


def _fits(c, b) -> bool:
    if c["occupantType"] != "vessel":
        return True  # events have no length
    return b["lengthFt"] is not None and b["lengthFt"] >= c["vesselLengthFt"]


def _slack(c, b):
    """Wasted length in tenths of a foot; 0 for events and unmeasured berths."""
    if c["occupantType"] != "vessel" or b["lengthFt"] is None:
        return 0
    return _tenths(b["lengthFt"]) - _tenths(c["vesselLengthFt"])


def _slack_ft(c, b):
    if c["occupantType"] != "vessel" or b["lengthFt"] is None:
        return None
    return _num(_slack(c, b) / SCALE)


def _num(x):
    return int(x) if float(x).is_integer() else round(x, 1)


def _hint_vars(cvars):
    for _, _, p, dly, erl, pres, start, size, x in cvars:
        yield p
        yield dly
        yield erl
        yield from pres[1:]
        yield from start
        yield from size
        for xj in x:
            yield from xj.values()


def _no_room_detail(c, cands, o) -> str:
    names = ", ".join(b["name"] for b in cands[:4]) + (f" and {len(cands) - 4} more" if len(cands) > 4 else "")
    window = f"up to {o['maxDelayDays']} days late" + (f" or {o['maxEarlyDays']} early" if o["maxEarlyDays"] else "")
    return f"Every berth it fits ({names}) is taken, even {window}" + \
        (f" with up to {o['maxMoves']} move(s)." if o["maxMoves"] else ".")


def _result(status, o, inp, proposals, unplaced, t0) -> dict:
    return {
        "status": status,
        "options": o,
        "stats": {
            "selected": len(inp["conflicts"]),
            "considered": len(inp["conflicts"]) - sum(u["reason"] != "NO_ROOM" for u in unplaced),
            "placed": len(proposals),
            "unplaced": len(unplaced),
            "moves": sum(p["cost"]["moves"] for p in proposals),
            "delayDays": sum(p["cost"]["delayDays"] for p in proposals),
            "slackFootDays": _num(sum(p["cost"]["slackFootDays"] for p in proposals)),
            "solveMs": round((time.monotonic() - t0) * 1000),
        },
        "proposals": proposals,
        "unplaced": unplaced,
    }
