#!/usr/bin/env bash
# Rust TypeScript parser throughput: monogram's emitted Rust parser at several commits vs oxc,
# same inputs, same machine, same job. Usage (from the repo root, full history fetched):
#   test/bench-rust-oxc/run.sh [rounds=9]
# Variants: A = cbb58a0 (master before the 2026-11-20 work), P = 0990a37 (#89's parent),
#           Q = 103b396 (#89, longest match), B = 2632c2c (master when this measurement was asked
#           for), D = origin/master at run time if it moved past B, C = oxc (test/oxc-parse-bench).
# BENCH_BASE=<commit> with BENCH_EXTRA=<commit>: only D = BENCH_BASE, E = BENCH_EXTRA and C (the
# on-demand workflow .github/workflows/measure-bench.yml uses this).
set -euo pipefail
ROUNDS=${1:-9}
REPO=$(pwd)
H=$REPO/test/bench-rust-oxc
W=${BENCH_WORK:-$REPO/../bench-work}
# The TypeScript sources checker.ts / parser.ts come from this commit; the workflows pass their one
# pin (ci.yml's TS_REPO_SHA), the default is the same commit.
TS_REPO_SHA=${TS_REPO_SHA:-6fbce89821d93a5b761581d9ac540455f38e9acb}
# The oxc crate builds into this target directory (cacheable; keyed on test/oxc-parse-bench/Cargo.lock).
OXC_TARGET=${OXC_TARGET_DIR:-$W/oxc-target}
rm -rf "$W"; mkdir -p "$W/inputs" "$W/logs"

git fetch -q origin master
B_SHA=$(git rev-parse 2632c2c)
D_SHA=$(git rev-parse "${BENCH_BASE:-origin/master}^{commit}")
VARIANTS="A:cbb58a0 P:0990a37 Q:103b396 B:$B_SHA"
[ "$D_SHA" != "$B_SHA" ] && VARIANTS="$VARIANTS D:$D_SHA"
# BENCH_EXTRA=<commit>: one more variant E (e.g. a pull request's head, to compare with D = master);
# BENCH_ONLY=1 then drops A/P/Q so the job is shorter.
# BENCH_GRAMMAR=<name>: the grammar file every variant emits (default typescript); with `javascript`
# only the inputs that grammar accepts (in B) are timed.
GRAMMAR=${BENCH_GRAMMAR:-typescript}
# BENCH_MODE=fresh|reuse (default fresh, so older numbers stay comparable): fresh = a new CstBuilder /
# Allocator per timed parse; reuse = one kept across parses (parse_with / Allocator::reset). The
# binaries read it from the environment.
export BENCH_MODE=${BENCH_MODE:-fresh}
case $BENCH_MODE in fresh|reuse) ;; *) echo "BENCH_MODE must be fresh or reuse, not $BENCH_MODE"; exit 1;; esac
if [ -n "${BENCH_EXTRA:-}" ]; then
  [ -n "${BENCH_ONLY:-}" ] && VARIANTS="B:$B_SHA D:$D_SHA"
  VARIANTS="$VARIANTS E:$(git rev-parse "$BENCH_EXTRA^{commit}")"
  [ -n "${BENCH_BASE:-}" ] && VARIANTS="D:$D_SHA E:$(git rev-parse "$BENCH_EXTRA^{commit}")"
elif [ -n "${BENCH_BASE:-}" ]; then
  echo "BENCH_BASE needs BENCH_EXTRA (the commit to compare with it)"; exit 1
fi

