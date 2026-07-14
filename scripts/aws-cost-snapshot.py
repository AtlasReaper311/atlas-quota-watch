#!/usr/bin/env python3
"""Collect read-only AWS billing and usage evidence into Atlas cost-guard snapshots.

Uses only the AWS CLI already authenticated on the machine. No SDK dependency,
no writes, no budget creation, and no notification side effects.
"""
from __future__ import annotations
import argparse, calendar, datetime as dt, json, subprocess, sys
from decimal import Decimal

SCHEMA="atlas-cost-guard/quota-snapshot/v1"; SET_SCHEMA="atlas-cost-guard/quota-snapshot-set/v1"

def aws(*args:str)->dict:
    p=subprocess.run(["aws",*args,"--output","json"],capture_output=True,text=True)
    if p.returncode: raise RuntimeError(p.stderr.strip() or "AWS CLI failed")
    return json.loads(p.stdout)

def utc(s:str)->str: return f"{s}T00:00:00Z"
def month_bounds(now:dt.datetime):
    start=now.date().replace(day=1); days=calendar.monthrange(start.year,start.month)[1]
    end=start.replace(day=days)+dt.timedelta(days=1); return start,end

def snapshot(service, quota, usage, limit, start, end, observed, source, confidence="high", contributors=None):
    row={"schema_version":SCHEMA,"service_id":service,"provider":"aws","quota_type":quota,
         "observed_at":observed,"period_start":utc(start.isoformat()),"period_end":utc(end.isoformat()),
         "usage":float(usage) if usage is not None else None,"quota_limit":float(limit) if limit is not None else None,
         "availability":"available" if usage is not None else "unavailable",
         "source":{"kind":"aws-cli","name":source,"collected_by":"AtlasReaper311/atlas-quota-watch"},
         "confidence":confidence,"classification":{"lifecycle":"production","scope":"internal","provenance":"original"}}
    if contributors: row["contributors"]=contributors[:10]
    return row

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--now'); ap.add_argument('--currency',default='USD'); ap.add_argument('--monthly-budget',type=Decimal,default=Decimal('0')); ap.add_argument('--out'); a=ap.parse_args()
    now=dt.datetime.fromisoformat(a.now.replace('Z','+00:00')) if a.now else dt.datetime.now(dt.timezone.utc)
    start,end=month_bounds(now); observed=now.astimezone(dt.timezone.utc).isoformat().replace('+00:00','Z')
    rows=[]
    ce=aws('ce','get-cost-and-usage','--time-period',f'Start={start},End={end}','--granularity','MONTHLY','--metrics','UnblendedCost','--group-by','Type=DIMENSION,Key=SERVICE')
    groups=ce.get('ResultsByTime',[{}])[0].get('Groups',[])
    total=Decimal('0'); contributors=[]
    for g in groups:
        amount=Decimal(g['Metrics']['UnblendedCost']['Amount']); total+=amount
        if amount>0: contributors.append({'id':g['Keys'][0].replace(' ','_')[:128], 'usage':float(amount)})
    contributors.sort(key=lambda x:x['usage'], reverse=True)
    rows.append(snapshot('aws-account','monthly-spend',total,a.monthly_budget,start,end,observed,'cost-explorer',contributors=contributors))
    forecast=None
    try:
        fc=aws('ce','get-cost-forecast','--time-period',f'Start={now.date()},End={end}','--metric','UNBLENDED_COST','--granularity','MONTHLY')
        forecast=Decimal(fc['Total']['Amount'])+total
    except Exception:
        pass
    rows.append(snapshot('aws-account','forecast-spend',forecast,a.monthly_budget,start,end,observed,'cost-explorer-forecast',confidence='medium' if forecast is not None else 'unknown'))
    doc={'schema_version':SET_SCHEMA,'evaluation_time':observed,'snapshots':rows}
    data=json.dumps(doc,indent=2)+"\n"
    Path=a.out
    if Path: open(Path,'w',encoding='utf-8').write(data)
    else: sys.stdout.write(data)
if __name__=='__main__':
    try: main()
    except Exception as e: print(f'aws-cost-snapshot: {e}',file=sys.stderr); raise SystemExit(1)
