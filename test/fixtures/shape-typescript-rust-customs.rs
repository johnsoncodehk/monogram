// ── M-A1.4-S5: streaming-only ESTree fixture ───────────────────────────────
// Tree mode was removed (M-A1.4-S5): the emitter no longer builds arena trees
// or calls customs handlers — every completion point emits a StreamEvent
// (typ, alt, off, end) into ShapeParser.events. This fixture therefore keeps
// only the streaming side:
//   - TN_* tags (tag_type maps them to names for the event type dispatch)
//   - tag_type / kid_type / optional_chain_type (used by estree_type_of_streaming)
//   - parse_stream (callback replay of the committed events)
//   - the schema-driven estree JSON rebuild (VSpec/Schema/SC_*/rebuild_estree)
// The 82 typed-node handlers, TnodesArena, TsEstreeCustoms, the GrammarCustoms
// impl and the StreamingCustoms probe were all tree-mode — deleted.
const TN_BINEXPR: u16 = 1;
const TN_VARDECLARATOR: u16 = 75;
const TN_SWITCHCASE: u16 = 76;
const TN_IDENT: u16 = 2;
const TN_EXPRSTMT: u16 = 3;
const TN_CALL: u16 = 4;
const TN_MEMBER: u16 = 5;
const TN_VARDECL: u16 = 6;
const TN_BLOCKSTMT: u16 = 7;
const TN_PROPERTY: u16 = 8;
const TN_FUNCDECL: u16 = 9;
const TN_ARROWFN: u16 = 10;
const TN_TEMPLATELIT: u16 = 11;
const TN_TEMPLATEEL: u16 = 12;
const TN_IF: u16 = 13;
const TN_FOR: u16 = 14;
const TN_FORIN: u16 = 15;
const TN_FOROF: u16 = 16;
const TN_WHILE: u16 = 17;
const TN_DOWHILE: u16 = 18;
const TN_SWITCH: u16 = 19;
const TN_RETURN: u16 = 20;
const TN_THROW: u16 = 21;
const TN_BREAK: u16 = 22;
const TN_CONTINUE: u16 = 23;
const TN_TRY: u16 = 24;
const TN_LABELED: u16 = 25;
const TN_EMPTY: u16 = 26;
const TN_DEBUGGER: u16 = 27;
const TN_WITH: u16 = 28;
const TN_SEQ: u16 = 29;
const TN_COND: u16 = 30;
const TN_ASSIGN: u16 = 31;
const TN_LOGICAL: u16 = 32;
const TN_UNARY: u16 = 33;
const TN_UPDATE: u16 = 34;
const TN_EXPORTNAMED: u16 = 35;
const TN_EXPORTALL: u16 = 36;
const TN_EXPORTDEFAULT: u16 = 37;
const TN_IMPORT: u16 = 38;
const TN_CLASSDECL: u16 = 39;
const TN_CLASSBODY: u16 = 40;
const TN_CLASSEXPR: u16 = 41;
const TN_METHODDEF: u16 = 42;
const TN_STATICBLOCK: u16 = 43;
const TN_PROPDEF: u16 = 44;
const TN_DECORATOR: u16 = 45;
const TN_METAPROP: u16 = 46;
const TN_FUNCEXPR: u16 = 47;
const TN_REST: u16 = 48;
const TN_SPREAD: u16 = 49;
const TN_TSINTERFACEDECL: u16 = 50;
const TN_TSINTERFACEBODY: u16 = 51;
const TN_TSPROPSIG: u16 = 52;
const TN_TSMAPPED: u16 = 53;
const TN_TSINDEXSIG: u16 = 54;
const TN_TSMETHODSIG: u16 = 55;
const TN_TSTYPEREF: u16 = 56;
const TN_TSTYPELIT: u16 = 57;
const TN_TSALIAS: u16 = 58;
const TN_TSCONDTYPE: u16 = 59;
const TN_TSINDEXED: u16 = 60;
const TN_TSNONNULL: u16 = 61;
const TN_TSAS: u16 = 62;
const TN_TSSATISFIES: u16 = 63;
const TN_TSINSTANTIATION: u16 = 64;
const TN_TSNAMESPACE: u16 = 65;
const TN_TSMODULE: u16 = 66;
const TN_TSIMPORTEQUALS: u16 = 67;
const TN_TSENUM: u16 = 68;
const TN_TYPE: u16 = 69;
const TN_FORHEAD: u16 = 70;
const TN_DECLARATION: u16 = 71;
const TN_TAGGEDTPL: u16 = 72;
const TN_ARRAYPAT: u16 = 73;
const TN_TSCALLSIG: u16 = 74;
const TN_TYPEKEEP: u16 = 77;
const TN_BLOCKSTMT_SP: u16 = 78;
const TN_MEMBERNAME: u16 = 79;
const TN_TSTYPEPARAM: u16 = 80;
const TN_TSTPARAMDECL: u16 = 81;
const TN_RAWVAL: u16 = 82;
const TN_METAOP: u16 = 83;
const TN_PARAMIDENT: u16 = 84;

fn tag_type(tag: u16) -> &'static str {
    match tag {
        TN_BINEXPR => "BinaryExpression",
        TN_VARDECLARATOR => "VariableDeclarator",
        TN_SWITCHCASE => "SwitchCase",
        TN_IDENT => "Identifier",
        TN_EXPRSTMT => "ExpressionStatement",
        TN_CALL => "CallExpression",
        TN_MEMBER => "MemberExpression",
        TN_VARDECL => "VariableDeclaration",
        TN_BLOCKSTMT => "BlockStatement",
        TN_PROPERTY => "Property",
        TN_FUNCDECL => "FunctionDeclaration",
        TN_ARROWFN => "ArrowFunctionExpression",
        TN_TEMPLATELIT => "TemplateLiteral",
        TN_TEMPLATEEL => "TemplateElement",
        TN_IF => "IfStatement",
        TN_FOR => "ForStatement",
        TN_FORIN => "ForInStatement",
        TN_FOROF => "ForOfStatement",
        TN_WHILE => "WhileStatement",
        TN_DOWHILE => "DoWhileStatement",
        TN_SWITCH => "SwitchStatement",
        TN_RETURN => "ReturnStatement",
        TN_THROW => "ThrowStatement",
        TN_BREAK => "BreakStatement",
        TN_CONTINUE => "ContinueStatement",
        TN_TRY => "TryStatement",
        TN_LABELED => "LabeledStatement",
        TN_EMPTY => "EmptyStatement",
        TN_DEBUGGER => "DebuggerStatement",
        TN_WITH => "WithStatement",
        TN_SEQ => "SequenceExpression",
        TN_COND => "ConditionalExpression",
        TN_ASSIGN => "AssignmentExpression",
        TN_LOGICAL => "LogicalExpression",
        TN_UNARY => "UnaryExpression",
        TN_UPDATE => "UpdateExpression",
        TN_EXPORTNAMED => "ExportNamedDeclaration",
        TN_EXPORTALL => "ExportAllDeclaration",
        TN_EXPORTDEFAULT => "ExportDefaultDeclaration",
        TN_IMPORT => "ImportDeclaration",
        TN_CLASSDECL => "ClassDeclaration",
        TN_CLASSBODY => "ClassBody",
        TN_CLASSEXPR => "ClassExpression",
        TN_METHODDEF => "MethodDefinition",
        TN_STATICBLOCK => "StaticBlock",
        TN_PROPDEF => "PropertyDefinition",
        TN_DECORATOR => "Decorator",
        TN_METAPROP => "MetaProperty",
        TN_FUNCEXPR => "FunctionExpression",
        TN_REST => "RestElement",
        TN_SPREAD => "SpreadElement",
        TN_TSINTERFACEDECL => "TSInterfaceDeclaration",
        TN_TSINTERFACEBODY => "TSInterfaceBody",
        TN_TSPROPSIG => "TSPropertySignature",
        TN_TSMAPPED => "TSMappedType",
        TN_TSINDEXSIG => "TSIndexSignature",
        TN_TSMETHODSIG => "TSMethodSignature",
        TN_TSTYPEREF => "TSTypeReference",
        TN_TSTYPELIT => "TSTypeLiteral",
        TN_TSALIAS => "TSTypeAliasDeclaration",
        TN_TSCONDTYPE => "TSConditionalType",
        TN_TSINDEXED => "TSIndexedAccessType",
        TN_TSNONNULL => "TSNonNullExpression",
        TN_TSAS => "TSAsExpression",
        TN_TSSATISFIES => "TSSatisfiesExpression",
        TN_TSINSTANTIATION => "TSInstantiationExpression",
        TN_TSNAMESPACE => "TSNamespaceExportDeclaration",
        TN_TSMODULE => "TSModuleDeclaration",
        TN_TSIMPORTEQUALS => "TSImportEqualsDeclaration",
        TN_TSENUM => "TSEnumDeclaration",
        TN_TYPE => "Type",
        TN_FORHEAD => "ForHead",
        TN_DECLARATION => "Declaration",
        TN_TAGGEDTPL => "TaggedTemplateExpression",
        TN_ARRAYPAT => "ArrayPattern",
        TN_TSCALLSIG => "TSCallSignatureDeclaration",
        TN_TYPEKEEP => "Type",
        TN_BLOCKSTMT_SP => "BlockStatement",
        TN_MEMBERNAME => "MemberName",
        TN_TSTYPEPARAM => "TSTypeParameter",
        TN_TSTPARAMDECL => "TSTypeParameterDeclaration",
        TN_RAWVAL => "TemplateElementValue",
        TN_METAOP => "TypeMetaOp",
        TN_PARAMIDENT => "Identifier",
        _ => "UnknownTag",
    }
}
fn kid_type(v: SVal) -> &'static str {
    match v {
        SVal::TNode(tag, _) => tag_type(tag),
        SVal::Str(..) | SVal::OwnStr(_) => "Identifier",
        _ => "UnknownKid",
    }
}
fn optional_chain_type(kids: &[SVal]) -> &'static str {
    match kids.first().copied() {
        Some(SVal::List(..)) | Some(SVal::NodeList(..)) => "CallExpression",
        _ => "MemberExpression",
    }
}

/// M-A1.2: streaming structure-event parse — emitter emits (tag, span) at every
/// completion point; no AST is built.
/// Streaming parse: `cb` receives every COMMITTED node-completion event
/// (replayed after the walk — speculative events are dropped by the checkpoint
/// watermark truncation). `cb` returns false to abort the replay.
/// Returns true iff the source parsed successfully.
///
/// Leaf contract: tokens are lexed once; a token is a LEAF iff no event's
/// [off, end) span covers it (every node span is covered by its parent, so the
/// uncovered token ranges are exactly the leaves).
///
/// M-A1.4-S5: the emitter pushes committed StreamEvents directly, so the customs
/// only supplies the leaf-number policy the walk still needs (the tree-mode
/// TsEstreeCustoms/StreamingCustoms/82 handlers are deleted).
#[derive(Default)]
pub struct TsStreamCustoms;
impl<'a> ShapeCustoms<'a> for TsStreamCustoms {
    /// Full TS number-leaf policy (hex/bin/oct/underscore → NaN) — byte-parity
    /// with the tree-era TsEstreeCustoms::leaf_number, so the rebuild output and
    /// the walk's leaf values are unchanged.
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
        if !bytes.is_empty() && bytes.len() <= 19 && bytes.iter().all(|c| c.is_ascii_digit()) {
            let mut v: u64 = 0;
            for &c in bytes { v = v * 10 + (c - b'0') as u64; }
            return v as f64;
        }
        text.parse::<f64>().unwrap_or(f64::NAN)
    }
}

pub fn parse_stream<'a>(src: &'a str, mut cb: impl FnMut(&StreamEvent) -> bool) -> bool {
    let customs = TsStreamCustoms::default();
    let Some(root) = parse_ast_with(src, &customs) else { return false; };
    for ev in &root.events {
        if !cb(ev) { break; }
    }
    true
}
pub fn parse_stream_buf<'a>(src: &'a str, buf: &mut Vec<StreamEvent>, mut cb: impl FnMut(&StreamEvent) -> bool) -> bool {
    let customs = TsStreamCustoms::default();
    let mut b = Some(std::mem::take(buf));
    let ok = parse_ast_with_buf(src, &customs, &mut b).is_some();
    *buf = b.unwrap_or_else(Vec::new);
    if !ok { return false; }
    for ev in buf.iter() {
        if !cb(ev) { break; }
    }
    buf.clear();
    true
}

