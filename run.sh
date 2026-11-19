#!/usr/bin/env bash
# usage: run.sh <in.ts> <rounds> <dir>...   (each <dir>/go/gb already built)
set -e
in=$1; n=$2; shift 2
for r in $(seq 1 "$n"); do for c in "$@"; do echo "$r $c $(./$c/go/gb "$in")"; done; done | tee results.log
