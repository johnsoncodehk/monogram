// TypeScriptReact (`.tsx`) — TypeScript + JSX.
//
// The whole dialect is the JSX delta applied to the conformance-proven TypeScript
// grammar: typescriptreact reuses typescript.ts's rules verbatim (by name, via the
// built grammar) and adds the JSX layer. The `withJsx` layer lives in
// javascriptreact.ts (the JS+JSX grammar that owns it) — so `typescriptreact →
// javascriptreact` for the JSX layer parallels `typescript → javascript` for the base
// vocabulary; see javascriptreact.ts for why it post-processes the built grammar.
// Scope name `source.tsx` matches VS Code's official TypeScriptReact grammar.
import typescript from './typescript.ts';
import { withJsx } from './javascriptreact.ts';

export default withJsx(typescript, { name: 'typescriptreact', scopeName: 'source.tsx' });
