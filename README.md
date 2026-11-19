# Go NewDoc Linux closure — artifacts

Generated Go parser sources (goTarget, `typescript.ts`) for the reference set and the fixed master,
plus the unchanged harness used for the original measurement (`main.go.tmpl`, the `best()` harness:
parseWith best of 15, NewDoc best of 15, 200 alternating insert/delete edits best of 7, reused count).

| dir       | commit                               | note |
|-----------|--------------------------------------|------|
| ee11fdf   | before per-Doc engine (pre-regression) | |
| c22b9cc   | regression                           | parser.go byte-identical to ab5cf61 |
| ab5cf61   |                                      | parser.go byte-identical to c22b9cc |
| 6dec677   |                                      | |
| d1fd6c9   | regression, master before PR76       | parser.go byte-identical to 3f08aef |
| 3f08aef   | master before the fix                | parser.go byte-identical to d1fd6c9 |
| aa02d65   | master with the fix (8219338)        | the only new source to measure |

Corpus: the original 270,780-byte `in.ts`, sha256
`65f5f596db0eaeb5d12e3992cd150c9afbd16945e385edb2843dc2a5758eef1d` (not included; use the box copy and
check the hash). `SHA256SUMS` covers every file here; compare the existing box binaries' sources
against it before reusing them.

Build (Go 1.24.4, per dir): `cd <dir>/go && go build -o gb .`

Run: `bash run.sh /path/to/in.ts 7 ee11fdf c22b9cc d1fd6c9 aa02d65` — serial, the listed binaries
alternate within each round, nothing else heavy should run meanwhile. Every line must read
`reused 3000` and no `REJECT`. `stat.py results.log` prints median [min-max] per commit.

Mac reference only (Apple M2, Go 1.26, 7 rounds): NewDoc median ee11fdf 8.63 ms, 3f08aef 9.30 ms,
aa02d65 7.14 ms; parseWith and edit unchanged. Not a Linux result.