// ── M-A1.3: schema-driven estree JSON rebuild from the streaming event stream ──
// The streaming parser emits (cstName, alt, off, end) at every completion point.
// A consumer walks the events (completion order: children before parents),
// rebuilding each node's JSON from a per-(cstName, alt) schema, then pushing the
// finished subtree onto a stack. Byte-identical to the tree JSON writer.
#[derive(Clone, Copy)]
pub enum VSpec {
    Kid(&'static str),          // one child of this tag (completion order)
    KidList(&'static str),      // all children of this tag → JSON array
    Opt(&'static str),          // optional child; absent → null
    Kids,                       // all remaining children (mixed tags) → JSON array
    LeafRest,                   // last remaining child if any, else re-lexed last token (leaf_json)
    LeafTok(usize),             // re-lex node span, absolute token i (leaf_json auto-detect)
    LeafLast(usize),            // re-lex node span, i-th from the end (leaf_json)
    TokTexts,                   // all token texts of the node span → JSON string array
    ArgSeq,                     // last remaining child wrapped as SequenceExpression{expressions:[kid,[]]}; null if none
    KidByTag(&'static str),     // rposition of one child with this tag → its JSON
    KidListOrNull(&'static str),// all children of this tag → JSON array; null if none
    LeafRestOrNull,             // last remaining child if its tag is an expr type, else null
    InitLeaf,                   // last remaining child if any, else: '=' present in span → leaf of last token, else null
    ArgSeqLeaf,                 // ArgSeq, else leaf of last non-';' token after the leading keyword; null if none
    ClassBodyFromPool,          // all remaining MethodDefinition/PropertyDefinition/StaticBlock → {"type":"ClassBody","body":[...]}
    FuncExprFromPool,           // last "BlockStatement" child → FunctionExpression{params:[],body,async:false,generator:false}
    CallArgs,                   // 0 kids → []; 1 kid → [[kid]]; else flat [k1,k2] (tree-mode nesting quirk)
    TemplateQuasis,             // re-lex template span → quasis JSON array (TemplateElement list)
    MetaOpTok(usize),           // re-lex span, JSON-escape token i → {"op":"..."}
    LeafIdent(usize),           // {"type":"Identifier","name":leaf(token i)}
    LeafIdentLast(usize),       // {"type":"Identifier","name":leaf(last-i token)}
    ClassName,                  // leaf of the token right after the "class" keyword
    Seq(&'static [SeqPart]),    // concatenate parts into one JSON array [p1,p2,...]
    UnionName,                  // union left operand: pool Type if ≥2 Types, else leaf token 0
    UnionParams,                // union right operand: pool Type if ≥1, else leaf last token
    FirstRest,                  // pool[0] (leftmost/innermost child); null if empty
    TryHandler,                 // [param-or-null, catch-block] from pool
    CondTrue,                   // conditional true branch: literal after '?' → leaf, else pool Type
    SeqExpr,                    // re-lex '[..]' span → comma-split element array (elision→null, '...'→pool, num→leaf)
    SeqExpr8,                   // throw-new: leaf all tokens except new/(/) → array
    TypeTupleChildren,          // '[T, U]' → [[[null,T],[null,U]]]
    TupleHeadText,              // tuple headText: "," + "[object Object]" xN joined by ",,"
    Type3Children,              // 'typeof obj' → [{Type{children:[obj],headText:obj,off,end}}]
    TypeWrap0,                  // {"type":"Type","children":[leaf tok0],"headText":leaf tok0}
    TSEnumId,                   // [ImportClause, source-leaf] or bare source-leaf
    SwitchCases,                // aggregate case-head + consequent-stmt wrappers into cases array
    PropGetSetValue,            // get → []; set → [param list]
    ModValue,                   // abstract/protected/private member value: [MN,<inner>]
    LabelTok,                   // token 1 if present and not ';', else null (break/continue label)
    TokLeafs,                   // all token texts with leaf auto-detect → JSON array
    CtorValue,                  // constructor FunctionExpression{params:[KidList Identifier],body:[Kid Block],static:false}
    AsTok,                      // token after 'as' if present, else null (import local)
    TSIndexParams,              // ["k",[Type,Type,...]] from '[' key ':' types ']'
    IndexType,                  // T[K] → Type kid, else literal leaf after '[' (Obj["key"])
    TSInterfaceBodyFromPool,    // all remaining pool children → {"type":"TSInterfaceBody","body":[...]}
    TokLeafsNoBrackets,         // TokLeafs minus literal '[' ']' tokens (computed member name)
    DecoratorExpr,              // @dec → {Identifier dec}; @dec(...) → {CallExpression{callee,arguments:[]}}
    TypeParamConstraint,        // Type after 'extends' if present, else null
    TypeParamDefault,           // Type after '=' if present, else null
    ArrowParams,                // '(' → KidList Identifier; else → [LeafIdent(0)]
    CallCallee,                 // last non-CallExpression pool item, else LeafIdent(0)
    CallArgs2,                  // span '(' ')' comma-split: 1 arg → [[kid]]; N → flat (pool + leaf)
    EqLeaf,                     // leaf of token right after '=' if present, else null
    MemberNameComputed,         // '[' expr ']' → [{Identifier}] / leaf per token
    DeclaratorId,               // pool ObjectPattern/ArrayPattern if any, else LeafTok(0)
    MemberProperty,             // last token, or token inside '[' for computed access
    ImportName,                 // token 0, skipping a leading 'type' keyword
    PipeOp,                     // {"op":"|"} from the '|' token
    LtOp,                       // {"op":"<"} from the '<' token
    PropKey,                    // token 0 as {Identifier}, skipping a leading '...'
    PropValue,                  // span starts with '...' → null, else LeafRest
    PropValueColon,             // property `k: v` value: the pool kid whose span starts
                                // AFTER the top-level ':' (a node value like `a: b.c`);
                                // else the leaf of the first token after the ':' (literal
                                // `a: 1` / `[k]: 2` — a computed KEY's identifier sits
                                // BEFORE the colon and must not be taken as the value)
    MemberComputed,             // span contains '[' → true, else false
    CondFalse,                  // pool[0] if any, else leaf of last non-':' token
    CondSeg(u8),                // ConditionalExpression segment: 0=test 1=consequent 2=alternate —
                                // kid by span inside the segment, else leaf of the first non-punct token
    FnReturnType,               // 'x is T' → {Type{children:[x,Type]}}; else Opt("Type")
    NamespaceName,              // leaf after the last 'namespace' keyword before off
    MergeNamespace,             // merge pool Identifier(17) jsons → FunctionDeclaration{id,params:[all]}
    SpanOff,
    SpanEnd,
    Const(&'static str),
    Raw(&'static str),           // raw literal output (no JSON escaping) — for [] etc
    Flag(bool),
    ExprFlag,                   // body is BlockStatement → false, else true (arrow expression)
    BinLeft,                    // binary/logical/assign left: leftmost kid if it starts the span, else literal leaf before the op
    BinOp,                      // binary/logical/assign operator: token right after the left operand / right before the right operand
    SwitchDiscriminant,         // last non-SwitchCase pool kid, else leaf of token 1 (switch discriminant)
    QuestionFlag,               // span contains '?' → true, else false (TS property optional)
}
#[derive(Clone, Copy)]
pub struct FSpec { pub name: &'static str, pub v: VSpec }
pub struct Schema {
    pub estree: &'static str,
    pub no_type: bool,
    pub kids: &'static [&'static str],
    pub any_kids: bool,
    pub fields: &'static [FSpec],
}

/// A sequence of JSON values concatenated inside one array (for Seq VSpec).
#[derive(Clone, Copy)]
pub enum SeqPart {
    LeafTok(usize),
    LeafLast(usize),
    Kid(&'static str),
    KidList(&'static str),
    Opt(&'static str),
    Kids,
    Null,
    Const(&'static str),
    Raw(&'static str),
    LeafIdent(usize),
    AsTok,
    GetSetParams,
}

fn schema_for(etype: &str, alt: u32) -> &'static Schema {
    let s: &'static [(&'static str, u32, &'static Schema)] = &[
        ("Program", 0, &SC_PROGRAM),
        ("VariableDeclaration", 1, &SC_VARDECL),
        ("VariableDeclaration", 16, &SC_VARDECL_USING),
        ("ReturnStatement", 7, &SC_RETURN),
        ("ThrowStatement", 8, &SC_THROW),
        ("BreakStatement", 9, &SC_BREAK),
        ("ContinueStatement", 10, &SC_CONTINUE),
        ("LabeledStatement", 12, &SC_LABELED),
        ("EmptyStatement", 13, &SC_EMPTY),
        ("DebuggerStatement", 14, &SC_DEBUGGER),
        ("ExpressionStatement", 18, &SC_EXPRSTMT),
        ("VariableDeclarator", 0, &SC_VARDECLARATOR),
        ("FunctionDeclaration", 0, &SC_FUNCDECL),
        ("FunctionDeclaration", 1, &SC_FUNCDECL_GEN),
        ("FunctionDeclaration", 3, &SC_FUNCDECL_AG),
        ("Type", 0, &SC_TYPE),
        ("Type", 2, &SC_TSTYPEREF_UNION),
        ("Type", 3, &SC_TYPE3),
        ("Type", 4, &SC_TSCOND),
        ("Type", 5, &SC_TYPE_PAREN),
        ("Type", 8, &SC_TYPE8),
        ("Type", 9, &SC_TYPE9),
        // keyword literal types (true/false/null/undefined/this): the tree emits
        // the same empty-Type shape as void (children:[], headText:"", off, end).
        ("Type", 11, &SC_TYPE15),
        ("Type", 12, &SC_TYPE15),
        ("Type", 13, &SC_TYPE15),
        ("Type", 14, &SC_TYPE15),
        ("Type", 15, &SC_TYPE15),
        ("Type", 16, &SC_TYPE15),
        ("$template", 0, &SC_TPL0),
        ("BlockStatement", 0, &SC_BLOCK),
        ("Identifier", 0, &SC_IDENT),
        ("Identifier", 1, &SC_IDENT1),
        ("Identifier", 2, &SC_PARAMIDENT),
        ("Identifier", 6, &SC_IDENT6),
        ("Identifier", 13, &SC_IDENT13),
        ("ArrowFunctionExpression", 0, &SC_ARROW0),
        ("ArrowFunctionExpression", 1, &SC_ARROW),
        ("ArrowFunctionExpression", 2, &SC_ARROW),
        ("ArrowFunctionExpression", 3, &SC_ARROW),
        ("AssignmentExpression", 0, &SC_ASSIGN),
        ("UpdateExpression", 0, &SC_UPDATE),
        ("UnaryExpression", 0, &SC_UNARY),
        ("LogicalExpression", 0, &SC_LOGICAL),
        ("ConditionalExpression", 7, &SC_COND),
        ("MemberExpression", 3, &SC_MEMBEREXPR3),
        ("MemberExpression", 4, &SC_MEMBEREXPR4),
        ("MemberExpression", 5, &SC_MEMBEREXPR5),
        ("TSAsExpression", 8, &SC_TSAS),
        ("TSNonNullExpression", 6, &SC_TSNONNULL),
        ("SequenceExpression", 8, &SC_SEQ8),
        ("SequenceExpression", 11, &SC_SEQ11),
        ("SequenceExpression", 14, &SC_SEQ14),
        ("SequenceExpression", 16, &SC_SEQ16),
        ("SequenceExpression", 20, &SC_SEQ20),
        ("ForStatement", 3, &SC_FORSTATEMENT),
        ("ForHead", 0, &SC_FORHEAD),
        ("ForHead", 1, &SC_FORHEAD),
        ("WhileStatement", 4, &SC_WHILE),
        ("DoWhileStatement", 5, &SC_DOWHILE),
        ("WithStatement", 15, &SC_WITH),
        ("TryStatement", 11, &SC_TRY),
        ("SwitchStatement", 6, &SC_SWITCHSTMT),
        ("SwitchCase", 0, &SC_SWITCHCASE0),
        ("SwitchCase", 1, &SC_SWITCHCASE1),
        ("SwitchCase", 2, &SC_SWITCHCASE2),
        ("TemplateLiteral", 0, &SC_TEMPLATELIT),
        ("TemplateElement", 0, &SC_TEMPLATEEL),
        ("ClassDeclaration", 6, &SC_CLASSDECL),
        ("ClassExpression", 2, &SC_CLASSEXPR),
        ("ClassBody", 0, &SC_CLASSBODY),
        ("ClassHeritage", 0, &SC_CLASSHERITAGE),
        ("Decorator", 0, &SC_DECORATOR),
        ("StaticBlock", 2, &SC_STATICBLOCK),
        ("MethodDefinition", 1, &SC_METHODDEF_CTOR),
        ("MethodDefinition", 3, &SC_METHODDEF),
        ("MemberName", 0, &SC_MEMBERNAME),
        ("MemberName", 2, &SC_MEMBERNAME2),
        ("MemberName", 3, &SC_MEMBERNAME3),
        ("MemberName", 8, &SC_MEMBERNAME8),
        ("Property", 0, &SC_PROP0),
        ("Property", 7, &SC_PROP7),
        ("Property", 9, &SC_PROP9),
        ("Property", 11, &SC_PROP11),
        ("Property", 1, &SC_PROP_SHORTHAND),
        ("FunctionExpression", 0, &SC_FUNCEXPR),
        ("ArrayPattern", 1, &SC_ARRAYPATTERN),
        ("ObjectPattern", 0, &SC_OBJECTPATTERN),
        ("AssignmentPatternOrId", 0, &SC_APOI),
        ("RestElement", 3, &SC_RESTELEM),
        ("TSTypeAliasDeclaration", 5, &SC_TSALIAS),
        ("TSTypeReference", 0, &SC_TSTYPEREF),
        ("TypeMetaOp", 0, &SC_TYPE_METAOP),
        ("IfStatement", 2, &SC_IF),
        ("TSTypeParameter", 0, &SC_TSTYPEPARAM),
        ("TSTypeParameterDeclaration", 0, &SC_TSTPARAMDECL),
        ("BinaryExpression", 0, &SC_BINARY),
        ("BinaryExpression", 9, &SC_BINARY),
        ("BinaryExpression", 10, &SC_BINARY),
        ("CallExpression", 2, &SC_CALL),
        ("CallExpression", 4, &SC_CALL4),
        ("MetaProperty", 7, &SC_METAPROP7),
        ("TSInstantiationExpression", 1, &SC_TSINSTANTIATION),
        ("TSSatisfiesExpression", 11, &SC_TSSATISFIES),
        ("MemberExpression", 0, &SC_MEMBEREXPR0),
        ("MemberName", 1, &SC_MEMBERNAME1),
        ("RestElement", 0, &SC_RESTELEM0),
        ("ExportSpecifier", 0, &SC_EXPORTSPEC),
        ("ExportNamedDeclaration", 15, &SC_EXPORTNAMED15),
        ("TSModuleDeclaration", 24, &SC_TSMODULEDECL24),
        ("Identifier", 17, &SC_IDENT17),
        ("Type", 1, &SC_TSINDEXED1),
        ("Type", 7, &SC_TYPE7),
        ("TSMappedType", 2, &SC_TSMAPPEDTYPE2),
        ("TSMethodSignature", 1, &SC_TSMETHODSIG1),
        ("UnknownKid", 12, &SC_UNKNOWNKID12),
        ("UnknownKid", 15, &SC_UNKNOWNKID15),
        ("UnknownKid", 5, &SC_UNKNOWNKID5),
        ("Declaration", 8, &SC_DECL8),
        ("Declaration", 9, &SC_DECL9),
        ("Declaration", 10, &SC_DECL10),
        ("Declaration", 12, &SC_DECL12),
        ("ExportNamedDeclaration", 18, &SC_EXPORTNAMED),
        ("ExportDefaultDeclaration", 20, &SC_EXPORTDEFAULT),
        ("ImportClause", 1, &SC_IMPORTCLAUSE1),
        ("ImportClause", 2, &SC_IMPORTCLAUSE2),
        ("ImportSpecifier", 0, &SC_IMPORTSPEC),
        ("TSEnumDeclaration", 26, &SC_TSENUMDECL),
        ("TSNamespaceExportDeclaration", 25, &SC_TSNS_EXPORT),
        ("TSEnumMember", 0, &SC_TSENUMMEMBER),
        ("TSInterfaceDeclaration", 4, &SC_TSINTERFACEDECL),
        ("TSPropertySignature", 3, &SC_TSPROPSIG3),
        ("TSPropertySignature", 4, &SC_TSPROPSIG4),
        ("SequenceExpression", 4, &SC_SEQ4),
        ("SequenceExpression", 0, &SC_SEQ4),
        ("SequenceExpression", 1, &SC_SEQ4),
        ("SequenceExpression", 2, &SC_SEQ4),
        ("SequenceExpression", 3, &SC_SEQ4),
        ("UnknownKid", 13, &SC_UNKNOWNKID13),
        ("TaggedTemplateExpression", 0, &SC_TAGGEDTPL),
        ("ForHead", 2, &SC_FORHEAD),
        ("ForHead", 3, &SC_FORHEAD),
    ];
    for &(t, a, sc) in s {
        if t == etype && a == alt { return sc; }
    }
    panic!("no schema for ({}, {})", etype, alt);
}

const SC_PROGRAM: Schema = Schema {
    estree: "Program", no_type: false,
    kids: &[],
    any_kids: true,
    fields: &[
        FSpec { name: "body", v: VSpec::Kids },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_VARDECL: Schema = Schema {
    estree: "VariableDeclaration", no_type: false,
    kids: &["VariableDeclarator"],
    any_kids: false,
    fields: &[
        FSpec { name: "kind", v: VSpec::LeafTok(0) },
        FSpec { name: "declarations", v: VSpec::KidList("VariableDeclarator") },
    ],
};

const SC_VARDECLARATOR: Schema = Schema {
    estree: "VariableDeclarator", no_type: false,
    kids: &["Type", "Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "Type", "TSTypeReference", "TSTypeParameterDeclaration", "ObjectPattern", "ArrayPattern", "UnknownKid", "Property", "AssignmentPatternOrId"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::DeclaratorId },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
        FSpec { name: "init", v: VSpec::InitLeaf },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_RETURN: Schema = Schema {
    estree: "ReturnStatement", no_type: false,
    kids: &["Identifier", "SequenceExpression", "BinaryExpression", "CallExpression", "MemberExpression", "ConditionalExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "argument", v: VSpec::ArgSeqLeaf },
    ],
};

const SC_EXPRSTMT: Schema = Schema {
    estree: "ExpressionStatement", no_type: false,
    kids: &["Identifier", "SequenceExpression", "BinaryExpression", "CallExpression", "MemberExpression", "ConditionalExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "UnknownKid"],
    any_kids: false,
    fields: &[
        FSpec { name: "expression", v: VSpec::LeafRest },
    ],
};

const SC_BLOCK: Schema = Schema {
    estree: "BlockStatement", no_type: false,
    kids: &["VariableDeclaration", "ExpressionStatement", "ReturnStatement", "IfStatement", "ForStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "ThrowStatement", "BreakStatement", "ContinueStatement", "TryStatement", "LabeledStatement", "WithStatement", "FunctionDeclaration", "ClassDeclaration", "BlockStatement", "EmptyStatement", "DebuggerStatement", "TSTypeAliasDeclaration", "ExportNamedDeclaration", "ImportDeclaration", "TSModuleDeclaration", "TSInterfaceDeclaration", "TSEnumDeclaration", "ArrowFunctionExpression", "TemplateLiteral", "ClassExpression", "FunctionExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "body", v: VSpec::Kids },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TYPE: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type", "TSTypeReference", "Expr"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TokTexts },
        FSpec { name: "headText", v: VSpec::LeafLast(0) },
    ],
};

const SC_FUNCDECL: Schema = Schema {
    estree: "FunctionDeclaration", no_type: false,
    kids: &["TSTypeParameterDeclaration", "Identifier", "BlockStatement", "Type", "TSTypeReference", "BinaryExpression", "CallExpression", "SequenceExpression", "MemberExpression", "ArrowFunctionExpression", "IfStatement", "ForStatement", "ForOfStatement", "AssignmentExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "TaggedTemplateExpression", "TemplateLiteral", "ClassExpression", "FunctionExpression", "Property", "SpreadElement", "MetaProperty", "RestElement", "ObjectPattern", "ArrayPattern", "AssignmentPatternOrId", "UnknownKid", "ExpressionStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "async", v: VSpec::Flag(false) },
        FSpec { name: "generator", v: VSpec::Flag(false) },
        FSpec { name: "id", v: VSpec::LeafTok(1) },
        FSpec { name: "typeParameters", v: VSpec::Opt("TSTypeParameterDeclaration") },
        FSpec { name: "params", v: VSpec::KidList("Identifier") },
        FSpec { name: "returnType", v: VSpec::FnReturnType },
        FSpec { name: "body", v: VSpec::Opt("BlockStatement") },
    ],
};

const SC_PARAMIDENT: Schema = Schema {
    estree: "Identifier", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::Const("") },
        FSpec { name: "decorators", v: VSpec::Raw("[]") },
        FSpec { name: "optional", v: VSpec::Flag(false) },
    ],
};

/// ForHead is a structural marker only — the ForStatement unwraps it (transparent
/// in rebuild_estree) and its declarator/test/update are collected as the ForStatement's.
const SC_FORHEAD: Schema = Schema {
    estree: "ForHead", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[],
};

const SC_FORSTATEMENT: Schema = Schema {
    estree: "ForStatement", no_type: false,
    kids: &["VariableDeclarator", "Identifier", "BlockStatement", "ExpressionStatement", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "EmptyStatement", "BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement", "IfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement", "LabeledStatement", "WithStatement", "ForStatement", "ForInStatement", "ForOfStatement", "DebuggerStatement", "ObjectPattern", "ArrayPattern"],
    any_kids: false,
    fields: &[
        FSpec { name: "init", v: VSpec::KidListOrNull("VariableDeclarator") },
        FSpec { name: "test", v: VSpec::LeafRestOrNull },
        FSpec { name: "update", v: VSpec::Raw("null") },
        FSpec { name: "body", v: VSpec::FirstRest },
    ],
};

/// for-in: pool is [body, right, left] (completion order) — left = rightmost
/// pool kid, right = next, body = first popped.
const SC_FORIN: Schema = Schema {
    estree: "ForInStatement", no_type: false,
    kids: &["VariableDeclarator", "VariableDeclaration", "Identifier", "BlockStatement", "ExpressionStatement", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "EmptyStatement", "BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement", "IfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement", "LabeledStatement", "WithStatement", "ForStatement", "ForInStatement", "ForOfStatement", "DebuggerStatement", "ObjectPattern", "ArrayPattern"],
    any_kids: false,
    fields: &[
        FSpec { name: "left", v: VSpec::LeafRest },
        FSpec { name: "right", v: VSpec::LeafRest },
        FSpec { name: "body", v: VSpec::FirstRest },
    ],
};

const SC_FOROF: Schema = Schema {
    estree: "ForOfStatement", no_type: false,
    kids: &["VariableDeclarator", "VariableDeclaration", "Identifier", "BlockStatement", "ExpressionStatement", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "EmptyStatement", "BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement", "IfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement", "LabeledStatement", "WithStatement", "ForStatement", "ForInStatement", "ForOfStatement", "DebuggerStatement", "ObjectPattern", "ArrayPattern"],
    any_kids: false,
    fields: &[
        FSpec { name: "left", v: VSpec::LeafRest },
        FSpec { name: "right", v: VSpec::LeafRest },
        FSpec { name: "body", v: VSpec::FirstRest },
        FSpec { name: "await", v: VSpec::Flag(false) },
    ],
};

const SC_TEMPLATELIT: Schema = Schema {
    estree: "TemplateLiteral", no_type: false,
    kids: &["TemplateElement", "Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "quasis", v: VSpec::TemplateQuasis },
        FSpec { name: "expressions", v: VSpec::Kids },
    ],
};

const SC_TEMPLATEEL: Schema = Schema {
    estree: "TemplateElement", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "value", v: VSpec::Raw("{\"raw\":\"\"}") },
        FSpec { name: "tail", v: VSpec::Flag(false) },
    ],
};

const SC_TAGGEDTPL: Schema = Schema {
    estree: "TaggedTemplateExpression", no_type: false,
    kids: &["Identifier", "TemplateLiteral", "TaggedTemplateExpression", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "tag", v: VSpec::LeafRest },
        FSpec { name: "quasi", v: VSpec::LeafRest },
    ],
};

const SC_CLASSDECL: Schema = Schema {
    estree: "ClassDeclaration", no_type: false,
    kids: &["ClassBody", "MethodDefinition", "PropertyDefinition", "StaticBlock", "Decorator", "ClassHeritage", "TSTypeParameterDeclaration", "Identifier", "Type", "TSTypeReference", "TemplateLiteral", "UnknownKid"],
    any_kids: false,
    fields: &[
        FSpec { name: "decorators", v: VSpec::KidList("Decorator") },
        FSpec { name: "id", v: VSpec::ClassName },
        FSpec { name: "superClass", v: VSpec::Opt("ClassHeritage") },
        FSpec { name: "body", v: VSpec::ClassBodyFromPool },
    ],
};

const SC_CLASSBODY: Schema = Schema {
    estree: "ClassBody", no_type: false,
    kids: &["MethodDefinition", "PropertyDefinition", "StaticBlock"],
    any_kids: false,
    fields: &[
        FSpec { name: "body", v: VSpec::Kids },
    ],
};

const SC_METHODDEF: Schema = Schema {
    estree: "MethodDefinition", no_type: false,
    kids: &["MemberName", "FunctionExpression", "BlockStatement", "Identifier", "Type", "Decorator", "UnknownKid", "SequenceExpression", "BinaryExpression", "CallExpression", "MemberExpression", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "TemplateLiteral", "MetaProperty", "ClassExpression", "SpreadElement", "RestElement", "ObjectPattern", "ArrayPattern", "AssignmentPatternOrId", "Property"],
    any_kids: false,
    fields: &[
        FSpec { name: "kind", v: VSpec::Const("method") },
        FSpec { name: "key", v: VSpec::KidByTag("MemberName") },
        FSpec { name: "value", v: VSpec::FuncExprFromPool },
        FSpec { name: "static", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
    ],
};

const SC_MEMBERNAME: Schema = Schema {
    estree: "MemberName", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TokTexts },
        FSpec { name: "arm", v: VSpec::Const("passthrough") },
        FSpec { name: "alt", v: VSpec::Raw("0") },
    ],
};

const SC_FUNCEXPR: Schema = Schema {
    estree: "FunctionExpression", no_type: false,
    kids: &["Identifier", "BlockStatement", "BinaryExpression", "SequenceExpression", "CallExpression", "MemberExpression", "ConditionalExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "Type", "TSTypeReference", "TSTypeParameterDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "params", v: VSpec::KidList("Identifier") },
        FSpec { name: "body", v: VSpec::LeafRest },
        FSpec { name: "async", v: VSpec::Flag(false) },
        FSpec { name: "generator", v: VSpec::Flag(false) },
    ],
};

const SC_TSALIAS: Schema = Schema {
    estree: "TSTypeAliasDeclaration", no_type: false,
    kids: &["Type", "TSTypeReference", "TSTypeParameterDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::LeafTok(1) },
        FSpec { name: "typeParameters", v: VSpec::Opt("TSTypeParameterDeclaration") },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
    ],
};

/// A type-led union (`A | B`) arrives tagged "Type" with alt 2 (tsTypeLed arm 2),
/// but the tree emits it as TSTypeReference{typeName, typeParameters, meta:{op}}.
const SC_TSTYPEREF_UNION: Schema = Schema {
    estree: "TSTypeReference", no_type: false,
    kids: &["Type", "TSTypeReference", "TypeMetaOp", "$template"],
    any_kids: false,
    fields: &[
        FSpec { name: "typeName", v: VSpec::UnionName },
        FSpec { name: "typeParameters", v: VSpec::UnionParams },
        FSpec { name: "meta", v: VSpec::PipeOp },
    ],
};

const SC_TSTYPEREF: Schema = Schema {
    estree: "TSTypeReference", no_type: false,
    kids: &["Type", "TSTypeReference", "TypeMetaOp"],
    any_kids: false,
    fields: &[
        FSpec { name: "typeName", v: VSpec::Opt("Type") },
        FSpec { name: "typeParameters", v: VSpec::LeafRest },
        FSpec { name: "meta", v: VSpec::Opt("TypeMetaOp") },
    ],
};

const SC_TYPE_METAOP: Schema = Schema {
    estree: "TypeMetaOp", no_type: true,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "op", v: VSpec::LeafTok(0) },
    ],
};

const SC_IDENT: Schema = Schema {
    estree: "Identifier", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::LeafTok(0) },
    ],
};

/// `this`-parameter with a type annotation: the Identifier event spans `this: T`
/// and the tree binds the Type into typeAnnotation (estreeParam this-arm).
const SC_IDENT_THIS: Schema = Schema {
    estree: "Identifier", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::LeafTok(0) },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
    ],
};

const SC_ARROW: Schema = Schema {
    estree: "ArrowFunctionExpression", no_type: false,
    kids: &["Identifier", "BlockStatement", "BinaryExpression", "SequenceExpression", "CallExpression", "MemberExpression", "ConditionalExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "Type", "TSTypeReference", "ArrowFunctionExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "params", v: VSpec::ArrowParams },
        FSpec { name: "body", v: VSpec::LeafRest },
        FSpec { name: "async", v: VSpec::Flag(false) },
        FSpec { name: "expression", v: VSpec::ExprFlag },
    ],
};

