
// ── SH3-4 ESTree customs (mirrors shape-typescript.ts) ─────────────────────
fn ts_obj(typ: &'static str, fields: Vec<(&'static str, AstValue)>) -> AstValue {
    AstValue::Object { typ, fields }
}
fn ts_ident(name: &str) -> AstValue { ts_obj("Identifier", vec![("name", AstValue::String(name.to_owned()))]) }
fn ts_lit_str(s: &str) -> AstValue { AstValue::String(s.to_owned()) }
fn ts_lit_num(n: f64) -> AstValue { AstValue::Number(n) }
fn ts_null() -> AstValue { AstValue::Null }
fn ts_arr(xs: Vec<AstValue>) -> AstValue { AstValue::Array(xs) }
fn ts_bool(b: bool) -> AstValue { AstValue::Bool(b) }
fn shape_partial(tag: &'static str, mode: &'static str, value: AstValue) -> AstValue {
    AstValue::Partial { tag, mode, value: Box::new(value) }
}
fn ctx_span<'a>(ctx: &AstCustomCtx<'a>) -> &'a str {
    ctx.src.get(ctx.off..ctx.end).unwrap_or("")
}
fn ctx_prefix<'a>(ctx: &AstCustomCtx<'a>, len: usize) -> &'a str {
    let rest = ctx.src.get(ctx.off..).unwrap_or("");
    rest.get(..len).unwrap_or(rest)
}
fn unhandled(fn_name: &str, ctx: &AstCustomCtx<'_>, identity: Option<&str>) -> ! {
    let suffix = identity.map(|s| s.to_owned()).unwrap_or_else(|| {
        let op = ctx.op_text.map(|o| format!(" opText={:?}", o)).unwrap_or_default();
        format!("altPath={:?}{}", ctx.alt_path, op)
    });
    panic!("shape custom {}: unhandled {}", fn_name, suffix);
}
fn first_kid(kids: &[AstValue]) -> Option<AstValue> { kids.first().cloned() }
fn flat_kids(kids: &[AstValue]) -> Vec<AstValue> {
    let mut out: Vec<AstValue> = Vec::new();
    for k in kids {
        match k {
            AstValue::Array(xs) => out.extend(xs.clone()),
            AstValue::Null => {}
            other => out.push(other.clone()),
        }
    }
    out
}
/// Like TS `flatKids(x ?? [])[0] ?? null`, but also unwrap one extra single-array pack
/// that rust star/opt sometimes leaves as `[[Heritage]]`.
fn first_flat(v: Option<AstValue>) -> AstValue {
    let mut xs = flat_kids(&[v.unwrap_or_else(|| ts_arr(vec![]))]);
    while let Some(AstValue::Array(inner)) = xs.first() {
        if xs.len() != 1 { break; }
        xs = inner.clone();
    }
    xs.into_iter().next().unwrap_or_else(ts_null)
}
/// Approximate JS `String(x)` used by TS keep shapes (Array joins with ',', Object → `[object Object]`).
fn js_string(v: &AstValue) -> String {
    match v {
        AstValue::String(s) => s.clone(),
        AstValue::Number(n) => {
            if n.is_nan() { "NaN".into() }
            else if n.is_infinite() { if n.is_sign_negative() { "-Infinity" } else { "Infinity" }.into() }
            else if *n == 0.0 { "0".into() }
            else { n.to_string() }
        }
        AstValue::Bool(b) => b.to_string(),
        AstValue::Null => "".into(), // JS Array#toString / String(null??'') join slot is empty
        AstValue::Array(xs) => xs.iter().map(js_string).collect::<Vec<_>>().join(","),
        AstValue::Object { .. } | AstValue::Partial { .. } => "[object Object]".into(),
    }
}
fn flat_kids_deep_lists(kids: &[AstValue]) -> Vec<AstValue> {
    // Fully flatten nested array packs from sep/star/opt (heritage lists, etc.).
    fn walk(v: &AstValue, out: &mut Vec<AstValue>) {
        match v {
            AstValue::Null => {}
            AstValue::Array(xs) => for x in xs { walk(x, out); }
            other => out.push(other.clone()),
        }
    }
    let mut out = Vec::new();
    for k in kids { walk(k, &mut out); }
    out
}
fn seq_expr(head: Option<AstValue>, tail: Option<AstValue>) -> Option<AstValue> {
    let mut parts = Vec::new();
    if let Some(h) = head { parts.extend(flat_kids(&[h])); }
    if let Some(t) = tail { parts.extend(flat_kids(&[t])); }
    match parts.len() {
        0 => None,
        1 => Some(parts.into_iter().next().unwrap()),
        _ => Some(ts_obj("SequenceExpression", vec![("expressions", ts_arr(parts))])),
    }
}
fn strip_asi(kids: &[AstValue]) -> Vec<AstValue> {
    kids.iter().filter(|k| !matches!(k, AstValue::Array(xs) if xs.is_empty())).cloned().collect()
}
fn member_expr(obj: AstValue, prop: AstValue, computed: bool) -> AstValue {
    let p = match &prop {
        AstValue::String(s) => ts_ident(s),
        other => other.clone(),
    };
    ts_obj("MemberExpression", vec![
        ("object", obj), ("property", p), ("computed", ts_bool(computed)), ("optional", ts_bool(false)),
    ])
}
fn call_expr(callee: AstValue, args: Vec<AstValue>) -> AstValue {
    ts_obj("CallExpression", vec![("callee", callee), ("arguments", ts_arr(args))])
}
fn unary_expr(op: &str, arg: AstValue) -> AstValue {
    ts_obj("UnaryExpression", vec![("operator", ts_lit_str(op)), ("argument", arg), ("prefix", ts_bool(true))])
}
fn binary_expr(left: AstValue, op: &str, right: AstValue) -> AstValue {
    ts_obj("BinaryExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
}
fn update_expr(op: &str, arg: AstValue, prefix: bool) -> AstValue {
    ts_obj("UpdateExpression", vec![("operator", ts_lit_str(op)), ("argument", arg), ("prefix", ts_bool(prefix))])
}
fn arrow_fn(params: Vec<AstValue>, body: AstValue, async_: bool) -> AstValue {
    let expression = match &body {
        AstValue::Object { typ, .. } => *typ != "BlockStatement",
        _ => true,
    };
    ts_obj("ArrowFunctionExpression", vec![
        ("params", ts_arr(params)), ("body", body), ("async", ts_bool(async_)), ("expression", ts_bool(expression)),
    ])
}
fn head_is_new(v: &AstValue) -> bool {
    match v {
        AstValue::String(s) => s == "new",
        AstValue::Object { typ, fields, .. } if *typ == "Identifier" => {
            fields.iter().any(|(k, v)| *k == "name" && matches!(v, AstValue::String(s) if s == "new"))
        }
        _ => false,
    }
}
fn tpl_raw(kind: &str, text: &str) -> String {
    let open = "`"; let i_open = "${"; let i_close = "}";
    if kind == "nosubst" {
        return if text.starts_with(open) && text.ends_with(open) {
            text[open.len()..text.len() - open.len()].to_owned()
        } else { text.to_owned() };
    }
    let mut s = text.to_owned();
    if kind == "head" {
        if s.starts_with(open) { s = s[open.len()..].to_owned(); }
        if s.ends_with(i_open) { s = s[..s.len() - i_open.len()].to_owned(); }
        return s;
    }
    if kind == "middle" {
        if s.starts_with(i_close) { s = s[i_close.len()..].to_owned(); }
        if s.ends_with(i_open) { s = s[..s.len() - i_open.len()].to_owned(); }
        return s;
    }
    if s.starts_with(i_close) { s = s[i_close.len()..].to_owned(); }
    if s.ends_with(open) { s = s[..s.len() - open.len()].to_owned(); }
    s
}
fn estree_optional_chain(left: AstValue, kids: &[AstValue]) -> AstValue {
    let k0 = kids.first().cloned();
    match k0 {
        Some(AstValue::Array(k0)) => {
            if let Some(AstValue::Array(ref inner)) = k0.first() {
                let args = k0.get(1).and_then(|a| match a { AstValue::Array(xs) => Some(xs.clone()), _ => None }).unwrap_or_default();
                let mut fields = vec![("callee", left), ("arguments", ts_arr(args)), ("optional", ts_bool(true))];
                fields.push(("typeArguments", AstValue::Array(inner.clone())));
                ts_obj("CallExpression", fields)
            } else {
                let mut o = call_expr(left, k0);
                if let AstValue::Object { ref mut fields, .. } = o { fields.push(("optional", ts_bool(true))); }
                o
            }
        }
        Some(AstValue::String(ref s)) if s.starts_with('`') => {
            ts_obj("TaggedTemplateExpression", vec![("tag", left), ("quasi", AstValue::String(s.clone()))])
        }
        Some(ref v) if matches!(v, AstValue::Object { typ, .. } if *typ == "TemplateLiteral") => {
            ts_obj("TaggedTemplateExpression", vec![("tag", left), ("quasi", v.clone())])
        }
        Some(AstValue::String(ref s)) => {
            let mut o = member_expr(left, AstValue::String(s.clone()), false);
            if let AstValue::Object { ref mut fields, .. } = o { fields.push(("optional", ts_bool(true))); }
            o
        }
        other => {
            let mut o = member_expr(left, other.unwrap_or(ts_lit_str("undefined")), true);
            if let AstValue::Object { ref mut fields, .. } = o { fields.push(("optional", ts_bool(true))); }
            o
        }
    }
}
const ASSIGN_OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "??=", "||=", "&&="];
const LOGICAL_OPS: &[&str] = &["??", "||", "&&"];
const UPDATE_OPS: &[&str] = &["++", "--"];
const BINARY_OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "??=", "||=", "&&=", "??", "||", "&&", "|", "^", "&", "==", "!=", "===", "!==", "<", ">", "<=", ">=", "<<", ">>", ">>>", "+", "-", "*", "/", "%", "**"];
const PREFIX_OPS: &[&str] = &["!", "~", "+", "-", "typeof", "void", "delete", "await", "yield", "++", "--"];

