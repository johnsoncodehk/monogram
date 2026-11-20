# Relex-family Linux validation package

Self-contained: needs Go (and optionally rustc / Node ≥ 23.6 for the Rust and TS rows) plus the
original 270,780-byte `in.ts` (sha256 `65f5f596db0eaeb5d12e3992cd150c9afbd16945e385edb2843dc2a5758eef1d`).
No repo checkout.

    ./run.sh /path/to/in.ts 7      # serial; then send results.tgz

| dir  | source                                                                                  |
|------|-----------------------------------------------------------------------------------------|
| base | master 02d8827 (Go parser.go byte-identical to the earlier `cand`, sha256 1fb7d7b0…)     |
| fam  | branch `cursor/relex-scanmeta-family-016d` @ ac70b67 — relex/scanMeta family generated  |

All files are `emitParser(typescript.ts, target)` outputs; see SHA256SUMS.

Rows: `gobench` = the original harness (ParseWith / NewDoc / 200-edit loop); `goprof` = 300 NewDoc
with per-NewDoc alloc + GC cycles; `goedit` = 2000 edits at semicolons spread over the file with
per-Edit alloc; `rust` / `ts` = Doc creation + 400-edit median.

Mac evidence only (Apple M2, go1.26.3, 5 alternating serial rounds, medians; not a Linux result):

| row                  | base     | fam      |
|----------------------|----------|----------|
| Go NewDoc median     | 6.169 ms | 6.165 ms |
| Go NewDoc alloc / GC | 10.89 MB / 1.00 | 10.89 MB / 1.00 |
| Go Edit median       | 2372 µs  | 2233 µs  |
| Go Edit alloc        | 9239 KB  | 4718 KB  |
| Rust Doc::new / edit | 4.685 / 1.779 ms | 4.644 / 1.707 ms |
| TS createDoc / edit  | 54.02 / 6.14 ms  | 54.09 / 6.19 ms  |
