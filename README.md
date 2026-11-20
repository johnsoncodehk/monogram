# Relex-family Linux validation package

Self-contained: needs Go (and optionally rustc / Node ≥ 23.6 for the Rust and TS rows) plus the
original 270,780-byte `in.ts` (sha256 `65f5f596db0eaeb5d12e3992cd150c9afbd16945e385edb2843dc2a5758eef1d`).
No repo checkout.

    ./run.sh /path/to/in.ts 7      # serial; then send results.tgz

| dir  | commit (johnsoncodehk/monogram)                         | what                                   |
|------|---------------------------------------------------------|----------------------------------------|
| base | `02d8827` master                                        | before the relex family                |
| fam  | `ac70b67` PR #78 (first Linux run: Rust Doc::new +15.6%) | relex/scanMeta family generated        |
| fix  | `3c1a1ad` PR #78                                        | Rust no longer reserves growth estimates |

Every `parser.go` / `parser.ts` and the parser part of `bench.rs` is `emitParser(typescript.ts, target)`
from that commit; `bench.rs` appends `bench-tail.rs`. Reproduce and verify against `SHA256SUMS`:

    ./gen.sh /path/to/monogram-clone   # git archive <commit> per VARIANTS → node gen.ts → sha256 -c

`base/` and `fam/` are byte-identical to the previous package (artifact commit 395feaf), and the
harness files (`main-*.go`, `tsbench.ts`, `bench-tail.rs`) are unchanged, so timing semantics match
the first Linux run. `fix` changes only Rust output versus `fam`: `scan_meta_toks` uses
`Vec::new()` without the trim (the same allocation pattern as base), and the relex prefix is
`old_toks[..n].to_vec()`. Go output is identical to `fam` apart from two comment lines.

Rows: `gobench` = the original harness (ParseWith / NewDoc / 200-edit loop); `goprof` = 300 NewDoc
with per-NewDoc alloc + GC cycles; `goedit` = 2000 edits at semicolons spread over the file with
per-Edit alloc; `rust` / `ts` = Doc creation + 400-edit median. `results/rust-alloc.log` is a
diagnostic (counting allocator around 25 `Doc::new`, plus minor faults when GNU time exists); the
env file records glibc and THP settings.

Mac evidence only (Apple M2, not a Linux result; the regression does not reproduce on macOS):

| row                                 | base            | fam             | fix             |
|-------------------------------------|-----------------|-----------------|-----------------|
| Rust Doc::new median                | 4.675 ms        | 4.637 ms        | 4.691 ms        |
| Rust edit median                    | 1.762 ms        | 1.688 ms        | 1.717 ms        |
| Rust Doc::new allocs/reallocs/bytes | 11 / 70 / 23.51 MB | 11 / 40 / 19.45 MB | 11 / 70 / 23.51 MB |
| Go NewDoc alloc / GC                | 10.89 MB / 1.00 | 10.89 MB / 1.00 | 10.89 MB / 1.00 |
| Go Edit median / alloc              | 2354 µs / 9239 KB | 2213 µs / 4718 KB | 2214 µs / 4718 KB |
