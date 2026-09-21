"""Sizing + data-quality stats over the sample workbook. Reuses backend/parse.py.
Run:  python3 data_analysis/stats.py
"""
import sys, re, collections, statistics, datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import parse, openpyxl
entries, labels, stray, meta = parse.parse()

# --- dedupe carried-over December blocks at head of sheets 2002-2004
def key(e): return (e['berth'], parse.norm(e['name']), e['year'], e['month'], e['d0'], e['d1'])
first_dec = {}
for m in meta:
    if m[0] in ("2002","2003","2004") and m[2]==12 and m[1] < 10:
        first_dec[m[0]] = (m[4])  # year assigned
dup_report = {}
keep = []
head_dec_rows = {}  # sheet -> set of rows in head Dec block
for sh in ("2002","2003","2004"):
    rows = [m for m in meta if m[0]==sh]
    head = rows[0]; nxt = rows[1]
    head_dec_rows[sh] = (head[1], nxt[1]-1)
head_entries = collections.defaultdict(set); tail_entries = collections.defaultdict(set)
for e in entries:
    sh=e['sheet']
    if sh in head_dec_rows and head_dec_rows[sh][0] <= e['row'] <= head_dec_rows[sh][1] and e['month']==12 and e['row']<head_dec_rows[sh][1]+1:
        head_entries[(e['year'])].add(key(e)); continue
    if e['month']==12 and e['year'] in (2001,2002,2003): tail_entries[e['year']].add(key(e))
    keep.append(e)
for y in (2001,2002,2003):
    h,t = head_entries[y], tail_entries[y]
    print(f"carry-over Dec {y}: head-copy {len(h)} entries, tail-original {len(t)} entries, only-in-head {len(h-t)}, only-in-tail {len(t-h)}")
entries = keep

# --- classification
VESSEL = re.compile(r"^(R/V|M/V|M/Y|S/V|S/Y|F/V|OSV|TUG|BARGE|BUNKER BARGE)\b", re.I)
CLOSURE = re.compile(r"MAINTENANCE|REBUILD|REPAIR|WORK|CLOSED|NO DOCKING|TEST|PAVING|INSPECTION|RESTRICTED|CRANE|UTILITY|BOLLARD|NO USAGE", re.I)
EVENT   = re.compile(r"COMMUNITY|CAMPUS|HOLIDAY|ROAD RACE|TOUR|OPEN HOUSE|STROLL|RECEPTION|DRILL|TRAINING|FILM|SAIL DAY", re.I)
NOTE    = re.compile(r"^ETA|ARRIV|DEPART|^ETD|FUEL|BUNKERING|WATER|TOUCH AND GO|DELAY|PROVISION|LOAD|WIRE|RETURNS|EMERGENCY|PUMP", re.I)
def cls(n):
    n=n.strip()
    if VESSEL.match(n): return "vessel"
    if CLOSURE.search(n): return "closure/maint"
    if EVENT.search(n): return "event"
    if NOTE.search(n): return "ops-note"
    return "other"
for e in entries:
    e['nn']=parse.norm(e['name']); e['cls']=cls(e['name'])
    e['start']=datetime.date(e['year'],e['month'],e['d0']); e['end']=datetime.date(e['year'],e['month'],e['d1'])

cnt=collections.Counter(e['cls'] for e in entries)
print("\nentry classes (cell-groups):", dict(cnt))
print("unclassified 'other':", sorted({e['nn'] for e in entries if e['cls']=='other'}))
for c in ("closure/maint","event","ops-note"):
    names=collections.Counter(e['nn'] for e in entries if e['cls']==c)
    print(f"\n{c}: {len(names)} distinct, {sum(names.values())} entries"); print("  ", dict(names.most_common(40)))

# --- vessels
vessels = collections.Counter(e['nn'] for e in entries if e['cls']=='vessel')
print("\nDISTINCT VESSELS (case-normalised):", len(vessels))
# same name w/ different prefix?
core=collections.defaultdict(set)
for v in vessels:
    core[re.sub(VESSEL, "", v).strip()].add(v)
print("core names appearing under >1 prefix:", {k:v for k,v in core.items() if len(v)>1})
print("vessels seen only once:", sum(1 for c in vessels.values() if c==1))
print("top 8 vessels by entries:", vessels.most_common(8))

# --- berths
b=collections.Counter(e['berth'] for e in entries)
print("\nentries per berth label:", b.most_common())

# --- coalesce into stays
by = collections.defaultdict(list)
for e in entries: by[(e['berth'], e['nn'])].append(e)
stays=[]
for k,lst in by.items():
    lst.sort(key=lambda e:e['start'])
    cur=None
    for e in lst:
        if cur and e['start'] <= cur['end'] + datetime.timedelta(days=1):
            cur['end']=max(cur['end'],e['end'])
        else:
            if cur: stays.append(cur)
            cur=dict(berth=k[0], nn=k[1], cls=e['cls'], start=e['start'], end=e['end'])
    stays.append(cur)
