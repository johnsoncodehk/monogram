#!/usr/bin/env bash
# usage: ./gen.sh <monogram git clone> — regenerates base/ fam/ fix/ from `git archive <commit>` and checks SHA256SUMS.
set -eu
REPO=$(cd "$1" && pwd); cd "$(dirname "$0")"; T=$(mktemp -d)
while read -r v c; do
  mkdir -p $T/$v && git -C "$REPO" archive $c | tar -x -C $T/$v
  ln -s "$REPO/node_modules" $T/$v/node_modules 2>/dev/null || true
  node gen.ts $T/$v $v 2>/dev/null
done < VARIANTS
rm -rf $T; shasum -a 256 -c SHA256SUMS 2>/dev/null || sha256sum -c SHA256SUMS