const SC_ARROW0: Schema = Schema {
    estree: "ArrowFunctionExpression", no_type: false,
    kids: &["Identifier", "BlockStatement", "BinaryExpression", "SequenceExpression", "CallExpression", "MemberExpression", "ConditionalExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "Type", "TSTypeReference", "ArrowFunctionExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "params", v: VSpec::Raw("[null]") },
        FSpec { name: "body", v: VSpec::FirstRest },
        FSpec { name: "async", v: VSpec::Flag(true) },
        FSpec { name: "expression", v: VSpec::Flag(false) },
    ],
};

const SC_TYPE8B: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(0), SeqPart::Kid("Type")]) },
        FSpec { name: "headText", v: VSpec::LeafTok(0) },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TYPE_FN: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["TSTypeParameterDeclaration", "Identifier", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::Opt("TSTypeParameterDeclaration"), SeqPart::KidList("Identifier"), SeqPart::Opt("Type")]) },
        FSpec { name: "headText", v: VSpec::Const("") },
    ],
};

const SC_IF: Schema = Schema {
    estree: "IfStatement", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "BlockStatement", "ExpressionStatement", "ReturnStatement", "VariableDeclaration", "IfStatement", "ForStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "ThrowStatement", "BreakStatement", "ContinueStatement", "TryStatement", "LabeledStatement", "WithStatement", "FunctionDeclaration", "ClassDeclaration", "EmptyStatement", "DebuggerStatement", "TSTypeAliasDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "test", v: VSpec::LeafRest },
        FSpec { name: "consequent", v: VSpec::LeafRest },
        FSpec { name: "alternate", v: VSpec::LeafRest },
    ],
};

const SC_TSTYPEPARAM: Schema = Schema {
    estree: "TSTypeParameter", no_type: false,
    kids: &["Type", "TSTypeReference", "Expr"],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::LeafTok(0) },
        FSpec { name: "constraint", v: VSpec::TypeParamConstraint },
        FSpec { name: "default", v: VSpec::TypeParamDefault },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TSTPARAMDECL: Schema = Schema {
    estree: "TSTypeParameterDeclaration", no_type: false,
    kids: &["TSTypeParameter"],
    any_kids: false,
    fields: &[
        FSpec { name: "params", v: VSpec::KidList("TSTypeParameter") },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_BINARY: Schema = Schema {
    estree: "BinaryExpression", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "left", v: VSpec::BinLeft },
        FSpec { name: "operator", v: VSpec::BinOp },
        FSpec { name: "right", v: VSpec::LeafRest },
    ],
};

const SC_CALL: Schema = Schema {
    estree: "CallExpression", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "callee", v: VSpec::CallCallee },
        FSpec { name: "arguments", v: VSpec::CallArgs2 },
    ],
};

const SC_TSINSTANTIATION: Schema = Schema {
    estree: "TSInstantiationExpression", no_type: false,
    kids: &["Expr"],
    any_kids: false,
    fields: &[
        FSpec { name: "expression", v: VSpec::Kid("Expr") },
        FSpec { name: "typeArguments", v: VSpec::KidList("Expr") },
    ],
};

// ── M-A1.3 round 6: schemas for the remaining corpus shapes ──

const SC_VARDECL_USING: Schema = Schema {
    estree: "VariableDeclaration", no_type: false,
    kids: &["VariableDeclarator"],
    any_kids: false,
    fields: &[
        FSpec { name: "kind", v: VSpec::Const("using") },
        FSpec { name: "declarations", v: VSpec::KidList("VariableDeclarator") },
    ],
};

const SC_THROW: Schema = Schema {
    estree: "ThrowStatement", no_type: false,
    kids: &["SequenceExpression", "Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "NewExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "argument", v: VSpec::LeafRest },
    ],
};

const SC_BREAK: Schema = Schema {
    estree: "BreakStatement", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "label", v: VSpec::LabelTok },
    ],
};

const SC_CONTINUE: Schema = Schema {
    estree: "ContinueStatement", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "label", v: VSpec::LabelTok },
    ],
};

const SC_LABELED: Schema = Schema {
    estree: "LabeledStatement", no_type: false,
    kids: &["ForStatement", "WhileStatement", "DoWhileStatement", "BlockStatement", "ExpressionStatement", "VariableDeclaration", "IfStatement", "ReturnStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "label", v: VSpec::LeafIdent(0) },
        FSpec { name: "body", v: VSpec::LeafRest },
    ],
};

const SC_EMPTY: Schema = Schema {
    estree: "EmptyStatement", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[],
};

const SC_DEBUGGER: Schema = Schema {
    estree: "DebuggerStatement", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[],
};

const SC_FUNCDECL_GEN: Schema = Schema {
    estree: "FunctionDeclaration", no_type: false,
    kids: &["TSTypeParameterDeclaration", "Identifier", "BlockStatement", "Type", "TSTypeReference", "BinaryExpression", "CallExpression", "SequenceExpression", "MemberExpression", "ArrowFunctionExpression", "IfStatement", "ForStatement", "ForOfStatement", "AssignmentExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "TaggedTemplateExpression", "TemplateLiteral", "ClassExpression", "FunctionExpression", "Property", "SpreadElement", "MetaProperty", "RestElement", "UnknownKid", "ExpressionStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "async", v: VSpec::Flag(true) },
        FSpec { name: "generator", v: VSpec::Flag(false) },
        FSpec { name: "id", v: VSpec::LeafTok(2) },
        FSpec { name: "typeParameters", v: VSpec::Opt("TSTypeParameterDeclaration") },
        FSpec { name: "params", v: VSpec::KidList("Identifier") },
        FSpec { name: "returnType", v: VSpec::FnReturnType },
        FSpec { name: "body", v: VSpec::Opt("BlockStatement") },
    ],
};

const SC_FUNCDECL_AG: Schema = Schema {
    estree: "FunctionDeclaration", no_type: false,
    kids: &["TSTypeParameterDeclaration", "Identifier", "BlockStatement", "Type", "TSTypeReference", "BinaryExpression", "CallExpression", "SequenceExpression", "MemberExpression", "ArrowFunctionExpression", "IfStatement", "ForStatement", "ForOfStatement", "AssignmentExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "TaggedTemplateExpression", "TemplateLiteral", "ClassExpression", "FunctionExpression", "Property", "SpreadElement", "MetaProperty", "RestElement", "UnknownKid", "ExpressionStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "async", v: VSpec::Flag(true) },
        FSpec { name: "generator", v: VSpec::Flag(true) },
        FSpec { name: "id", v: VSpec::LeafTok(3) },
        FSpec { name: "typeParameters", v: VSpec::Opt("TSTypeParameterDeclaration") },
        FSpec { name: "params", v: VSpec::KidList("Identifier") },
        FSpec { name: "returnType", v: VSpec::FnReturnType },
        FSpec { name: "body", v: VSpec::Opt("BlockStatement") },
    ],
};

const SC_TYPE3: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(1)]) },
        FSpec { name: "headText", v: VSpec::LeafTok(1) },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TYPE_KEYOF: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Kids },
        FSpec { name: "headText", v: VSpec::Const("[object Object]") },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TSCOND: Schema = Schema {
    estree: "TSConditionalType", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "checkType", v: VSpec::LeafRest },
        FSpec { name: "extendsType", v: VSpec::LeafRest },
        FSpec { name: "trueType", v: VSpec::CondTrue },
        FSpec { name: "falseType", v: VSpec::CondFalse },
    ],
};

const SC_TYPE8: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(1), SeqPart::Kid("Type")]) },
        FSpec { name: "headText", v: VSpec::LeafTok(1) },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TYPE9: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(1), SeqPart::Null]) },
        FSpec { name: "headText", v: VSpec::LeafTok(1) },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

/// Parenthesized type `(A | B)` (alt 5): a Type wrapper whose children are the
/// inner union/reference kid(s); headText is the tree's object-string quirk.
const SC_TYPE_PAREN: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type", "TSTypeReference", "TypeMetaOp", "$template"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Kids },
        FSpec { name: "headText", v: VSpec::Const("[object Object]") },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TYPE15: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Raw("[]") },
        FSpec { name: "headText", v: VSpec::Const("") },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TYPE_TUPLE: Schema = Schema {
    estree: "Type", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TypeTupleChildren },
        FSpec { name: "headText", v: VSpec::TupleHeadText },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TSTYPEREF_DOT: Schema = Schema {
    estree: "TSTypeReference", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "typeName", v: VSpec::Opt("Type") },
        FSpec { name: "typeParameters", v: VSpec::LeafLast(0) },
        FSpec { name: "meta", v: VSpec::MetaOpTok(1) },
    ],
};

const SC_TSTYPEREF_LT: Schema = Schema {
    estree: "TSTypeReference", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "typeName", v: VSpec::Opt("Type") },
        FSpec { name: "typeParameters", v: VSpec::Seq(&[SeqPart::Kid("Type")]) },
        FSpec { name: "meta", v: VSpec::LtOp },
    ],
};

const SC_TPL0: Schema = Schema {
    estree: "$template", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(0), SeqPart::Kid("Type"), SeqPart::LeafLast(0)]) },
        FSpec { name: "headText", v: VSpec::LeafTok(0) },
    ],
};

const SC_IDENT1: Schema = Schema {
    estree: "Identifier", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::Const("") },
        FSpec { name: "decorators", v: VSpec::Raw("[]") },
        FSpec { name: "optional", v: VSpec::Flag(true) },
    ],
};

const SC_IDENT6: Schema = Schema {
    estree: "Identifier", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::LeafTok(1) },
    ],
};

const SC_IDENT13: Schema = Schema {
    estree: "Identifier", no_type: false,
    kids: &["Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "name", v: VSpec::LeafLast(0) },
    ],
};

const SC_ASSIGN: Schema = Schema {
    estree: "AssignmentExpression", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "left", v: VSpec::BinLeft },
        FSpec { name: "operator", v: VSpec::BinOp },
        FSpec { name: "right", v: VSpec::LeafRest },
    ],
};

const SC_UPDATE: Schema = Schema {
    estree: "UpdateExpression", no_type: false,
    kids: &["Identifier", "MemberExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "operator", v: VSpec::LeafTok(1) },
        FSpec { name: "argument", v: VSpec::LeafRest },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_UNARY: Schema = Schema {
    estree: "UnaryExpression", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TemplateLiteral", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "operator", v: VSpec::LeafTok(0) },
        FSpec { name: "argument", v: VSpec::LeafRest },
        FSpec { name: "prefix", v: VSpec::Flag(true) },
    ],
};

const SC_LOGICAL: Schema = Schema {
    estree: "LogicalExpression", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "left", v: VSpec::BinLeft },
        FSpec { name: "operator", v: VSpec::BinOp },
        FSpec { name: "right", v: VSpec::LeafRest },
    ],
};

