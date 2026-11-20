#!/usr/bin/env bash
# usage: ./run.sh <in.ts> [rounds=7]   — serial; run nothing else heavy meanwhile.
# Variants (see VARIANTS): base = master cbb58a0, prev = PR78 ecd5e4c, fix = PR78 52a8f9c.
set -eu
IN=$(readlink -f "$1"); R=${2:-7}; cd "$(dirname "$0")"; W=$PWD/build; rm -rf $W results; mkdir -p $W results
TOK2=$PWD/tok2mb.ts
VS=$(cut -d' ' -f1 VARIANTS | tr '\n' ' ')
sha() { sha256sum "$@" 2>/dev/null || shasum -a 256 "$@"; }
{ date -Is 2>/dev/null || date; go version; rustc --version || true; node --version || true; uname -a; nproc 2>/dev/null || sysctl -n hw.ncpu; cat /proc/loadavg 2>/dev/null || true; sha "$IN" "$TOK2"
  ldd --version 2>&1 | head -1 || true; cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true; } > results/env.txt
for v in $VS; do
  for h in bench prof edit tok; do
    d=$W/$v/$h; mkdir -p $d/parser; cp $v/parser.go $d/parser/; cp main-$h.go $d/main.go
    printf 'module bench\n\ngo 1.22\n' > $d/go.mod; (cd $d && go build -o run .)
  done
  if command -v rustc >/dev/null; then
    rustc -O -A warnings $v/bench.rs -o $W/$v/rust
    rustc -O -A warnings $v/tok.rs -o $W/$v/rust-tok
    { sed '/^fn med(/,$d' $v/bench.rs; cat alloc-tail.rs; } > $W/$v/alloc.rs && rustc -O -A warnings $W/$v/alloc.rs -o $W/$v/rust-alloc
  fi
done
for r in $(seq 1 $R); do for v in $VS; do
  echo "$r $v gobench $($W/$v/bench/run $IN)"
  echo "$r $v goprof  $($W/$v/prof/run -n 300 $IN)"
  echo "$r $v goedit  $($W/$v/edit/run $IN)"
  echo "$r $v gotok   in.ts $($W/$v/tok/run $IN)"
  echo "$r $v gotok   2mb   $($W/$v/tok/run $TOK2)"
  if [ -x $W/$v/rust ]; then
    echo "$r $v rust    $($W/$v/rust $IN)"
    echo "$r $v rstok   in.ts $($W/$v/rust-tok $IN)"
    echo "$r $v rstok   2mb   $($W/$v/rust-tok $TOK2)"
  fi
  if command -v node >/dev/null; then
    echo "$r $v ts      $(node tsbench.ts $PWD/$v/parser.ts $IN 2>/dev/null)"
    echo "$r $v tstok   in.ts $(node tstok.ts $PWD/$v/parser.ts $IN 2>/dev/null)"
    echo "$r $v tstok   2mb   $(node tstok.ts $PWD/$v/parser.ts $TOK2 2>/dev/null)"
  fi
done; done | tee results/results.log
# Diagnostics only (not timing rows): Rust Doc::new allocator calls, plus process faults when GNU time exists.
for v in $VS; do [ -x $W/$v/rust-alloc ] || continue
  if [ -x /usr/bin/time ] && /usr/bin/time -f x true 2>/dev/null; then /usr/bin/time -f "$v faults: minor %R major %F maxrss %MKB" $W/$v/rust-alloc $IN 2>&1 | sed "s/^Doc/$v Doc/"
  else echo "$v $($W/$v/rust-alloc $IN)"; fi
done | tee results/rust-alloc.log
tar czf results.tgz results && echo "done: $PWD/results.tgz"
