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


def label(texts, api_key=None):
    """→ ({text: label}, calls_made). Only labels in LABELS other than 'unknown' are returned."""
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    texts = sorted(set(texts))[:MAX_STRINGS]
    if not api_key or not texts:
        return {}, 0
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 4096,
        "temperature": 0,
        "messages": [{"role": "user", "content": PROMPT + json.dumps(texts, ensure_ascii=False)}],
    }).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
        "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            reply = json.load(resp)
        text = "".join(b.get("text", "") for b in reply.get("content", []) if b.get("type") == "text")
        start, end = text.find("{"), text.rfind("}")
        parsed = json.loads(text[start:end + 1])
    except Exception:
        return {}, 1
    return {t: l for t, l in parsed.items() if t in texts and l in LABELS and l != "unknown"}, 1
