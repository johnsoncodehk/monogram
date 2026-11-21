#!/usr/bin/env bash
# Where monogram's emitted Rust TypeScript parser spends its instructions, next to oxc, on the same
# inputs: one parse per process under Callgrind (deterministic instruction counts), plus work
# counts and heap traffic from a separate instrumented build. Usage (repo root, full history):
#   test/bench-rust-profile/run.sh
# Variants: A = cbb58a0 (master before the 2026-11-20 work), M = PROFILE_M (default fa2ac4b,
# origin/master when this profile was asked for), C = oxc (test/oxc-parse-bench, oxc_parser 0.126).
#
# Builds. Profiled (callgrind, native timing): every crate's [profile.release] is the benchmark's
# (cargo defaults: opt-level 3, thin-local LTO, 16 codegen units, unwind) with only `debug = true`
# added, for symbols and line tables; debug info does not change codegen. Count builds (work
# counters, counting global allocator) are separate binaries and are never profiled.
set -euo pipefail
REPO=$(pwd)
H=$REPO/test/bench-rust-profile
HB=$REPO/test/bench-rust-oxc
W=${PROFILE_WORK:-$REPO/../prof-work}
OUT=$W/out
TS_REPO_SHA=6fbce89821d93a5b761581d9ac540455f38e9acb
rm -rf "$W"; mkdir -p "$W/inputs" "$OUT/cg" "$OUT/annotate" "$OUT/regions" "$OUT/perf"
R=$OUT/results.txt; : > "$R"

git fetch -q origin master
A_SHA=$(git rev-parse cbb58a0)
M_SHA=$(git rev-parse "${PROFILE_M:-fa2ac4b}")
VARIANTS="A:$A_SHA M:$M_SHA"

