package main

import (
	"fmt"
	"os"
	"time"

	"bench/parser"
)

func best(n int, f func()) float64 {
	f(); m := 1e18
	for i := 0; i < n; i++ { t := time.Now(); f(); d := float64(time.Since(t).Nanoseconds()); if d < m { m = d } }
	return m
}

func main() {
	data, _ := os.ReadFile(os.Args[1])
	src := string(data)
	b := &parser.CstBuilder{}
	if _, ok := parser.ParseWith(src, b); !ok { fmt.Println("REJECT"); return }
	pw := best(15, func() { parser.ParseWith(src, b) }) / 1e6
	nd := best(15, func() { parser.NewDoc(src) }) / 1e6
	d := parser.NewDoc(src)
	pos := len(src) / 2
	for pos < len(src) && src[pos] != '\n' { pos++ }
	pos++
	flip := false
	ed := best(7, func() {
		for i := 0; i < 200; i++ {
			if flip { d.Edit([]parser.Edit{{Start: pos, End: pos + 1, Text: ""}}) } else { d.Edit([]parser.Edit{{Start: pos, End: pos, Text: " "}}) }
			flip = !flip
		}
	}) / 200 / 1e3
	fmt.Printf("parseWith %.3f ms  newDoc %.3f ms  edit %.2f us  reused %d\n", pw, nd, ed, d.Align().Reused)
}
