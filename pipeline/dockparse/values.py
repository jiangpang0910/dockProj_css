"""Cell values → clean data: dates in any common spelling, date ranges, feet, and names that carry a length.

Pure functions, no I/O. Every function answers None (never a guess) when the value can't be read; the caller
decides whether that is an issue. Day/month order for numeric dates ("03/05/2015") is decided per COLUMN by
date_orders(): one value with a day above 12 settles it for the whole column, which is how a person reads a sheet.
"""
import datetime as dt
import re

from .classify import clean, num

FOOT = r"(?:ft\.?|feet|foot|['’′])"
_LEN_TAIL = re.compile(rf"[\s,]*[\(\[]?\s*(?:LOA[:\s]*)?(\d+(?:\.\d+)?)\s*{FOOT}\s*[\)\]]?\s*$", re.I)
_LOA_PAREN = re.compile(r"[\s,]*[\(\[]\s*LOA[:\s]*(\d+(?:\.\d+)?)\s*(?:ft\.?|feet|['’′])?\s*[\)\]]\s*$", re.I)
_BARE_TAIL = re.compile(r"^(?P<name>\S.*\s\S*[^\d\s])\s+(?P<n>\d{2,3})$")  # "North Bridge Speedster 46": ≥ 2 words
_FEET = re.compile(rf"^\s*(\d+(?:\.\d+)?)\s*{FOOT}?\s*$", re.I)

MONTHS = {m: i for i, names in enumerate(
    [("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",), ("jun", "june"),
     ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"),
     ("dec", "december")], start=1) for m in names}
_ISO = re.compile(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$")
_NUM = re.compile(r"^(\d{1,2})([/\-.])(\d{1,2})\2(\d{2}|\d{4})$")
_DAY_MON = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?[\s\-./]*([A-Za-z]{3,9})\.?[\s\-,./]*(\d{2}|\d{4})?$")
_MON_DAY = re.compile(r"^([A-Za-z]{3,9})\.?[\s\-./]*(\d{1,2})(?:st|nd|rd|th)?[\s,./]*(\d{2}|\d{4})?$")
_DAY_ONLY = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?$")
_DAY_YEAR = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$")
_RANGE_SEPS = [" to ", " through ", " thru ", " until ", " – ", " — ", " - ", "–", "—", "-", "→", "/"]
EXCEL_EPOCH = dt.date(1899, 12, 30)


def _year(y):
    y = int(y)
    return y if y >= 100 else 2000 + y if y < 70 else 1900 + y


def date_parts(text, order="MDY"):
    """'3 Mar 2016' → (2016, 3, 3); '3 Mar' → (None, 3, 3); '3' → (None, None, 3) [only useful inside a range].
    Numeric triples follow `order` ("DMY" | "MDY"). None when it isn't a date."""
    s = clean(text)
    if (m := _ISO.match(s)):
        return _year(m[1]), int(m[2]), int(m[3])
    if (m := _NUM.match(s)):
        a, b = int(m[1]), int(m[3])
        d, mo = (a, b) if order == "DMY" else (b, a)
        return _year(m[4]), mo, d
    if (m := _DAY_MON.match(s)) and m[2].lower() in MONTHS:
        return (_year(m[3]) if m[3] else None), MONTHS[m[2].lower()], int(m[1])
    if (m := _MON_DAY.match(s)) and m[1].lower() in MONTHS:
        return (_year(m[3]) if m[3] else None), MONTHS[m[1].lower()], int(m[2])
    if (m := _DAY_YEAR.match(s)):
        return _year(m[2]), None, int(m[1])
    if (m := _DAY_ONLY.match(s)):
        return None, None, int(m[1])
    return None


def _valid(y, mo, d):
    try:
        return dt.date(y, mo, d)
    except (TypeError, ValueError):
        return None


def parse_date(v, order="MDY"):
    """Any cell → datetime.date, or None. Excel date cells, Excel serial numbers, and text in the common spellings."""
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return EXCEL_EPOCH + dt.timedelta(days=int(v)) if 20000 <= v <= 80000 else None
    if not isinstance(v, str):
        return None
    p = date_parts(v, order)
    return _valid(*p) if p and p[0] and p[1] else None


def parse_range(v, order="MDY"):
    """'3 Mar - 7 Mar 2016', '3–7 Mar 2016', 'Mar 3-7, 2016', '2016-03-03 to 2016-03-07' → (start, end), or None.
    A side missing its month or year borrows from the other side; '28 Dec - 2 Jan 2017' starts in 2016."""
    if not isinstance(v, str):
        return None
    s = clean(v)
    for sep in _RANGE_SEPS:
        i = s.find(sep)
        while i > 0:
            left, right = date_parts(s[:i], order), date_parts(s[i + len(sep):], order)
            if left and right:
                ly, lm, ld = left
                ry, rm, rd = right
                lm, rm = lm or rm, rm or lm
                ly, ry = ly or ry, ry or ly
                a, b = _valid(ly, lm, ld), _valid(ry, rm, rd)
                if a and b:
                    if a > b and left[0] is None:
                        a = _valid(ly - 1, lm, ld) or a
                    if a <= b:
                        return a, b
            i = s.find(sep, i + 1)
    return None


def date_orders(values):
    """For a column: {separator: "DMY" | "MDY" | None} decided by evidence in the numeric dates that use that
    separator. None = nothing in the column settles it (the caller may default and say so)."""
    seen: dict = {}
    for v in values:
        if isinstance(v, str) and (m := _NUM.match(clean(v))):
            a, b = int(m[1]), int(m[3])
            cur = seen.setdefault(m[2], None)
            if a > 12 and cur is None:
                seen[m[2]] = "DMY"
            elif b > 12 and cur is None:
                seen[m[2]] = "MDY"
    return seen


def order_for(v, orders, default="MDY"):
    """The day/month order to read one cell with, from the column's evidence."""
    if isinstance(v, str) and (m := _NUM.match(clean(v))):
        return orders.get(m[2]) or default
    return default


def feet(v):
    """46, 46.5, '46 ft', "46'", '410' → number; else None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return num(v) if v > 0 else None
    if isinstance(v, str) and (m := _FEET.match(v)) and float(m[1]) > 0:
        return num(m[1])
    return None


def split_name_length(text, bare_ok=False):
    """'North Bridge Speedster 46\\'' → ('North Bridge Speedster', 46, False). Reads every trailing length
    ("85'", "(85 ft)", "(LOA 92)"); when several disagree the LARGER wins, as in the registry.
    A bare trailing number ("... 46") is a length only when bare_ok (the column is known to carry lengths);
    otherwise it stays in the name and the third value says the cell was ambiguous."""
    s, length, ambiguous = clean(text), None, False
    while True:
        m = _LOA_PAREN.search(s) or _LEN_TAIL.search(s)
        if not m or m.start() == 0:
            break
        length = max(length or 0, num(m[1]))
        s = s[:m.start()].rstrip(" ,-(")
    if (m := _BARE_TAIL.match(s)) and int(m["n"]) >= 10:
        if bare_ok or length is not None:
            length = max(length or 0, int(m["n"]))
            s = m["name"]
        else:
            ambiguous = True
    return s, length, ambiguous


def berth_label(text):
    """'NORTH PIER WEST (410 ft)' / "North Pier West - 410'" → ('North Pier West', 410). Sections keep None."""
    name, length, _ = split_name_length(text)
    name = name.rstrip(" -–:")
    if name.isupper():
        name = name.title()
    return name, length