print("\nentries:", len(entries), "-> stays after coalescing adjacent same berth+name:", len(stays))

# months covered per year
months=collections.defaultdict(set)
for m in meta: months[m[4]].add(m[2])
partial={y for y,ms in months.items() if len(ms)<12}
print("years with <12 month blocks:", {y:sorted(months[y]) for y in partial})

def table(label, sel):
    per=collections.Counter(s['start'].year for s in stays if sel(s))
    yrs=sorted(y for y in months)
    full=[y for y in yrs if y not in partial]
    vals=[per.get(y,0) for y in full]
    print(f"\n== {label}: per-year stays (full years {full[0]}-{full[-1]}, n={len(full)})")
    print("   total", sum(per.values()), "| mean %.1f | median %s | min %s (%s) | max %s (%s)" % (
        statistics.mean(vals), statistics.median(vals),
        min(vals), [y for y in full if per.get(y,0)==min(vals)], max(vals), [y for y in full if per.get(y,0)==max(vals)]))
    top=sorted(full,key=lambda y:-per.get(y,0))[:3]; bot=sorted(full,key=lambda y:per.get(y,0))[:3]
    print("   top3:", [(y,per[y]) for y in top], " bottom3:", [(y,per.get(y,0)) for y in bot])
    return per
allper = table("ALL stays", lambda s: True)
vper = table("VESSEL stays", lambda s: s['cls']=='vessel')
eper = table("NON-VESSEL stays (events+closures+notes+other)", lambda s: s['cls']!='vessel')

print("\nyear : all / vessel / non-vessel / cumulative(all)")
cum=0
for y in sorted(months):
    cum+=allper.get(y,0)
    print(f"{y}{'*' if y in partial else ' '}: {allper.get(y,0):4d} / {vper.get(y,0):4d} / {eper.get(y,0):4d} / {cum:5d}")

# distinct vessels per year, berth-days per year
print("\nbusiest months (all stays starting): ")
pm=collections.Counter((s['start'].year,s['start'].month) for s in stays)
print("  top5:", pm.most_common(5), " median month:", statistics.median(pm.values()))

# stay length distribution
lens=[(s['end']-s['start']).days+1 for s in stays if s['cls']=='vessel']
lens.sort()
print("\nvessel stay length days: median", statistics.median(lens), "p90", lens[int(.9*len(lens))], "max", lens[-1])

# preliminary overlaps (vessel vs vessel same berth)
ov=0; ex=[]
byb=collections.defaultdict(list)
for s in stays:
    if s['cls']=='vessel' and s['berth']: byb[s['berth']].append(s)
for b_,lst in byb.items():
    lst.sort(key=lambda s:s['start'])
    for i in range(len(lst)):
        for j in range(i+1,len(lst)):
            if lst[j]['start']>lst[i]['end']: break
            if lst[j]['nn']!=lst[i]['nn']: ov+=1; ex.append((b_,lst[i]['nn'],lst[i]['start'],lst[i]['end'],lst[j]['nn'],lst[j]['start'],lst[j]['end']))
print("\nPRELIM vessel-vs-vessel same-berth overlapping stays:", ov)
for x in ex[:6]: print("  ",x)
orph=[s for s in stays if s['berth'] is None]
print("stays with no berth label:", len(orph), " (vessel:", sum(1 for s in orph if s['cls']=='vessel'),")")

# --- registry tabs
wb=openpyxl.load_workbook(parse.PATH, data_only=True)
reg=collections.defaultdict(set)
for tab in ("Science","Yachts"):
    for row in wb[tab].iter_rows(values_only=True):
        for v in row:
            if isinstance(v,str):
                m=re.match(r"^(.+?)\s+(\d+)'\s*$", v.strip())
                if m and VESSEL.match(m.group(1)): reg[tab].add((parse.norm(m.group(1)), int(m.group(2))))
sched = set(vessels)
for tab,s in reg.items():
    names={n for n,_ in s}
    print(f"\nregistry tab {tab}: {len(s)} vessel+length rows, {len(names)} distinct names; on schedule: {len(names & sched)}")
allreg={n for s in reg.values() for n,_ in s}
print("vessels on schedule with a registry length:", len(sched & allreg), "of", len(sched))
lens_by=collections.defaultdict(set)
for s in reg.values():
    for n,l in s: lens_by[n].add(l)
print("registry names with conflicting lengths:", sum(1 for v in lens_by.values() if len(v)>1))
