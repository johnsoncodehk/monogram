#!/usr/bin/env bash
# The inner loop's cost and catch rate, for .github/workflows/measure-inner-loop.yml (a runner, not
# the shared dev box). From the repository root, full history fetched:
#   test/inner-loop-measure.sh corpora            clone the pinned TS and test262 corpora (as ci.yml)
#   test/inner-loop-measure.sh timing             five sample commits x --changed / --quick x cold / warm
#   test/inner-loop-measure.sh concurrent        two cold runs of a gate at once into one empty cache
#   test/inner-loop-measure.sh go-unused          the quick tier against a Go printer mistake only a real
#     grammar's parser reaches: a variable declared and not used in the relexable lexer's regex-context
#     state (printed for a grammar with a regex context: javascript, not calc / templatejs)
#   test/inner-loop-measure.sh catch <branch>:<sha>
#     <sha> is a head of land/<branch> whose CI failed for a real reason. Its change is put back onto
#     this tree: what the branch's last head (origin/land/<branch>, what was fixed and landed)
#     changed is reverted and what <sha> changed is applied, file by file, each from its own merge
#     base (so master's work merged into the branch is not undone); conflicting hunks take the
#     branch's side and the file is named. Then `--quick` and `--changed` run against that one change.
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
  for kv in c6cab09:docs d6d12b8:test-only 9164d57:rust-printer 11a7c70:go-printer 211029f:generator de35876:grammar; do
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
go-unused)
  out=/tmp/go-unused; mkdir -p "$out"
  # This script commits probes: give THOSE commits an identity through the environment. Never `git config`:
  # a worktree shares .git/config with the main checkout, and a config written here changed the author of
  # every commit landed from that machine (51 commits on master, 2026-11-23 20:10 to 2026-11-24 06:21 UTC).
  export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.invalid GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.invalid
  grep -q 'const rxStateFrom = rx ? `\\tprevIsValue := func() bool {' src/targets/target-go.ts || { echo "go-unused: the mutation site moved"; exit 1; }
  sed -i 's/const rxStateFrom = rx ? `/&\\tunusedProbe := 0\\n/' src/targets/target-go.ts
  git diff | grep '^[-+] '; git commit -qam 'go-unused probe'
  node test/check.ts --quick --commit=HEAD > "$out/quick.txt" 2>&1; rc=$?
  grep -E '^    [✓✗] ' "$out/quick.txt"; grep -A12 -E '^── ✗' "$out/quick.txt" | head -40
  row ' mutation ' ' --quick exit ' ' failed gates ' ' Go compiler says '
  row '---' '---' '---' '---'
  row ' declared-and-not-used in the relexable lexer regex-context state ' " $rc " " $(failed_gates "$out/quick.txt") " " $(grep -m1 -o 'declared and not used[^|]*' "$out/quick.txt" || echo none) "
  git reset -q --hard HEAD^
  ;;
