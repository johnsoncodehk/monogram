// Parse-only self-bench for test/profile-portable-peers.mjs (stdin → N iterations → ms/iter).
// Built with a go.mod that `replace`s github.com/microsoft/typescript-go → $TSGO_REPO.
package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/parser"
)

func parse(src string) {
	_ = parser.ParseSourceFile(ast.SourceFileParseOptions{
		FileName: "/bench.js",
		Path:     "/bench.js",
	}, src, core.ScriptKindJS)
}

func main() {
	data, _ := io.ReadAll(os.Stdin)
	src := string(data)
	if len(os.Args) > 1 {
		iters, err := strconv.Atoi(os.Args[1])
		if err != nil || iters <= 0 {
			os.Exit(2)
		}
		for i := 0; i < 3; i++ {
			parse(src)
		}
		t0 := time.Now()
		for i := 0; i < iters; i++ {
			parse(src)
		}
		fmt.Printf("%.4f\n", float64(time.Since(t0).Nanoseconds())/1e6/float64(iters))
		return
	}
	parse(src)
}
