// TypeScriptReact (`.tsx`) — TypeScript + JSX.
//
// The whole dialect is the JSX delta applied to the conformance-proven TypeScript
// grammar: typescriptreact reuses typescript.ts's rules verbatim (by name, via the
// built grammar) and adds the JSX layer. See examples/jsx.ts for why this is a
// post-process of the built grammar rather than a rule import, and for the exact
// delta. Scope name `source.tsx` matches VS Code's official TypeScriptReact grammar.
import typescript from './typescript.ts';
import { withJsx } from './jsx.ts';

export default withJsx(typescript, { name: 'typescriptreact', scopeName: 'source.tsx' });