const SC_COND: Schema = Schema {
    estree: "ConditionalExpression", no_type: false,
    kids: &["Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "test", v: VSpec::CondSeg(0) },
        FSpec { name: "consequent", v: VSpec::CondSeg(1) },
        FSpec { name: "alternate", v: VSpec::CondSeg(2) },
    ],
};

const SC_MEMBEREXPR3: Schema = Schema {
    estree: "MemberExpression", no_type: false,
    kids: &["Identifier", "MemberExpression", "CallExpression", "SequenceExpression", "UnknownKid", "TSNonNullExpression", "ThisExpr"],
    any_kids: false,
    fields: &[
        FSpec { name: "object", v: VSpec::LeafRest },
        FSpec { name: "property", v: VSpec::MemberProperty },
        FSpec { name: "computed", v: VSpec::Flag(false) },
        FSpec { name: "optional", v: VSpec::Flag(false) },
    ],
};

/// Computed member access `a[b]` (alt 5): same shape as the `.` access with
/// computed=true.
const SC_MEMBEREXPR5: Schema = Schema {
    estree: "MemberExpression", no_type: false,
    kids: &["Identifier", "MemberExpression", "CallExpression", "SequenceExpression", "UnknownKid", "TSNonNullExpression", "ThisExpr"],
    any_kids: false,
    fields: &[
        FSpec { name: "object", v: VSpec::LeafRest },
        FSpec { name: "property", v: VSpec::MemberProperty },
        FSpec { name: "computed", v: VSpec::Flag(true) },
        FSpec { name: "optional", v: VSpec::Flag(false) },
    ],
};

const SC_MEMBEREXPR4: Schema = Schema {
    estree: "MemberExpression", no_type: false,
    kids: &["Identifier", "MemberExpression", "CallExpression", "SequenceExpression", "TSNonNullExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "object", v: VSpec::LeafRest },
        FSpec { name: "property", v: VSpec::MemberProperty },
        FSpec { name: "computed", v: VSpec::MemberComputed },
        FSpec { name: "optional", v: VSpec::Flag(false) },
        FSpec { name: "optional", v: VSpec::Flag(true) },
    ],
};

const SC_TSAS: Schema = Schema {
    estree: "TSAsExpression", no_type: false,
    kids: &["Identifier", "Type", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TSAsExpression", "TSNonNullExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "expression", v: VSpec::LeafRest },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
    ],
};

const SC_TSNONNULL: Schema = Schema {
    estree: "TSNonNullExpression", no_type: false,
    kids: &["Identifier", "MemberExpression", "CallExpression", "TSNonNullExpression", "SequenceExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "expression", v: VSpec::LeafRest },
    ],
};

const SC_SEQ8: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &["Identifier", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::SeqExpr8 },
    ],
};

const SC_SEQ11: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &["Identifier", "AssignmentPatternOrId", "RestElement", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "SpreadElement"],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::SeqExpr },
    ],
};

const SC_SEQ14: Schema = Schema {
    estree: "__parengroup__", no_type: false,
    kids: &["BlockStatement", "ArrowFunctionExpression", "ClassExpression", "SequenceExpression", "FunctionExpression", "Identifier", "CallExpression", "MemberExpression", "BinaryExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "UnaryExpression", "UpdateExpression", "TemplateLiteral", "TSAsExpression", "TSNonNullExpression", "TSInstantiationExpression", "TSSatisfiesExpression", "UnknownKid", "Property", "TaggedTemplateExpression", "MetaProperty", "SpreadElement", "RestElement"],
    any_kids: false,
    fields: &[],
};

const SC_SEQ16: Schema = Schema {
    estree: "__passthrough__", no_type: false,
    kids: &["BlockStatement", "Identifier", "SequenceExpression"],
    any_kids: false,
    fields: &[],
};

const SC_SEQ20: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &["Type", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::Kids },
    ],
};

const SC_WHILE: Schema = Schema {
    estree: "WhileStatement", no_type: false,
    kids: &["BlockStatement", "ExpressionStatement", "Identifier", "CallExpression", "VariableDeclaration", "IfStatement", "ReturnStatement", "ContinueStatement", "BreakStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "test", v: VSpec::Opt("BlockStatement") },
        FSpec { name: "body", v: VSpec::Raw("null") },
    ],
};

const SC_DOWHILE: Schema = Schema {
    estree: "DoWhileStatement", no_type: false,
    kids: &["BlockStatement", "ExpressionStatement", "Identifier", "CallExpression", "VariableDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "body", v: VSpec::LeafRest },
        FSpec { name: "test", v: VSpec::Raw("null") },
    ],
};

const SC_WITH: Schema = Schema {
    estree: "WithStatement", no_type: false,
    kids: &["BlockStatement", "ExpressionStatement", "Identifier", "CallExpression", "VariableDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "object", v: VSpec::Opt("BlockStatement") },
        FSpec { name: "body", v: VSpec::Raw("null") },
    ],
};

const SC_TRY: Schema = Schema {
    estree: "TryStatement", no_type: false,
    kids: &["BlockStatement", "Identifier", "ExpressionStatement", "CallExpression", "VariableDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "block", v: VSpec::LeafRest },
        FSpec { name: "handler", v: VSpec::TryHandler },
        FSpec { name: "finalizer", v: VSpec::Opt("BlockStatement") },
    ],
};

const SC_SWITCHSTMT: Schema = Schema {
    estree: "SwitchStatement", no_type: false,
    kids: &["SwitchCase", "Identifier", "ExpressionStatement", "CallExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "discriminant", v: VSpec::SwitchDiscriminant },
        FSpec { name: "cases", v: VSpec::SwitchCases },
    ],
};

const SC_SWITCHCASE0: Schema = Schema {
    estree: "SwitchCase", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "test", v: VSpec::LeafTok(1) },
        FSpec { name: "consequent", v: VSpec::Raw("[]") },
    ],
};

const SC_SWITCHCASE1: Schema = Schema {
    estree: "SwitchCase", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "test", v: VSpec::Raw("null") },
        FSpec { name: "consequent", v: VSpec::Raw("[]") },
    ],
};

const SC_SWITCHCASE2: Schema = Schema {
    estree: "__passthrough__", no_type: false,
    kids: &["ExpressionStatement", "BreakStatement", "ContinueStatement", "ReturnStatement", "VariableDeclaration", "ThrowStatement", "IfStatement", "BlockStatement"],
    any_kids: false,
    fields: &[],
};

const SC_CLASSEXPR: Schema = Schema {
    estree: "ClassExpression", no_type: false,
    kids: &["ClassBody", "MethodDefinition", "StaticBlock", "PropertyDefinition"],
    any_kids: false,
    fields: &[
        FSpec { name: "decorators", v: VSpec::Raw("[]") },
        FSpec { name: "id", v: VSpec::Raw("null") },
        FSpec { name: "body", v: VSpec::ClassBodyFromPool },
    ],
};

const SC_CLASSHERITAGE: Schema = Schema {
    estree: "ClassHeritage", no_type: false,
    kids: &["Type", "TSTypeReference", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TokTexts },
        FSpec { name: "headText", v: VSpec::LeafLast(0) },
    ],
};

const SC_DECORATOR: Schema = Schema {
    estree: "Decorator", no_type: false,
    kids: &["Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "expression", v: VSpec::DecoratorExpr },
    ],
};

const SC_STATICBLOCK: Schema = Schema {
    estree: "StaticBlock", no_type: false,
    kids: &["BlockStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "body", v: VSpec::Raw("[]") },
    ],
};

const SC_METHODDEF_CTOR: Schema = Schema {
    estree: "MethodDefinition", no_type: false,
    kids: &["Identifier", "BlockStatement", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "kind", v: VSpec::Const("constructor") },
        FSpec { name: "key", v: VSpec::Raw("{\"type\":\"Identifier\",\"name\":\"constructor\"}") },
        FSpec { name: "value", v: VSpec::CtorValue },
        FSpec { name: "static", v: VSpec::Flag(false) },
    ],
};

const SC_METHODDEF_MOD: Schema = Schema {
    estree: "MethodDefinition", no_type: false,
    kids: &["MemberName", "Type", "BlockStatement", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "kind", v: VSpec::Const("method") },
        FSpec { name: "key", v: VSpec::Raw("[]") },
        FSpec { name: "value", v: VSpec::ModValue },
        FSpec { name: "static", v: VSpec::Flag(false) },
    ],
};

const SC_METHODDEF_GETSET: Schema = Schema {
    estree: "MethodDefinition", no_type: false,
    kids: &["MemberName", "BlockStatement", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "kind", v: VSpec::Const("method") },
        FSpec { name: "key", v: VSpec::Raw("[]") },
        FSpec { name: "value", v: VSpec::Seq(&[SeqPart::Kid("MemberName"), SeqPart::Null, SeqPart::GetSetParams, SeqPart::Null, SeqPart::Kid("BlockStatement")]) },
        FSpec { name: "static", v: VSpec::Flag(false) },
    ],
};

const SC_MEMBERNAME2: Schema = Schema {
    estree: "MemberName", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TokLeafs },
        FSpec { name: "arm", v: VSpec::Const("passthrough") },
        FSpec { name: "alt", v: VSpec::Raw("2") },
    ],
};

const SC_MEMBERNAME3: Schema = Schema {
    estree: "MemberName", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TokLeafs },
        FSpec { name: "arm", v: VSpec::Const("passthrough") },
        FSpec { name: "alt", v: VSpec::Raw("3") },
    ],
};

const SC_MEMBERNAME8: Schema = Schema {
    estree: "MemberName", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::MemberNameComputed },
        FSpec { name: "arm", v: VSpec::Const("passthrough") },
        FSpec { name: "alt", v: VSpec::Raw("8") },
    ],
};

const SC_PROP0: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["AssignmentPatternOrId", "Identifier", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::PropKey },
        FSpec { name: "value", v: VSpec::PropValue },
        FSpec { name: "kind", v: VSpec::Const("init") },
        FSpec { name: "method", v: VSpec::Flag(false) },
        FSpec { name: "shorthand", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
    ],
};

const SC_PROP7: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["MemberName", "BlockStatement", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::KidByTag("MemberName") },
        FSpec { name: "value", v: VSpec::Raw("null") },
        FSpec { name: "kind", v: VSpec::Const("set") },
        FSpec { name: "shorthand", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
        FSpec { name: "method", v: VSpec::Flag(false) },
    ],
};

const SC_PROP9: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["MemberName", "Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty", "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "ObjectPattern", "ArrayPattern", "AssignmentPatternOrId"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::KidByTag("MemberName") },
        // value is a pool kid when the property value is a node (`a: b` → the
        // Identifier event; `a: b.c` → the MemberExpression), else the re-lexed
        // leaf (literal `a: 1`). Span-gated on the ':' so a computed key's
        // identifier (`[k]: 2` → k is BEFORE the colon) is never taken as value.
        FSpec { name: "value", v: VSpec::PropValueColon },
        FSpec { name: "kind", v: VSpec::Const("init") },
        FSpec { name: "shorthand", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
        FSpec { name: "method", v: VSpec::Flag(false) },
    ],
};

const SC_PROP11: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::LeafIdent(0) },
        FSpec { name: "value", v: VSpec::Raw("null") },
        FSpec { name: "kind", v: VSpec::Const("init") },
        FSpec { name: "shorthand", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
        FSpec { name: "method", v: VSpec::Flag(false) },
    ],
};

const SC_PROP_SHORTHAND: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["AssignmentPatternOrId", "Identifier", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::LeafIdent(0) },
        FSpec { name: "value", v: VSpec::LeafIdent(0) },
        FSpec { name: "kind", v: VSpec::Const("init") },
        FSpec { name: "method", v: VSpec::Flag(false) },
        FSpec { name: "shorthand", v: VSpec::Flag(true) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
    ],
};

const SC_PROP_GETSET: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["MemberName", "Identifier", "BlockStatement", "ReturnStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::KidByTag("MemberName") },
        FSpec { name: "value", v: VSpec::PropGetSetValue },
        FSpec { name: "kind", v: VSpec::Const("init") },
        FSpec { name: "shorthand", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(true) },
        FSpec { name: "method", v: VSpec::Flag(false) },
    ],
};

const SC_ARRAYPATTERN: Schema = Schema {
    estree: "ArrayPattern", no_type: false,
    kids: &["AssignmentPatternOrId", "RestElement", "Identifier", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "elements", v: VSpec::SeqExpr },
    ],
};

const SC_OBJECTPATTERN: Schema = Schema {
    estree: "ObjectPattern", no_type: false,
    kids: &["Property", "RestElement", "AssignmentPatternOrId"],
    any_kids: false,
    fields: &[
        FSpec { name: "properties", v: VSpec::Kids },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_APOI: Schema = Schema {
    estree: "AssignmentPatternOrId", no_type: false,
    kids: &["Identifier", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::LeafTok(0) },
        FSpec { name: "init", v: VSpec::InitLeaf },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_RESTELEM: Schema = Schema {
    estree: "RestElement", no_type: false,
    kids: &["Identifier", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "argument", v: VSpec::LeafTok(1) },
    ],
};

const SC_DECL8: Schema = Schema {
    estree: "Declaration", no_type: false,
    kids: &["TSEnumMember", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "alt", v: VSpec::Raw("8") },
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(1), SeqPart::Kids]) },
    ],
};

const SC_DECL9: Schema = Schema {
    estree: "Declaration", no_type: false,
    kids: &["Identifier", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "alt", v: VSpec::Raw("9") },
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(2), SeqPart::Null, SeqPart::KidList("Identifier"), SeqPart::Opt("Type")]) },
    ],
};

const SC_DECL10: Schema = Schema {
    estree: "Declaration", no_type: false,
    kids: &["BlockStatement", "VariableDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "alt", v: VSpec::Raw("10") },
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(2)]) },
    ],
};

const SC_DECL12: Schema = Schema {
    estree: "Declaration", no_type: false,
    kids: &["VariableDeclaration", "VariableDeclarator", "Type", "FunctionDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "alt", v: VSpec::Raw("12") },
        FSpec { name: "children", v: VSpec::Kids },
    ],
};

const SC_EXPORTNAMED: Schema = Schema {
    estree: "ExportNamedDeclaration", no_type: false,
    kids: &["VariableDeclaration", "VariableDeclarator", "BlockStatement", "ExpressionStatement", "Type", "TSAsExpression", "Identifier", "ExportNamedDeclaration", "TSTypeAliasDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "specifiers", v: VSpec::Kids },
    ],
};

const SC_EXPORTDEFAULT: Schema = Schema {
    estree: "ExportDefaultDeclaration", no_type: false,
    kids: &["BlockStatement", "FunctionDeclaration", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "declaration", v: VSpec::Raw("[]") },
    ],
};

const SC_IMPORTCLAUSE1: Schema = Schema {
    estree: "ImportClause", no_type: false,
    kids: &["ImportSpecifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(0), SeqPart::AsTok]) },
        FSpec { name: "arm", v: VSpec::Const("defaultEtc") },
        FSpec { name: "alt", v: VSpec::Raw("1") },
    ],
};

const SC_IMPORTCLAUSE2: Schema = Schema {
    estree: "ImportClause", no_type: false,
    kids: &["ImportSpecifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::KidList("ImportSpecifier")]) },
        FSpec { name: "arm", v: VSpec::Const("defaultEtc") },
        FSpec { name: "alt", v: VSpec::Raw("2") },
    ],
};

const SC_IMPORTSPEC: Schema = Schema {
    estree: "ImportSpecifier", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "imported", v: VSpec::ImportName },
        FSpec { name: "local", v: VSpec::AsTok },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TSENUMDECL: Schema = Schema {
    estree: "TSEnumDeclaration", no_type: false,
    kids: &["ImportClause", "TSEnumMember", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::TSEnumId },
        FSpec { name: "members", v: VSpec::Raw("[]") },
    ],
};

const SC_TSNS_EXPORT: Schema = Schema {
    estree: "TSNamespaceExportDeclaration", no_type: false,
    kids: &["TSEnumMember", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::LeafTok(2) },
    ],
};

const SC_TSENUMMEMBER: Schema = Schema {
    estree: "TSEnumMember", no_type: false,
    kids: &["MemberName", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::KidByTag("MemberName") },
        FSpec { name: "initializer", v: VSpec::InitLeaf },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_TSINTERFACEDECL: Schema = Schema {
    estree: "TSInterfaceDeclaration", no_type: false,
    kids: &["TSPropertySignature", "MemberName", "Type", "TSTypeParameterDeclaration", "TSTypeReference", "ClassHeritage"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::LeafTok(1) },
        FSpec { name: "typeParameters", v: VSpec::Opt("TSTypeParameterDeclaration") },
        FSpec { name: "extends", v: VSpec::KidList("ClassHeritage") },
        FSpec { name: "body", v: VSpec::TSInterfaceBodyFromPool },
    ],
};

const SC_TSPROPSIG3: Schema = Schema {
    estree: "TSPropertySignature", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::LeafTok(0) },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
        FSpec { name: "optional", v: VSpec::QuestionFlag },
        FSpec { name: "readonly", v: VSpec::Flag(false) },
    ],
};

