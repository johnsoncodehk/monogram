#!/usr/bin/env bash
# Where monogram's emitted Rust TypeScript parser spends its instructions, next to oxc, on the same
# inputs: one parse per process under Callgrind (deterministic instruction counts), plus work
# counts and heap traffic from a separate instrumented build. Usage (repo root, full history):
#   test/bench-rust-profile/run.sh
# PROFILE_SCOPE=full (default) runs everything below. PROFILE_SCOPE=pr runs only the deterministic
# A/M part that the pull-request workflow (.github/workflows/measure-profile.yml) reports: work
# counts, heap traffic, page faults and Callgrind instructions of A and M. It skips oxc (the same
# reference on both sides of a PR), the native timings, the annotations and phase regions, the
# cache/branch simulation and perf.
# Variants: A = PROFILE_A (default cbb58a0, master before the 2026-11-20 work), M = PROFILE_M (default fa2ac4b,
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
# The TypeScript sources checker.ts / parser.ts come from this commit; the workflows pass their one
# pin (ci.yml's TS_REPO_SHA), the default is the same commit.
TS_REPO_SHA=${TS_REPO_SHA:-6fbce89821d93a5b761581d9ac540455f38e9acb}
SCOPE=${PROFILE_SCOPE:-full}
case $SCOPE in full|pr) ;; *) echo "PROFILE_SCOPE must be full or pr, not $SCOPE"; exit 1;; esac
# The oxc crates build into one target directory (cacheable; keyed on test/oxc-parse-bench/Cargo.lock).
OXC_TARGET=${OXC_TARGET_DIR:-$W/oxc-target}
rm -rf "$W"; mkdir -p "$W/inputs" "$OUT/cg" "$OUT/annotate" "$OUT/regions" "$OUT/perf"
R=$OUT/results.txt; : > "$R"
# Every measured process runs under a time limit (PROFILE_CMD_TIMEOUT seconds, default 600; the
# slowest single measurement, a Callgrind cache simulation of checker.ts, takes well under a minute
# on the CI runner): a parser that does not terminate on an input is then ONE measurement recorded as
# failed (exit 124: a CRASH / FAILED line, which the summary lists as NOT RUN), not a job cancelled at
# its time limit with every measurement and the log lost (run 45222944792).
CMD_TIMEOUT=${PROFILE_CMD_TIMEOUT:-600}
lim() { timeout -k 10 "$CMD_TIMEOUT" "$@"; }
# Where the time goes: every phase's wall-clock seconds, printed when it ends and kept in phases.txt
# (the job summary shows them).
PH_NAME=''; PH_T=$SECONDS
phase() { # <id> <title>; `phase end` closes the last one
  if [ -n "$PH_NAME" ]; then echo "PHASE $PH_NAME $((SECONDS - PH_T)) s" | tee -a "$OUT/phases.txt"; fi
  PH_NAME=$1; PH_T=$SECONDS
  if [ "$1" != end ]; then echo "=== $2"; else PH_NAME=''; fi
}

git fetch -q origin master
A_SHA=$(git rev-parse "${PROFILE_A:-cbb58a0}")
M_SHA=$(git rev-parse "${PROFILE_M:-fa2ac4b}")
VARIANTS="A:$A_SHA M:$M_SHA"
# Each input is parsed by its own grammar's parser: .tsx by typescriptreact, .jsx by
# javascriptreact, the rest by typescript. A build of another grammar than typescript lives beside
# typescript's with the grammar as a suffix (mono-prof-M-typescriptreact, targets-M-javascriptreact).
GRAMMARS="typescript typescriptreact javascriptreact"
grammar_of() { case $1 in *.tsx) echo typescriptreact;; *.jsx) echo javascriptreact;; *) echo typescript;; esac; }
sfx() { [ "$1" = typescript ] || echo "-$1"; }
mono() { echo "$W/mono-$1-$2$(sfx "$3")/target/release/mono-$1-$2$(sfx "$3")"; } # <prof|count> <variant> <grammar>

