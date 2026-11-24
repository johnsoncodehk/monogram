#!/usr/bin/env bash
# Wall-clock A/B of the TS target, the emitted JS parser and the Go target at two commits, in ONE
# job: D = TARGETS_BASE, E = TARGETS_COMMIT. Each round runs every input under every
# (target, mode) for both variants back to back, the variant order alternating per round; each
# measurement is a fresh process (go-main.go / time.ts: 3 warm-up parses, then >= 1 s). Medians and
# per-round E/D ratios by test/bench-rust-oxc/summarize.ts. Only ratios inside one job compare.
# Usage (repo root, full history):
#   TARGETS_BASE=<commit> TARGETS_COMMIT=<commit> test/bench-targets/run.sh [rounds=9]
# TARGETS_GRAMMAR = typescript (default) | javascript | typescriptreact | javascriptreact. TARGETS_ONLY = a space-separated subset of
# "ts-parse ts-parseWith js-fresh js-reuse go-fresh go-reuse" (default all).
set -euo pipefail
ROUNDS=${1:-9}
REPO=$(pwd)
H=$REPO/test/bench-targets
W=${TARGETS_WORK:-$REPO/../targets-work}
TS_REPO_SHA=${TS_REPO_SHA:-6fbce89821d93a5b761581d9ac540455f38e9acb}
GRAMMAR=${TARGETS_GRAMMAR:-typescript}
ONLY=${TARGETS_ONLY:-ts-parse ts-parseWith js-fresh js-reuse go-fresh go-reuse}
[ -n "${TARGETS_BASE:-}" ] && [ -n "${TARGETS_COMMIT:-}" ] || { echo "TARGETS_BASE and TARGETS_COMMIT are required"; exit 1; }
rm -rf "$W"; mkdir -p "$W/inputs" "$W/logs"
D_SHA=$(git rev-parse "$TARGETS_BASE^{commit}"); E_SHA=$(git rev-parse "$TARGETS_COMMIT^{commit}")

echo "=== environment"
lscpu | grep -E '^(Model name|CPU\(s\)|L2 cache|L3 cache)' || true
nproc; uname -a; node --version; go version
echo "grammar = $GRAMMAR"; echo "measured = $ONLY"
for kv in "D:$D_SHA" "E:$E_SHA"; do echo "${kv%%:*} = $(git log -1 --format='%h %ad %s' --date=iso "${kv#*:}")"; done

echo "=== emit and build"
for kv in "D:$D_SHA" "E:$E_SHA"; do
  v=${kv%%:*}; c=${kv#*:}
  git worktree add -q --detach "$W/src-$v" "$c"
  (cd "$W/src-$v" && npm ci --silent --no-audit --no-fund)
  node "$H/emit.ts" "$W/src-$v" "$W/out-$v" "$GRAMMAR"
  (cd "$W/out-$v/go" && go build -trimpath -o bench .)
  sha256sum "$W/out-$v/ts.mts" "$W/out-$v/js.mts" "$W/out-$v/go/parser/parser.go"
done

echo "=== inputs"
cp "$REPO/node_modules/tsc-oracle/lib/typescript.d.ts" "$W/inputs/typescript.d.ts"
curl -fsSL "https://raw.githubusercontent.com/microsoft/TypeScript/$TS_REPO_SHA/src/compiler/checker.ts" -o "$W/inputs/checker.ts"
git show 2632c2c:src/gen-tm.ts > "$W/inputs/gen-tm.ts"
cp "$REPO/node_modules/acorn/dist/acorn.js" "$W/inputs/acorn.js"
case $GRAMMAR in
  typescript) INPUTS="checker.ts typescript.d.ts gen-tm.ts acorn.js";;
  javascript) INPUTS="acorn.js";;
  # The element dialects: the element code of the pinned tsc corpus (TS_CASES = its tests/cases;
  # test/bench-rust-profile/element-inputs.ts says how it is chosen), and acorn.js as plain code.
  typescriptreact|javascriptreact)
    node "$REPO/test/bench-rust-profile/element-inputs.ts" "${TS_CASES:-/tmp/ts-repo/tests/cases}" "$W/inputs"
    if [ "$GRAMMAR" = typescriptreact ]; then INPUTS="jsx-corpus.tsx acorn.js"; else INPUTS="jsx-corpus.jsx acorn.js"; fi;;
  *) echo "TARGETS_GRAMMAR must be typescript, javascript, typescriptreact or javascriptreact, not $GRAMMAR"; exit 1;;
esac
(cd "$W/inputs" && wc -c $INPUTS)

run1() { # <variant> <target-mode> <file>: one measurement, "ms n"
  local v=$1 tm=$2 f=$3
  case $tm in
    go-*) "$W/out-$v/go/bench" "${tm#go-}" "$W/inputs/$f" ;;
    ts-*) node "$H/time.ts" "$W/out-$v/ts.mts" "${tm#ts-}" "$W/inputs/$f" ;;
    js-*) node "$H/time.ts" "$W/out-$v/js.mts" "${tm#js-}" "$W/inputs/$f" ;;
  esac
}

echo "=== acceptance (one untimed parse per target per input per variant)"
for v in D E; do for f in $INPUTS; do for t in ts js go; do
  case $t in go) r=$("$W/out-$v/go/bench" check "$W/inputs/$f");; *) r=$(node "$H/time.ts" "$W/out-$v/$t.mts" "check-$t" "$W/inputs/$f");; esac
  echo "$v $t $r $f"
done; done; done | tee "$W/logs/check.txt"
accepted() { grep -qF "$1 $2 ACCEPT $3" "$W/logs/check.txt"; }

echo "=== timing: $ROUNDS rounds; variant order alternates per round"
for r in $(seq 1 "$ROUNDS"); do
  if [ $((r % 2)) = 1 ]; then ORDER="D E"; else ORDER="E D"; fi
  for f in $INPUTS; do
    bytes=$(wc -c < "$W/inputs/$f")
    for tm in $ONLY; do
      accepted D "${tm%%-*}" "$f" && accepted E "${tm%%-*}" "$f" || continue
      for v in $ORDER; do
        out=$(run1 "$v" "$tm" "$f") || { echo "FAILED $v $tm $f"; exit 1; }
        ms=${out%% *}
        echo "ROW $r $v $tm:$f $ms $(node -e "console.log(($bytes / 1e6 / ($ms / 1000)).toFixed(1))") (n=${out##* })"
      done
    done
  done
done | tee "$W/logs/rows.txt"

echo "=== summary"
node "$REPO/test/bench-rust-oxc/summarize.ts" "$W/logs/rows.txt"