const SC_TSPROPSIG4: Schema = Schema {
    estree: "TSPropertySignature", no_type: false,
    kids: &["MemberName", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::KidByTag("MemberName") },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
        FSpec { name: "optional", v: VSpec::Flag(false) },
        FSpec { name: "readonly", v: VSpec::Flag(false) },
    ],
};

const SC_TSPROPSIG4_METHOD: Schema = Schema {
    estree: "TSPropertySignature", no_type: false,
    kids: &["MemberName", "Type", "Identifier", "TSTypeParameterDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::KidByTag("MemberName") },
        FSpec { name: "typeAnnotation", v: VSpec::Seq(&[SeqPart::Opt("TSTypeParameterDeclaration"), SeqPart::KidList("Identifier"), SeqPart::Opt("Type")]) },
        FSpec { name: "optional", v: VSpec::Flag(false) },
        FSpec { name: "readonly", v: VSpec::Flag(false) },
    ],
};

const SC_SEQ4: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::Raw("[]") },
    ],
};

const SC_UNKNOWNKID13: Schema = Schema {
    estree: "__leaflast__", no_type: false,
    kids: &["Identifier", "CallExpression", "BinaryExpression"],
    any_kids: false,
    fields: &[],
};

const SC_UNKNOWNKID12: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &["Property", "MemberName", "BlockStatement", "AssignmentPatternOrId"],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::Kids },
    ],
};

const SC_UNKNOWNKID15: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::Raw("[]") },
    ],
};

const SC_UNKNOWNKID5: Schema = Schema {
    estree: "SequenceExpression", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "expressions", v: VSpec::Raw("[]") },
    ],
};

const SC_CALL4: Schema = Schema {
    estree: "CallExpression", no_type: false,
    kids: &["MemberExpression", "Identifier", "CallExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "callee", v: VSpec::LeafRest },
        FSpec { name: "arguments", v: VSpec::Kids },
        FSpec { name: "optional", v: VSpec::Flag(true) },
    ],
};

const SC_METAPROP7: Schema = Schema {
    estree: "MetaProperty", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "meta", v: VSpec::LeafIdent(0) },
        FSpec { name: "property", v: VSpec::LeafIdent(2) },
    ],
};

const SC_TSSATISFIES: Schema = Schema {
    estree: "TSSatisfiesExpression", no_type: false,
    kids: &["Identifier", "Type", "MemberExpression", "CallExpression", "BinaryExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "expression", v: VSpec::LeafRest },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
    ],
};

const SC_MEMBEREXPR0: Schema = Schema {
    estree: "MemberExpression", no_type: false,
    kids: &["Identifier", "MemberExpression"],
    any_kids: false,
    fields: &[
        FSpec { name: "object", v: VSpec::LeafTok(0) },
        FSpec { name: "property", v: VSpec::MemberProperty },
        FSpec { name: "computed", v: VSpec::Flag(false) },
        FSpec { name: "optional", v: VSpec::Flag(false) },
    ],
};

const SC_MEMBERNAME1: Schema = Schema {
    estree: "MemberName", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::TokLeafs },
        FSpec { name: "arm", v: VSpec::Const("passthrough") },
        FSpec { name: "alt", v: VSpec::Raw("1") },
    ],
};

const SC_RESTELEM0: Schema = Schema {
    estree: "RestElement", no_type: false,
    kids: &["Identifier", "MemberName"],
    any_kids: false,
    fields: &[
        FSpec { name: "argument", v: VSpec::LeafTok(1) },
        FSpec { name: "off", v: VSpec::SpanOff },
        FSpec { name: "end", v: VSpec::SpanEnd },
    ],
};

const SC_EXPORTSPEC: Schema = Schema {
    estree: "ExportSpecifier", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::LeafTok(0), SeqPart::Null]) },
    ],
};

const SC_EXPORTNAMED15: Schema = Schema {
    estree: "ExportNamedDeclaration", no_type: false,
    kids: &["Identifier", "VariableDeclaration", "BlockStatement"],
    any_kids: false,
    fields: &[
        FSpec { name: "declaration", v: VSpec::MergeNamespace },
    ],
};

const SC_TSMODULEDECL24: Schema = Schema {
    estree: "TSModuleDeclaration", no_type: false,
    kids: &["ExportSpecifier", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "id", v: VSpec::KidList("ExportSpecifier") },
        FSpec { name: "body", v: VSpec::Raw("null") },
        FSpec { name: "declare", v: VSpec::Flag(true) },
    ],
};

const SC_IDENT17: Schema = Schema {
    estree: "FunctionDeclaration", no_type: false,
    kids: &["ExportNamedDeclaration", "VariableDeclaration", "BlockStatement", "Identifier", "TSTypeAliasDeclaration"],
    any_kids: false,
    fields: &[
        FSpec { name: "async", v: VSpec::Flag(false) },
        FSpec { name: "generator", v: VSpec::Flag(false) },
        FSpec { name: "id", v: VSpec::NamespaceName },
        FSpec { name: "typeParameters", v: VSpec::Raw("[]") },
        FSpec { name: "params", v: VSpec::Kids },
        FSpec { name: "returnType", v: VSpec::Raw("null") },
        FSpec { name: "body", v: VSpec::Raw("null") },
    ],
};

const SC_TSINDEXED1: Schema = Schema {
    estree: "TSIndexedAccessType", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "objectType", v: VSpec::Opt("Type") },
        FSpec { name: "indexType", v: VSpec::Raw("null") },
    ],
};

/// Indexed-access LED `T[K]` (alt 5): objectType = the left operand, indexType = the kid/leaf.
const SC_TSINDEXED5: Schema = Schema {
    estree: "TSIndexedAccessType", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "objectType", v: VSpec::Opt("Type") },
        FSpec { name: "indexType", v: VSpec::IndexType },
    ],
};

const SC_TSTYPEREF_AMP: Schema = Schema {
    estree: "TSTypeReference", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "typeName", v: VSpec::Opt("Type") },
        FSpec { name: "typeParameters", v: VSpec::Opt("Type") },
        FSpec { name: "meta", v: VSpec::MetaOpTok(1) },
    ],
};

const SC_TSTYPEREF_Q: Schema = Schema {
    estree: "TSTypeReference", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "typeName", v: VSpec::Opt("Type") },
        FSpec { name: "typeParameters", v: VSpec::Raw("null") },
        FSpec { name: "meta", v: VSpec::MetaOpTok(1) },
    ],
};

const SC_TYPE7: Schema = Schema {
    estree: "TSTypeLiteral", no_type: false,
    kids: &["TSPropertySignature", "TSMethodSignature", "TSMappedType", "TSTypeReference", "MemberName", "Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "members", v: VSpec::Kids },
    ],
};

const SC_TSMAPPEDTYPE2: Schema = Schema {
    estree: "TSPropertySignature", no_type: false,
    kids: &["Type"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::LeafTok(1) },
        FSpec { name: "typeAnnotation", v: VSpec::Opt("Type") },
        FSpec { name: "optional", v: VSpec::QuestionFlag },
        FSpec { name: "readonly", v: VSpec::Flag(true) },
    ],
};

const SC_TSMETHODSIG1: Schema = Schema {
    estree: "TSIndexSignature", no_type: false,
    kids: &["Type", "TSIndexedAccessType", "$template"],
    any_kids: false,
    fields: &[
        FSpec { name: "parameters", v: VSpec::TSIndexParams },
        FSpec { name: "typeAnnotation", v: VSpec::TSIndexParams },
    ],
};

const SC_CLASSHERITAGE_LT: Schema = Schema {
    estree: "ClassHeritage", no_type: false,
    kids: &["ClassHeritage", "Type", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "children", v: VSpec::Seq(&[SeqPart::Kid("ClassHeritage"), SeqPart::KidList("Type")]) },
        FSpec { name: "headText", v: VSpec::LeafTok(0) },
    ],
};

const SC_SEQ8_PT: Schema = Schema {
    estree: "__passthrough__", no_type: false,
    kids: &["MemberExpression", "Identifier"],
    any_kids: false,
    fields: &[],
};

const SC_SEQ11_LEAF: Schema = Schema {
    estree: "__seqleaf__", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[],
};

const SC_PROP0_REST: Schema = Schema {
    estree: "Property", no_type: false,
    kids: &["MemberName", "Identifier"],
    any_kids: false,
    fields: &[
        FSpec { name: "key", v: VSpec::PropKey },
        FSpec { name: "value", v: VSpec::Raw("null") },
        FSpec { name: "kind", v: VSpec::Const("init") },
        FSpec { name: "shorthand", v: VSpec::Flag(false) },
        FSpec { name: "computed", v: VSpec::Flag(false) },
        FSpec { name: "method", v: VSpec::Flag(false) },
    ],
};

const SC_SEQ8_LEAF: Schema = Schema {
    estree: "__newleaf__", no_type: false,
    kids: &[],
    any_kids: false,
    fields: &[],
};

/// Tags that count as expression values (for LeafRestOrNull / update-ish fields).
const EXPR_TAGS: &[&str] = &[
    "Identifier", "BinaryExpression", "CallExpression", "MemberExpression", "SequenceExpression",
    "TemplateLiteral", "UnaryExpression", "UpdateExpression", "LogicalExpression", "AssignmentExpression",
    "ConditionalExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression",
    "TSInstantiationExpression", "ArrowFunctionExpression", "TaggedTemplateExpression", "MetaProperty",
    "ClassExpression", "FunctionExpression", "SpreadElement", "RestElement", "Type", "TSTypeReference",
];

/// Re-lex a template-literal span and emit its quasis array:
/// TemplateElement{value:{raw}, tail} per text part between `${ ... }` holes.
/// The split is depth-aware: `${` inside a nested backtick template (or inside
/// braces of the hole itself) does not open a new hole of this literal.
fn tpl_quasis_json(off: u32, end: u32, src: &str) -> String {
    fn push_quasi(raw: &str, tail: bool, out: &mut String) {
        out.push_str("{\"type\":\"TemplateElement\",\"value\":{\"raw\":");
        let mut s = String::new();
        _shape_json_string(raw, &mut s);
        out.push_str(&s);
        out.push_str("},\"tail\":");
        out.push_str(if tail { "true" } else { "false" });
        out.push('}');
    }
    let text = &src[off as usize..end as usize];
    let inner = if text.starts_with('`') && text.ends_with('`') { &text[1..text.len() - 1] } else { text };
    let b = inner.as_bytes();
    let mut out = String::from("[");
    let mut first = true;
    let mut i = 0usize;
    let mut quasi_start = 0usize;
    let mut in_hole = false;
    let mut depth = 0i32;
    let mut in_tpl = false;
    while i < b.len() {
        let c = b[i];
        if in_hole {
            if in_tpl {
                if c == b'`' { in_tpl = false; }
                i += 1;
            } else if c == b'`' { in_tpl = true; i += 1; }
            else if c == b'{' && i > 0 && b[i - 1] == b'$' { depth += 1; i += 1; }
            else if c == b'}' {
                depth -= 1;
                if depth == 0 {
                    in_hole = false;
                    quasi_start = i + 1;
                }
                i += 1;
            } else { i += 1; }
        } else if c == b'$' && i + 1 < b.len() && b[i + 1] == b'{' {
            if !first { out.push(','); }
            first = false;
            push_quasi(&inner[quasi_start..i], false, &mut out);
            depth = 1;
            in_hole = true;
            i += 2;
        } else { i += 1; }
    }
    if !first { out.push(','); }
    first = false;
    push_quasi(&inner[quasi_start..], true, &mut out);
    out.push(']');
    out
}

/// Leaf of the token immediately after '=' in the span (for field initializers).
fn leaf_eq(src: &str, off: u32, end: u32) -> String {
    let toks = lex(&src[off as usize..end as usize]);
    for (i, t) in toks.iter().enumerate() {
        let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
        if text == "=" && i + 1 < toks.len() {
            let t2 = toks[i + 1];
            return leaf_json(&src[off as usize + t2.off as usize..off as usize + t2.end as usize]);
        }
    }
    "null".to_string()
}

/// Byte offset just after the first separator token (`:` / `=`) of a node span,
/// or None. Used to decide whether a pool kid is a VALUE (after the separator)
/// rather than a key/decorator (before it).
fn sep_after(src: &str, off: u32, end: u32, sep: &str) -> Option<u32> {
    let toks = lex(&src[off as usize..end as usize]);
    for t in toks {
        let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
        if text == sep { return Some(off + t.end as u32); }
    }
    None
}

/// Absolute (off, end) token pairs of a node span.
fn tok_pairs(src: &str, off: u32, end: u32) -> Vec<(u32, u32)> {
    lex(&src[off as usize..end as usize]).iter().map(|t| (off + t.off as u32, off + t.end as u32)).collect()
}
/// Last token ending at or before `at`.
fn token_ending_at(toks: &[(u32, u32)], at: u32) -> Option<(u32, u32)> {
    toks.iter().rev().find(|(_, e)| *e <= at).copied()
}
/// First token starting at or after `at`.
fn token_after(toks: &[(u32, u32)], at: u32) -> Option<(u32, u32)> {
    toks.iter().find(|(s, _)| *s >= at).copied()
}

/// Count of top-level (depth-0) commas in a comma-separated inner region.
fn count_top_level_commas(inner: &str) -> usize {
    let toks = lex(inner);
    let mut depth = 0i32;
    let mut n = 0usize;
    for t in &toks {
        let tt = &inner[t.off as usize..t.end as usize];
        if tt == "[" || tt == "(" || tt == "{" { depth += 1; }
        else if tt == "]" || tt == ")" || tt == "}" { depth -= 1; }
        else if tt == "," && depth == 0 { n += 1; }
    }
    n
}

