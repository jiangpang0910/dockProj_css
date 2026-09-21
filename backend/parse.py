"""Prototype parser for the legacy dock-schedule workbook (grid -> flat entries).

Reference for the TypeScript importer: one sheet per year, month blocks, berth rows,
day columns; multi-day stays are merged cells. Known quirks it handles:
  - only day 1 is numbered in old sheets (other days inferred from column offset)
  - month-header years can be wrong (2010 sheet has "NOVEMBER 2018") -> inferred by sequence
  - unlabeled overflow rows -> entries with berth=None
Run:  python3 backend/parse.py [path/to/workbook.xlsx]
"""
import openpyxl, re, datetime, collections, sys
from pathlib import Path
from openpyxl.utils import get_column_letter as L

_DEFAULT = Path(__file__).resolve().parent.parent / "sample_data" / "Dock Schedule - Synthetic Sample.xlsx"
PATH = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith(".xlsx") else str(_DEFAULT)
MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"]
MRE = re.compile(r"^\s*(%s)\b\s*(\d{4})?\s*$" % "|".join(MONTHS), re.I)
BERTH_RE = re.compile(r"^(.*?)\s+-\s+(\d+)'\s*$")

def norm(s):
    return re.sub(r"\s+", " ", str(s).strip()).upper()

def parse():
    wb = openpyxl.load_workbook(PATH)
    entries = []      # dict per cell-group
    labels = collections.Counter()
    stray = []
    blocks_meta = []
    for ws in wb.worksheets:
        if not ws.title.isdigit(): continue
        sy = int(ws.title)
        merged = {}
        covered = set()
        for r in ws.merged_cells.ranges:
            merged[(r.min_row, r.min_col)] = r
            for rr in range(r.min_row, r.max_row+1):
                for cc in range(r.min_col, r.max_col+1):
                    covered.add((rr,cc))
        # find month header rows
        heads = []
        for r in range(1, ws.max_row+1):
            v = ws.cell(r,1).value
            if isinstance(v,str):
                m = MRE.match(v)
                if m: heads.append((r, MONTHS.index(m.group(1).upper())+1, int(m.group(2)) if m.group(2) else None))
        prev = None
        for i,(hr, mon, ly) in enumerate(heads):
            end = heads[i+1][0]-1 if i+1 < len(heads) else ws.max_row
            # year inference
            if prev is None:
                y = ly if (ly and abs(ly-sy)<=1) else sy
            else:
                y = prev[0] + (1 if mon < prev[1] else 0)
            prev = (y, mon)
            # day-number row: among hr..hr+2 the row with most ints
            best=None
            for rr in range(hr, min(hr+3,end)+1):
                daycols = {c:ws.cell(rr,c).value for c in range(2, ws.max_column+1) if isinstance(ws.cell(rr,c).value,int) and 1<=ws.cell(rr,c).value<=31}
                if best is None or len(daycols)>len(best[1]): best=(rr,daycols)
            drow, daycols = best
            import calendar
            c1 = min((c for c,d in daycols.items() if d==1), default=None)
            if c1 is None: c1 = min(daycols) if daycols else 2
            try: ndays = calendar.monthrange(y, mon)[1]
            except Exception: ndays = 31
            col2day = {c1+k: k+1 for k in range(ndays)}
            # keep numeric cross-check
            numdisagree = sum(1 for c,d in daycols.items() if col2day.get(c)!=d)
            # weekday check
            wk = {'M':0,'T':1,'W':2,'TR':3,'F':4,'S':5}
            mism = 0
            for rr in range(hr, min(hr+3,end)+1):
                for c,d in col2day.items():
                    w = ws.cell(rr,c).value
                    if isinstance(w,str) and w.strip().upper() in ('M','T','W','TR','F','S'):
                        try:
                            wd = datetime.date(y,mon,d).weekday()
                        except ValueError:
                            mism += 1; continue
                        if w.strip().upper()=='S':
                            ok = wd in (5,6)
                        else:
                            ok = wd == wk[w.strip().upper()]
                        if not ok: mism += 1
            blocks_meta.append((ws.title, hr, mon, ly, y, len(col2day), mism, numdisagree))
            for r in range(hr, end+1):
                a = ws.cell(r,1).value
                lab = norm(a) if isinstance(a,str) else None
                for c in range(2, ws.max_column+1):
                    v = ws.cell(r,c).value
                    if v is None or (r,c) in covered and (r,c) not in merged: continue
                    if r <= drow: continue
                    if isinstance(v,(int,float)): continue
                    if isinstance(v,str) and v.strip().upper() in ('M','T','W','TR','F','S'): continue
                    rng = merged.get((r,c))
                    c0, c1 = (rng.min_col, rng.max_col) if rng else (c,c)
                    days = [col2day[cc] for cc in range(c0,c1+1) if cc in col2day]
                    if not days:
                        stray.append((ws.title,r,L(c),v,'no-day-col')); continue
                    entries.append(dict(sheet=ws.title, row=r, col=c, berth=lab, name=str(v), year=y, month=mon,
                                        d0=min(days), d1=max(days), merged=bool(rng)))
            for r in range(drow+1, end+1):
                a = ws.cell(r,1).value
                if isinstance(a,str): labels[norm(a)] += 1
    return entries, labels, stray, blocks_meta

if __name__ == "__main__":
    entries, labels, stray, meta = parse()
    print("entries:", len(entries), " stray:", len(stray))
    print("row labels:", labels.most_common())
    print("stray sample:", stray[:10])
    bad = [m for m in meta if m[6] or m[4]!=(m[3] or m[4])]
    print("blocks:", len(meta), " blocks w/ weekday mismatch or label-year!=inferred:", len(bad))
    for m in bad[:25]: print("  ", m)
    names = collections.Counter(norm(e['name']) for e in entries)
    print("distinct names:", len(names))
    for n,c in sorted(names.items(), key=lambda x:-x[1]): print(f"{c:5d} {n}")
