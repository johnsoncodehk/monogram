#!/usr/bin/env bash
# Diagnostic (not for master): ts parseWith of D and E under several node flag sets, alternating,
# fresh process per measurement (test/bench-targets/time.ts); then one traced run per variant.
# Env: DIAG_BASE, DIAG_COMMIT, DIAG_ROUNDS (7).
set -euo pipefail
REPO=$(pwd); H=$REPO/test/bench-targets; W=$RUNNER_TEMP/diag
ROUNDS=${DIAG_ROUNDS:-7}
rm -rf "$W"; mkdir -p "$W/inputs"
lscpu | grep -E '^(Model name|CPU\(s\))' || true; node --version
for kv in "D:$DIAG_BASE" "E:$DIAG_COMMIT"; do
  v=${kv%%:*}; c=$(git rev-parse "${kv#*:}^{commit}")
  echo "$v = $(git log -1 --format='%h %s' "$c")"
  git worktree add -q --detach "$W/src-$v" "$c"
  (cd "$W/src-$v" && npm ci --silent --no-audit --no-fund)
  node "$H/emit.ts" "$W/src-$v" "$W/out-$v" typescript
  wc -c "$W/out-$v/ts.mts"
done
cp "$REPO/node_modules/acorn/dist/acorn.js" "$W/inputs/acorn.js"
git show 2632c2c:src/gen-tm.ts > "$W/inputs/gen-tm.ts"
FLAGSETS=("none" "--no-allocation-site-pretenuring" "--max-lazy" "--no-lazy-feedback-allocation" "--single-threaded-gc")
flags() { [ "$1" = none ] && echo "" || echo "$1"; }
echo "=== timing"
for r in $(seq 1 "$ROUNDS"); do
  if [ $((r % 2)) = 1 ]; then ORDER="D E"; else ORDER="E D"; fi
  for f in acorn.js gen-tm.ts; do for fs in "${FLAGSETS[@]}"; do for v in $ORDER; do
    fl=$(flags "$fs")
    out=$(node $fl "$H/time.ts" "$W/out-$v/ts.mts" parseWith "$W/inputs/$f" 2>/dev/null) || out="FAIL 0"
    echo "ROW $r $v $fs $f ${out%% *}"
  done; done; done
done | tee "$W/rows.txt"
echo "=== medians (ms per parse)"
awk '{k=$4" "$5" "$3; a[k]=a[k]" "$6} END{for(k in a) print k, a[k]}' "$W/rows.txt" | sort | while read -r fs f v rest; do
  m=$(echo $rest | tr ' ' '\n' | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}')
  echo "$f $fs $v median=$m all=[$rest]"
done
echo "=== traces (acorn.js, one timed process each)"
for v in D E; do
  node --trace-deopt "$H/time.ts" "$W/out-$v/ts.mts" parseWith "$W/inputs/acorn.js" > "$W/deopt-$v.txt" 2>&1 || true
  echo "$v deopts: $(grep -c 'bailout\|deoptimiz' "$W/deopt-$v.txt" || true) tenuring: $(grep -c 'tenuring' "$W/deopt-$v.txt" || true)"
  grep -o 'reason: [^)]*' "$W/deopt-$v.txt" | sort | uniq -c | sort -rn | head -12 | sed "s/^/  $v /"
  node --trace-pretenuring "$H/time.ts" "$W/out-$v/ts.mts" parseWith "$W/inputs/acorn.js" > "$W/pret-$v.txt" 2>&1 || true
  echo "$v pretenuring lines: $(wc -l < "$W/pret-$v.txt")"; grep -v '^[0-9.]* [0-9]*$' "$W/pret-$v.txt" | sed 's/0x[0-9a-f]*/A/g' | sort | uniq -c | sort -rn | head -15 | sed "s/^/  $v /"
  node --trace-gc "$H/time.ts" "$W/out-$v/ts.mts" parseWith "$W/inputs/acorn.js" > "$W/gc-$v.txt" 2>&1 || true
  echo "$v gc: scavenge $(grep -c Scavenge "$W/gc-$v.txt" || true) mark-compact $(grep -c 'Mark-Compact' "$W/gc-$v.txt" || true) minor-ms $(grep -c 'Minor Mark' "$W/gc-$v.txt" || true); last: $(tail -2 "$W/gc-$v.txt" | head -1)"
  node --trace-opt "$H/time.ts" "$W/out-$v/ts.mts" parseWith "$W/inputs/acorn.js" > "$W/opt-$v.txt" 2>&1 || true
  echo "$v optimizations completed: $(grep -c 'completed' "$W/opt-$v.txt" || true)"
done
tar -czf "$RUNNER_TEMP/diag-traces.tgz" -C "$W" deopt-D.txt deopt-E.txt pret-D.txt pret-E.txt gc-D.txt gc-E.txt opt-D.txt opt-E.txt rows.txt
