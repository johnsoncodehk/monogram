// patterndemand.ts's context computed eagerly (in every Pratt call's form): the twin the demand
// form must agree with, row for row.
import { patternGrammar } from './patterndemand.ts';

export default patternGrammar('eager');
