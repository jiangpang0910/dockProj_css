"""CLI: python3 -m pipeline.audit <file.xlsx>  →  what the parser did with every cell (see dockparse/audit.py)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dockparse.audit import audit  # noqa: E402

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], "rb") as f:
        r = audit(f.read())
    for k, n in r["counts"].items():
        print(f"{n:7d}  {k}")
    print(f"\n{len(r['unaccounted'])} cell(s) unaccounted for")
    for h in r["unaccounted"][:50]:
        print("  ", json.dumps(h, default=str))
