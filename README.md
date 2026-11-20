# Lex-scan family Linux validation package

Self-contained: needs Go (and optionally rustc / Node ≥ 23.6 for the Rust and TS rows) plus the
original 270,780-byte `in.ts` (sha256 `65f5f596db0eaeb5d12e3992cd150c9afbd16945e385edb2843dc2a5758eef1d`).
No repo checkout. The 2 MB tokenize input `tok2mb.ts` is included (2,000,128 bytes, sha256
`297997edb2c33a9f6d5491ef8ed3e5ec6e8b3e17efc86e71b3f4a0d7cdc81866`).

    ./run.sh /path/to/in.ts 7          # serial; then send results.tgz
    node summarize.ts results/results.log   # per row and variant, the median over rounds

| dir   | commit (johnsoncodehk/monogram) | what                                                                 |
|-------|---------------------------------|----------------------------------------------------------------------|
| base  | `cbb58a0` master                | before the lex-scan family                                           |
| fix   | `52a8f9c` PR #78                | lex-scan family; Go splices the scanners at generation time          |
| rsfix | `00917e2` PR #78 head           | + Rust `lex_from` inlined into its per-token callers; shared scanners return -1 for a negative position first |

Every `parser.go` / `parser.ts`, and the parser part of `bench.rs` / `tok.rs`, is
`emitParser(typescript.ts, target)` from that commit. `bench.rs` appends `bench-tail.rs`, and
`tok.rs` appends `tok-tail.rs`. To reproduce and verify against `SHA256SUMS`:

    ./gen.sh /path/to/monogram-clone   # git archive <commit> per VARIANTS → node gen.ts → sha256 -c

`base` is byte-identical to the previous packages' `base` (master 02d8827). The earlier `prev`
variant (`ecd5e4c`) is dropped; its Linux rows are in the previous package (artifact commit a8e1359).

Rows:
- `gobench`, `goprof`, `goedit`, `rust`, `ts` and `rust-alloc.log`: unchanged harness files.
- `gotok` / `rstok` / `tstok`: tokenize only, on `in.ts` and on `tok2mb.ts`. Each is 20 warm-up
  runs, then the median and min of 101 runs.

Mac evidence only (Apple M2, go1.26.3, rustc 1.92, Node 24.15; not a Linux result). Medians over
7 alternating rounds of `run.sh`:

| row                           | base                | fix                 | rsfix               |
|-------------------------------|---------------------|---------------------|---------------------|
| Rust Doc::new median          | 4.686 ms            | 4.875 ms            | 3.998 ms            |
| Rust parse_with / edit median | 3.075 / 1.778 ms    | 3.158 / 1.740 ms    | 3.004 / 1.746 ms    |
| Rust tokenize in.ts / 2 MB    | 0.889 / 6.721 ms    | 0.902 / 6.807 ms    | 0.885 / 6.797 ms    |
| Rust Doc::new allocs          | 11 / 70 / 23.51 MB  | 11 / 70 / 23.51 MB  | 11 / 70 / 23.51 MB  |
| Go NewDoc best (goprof)       | 6.035 ms            | 6.053 ms            | 6.067 ms            |
| Go NewDoc alloc / GC          | 10.89 MB / 1        | 10.89 MB / 1        | 10.89 MB / 1        |
| Go Edit median / alloc        | 2410 µs / 9239 KB   | 2222 µs / 4718 KB   | 2228 µs / 4718 KB   |
| Go tokenize 2 MB median / min | 14.56 / 14.27 ms    | 14.99 / 14.60 ms    | 15.00 / 14.64 ms    |
| TS createDoc / edit median    | 54.50 / 6.16 ms     | 52.90 / 6.18 ms     | 51.74 / 6.38 ms     |
| TS tokenize 2 MB min          | 48.31 ms            | 48.11 ms            | 47.99 ms            |

Rust `Doc::new` per round, rsfix against base: −11.0, −16.7, −14.7, −14.9, −12.4, −14.7, −13.7%
(fix against base: +4.1, +1.2, +4.0, +3.7, +5.7, +4.3, +8.3%).

The Go tokenize row depends on the harness binary. The same `parser.go` as `go test` benchmarks
(`Tokenize` on 2 MB, 5 interleaved rounds): min base 14.65, fix 14.53, rsfix 14.55 ms; median
instructions retired by the `Lex` benchmark process base 4.049e10, fix 4.075e10, rsfix 4.083e10.

Why rsfix: `scan_meta` and the window relex call `lex_from` once per token. Out of line, each
call rebuilds the lexer state on the stack and returns it as a tuple; a profile puts the lex-scan
family's Rust `Doc::new` cost at that per-call boundary (state construction and return), not in
the scanners. Inlined, `Doc::new` instructions drop 1.3255e10 → 1.1665e10 (base 1.2918e10). The
scanner guard (`p < 0` → -1) lets LLVM prove scanner indexes non-negative: Rust `Doc::new`
instructions −1.2% (with `lex_from` inlined), `lex` −1.8%. Same-conditions residue: base with `lex_from` inlined is
1.1509e10 instructions / 3.91 ms, rsfix 1.1665e10 / 3.99 ms (+1.4% / +2%).
