// Region markers for the execution tracer (test/exec-trace.ts).
//
// In production these are near-free no-ops: they flip a global flag nothing reads, so
// leaving `startTrace()`/`endTrace()` around a region you're optimizing costs nothing.
// The tracer runs an *instrumented* build of the source whose recorded ops are gated on
// that same flag — so the markers bound exactly the executed region that gets printed.
export function startTrace(): void { (globalThis as { __REC?: boolean }).__REC = true; }
export function endTrace(): void { (globalThis as { __REC?: boolean }).__REC = false; }