catch)
  spec=${2:?branch:sha}; B=${spec%%:*}; F=$(git rev-parse "${spec#*:}^{commit}"); L=origin/land/$B
  out=/tmp/catch-out; mkdir -p "$out"
  # This script commits probes: give THOSE commits an identity through the environment. Never `git config`:
  # a worktree shares .git/config with the main checkout, and a config written here changed the author of
  # every commit landed from that machine (51 commits on master, 2026-11-23 20:10 to 2026-11-24 06:21 UTC).
  export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.invalid GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.invalid
  mb() { git merge-base "$1" origin/master; }
  # the files the branch changed, at the failing head and at its last head; generated artifacts and
  # prose are regenerated or irrelevant; the loop's own tooling (check.ts, gate-deps, this script,
  # workflows, the size record, package.json) stays this tree's: it is what is being measured
  git diff --name-only "$(mb "$F")" "$F" > "$out/files-F.txt"
  git diff --name-only "$(mb "$L")" "$L" > "$out/files-L.txt"
  sort -u "$out/files-F.txt" "$out/files-L.txt" | grep -vE '\.(tmLanguage|monarch|language-configuration|contributes)\.json$|^tree-sitter/|\.md$|^test/(check|gate-deps|check-targets|inner-loop-measure)\.|^\.github/|^docs/emit-sizes\.json$|^package(-lock)?\.json$' > "$out/files.txt"
  skipped=''
  # The put-back, file by file, from the BRANCH's own changes only (master's work merged into the
  # branch between the two heads is not undone): revert what the landed head changed (its diff from
  # its merge base) and apply what the failing head changed (its diff from its own), each a 3-way
  # merge onto this tree's file; a hunk that conflicts with master's later work takes the branch's
  # side and the file is named in the last column.
  blob() { git show "$1:$2" 2>/dev/null; }
  three() { # <file> <base rev> <theirs rev>: merge into the working file; 1 if it conflicted
    local f=$1 bf=$out/m-base tf=$out/m-theirs of=$out/m-ours n=0
    blob "$2" "$f" > "$bf"; local hb=$?; blob "$3" "$f" > "$tf"; local ht=$?
    # a file master deleted since the base (this tree lacks it, the base has it): nothing runs it
    if [ ! -e "$f" ] && [ $hb = 0 ]; then return 0; fi
    if [ -e "$f" ]; then cp "$f" "$of"; else : > "$of"; fi
    if [ $ht != 0 ]; then # the change deletes the file: delete it if this tree's equals the base
      if [ $hb = 0 ] && cmp -s "$of" "$bf"; then rm -f -- "$f"; return 0; fi
      [ -e "$f" ] && return 1; return 0
    fi
    git merge-file -p "$of" "$bf" "$tf" > /dev/null 2>&1 || n=1
    mkdir -p "$(dirname "$f")"
    git merge-file -p --theirs "$of" "$bf" "$tf" > "$f" 2>/dev/null || true
    return $n
  }
  MBL=$(mb "$L"); MBF=$(mb "$F")
  for p in $(cat "$out/files.txt"); do
    conflict=0
    grep -qxF "$p" "$out/files-L.txt" && { three "$p" "$L" "$MBL" || conflict=1; }
    grep -qxF "$p" "$out/files-F.txt" && { three "$p" "$MBF" "$F" || conflict=1; }
    [ $conflict = 1 ] && skipped="$skipped $p"
    if [ -e "$p" ]; then git add -- "$p"; else git rm -q --cached --ignore-unmatch -- "$p"; fi
  done
  git diff --cached --quiet && { row " $B " " ${F:0:10} " ' no difference from this tree ' '' '' ' not reproduced '; exit 0; }
  git commit -q -m "put back the failure of $B at $F"
  # CATCH_DRY=1: stop here (shows what was put back)
  if [ -n "${CATCH_DRY:-}" ]; then git show --stat --format=%s HEAD; echo "conflicts:${skipped:- none}"; exit 0; fi
  npm run gen > "$out/gen.txt" 2>&1 || echo "gen failed (the gates then fail on its absence)"
  t0=$(now); node test/check.ts --quick HEAD~1 > "$out/quick.txt" 2>&1; q=$?; t1=$(now)
  node test/check.ts --changed HEAD~1 > "$out/changed.txt" 2>&1; c=$?
  # the ci tier too (corpus / edits / recovery classes, test262, ...): a failure only it shows is one
  # the inner loop cannot catch at all
  node test/check.ts --changed --all HEAD~1 > "$out/all.txt" 2>&1; a=$?
  if [ $q != 0 ] && [ -z "$(failed_gates "$out/quick.txt")" ]; then v='ERROR (check.ts ran no gate)'; elif [ $q != 0 ]; then v=caught; elif [ $c != 0 ]; then v='MISSED (--changed catches)'; elif [ $a != 0 ]; then v='MISSED (ci tier only)'; else v='not reproduced'; fi
  row ' branch ' ' failing head ' ' --quick failed ' ' --changed failed ' ' --changed --all failed ' ' quick s ' ' verdict ' ' files with a conflicting hunk (branch side taken) '
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
  for g in "test/portable-lists.ts --grammars=calc,templatejs" "test/parser-ir-library.ts"; do
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
