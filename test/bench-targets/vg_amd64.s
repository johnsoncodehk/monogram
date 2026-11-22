// The Valgrind client request of valgrind.h for amd64, so that go-main.go's count-* modes turn
// Callgrind's collection on and off around exactly one parse (CALLGRIND_TOGGLE_COLLECT) instead of
// --toggle-collect=<function>: Callgrind decides that a function has returned from the stack
// pointer, and the Go runtime switches stacks (systemstack, morestack), which would end a toggled
// function early. Outside Valgrind the sequence is a no-op (DI is rotated by 128 bits) and the
// request returns its default, 0.
#include "textflag.h"

// func vgRequest(args *[6]uint64) uint64
TEXT ·vgRequest(SB),NOSPLIT,$0-16
	MOVQ args+0(FP), AX
	MOVQ $0, DX
	// rolq $3, %rdi; rolq $13, %rdi; rolq $61, %rdi; rolq $51, %rdi; xchgq %rbx, %rbx
	BYTE $0x48; BYTE $0xc1; BYTE $0xc7; BYTE $0x03
	BYTE $0x48; BYTE $0xc1; BYTE $0xc7; BYTE $0x0d
	BYTE $0x48; BYTE $0xc1; BYTE $0xc7; BYTE $0x3d
	BYTE $0x48; BYTE $0xc1; BYTE $0xc7; BYTE $0x33
	BYTE $0x48; BYTE $0x87; BYTE $0xdb
	MOVQ DX, ret+8(FP)
	RET