/// Walk top-level comma elements of `inner`; per element, a pool kid (rposition,
/// leftmost-first) when it starts with a non-literal token, else a leaf of the
/// element text. Appends the resulting JSON values to `out`.
fn comma_split_elems(inner: &str, base: u32, pool: &mut Vec<(&'static str, u32, u32, String)>, out: &mut Vec<String>) {
    let toks = lex(inner);
    let mut depth = 0i32;
    let mut start = 0usize;
    for (i, t) in toks.iter().enumerate() {
        let tt = &inner[t.off as usize..t.end as usize];
        if tt == "[" || tt == "(" || tt == "{" { depth += 1; }
        else if tt == "]" || tt == ")" || tt == "}" { depth -= 1; }
        if (tt == "," && depth == 0) || i + 1 == toks.len() {
            let end_i = if tt == "," { i } else { i + 1 };
            if end_i <= start { start = i + 1; continue; }
            let elem = &inner[toks[start].off as usize..toks[end_i - 1].end as usize];
            let elem_t = elem.trim();
            if !elem_t.is_empty() {
                let ftext = &inner[toks[start].off as usize..toks[start].end as usize];
                let b = ftext.as_bytes();
                let is_lit = !b.is_empty() && (b[0] == b'"' || b[0] == b'\'' || b[0].is_ascii_digit() || (b[0] == b'.' && b.len() > 1));
                if !is_lit {
                    if let Some(idx) = pool.iter().rposition(|_| true) { out.push(pool.remove(idx).3); }
                    else { out.push(leaf_json(ftext)); }
                } else {
                    out.push(leaf_json(elem_t));
                }
            }
            start = i + 1;
        }
    }
}

/// Flat call-arguments list: per top-level comma element of the args paren inner,
/// a pool kid (rposition, leftmost-first) when the element starts with a
/// non-literal token, else a leaf of the element text.
fn call_args_flat(inner: &str, base: u32, pool: &mut Vec<(&'static str, u32, u32, String)>) -> String {
    let mut items: Vec<String> = Vec::new();
    comma_split_elems(inner, base, pool, &mut items);
    let mut out = String::from("[");
    for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
    out.push(']');
    out
}

fn eval_spec(v: VSpec, pool: &mut Vec<(&'static str, u32, u32, String)>, off: u32, end: u32, src: &str) -> String {
    match v {
        VSpec::Kid(t) => {
            let idx = pool.iter().rposition(|(pt, _, _, _)| *pt == t).expect("kid missing");
            pool.remove(idx).3
        }
        VSpec::KidList(t) => {
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == t).map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.retain(|(pt, _, _, _)| *pt != t);
            let mut out = String::from("[");
            for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
            out.push(']');
            out
        }
        VSpec::Opt(t) => {
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == t) {
                pool.remove(idx).3
            } else { "null".to_string() }
        }
        VSpec::Kids => {
            let mut items: Vec<String> = pool.iter().map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.clear();
            let mut out = String::from("[");
            for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
            out.push(']');
            out
        }
        VSpec::LeafRest => {
            if let Some(idx) = pool.iter().rposition(|_| true) {
                pool.remove(idx).3
            } else {
                // fallback: leaf of the last non-';' token (a literal-only node span)
                let toks = lex(&src[off as usize..end as usize]);
                let mut leaf = "null".to_string();
                for t in toks.iter().rev() {
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if text != ";" { leaf = leaf_json(text); break; }
                }
                leaf
            }
        }
        VSpec::LeafTok(i) => leaf_tok_abs(i, off, end, src),
        VSpec::LeafLast(i) => leaf_tok_last(i, off, end, src),
        VSpec::TokTexts => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = String::from("[");
            for (i, t) in toks.iter().enumerate() {
                if i > 0 { out.push(','); }
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                let mut s = String::new();
                _shape_json_string(text, &mut s);
                out.push_str(&s);
            }
            out.push(']');
            out
        }
        VSpec::ArgSeq => {
            if let Some(idx) = pool.iter().rposition(|_| true) {
                let kid = pool.remove(idx).3;
                format!("{{\"type\":\"SequenceExpression\",\"expressions\":[{},[]]}}", kid)
            } else { "null".to_string() }
        }
        VSpec::KidByTag(t) => {
            let idx = pool.iter().rposition(|(pt, _, _, _)| *pt == t).expect("kid missing");
            pool.remove(idx).3
        }
        VSpec::KidListOrNull(t) => {
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == t).map(|(_, _, _, j)| j.clone()).collect();
            if items.is_empty() { return "null".to_string(); }
            items.reverse();
            pool.retain(|(pt, _, _, _)| *pt != t);
            let mut out = String::from("[");
            for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
            out.push(']');
            out
        }
        VSpec::LeafRestOrNull => {
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| EXPR_TAGS.contains(pt)) {
                pool.remove(idx).3
            } else { "null".to_string() }
        }
        VSpec::InitLeaf => {
            if !pool.is_empty() {
                pool.remove(0).3
            } else {
                let toks = lex(&src[off as usize..end as usize]);
                let has_eq = toks.iter().any(|t| {
                    &src[off as usize + t.off as usize..off as usize + t.end as usize] == "="
                });
                if has_eq && !toks.is_empty() {
                    let t = toks[toks.len() - 1];
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    leaf_json(text)
                } else { "null".to_string() }
            }
        }
        VSpec::ArgSeqLeaf => {
            if let Some(idx) = pool.iter().rposition(|_| true) {
                let kid = pool.remove(idx).3;
                format!("{{\"type\":\"SequenceExpression\",\"expressions\":[{},[]]}}", kid)
            } else {
                let toks = lex(&src[off as usize..end as usize]);
                let mut pick: Option<&Tok> = None;
                let mut idx = 0usize;
                for (i, t) in toks.iter().enumerate() {
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if text != ";" { pick = Some(t); idx = i; }
                }
                match pick {
                    Some(t) if idx > 0 => {
                        let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                        let kid = leaf_json(text);
                        format!("{{\"type\":\"SequenceExpression\",\"expressions\":[{},[]]}}", kid)
                    }
                    _ => "null".to_string(),
                }
            }
        }
        VSpec::ClassBodyFromPool => {
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt != "TSTypeParameterDeclaration" && *pt != "ClassHeritage" && *pt != "Decorator" && *pt != "Identifier" && *pt != "Type" && *pt != "TSTypeReference" && *pt != "TemplateLiteral" && *pt != "UnknownKid").map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.clear();
            let mut out = String::from("{\"type\":\"ClassBody\",\"body\":[");
            for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
            out.push_str("]}");
            out
        }
        VSpec::FuncExprFromPool => {
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "BlockStatement") {
                let body = pool.remove(idx).3;
                format!("{{\"type\":\"FunctionExpression\",\"params\":[],\"body\":{},\"async\":false,\"generator\":false}}", body)
            } else {
                // field-like member: `x = 1` → params:[1]; `x!: T` → params:[]
                let text = &src[off as usize..end as usize];
                if text.contains('=') {
                    if let Some(after) = sep_after(src, off, end, "=") {
                        // node initializer (`x = false` / `x = f()`): the initializer's
                        // event sits after the '=' — use it as the param (a decorator
                        // kid before the '=' is never taken)
                        if let Some(idx) = pool.iter().rposition(|(_, ko, _, _)| *ko >= after) {
                            let kid = pool.remove(idx).3;
                            format!("{{\"type\":\"FunctionExpression\",\"params\":[{}],\"body\":null,\"async\":false,\"generator\":false}}", kid)
                        } else {
                            format!("{{\"type\":\"FunctionExpression\",\"params\":[{}],\"body\":null,\"async\":false,\"generator\":false}}", leaf_eq(&src, off, end))
                        }
                    } else {
                        format!("{{\"type\":\"FunctionExpression\",\"params\":[{}],\"body\":null,\"async\":false,\"generator\":false}}", leaf_eq(&src, off, end))
                    }
                } else {
                    "{\"type\":\"FunctionExpression\",\"params\":[],\"body\":null,\"async\":false,\"generator\":false}".to_string()
                }
            }
        }
        VSpec::ModValue => {
            let mn = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "MemberName") { pool.remove(idx).3 } else { "null".to_string() };
            let text = &src[off as usize..end as usize];
            if text.contains('=') {
                format!("[{},[null,{}]]", mn, leaf_eq(&src, off, end))
            } else if text.contains("?:") {
                let ty = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { pool.remove(idx).3 } else { "null".to_string() };
                format!("[{},[{},null]]", mn, ty)
            } else if text.contains('{') {
                let blk = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "BlockStatement") { pool.remove(idx).3 } else { "null".to_string() };
                format!("[{},null,[],null,{}]", mn, blk)
            } else {
                let ty = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { pool.remove(idx).3 } else { "null".to_string() };
                format!("[{},[null,[],{},null]]", mn, ty)
            }
        }
        VSpec::CallArgs => {
            if pool.is_empty() { return "[]".to_string(); }
            let mut items: Vec<String> = pool.iter().map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.clear();
            if items.len() == 1 {
                format!("[[{}]]", items[0])
            } else {
                let mut out = String::from("[");
                for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
                out.push(']');
                out
            }
        }
        VSpec::TemplateQuasis => tpl_quasis_json(off, end, src),
        VSpec::MetaOpTok(i) => {
            let toks = lex(&src[off as usize..end as usize]);
            if i >= toks.len() { return "null".to_string(); }
            let t = toks[i];
            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
            let mut o = String::from("{\"op\":");
            let mut s = String::new();
            _shape_json_string(text, &mut s);
            o.push_str(&s);
            o.push('}');
            o
        }
        VSpec::LeafIdent(i) => {
            let toks = lex(&src[off as usize..end as usize]);
            if i >= toks.len() { return "null".to_string(); }
            let t = toks[i];
            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
            format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text))
        }
        VSpec::LeafIdentLast(i) => {
            let toks = lex(&src[off as usize..end as usize]);
            if toks.is_empty() || i >= toks.len() { return "null".to_string(); }
            let t = toks[toks.len() - 1 - i];
            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
            format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text))
        }
        VSpec::ClassName => {
            let toks = lex(&src[off as usize..end as usize]);
            for (i, t) in toks.iter().enumerate() {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "class" && i + 1 < toks.len() {
                    let t2 = toks[i + 1];
                    return leaf_json(&src[off as usize + t2.off as usize..off as usize + t2.end as usize]);
                }
            }
            "null".to_string()
        }
        VSpec::Seq(parts) => {
            let mut out = String::from("[");
            let mut first = true;
            for p in parts {
                if !first { out.push(','); }
                first = false;
                match p {
                    SeqPart::LeafTok(i) => out.push_str(&leaf_tok_abs(*i, off, end, src)),
                    SeqPart::LeafLast(i) => out.push_str(&leaf_tok_last(*i, off, end, src)),
                    SeqPart::Kid(t) => {
                        let idx = pool.iter().rposition(|(pt, _, _, _)| *pt == *t).expect("kid missing");
                        out.push_str(&pool.remove(idx).3);
                    }
                    SeqPart::KidList(t) => {
                        let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == *t).map(|(_, _, _, j)| j.clone()).collect();
                        items.reverse();
                        pool.retain(|(pt, _, _, _)| *pt != *t);
                        let mut o2 = String::from("[");
                        for (i2, it) in items.iter().enumerate() { if i2 > 0 { o2.push(','); } o2.push_str(it); }
                        o2.push(']');
                        out.push_str(&o2);
                    }
                    SeqPart::Opt(t) => {
                        if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == *t) {
                            out.push_str(&pool.remove(idx).3);
                        } else { out.push_str("null"); }
                    }
                    SeqPart::Kids => {
                        let mut items: Vec<String> = pool.iter().map(|(_, _, _, j)| j.clone()).collect();
                        items.reverse();
                        pool.clear();
                        let mut o2 = String::from("[");
                        for (i2, it) in items.iter().enumerate() { if i2 > 0 { o2.push(','); } o2.push_str(it); }
                        o2.push(']');
                        out.push_str(&o2);
                    }
                    SeqPart::Null => out.push_str("null"),
                    SeqPart::Const(s) => { let mut o2 = String::new(); _shape_json_string(s, &mut o2); out.push_str(&o2); }
                    SeqPart::Raw(s) => out.push_str(s),
                    SeqPart::LeafIdent(i) => {
                        let toks = lex(&src[off as usize..end as usize]);
                        if *i < toks.len() {
                            let t = toks[*i];
                            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                            out.push_str(&format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text)));
                        } else { out.push_str("null"); }
                    }
                    SeqPart::AsTok => {
                        let toks = lex(&src[off as usize..end as usize]);
                        let mut v = "null".to_string();
                        for (i, t) in toks.iter().enumerate() {
                            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                            if text == "as" && i + 1 < toks.len() {
                                let t2 = toks[i + 1];
                                v = leaf_json(&src[off as usize + t2.off as usize..off as usize + t2.end as usize]);
                                break;
                            }
                        }
                        out.push_str(&v);
                    }
                    SeqPart::GetSetParams => {
                        let text = &src[off as usize..end as usize];
                        if text.trim_start().starts_with("set") {
                            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == "Identifier").map(|(_, _, _, j)| j.clone()).collect();
                            items.reverse();
                            pool.retain(|(pt, _, _, _)| *pt != "Identifier");
                            let mut o3 = String::from("[");
                            for (i3, it) in items.iter().enumerate() { if i3 > 0 { o3.push(','); } o3.push_str(it); }
                            o3.push(']');
                            out.push_str(&o3);
                        } else { out.push_str("[]"); }
                    }
                }
            }
            out.push(']');
            out
        }
        VSpec::UnionName => {
            let n = pool.iter().filter(|(pt, _, _, _)| *pt == "Type" || *pt == "$template").count();
            if n >= 2 {
                let idx = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type" || *pt == "$template").unwrap();
                pool.remove(idx).3
            } else {
                leaf_tok_abs(0, off, end, src)
            }
        }
        VSpec::UnionParams => {
            let n = pool.iter().filter(|(pt, _, _, _)| *pt == "Type" || *pt == "$template").count();
            if n >= 1 {
                let idx = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type" || *pt == "$template").unwrap();
                pool.remove(idx).3
            } else {
                leaf_tok_last(0, off, end, src)
            }
        }
        VSpec::FirstRest => {
            if !pool.is_empty() { pool.remove(0).3 } else { "null".to_string() }
        }
        VSpec::TryHandler => {
            let param = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Identifier") { pool.remove(idx).3 } else { "null".to_string() };
            let block = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "BlockStatement") { pool.remove(idx).3 } else { "null".to_string() };
            format!("[{},{}]", param, block)
        }
        VSpec::CondTrue => {
            let toks = lex(&src[off as usize..end as usize]);
            if let Some(qi) = toks.iter().position(|t| &src[off as usize + t.off as usize..off as usize + t.end as usize] == "?") {
                if qi + 1 < toks.len() {
                    let t = toks[qi + 1];
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    let b = text.as_bytes();
                    let literal = !b.is_empty() && (b[0] == b'"' || b[0] == b'\'' || b[0].is_ascii_digit() || text == "true" || text == "false" || text == "null" || text == "undefined");
                    if literal { return leaf_json(text); }
                    if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { return pool.remove(idx).3; }
                    return leaf_json(text);
                }
            }
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { pool.remove(idx).3 } else { "null".to_string() }
        }
        VSpec::SeqExpr => {
            let text = &src[off as usize..end as usize];
            let inner = text.trim_start_matches('[').trim_end_matches(']');
            let toks = lex(inner);
            // split top-level commas (depth of [ ( { )
            let mut out = String::from("[");
            let mut first = true;
            let mut depth = 0i32;
            let mut start = 0usize;
            for (i, t) in toks.iter().enumerate() {
                let tt = &inner[t.off as usize..t.end as usize];
                if tt == "[" || tt == "(" || tt == "{" { depth += 1; }
                else if tt == "]" || tt == ")" || tt == "}" { depth -= 1; }
                if (tt == "," && depth == 0) || i + 1 == toks.len() {
                    let end_i = if tt == "," { i } else { i + 1 };
                    let elem: Vec<&Tok> = toks[start..end_i].iter().collect();
                    if !first { out.push(','); }
                    first = false;
                    if elem.is_empty() {
                        out.push_str("null");
                    } else {
                        let first_tok = elem[0];
                        let ftext = &inner[first_tok.off as usize..first_tok.end as usize];
                        let fbytes = ftext.as_bytes();
                        let is_num = !fbytes.is_empty() && (fbytes[0].is_ascii_digit() || (fbytes[0] == b'.' && fbytes.len() > 1));
                        if ftext == "..." || ftext == "..." {
                            if let Some(idx) = pool.iter().rposition(|_| true) { out.push_str(&pool.remove(idx).3); }
                            else { out.push_str("null"); }
                        } else if is_num {
                            out.push_str(&leaf_json(ftext));
                        } else {
                            if let Some(idx) = pool.iter().rposition(|_| true) { out.push_str(&pool.remove(idx).3); }
                            else {
                                // single-token leaf
                                if elem.len() == 1 { out.push_str(&leaf_json(ftext)); }
                                else { out.push_str("null"); }
                            }
                        }
                    }
                    start = if tt == "," { i + 1 } else { i + 1 };
                }
            }
            out.push(']');
            out
        }
        VSpec::SeqExpr8 => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = String::from("[");
            let mut first = true;
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "new" || text == "(" || text == ")" || text == "," { continue; }
                if !first { out.push(','); }
                first = false;
                // Identifier args arrive as pool kids (e.g. `new Foo(a, b)` → a/b) —
                // use the kid covering this token, else leaf the token itself.
                if let Some(idx) = pool.iter().rposition(|(_, ko, ke, _)| {
                    *ko <= off + t.off as u32 && *ke >= off + t.end as u32
                }) {
                    out.push_str(&pool.remove(idx).3);
                } else {
                    out.push_str(&leaf_json(text));
                }
            }
            out.push(']');
            out
        }
        VSpec::TypeTupleChildren => {
            let text = &src[off as usize..end as usize];
            let inner = text.trim_start_matches('[').trim_end_matches(']');
            let toks = lex(inner);
            let mut elems: Vec<String> = Vec::new();
            let mut depth = 0i32;
            let mut start = 0usize;
            for (i, t) in toks.iter().enumerate() {
                let tt = &inner[t.off as usize..t.end as usize];
                if tt == "[" || tt == "(" { depth += 1; }
                else if tt == "]" || tt == ")" { depth -= 1; }
                if (tt == "," && depth == 0) || i + 1 == toks.len() {
                    let end_i = if tt == "," { i } else { i + 1 };
                    if end_i > start || i + 1 == toks.len() {
                        let mut e = String::from("[null,");
                        if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { e.push_str(&pool.remove(idx).3); } else { e.push_str("null"); }
                        e.push(']');
                        elems.push(e);
                    }
                    start = i + 1;
                }
            }
            // tree: children = [ [elem1, elem2, ...] ]  (one extra wrapper)
            let mut out = String::from("[[");
            for (i, e) in elems.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(e); }
            out.push_str("]]");
            out
        }
        VSpec::TupleHeadText => {
            let text = &src[off as usize..end as usize];
            let inner = text.trim_start_matches('[').trim_end_matches(']');
            let toks = lex(inner);
            let mut n = 1usize;
            let mut depth = 0i32;
            for t in toks {
                let tt = &inner[t.off as usize..t.end as usize];
                if tt == "[" || tt == "(" { depth += 1; }
                else if tt == "]" || tt == ")" { depth -= 1; }
                else if tt == "," && depth == 0 { n += 1; }
            }
            let mut out = String::from(",");
            for i in 0..n { if i > 0 { out.push_str(",,"); } out.push_str("[object Object]"); }
            let mut q = String::new();
            _shape_json_string(&out, &mut q);
            q
        }
        VSpec::Type3Children => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = String::from("[");
            let mut first = true;
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "typeof" || text == "keyof" { continue; }
                if !first { out.push(','); }
                first = false;
                out.push_str(&format!("{{\"type\":\"Type\",\"children\":[{}],\"headText\":{},\"off\":{},\"end\":{}}}", leaf_json(text), leaf_json(text), off, end));
            }
            out.push(']');
            out
        }
        VSpec::TypeWrap0 => {
            let toks = lex(&src[off as usize..end as usize]);
            if toks.is_empty() { return "null".to_string(); }
            let t = toks[0];
            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
            format!("{{\"type\":\"Type\",\"children\":[{}],\"headText\":{}}}", leaf_json(text), leaf_json(text))
        }
        VSpec::TSEnumId => {
            let source_leaf = {
                let toks = lex(&src[off as usize..end as usize]);
                let mut s = "null".to_string();
                for t in toks {
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if text.starts_with('"') { s = leaf_json(text); }
                }
                s
            };
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "ImportClause") {
                let kid = pool.remove(0).3;
                format!("[{},{}]", kid, source_leaf)
            } else { source_leaf }
        }
        VSpec::SwitchCases => {
            // Only SwitchCase entries participate in the fold — the discriminant
            // (last non-SwitchCase pool item) is consumed by SwitchDiscriminant.
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == "SwitchCase").map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.retain(|(pt, _, _, _)| *pt == "SwitchCase");
            let mut out = String::from("[");
            let mut first = true;
            let mut cur: Option<String> = None;
            for it in items {
                if it.starts_with("{\"type\":\"SwitchCase\"") {
                    if let Some(c) = cur.take() { if !first { out.push(','); } first = false; out.push_str(&c); }
                    cur = Some(it);
                } else if let Some(c) = cur.as_mut() {
                    let needle = "\"consequent\":";
                    if let Some(pos) = c.find(needle) {
                        let arr = pos + needle.len();
                        if c[arr..].starts_with('[') {
                            // find the matching ']' for the consequent array (depth-aware)
                            let bytes = c.as_bytes();
                            let mut depth = 0i32;
                            let mut at: Option<usize> = None;
                            for i in arr..bytes.len() {
                                match bytes[i] {
                                    b'[' => depth += 1,
                                    b']' => { depth -= 1; if depth == 0 { at = Some(i); break; } }
                                    _ => {}
                                }
                            }
                            if let Some(at) = at {
                                if at == arr + 1 {
                                    c.replace_range(arr..at + 1, &format!("[{}]", it));
                                } else {
                                    c.insert_str(at, &format!(",{}", it));
                                }
                            }
                        }
                    }
                }
            }
            if let Some(c) = cur.take() { if !first { out.push(','); } first = false; out.push_str(&c); }
            out.push(']');
            out
        }
        VSpec::PropGetSetValue => {
            let text = &src[off as usize..end as usize];
            let ts = text.trim_start();
            if ts.starts_with("get") {
                "[]".to_string()
            } else {
                let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == "Identifier").map(|(_, _, _, j)| j.clone()).collect();
                items.reverse();
                pool.retain(|(pt, _, _, _)| *pt != "Identifier");
                let mut o2 = String::from("[");
                for (i2, it) in items.iter().enumerate() { if i2 > 0 { o2.push(','); } o2.push_str(it); }
                o2.push(']');
                o2
            }
        }
        VSpec::LabelTok => {
            let toks = lex(&src[off as usize..end as usize]);
            if toks.len() > 1 {
                let t = toks[1];
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text != ";" { leaf_json(text) } else { "null".to_string() }
            } else { "null".to_string() }
        }
        VSpec::TokLeafs => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = String::from("[");
            for (i, t) in toks.iter().enumerate() {
                if i > 0 { out.push(','); }
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                out.push_str(&leaf_json(text));
            }
            out.push(']');
            out
        }
        VSpec::CtorValue => {
            let mut params = String::from("[");
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == "Identifier").map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.retain(|(pt, _, _, _)| *pt != "Identifier");
            for (i2, it) in items.iter().enumerate() { if i2 > 0 { params.push(','); } params.push_str(it); }
            params.push(']');
            let body = if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "BlockStatement") { pool.remove(idx).3 } else { "null".to_string() };
            format!("{{\"type\":\"FunctionExpression\",\"params\":{},\"body\":{}}}", params, body)
        }
        VSpec::AsTok => {
            let toks = lex(&src[off as usize..end as usize]);
            for (i, t) in toks.iter().enumerate() {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "as" && i + 1 < toks.len() {
                    let t2 = toks[i + 1];
                    return leaf_json(&src[off as usize + t2.off as usize..off as usize + t2.end as usize]);
                }
            }
            "null".to_string()
        }
        VSpec::TSIndexParams => {
            let toks = lex(&src[off as usize..end as usize]);
            let text = &src[off as usize..end as usize];
            let is_mapped = text.contains("in");
            // key = first token after the '[' (skip leading +/-/readonly modifiers)
            let mut key = "null".to_string();
            let mut bracket = false;
            for t in &toks {
                let tt = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if tt == "[" { bracket = true; continue; }
                if bracket { key = leaf_json(tt); break; }
            }
            // children (constraint / asType / value) in source order
            let mut items: Vec<String> = pool.iter().map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            let mut o2 = String::from("[");
            if is_mapped && items.len() >= 2 {
                // [constraint, asType-or-null, value]
                let constraint = items[0].clone();
                let value = items[items.len() - 1].clone();
                let as_type = if items.len() >= 3 { items[1].clone() } else { "null".to_string() };
                o2.push_str(&constraint);
                o2.push(',');
                o2.push_str(&as_type);
                o2.push(',');
                o2.push_str(&value);
            } else {
                for (i2, it) in items.iter().enumerate() { if i2 > 0 { o2.push(','); } o2.push_str(it); }
            }
            o2.push(']');
            format!("[{},{}]", key, o2)
        }
        VSpec::IndexType => {
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") {
                pool.remove(idx).3
            } else {
                let toks = lex(&src[off as usize..end as usize]);
                let mut bracket = false;
                let mut out = "null".to_string();
                for t in &toks {
                    let tt = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if tt == "[" { bracket = true; continue; }
                    if bracket { out = leaf_json(tt); break; }
                }
                out
            }
        }
        VSpec::TokLeafsNoBrackets => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = String::from("[");
            let mut first = true;
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "[" || text == "]" { continue; }
                if !first { out.push(','); }
                first = false;
                out.push_str(&leaf_json(text));
            }
            out.push(']');
            out
        }
        VSpec::DecoratorExpr => {
            let text = &src[off as usize..end as usize];
            if text.contains('(') {
                let toks = lex(&src[off as usize..end as usize]);
                let mut callee = "null".to_string();
                for t in &toks {
                    let tt = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if tt.starts_with('@') {
                        callee = format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(&tt[1..]));
                        break;
                    }
                }
                // arguments: tokens inside the first paren pair
                let mut args = String::from("[");
                let mut first = true;
                let mut in_paren = false;
                for t in &toks {
                    let tt = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if tt == "(" { in_paren = true; continue; }
                    if tt == ")" { in_paren = false; continue; }
                    if in_paren {
                        if !first { args.push(','); }
                        first = false;
                        args.push_str(&format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(tt)));
                    }
                }
                args.push(']');
                format!("{{\"type\":\"CallExpression\",\"callee\":{},\"arguments\":{}}}", callee, args)
            } else {
                let toks = lex(&src[off as usize..end as usize]);
                let mut name = "null".to_string();
                for t in toks {
                    let tt = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    let s = tt.strip_prefix('@').unwrap_or(tt);
                    name = leaf_json(s);
                }
                format!("{{\"type\":\"Identifier\",\"name\":{}}}", name)
            }
        }
        VSpec::TypeParamConstraint => {
            let text = &src[off as usize..end as usize];
            if text.contains("extends") {
                if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { pool.remove(idx).3 } else { "null".to_string() }
            } else { "null".to_string() }
        }
        VSpec::TypeParamDefault => {
            let text = &src[off as usize..end as usize];
            if text.contains('=') {
                if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { pool.remove(idx).3 } else { "null".to_string() }
            } else { "null".to_string() }
        }
        VSpec::ArrowParams => {
            let toks = lex(&src[off as usize..end as usize]);
            if !toks.is_empty() {
                let mut si = 0usize;
                let t0 = &src[off as usize + toks[0].off as usize..off as usize + toks[0].end as usize];
                if t0 == "new" && toks.len() > 1 { si = 1; }
                let t0 = &src[off as usize + toks[si].off as usize..off as usize + toks[si].end as usize];
                if t0 != "(" {
                    // single identifier param without parens
                    return format!("[{}]", format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(t0)));
                }
            }
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, j)| *pt == "Identifier" && j.starts_with("{\"type\":\"Identifier\",\"name\":\"\"")).map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.retain(|(pt, _, _, j)| !(*pt == "Identifier" && j.starts_with("{\"type\":\"Identifier\",\"name\":\"\"")));
            let mut out = String::from("[");
            for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
            out.push(']');
            out
        }
        VSpec::CallCallee => {
            // pool is reversed kid order: [args..., callee] — the callee is the
            // LAST pool item (a Call/Member kid for chained/member calls, or the
            // callee-leaf Identifier event for a plain `f(...)`).
            if let Some(idx) = pool.iter().rposition(|_| true) {
                pool.remove(idx).3
            } else {
                let toks = lex(&src[off as usize..end as usize]);
                if !toks.is_empty() {
                    let t = toks[0];
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text))
                } else { "null".to_string() }
            }
        }
        VSpec::CallArgs2 => {
            let text = &src[off as usize..end as usize];
            let toks = lex(text);
            // args are the LAST top-level paren pair: the pair whose ')' returns
            // the depth to 0 (for a chained call `f(a)(b)` / `f(a, b)()` that's
            // the trailing pair; for a parenthesized callee `(f)(a)` the callee's
            // pair is inside the span so the last depth-0 pair is still the args;
            // for nested args `f(g(1, 2), 3)` the inner g-args pair closes at
            // depth 1 and is skipped, leaving the outer `(...)` as the args).
            let mut depth = 0i32;
            let mut n = 0usize;
            let mut has_paren = false;
            let mut opens: Vec<usize> = Vec::new();
            let mut last_pair: Option<(usize, usize)> = None;
            for t in &toks {
                let tt = &text[t.off as usize..t.end as usize];
                if tt == "(" { opens.push(t.off as usize); depth += 1; has_paren = true; }
                else if tt == ")" {
                    if let Some(o) = opens.pop() {
                        depth -= 1;
                        if depth == 0 { last_pair = Some((o, t.off as usize)); }
                    }
                }
                else if tt == "," && depth == 1 { n += 1; }
            }
            if !has_paren { return "[]".to_string(); }
            let (po, pc) = last_pair.unwrap_or((0, text.len()));
            let inner = &text[po + 1..pc];
            let inner_t = inner.trim();
            if inner_t.is_empty() { return "[]".to_string(); }
            let mut nargs = n + 1;
            if inner_t.ends_with(',') { nargs = nargs.saturating_sub(1); }
            if nargs == 0 { return "[]".to_string(); }
            if pool.len() >= nargs {
                // All args are kids → tree-mode nesting quirk: [[k1, k2, ...]]
                let mut items: Vec<String> = Vec::new();
                for _ in 0..nargs {
                    let idx = pool.iter().rposition(|_| true).unwrap();
                    items.push(pool.remove(idx).3);
                }
                let mut out = String::from("[[");
                for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
                out.push_str("]]");
                return out;
            }
            // Mixed literal/leaf args → flat [a, 1, x]: pool kid (leftmost-first)
            // for non-literal elements, leaf for number/string literals.
            call_args_flat(inner, off, pool)
        }
        VSpec::BinLeft => {
            // Left operand of a binary/logical/assign node: the leftmost pool kid
            // when it starts the node span (or sits wholly left of the operator),
            // else the literal leaf region between the span start and the operator.
            let toks = tok_pairs(src, off, end);
            let op_start: u32 = if let Some((_, loff, lend, _)) = pool.last() {
                if *loff == off {
                    token_after(&toks, *lend).map(|(s, _)| s).unwrap_or(end)
                } else {
                    let roff = pool.first().map(|(_, o, _, _)| *o).unwrap_or(end);
                    token_ending_at(&toks, roff).map(|(s, _)| s).unwrap_or(off)
                }
            } else if toks.len() >= 2 {
                toks[toks.len() - 2].0
            } else { off };
            if let Some((_, loff, lend, _)) = pool.last() {
                if *loff >= off && *lend <= op_start {
                    return pool.pop().unwrap().3;
                }
            }
            let mut leaf = "null".to_string();
            for (s, e) in &toks {
                if *s >= op_start { break; }
                leaf = leaf_json(&src[*s as usize..*e as usize]);
                break;
            }
            leaf
        }
        VSpec::BinOp => {
            // Operator of a binary/logical/assign node: the token right after the
            // left operand (leftmost kid ending the span start) or right before
            // the right operand's first kid; fallback second-to-last token.
            let toks = tok_pairs(src, off, end);
            let op: Option<(u32, u32)> = if let Some((_, loff, lend, _)) = pool.last() {
                if *loff == off {
                    token_after(&toks, *lend)
                } else {
                    let roff = pool.first().map(|(_, o, _, _)| *o).unwrap_or(end);
                    token_ending_at(&toks, roff)
                }
            } else if toks.len() >= 2 {
                Some(toks[toks.len() - 2])
            } else { None };
            match op {
                Some((s, e)) => leaf_json(&src[s as usize..e as usize]),
                None => "null".to_string(),
            }
        }
        VSpec::SwitchDiscriminant => {
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt != "SwitchCase") {
                pool.remove(idx).3
            } else {
                // literal discriminant: the token right after the first '('
                let toks = lex(&src[off as usize..end as usize]);
                let mut leaf = "null".to_string();
                for (i, t) in toks.iter().enumerate() {
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if text == "(" && i + 1 < toks.len() {
                        let t2 = toks[i + 1];
                        leaf = leaf_json(&src[off as usize + t2.off as usize..off as usize + t2.end as usize]);
                        break;
                    }
                }
                leaf
            }
        }
        VSpec::QuestionFlag => {
            // Tree quirk: ts_type_member/ts_interface_member set `optional` from
            // src.contains('?') over the WHOLE source, not the member span.
            if src.contains('?') { "true".to_string() } else { "false".to_string() }
        }
        VSpec::EqLeaf => {
            let toks = lex(&src[off as usize..end as usize]);
            for (i, t) in toks.iter().enumerate() {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "=" && i + 1 < toks.len() {
                    let t2 = toks[i + 1];
                    return leaf_json(&src[off as usize + t2.off as usize..off as usize + t2.end as usize]);
                }
            }
            "null".to_string()
        }
        VSpec::TSInterfaceBodyFromPool => {
            let mut items: Vec<String> = pool.iter().map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.clear();
            let mut out = String::from("{\"type\":\"TSInterfaceBody\",\"body\":[");
            for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
            out.push_str("]}");
            out
        }
        VSpec::MemberNameComputed => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = String::from("[");
            let mut first = true;
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "[" || text == "]" { continue; }
                if !first { out.push(','); }
                first = false;
                let b = text.as_bytes();
                let literal = !b.is_empty() && (b[0] == b'"' || b[0] == b'\'' || b[0].is_ascii_digit());
                if literal { out.push_str(&leaf_json(text)); }
                else { out.push_str(&format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text))); }
            }
            out.push(']');
            out
        }
        VSpec::DeclaratorId => {
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "ObjectPattern") { pool.remove(idx).3 }
            else if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "ArrayPattern") { pool.remove(idx).3 }
            else { leaf_tok_abs(0, off, end, src) }
        }
        VSpec::MemberProperty => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut pick: Option<&Tok> = None;
            let mut in_bracket = false;
            for t in &toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "[" { in_bracket = true; continue; }
                if text == "]" { in_bracket = false; continue; }
                if in_bracket { pick = Some(t); break; }
                pick = Some(t);
            }
            if let Some(t) = pick {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text))
            } else { "null".to_string() }
        }
        VSpec::ImportName => {
            let toks = lex(&src[off as usize..end as usize]);
            if toks.is_empty() { return "null".to_string(); }
            let mut i = 0usize;
            if toks.len() > 1 {
                let t0 = &src[off as usize + toks[0].off as usize..off as usize + toks[0].end as usize];
                if t0 == "type" { i = 1; }
            }
            let t = toks[i];
            leaf_json(&src[off as usize + t.off as usize..off as usize + t.end as usize])
        }
        VSpec::PipeOp => {
            let toks = lex(&src[off as usize..end as usize]);
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "|" { return "{\"op\":\"|\"}".to_string(); }
            }
            "null".to_string()
        }
        VSpec::LtOp => {
            let toks = lex(&src[off as usize..end as usize]);
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "<" { return "{\"op\":\"<\"}".to_string(); }
            }
            "null".to_string()
        }
        VSpec::PropKey => {
            let toks = lex(&src[off as usize..end as usize]);
            if toks.is_empty() { return "null".to_string(); }
            let mut i = 0usize;
            if toks.len() > 1 {
                let t0 = &src[off as usize + toks[0].off as usize..off as usize + toks[0].end as usize];
                if t0 == "..." { i = 1; }
            }
            let t = toks[i];
            let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
            format!("{{\"type\":\"Identifier\",\"name\":{}}}", leaf_json(text))
        }
        VSpec::MemberComputed => {
            let text = &src[off as usize..end as usize];
            if text.contains('[') { "true".to_string() } else { "false".to_string() }
        }
        VSpec::CondFalse => {
            if !pool.is_empty() { pool.remove(0).3 }
            else {
                let toks = lex(&src[off as usize..end as usize]);
                let mut leaf = "null".to_string();
                for t in toks.iter().rev() {
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    if text != ":" && text != "?" { leaf = leaf_json(text); break; }
                }
                leaf
            }
        }
        VSpec::CondSeg(k) => {
            // Split the node span on top-level '?' and ':' into test / consequent /
            // alternate segments. A segment is served by a pool kid whose span sits
            // inside it (identifiers/exprs produce events); otherwise the segment
            // is a literal (number/string/keyword) → leaf of its first token.
            let text = &src[off as usize..end as usize];
            let toks = lex(text);
            let mut q: Option<usize> = None;
            let mut c: Option<usize> = None;
            let mut depth = 0i32;
            for (i, t) in toks.iter().enumerate() {
                let tt = &text[t.off as usize..t.end as usize];
                if tt == "(" || tt == "[" || tt == "{" { depth += 1; }
                else if tt == ")" || tt == "]" || tt == "}" { depth -= 1; }
                else if tt == "?" && depth == 0 && q.is_none() { q = Some(i); }
                else if tt == ":" && depth == 0 && c.is_none() { c = Some(i); }
            }
            let (s0, s1) = match k {
                0 => (0usize, q.map(|i| toks[i].off as usize).unwrap_or(text.len())),
                1 => (q.map(|i| toks[i].off as usize + 1).unwrap_or(0), c.map(|i| toks[i].off as usize).unwrap_or(text.len())),
                _ => (c.map(|i| toks[i].off as usize + 1).unwrap_or(0), text.len()),
            };
            let mut hit: Option<usize> = None;
            for (pi, (_, ko, ke, _)) in pool.iter().enumerate() {
                let ko = (*ko as usize).saturating_sub(off as usize);
                let ke = (*ke as usize).saturating_sub(off as usize);
                if ko >= s0 && ke <= s1 && ke > s0 { hit = Some(pi); break; }
            }
            if let Some(pi) = hit { return pool.remove(pi).3; }
            let mut out = "null".to_string();
            for t in &toks {
                let to = t.off as usize;
                if to < s0 || to >= s1 { continue; }
                let tt = &text[to..t.end as usize];
                if tt == "?" || tt == ":" { continue; }
                out = leaf_json(tt);
                break;
            }
            out
        }
        VSpec::FnReturnType => {
            let toks = lex(&src[off as usize..end as usize]);
            let mut has_is = false;
            let mut prev: Option<usize> = None;
            for (i, t) in toks.iter().enumerate() {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "is" { has_is = true; prev = if i > 0 { Some(i - 1) } else { None }; }
            }
            let pool_type = pool.iter().any(|(pt, _, _, j)| *pt == "Type" && !j.contains("\"off\":"));
            if has_is && pool_type {
                if let Some(pi) = prev {
                    let t = toks[pi];
                    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                    let leaf = leaf_json(text);
                    let mut ty = "null".to_string();
                    if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { ty = pool.remove(idx).3; }
                    return format!("[{},{}]", leaf, ty);
                }
            }
            if let Some(idx) = pool.iter().rposition(|(pt, _, _, _)| *pt == "Type") { pool.remove(idx).3 } else { "null".to_string() }
        }
        VSpec::NamespaceName => {
            let pre = &src[..off as usize];
            let toks = lex(pre);
            let mut name = "null".to_string();
            for (i, t) in toks.iter().enumerate() {
                let text = &pre[t.off as usize..t.end as usize];
                if text == "namespace" && i + 1 < toks.len() {
                    let t2 = toks[i + 1];
                    name = leaf_json(&pre[t2.off as usize..t2.end as usize]);
                }
            }
            name
        }
        VSpec::PropValue => {
            let text = &src[off as usize..end as usize];
            if text.trim_start().starts_with("...") { "null".to_string() }
            else if let Some(idx) = pool.iter().rposition(|_| true) { pool.remove(idx).3 }
            else { "null".to_string() }
        }
        VSpec::PropValueColon => {
            if let Some(after) = sep_after(src, off, end, ":") {
                if let Some(idx) = pool.iter().rposition(|(_, ko, _, _)| *ko >= after) {
                    return pool.remove(idx).3;
                }
                // literal value: leaf of the first token after the ':' (`a: 1`,
                // `[k]: 2` — a computed key's identifier sits BEFORE the colon)
                let text = &src[off as usize..end as usize];
                let toks = lex(text);
                for t in toks {
                    if off + t.off as u32 >= after {
                        return leaf_json(&text[t.off as usize..t.end as usize]);
                    }
                }
                return "null".to_string();
            }
            if let Some(idx) = pool.iter().rposition(|_| true) { pool.remove(idx).3 } else { "null".to_string() }
        }
        VSpec::MergeNamespace => {
            // pool entries (pop order) are Identifier(17) jsons shaped like
            // FunctionDeclaration{...}; merge: first id, all params concatenated.
            let mut items: Vec<String> = pool.iter().filter(|(pt, _, _, _)| *pt == "Identifier").map(|(_, _, _, j)| j.clone()).collect();
            items.reverse();
            pool.retain(|(pt, _, _, _)| *pt != "Identifier");
            let mut id = "null".to_string();
            let mut params = String::from("[");
            let mut first = true;
            for it in &items {
                if let Some(p) = it.find("\"id\":") {
                    let rest = &it[p + 5..];
                    if let Some(e) = rest.find(',') { if id == "null" { id = rest[..e].to_string(); } }
                }
                if let Some(p) = it.find("\"params\":") {
                    let rest = &it[p + 9..];
                    if let Some(open) = rest.find('[') {
                        let start = p + 9 + open;
                        let bytes = it.as_bytes();
                        let mut depth = 0i32;
                        let mut close: Option<usize> = None;
                        for i in start..bytes.len() {
                            match bytes[i] {
                                b'[' => depth += 1,
                                b']' => { depth -= 1; if depth == 0 { close = Some(i); break; } }
                                _ => {}
                            }
                        }
                        if let Some(c) = close {
                            let inner = &it[start + 1..c];
                            if !inner.is_empty() {
                                if !first { params.push(','); }
                                first = false;
                                params.push_str(inner);
                            }
                        }
                    }
                }
            }
            params.push(']');
            format!("{{\"type\":\"FunctionDeclaration\",\"async\":false,\"generator\":false,\"id\":{},\"typeParameters\":[],\"params\":{},\"returnType\":null,\"body\":null}}", id, params)
        }
        VSpec::SpanOff => off.to_string(),
        VSpec::SpanEnd => end.to_string(),
        VSpec::Const(s) => { let mut o = String::new(); _shape_json_string(s, &mut o); o }
        VSpec::Raw(s) => s.to_string(),
        VSpec::Flag(b) => if b { "true".to_string() } else { "false".to_string() },
        VSpec::ExprFlag => {
            let text = &src[off as usize..end as usize];
            if text.contains('{') { "false".to_string() } else { "true".to_string() }
        }
    }
}

