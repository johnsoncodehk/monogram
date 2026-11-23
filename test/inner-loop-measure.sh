#!/usr/bin/env bash
# The inner loop's cost and catch rate, for .github/workflows/measure-inner-loop.yml (a runner, not
# the shared dev box). From the repository root, full history fetched:
#   test/inner-loop-measure.sh corpora            clone the pinned TS and test262 corpora (as ci.yml)
#   test/inner-loop-measure.sh timing             five sample commits x --changed / --quick x cold / warm
#   test/inner-loop-measure.sh concurrent        two cold runs of a gate at once into one empty cache
#   test/inner-loop-measure.sh catch <branch>:<sha>
#     <sha> is a head of land/<branch> whose CI failed for a real reason. Its change is put back onto
#     this tree: the difference from the branch's last head (origin/land/<branch>, what was fixed
#     and landed) back to <sha>, over the files the branch itself changed; a file that no longer
#     applies is 3-way merged with the failing head's side on conflicts, and named. Then `--quick` and `--changed` run against that one change.
#     caught: --quick fails; MISSED: --quick passes and --changed (or only `--changed --all`, the
#     ci tier) fails; not reproduced: all three pass (not visible on this tree, or did not apply).
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
  # prose are regenerated or irrelevant; the loop's own tooling (check.ts, gate-deps, this script,
  # workflows, the size record, package.json) stays this tree's: it is what is being measured
  git diff --name-only "$(mb "$F")" "$F" > "$out/files-F.txt"
  git diff --name-only "$(mb "$L")" "$L" > "$out/files-L.txt"
  sort -u "$out/files-F.txt" "$out/files-L.txt" | grep -vE '\.(tmLanguage|monarch|language-configuration|contributes)\.json$|^tree-sitter/|\.md$|^test/(check|gate-deps|check-targets|inner-loop-measure)\.|^\.github/|^docs/emit-sizes\.json$|^package(-lock)?\.json$' > "$out/files.txt"
  git diff "$L" "$F" -- $(cat "$out/files.txt") > "$out/unfix.diff"
  skipped=''
  if [ ! -s "$out/unfix.diff" ]; then
    row " $B " " ${F:0:10} " ' no difference from the landed head ' '' '' ' not reproduced '; exit 0
  fi
  # file by file: a 3-way apply of that file's difference; where master moved the file too far for
  # that, a 3-way merge (base: the landed head's file, ours: this tree's, theirs: the failing
  # head's) whose conflicting hunks take the failing head's side (named in the last column). A file
  # this tree no longer has but the landed head had (deleted since: nothing runs it) is skipped.
  for p in $(cat "$out/files.txt"); do
    git diff "$L" "$F" -- "$p" > "$out/one.diff"
    [ -s "$out/one.diff" ] || continue
    if ! git cat-file -e "HEAD:$p" 2>/dev/null && git cat-file -e "$L:$p" 2>/dev/null; then continue; fi
    if ! git apply -3 --index "$out/one.diff" 2>> "$out/apply.log"; then
      if git cat-file -e "HEAD:$p" 2>/dev/null; then git checkout -q HEAD -- "$p"; else git rm -q -f --ignore-unmatch -- "$p"; rm -f -- "$p"; fi
      blob() { git show "$1:$p" 2>/dev/null || true; }
      if git cat-file -e "$F:$p" 2>/dev/null; then
        blob HEAD > "$out/m-ours"; blob "$L" > "$out/m-base"; blob "$F" > "$out/m-theirs"
        mkdir -p "$(dirname "$p")"
        git merge-file -p --theirs "$out/m-ours" "$out/m-base" "$out/m-theirs" > "$p" || true
        git add -- "$p"
      else git rm -q -f --ignore-unmatch -- "$p"; fi
      skipped="$skipped $p"
    fi
  done
  git diff --cached --quiet && { row " $B " " ${F:0:10} " ' no difference from this tree ' '' '' ' not reproduced '; exit 0; }
  git commit -q -m "put back the failure of $B at $F"
  npm run gen > "$out/gen.txt" 2>&1 || echo "gen failed (the gates then fail on its absence)"
  t0=$(now); node test/check.ts --quick HEAD~1 > "$out/quick.txt" 2>&1; q=$?; t1=$(now)
  node test/check.ts --changed HEAD~1 > "$out/changed.txt" 2>&1; c=$?
  # the ci tier too (corpus / edits / recovery classes, test262, ...): a failure only it shows is one
  # the inner loop cannot catch at all
  node test/check.ts --changed --all HEAD~1 > "$out/all.txt" 2>&1; a=$?
  if [ $q != 0 ] && [ -z "$(failed_gates "$out/quick.txt")" ]; then v='ERROR (check.ts ran no gate)'; elif [ $q != 0 ]; then v=caught; elif [ $c != 0 ]; then v='MISSED (--changed catches)'; elif [ $a != 0 ]; then v='MISSED (ci tier only)'; else v='not reproduced'; fi
  row ' branch ' ' failing head ' ' --quick failed ' ' --changed failed ' ' --changed --all failed ' ' quick s ' ' verdict ' ' files merged favouring the failing head '
  row '---' '---' '---' '---' '---' '---:' '---' '---'
  row " $B " " ${F:0:10} " " $(failed_gates "$out/quick.txt") " " $(failed_gates "$out/changed.txt") " " $(failed_gates "$out/all.txt") " " $(secs "$t0" "$t1") " " $v " " ${skipped:-none} "
  ;;
concurrent)
  # Two gates building the same keys at once into one EMPTY build / emission cache (a fresh TMPDIR):
  # both must pass, every key must end as one complete entry (its `ok` marker), no lock or private
  # build directory may be left, and a third (warm) run must pass from the entries alone.
  T=$(mktemp -d); C=$T/monogram-build-cache
  row ' gate ' ' run 1 ' ' run 2 ' ' warm run ' ' entries ' ' complete ' ' locks left ' ' tmp left '
  row '---' '---' '---' '---' '---:' '---:' '---:' '---:'
  for g in "test/portable-lists.ts --grammars=calc,templatejs" "test/emit-portable-library.ts"; do
    rm -rf "$C"
    TMPDIR=$T node $g > /tmp/cc-1.txt 2>&1 & p1=$!
    TMPDIR=$T node $g > /tmp/cc-2.txt 2>&1 & p2=$!
    wait $p1; r1=$?; wait $p2; r2=$?
    TMPDIR=$T node $g > /tmp/cc-3.txt 2>&1; r3=$?
    row " $g " " exit $r1 " " exit $r2 " " exit $r3 " " $(ls "$C" | grep -vcE '\.lock$|\.tmp-') " " $(ls "$C"/*/ok 2>/dev/null | wc -l) " " $(ls -d "$C"/*.lock 2>/dev/null | wc -l) " " $(ls -d "$C"/*.tmp-* 2>/dev/null | wc -l) "
    [ $r1 = 0 ] && [ $r2 = 0 ] && [ $r3 = 0 ] || tail -n 20 /tmp/cc-1.txt /tmp/cc-2.txt /tmp/cc-3.txt >&2
  done
  ;;
*) echo "unknown command $cmd"; exit 1 ;;
esac
