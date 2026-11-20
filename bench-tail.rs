
fn med(mut v: Vec<f64>) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] }
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let src = std::fs::read_to_string(&path).unwrap();
    let mut pw = Vec::new();
    let mut dn = Vec::new();
    for _ in 0..25 {
        let t = std::time::Instant::now();
        let mut b = CstBuilder::default();
        let r = parse_with(&src, &mut b);
        pw.push(t.elapsed().as_secs_f64() * 1e3);
        assert!(r.is_some());
        let t = std::time::Instant::now();
        let d: Doc = Doc::new(src.clone());
        dn.push(t.elapsed().as_secs_f64() * 1e3);
        assert!(d.root_handle().is_some());
    }
    let mut d: Doc = Doc::new(src.clone());
    let semis: Vec<usize> = src.match_indices(";").map(|(i, _)| i + 1).collect();
    let mut ed = Vec::new();
    let mut reused = 0;
    for i in 0..400 {
        let at = semis[(i * 7919) % semis.len()];
        let e = if i % 2 == 0 { Edit { start: at, end: at, text: " ".into() } } else { Edit { start: semis[((i - 1) * 7919) % semis.len()], end: semis[((i - 1) * 7919) % semis.len()] + 1, text: "".into() } };
        let t = std::time::Instant::now();
        d.edit(&[e]);
        ed.push(t.elapsed().as_secs_f64() * 1e3);
        if d.alignment().map(|a| a.reused).unwrap_or(0) > 0 { reused += 1; }
    }
    assert!(d.root_handle().is_some());
    println!("{}: parse_with {:.3}ms  Doc::new {:.3}ms  edit median {:.4}ms (reused {}/400)", path, med(pw), med(dn), med(ed), reused);
}
