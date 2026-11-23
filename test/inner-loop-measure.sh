#!/usr/bin/env bash
# The inner loop's cost and catch rate, for .github/workflows/measure-inner-loop.yml (a runner, not
# the shared dev box). From the repository root, full history fetched:
#   test/inner-loop-measure.sh corpora            clone the pinned TS and test262 corpora (as ci.yml)
#   test/inner-loop-measure.sh timing             five sample commits x --changed / --quick x cold / warm
#   test/inner-loop-measure.sh catch <branch>:<sha>
#     <sha> is a head of land/<branch> whose CI failed for a real reason. Its change is put back onto
#     this tree: the difference from the branch's last head (origin/land/<branch>, what was fixed
#     and landed) back to <sha>, over the files the branch itself changed; a file that no longer
#     applies is left out and named. Then `--quick` and `--changed` run against that one change.
#     caught: --quick fails; missed: --changed fails and --quick passes; not reproduced: --changed
#     passes (the defect is not visible in the inner loop at all on this tree, or did not apply).
set -uo pipefail
cmd=${1:?usage: corpora | timing | catch <branch>:<sha>}
row() { local IFS='|'; echo "|$*|"; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }
now() { date +%s.%N; }
cold() { rm -rf "$(node -p 'require("os").tmpdir()')/monogram-build-cache"; go clean -cache 2>/dev/null || true; }
gates_run() { grep -cE '^    [✓✗] ' "$1" || true; }
failed_gates() { grep -E '^    ✗ ' "$1" | awk '{print $2}' | tr '\n' ' '; }

case $cmd in
corpora)
  set -e
  rm -rf /tmp/ts-repo; mkdir -p /tmp/ts-repo
  git -C /tmp/ts-repo init -q
  git -C /tmp/ts-repo remote add origin https://github.com/microsoft/TypeScript
  git -C /tmp/ts-repo config core.sparseCheckout true
  printf 'tests/cases/\n' > /tmp/ts-repo/.git/info/sparse-checkout
  git -C /tmp/ts-repo fetch -q --depth 1 --filter=blob:none origin "$TS_REPO_SHA"
  git -C /tmp/ts-repo checkout -q FETCH_HEAD
  rm -rf /tmp/test262; mkdir -p /tmp/test262
  git -C /tmp/test262 init -q
  git -C /tmp/test262 remote add origin https://github.com/tc39/test262
  git -C /tmp/test262 config core.sparseCheckout true
  printf 'test/language/\ntest/annexB/language/\n' > /tmp/test262/.git/info/sparse-checkout
  git -C /tmp/test262 fetch -q --depth 1 --filter=blob:none origin "$(cat test/test262.sha)"
  git -C /tmp/test262 checkout -q FETCH_HEAD
  ;;
timing)
  mkdir -p /tmp/timing-out
  echo "cores: $(nproc)"
  row ' commit ' ' change ' ' mode ' ' gates ' ' cold s ' ' warm s ' ' result '
  row '---' '---' '---' '---:' '---:' '---:' '---'
  for kv in c6cab09:docs d6d12b8:test-only 9164d57:rust-printer 211029f:generator de35876:grammar; do
    c=${kv%%:*}
    for m in changed quick; do
      cold
      log=/tmp/timing-out/$c-$m
      t0=$(now); node test/check.ts --$m --commit="$c" > "$log-cold.txt" 2>&1; rc1=$?; t1=$(now)
      node test/check.ts --$m --commit="$c" > "$log-warm.txt" 2>&1; rc2=$?; t2=$(now)
      res=ok; [ $rc1 = 0 ] && [ $rc2 = 0 ] || res="FAILED: $(failed_gates "$log-cold.txt")"
      row " $c " " ${kv#*:} " " --$m " " $(gates_run "$log-warm.txt") " " $(secs "$t0" "$t1") " " $(secs "$t1" "$t2") " " $res "
      grep -E '^    [✓✗] ' "$log-warm.txt" | sed "s/^/  $c --$m warm: /" >&2
    done
  done
  ;;
catch)
  spec=${2:?branch:sha}; B=${spec%%:*}; F=$(git rev-parse "${spec#*:}^{commit}"); L=origin/land/$B
  out=/tmp/catch-out; mkdir -p "$out"
  git config user.email ci@example.invalid; git config user.name ci
  mb() { git merge-base "$1" origin/master; }
  # the files the branch changed, at the failing head and at its last head; generated artifacts and
  # prose are regenerated or irrelevant
  git diff --name-only "$(mb "$F")" "$F" > "$out/files-F.txt"
  git diff --name-only "$(mb "$L")" "$L" > "$out/files-L.txt"
  sort -u "$out/files-F.txt" "$out/files-L.txt" | grep -vE '\.(tmLanguage|monarch|language-configuration|contributes)\.json$|^tree-sitter/|\.md$' > "$out/files.txt"
  git diff "$L" "$F" -- $(cat "$out/files.txt") > "$out/unfix.diff"
  skipped=''
  if [ ! -s "$out/unfix.diff" ]; then
    row " $B " " ${F:0:10} " ' no difference from the landed head ' '' '' ' not reproduced '; exit 0
  fi
  if ! git apply -3 --index "$out/unfix.diff" 2> "$out/apply.log"; then
    bad=$( (grep -oE '^error: patch failed: [^:]+' "$out/apply.log" | sed 's/^error: patch failed: //'; git diff --name-only --diff-filter=U) | sort -u)
    git reset -q --hard HEAD
    ex=(); for f in $bad; do ex+=("--exclude=$f"); done
    skipped=$(echo $bad)
    git apply -3 --index "${ex[@]}" "$out/unfix.diff" 2>> "$out/apply.log" || { row " $B " " ${F:0:10} " " does not apply: $skipped " '' '' ' not reproduced '; exit 0; }
  fi
  git commit -q -m "put back the failure of $B at $F"
  npm run gen > "$out/gen.txt" 2>&1 || echo "gen failed (the gates then fail on its absence)"
  t0=$(now); node test/check.ts --quick HEAD~1 > "$out/quick.txt" 2>&1; q=$?; t1=$(now)
  node test/check.ts --changed HEAD~1 > "$out/changed.txt" 2>&1; c=$?
  if [ $c != 0 ] && [ $q != 0 ]; then v=caught; elif [ $c != 0 ]; then v=MISSED; elif [ $q != 0 ]; then v='quick only'; else v='not reproduced'; fi
  row ' branch ' ' failing head ' ' --quick failed ' ' --changed failed ' ' quick s ' ' verdict ' ' files left out '
  row '---' '---' '---' '---' '---:' '---' '---'
  row " $B " " ${F:0:10} " " $(failed_gates "$out/quick.txt") " " $(failed_gates "$out/changed.txt") " " $(secs "$t0" "$t1") " " $v " " ${skipped:-none} "
  ;;
*) echo "unknown command $cmd"; exit 1 ;;
esac