fn leaf_json(text: &str) -> String {
    // Auto-detect leaf kind: numeric syntax → number, true/false → bool, else string.
    // BigInt literals (10n) keep the 'n' and serialize as strings.
    let b = text.as_bytes();
    let is_bigint = !b.is_empty() && b[b.len() - 1] == b'n'
        && (b[0].is_ascii_digit() || (b[0] == b'-' && b.len() > 1 && b[1].is_ascii_digit()));
    if is_bigint {
        let mut o = String::new();
        _shape_json_string(text, &mut o);
        return o;
    }
    let is_num = !b.is_empty()
        && (b[0].is_ascii_digit()
            || (b[0] == b'.' && b.len() > 1 && b[1].is_ascii_digit())
            || (b[0] == b'-' && b.len() > 1 && b[1].is_ascii_digit()));
    if is_num {
        TsStreamCustoms::default().leaf_number(text).to_string()
    } else if text == "true" || text == "false" {
        text.to_string()
    } else {
        let mut o = String::new();
        _shape_json_string(text, &mut o);
        o
    }
}
fn leaf_tok_abs(i: usize, off: u32, end: u32, src: &str) -> String {
    let toks = lex(&src[off as usize..end as usize]);
    if i >= toks.len() { return "null".to_string(); }
    let t = toks[i];
    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
    leaf_json(text)
}
fn leaf_tok_last(i: usize, off: u32, end: u32, src: &str) -> String {
    let toks = lex(&src[off as usize..end as usize]);
    if toks.len() == 0 || i >= toks.len() { return "null".to_string(); }
    let t = toks[toks.len() - 1 - i];
    let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
    leaf_json(text)
}

