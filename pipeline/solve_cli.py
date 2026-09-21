"""CLI: python3 -m pipeline.solve_cli  <  SolverInput JSON  →  SolveResult JSON on stdout.

Used by the TS service locally (src/server/services/solve.ts spawns it). Exit 2 only for unreadable input.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docksolve import solve  # noqa: E402


def main():
    try:
        inp = json.load(sys.stdin)
    except ValueError as e:
        print(f"bad input: {e}", file=sys.stderr)
        return 2
    json.dump(solve(inp), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
