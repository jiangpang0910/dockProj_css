"""One watched CP-SAT run for the monitor (cpsat/server.ts spawns it: python3 cpsat/worker.py).

stdin   line 1: {"input": SolverInput, "stageSeconds": number}
        then any of: "skip" (stop the running stage, keep its best, go on)  "stop" (stop it and skip the rest)
stdout  one JSON event per line:
        start     {counts, stages, shares}               shares: how production splits timeLimitSec
        stage     {k, name, maximize}                       a stage begins; t below is seconds since it began
        solution  {k, t, obj, bound}                        a better answer
        bound     {k, t, bound}                             a tighter proof of how good an answer can get
        log       {line}                                    CP-SAT's own search log
        stageEnd  {k, t, status, obj, bound, stopped}
        result    {result}                                  the SolveResult, as the app would get it
        error     {message}
"""
import json
import os
import sys
import threading
import time
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))
from ortools.sat.python import cp_model  # noqa: E402
from docksolve import STAGE_SHARE, STAGES, Watch, solve  # noqa: E402

_out = threading.Lock()


def emit(kind, **data):
    with _out:
        sys.stdout.write(json.dumps({"type": kind, **data}) + "\n")
        sys.stdout.flush()


class _Improved(cp_model.CpSolverSolutionCallback):
    def __init__(self, k):
        super().__init__()
        self.k = k

    def on_solution_callback(self):
        emit("solution", k=self.k, t=self.wall_time, obj=self.objective_value, bound=self.best_objective_bound)


class Monitor(Watch):
    def __init__(self, stage_seconds):
        self.stage_seconds = stage_seconds
        self.solver = None
        self.t0 = 0.0
        self.stopped = False  # the running stage was stopped by hand

    def stage_start(self, k, maximize, solver):
        self.solver, self.t0, self.stopped = solver, time.monotonic(), False
        solver.parameters.log_search_progress = True
        solver.parameters.log_to_stdout = False
        solver.log_callback = lambda line: emit("log", line=line)
        solver.best_bound_callback = lambda b: emit("bound", k=k, t=time.monotonic() - self.t0, bound=b)
        emit("stage", k=k, name=STAGES[k], maximize=maximize)

    def callback(self, k):
        return _Improved(k)

    def stage_end(self, k, status, solver):
        found = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        emit("stageEnd", k=k, t=time.monotonic() - self.t0, status=solver.status_name(status),
             obj=solver.objective_value if found else None, bound=solver.best_objective_bound if found else None,
             stopped=self.stopped)
        self.solver = None

    def command(self, cmd):
        if cmd == "stop":
            self.stop_all = True
        if cmd in ("skip", "stop") and self.solver is not None:
            self.stopped = True
            self.solver.stop_search()


def main():
    try:
        job = json.loads(sys.stdin.readline())
        inp = job["input"]
    except (ValueError, KeyError) as e:
        emit("error", message=f"bad job: {e}")
        return 2
    watch = Monitor(float(job["stageSeconds"]))

    def listen():
        for line in sys.stdin:
            watch.command(line.strip())
    threading.Thread(target=listen, daemon=True).start()

    emit("start", counts={"conflicts": len(inp["conflicts"]), "berths": len(inp["berths"]),
                          "berthBusy": len(inp["berthBusy"]), "vesselBusy": len(inp["vesselBusy"])},
         stages=STAGES, shares=STAGE_SHARE)
    try:
        emit("result", result=solve(inp, watch))
    except Exception as e:  # noqa: BLE001 — the page shows it rather than a dead stream
        emit("error", message=f"{type(e).__name__}: {e}", trace=traceback.format_exc())
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
