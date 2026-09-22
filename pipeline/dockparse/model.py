"""The optional model step: label the cell texts regex couldn't place.

One batched request per upload, unique strings only, temperature 0, strict JSON back. The model only ever LABELS
text (vessel / event / closure / note / unknown); dates, berths and lengths always come from the grid and regex.
No ANTHROPIC_API_KEY, a network error or a malformed reply → returns {} and the cells stay UNPARSEABLE_CELL.
Standard library only, so the Vercel function stays small.
"""
import json
import os
import urllib.request

MODEL = "claude-haiku-4-5-20251001"
LABELS = {"vessel", "event", "closure", "note", "unknown"}
MAX_STRINGS = 300          # a single upload never needs more; the sample has a few dozen leftovers
TIMEOUT_S = 25

PROMPT = """You label free-text cells from a marine research facility's dock schedule spreadsheet.
Each cell occupied a berth (a mooring) for one or more days. Label each with exactly one of:
- "vessel": a boat or ship occupying the berth (even without an R/V, M/V… prefix)
- "event": a non-vessel use of the berth by people (community day, class, ceremony, scouts, filming…)
- "closure": the berth is unusable (maintenance, repairs, survey work, construction, hazards…)
- "note": an operational remark, not an occupant (arrival times, fuel, deliveries, reminders…)
- "unknown": you can't tell
Reply with ONLY a JSON object mapping each input string exactly to its label. No prose.

Cells:
"""


LAYOUT_PROMPT = """These are the first rows of spreadsheet sheets from a marine facility's dock schedule that our
automatic reader could not map to columns. For each sheet, say which row is the header row (1-based; null if the
table has no header row) and which column letter holds which field. Fields: berth, vessel, type, start, end,
dates (a single column holding a date range), notes, length, draft, operator, order.
A sheet is worth mapping only if it is a table of stays (vessel + dates, usually a berth), a list of vessels
(name + length) or a list of berths (name + length). Omit sheets that are none of these.
Reply with ONLY a JSON object: {"<sheet title>": {"headerRow": <number or null>, "columns": {"<letter>": "<field>"}}}.
Never name a column that isn't shown, and never guess values: you only say where things are.

Sheets:
"""


def label(texts, api_key=None):
    """→ ({text: label}, calls_made). Only labels in LABELS other than 'unknown' are returned."""
    texts = sorted(set(texts))[:MAX_STRINGS]
    parsed, calls = _ask(PROMPT + json.dumps(texts, ensure_ascii=False), api_key) if texts else (None, 0)
    if not parsed:
        return {}, calls
    return {t: l for t, l in parsed.items() if t in texts and l in LABELS and l != "unknown"}, calls


def propose_layout(profiles, api_key=None):
    """profiles: [{title, rows: [[cell text…]…], fields}] → ({title: {"headerRow": int|None, "columns": {col_index: field}}},
    calls_made). The model only says WHERE things are; table.py then reads the cells itself. Anything malformed
    is dropped, so a bad answer means a sheet stays skipped, never a wrong booking."""
    from .table import FIELDS
    if not profiles:
        return {}, 0
    parsed, calls = _ask(LAYOUT_PROMPT + json.dumps(profiles, ensure_ascii=False), api_key)
    out = {}
    for title, spec in (parsed or {}).items():
        if not isinstance(spec, dict) or not isinstance(spec.get("columns"), dict):
            continue
        cols = {}
        for letter, field in spec["columns"].items():
            if isinstance(letter, str) and letter.isalpha() and field in FIELDS and field not in cols.values():
                idx = 0
                for ch in letter.upper():
                    idx = idx * 26 + (ord(ch) - 64)
                cols[idx] = field
        hr = spec.get("headerRow")
        if cols and (hr is None or (isinstance(hr, int) and hr >= 1)):
            out[title] = {"headerRow": hr, "columns": cols}
    return out, calls


def _ask(prompt, api_key=None):
    """One request, strict JSON back → (parsed dict | None, calls_made). No key: (None, 0)."""
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None, 0
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 4096,
        "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
        "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            reply = json.load(resp)
        text = "".join(b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text")
        start, end = text.find("{"), text.rfind("}")
        parsed = json.loads(text[start:end + 1])
        return (parsed if isinstance(parsed, dict) else None), 1
    except Exception:
        return None, 1
