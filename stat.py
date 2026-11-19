import re,sys,statistics as st
d={}
for l in open(sys.argv[1] if len(sys.argv)>1 else 'results.log'):
  r,c,*_=l.split(); m=re.search(r'parseWith ([\d.]+) ms  newDoc ([\d.]+) ms  edit ([\d.]+) us  reused (\d+)',l)
  if not m: print('BAD',l.strip()); continue
  d.setdefault(c,[]).append(tuple(float(x) for x in m.groups()))
for c,v in d.items():
  f=lambda i:(st.median([x[i] for x in v]),min(x[i] for x in v),max(x[i] for x in v))
  print('%-10s n=%d'%(c,len(v)),'parseWith %.3f [%.3f-%.3f]'%f(0),' newDoc %.3f [%.3f-%.3f]'%f(1),' edit %.0f [%.0f-%.0f]us'%f(2),' reused',sorted(set(int(x[3]) for x in v)))
