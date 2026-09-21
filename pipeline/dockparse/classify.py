"""Cell text → what kind of occupant it is. Regex first; the model (model.py) only sees what this can't place.

Vessel names start with a hull prefix (R/V, M/V, …). Closures, events and operational notes are recognised
by keywords. Anything else is "unknown" and becomes UNPARSEABLE_CELL (or goes to the model, if enabled).
"""
import re

PREFIX = r"(?:R/V|M/V|M/Y|S/V|S/Y|F/V|OSV|OS/V|TUG|BARGE)"
VESSEL_RE = re.compile(rf"^\s*{PREFIX}\s+\S", re.I)
FT = r"(\d+(?:\.\d+)?)\s*['’′]"
NAME_WITH_LENGTH_RE = re.compile(rf"^\s*(?P<name>{PREFIX}\s+.+?)\s+{FT}\s*$", re.I)

# Order matters: a cell is a closure before it is an event before it is a note.
CLOSURE = ["MAINTENANCE", "REBUILD", "REPAIR", "WORK", "CLOSED", "NO DOCKING", "TEST", "PAVING", "INSPECTION",
           "RESTRICTED", "CRANE", "UTILITY", "BOLLARD"]
EVENT = ["COMMUNITY", "CAMPUS", "HOLIDAY", "RACE", "TOUR", "OPEN HOUSE", "STROLL", "RECEPTION", "DRILL", "TRAINING", "FILM"]
NOTE = ["ETA", "ARRIV", "DEPART", "ETD", "FUEL", "BUNKERING", "WATER", "TOUCH", "DELAY", "PROVISION", "LOAD", "WIRE",
        "RETURNS", "EMERGENCY", "PUMP"]


def _kw(words):
    return re.compile(r"\b(?:%s)" % "|".join(re.escape(w) for w in words), re.I)


CLOSURE_RE, EVENT_RE, NOTE_RE = _kw(CLOSURE), _kw(EVENT), _kw(NOTE)
WEEKDAY_LETTERS = {"M", "T", "W", "TR", "F", "S", "SU", "SA", "TH"}


def classify(text: str) -> str:
    """→ 'vessel' | 'closure' | 'event' | 'note' | 'unknown'."""
    if VESSEL_RE.match(text):
        return "vessel"
    if CLOSURE_RE.search(text):
        return "closure"
    if EVENT_RE.search(text):
        return "event"
    if NOTE_RE.search(text):
        return "note"
    return "unknown"


def clean(text: str) -> str:
    """Trim and collapse whitespace."""
    return re.sub(r"\s+", " ", str(text)).strip()


def vessel_key(name: str) -> str:
    """Identity for matching: case- and spacing-insensitive, OS/V ≡ OSV."""
    return clean(name).upper().replace("OS/V ", "OSV ")


def vessel_display(name: str) -> str:
    """'R/V HIGH DRIFT' → 'R/V High Drift'; the hull prefix stays upper-case."""
    s = clean(name).replace("OS/V ", "OSV ").replace("os/v ", "OSV ")
    prefix, _, rest = s.partition(" ")
    prefix = prefix.upper() if "/" in prefix or prefix.upper() in ("OSV",) else prefix.title()
    return f"{prefix} {rest.title()}" if rest else prefix


def num(s):
    f = float(s)
    return int(f) if f.is_integer() else f