phase environment "environment"
lscpu | grep -E '^(Model name|Architecture|CPU\(s\)|Thread\(s\) per core|Core\(s\) per socket|L2 cache|L3 cache|CPU max MHz)' || true
nproc; uname -a; cat /proc/loadavg
rustc -vV; cargo -V; node --version; valgrind --version
echo "perf_event_paranoid=$(cat /proc/sys/kernel/perf_event_paranoid)"
echo "origin/master = $(git rev-parse origin/master)"
for kv in $VARIANTS; do echo "${kv%%:*} = $(git log -1 --format='%h %ad %s' --date=iso "${kv#*:}")"; done
echo "scope = $SCOPE"

phase build-monogram "emit and build monogram (profiled build and count build per variant)"
for kv in $VARIANTS; do
  v=${kv%%:*}; c=${kv#*:}
  git worktree add -q --detach "$W/src-$v" "$c"
  (cd "$W/src-$v" && npm ci --silent --no-audit --no-fund)
  for g in $GRAMMARS; do
    n=$v$(sfx "$g")
    node "$HB/emit.ts" "$W/src-$v" "$W/parser-$n.rs" "$g"
    sha256sum "$W/parser-$n.rs"
    for kind in prof count; do
      d=$W/mono-$kind-$n; mkdir -p "$d/src"
      printf '[package]\nname = "mono-%s-%s"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n\n[profile.release]\ndebug = %s\n' \
        "$kind" "$n" "$([ $kind = prof ] && echo true || echo false)" > "$d/Cargo.toml"
    done
    cat "$W/parser-$n.rs" "$H/prof-tail.rs" > "$W/mono-prof-$n/src/main.rs"
    node "$H/patch-count.ts" "$W/parser-$n.rs" "$W/parser-$n.count.rs"
    cat "$W/parser-$n.count.rs" "$H/count-tail.rs" > "$W/mono-count-$n/src/main.rs"
    for kind in prof count; do (cd "$W/mono-$kind-$n" && RUSTFLAGS="-A warnings" cargo build --release -q); done
    cp "$W/mono-prof-$n/src/main.rs" "$OUT/main-$n.rs"
  done
done
echo "note: RUSTFLAGS='-A warnings' on the monogram crates only silences lints; it does not affect codegen."

HAVE_OXC=0; HAVE_LEX=0; HAVE_OXCCOUNT=0
if [ "$SCOPE" = full ]; then
phase build-oxc "build oxc (profiled: test/oxc-parse-bench with debug = true; oxc-lex and oxc-count beside it)"
cp -r "$REPO/test/oxc-parse-bench" "$W/oxc"; rm -rf "$W/oxc/target"
sed -i 's/^debug = false$/debug = true/' "$W/oxc/Cargo.toml"
grep -A3 '^\[profile' "$W/oxc/Cargo.toml"
mkdir -p "$W/oxc/src/bin"; cp "$H/oxc-once.rs" "$W/oxc/src/bin/oxc-once.rs"; cp "$HB/oxc-check.rs" "$W/oxc/src/bin/oxc-check.rs"
(cd "$W/oxc" && cargo build --release --locked -q --target-dir "$OXC_TARGET")
HAVE_OXC=1
for x in oxc-lex oxc-count; do
  cp -r "$H/$x" "$W/$x"; cp "$REPO/test/oxc-parse-bench/Cargo.lock" "$W/$x/Cargo.lock"
done
if (cd "$W/oxc-lex" && cargo build --release -q --target-dir "$OXC_TARGET"); then HAVE_LEX=1; else echo "oxc-lex: build failed; oxc lexer-alone numbers skipped"; fi
if (cd "$W/oxc-count" && cargo build --release -q --target-dir "$OXC_TARGET"); then HAVE_OXCCOUNT=1; else echo "oxc-count: build failed; oxc counts skipped"; fi
(cd "$W/oxc" && cargo tree -q --depth 1 -e normal | head -5)
fi
OXC=$OXC_TARGET/release

phase inputs "inputs"
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
node "$H/synth-nonascii.ts" "$W/inputs/nonascii.ts"
# Dense one-byte tokens with no trivia: one token per input byte, the most a lexer can emit.
node -e 'require("fs").writeFileSync(process.argv[1], ";".repeat(1 << 20))' "$W/inputs/dense-semi.ts"
node -e 'require("fs").writeFileSync(process.argv[1], "a" + "+a".repeat(1 << 19) + ";")' "$W/inputs/dense-plus.ts"
# The element inputs (TSX / JSX): the real element code of the pinned tsc corpus
# (element-inputs.ts says how they are chosen); TS_CASES is its tests/cases directory.
node "$H/element-inputs.ts" "${TS_CASES:-/tmp/ts-repo/tests/cases}" "$W/inputs"
# The control: gen-tm.ts (plain TypeScript, no element) through the typescriptreact parser. Against
# gen-tm.ts through the typescript one it is what the element machinery costs code outside elements.
cp "$W/inputs/gen-tm.ts" "$W/inputs/gen-tm.tsx"
MAIN="checker.ts gen-tm.ts typescript.d.ts dense-semi.ts"
ELEMENTS="jsx-corpus.tsx jsx-corpus.jsx gen-tm.tsx"
INPUTS="$MAIN typescript.js parser.ts synth2mb.ts typescript.ts nonascii.ts dense-plus.ts $ELEMENTS"
(cd "$W/inputs" && wc -c $INPUTS && sha256sum $INPUTS)
cd "$W/inputs"

phase counts "acceptance and work counts (count builds; not profiled)"
for f in $INPUTS; do
  [ $HAVE_OXC = 1 ] && { lim "$OXC/oxc-once" --once "$f" || echo "CRASH $f oxc-once (exit $?)"; } | sed 's/^/C /' | tee -a "$R"
  # oxc-count overflows its stack on dense-plus.ts (a 1 MB left-deep `a+a+…`): that is a fact about
  # the reference, not a reason to lose the whole profile, so a crash here is recorded and the run goes on.
  [ $HAVE_OXCCOUNT = 1 ] && { lim "$OXC/oxc-count" "$f" || echo "OXCCOUNT $f crashed (exit $?)"; } | tee -a "$R"
  for v in A M; do
    lim "$(mono prof $v "$(grammar_of "$f")")" --once "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v CRASH $f" | tee -a "$R"
    lim "$(mono count $v "$(grammar_of "$f")")" "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v COUNTCRASH $f" | tee -a "$R"
  done
done

phase faults "page faults per parse (count builds, getrusage): first parse in a fresh process, and the warm bench loop"
for f in $INPUTS; do
  for v in A M; do
    for m in cold warm reuse; do
      lim "$(mono count $v "$(grammar_of "$f")")" --faults-$m "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v FAULTSCRASH $m $f" | tee -a "$R"
    done
  done
  # oxc in both modes (fresh Allocator per parse; one Allocator reset between parses). A crash of the
  # reference on a pathological input is recorded, never fatal.
  if [ $HAVE_OXCCOUNT = 1 ]; then
    for m in fresh reuse; do
      { lim "$OXC/oxc-count" --faults $m "$f" || echo "OXCFAULTSCRASH $m $f (exit $?)"; } | tee -a "$R"
    done
  fi
done

if [ "$SCOPE" = full ]; then
phase native-time "native time per parse (profiled build; one run each, indicative only: the benchmark is test/bench-rust-oxc)"
for f in $MAIN; do
  { lim "$OXC/oxc-parse-bench" "$f" || echo "crashed - (exit $?)"; } | awk -v f="$f" '{print "C TIME parse", f, "ms=" $3}' | tee -a "$R"
  for v in A M; do
    lim "$W/mono-prof-$v/target/release/mono-prof-$v" --time "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v TIMECRASH $f" | tee -a "$R"
    lim "$W/mono-prof-$v/target/release/mono-prof-$v" --time-lex "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v TIMECRASH $f" | tee -a "$R"
    lim "$W/mono-prof-$v/target/release/mono-prof-$v" --time-reuse "$f" | sed "s/^/$v /" | tee -a "$R" || echo "$v TIMECRASH $f" | tee -a "$R"
  done
done
fi

phase callgrind "callgrind: one parse per process; collection limited to the measured entry point"
CG=(valgrind --tool=callgrind --dump-instr=no --collect-jumps=no --cache-sim=no --compress-strings=no --compress-pos=no --collect-atstart=no)
ir_of() { grep -E '^(totals|summary):' "$1" | head -1 | awk '{print $2}'; }
cg_run() { # <tag> <toggle> <cmd...>
  local tag=$1 tog=$2; shift 2
  local out=$OUT/cg/$tag.out
  if lim "${CG[@]}" --toggle-collect="$tog" --callgrind-out-file="$out" "$@" > "$OUT/cg/$tag.stdout" 2> "$OUT/cg/$tag.log"; then
    echo "IR $tag $(ir_of "$out")" | tee -a "$R"
  else
    echo "IR $tag FAILED"; tail -5 "$OUT/cg/$tag.log"
  fi
}
for f in $INPUTS; do
  if [ $HAVE_OXC = 1 ]; then
    cg_run "C.parse.$f" '*oxc_prof_parse*' "$OXC/oxc-once" --once "$f"
    cg_run "C.parse-reuse.$f" '*oxc_prof_parse_reuse*' "$OXC/oxc-once" --once-reuse "$f"
  fi
  [ $HAVE_LEX = 1 ] && cg_run "C.lex.$f" '*oxc_prof_lex*' "$OXC/oxc-lex" --once "$f" && cat "$OUT/cg/C.lex.$f.stdout" | tee -a "$R"
  for v in A M; do
    b=$(mono prof $v "$(grammar_of "$f")")
    grep -qF "$v ACCEPT $f " "$R" || { echo "$v rejects $f: profiled anyway (the parse fails late or early; see its tables)"; }
    cg_run "$v.parse.$f" '*mono_prof_parse*' "$b" --once "$f"
    cg_run "$v.lex.$f" '*mono_prof_lex*' "$b" --lex-once "$f"
    cg_run "$v.parse-reuse.$f" '*mono_prof_parse_reuse*' "$b" --once-reuse "$f"
    case " $MAIN " in *" $f "*) cg_run "$v.tokenize.$f" '*mono_prof_tokenize*' "$b" --tokenize-once "$f";; esac
  done
done

phase go-ts-targets "Go and TS targets: work per parse of the same inputs (Go: Callgrind instructions; TS target and emitted JS parser: V8 block executions)"
# So that a change which improves one target only shows as a move in one column of the summary.
# Go: test/bench-targets/go-main.go count (a parse into a reused CstBuilder: the direct engine) and
# count-builder (into a reused SlimBuilder: the builder engine), collection toggled
# around it by a client request; built with -tags faketime and run with GOGC=off GOMAXPROCS=1
# GODEBUG=asyncpreemptoff=1 (go-main.go says why each is needed); the map runtime's instructions are
# counted (test/bench-targets/go-ir.ts says why). TS / JS: test/bench-targets/blocks.ts (block
# executions) and test/bench-targets/allocs.ts (exact allocations).
# Both are pure functions of the emitted code and the input; PROFILE_TARGETS_REPEAT=1 (the default)
# measures M a second time (M2), and the summary fails the job if M2 differs from M.
mkdir -p "$OUT/targets"
go version
T0=$SECONDS
for v in A M; do
  for g in $GRAMMARS; do
    d=$W/targets-$v$(sfx "$g")
    node "$REPO/test/bench-targets/emit.ts" "$W/src-$v" "$d" "$g"
    (cd "$d/go" && go build -trimpath -tags faketime -o count .)
    sha256sum "$d/ts.mts" "$d/js.mts" "$d/go/parser/parser.go"
  done
done
TVARIANTS="A M"; [ "${PROFILE_TARGETS_REPEAT:-1}" = 1 ] && TVARIANTS="A M M2"
# The main inputs and the element inputs only: under Callgrind the Go parse costs about 3x the Rust one.
TINPUTS="$MAIN $ELEMENTS"
for f in $TINPUTS; do
  for v in $TVARIANTS; do
    t=${v%2}$(sfx "$(grammar_of "$f")") # M2 runs M's build
    # reuse: into a kept CstBuilder (the direct engine); builder: into a kept SlimBuilder (the
    # builder engine parserW, through the Builder interface).
    for gm in reuse builder; do
      out=$OUT/targets/$v.go-$gm.$f.cg
      cm=count; [ $gm = builder ] && cm=count-builder
      if lim env GOGC=off GOMAXPROCS=1 GODEBUG=asyncpreemptoff=1 "${CG[@]}" --callgrind-out-file="$out" "$W/targets-$t/go/count" $cm "$f" > "$out.stdout" 2> "$out.log" \
        && gi=$(node "$REPO/test/bench-targets/go-ir.ts" "$out") \
        && node "$REPO/test/bench-targets/go-ir.ts" "$out" --map-callers > "$out.map-callers.txt"; then
        echo "GOIR $v.$gm.$f $(grep -aoE 'ACCEPT|REJECT' "$out.stdout" | head -1) $gi" | tee -a "$R"
      else
        echo "GOIR $v.$gm.$f FAILED" | tee -a "$R"; tail -5 "$out.log"
      fi
    done
    for tm in ts-parse js-fresh; do
      if r=$(lim node "$REPO/test/bench-targets/blocks.ts" "$W/targets-$t/${tm%%-*}.mts" "$tm" "$f" "$OUT/targets/$v.$tm.$f.json"); then
        echo "TSBLK $v.$tm.$f $r" | tee -a "$R"
      else
        echo "TSBLK $v.$tm.$f FAILED" | tee -a "$R"
      fi
    done
  done
done
# Allocations of the TS / JS parse: exact counts, so A and M once (test/bench-targets/allocs.ts;
# one process per module: instrumenting it is most of the cost).
for v in A M; do
  for g in $GRAMMARS; do
    d=$W/targets-$v$(sfx "$g")
    gf=$(for f in $TINPUTS; do if [ "$(grammar_of "$f")" = "$g" ]; then echo "$f"; fi; done)
    for tm in ts-parse js-fresh; do
      if out=$(lim node "$REPO/test/bench-targets/allocs.ts" "$d/${tm%%-*}.mts" "$tm" "$d/alloc" $gf); then
        while read -r f rest; do echo "TSALLOC $v.$tm.$f $rest" | tee -a "$R"; done <<< "$out"
      else
        echo "TSALLOC $v.$tm.$g FAILED" | tee -a "$R"
      fi
    done
  done
done
echo "Go and TS targets: $((SECONDS - T0)) s (emit, build and measure)"

if [ "$SCOPE" = pr ]; then
  phase end
  echo "=== summary"
  node "$H/summarize.ts" "$R" | tee "$OUT/summary.txt"
  exit 0
fi

phase annotate-regions "annotate and phase regions"
for out in "$OUT"/cg/*.out; do
  tag=$(basename "$out" .out)
  callgrind_annotate --inclusive=yes --threshold=99.9 "$out" > "$OUT/annotate/$tag.inclusive.txt" 2>&1 || true
  callgrind_annotate --inclusive=no --threshold=99.9 "$out" > "$OUT/annotate/$tag.exclusive.txt" 2>&1 || true
  case $tag in
    C.*) node "$H/regions.ts" oxc "$out" > "$OUT/regions/$tag.txt" 2>&1 || true ;;
    A.*|M.*) rest=${tag#*.}; node "$H/regions.ts" mono "$out" "$OUT/main-${tag%%.*}$(sfx "$(grammar_of "${rest#*.}")").rs" > "$OUT/regions/$tag.txt" 2>&1 || true ;;
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

phase cache-sim "callgrind cache and branch simulation (same entry points; explains instructions that do not cost the same time)"
# Valgrind's simulated caches (sized from the host) and branch predictor, not the hardware's:
# counts to compare between parsers, not cycle predictions.
mkdir -p "$OUT/sim"
for f in $MAIN; do
  for tag in "C.parse.$f:*oxc_prof_parse*:$OXC/oxc-once --once" \
             "A.parse.$f:*mono_prof_parse*:$W/mono-prof-A/target/release/mono-prof-A --once" \
             "M.parse.$f:*mono_prof_parse*:$W/mono-prof-M/target/release/mono-prof-M --once" \
             "A.lex.$f:*mono_prof_lex*:$W/mono-prof-A/target/release/mono-prof-A --lex-once" \
             "M.lex.$f:*mono_prof_lex*:$W/mono-prof-M/target/release/mono-prof-M --lex-once"; do
    t=${tag%%:*}; rest=${tag#*:}; tog=${rest%%:*}; cmd=${rest#*:}
    out=$OUT/sim/$t.out
    if lim "${CG[@]}" --cache-sim=yes --branch-sim=yes --toggle-collect="$tog" --callgrind-out-file="$out" $cmd "$f" > /dev/null 2> "$OUT/sim/$t.log"; then
      echo "SIM $t $(grep '^events:' "$out" | head -1) | $(grep -E '^(totals|summary):' "$out" | head -1)" | tee -a "$R"
      for ev in Bcm Bim D1mr D1mw DLmr DLmw; do
        case $t in
          C.*) REGIONS_EVENT=$ev node "$H/regions.ts" oxc "$out" > "$OUT/sim/$t.$ev.txt" 2>&1 || true ;;
          A.*) REGIONS_EVENT=$ev node "$H/regions.ts" mono "$out" "$OUT/main-A.rs" > "$OUT/sim/$t.$ev.txt" 2>&1 || true ;;
          M.*) REGIONS_EVENT=$ev node "$H/regions.ts" mono "$out" "$OUT/main-M.rs" > "$OUT/sim/$t.$ev.txt" 2>&1 || true ;;
        esac
      done
    else
      echo "SIM $t FAILED"; tail -5 "$OUT/sim/$t.log"
    fi
  done
done
grep -h '^desc:' "$OUT/sim/C.parse.checker.ts.out" || true; grep -h 'warning' "$OUT"/sim/*.log | sort | uniq -c | head -5 || true

phase perf "perf (if the runner allows it): instructions and cycles per parse, whole process minus --noop"
if command -v perf >/dev/null && sudo sysctl -q kernel.perf_event_paranoid=1 && perf stat -e instructions:u true >/dev/null 2>&1; then
  pst() { perf stat -x, -r 5 -e instructions:u,cycles:u,branch-misses:u,page-faults "$@" 2>&1 >/dev/null | awk -F, '{print $3 "=" $1}' | tr '\n' ' '; }
  for f in $MAIN; do
    echo "PERF C $f once: $(pst "$OXC/oxc-once" --once "$f") noop: $(pst "$OXC/oxc-once" --noop "$f")" | tee -a "$R"
    for v in A M; do
      b=$W/mono-prof-$v/target/release/mono-prof-$v
      echo "PERF $v $f once: $(pst "$b" --once "$f") lex: $(pst "$b" --lex-once "$f") noop: $(pst "$b" --noop "$f")" | tee -a "$R"
      lim perf record -q -e cycles:u -F 1999 -o "$OUT/perf/$v.$f.data" "$b" --time "$f" >/dev/null 2>&1 || true
      perf report -i "$OUT/perf/$v.$f.data" --stdio --no-children --sort sym 2>/dev/null | grep -v '^#' | grep -v '^$' | head -40 > "$OUT/perf/$v.$f.report.txt" || true
    done
    lim perf record -q -e cycles:u -F 1999 -o "$OUT/perf/C.$f.data" "$OXC/oxc-parse-bench" "$f" >/dev/null 2>&1 || true
    perf report -i "$OUT/perf/C.$f.data" --stdio --no-children --sort sym 2>/dev/null | grep -v '^#' | grep -v '^$' | head -40 > "$OUT/perf/C.$f.report.txt" || true
  done
  rm -f "$OUT"/perf/*.data
  for x in "$OUT"/perf/*.report.txt; do echo "---- $(basename "$x") (cycles by symbol, bench loop)"; head -25 "$x" | cut -c1-200; done
else
  echo "perf not usable on this runner; skipped. Diagnostics:"
  command -v perf || echo "no perf binary"
  sudo sysctl kernel.perf_event_paranoid || true
  perf stat -e instructions:u true 2>&1 | tail -5 || true
  ls /sys/bus/event_source/devices/ 2>&1 || true
fi

phase end
echo "=== summary"
node "$H/summarize.ts" "$R" | tee "$OUT/summary.txt"
