
// Tokenize only: 20 warm-up runs, then the median and min of 101 runs.
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let src = std::fs::read_to_string(&path).unwrap();
    let n = tokenize(&src).len();
    for _ in 0..20 { let _ = tokenize(&src); }
    let mut ts: Vec<f64> = Vec::new();
    for _ in 0..101 { let t = std::time::Instant::now(); let toks = tokenize(&src); ts.push(t.elapsed().as_secs_f64() * 1e3); assert_eq!(toks.len(), n); }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("tokenize {} toks median {:.3} ms  min {:.3} ms", n, ts[ts.len() / 2], ts[0]);
}