/// schema_for with span-aware dynamic selection: some (tag, alt) pairs carry
/// several tree meanings that are distinguishable from the source text.
fn schema_for_ev(etype: &str, alt: u32, off: u32, end: u32, src: &str) -> &'static Schema {
    let text = &src[off as usize..end as usize];
    match (etype, alt) {
        ("Type", 0) => { if text.starts_with('<') || text.starts_with('(') { &SC_TYPE_FN } else if text.contains('<') { &SC_TSTYPEREF_LT } else { schema_for(etype, alt) } }
        ("Type", 2) => { if text.contains("keyof") { &SC_TYPE_KEYOF } else { schema_for(etype, alt) } }
        ("Type", 5) => { if text.starts_with('(') { &SC_TYPE_PAREN } else { &SC_TSINDEXED5 } }
        ("Type", 6) => { if text.starts_with('[') { &SC_TYPE_TUPLE } else { &SC_TSTYPEREF_DOT } }
        ("Property", 1) => {
            let ts = text.trim_start();
            if ts.starts_with("get") || ts.starts_with("set") { &SC_PROP_GETSET } else { &SC_PROP_SHORTHAND }
        }
        ("MethodDefinition", 3) => {
            let ts = text.trim_start();
            if ts.starts_with("abstract") || ts.starts_with("protected") || ts.starts_with("private") || ts.starts_with("async") || ts.starts_with("accessor") { &SC_METHODDEF_MOD }
            else if ts.starts_with("static") {
                if text.contains('=') { schema_for(etype, alt) } else { &SC_METHODDEF_MOD }
            }
            else if ts.starts_with("get") || ts.starts_with("set") { &SC_METHODDEF_GETSET }
            else { schema_for(etype, alt) }
        }
        ("Property", 0) => {
            if text.trim_start().starts_with("...") { &SC_PROP0_REST } else { schema_for(etype, alt) }
        }
        ("ClassHeritage", 0) => {
            if text.contains('<') { &SC_CLASSHERITAGE_LT } else { schema_for(etype, alt) }
        }
        ("SequenceExpression", 8) => {
            if text.contains('.') { &SC_SEQ8_PT }
            else if let (Some(po), Some(pc)) = (text.find('('), text.rfind(')')) {
                if text[po + 1..pc].trim().is_empty() { &SC_SEQ8_LEAF }
                else { schema_for(etype, alt) }
            }
            else { &SC_SEQ8_LEAF }
        }
        ("Type", 3) => {
            if text.contains('&') { &SC_TSTYPEREF_AMP } else { schema_for(etype, alt) }
        }
        ("Type", 8) => {
            if text.contains('?') { &SC_TSTYPEREF_Q }
            else if text.starts_with("asserts") { &SC_TYPE8 }
            else { &SC_TYPE8B }
        }
        ("SequenceExpression", 11) => {
            let inner = text.trim_start_matches('[').trim_end_matches(']').trim();
            let toks = lex(&src[off as usize..end as usize]);
            if inner.len() > 0 && !inner.contains(',') && toks.len() <= 3 {
                let b = inner.as_bytes();
                if b[0] == b'"' || b[0] == b'\'' || b[0].is_ascii_digit() { &SC_SEQ11_LEAF } else { schema_for(etype, alt) }
            } else { schema_for(etype, alt) }
        }
        ("TSPropertySignature", 4) => {
            if text.contains('(') { &SC_TSPROPSIG4_METHOD } else { schema_for(etype, alt) }
        }
        // ForStatement dispatch is alt-driven (see rebuild_estree: the ForHead
        // event's alt is stashed and re-encoded here): 100/101 = classic ForHead
        // (the tree falls back to a classic ForStatement for `for (const x of
        // xs)` — the grammar parses a declarator head as the classic arm),
        // 102 = for-in, 103 = for-of.
        ("ForStatement", 100) | ("ForStatement", 101) => schema_for("ForStatement", 3),
        ("ForStatement", 102) => &SC_FORIN,
        ("ForStatement", 103) => &SC_FOROF,
        // this-param with a type annotation: span contains ':' (e.g. `this: T`)
        ("Identifier", 0) => {
            if text.contains(':') { &SC_IDENT_THIS } else { schema_for(etype, alt) }
        }
        _ => schema_for(etype, alt),
    }
}

/// Rebuild the whole estree JSON from a streaming event list (completion order).
pub fn rebuild_estree(events: &[StreamEvent], src: &str) -> String {
    let mut stack: Vec<(&'static str, u32, u32, String)> = Vec::new();
    // ForHead alts in completion order — the ForStatement schema is chosen from
    // its head's alt (in/of/classic), which the transparent ForHead pop discards.
    let mut forhead_alts: Vec<u32> = Vec::new();
    for ev in events {
        let (tag, alt, off, end) = (ev.typ, ev.alt, ev.off, ev.end);
        if tag == "ForHead" { forhead_alts.push(alt); }
        // Wrapper events re-emit the exact node already on top of the stack
        // (Stmt arm 0 wraps its BlockStatement kid; arm 17 passes a kid through).
        // Same tag + same span ⇒ same logical node ⇒ skip the duplicate push.
        if let Some(top) = stack.last() {
            if top.0 == tag && top.1 == off && top.2 == end { continue; }
            // Backtracked-parse artifacts (template holes first tried as a Type)
            // leave a spurious "Type" event with the same span as the real event.
            if top.0 == "Type" && top.1 == off && top.2 == end && tag != "Type" { stack.pop(); }
        }
        // ForStatement: re-encode the stashed ForHead alt so schema_for_ev can
        // pick ForInStatement / ForOfStatement / ForStatement per the tree.
        let mut eff_alt = alt;
        if tag == "ForStatement" && alt == 3 {
            eff_alt = 100 + forhead_alts.pop().unwrap_or(1).min(3);
        }
        let s = schema_for_ev(tag, eff_alt, off, end, src);
        let mut pool: Vec<(&'static str, u32, u32, String)> = Vec::new();
        if std::env::var("RBD").is_ok() { eprintln!("EV {} alt={} span=({},{}) stack={:?}", tag, alt, off, end, stack.iter().map(|(t,o,e,_)| format!("{}:{}-{}", t, o, e)).collect::<Vec<_>>()); }
        // Children are the contiguous top-of-stack subtrees whose spans lie
        // fully inside this node's span — sibling nodes with a matching tag
        // (e.g. a function param vs a return argument) are excluded by span.
        // Transparent tags (ForHead) are structural markers, not tree nodes:
        // discard them so their children remain collectable as this node's.
        while let Some(top) = stack.last() {
            let (ttag, toff, tend, _) = *top;
            if ttag == "ForHead" { stack.pop(); continue; }
            if (s.any_kids || s.kids.contains(&ttag)) && toff >= off && tend <= end {
                let (ttag2, toff2, tend2, j) = stack.pop().unwrap();
                pool.push((ttag2, toff2, tend2, j));
            }
            else { break; }
        }
        if s.estree == "__parengroup__" {
            // Parenthesized (or bracketed) comma group: a single element passes
            // through (pool kid if any, else the literal leaf); multiple elements
            // become SequenceExpression{expressions:[...]} (pool kids in order).
            let text = &src[off as usize..end as usize];
            let text_t = text.trim();
            let inner = if text_t.len() >= 2 && (text_t.starts_with('(') || text_t.starts_with('[')) {
                &text_t[1..text_t.len() - 1]
            } else { text_t };
            let n = count_top_level_commas(inner) + 1;
            if n <= 1 {
                let out = if !pool.is_empty() { pool.remove(0).3 }
                    else if !inner.trim().is_empty() {
                        let toks = lex(inner);
                        let t = toks[0];
                        leaf_json(&inner[t.off as usize..t.end as usize])
                    } else { "null".to_string() };
                stack.push((tag, off, end, out));
            } else {
                let mut items: Vec<String> = Vec::new();
                if pool.len() == 1 && pool[0].1 >= off && pool[0].2 <= end
                    && pool[0].1 - off <= 1 && end - pool[0].2 <= 1 {
                    // one kid covering the whole group (e.g. an object literal
                    // pre-wrapped as UnknownKid, or a nested paren group) → pass through
                    items.push(pool.remove(0).3);
                } else {
                    comma_split_elems(inner, off, &mut pool, &mut items);
                }
                let mut out = String::from("{\"type\":\"SequenceExpression\",\"expressions\":[");
                for (i, it) in items.iter().enumerate() { if i > 0 { out.push(','); } out.push_str(it); }
                out.push_str("]}");
                stack.push((tag, off, end, out));
            }
            continue;
        }
        if s.estree == "__passthrough__" {
            let out = if !pool.is_empty() { pool.remove(0).3 } else { "null".to_string() };
            stack.push((tag, off, end, out));
            continue;
        }
        if s.estree == "__seqleaf__" {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = "null".to_string();
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "[" || text == "]" { continue; }
                out = leaf_json(text);
                break;
            }
            stack.push((tag, off, end, out));
            continue;
        }
        if s.estree == "__newleaf__" {
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = "null".to_string();
            for t in toks {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text == "new" || text == "(" || text == ")" || text == ";" { continue; }
                out = leaf_json(text);
                break;
            }
            stack.push((tag, off, end, out));
            continue;
        }
        if s.estree == "__leaflast__" {
            if !pool.is_empty() {
                let out = pool.remove(0).3;
                stack.push((tag, off, end, out));
                continue;
            }
            let toks = lex(&src[off as usize..end as usize]);
            let mut out = "null".to_string();
            for t in toks.iter().rev() {
                let text = &src[off as usize + t.off as usize..off as usize + t.end as usize];
                if text != ";" { out = leaf_json(text); break; }
            }
            stack.push((tag, off, end, out));
            continue;
        }
        let mut out = String::new();
        if s.no_type { out.push('{'); }
        else {
            out.push_str("{\"type\":\"");
            out.push_str(s.estree);
            out.push('"');
        }
        let mut first = s.no_type;
        for f in s.fields {
            let val = eval_spec(f.v, &mut pool, off, end, src);
            if !first { out.push(','); }
            first = false;
            out.push('"');
            out.push_str(f.name);
            out.push_str("\":");
            out.push_str(&val);
        }
        out.push('}');
        if std::env::var("RBD").is_ok() { eprintln!("  -> pool={:?}", pool.iter().map(|(t,_,_,_)| *t).collect::<Vec<_>>()); }
        stack.push((tag, off, end, out));
    }
    stack.last().map(|(_, _, _, j)| j.clone()).unwrap_or_else(|| "null".to_string())
}

