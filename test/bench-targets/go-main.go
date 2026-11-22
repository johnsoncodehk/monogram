package main

// go-main <fresh|reuse|check> <file>: the Go target's ParseWith timed as test/bench-rust-oxc's
// bench-tail.rs times the Rust one: 3 warm-up parses, then parses until at least 1 s and 5 parses
// have run; prints "<ms per parse> <parses>". fresh = a new CstBuilder per parse; reuse = one kept
// (ParseWith empties and reuses its buffers). The collector runs as it would in a program: its cost
// is part of the parse's. check = one parse, prints ACCEPT or REJECT.
import (
	"fmt"
	"os"
	"time"

	"consumer/parser"
)

var sink any

func main() {
	mode, path := os.Args[1], os.Args[2]
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	src := string(b)
	kept := &parser.CstBuilder{}
	once := func() bool {
		bb := kept
		if mode == "fresh" {
			bb = &parser.CstBuilder{}
		}
		_, ok := parser.ParseWith(src, bb)
		sink = bb
		return ok
	}
	if mode == "check" {
		if once() {
			fmt.Println("ACCEPT")
		} else {
			fmt.Println("REJECT")
		}
		return
	}
	for i := 0; i < 3; i++ {
		once()
	}
	n := 0
	start := time.Now()
	for {
		once()
		n++
		if n >= 5 && time.Since(start) >= time.Second {
			break
		}
	}
	fmt.Printf("%.3f %d\n", float64(time.Since(start).Microseconds())/1000/float64(n), n)
}
