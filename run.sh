#!/usr/bin/env bash
# usage: ./run.sh <in.ts> [rounds=7]   — serial; run nothing else heavy meanwhile.
# base = master 02d8827, fam = cursor/relex-scanmeta-family-016d (generated relex family).
set -eu
IN=$(readlink -f "$1"); R=${2:-7}; cd "$(dirname "$0")"; W=$PWD/build; rm -rf $W results; mkdir -p $W results
{ date -Is; go version; rustc --version || true; node --version || true; uname -a; nproc; cat /proc/loadavg; sha256sum "$IN"; } > results/env.txt
for v in base fam; do
  for h in bench prof edit; do
    d=$W/$v/$h; mkdir -p $d/parser; cp $v/parser.go $d/parser/; cp main-$h.go $d/main.go
    printf 'module bench\n\ngo 1.22\n' > $d/go.mod; (cd $d && go build -o run .)
  done
  if command -v rustc >/dev/null; then rustc -O -A warnings $v/bench.rs -o $W/$v/rust; fi
done
for r in $(seq 1 $R); do for v in base fam; do
  echo "$r $v gobench $($W/$v/bench/run $IN)"
  echo "$r $v goprof  $($W/$v/prof/run -n 300 $IN)"
  echo "$r $v goedit  $($W/$v/edit/run $IN)"
  [ -x $W/$v/rust ] && echo "$r $v rust    $($W/$v/rust $IN)"
  command -v node >/dev/null && echo "$r $v ts      $(node tsbench.ts $PWD/$v/parser.ts $IN 2>/dev/null)"
done; done | tee results/results.log
tar czf results.tgz results && echo "done: $PWD/results.tgz"
