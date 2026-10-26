/**
 * Lenient CSS parsing for the oracle, with CSS Nesting support.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). The oracle parses CSS with css-tree, an
 * independent parser, so it never relies on the Lightning CSS build under test to understand that
 * build's own output.
 *
 * css-tree only parses nested style rules that start with `&`; any other nested rule becomes a Raw
 * node (or a bogus declaration such as `div::before{...}`), and every such parse error costs a pass
 * over the whole sheet. This module forks css-tree with a Block parser that reads a statement in a
 * style block as a nested rule when a `{` comes before the next `;` or `}`. No declaration value
 * contains a top-level `{` except a custom property's, so custom properties are excluded.
 */
import * as csstree from 'css-tree';

/** @import { CssNode, CssParser } from 'css-tree' */

const TOKEN = csstree.tokenTypes;

/**
 * @param {number} type
 * @returns {boolean} Whether the token opens a group (`(`, `[`, a function).
 */
function opensGroup(type) {
  return type === TOKEN.LeftParenthesis || type === TOKEN.LeftSquareBracket || type === TOKEN.Function;
}

/**
 * @param {number} type
 * @returns {boolean} Whether the token closes a group (`)` or `]`).
 */
function closesGroup(type) {
  return type === TOKEN.RightParenthesis || type === TOKEN.RightSquareBracket;
}

/**
 * Whether the statement at the parser's position is a nested rule rather than a declaration.
 *
 * @this {CssParser}
 * @returns {boolean}
 */
function startsNestedRule() {
  if (this.tokenType === TOKEN.Ident && this.substring(this.tokenStart, this.tokenStart + 2) === '--') {
    return false;
  }

  let depth = 0;

  for (let offset = 0; ; offset++) {
    const type = this.lookupType(offset);

    if (type === TOKEN.EOF) {
      return false;
    }

    if (opensGroup(type)) {
      depth++;
    } else if (closesGroup(type) && depth > 0) {
      depth--;
    } else if (depth === 0 && type === TOKEN.LeftCurlyBracket) {
      return true;
    } else if (depth === 0 && (type === TOKEN.Semicolon || type === TOKEN.RightCurlyBracket)) {
      return false;
    }
  }
}

/**
 * css-tree's Block parser, reading nested rules without a leading `&` (see the module header).
 *
 * @this {CssParser}
 * @param {boolean} isStyleBlock
 * @returns {CssNode}
 */
function parseBlock(isStyleBlock) {
  const raw = () => this.Raw(null, true);
  const rawDeclaration = () => this.Raw(this.consumeUntilSemicolonIncluded, true);
  const start = this.tokenStart;
  const children = this.createList();

  this.eat(TOKEN.LeftCurlyBracket);

  while (!this.eof && this.tokenType !== TOKEN.RightCurlyBracket) {
    if (this.tokenType === TOKEN.WhiteSpace || this.tokenType === TOKEN.Comment) {
      this.next();
    } else if (this.tokenType === TOKEN.AtKeyword) {
      children.push(this.parseWithFallback(this.Atrule.bind(this, isStyleBlock), raw));
    } else if (!isStyleBlock || startsNestedRule.call(this)) {
      children.push(this.parseWithFallback(this.Rule, raw));
    } else if (this.tokenType === TOKEN.Semicolon) {
      children.push(rawDeclaration());
    } else {
      children.push(this.parseWithFallback(this.Declaration, rawDeclaration));

      if (this.tokenType === TOKEN.Semicolon) {
        this.next();
      }
    }
  }

  if (!this.eof) {
    this.eat(TOKEN.RightCurlyBracket);
  }

  return /** @type {CssNode} */ ({ type: 'Block', loc: this.getLocation(start, this.tokenStart), children });
}

/** css-tree with the nesting-aware Block parser. */
const nesting = csstree.fork({ node: { Block: { parse: parseBlock } } });

/**
 * Parse a sheet leniently (errors become Raw nodes, offsets recorded).
 *
 * @param {string} css
 * @returns {CssNode | null} null when css-tree cannot parse it at all.
 */
export function parseSheet(css) {
  try {
    return nesting.parse(css, {
      positions: true,
      parseValue: true,
      parseCustomProperty: false,
      onParseError: () => {},
    });
  } catch {
    return null;
  }
}

/**
 * css-tree's serialization of a sheet: equal for sheets that differ only in whitespace, comments or
 * final semicolons. A side whose text is the input's in this sense behaves like the input.
 *
 * @param {unknown} css
 * @returns {string | null} null when `css` is not a string or cannot be parsed.
 */
export function canonicalText(css) {
  const ast = typeof css === 'string' ? parseSheet(css) : null;

  return ast ? nesting.generate(ast) : null;
}

/**
 * Whether a node is a `@keyframes` rule (prefixed forms included): its selectors are keyframe
 * offsets, not selectors.
 *
 * @param {CssNode} node
 * @returns {boolean}
 */
export function isKeyframes(node) {
  return node.type === 'Atrule' && /keyframes$/i.test(node.name);
}