echo "=== environment"
lscpu | grep -E '^(Model name|Architecture|CPU\(s\)|Thread\(s\) per core|Core\(s\) per socket|Socket\(s\)|L2 cache|L3 cache|CPU max MHz)' || true
nproc; uname -a; cat /proc/loadavg
rustc -vV; cargo -V; node --version
echo "origin/master = $(git rev-parse origin/master)"
echo "D = $D_SHA"
echo "grammar = $GRAMMAR"
echo "mode = $BENCH_MODE"
for kv in $VARIANTS; do echo "${kv%%:*} = $(git log -1 --format='%h %ad %s' --date=iso "${kv#*:}")"; done

echo "=== emit monogram Rust parsers"
for kv in $VARIANTS; do
  v=${kv%%:*}; c=${kv#*:}
  git worktree add -q --detach "$W/src-$v" "$c"
  (cd "$W/src-$v" && npm ci --silent --no-audit --no-fund)
  node "$H/emit.ts" "$W/src-$v" "$W/parser-$v.rs" "$GRAMMAR"
  grep -n '^pub fn parse_with\|^pub struct CstBuilder' "$W/parser-$v.rs" | sed "s/^/$v: /"
  d=$W/mono-$v; mkdir -p "$d/src"
  sed "s/@NAME@/mono-bench-$v/" "$H/mono-Cargo.toml" > "$d/Cargo.toml"
  cat "$W/parser-$v.rs" "$H/bench-tail.rs" > "$d/src/main.rs"
  sha256sum "$W/parser-$v.rs"
done

echo "=== build (cargo --release; identical [profile.release] on every crate)"
cp -r "$REPO/test/oxc-parse-bench" "$W/oxc"; rm -rf "$W/oxc/target"
mkdir -p "$W/oxc/src/bin"; cp "$H/oxc-check.rs" "$W/oxc/src/bin/oxc-check.rs"
grep -A5 '^\[profile' "$W/oxc/Cargo.toml"
(cd "$W/oxc" && cargo build --release --locked -q --target-dir "$OXC_TARGET")
for kv in $VARIANTS; do
  v=${kv%%:*}
  (cd "$W/mono-$v" && RUSTFLAGS="-A warnings" cargo build --release -q)
done
echo "note: RUSTFLAGS='-A warnings' on the monogram crates only silences lints; it does not affect codegen."
declare -A BIN
for kv in $VARIANTS; do v=${kv%%:*}; BIN[$v]=$W/mono-$v/target/release/mono-bench-$v; done
BIN[C]=$OXC_TARGET/release/oxc-parse-bench

echo "=== inputs"
cp "$REPO/node_modules/tsc-oracle/lib/typescript.d.ts" "$W/inputs/typescript.d.ts"
cp "$REPO/node_modules/tsc-oracle/lib/typescript.js" "$W/inputs/typescript.js"
echo "typescript npm: $(node -p 'require("./node_modules/tsc-oracle/package.json").version')"
for f in checker.ts parser.ts; do
  curl -fsSL "https://raw.githubusercontent.com/microsoft/TypeScript/$TS_REPO_SHA/src/compiler/$f" -o "$W/inputs/$f"
done
# gen-tm.ts and typescript.ts as of 2632c2c (variant B), whichever variants run: fixed inputs.
git show 2632c2c:src/gen-tm.ts > "$W/inputs/gen-tm.ts"
git show 2632c2c:typescript.ts > "$W/inputs/typescript.ts"
node "$H/synth2mb.ts" "$W/inputs/synth2mb.ts"
node "$H/synth-nonascii.ts" "$W/inputs/nonascii.ts"
INPUTS="typescript.js checker.ts synth2mb.ts typescript.d.ts parser.ts gen-tm.ts typescript.ts nonascii.ts"
(cd "$W/inputs" && wc -c $INPUTS && sha256sum $INPUTS)

echo "=== acceptance (one untimed parse per input per parser)"
cd "$W/inputs"
"${BIN[C]%/*}/oxc-check" $INPUTS | tee "$W/logs/check-C.txt"
for kv in $VARIANTS; do v=${kv%%:*}
  for f in $INPUTS; do
    if out=$("${BIN[$v]}" --check "$f" 2>&1); then echo "$v $out"; else echo "$v CRASH $f: $(echo "$out" | tail -2)"; fi
  done | tee "$W/logs/check-$v.txt"
done
accepted() { grep -qF "ACCEPT $2 " "$W/logs/check-$1.txt"; }
# An input is timed when oxc and the reference variant (B, or D when B is not run) accept it.
case " $VARIANTS " in *" B:"*) REF=B;; *) REF=D;; esac

echo "=== timing: $ROUNDS rounds; within a round each input runs every parser back to back, order rotated per round"
ORDER=(C); for kv in $VARIANTS; do ORDER+=("${kv%%:*}"); done; NV=${#ORDER[@]}
for r in $(seq 1 "$ROUNDS"); do
  for f in $INPUTS; do
    accepted C "$f" && accepted "$REF" "$f" || continue
    for i in $(seq 0 $((NV - 1))); do
      v=${ORDER[$(( (i + r) % NV ))]}
      accepted "$v" "$f" || continue
      line=$("${BIN[$v]}" "$f" 2>&1) || line="FAIL x FAIL x FAIL x FAIL"
      echo "ROW $r $v $f $(echo "$line" | awk '{print $3, $5, $7}')"
    done
  done
done | tee "$W/logs/rows.txt"

echo "=== summary"
node "$H/summarize.ts" "$W/logs/rows.txt"
