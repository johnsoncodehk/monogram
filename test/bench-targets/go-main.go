package main

// go-main <fresh|reuse|check|count> <file>: the Go target's ParseWith timed as test/bench-rust-oxc's
// bench-tail.rs times the Rust one: 3 warm-up parses, then parses until at least 1 s and 5 parses
// have run; prints "<ms per parse> <parses>". fresh = a new CstBuilder per parse; reuse = one kept
// (ParseWith empties and reuses its buffers). The collector runs as it would in a program: its cost
// is part of the parse's. check = one parse, prints ACCEPT or REJECT.
//
// count: one parse under Callgrind (test/bench-rust-profile/run.sh), the second parse into the
// builder of a first, collection toggled on and off around it by a client request (vg_amd64.s).
// Prints ACCEPT or REJECT. Deterministic only in the build and environment run.sh gives it:
// `-tags faketime` (the runtime's clock stands still, so sysmon never preempts the parse: a
// preemption runs the scheduler inside the measured region, as often as wall time allows) and
// GOGC=off GOMAXPROCS=1 GODEBUG=asyncpreemptoff=1 (no collector cycles, no preemption signals). The
// map runtime's instructions still vary with the per-process hash seed; go-ir.ts counts them apart.
// A first parse into a new builder is not measured this way: its page allocator's search
// (runtime.(*pageAlloc).find) varied by up to 0.14% between runs of one binary, also without
// address randomization; a fresh parse's allocations are pinned by the alloc-work gate instead.
import (
	"fmt"
	"os"
	"time"

	"consumer/parser"
)

var sink any

// toggleCollect is CALLGRIND_TOGGLE_COLLECT (callgrind.h: VG_USERREQ_TOOL_BASE('C','T') + 2).
func toggleCollect() { vgRequest(&[6]uint64{0x43540002}) }

//go:noinline
func measured(src string, b *parser.CstBuilder) bool {
	toggleCollect()
	_, ok := parser.ParseWith(src, b)
	toggleCollect()
	return ok
}

func verdict(ok bool) {
	if ok {
		fmt.Println("ACCEPT")
	} else {
		fmt.Println("REJECT")
	}
}

func main() {
	mode, path := os.Args[1], os.Args[2]
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	src := string(b)
	kept := &parser.CstBuilder{}
	if mode == "count" {
		parser.ParseWith(src, kept)
		verdict(measured(src, kept))
		sink = kept
		return
	}
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
		verdict(once())
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
