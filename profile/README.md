# Go NewDoc Linux profiling package (round 2)

Self-contained: needs only Go (measure with go1.24.4) and the original 270,780-byte `in.ts`
(sha256 65f5f596db0eaeb5d12e3992cd150c9afbd16945e385edb2843dc2a5758eef1d). No repo checkout.

    cd profile && ./profile.sh /path/to/in.ts 7      # serial; ~3-4 min; then send results.tgz

Variants (each has `bench/` = the original harness `main.go.tmpl`, `prof/` = NewDoc-only profiler):

| dir       | parser.go                                                                        |
|-----------|----------------------------------------------------------------------------------|
| ee11fdf   | pre-regression reference (package-level arena shared by every Doc)               |
| aa02d65   | current master c704a6a (byte-identical parser.go, sha256 0ab23eac…)               |
| cand      | candidate fix, generated from src/target-go.ts: token/meta slices presized from len(src)/2, node/kid arena from 0.75×/1.25× token count |

What each section isolates:
1. original harness, alternating serial rounds (same numbers as the earlier summary).
2. per-NewDoc allocated bytes, GC cycles, GC pause, heap released to the OS.
3. `GOGC=off`: time with no GC at all — if aa02d65's gap to ee11fdf closes here, the gap is GC-driven.
4. `GODEBUG=madvdontneed=0`: lazier return of freed pages — if the gap shrinks here, it is page
   return/re-fault (scavenger) cost.
5. GC cycle count from gctrace.
6. page faults and task-clock (`perf stat`, else GNU `/usr/bin/time -v`).
7. CPU pprof top (flat and cum) per variant — the direct Linux attribution.
8. alloc_space top per variant (platform-independent: who allocates).

Mac smoke run of this package (Mac evidence only, not a Linux result): alloc per NewDoc
ee11fdf 30.1 MB / aa02d65 26.2 MB / cand 10.9 MB; GC cycles per NewDoc 2.78 / 5.11 / 1.00.
The hypothesis to confirm or reject on Linux: ee11fdf's shared arena kept a large live heap
(high GC goal); per-Doc ownership drops it, so append-growth garbage triggers ~2x more GC
cycles, each returning pages that the next Doc faults back in.