fn estree_stmt(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let k = &ctx.kids;
    match arm {
        Some(0) => {
            if let Some(body) = first_kid(k) {
                if let AstValue::Object { typ, .. } = &body {
                    if *typ == "BlockStatement" { return body; }
                }
                return ts_obj("BlockStatement", vec![("body", ts_arr(flat_kids(&[body])))]);
            }
            ts_obj("BlockStatement", vec![("body", ts_arr(flat_kids(k)))])
        }
        Some(1) => {
            let kind = if ctx_prefix(ctx, 5).starts_with("const") { "const" }
                else if ctx_prefix(ctx, 3).starts_with("let") { "let" } else { "var" };
            ts_obj("VariableDeclaration", vec![("kind", ts_lit_str(kind)), ("declarations", ts_arr(flat_kids(k)))])
        }
        Some(2) => ts_obj("IfStatement", vec![
            ("test", seq_expr(k.get(0).cloned(), k.get(1).cloned()).unwrap_or(ts_null())),
            ("consequent", k.get(2).cloned().unwrap_or(ts_null())),
            ("alternate", k.get(3).cloned().unwrap_or(ts_null())),
        ]),
        Some(3) => {
            let body = k.get(1).cloned().unwrap_or(ts_null());
            if let Some(AstValue::Object { fields, .. }) = k.get(0) {
                let kind = fields.iter().find(|(n,_)| *n == "kind").and_then(|(_,v)| match v { AstValue::String(s) => Some(s.as_str()), _ => None });
                if kind == Some("in") {
                    return ts_obj("ForInStatement", vec![
                        ("left", fields.iter().find(|(n,_)| *n == "left").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                        ("right", fields.iter().find(|(n,_)| *n == "right").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                        ("body", body),
                    ]);
                }
                if kind == Some("of") {
                    let await_ = fields.iter().any(|(n, v)| *n == "await" && matches!(v, AstValue::Bool(true)));
                    return ts_obj("ForOfStatement", vec![
                        ("left", fields.iter().find(|(n,_)| *n == "left").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                        ("right", fields.iter().find(|(n,_)| *n == "right").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                        ("body", body), ("await", ts_bool(await_)),
                    ]);
                }
                return ts_obj("ForStatement", vec![
                    ("init", fields.iter().find(|(n,_)| *n == "init").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                    ("test", fields.iter().find(|(n,_)| *n == "test").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                    ("update", fields.iter().find(|(n,_)| *n == "update").map(|(_,v)| v.clone()).unwrap_or(ts_null())),
                    ("body", body),
                ]);
            }
            ts_obj("ForStatement", vec![("init", ts_null()), ("test", ts_null()), ("update", ts_null()), ("body", body)])
        }
        Some(4) => ts_obj("WhileStatement", vec![
            ("test", seq_expr(k.get(1).cloned(), k.get(2).cloned()).unwrap_or(ts_null())),
            ("body", k.get(3).cloned().unwrap_or(ts_null())),
        ]),
        Some(5) => ts_obj("DoWhileStatement", vec![
            ("body", k.get(0).cloned().unwrap_or(ts_null())),
            ("test", seq_expr(k.get(2).cloned(), k.get(3).cloned()).unwrap_or(ts_null())),
        ]),
        Some(6) => {
            let cases_k = k.get(2).or_else(|| k.get(1));
            let cases = cases_k.map(|c| flat_kids(&[c.clone()])).unwrap_or_default();
            ts_obj("SwitchStatement", vec![
                ("discriminant", k.get(0).cloned().unwrap_or(ts_null())),
                ("cases", ts_arr(cases)),
            ])
        }
        Some(7) => ts_obj("ReturnStatement", vec![("argument", seq_expr(k.get(0).cloned(), k.get(1).cloned()).unwrap_or(ts_null()))]),
        Some(8) => ts_obj("ThrowStatement", vec![("argument", seq_expr(k.get(0).cloned(), k.get(1).cloned()).unwrap_or(ts_null()))]),
        Some(9) => ts_obj("BreakStatement", vec![("label", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(10) => ts_obj("ContinueStatement", vec![("label", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(11) => ts_obj("TryStatement", vec![
            ("block", k.get(0).cloned().unwrap_or(ts_null())),
            ("handler", k.get(1).cloned().unwrap_or(ts_null())),
            ("finalizer", k.get(2).cloned().unwrap_or(ts_null())),
        ]),
        Some(12) => ts_obj("LabeledStatement", vec![
            ("label", ts_ident(&match k.get(0) { Some(AstValue::String(s)) => s.clone(), _ => String::new() })),
            ("body", k.get(1).cloned().unwrap_or(ts_null())),
        ]),
        Some(13) => ts_obj("EmptyStatement", vec![]),
        Some(14) => ts_obj("DebuggerStatement", vec![]),
        Some(15) => ts_obj("WithStatement", vec![
            ("object", k.get(1).cloned().unwrap_or(ts_null())),
            ("body", k.get(2).cloned().unwrap_or(ts_null())),
        ]),
        Some(16) => ts_obj("VariableDeclaration", vec![("kind", ts_lit_str("using")), ("declarations", ts_arr(flat_kids(&[k.last().cloned().unwrap_or(ts_null())]))) ]),
        Some(17) => first_kid(k).unwrap_or_else(|| k.get(0).cloned().unwrap_or(ts_null())),
        Some(18) => {
            let expr = strip_asi(k).into_iter().next().unwrap_or(ts_null());
            ts_obj("ExpressionStatement", vec![("expression", expr)])
        }
        _ => unhandled("estreeStmt", ctx, None),
    }
}

fn estree_decl(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let k = &ctx.kids;
    match arm {
        Some(17) => ts_obj("ExportNamedDeclaration", vec![("declaration", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(18) => ts_obj("ExportNamedDeclaration", vec![("specifiers", ts_arr(flat_kids(k)))]),
        Some(19) => ts_obj("ExportAllDeclaration", vec![("source", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(20) => ts_obj("ExportDefaultDeclaration", vec![("declaration", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(21) => ts_obj("ImportDeclaration", vec![
            ("specifiers", ts_arr(match k.get(1) {
                Some(v) => flat_kids(&[v.clone()]),
                None => flat_kids(k),
            })),
            ("source", k.get(2).or_else(|| k.get(1)).cloned().unwrap_or(ts_null())),
        ]),
        Some(22) => ts_obj("TSImportEqualsDeclaration", vec![("id", k.get(0).cloned().unwrap_or(ts_null())), ("moduleReference", k.get(1).cloned().unwrap_or(ts_null()))]),
        Some(23) => ts_obj("TSModuleDeclaration", vec![("id", k.get(0).cloned().unwrap_or(ts_null())), ("body", k.get(1).cloned().unwrap_or(ts_null()))]),
        Some(24) => ts_obj("TSModuleDeclaration", vec![("id", k.get(0).cloned().unwrap_or(ts_null())), ("body", k.get(1).cloned().unwrap_or(ts_null())), ("declare", ts_bool(true))]),
        Some(25) => ts_obj("TSNamespaceExportDeclaration", vec![("id", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(26) => ts_obj("TSEnumDeclaration", vec![("id", k.get(0).cloned().unwrap_or(ts_null())), ("members", ts_arr(flat_kids(&[k.get(1).cloned().unwrap_or(ts_arr(vec![]))])))]),
        Some(27) => ts_obj("TSInterfaceDeclaration", vec![("id", k.get(0).cloned().unwrap_or(ts_null())), ("body", k.get(1).cloned().unwrap_or(ts_null()))]),
        Some(4) => ts_obj("TSInterfaceDeclaration", vec![
            ("id", k.get(0).cloned().unwrap_or(ts_null())),
            ("typeParameters", k.get(1).cloned().unwrap_or(ts_null())),
            ("extends", ts_arr(flat_kids_deep_lists(&[k.get(2).cloned().unwrap_or(ts_arr(vec![]))]))),
            ("body", ts_obj("TSInterfaceBody", vec![("body", ts_arr(flat_kids(&[k.get(3).cloned().unwrap_or(ts_arr(vec![]))])))])),
        ]),
        Some(5) => ts_obj("TSTypeAliasDeclaration", vec![
            ("id", k.get(0).cloned().unwrap_or(ts_null())),
            ("typeParameters", k.get(1).cloned().unwrap_or(ts_null())),
            ("typeAnnotation", k.get(2).cloned().unwrap_or(ts_null())),
        ]),
        Some(6) => ts_obj("ClassDeclaration", vec![
            ("decorators", ts_arr(flat_kids(&[k.get(0).cloned().unwrap_or(ts_arr(vec![]))]))),
            ("id", k.get(1).cloned().unwrap_or(ts_null())),
            ("superClass", first_flat(k.get(3).cloned())),
            ("body", ts_obj("ClassBody", vec![("body", ts_arr(flat_kids(&[k.get(4).cloned().unwrap_or(ts_arr(vec![]))])))])),
        ]),
        Some(0) | Some(1) | Some(2) | Some(3) => {
            let async_ = arm == Some(1) || arm == Some(3);
            let gen = arm == Some(2) || arm == Some(3);
            ts_obj("FunctionDeclaration", vec![
                ("async", ts_bool(async_)), ("generator", ts_bool(gen)),
                ("id", k.get(0).cloned().unwrap_or(ts_null())),
                ("typeParameters", k.get(1).cloned().unwrap_or(ts_null())),
                ("params", ts_arr(flat_kids(&[k.get(2).cloned().unwrap_or(ts_arr(vec![]))]))),
                ("returnType", k.get(3).cloned().unwrap_or(ts_null())),
                ("body", k.get(4).cloned().unwrap_or(ts_null())),
            ])
        }
        Some(15) | Some(16) => {
            let inner_arm = if arm == Some(15) { 0usize } else { 6 };
            let inner = estree_decl(&AstCustomCtx { name: ctx.name, rule: ctx.rule, src: ctx.src, kids: ctx.kids.clone(), alt_path: vec![inner_arm], off: ctx.off, end: ctx.end, left: ctx.left.clone(), op_text: ctx.op_text, state: ctx.state.clone() });
            ts_obj("ExportNamedDeclaration", vec![("declaration", inner)])
        }
        Some(14) => {
            // In the TS reference `{ type: 'TSDeclareFunction', ...FunctionDeclaration }`,
            // the spread's `type` wins.
            estree_decl(&AstCustomCtx { name: ctx.name, rule: ctx.rule, src: ctx.src, kids: ctx.kids.clone(), alt_path: vec![0], off: ctx.off, end: ctx.end, left: ctx.left.clone(), op_text: ctx.op_text, state: ctx.state.clone() })
        }
        Some(a) if (7..=13).contains(&a) => ts_obj("Declaration", vec![("alt", ts_lit_num(a as f64)), ("children", ts_arr(ctx.kids.clone()))]),
        _ => unhandled("estreeDecl", ctx, None),
    }
}

fn estree_paren_or_comma(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 20 { unhandled("estreeParenOrComma", ctx, None); }
    if arm == Some(7) { return ts_obj("MetaProperty", vec![("meta", ts_ident("new")), ("property", ts_ident("target"))]); }
    let parts = flat_kids(&ctx.kids);
    if parts.len() == 1 { parts.into_iter().next().unwrap() }
    else { ts_obj("SequenceExpression", vec![("expressions", ts_arr(parts))]) }
}

fn estree_expr_binary(ctx: &AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    if !BINARY_OPS.contains(&op) { unhandled("estreeExprBinary", ctx, None); }
    let right = ctx.kids.first().cloned().unwrap_or(ts_null());
    let left = ctx.left.clone().unwrap_or(ts_null());
    if ASSIGN_OPS.contains(&op) {
        ts_obj("AssignmentExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
    } else if LOGICAL_OPS.contains(&op) {
        ts_obj("LogicalExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
    } else {
        ts_obj("BinaryExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
    }
}

fn estree_expr_prefix(ctx: &AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    if !PREFIX_OPS.contains(&op) { unhandled("estreeExprPrefix", ctx, None); }
    let argument = ctx.kids.first().cloned().unwrap_or(ts_null());
    if UPDATE_OPS.contains(&op) { update_expr(op, argument, true) } else { unary_expr(op, argument) }
}

fn estree_expr_postfix_tok(ctx: &AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    if !op.starts_with('`') { unhandled("estreeExprPostfixTok", ctx, None); }
    ts_obj("TaggedTemplateExpression", vec![
        ("tag", ctx.left.clone().unwrap_or(ts_null())),
        ("quasi", ctx.kids.first().cloned().unwrap_or(ts_null())),
    ])
}

fn estree_template_literal(ctx: &AstCustomCtx<'_>) -> AstValue {
    let kids = &ctx.kids;
    if kids.len() == 1 {
        if let AstValue::String(ref s) = kids[0] {
            return ts_obj("TemplateLiteral", vec![
                ("quasis", ts_arr(vec![ts_obj("TemplateElement", vec![
                    ("value", ts_obj("", vec![("raw", ts_lit_str(&tpl_raw("nosubst", s)))])),
                    ("tail", ts_bool(true)),
                ])])),
                ("expressions", ts_arr(vec![])),
            ]);
        }
    }
    if kids.len() < 3 || kids.len() % 2 == 0 { unhandled("estreeTemplateLiteral", ctx, None); }
    let mut quasis = Vec::new();
    let mut expressions = Vec::new();
    for (i, k) in kids.iter().enumerate() {
        if i % 2 == 0 {
            let text = match k { AstValue::String(s) => s.as_str(), _ => unhandled("estreeTemplateLiteral", ctx, None) };
            let is_head = i == 0;
            let is_tail = i == kids.len() - 1;
            let kind = if is_head { "head" } else if is_tail { "tail" } else { "middle" };
            quasis.push(ts_obj("TemplateElement", vec![
                ("value", ts_obj("", vec![("raw", ts_lit_str(&tpl_raw(kind, text)))])),
                ("tail", ts_bool(is_tail)),
            ]));
        } else {
            expressions.push(k.clone());
        }
    }
    ts_obj("TemplateLiteral", vec![("quasis", ts_arr(quasis)), ("expressions", ts_arr(expressions))])
}

fn estree_expr_led(ctx: &AstCustomCtx<'_>) -> AstValue {
    let left = ctx.left.clone().unwrap_or(ts_null());
    let op = ctx.op_text.unwrap_or("");
    let arm = ctx.alt_path.first().copied();
    let slots = flat_kids(&ctx.kids);
    match arm {
        Some(0) | Some(2) => {
            let args = if slots.len() == 1 {
                if let AstValue::Array(ref xs) = slots[0] { xs.clone() } else { slots.clone() }
            } else { slots.clone() };
            call_expr(left, args.into_iter().filter(|x| !matches!(x, AstValue::Null)).collect())
        }
        Some(1) => ts_obj("TSInstantiationExpression", vec![
            ("expression", left),
            ("typeArguments", slots.get(0).cloned().unwrap_or(ts_arr(slots.clone()))),
        ]),
        Some(3) => member_expr(left, slots.get(0).cloned().unwrap_or(ts_lit_str("undefined")), false),
        Some(4) => estree_optional_chain(left, &ctx.kids),
        Some(5) => member_expr(left, slots.get(0).cloned().unwrap_or(ts_lit_str("undefined")), true),
        Some(6) => ts_obj("TSNonNullExpression", vec![("expression", left)]),
        Some(7) => ts_obj("ConditionalExpression", vec![
            ("test", left),
            ("consequent", slots.get(0).cloned().unwrap_or(ts_null())),
            ("alternate", slots.get(1).cloned().unwrap_or(ts_null())),
        ]),
        Some(8) => ts_obj("TSAsExpression", vec![("expression", left), ("typeAnnotation", slots.get(0).cloned().unwrap_or(ts_null()))]),
        Some(9) => binary_expr(left, "instanceof", slots.get(0).cloned().unwrap_or(ts_null())),
        Some(10) => binary_expr(left, "in", slots.get(0).cloned().unwrap_or(ts_null())),
        Some(11) => ts_obj("TSSatisfiesExpression", vec![("expression", left), ("typeAnnotation", slots.get(0).cloned().unwrap_or(ts_null()))]),
        _ => unhandled("estreeExprLed", ctx, Some(&format!("LED altPath={:?} opText={:?}", ctx.alt_path, op))),
    }
}

fn estree_expr_nud_seq(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => match ctx.kids.first() {
            Some(AstValue::String(s)) => ts_ident(s),
            Some(other) => other.clone(),
            None => ts_null(),
        },
        Some(1) | Some(2) => ts_obj("ClassExpression", vec![
            ("decorators", ts_arr(flat_kids(&[ctx.kids.get(0).cloned().unwrap_or(ts_arr(vec![]))]))),
            ("id", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("body", ts_obj("ClassBody", vec![("body", ts_arr(flat_kids(ctx.kids.get(3..).unwrap_or(&[]))))])),
        ]),
        _ => unhandled("estreeExprNudSeq", ctx, None),
    }
}

fn estree_arrow(ctx: &AstCustomCtx<'_>) -> AstValue {
    let async_ = ctx_span(ctx).trim_start().starts_with("async");
    let arm = ctx.alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 3 { unhandled("estreeArrow", ctx, None); }
    let params = if arm == Some(1) || arm == Some(2) {
        flat_kids(&[ctx.kids.get(1).cloned().unwrap_or(ts_arr(vec![]))])
    } else {
        let p = ctx.kids.first().cloned().unwrap_or(ts_null());
        vec![match p { AstValue::String(s) => ts_ident(&s), other => other }]
    };
    let body = ctx.kids.last().cloned().unwrap_or(ts_null());
    arrow_fn(params, body, async_)
}

fn ts_type_led(ctx: &AstCustomCtx<'_>) -> AstValue {
    if ctx.op_text.is_none() {
        let arm = ctx.alt_path.first().copied();
        if arm == Some(7) { return ts_obj("TSTypeLiteral", vec![("members", ts_arr(flat_kids(&ctx.kids)))]); }
        if arm.is_none() || arm.unwrap() > 20 {
            unhandled("tsTypeLed", ctx, Some(&format!("group altPath={:?}", ctx.alt_path)));
        }
        let head = ctx.kids.first().map(js_string).unwrap_or_default();
        return ts_obj("Type", vec![
            ("children", ts_arr(ctx.kids.clone())),
            ("headText", ts_lit_str(&head)),
            ("off", ts_lit_num(ctx.off as f64)),
            ("end", ts_lit_num(ctx.end as f64)),
        ]);
    }
    let op = ctx.op_text.unwrap_or("");
    let left = ctx.left.clone().unwrap_or(ts_null());
    if op == "extends" {
        ts_obj("TSConditionalType", vec![
            ("checkType", left),
            ("extendsType", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("trueType", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("falseType", ctx.kids.get(2).cloned().unwrap_or(ts_null())),
        ])
    } else if op == "[" {
        ts_obj("TSIndexedAccessType", vec![("objectType", left), ("indexType", ctx.kids.get(0).cloned().unwrap_or(ts_null()))])
    } else if op == "<" || op == "|" || op == "&" || op == "." || op == "?" || op == "!" {
        ts_obj("TSTypeReference", vec![
            ("typeName", left),
            ("typeParameters", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("meta", ts_obj("", vec![("op", ts_lit_str(op))])),
        ])
    } else {
        unhandled("tsTypeLed", ctx, Some(&format!("LED altPath={:?} opText={:?}", ctx.alt_path, op)))
    }
}

fn estree_new_target_led(ctx: &AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    let left = ctx.left.clone().unwrap_or(ts_null());
    if op == "." && matches!(ctx.kids.first(), Some(AstValue::String(s)) if s == "target") && head_is_new(&left) {
        return ts_obj("MetaProperty", vec![("meta", ts_ident("new")), ("property", ts_ident("target"))]);
    }
    if op == "." { member_expr(left, ctx.kids.first().cloned().unwrap_or(ts_lit_str("undefined")), false) }
    else if op == "[" { member_expr(left, ctx.kids.first().cloned().unwrap_or(ts_lit_str("undefined")), true) }
    else { unhandled("estreeNewTargetLed", ctx, None) }
}

fn estree_array_pattern(ctx: &AstCustomCtx<'_>) -> AstValue {
    if ctx.alt_path.first().copied() != Some(1) { unhandled("estreeArrayPattern", ctx, None); }
    let mut elems = Vec::new();
    for k in &ctx.kids {
        match k {
            AstValue::Array(xs) => elems.extend(xs.iter().map(|x| if matches!(x, AstValue::Null) { ts_null() } else { x.clone() })),
            other => elems.push(other.clone()),
        }
    }
    ts_obj("ArrayPattern", vec![("elements", ts_arr(elems))])
}

fn estree_binding_property(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let a = ctx.kids.get(0).cloned().unwrap_or(ts_null());
    let b = ctx.kids.get(1).cloned().unwrap_or(ts_null());
    match arm {
        Some(1) => ts_obj("Property", vec![
            ("key", ts_ident(&match &a { AstValue::String(s) => s.clone(), _ => String::new() })),
            ("value", ts_ident(&match &a { AstValue::String(s) => s.clone(), _ => String::new() })),
            ("kind", ts_lit_str("init")), ("method", ts_bool(false)), ("shorthand", ts_bool(true)), ("computed", ts_bool(false)),
        ]),
        Some(3) => ts_obj("RestElement", vec![("argument", a)]),
        Some(2) => ts_obj("Property", vec![
            ("key", a), ("value", b), ("kind", ts_lit_str("init")), ("method", ts_bool(false)),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(true)),
        ]),
        Some(0) => ts_obj("Property", vec![
            ("key", match &a { AstValue::String(s) => ts_ident(s), other => other.clone() }),
            ("value", b), ("kind", ts_lit_str("init")), ("method", ts_bool(false)),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(false)),
        ]),
        _ => unhandled("estreeBindingProperty", ctx, None),
    }
}

fn estree_param(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => {
            let mut o = ts_obj("Identifier", vec![("name", ts_lit_str("this"))]);
            if let AstValue::Object { ref mut fields, .. } = o {
                fields.push(("typeAnnotation", ctx.kids.get(0).cloned().unwrap_or(ts_null())));
            }
            o
        }
        Some(1) | Some(2) => {
            let id = ctx.kids.get(ctx.kids.len().saturating_sub(2)).or_else(|| ctx.kids.first()).cloned().unwrap_or(ts_null());
            let (typ, mut fields): (&'static str, Vec<(&'static str, AstValue)>) = match &id {
                AstValue::String(s) => ("Identifier", vec![("name", ts_lit_str(s))]),
                AstValue::Object { typ, fields: fs } => (
                    if typ.is_empty() { "Identifier" } else { typ },
                    fs.clone(),
                ),
                _ => ("Identifier", vec![("name", ts_lit_str(""))]),
            };
            fields.push(("decorators", ts_arr(flat_kids(&[ctx.kids.get(0).cloned().unwrap_or(ts_arr(vec![]))]))));
            fields.push(("optional", ts_bool(arm == Some(1))));
            AstValue::Object { typ, fields }
        }
        _ => unhandled("estreeParam", ctx, None),
    }
}

fn estree_for_head(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("classic")),
            ("init", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("test", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("update", ctx.kids.get(2).cloned().unwrap_or(ts_null())),
        ]),
        Some(1) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("classic")),
            ("init", seq_expr(ctx.kids.get(0).cloned(), None).unwrap_or(ts_null())),
            ("test", seq_expr(ctx.kids.get(1).cloned(), None).unwrap_or(ts_null())),
            ("update", seq_expr(ctx.kids.get(2).cloned(), None).unwrap_or(ts_null())),
        ]),
        Some(2) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("in")),
            ("left", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("right", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
        ]),
        Some(3) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("of")),
            ("left", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("right", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("await", ts_bool(ctx_prefix(ctx, 5).contains("await"))),
        ]),
        _ => unhandled("estreeForHead", ctx, None),
    }
}

fn estree_switch_case(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(2) => shape_partial("switch-consequent", "append", first_kid(&ctx.kids).unwrap_or(ts_null())),
        Some(1) => shape_partial("switch-consequent", "start", ts_obj("SwitchCase", vec![
            ("test", ts_null()), ("consequent", ts_arr(vec![])),
        ])),
        Some(0) => shape_partial("switch-consequent", "start", ts_obj("SwitchCase", vec![
            ("test", seq_expr(ctx.kids.get(0).cloned(), ctx.kids.get(1).cloned()).unwrap_or(ts_null())),
            ("consequent", ts_arr(vec![])),
        ])),
        _ => unhandled("estreeSwitchCase", ctx, None),
    }
}

fn estree_decorator(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 1 { unhandled("estreeDecorator", ctx, None); }
    let chain = flat_kids(&ctx.kids);
    let head = chain.first().cloned().unwrap_or(ts_null());
    let mut expr = match &head {
        AstValue::String(s) if s.starts_with('@') => ts_ident(&s[1..]),
        other => other.clone(),
    };
    for step in chain.iter().skip(1) {
        match step {
            AstValue::Array(xs) => expr = call_expr(expr, xs.clone()),
            AstValue::Object { .. } => expr = call_expr(expr, vec![step.clone()]),
            other => expr = member_expr(expr, other.clone(), false),
        }
    }
    ts_obj("Decorator", vec![("expression", expr)])
}

fn estree_class_member(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => ts_null(),
        Some(1) => ts_obj("MethodDefinition", vec![
            ("kind", ts_lit_str("constructor")), ("key", ts_ident("constructor")),
            ("value", ts_obj("FunctionExpression", vec![
                ("params", ts_arr(flat_kids(&[ctx.kids.get(0).cloned().unwrap_or(ts_arr(vec![]))]))),
                ("body", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ])),
            ("static", ts_bool(false)),
        ]),
        Some(2) => ts_obj("StaticBlock", vec![("body", ctx.kids.get(0).cloned().unwrap_or(ts_null()))]),
        Some(4) => ts_obj("PropertyDefinition", vec![
            ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("value", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("static", ts_bool(false)), ("readonly", ts_bool(false)),
        ]),
        Some(3) | Some(5) => {
            let nested = ctx.alt_path.get(1).copied();
            if arm == Some(3) && nested == Some(8) {
                let branch = ctx.kids.get(1).and_then(|b| match b { AstValue::Array(xs) => Some(xs.clone()), _ => None }).unwrap_or_default();
                let tail = branch.get(1).and_then(|b| match b { AstValue::Array(xs) => Some(xs.clone()), _ => None }).unwrap_or_default();
                return ts_obj("MethodDefinition", vec![
                    ("kind", ts_lit_str("method")),
                    ("key", branch.get(0).cloned().unwrap_or(ts_null())),
                    ("value", ts_obj("FunctionExpression", vec![
                        ("params", ts_arr(flat_kids(&[tail.get(1).cloned().unwrap_or(ts_arr(vec![]))]))),
                        ("body", tail.get(3).cloned().unwrap_or(ts_null())),
                        ("async", ts_bool(false)), ("generator", ts_bool(false)),
                    ])),
                    ("static", ts_bool(false)), ("computed", ts_bool(false)),
                ]);
            }
            if arm == Some(5) {
                return ts_obj("MethodDefinition", vec![
                    ("kind", ts_lit_str("method")),
                    ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                    ("value", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
                    ("static", ts_bool(true)),
                ]);
            }
            if nested.map(|n| n <= 8).unwrap_or(false) {
                return ts_obj("MethodDefinition", vec![
                    ("kind", ts_lit_str("method")),
                    ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                    ("value", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
                    ("static", ts_bool(false)),
                ]);
            }
            unhandled("estreeClassMember", ctx, None)
        }
        _ => unhandled("estreeClassMember", ctx, None),
    }
}

fn ts_interface_member(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => {
            let construct = ctx_span(ctx).trim_start().starts_with("new");
            let typ = if construct { "TSConstructSignatureDeclaration" } else { "TSCallSignatureDeclaration" };
            ts_obj(typ, vec![
                ("typeParameters", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                ("params", ts_arr(flat_kids(&[ctx.kids.get(1).cloned().unwrap_or(ts_arr(vec![]))]))),
                ("returnType", ctx.kids.get(2).cloned().unwrap_or(ts_null())),
            ])
        }
        Some(1) => ts_obj("TSMethodSignature", vec![
            ("kind", ts_lit_str(ctx_prefix(ctx, 3))),
            ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("params", ts_arr(flat_kids(&[ctx.kids.get(1).cloned().unwrap_or(ts_arr(vec![]))]))),
            ("returnType", ctx.kids.get(2).cloned().unwrap_or(ts_null())),
        ]),
        Some(2) => ts_obj("TSMappedType", vec![
            ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("constraint", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("typeAnnotation", ctx.kids.last().cloned().unwrap_or(ts_null())),
        ]),
        Some(3) => ts_obj("TSPropertySignature", vec![
            ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("typeAnnotation", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("optional", ts_bool(ctx.src.contains('?'))), ("readonly", ts_bool(true)),
        ]),
        Some(4) => {
            let method = ctx.kids.get(2).map(|k| matches!(k, AstValue::Array(_))).unwrap_or(false);
            if method {
                ts_obj("TSMethodSignature", vec![
                    ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                    ("params", ts_arr(flat_kids(&[ctx.kids.get(2).cloned().unwrap_or(ts_arr(vec![]))]))),
                    ("returnType", ctx.kids.get(3).cloned().unwrap_or(ts_null())),
                    ("optional", ts_bool(ctx.src.contains('?'))),
                ])
            } else {
                ts_obj("TSPropertySignature", vec![
                    ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                    ("typeAnnotation", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
                    ("optional", ts_bool(ctx.src.contains('?'))), ("readonly", ts_bool(false)),
                ])
            }
        }
        Some(5) => ts_obj("TSIndexSignature", vec![
            ("parameters", ts_arr(flat_kids(&[ctx.kids.get(0).cloned().unwrap_or(ts_arr(vec![]))]))),
            ("typeAnnotation", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
        ]),
        _ => unhandled("tsInterfaceMember", ctx, None),
    }
}

fn ts_type_member(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => {
            let construct = ctx_span(ctx).trim_start().starts_with("new");
            let typ = if construct { "TSConstructSignatureDeclaration" } else { "TSCallSignatureDeclaration" };
            ts_obj(typ, vec![
                ("typeParameters", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                ("params", ts_arr(flat_kids(&[ctx.kids.get(1).cloned().unwrap_or(ts_arr(vec![]))]))),
                ("returnType", ctx.kids.get(2).cloned().unwrap_or(ts_null())),
            ])
        }
        Some(1) => ts_obj("TSIndexSignature", vec![
            ("parameters", ctx.kids.get(0).cloned().unwrap_or(ts_arr(vec![]))),
            ("typeAnnotation", ctx.kids.last().cloned().unwrap_or(ts_null())),
        ]),
        Some(2) => ts_obj("TSPropertySignature", vec![
            ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
            ("typeAnnotation", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
            ("optional", ts_bool(ctx.src.contains('?'))), ("readonly", ts_bool(true)),
        ]),
        Some(3) => {
            let method = ctx.kids.get(2).map(|k| matches!(k, AstValue::Array(_))).unwrap_or(false);
            if method {
                ts_obj("TSMethodSignature", vec![
                    ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                    ("params", ts_arr(flat_kids(&[ctx.kids.get(2).cloned().unwrap_or(ts_arr(vec![]))]))),
                    ("returnType", ctx.kids.get(3).cloned().unwrap_or(ts_null())),
                    ("optional", ts_bool(ctx.src.contains('?'))),
                ])
            } else {
                ts_obj("TSPropertySignature", vec![
                    ("key", ctx.kids.get(0).cloned().unwrap_or(ts_null())),
                    ("typeAnnotation", ctx.kids.get(1).cloned().unwrap_or(ts_null())),
                    ("optional", ts_bool(ctx.src.contains('?'))), ("readonly", ts_bool(false)),
                ])
            }
        }
        _ => unhandled("tsTypeMember", ctx, None),
    }
}

fn estree_prop(ctx: &AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let k = &ctx.kids;
    match arm {
        Some(4) | Some(5) => ts_obj("Property", vec![
            ("key", ts_ident(&match k.get(0) { Some(AstValue::String(s)) => s.clone(), _ => String::new() })),
            ("value", ts_ident(&match k.get(0) { Some(AstValue::String(s)) => s.clone(), _ => String::new() })),
            ("kind", ts_lit_str("init")), ("shorthand", ts_bool(true)), ("computed", ts_bool(false)), ("method", ts_bool(false)),
        ]),
        Some(8) => ts_obj("SpreadElement", vec![("argument", k.get(0).cloned().unwrap_or(ts_null()))]),
        Some(6) | Some(7) => ts_obj("Property", vec![
            ("key", k.get(0).cloned().unwrap_or(ts_null())),
            ("value", k.get(1).cloned().unwrap_or(ts_null())),
            ("kind", ts_lit_str(if arm == Some(6) { "get" } else { "set" })),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(false)), ("method", ts_bool(false)),
        ]),
        Some(2) | Some(3) => ts_obj("Property", vec![
            ("key", k.get(0).cloned().unwrap_or(ts_null())),
            ("value", ts_obj("FunctionExpression", vec![
                ("params", ts_arr(flat_kids(&[k.get(1).cloned().unwrap_or(ts_arr(vec![]))]))),
                ("body", k.get(2).cloned().unwrap_or(ts_null())),
            ])),
            ("kind", ts_lit_str("init")), ("method", ts_bool(true)),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(false)),
        ]),
        Some(0) | Some(1) | Some(9) | Some(10) | Some(11) => ts_obj("Property", vec![
            ("key", match k.get(0) { Some(AstValue::String(s)) => ts_ident(s), Some(other) => other.clone(), None => ts_null() }),
            ("value", k.get(1).cloned().unwrap_or(ts_null())),
            ("kind", ts_lit_str("init")), ("shorthand", ts_bool(false)),
            ("computed", ts_bool(arm == Some(1))), ("method", ts_bool(false)),
        ]),
        _ => unhandled("estreeProp", ctx, None),
    }
}

pub struct TsEstreeCustoms;
impl ShapeCustoms for TsEstreeCustoms {
    /// Match JS `Number(text)`: hex/bin/octal OK; numeric separators → NaN; never panic.
    fn leaf_number(&self, text: &str) -> f64 {
        if text.contains('_') { return f64::NAN; }
        let bytes = text.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'0' {
            let (radix, rest) = match bytes[1] {
                b'x' | b'X' => (16u32, &text[2..]),
                b'b' | b'B' => (2u32, &text[2..]),
                b'o' | b'O' => (8u32, &text[2..]),
                _ => (0u32, ""),
            };
            if radix != 0 {
                return u64::from_str_radix(rest, radix).map(|n| n as f64).unwrap_or(f64::NAN);
            }
        }
        text.parse::<f64>().unwrap_or(f64::NAN)
    }
    fn ast_custom(&self, name: &str, ctx: AstCustomCtx<'_>) -> AstValue {
        match name {
            "estreeStmt" => estree_stmt(&ctx),
            "estreeDecl" => estree_decl(&ctx),
            "estreeParenOrComma" => estree_paren_or_comma(&ctx),
            "estreeExprBinary" => estree_expr_binary(&ctx),
            "estreeExprPrefix" => estree_expr_prefix(&ctx),
            "estreeExprPostfixTok" => estree_expr_postfix_tok(&ctx),
            "estreeTemplateLiteral" => estree_template_literal(&ctx),
            "estreeExprLed" => estree_expr_led(&ctx),
            "estreeExprNudSeq" => estree_expr_nud_seq(&ctx),
            "estreeArrow" => estree_arrow(&ctx),
            "tsTypeLed" => ts_type_led(&ctx),
            "estreeNewTargetLed" => estree_new_target_led(&ctx),
            "estreeArrayPattern" => estree_array_pattern(&ctx),
            "estreeBindingProperty" => estree_binding_property(&ctx),
            "estreeParam" => estree_param(&ctx),
            "estreeForHead" => estree_for_head(&ctx),
            "estreeSwitchCase" => estree_switch_case(&ctx),
            "estreeDecorator" => estree_decorator(&ctx),
            "estreeClassMember" => estree_class_member(&ctx),
            "tsInterfaceMember" => ts_interface_member(&ctx),
            "tsTypeMember" => ts_type_member(&ctx),
            "estreeProp" => estree_prop(&ctx),
            _ => panic!("shape rust: custom {} not provided — SH3-4", name),
        }
    }
}