echo "=== environment"
lscpu | grep -E '^(Model name|Architecture|CPU\(s\)|Thread\(s\) per core|Core\(s\) per socket|L2 cache|L3 cache|CPU max MHz)' || true
nproc; uname -a; cat /proc/loadavg
rustc -vV; cargo -V; node --version; valgrind --version
echo "perf_event_paranoid=$(cat /proc/sys/kernel/perf_event_paranoid)"
echo "origin/master = $(git rev-parse origin/master)"
for kv in $VARIANTS; do echo "${kv%%:*} = $(git log -1 --format='%h %ad %s' --date=iso "${kv#*:}")"; done

echo "=== emit and build monogram (profiled build and count build per variant)"
for kv in $VARIANTS; do
  v=${kv%%:*}; c=${kv#*:}
  git worktree add -q --detach "$W/src-$v" "$c"
  (cd "$W/src-$v" && npm ci --silent --no-audit --no-fund)
  node "$HB/emit.ts" "$W/src-$v" "$W/parser-$v.rs"
  sha256sum "$W/parser-$v.rs"
  for kind in prof count; do
    d=$W/mono-$kind-$v; mkdir -p "$d/src"
    printf '[package]\nname = "mono-%s-%s"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n\n[profile.release]\ndebug = %s\n' \
      "$kind" "$v" "$([ $kind = prof ] && echo true || echo false)" > "$d/Cargo.toml"
  done
  cat "$W/parser-$v.rs" "$H/prof-tail.rs" > "$W/mono-prof-$v/src/main.rs"
  node "$H/patch-count.ts" "$W/parser-$v.rs" "$W/parser-$v.count.rs"
  cat "$W/parser-$v.count.rs" "$H/count-tail.rs" > "$W/mono-count-$v/src/main.rs"
  for kind in prof count; do (cd "$W/mono-$kind-$v" && RUSTFLAGS="-A warnings" cargo build --release -q); done
  cp "$W/mono-prof-$v/src/main.rs" "$OUT/main-$v.rs"
done
echo "note: RUSTFLAGS='-A warnings' on the monogram crates only silences lints; it does not affect codegen."

echo "=== build oxc (profiled: test/oxc-parse-bench with debug = true; oxc-lex and oxc-count beside it)"
cp -r "$REPO/test/oxc-parse-bench" "$W/oxc"; rm -rf "$W/oxc/target"
sed -i 's/^debug = false$/debug = true/' "$W/oxc/Cargo.toml"
grep -A3 '^\[profile' "$W/oxc/Cargo.toml"
mkdir -p "$W/oxc/src/bin"; cp "$H/oxc-once.rs" "$W/oxc/src/bin/oxc-once.rs"; cp "$HB/oxc-check.rs" "$W/oxc/src/bin/oxc-check.rs"
(cd "$W/oxc" && cargo build --release --locked -q)
OXC=$W/oxc/target/release
HAVE_LEX=0; HAVE_OXCCOUNT=0
for x in oxc-lex oxc-count; do
  cp -r "$H/$x" "$W/$x"; cp "$REPO/test/oxc-parse-bench/Cargo.lock" "$W/$x/Cargo.lock"
done
if (cd "$W/oxc-lex" && cargo build --release -q); then HAVE_LEX=1; else echo "oxc-lex: build failed; oxc lexer-alone numbers skipped"; fi
if (cd "$W/oxc-count" && cargo build --release -q); then HAVE_OXCCOUNT=1; else echo "oxc-count: build failed; oxc counts skipped"; fi
(cd "$W/oxc" && cargo tree -q --depth 1 -e normal | head -5)

echo "=== inputs"
cp "$REPO/node_modules/typescript/lib/typescript.d.ts" "$W/inputs/typescript.d.ts"
cp "$REPO/node_modules/typescript/lib/typescript.js" "$W/inputs/typescript.js"
echo "typescript npm: $(node -p 'require("./node_modules/typescript/package.json").version')"
for f in checker.ts parser.ts; do
  curl -fsSL "https://raw.githubusercontent.com/microsoft/TypeScript/$TS_REPO_SHA/src/compiler/$f" -o "$W/inputs/$f"
done
# Same gen-tm.ts and typescript.ts as the benchmark (its variant B tree, 2632c2c).
git show 2632c2c:src/gen-tm.ts > "$W/inputs/gen-tm.ts"
git show 2632c2c:typescript.ts > "$W/inputs/typescript.ts"
node "$HB/synth2mb.ts" "$W/inputs/synth2mb.ts"
MAIN="checker.ts gen-tm.ts typescript.d.ts"
INPUTS="$MAIN typescript.js parser.ts synth2mb.ts typescript.ts"
(cd "$W/inputs" && wc -c $INPUTS && sha256sum $INPUTS)
cd "$W/inputs"

echo "=== acceptance and work counts (count builds; not profiled)"
for f in $INPUTS; do
  "$OXC/oxc-once" --once "$f" | sed 's/^/C /' | tee -a "$R"
  [ $HAVE_OXCCOUNT = 1 ] && "$W/oxc-count/target/release/oxc-count" "$f" | tee -a "$R"
  for v in A M; do
    "$W/mono-prof-$v/target/release/mono-prof-$v" --once "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v CRASH $f" | tee -a "$R"
    "$W/mono-count-$v/target/release/mono-count-$v" "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v COUNTCRASH $f" | tee -a "$R"
  done
done

echo "=== native time per parse (profiled build; one run each, indicative only: the benchmark is test/bench-rust-oxc)"
for f in $MAIN; do
  "$OXC/oxc-parse-bench" "$f" | awk -v f="$f" '{print "C TIME parse", f, "ms=" $3}' | tee -a "$R"
  for v in A M; do
    "$W/mono-prof-$v/target/release/mono-prof-$v" --time "$f" | sed "s/^/$v /" | tee -a "$R"
    "$W/mono-prof-$v/target/release/mono-prof-$v" --time-lex "$f" | sed "s/^/$v /" | tee -a "$R"
  done
done

echo "=== callgrind: one parse per process; collection limited to the measured entry point"
CG=(valgrind --tool=callgrind --dump-instr=no --collect-jumps=no --cache-sim=no --compress-strings=no --compress-pos=no --collect-atstart=no)
ir_of() { grep -E '^(totals|summary):' "$1" | head -1 | awk '{print $2}'; }
cg_run() { # <tag> <toggle> <cmd...>
  local tag=$1 tog=$2; shift 2
  local out=$OUT/cg/$tag.out
  if "${CG[@]}" --toggle-collect="$tog" --callgrind-out-file="$out" "$@" > "$OUT/cg/$tag.stdout" 2> "$OUT/cg/$tag.log"; then
    echo "IR $tag $(ir_of "$out")" | tee -a "$R"
  else
    echo "IR $tag FAILED"; tail -5 "$OUT/cg/$tag.log"
  fi
}
for f in $INPUTS; do
  cg_run "C.parse.$f" '*oxc_prof_parse*' "$OXC/oxc-once" --once "$f"
  [ $HAVE_LEX = 1 ] && cg_run "C.lex.$f" '*oxc_prof_lex*' "$W/oxc-lex/target/release/oxc-lex" --once "$f" && cat "$OUT/cg/C.lex.$f.stdout" | tee -a "$R"
  for v in A M; do
    b=$W/mono-prof-$v/target/release/mono-prof-$v
    grep -qF "$v ACCEPT $f " "$R" || { echo "$v rejects $f: profiled anyway (the parse fails late or early; see its tables)"; }
    cg_run "$v.parse.$f" '*mono_prof_parse*' "$b" --once "$f"
    cg_run "$v.lex.$f" '*mono_prof_lex*' "$b" --lex-once "$f"
    case " $MAIN " in *" $f "*) cg_run "$v.tokenize.$f" '*mono_prof_tokenize*' "$b" --tokenize-once "$f";; esac
  done
done

echo "=== annotate and phase regions"
for out in "$OUT"/cg/*.out; do
  tag=$(basename "$out" .out)
  callgrind_annotate --inclusive=yes --threshold=99.9 "$out" > "$OUT/annotate/$tag.inclusive.txt" 2>&1 || true
  callgrind_annotate --inclusive=no --threshold=99.9 "$out" > "$OUT/annotate/$tag.exclusive.txt" 2>&1 || true
  case $tag in
    C.*) node "$H/regions.ts" oxc "$out" > "$OUT/regions/$tag.txt" 2>&1 || true ;;
    A.*) node "$H/regions.ts" mono "$out" "$OUT/main-A.rs" > "$OUT/regions/$tag.txt" 2>&1 || true ;;
    M.*) node "$H/regions.ts" mono "$out" "$OUT/main-M.rs" > "$OUT/regions/$tag.txt" 2>&1 || true ;;
  esac
done
for f in $MAIN; do
  for v in C A M; do
    echo "################ $v parse $f"
    head -80 "$OUT/regions/$v.parse.$f.txt"
    echo "---- callgrind_annotate inclusive (top 40)"; grep -A44 -m1 'file:function' "$OUT/annotate/$v.parse.$f.inclusive.txt" | head -46 | cut -c1-220
    echo "---- callgrind_annotate exclusive (top 40)"; grep -A44 -m1 'file:function' "$OUT/annotate/$v.parse.$f.exclusive.txt" | head -46 | cut -c1-220
  done
done

echo "=== perf (if the runner allows it): instructions and cycles per parse, whole process minus --noop"
if command -v perf >/dev/null && sudo sysctl -q kernel.perf_event_paranoid=1 && perf stat -e instructions:u true >/dev/null 2>&1; then
  pst() { perf stat -x, -r 5 -e instructions:u,cycles:u,branch-misses:u "$@" 2>&1 >/dev/null | awk -F, '{print $3 "=" $1}' | tr '\n' ' '; }
  for f in $MAIN; do
    echo "PERF C $f once: $(pst "$OXC/oxc-once" --once "$f") noop: $(pst "$OXC/oxc-once" --noop "$f")" | tee -a "$R"
    for v in A M; do
      b=$W/mono-prof-$v/target/release/mono-prof-$v
      echo "PERF $v $f once: $(pst "$b" --once "$f") lex: $(pst "$b" --lex-once "$f") noop: $(pst "$b" --noop "$f")" | tee -a "$R"
      perf record -q -e cycles:u -F 1999 -o "$OUT/perf/$v.$f.data" "$b" --time "$f" >/dev/null 2>&1 || true
      perf report -i "$OUT/perf/$v.$f.data" --stdio --no-children --sort sym 2>/dev/null | grep -v '^#' | grep -v '^$' | head -40 > "$OUT/perf/$v.$f.report.txt" || true
    done
    perf record -q -e cycles:u -F 1999 -o "$OUT/perf/C.$f.data" "$OXC/oxc-parse-bench" "$f" >/dev/null 2>&1 || true
    perf report -i "$OUT/perf/C.$f.data" --stdio --no-children --sort sym 2>/dev/null | grep -v '^#' | grep -v '^$' | head -40 > "$OUT/perf/C.$f.report.txt" || true
  done
  rm -f "$OUT"/perf/*.data
  for x in "$OUT"/perf/*.report.txt; do echo "---- $(basename "$x") (cycles by symbol, bench loop)"; head -25 "$x" | cut -c1-200; done
else
  echo "perf not usable on this runner; skipped"
fi

echo "=== summary"
node "$H/summarize.ts" "$R" | tee "$OUT/summary.txt"
