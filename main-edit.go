package main

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"bench/parser"
)

// Edit-only: 2000 edits alternating insert " " / delete it at semicolons spread over the file
// (same pattern as the Rust/TS benches), reporting median time and bytes/allocs per Edit.
func main() {
	data, _ := os.ReadFile(os.Args[1])
	src := string(data)
	d := parser.NewDoc(src)
	var semis []int
	for i := strings.IndexByte(src, ';'); i >= 0; {
		semis = append(semis, i+1)
		j := strings.IndexByte(src[i+1:], ';')
		if j < 0 { break }
		i += 1 + j
	}
	n := 2000
	ts := make([]float64, n)
	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)
	for i := 0; i < n; i++ {
		at := semis[(i*7919)%len(semis)]
		var e parser.Edit
		if i%2 == 0 { e = parser.Edit{Start: at, End: at, Text: " "} } else { p := semis[((i-1)*7919)%len(semis)]; e = parser.Edit{Start: p, End: p + 1, Text: ""} }
		t := time.Now()
		d.Edit([]parser.Edit{e})
		ts[i] = float64(time.Since(t).Nanoseconds()) / 1e3
	}
	runtime.ReadMemStats(&m1)
	if d.Root() < 0 { fmt.Println("REJECT"); return }
	sort.Float64s(ts)
	fmt.Printf("edit median %.1f us  p90 %.1f us | per Edit: alloc %.1f KB, %d objs\n", ts[n/2], ts[n*9/10], float64(m1.TotalAlloc-m0.TotalAlloc)/float64(n)/1e3, (m1.Mallocs-m0.Mallocs)/uint64(n))
}
