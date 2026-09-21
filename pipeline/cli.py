"""CLI: python3 -m pipeline.cli <file.xlsx | --stdin> [--no-model] [--pretty]  →  ParsedWorkbook JSON on stdout.

Used by the TS importer locally (src/server/import/parser.ts spawns it with --stdin), by db:seed, and by hand.
Exit code 0 even for UNKNOWN_FORMAT: that's a result, reported as an issue. Exit 2 only for bad arguments.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dockparse import run  # noqa: E402


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    if "--stdin" in flags:
        data = sys.stdin.buffer.read()
    elif len(args) == 1:
        with open(args[0], "rb") as f:
            data = f.read()
    else:
        print(__doc__, file=sys.stderr)
        return 2
    result = run(data, use_model="--no-model" not in flags)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if "--pretty" in flags else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
