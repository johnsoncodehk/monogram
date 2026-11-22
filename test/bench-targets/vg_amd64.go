package main

// vgRequest issues one Valgrind client request (args = request code, then five arguments) and
// returns its result; vg_amd64.s.
//
//go:noescape
func vgRequest(args *[6]uint64) uint64
