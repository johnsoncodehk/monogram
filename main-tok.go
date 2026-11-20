package main

import (
	"fmt"
	"os"
	"sort"
	"time"

	"bench/parser"
)

// Tokenize only: 20 warm-up runs, then the median and min of 101 runs.
func main() {
	data, _ := os.ReadFile(os.Args[1])
	src := string(data)
	toks, _ := parser.Tokenize(src)
	for i := 0; i < 20; i++ { parser.Tokenize(src) }
	ts := make([]float64, 0, 101)
	for i := 0; i < 101; i++ { t := time.Now(); parser.Tokenize(src); ts = append(ts, float64(time.Since(t).Nanoseconds())/1e6) }
	sort.Float64s(ts)
	fmt.Printf("tokenize %d toks median %.3f ms  min %.3f ms\n", len(toks), ts[len(ts)/2], ts[0])
}
