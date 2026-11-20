#!/usr/bin/env bash
# usage: ./profile.sh <in.ts> [rounds=7]
# Serial only — run nothing else heavy meanwhile. Writes everything under ./results/.
set -u
IN=$(readlink -f "$1"); ROUNDS=${2:-7}; V="ee11fdf aa02d65 cand"
cd "$(dirname "$0")"; rm -rf results; mkdir -p results; R=$PWD/results
{ date -Is; go version; uname -a; echo "nproc $(nproc)"; cat /proc/loadavg
  echo "THP $(cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null)"; echo "THP defrag $(cat /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null)"
  echo "GOGC=${GOGC:-} GOMAXPROCS=${GOMAXPROCS:-} GODEBUG=${GODEBUG:-}"; sha256sum "$IN"; } > $R/env.txt
for v in $V; do (cd $v/bench && go build -o gb .) && (cd $v/prof && go build -o prof .) || { echo "build failed: $v"; exit 1; }; done

echo "== 1. original harness, $ROUNDS alternating serial rounds" | tee $R/summary.txt
for r in $(seq 1 $ROUNDS); do for v in $V; do echo "$r $v $(./$v/bench/gb "$IN")"; done; done | tee $R/bench.log | tee -a $R/summary.txt

echo "== 2. NewDoc-only, 300 iterations: allocation, GC cycles, heap released to the OS" | tee -a $R/summary.txt
for v in $V; do echo "$v $(./$v/prof/prof -n 300 "$IN")"; done | tee -a $R/summary.txt

echo "== 3. GC attribution: GOGC=off (40 iterations; needs ~1.2 GB RAM)" | tee -a $R/summary.txt
for v in $V; do echo "$v $(GOGC=off ./$v/prof/prof -n 40 "$IN")"; done | tee -a $R/summary.txt

echo "== 4. returned-memory attribution: GODEBUG=madvdontneed=0 (MADV_FREE instead of MADV_DONTNEED)" | tee -a $R/summary.txt
for v in $V; do echo "$v $(GODEBUG=madvdontneed=0 ./$v/prof/prof -n 300 "$IN")"; done | tee -a $R/summary.txt

echo "== 5. GC cycles per 300 NewDoc (gctrace line count)" | tee -a $R/summary.txt
for v in $V; do GODEBUG=gctrace=1 ./$v/prof/prof -n 300 "$IN" 2> $R/gctrace-$v.log >/dev/null; echo "$v gc_lines $(grep -c '^gc ' $R/gctrace-$v.log)"; done | tee -a $R/summary.txt

echo "== 6. page faults / task clock (perf stat, else /usr/bin/time -v)" | tee -a $R/summary.txt
for v in $V; do
  if command -v perf >/dev/null && perf stat -e task-clock true 2>/dev/null; then
    perf stat -e task-clock,page-faults,minor-faults,major-faults,context-switches -o $R/perf-$v.txt ./$v/prof/prof -n 300 "$IN" >/dev/null
    echo "$v"; grep -E 'task-clock|faults|context' $R/perf-$v.txt
  elif [ -x /usr/bin/time ]; then
    /usr/bin/time -v ./$v/prof/prof -n 300 "$IN" 2> $R/time-$v.txt >/dev/null
    echo "$v $(grep -E 'Minor|Major|Maximum resident|Elapsed' $R/time-$v.txt | tr -s ' \t' ' ' | tr '\n' ';')"
  else echo "$v (no perf, no /usr/bin/time)"; fi
done | tee -a $R/summary.txt

echo "== 7. CPU profile, 300 NewDoc (top 35 by flat, then by cum)" | tee -a $R/summary.txt
for v in $V; do
  ./$v/prof/prof -n 300 -cpuprofile $R/cpu-$v.pprof "$IN" >/dev/null
  { echo "### $v flat"; go tool pprof -top -nodecount=35 $v/prof/prof $R/cpu-$v.pprof 2>/dev/null
    echo "### $v cum"; go tool pprof -top -cum -nodecount=35 $v/prof/prof $R/cpu-$v.pprof 2>/dev/null; } > $R/cpu-$v.txt
  cp $v/prof/prof $R/prof-$v.bin
done
echo "(cpu-*.txt / cpu-*.pprof / prof-*.bin in results/)" | tee -a $R/summary.txt

echo "== 8. alloc profile, 300 NewDoc (alloc_space top 15)" | tee -a $R/summary.txt
for v in $V; do ./$v/prof/prof -n 300 -memprofile $R/mem-$v.pprof "$IN" >/dev/null
  go tool pprof -sample_index=alloc_space -top -nodecount=15 $v/prof/prof $R/mem-$v.pprof 2>/dev/null > $R/mem-$v.txt; done
tar czf results.tgz results && echo "done: $(pwd)/results.tgz"
