#!/usr/bin/env bash
# usage: ./run.sh <in.ts> [rounds=7]   — serial; run nothing else heavy meanwhile.
# Variants (see VARIANTS): base = master 02d8827, fam = PR78 ac70b67, fix = PR78 3c1a1ad.
set -eu
IN=$(readlink -f "$1"); R=${2:-7}; cd "$(dirname "$0")"; W=$PWD/build; rm -rf $W results; mkdir -p $W results
VS=$(cut -d' ' -f1 VARIANTS | tr '\n' ' ')
{ date -Is; go version; rustc --version || true; node --version || true; uname -a; nproc; cat /proc/loadavg; sha256sum "$IN"
  ldd --version 2>&1 | head -1 || true; cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true; } > results/env.txt
for v in $VS; do
  for h in bench prof edit; do
    d=$W/$v/$h; mkdir -p $d/parser; cp $v/parser.go $d/parser/; cp main-$h.go $d/main.go
    printf 'module bench\n\ngo 1.22\n' > $d/go.mod; (cd $d && go build -o run .)
  done
  if command -v rustc >/dev/null; then
    rustc -O -A warnings $v/bench.rs -o $W/$v/rust
    { sed '/^fn med(/,$d' $v/bench.rs; cat alloc-tail.rs; } > $W/$v/alloc.rs && rustc -O -A warnings $W/$v/alloc.rs -o $W/$v/rust-alloc
  fi
done
for r in $(seq 1 $R); do for v in $VS; do
  echo "$r $v gobench $($W/$v/bench/run $IN)"
  echo "$r $v goprof  $($W/$v/prof/run -n 300 $IN)"
  echo "$r $v goedit  $($W/$v/edit/run $IN)"
  [ -x $W/$v/rust ] && echo "$r $v rust    $($W/$v/rust $IN)"
  command -v node >/dev/null && echo "$r $v ts      $(node tsbench.ts $PWD/$v/parser.ts $IN 2>/dev/null)"
done; done | tee results/results.log
# Diagnostics only (not timing rows): Rust Doc::new allocator calls, plus process faults when GNU time exists.
for v in $VS; do [ -x $W/$v/rust-alloc ] || continue
  if [ -x /usr/bin/time ]; then /usr/bin/time -f "$v faults: minor %R major %F maxrss %MKB" $W/$v/rust-alloc $IN 2>&1 | sed "s/^Doc/$v Doc/"
  else echo "$v $($W/$v/rust-alloc $IN)"; fi
done | tee results/rust-alloc.log
tar czf results.tgz results && echo "done: $PWD/results.tgz"
