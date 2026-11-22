//go:build !amd64

package main

// vgRequest: the Valgrind client request is written for amd64 only (vg_amd64.s); the count-* modes
// are measured on the amd64 CI runner.
func vgRequest(args *[6]uint64) uint64 { panic("go-main count-* modes need amd64") }
