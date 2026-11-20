package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"sort"
	"time"

	"bench/parser"
)

// NewDoc-only profiling harness: same workload as main.go (best of N NewDoc over in.ts, 1 warmup),
// plus optional CPU / alloc profiles and per-iteration runtime stats.
func main() {
	n := flag.Int("n", 200, "NewDoc iterations")
	cpu := flag.String("cpuprofile", "", "")
	mem := flag.String("memprofile", "", "")
	keep := flag.Int("keep", 0, "keep the last K Docs alive (0 = drop each, as the bench does)")
	flag.Parse()
	data, _ := os.ReadFile(flag.Arg(0))
	src := string(data)
	if _, ok := parser.ParseWith(src, &parser.CstBuilder{}); !ok { fmt.Println("REJECT"); return }
	if *mem != "" { runtime.MemProfileRate = 4096 }
	parser.NewDoc(src)
	if *cpu != "" { f, _ := os.Create(*cpu); pprof.StartCPUProfile(f); defer pprof.StopCPUProfile() }
	var ms0, ms1 runtime.MemStats
	runtime.ReadMemStats(&ms0)
	live := make([]*parser.Doc, *keep)
	ts := make([]float64, *n)
	for i := 0; i < *n; i++ {
		t := time.Now(); d := parser.NewDoc(src); ts[i] = float64(time.Since(t).Nanoseconds()) / 1e6
		if *keep > 0 { live[i%*keep] = d }
	}
	runtime.ReadMemStats(&ms1)
	if *mem != "" { f, _ := os.Create(*mem); pprof.Lookup("allocs").WriteTo(f, 0); f.Close() }
	sort.Float64s(ts)
	k := float64(*n)
	fmt.Printf("newDoc best %.3f ms  median %.3f ms  p90 %.3f ms  | per NewDoc: alloc %.2f MB, %d objs, GCs %.2f, GC pause %.3f ms | HeapSys %.0f MB HeapReleased %.0f MB\n",
		ts[0], ts[len(ts)/2], ts[len(ts)*9/10],
		float64(ms1.TotalAlloc-ms0.TotalAlloc)/k/1e6, (ms1.Mallocs-ms0.Mallocs)/uint64(*n),
		float64(ms1.NumGC-ms0.NumGC)/k, float64(ms1.PauseTotalNs-ms0.PauseTotalNs)/k/1e6,
		float64(ms1.HeapSys)/1e6, float64(ms1.HeapReleased)/1e6)
}
