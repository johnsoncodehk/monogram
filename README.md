# Lex-scan family Linux validation package

Self-contained: needs Go (and optionally rustc / Node ≥ 23.6 for the Rust and TS rows) plus the
original 270,780-byte `in.ts` (sha256 `65f5f596db0eaeb5d12e3992cd150c9afbd16945e385edb2843dc2a5758eef1d`).
No repo checkout. The 2 MB tokenize input `tok2mb.ts` is included (2,000,128 bytes, sha256
`297997edb2c33a9f6d5491ef8ed3e5ec6e8b3e17efc86e71b3f4a0d7cdc81866`).

    ./run.sh /path/to/in.ts 7          # serial; then send results.tgz
    node summarize.ts results/results.log   # per row and variant, the median over rounds

| dir  | commit (johnsoncodehk/monogram) | what                                                        |
|------|---------------------------------|-------------------------------------------------------------|
| base | `cbb58a0` master                | before the lex-scan family                                  |
| prev | `ecd5e4c` PR #78                | lex-scan family; Go calls a scanner fn per token            |
| fix  | `52a8f9c` PR #78 head           | Go splices the scanners into the dispatch at generation time |

Every `parser.go` / `parser.ts`, and the parser part of `bench.rs` / `tok.rs`, is
`emitParser(typescript.ts, target)` from that commit. `bench.rs` appends `bench-tail.rs`, and
`tok.rs` appends `tok-tail.rs`. To reproduce and verify against `SHA256SUMS`:

    ./gen.sh /path/to/monogram-clone   # git archive <commit> per VARIANTS → node gen.ts → sha256 -c

`base/parser.go`, `base/parser.ts` and `base/bench.rs` are byte-identical to the previous
package's `base` (master 02d8827; previous package at artifact commit 6e80770), because #79 changed
no emitter. `prev` → `fix` changes only `parser.go`; TS and Rust output is byte-identical.

Rows:
- `gobench`, `goprof`, `goedit`, `rust`, `ts` and `rust-alloc.log`: the same harness files as the
  previous package, unchanged.
- `gotok` / `rstok` / `tstok` (new): tokenize only, on `in.ts` and on `tok2mb.ts`. Each is 20
  warm-up runs, then the median and min of 101 runs.

Mac evidence only (Apple M2, go1.26.3, rustc 1.92, Node 24.15; not a Linux result). Medians over
7 alternating rounds of `run.sh`:

| row                           | base                | prev                | fix                 |
|-------------------------------|---------------------|---------------------|---------------------|
| Go tokenize 2 MB median / min | 14.57 / 14.21 ms    | 15.38 / 14.72 ms    | 15.27 / 14.58 ms    |
| Go tokenize in.ts min         | 2.04 ms             | 2.14 ms             | 2.09 ms             |
| Go NewDoc best (gobench)      | 6.120 ms            | 6.096 ms            | 6.126 ms            |
| Go NewDoc alloc / GC          | 10.89 MB / 1.00     | 10.89 MB / 1.00     | 10.89 MB / 1.00     |
| Go Edit median / alloc        | 2396 µs / 9239 KB   | 2257 µs / 4718 KB   | 2239 µs / 4718 KB   |
| Rust tokenize 2 MB median     | 6.74 ms             | 6.91 ms             | 6.83 ms             |
| Rust Doc::new / edit median   | 4.699 / 1.814 ms    | 4.935 / 1.745 ms    | 4.980 / 1.802 ms    |
| TS tokenize 2 MB min          | 48.07 ms            | 47.49 ms            | 47.61 ms            |
| TS createDoc / edit median    | 55.50 / 6.40 ms     | 55.42 / 6.32 ms     | 52.61 / 6.23 ms     |

The Go tokenize row depends on the harness binary. The same `parser.go` built as `go test`
benchmarks gives these results (Mac, interleaved):
- `Tokenize`, min / p25 / median over 15 runs: base 14.67 / 14.76 / 14.80 ms, prev
  14.92 / 14.96 / 15.01 ms, fix 14.69 / 14.77 / 14.85 ms.
- The internal `lex`, min / p25 over 20 runs: base 11.69 / 11.96 ms, prev 11.85 / 12.11 ms, fix
  11.63 / 11.75 ms.
- Instructions retired by the `gotok` 2 MB process: base 2.97e10, prev 3.07e10 (+3.4%), fix
  2.97–2.99e10.

The Rust `Doc::new` delta comes from the lex-scan family and is the same in `prev` and `fix`
(identical Rust output). Isolated on the Mac, `scan_meta` (one `lex_from` call per token) is
+8% and `lex` +2%. Without `#[inline(always)]` on the scanners, `scan_meta` is +2.5% and `lex`
+15%.
