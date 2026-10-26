// Selector -> DOM synthesis for the computed-style oracle. Uses css-tree (an independent parser),
// so the oracle never relies on the LightningCSS build under test to understand its own output.
// The goal is coverage, not proof: input and output are always evaluated on the same DOM, so a
// selector we cannot match only lowers coverage; it can never create a false "different".
import * as csstree from 'css-tree';

const STATE_ATTRS = {
  hover: 'data-lcr-hover',
  active: 'data-lcr-active',
  focus: 'data-lcr-focus',
  'focus-visible': 'data-lcr-focus-visible',
  'focus-within': 'data-lcr-focus-within',
  target: 'data-lcr-target',
  visited: 'data-lcr-visited',
};
export const READABLE_PSEUDOS = new Set(['before', 'after', 'marker', 'first-line', 'first-letter', 'placeholder', 'selection', 'backdrop', 'file-selector-button']);
// Prefixed aliases are read through the standard pseudo-element (getComputedStyle does not accept
// most prefixed names); an engine that cannot resolve the standard name reads nothing for both.
export const PSEUDO_ALIASES = {
  '-moz-placeholder': 'placeholder',
  '-webkit-input-placeholder': 'placeholder',
  '-ms-input-placeholder': 'placeholder',
  '-moz-selection': 'selection',
  '-webkit-backdrop': 'backdrop',
  '-ms-backdrop': 'backdrop',
  '-webkit-file-upload-button': 'file-selector-button',
  '-ms-browse': 'file-selector-button',
};
// CSS 2 pseudo-elements that may be written with one colon (LightningCSS prints them that way).
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
// LightningCSS lowers :dir(rtl) to :lang() over this list.
export const RTL_LANGS = new Set(['ae', 'ar', 'arc', 'bcc', 'bqi', 'ckb', 'dv', 'fa', 'glk', 'he', 'ku', 'mzn', 'nqo', 'pnb', 'ps', 'sd', 'ug', 'ur', 'yi']);

/** Standard pseudo-element name for a selector node, or null when the node is not one. */
export function pseudoElementName(node) {
  if (node.type !== 'PseudoElementSelector' && node.type !== 'PseudoClassSelector') return null;
  const name = node.name.toLowerCase();
  if (node.type === 'PseudoElementSelector') return PSEUDO_ALIASES[name] || name;
  return LEGACY_PSEUDO_ELEMENTS.has(name) ? name : null;
}

const decodeIdent = (s) => (csstree.ident && csstree.ident.decode ? csstree.ident.decode(s) : s);
const decodeString = (s) => (csstree.string && csstree.string.decode ? csstree.string.decode(s) : s.replace(/^['"]|['"]$/g, ''));

// css-tree only parses nested style rules that start with `&`; any other nested rule becomes a Raw
// node (or a bogus declaration such as `div::before{...}`), and every such parse error costs a pass
// over the whole sheet. This Block parser reads a statement in a style block as a nested rule when
// a `{` comes before the next `;` or `}` (no declaration value but a custom property's has one).
const T = csstree.tokenTypes;
function startsNestedRule() {
  if (this.tokenType === T.Ident && this.substring(this.tokenStart, this.tokenStart + 2) === '--') return false;
  let depth = 0;
  for (let i = 0; ; i++) {
    const type = this.lookupType(i);
    if (type === T.EOF) return false;
    if (type === T.LeftParenthesis || type === T.LeftSquareBracket || type === T.Function) depth++;
    else if ((type === T.RightParenthesis || type === T.RightSquareBracket) && depth > 0) depth--;
    else if (depth === 0 && type === T.LeftCurlyBracket) return true;
    else if (depth === 0 && (type === T.Semicolon || type === T.RightCurlyBracket)) return false;
  }
}
function parseBlock(isStyleBlock) {
  const raw = () => this.Raw(null, true);
  const rawDeclaration = () => this.Raw(this.consumeUntilSemicolonIncluded, true);
  const start = this.tokenStart;
  const children = this.createList();
  this.eat(T.LeftCurlyBracket);
  while (!this.eof && this.tokenType !== T.RightCurlyBracket) {
    if (this.tokenType === T.WhiteSpace || this.tokenType === T.Comment) {
      this.next();
    } else if (this.tokenType === T.AtKeyword) {
      children.push(this.parseWithFallback(this.Atrule.bind(this, isStyleBlock), raw));
    } else if (!isStyleBlock || startsNestedRule.call(this)) {
      children.push(this.parseWithFallback(this.Rule, raw));
    } else if (this.tokenType === T.Semicolon) {
      children.push(rawDeclaration());
    } else {
      children.push(this.parseWithFallback(this.Declaration, rawDeclaration));
      if (this.tokenType === T.Semicolon) this.next();
    }
  }
  if (!this.eof) this.eat(T.RightCurlyBracket);
  return { type: 'Block', loc: this.getLocation(start, this.tokenStart), children };
}
const nesting = csstree.fork({ node: { Block: { parse: parseBlock } } });

/** Parse leniently; returns null if css-tree cannot parse at all. */
export function parseSheet(css) {
  try {
    return nesting.parse(css, { positions: true, parseValue: true, parseCustomProperty: false, onParseError: () => {} });
  } catch {
    return null;
  }
}

/** css-tree's serialization: equal for sheets that differ only in whitespace, comments or final semicolons. */
export function canonicalText(css) {
  const ast = typeof css === 'string' ? parseSheet(css) : null;
  return ast ? nesting.generate(ast) : null;
}

const isKeyframes = (node) => node.type === 'Atrule' && /keyframes$/i.test(node.name);

// A selector is an array of steps: {combinator, compound: [simple nodes]}.
function toSteps(selectorNode) {
  const steps = [];
  let cur = { combinator: null, compound: [] };
  selectorNode.children.forEach((child) => {
    if (child.type === 'Combinator') {
      if (cur.compound.length || steps.length === 0) steps.push(cur);
      cur = { combinator: child.name, compound: [] };
    } else {
      cur.compound.push(child);
    }
  });
  steps.push(cur);
  return steps.filter((s, i) => s.compound.length || i === 0);
}

function hasNesting(steps) {
  return steps.some((s) => s.compound.some((n) => n.type === 'NestingSelector'));
}

/** Resolve a nested selector against its parent selectors (CSS Nesting: & means :is(parent)). */
function resolveNested(childSteps, parentList) {
  if (!parentList || !parentList.length) {
    // top level: & refers to :scope / :root; drop it
    return [childSteps.map((s) => ({ ...s, compound: s.compound.filter((n) => n.type !== 'NestingSelector') }))];
  }
  const out = [];
  for (const parent of parentList) {
    if (hasNesting(childSteps)) {
      const steps = [];
      childSteps.forEach((s, i) => {
        if (s.compound.some((n) => n.type === 'NestingSelector')) {
          const rest = s.compound.filter((n) => n.type !== 'NestingSelector');
          const p = parent.map((ps) => ({ ...ps, compound: [...ps.compound] }));
          if (i === 0) {
            p[p.length - 1].compound.push(...rest);
            steps.push(...p);
          } else {
            p[0] = { ...p[0], combinator: s.combinator };
            p[p.length - 1].compound.push(...rest);
            steps.push(...p);
          }
        } else steps.push(s);
      });
      out.push(steps);
    } else {
      const first = childSteps[0];
      const rel = first.compound.length === 0 && childSteps.length > 1;
      const tail = rel ? childSteps.slice(1) : childSteps.map((s, i) => (i === 0 ? { ...s, combinator: ' ' } : s));
      if (rel) tail[0] = { ...tail[0], combinator: childSteps[1].combinator };
      out.push([...parent, ...tail]);
    }
  }
  return out;
}

/** Collect absolute selectors (as step arrays) and pseudo-elements used, walking nesting. */
export function collectSelectors(ast) {
  const selectors = [];
  const pseudos = new Set();
  let unsupported = 0;
  const visitBlock = (block, parentList) => {
    if (!block || !block.children) return;
    block.children.forEach((node) => visitNode(node, parentList));
  };
  const visitNode = (node, parentList) => {
    if (node.type === 'Rule' && node.prelude && node.prelude.type === 'SelectorList') {
      const resolved = [];
      node.prelude.children.forEach((sel) => {
        if (sel.type !== 'Selector') return;
        resolveNested(toSteps(sel), parentList).forEach((steps) => resolved.push(steps));
      });
      resolved.forEach((s) => selectors.push(s));
      visitBlock(node.block, resolved);
    } else if (node.type === 'Atrule' && !isKeyframes(node)) {
      if (node.name === 'scope' && node.prelude) {
        // @scope (<root>) [to (<limit>)]: treat the first root selector as the parent.
        let rootList = null;
        csstree.walk(node.prelude, {
          visit: 'SelectorList',
          enter(list) {
            if (rootList) return;
            rootList = [];
            list.children.forEach((sel) => sel.type === 'Selector' && rootList.push(toSteps(sel)));
          },
        });
        visitBlock(node.block, rootList || parentList);
      } else if (node.block) {
        visitBlock(node.block, parentList);
      }
    }
  };
  visitBlock(ast, null);
  for (const steps of selectors) {
    for (const s of steps) {
      for (const n of s.compound) {
        const name = pseudoElementName(n);
        if (name === null) continue;
        if (READABLE_PSEUDOS.has(name)) pseudos.add('::' + name);
        else unsupported++;
      }
    }
  }
  return { selectors, pseudos: [...pseudos].sort(), unsupported };
}

// ---------------------------------------------------------------------------------------------
// Element model

function newEl(tag = 'div') {
  return { tag, id: null, classes: [], attrs: {}, children: [], text: null, empty: false };
}

function nthIndex(nth) {
  // smallest positive n (1-based index) matching An+B
  if (!nth) return 1;
  if (nth.type === 'AnPlusB') {
    const a = Number(nth.a || 0);
    const b = Number(nth.b || 0);
    for (let k = 1; k <= 20; k++) {
      if (a === 0 ? k === b : (k - b) / a >= 0 && Number.isInteger((k - b) / a)) return k;
    }
    return 1;
  }
  if (nth.type === 'Identifier') return nth.name === 'even' ? 2 : 1;
  return 1;
}

function applyCompound(el, compound, ctx) {
  for (const n of compound) {
    switch (n.type) {
      case 'TypeSelector': {
        const name = n.name.includes('|') ? n.name.split('|').pop() : n.name;
        if (name !== '*') el.tag = name.toLowerCase();
        break;
      }
      case 'ClassSelector':
        el.classes.push(decodeIdent(n.name));
        break;
      case 'IdSelector':
        el.id = decodeIdent(n.name);
        break;
      case 'AttributeSelector': {
        const name = decodeIdent(n.name.name);
        let value = '';
        if (n.value) value = n.value.type === 'String' ? decodeString(n.value.value) : n.value.name || '';
        if (n.matcher === '|=' || n.matcher === '^=' || n.matcher === '~=' || n.matcher === '$=' || n.matcher === '*=' || n.matcher === '=') el.attrs[name] = value;
        else el.attrs[name] = el.attrs[name] || '';
        break;
      }
      case 'PseudoClassSelector':
        if (pseudoElementName(n) === null) applyPseudoClass(el, n, ctx);
        break;
      case 'PseudoElementSelector': {
        const name = pseudoElementName(n);
        if (name === 'marker' && el.tag === 'div') el.tag = 'li';
        if (name === 'placeholder') {
          el.tag = 'input';
          el.attrs.placeholder = 'x';
        }
        if (name === 'file-selector-button') {
          el.tag = 'input';
          el.attrs.type = 'file';
        }
        break;
      }
      case 'NestingSelector':
        break;
      default:
        ctx.unsupported++;
    }
  }
}

function firstCompoundOf(selectorList) {
  let first = null;
  if (!selectorList) return null;
  selectorList.children.forEach((sel) => {
    if (first || sel.type !== 'Selector') return;
    const steps = toSteps(sel);
    if (steps.length === 1) first = steps[0].compound;
  });
  return first;
}

function applyPseudoClass(el, n, ctx) {
  const name = n.name.toLowerCase();
  const arg = n.children && n.children.first ? n.children.first : null;
  if (STATE_ATTRS[name]) {
    el.attrs[STATE_ATTRS[name]] = '';
    return;
  }
  switch (name) {
    case 'is':
    case 'where':
    case 'matches':
    case '-webkit-any':
    case '-moz-any': {
      const comp = arg && arg.type === 'SelectorList' ? firstCompoundOf(arg) : null;
      if (comp) applyCompound(el, comp, ctx);
      else ctx.unsupported++;
      return;
    }
    case 'has': {
      // :has(> .x) / :has(.x) / :has(+ .x): add a matching child or next sibling
      if (arg && arg.type === 'SelectorList') {
        arg.children.forEach((sel, i) => {
          if (i > 0 || sel.type !== 'Selector') return;
          const steps = toSteps(sel);
          const child = newEl();
          applyCompound(child, steps[steps.length - 1].compound, ctx);
          const comb = steps.length > 1 ? steps[1].combinator : steps[0].combinator || ' ';
          if (comb === '+' || comb === '~') (el.afterSiblings = el.afterSiblings || []).push(child);
          else el.children.push(child);
        });
      }
      return;
    }
    case 'not':
      return; // fresh elements rarely match the argument
    case 'root':
      ctx.root = true;
      return;
    case 'empty':
      el.empty = true;
      return;
    case 'dir':
      // An RTL element normally carries an RTL language, which is what lowered :dir(rtl) matches.
      if (arg) el.attrs.dir = arg.name || 'ltr';
      if (el.attrs.dir === 'rtl' && !el.attrs.lang) el.attrs.lang = 'ar';
      return;
    case 'lang':
      if (arg) el.attrs.lang = arg.name || (arg.value ? decodeString(arg.value) : 'en');
      if (RTL_LANGS.has(String(el.attrs.lang).toLowerCase().split('-')[0]) && !el.attrs.dir) el.attrs.dir = 'rtl';
      return;
    case 'link':
    case 'any-link':
    case '-webkit-any-link':
      el.tag = 'a';
      el.attrs.href = '#lcr';
      return;
    case 'checked':
    case 'default':
      el.tag = 'input';
      el.attrs.type = 'checkbox';
      el.attrs.checked = '';
      return;
    case 'disabled':
      el.tag = el.tag === 'div' ? 'input' : el.tag;
      el.attrs.disabled = '';
      return;
    case 'enabled':
    case 'optional':
    case 'read-write':
      el.tag = el.tag === 'div' ? 'input' : el.tag;
      return;
    case 'required':
    case 'invalid':
    case 'user-invalid':
      el.tag = el.tag === 'div' ? 'input' : el.tag;
      el.attrs.required = '';
      return;
    case 'read-only':
      el.tag = el.tag === 'div' ? 'input' : el.tag;
      el.attrs.readonly = '';
      return;
    case 'placeholder-shown':
    case '-moz-placeholder-shown':
      el.tag = 'input';
      el.attrs.placeholder = 'x';
      return;
    case 'first-child':
    case 'last-child':
    case 'only-child':
    case 'first-of-type':
    case 'last-of-type':
    case 'only-of-type':
      return; // satisfied by construction (each step is a fresh, single child)
    case 'nth-child':
    case 'nth-of-type': {
      const k = arg && arg.nth ? nthIndex(arg.nth) : 1;
      el.spacersBefore = Math.max(el.spacersBefore || 0, k - 1);
      el.spacerTag = name === 'nth-of-type' ? el.tag : 'span';
      return;
    }
    case 'nth-last-child':
    case 'nth-last-of-type': {
      const k = arg && arg.nth ? nthIndex(arg.nth) : 1;
      el.spacersAfter = Math.max(el.spacersAfter || 0, k - 1);
      return;
    }
    default:
      ctx.unsupported++;
  }
}

/** Build a DOM fragment for one absolute selector. */
function buildPath(steps, ctx) {
  const rootCtx = { root: false };
  let top = null;
  let prev = null;
  let parentOfPrev = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const el = newEl();
    const local = { unsupported: 0, root: false };
    applyCompound(el, step.compound, local);
    ctx.unsupported += local.unsupported;
    if (i === 0 && (local.root || el.tag === 'html')) {
      // :root / html: attributes go on the document element, children start under #lcr-root
      for (const c of el.classes) ctx.rootAttrs.class = ((ctx.rootAttrs.class || '') + ' ' + c).trim();
      Object.assign(ctx.rootAttrs, el.attrs);
      if (el.id) ctx.rootAttrs.id = el.id;
      rootCtx.root = true;
      continue;
    }
    if (i <= 1 && el.tag === 'body') {
      // body is shared by every case; only attributes can be set, which would leak. Skip it.
      ctx.unsupported++;
      continue;
    }
    if (!prev) {
      top = el;
      parentOfPrev = null;
    } else {
      const comb = step.combinator || ' ';
      if (comb === '+' || comb === '~') {
        el.parentRef = parentOfPrev;
        (prev.afterSiblings = prev.afterSiblings || []).push(el);
        if (!parentOfPrev) {
          // siblings of the top element: wrap both in a container
          const wrap = newEl('div');
          wrap.children.push(top);
          top = wrap;
          parentOfPrev = wrap;
        }
        prev = el;
        continue;
      } else {
        prev.children.push(el);
        parentOfPrev = prev;
      }
    }
    prev = el;
  }
  if (prev && !prev.empty) prev.text = 'x';
  return top;
}

function render(el, parentTag = 'div') {
  if (!el) return '';
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'area', 'col', 'embed', 'source', 'track', 'wbr']);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const tag = /^[a-z][a-z0-9-]*$/.test(el.tag) ? el.tag : 'div';
  let attrs = '';
  if (el.id) attrs += ` id="${esc(el.id)}"`;
  if (el.classes.length) attrs += ` class="${esc(el.classes.join(' '))}"`;
  for (const [k, v] of Object.entries(el.attrs)) if (/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(k)) attrs += ` ${k}="${esc(v)}"`;
  const spacers = (n, t) => Array.from({ length: n || 0 }, () => `<${t || 'span'}></${t || 'span'}>`).join('');
  // An element followed by its sibling chain (`+` / `~` steps), rendered recursively.
  const withSiblings = (c) => render(c, tag) + (c.afterSiblings || []).map((s) => withSiblings(s)).join('');
  const inner = el.empty ? '' : el.children.map(withSiblings).join('') + (el.text || '');
  let html = voidTags.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner}</${tag}>`;
  if (tag === 'li' && !['ul', 'ol', 'menu'].includes(parentTag)) html = `<ul>${html}</ul>`;
  if (['td', 'th'].includes(tag) && parentTag !== 'tr') html = `<table><tbody><tr>${html}</tr></tbody></table>`;
  if (tag === 'tr' && !['tbody', 'thead', 'tfoot', 'table'].includes(parentTag)) html = `<table><tbody>${html}</tbody></table>`;
  if (tag === 'option' && !['select', 'datalist', 'optgroup'].includes(parentTag)) html = `<select>${html}</select>`;
  return spacers(el.spacersBefore, el.spacerTag) + html + spacers(el.spacersAfter, el.spacerTag);
}

const GENERIC_DOM = '<div class="lcr-generic"><p>x <span>y</span> <a href="#lcr">z</a></p><ul><li>i</li></ul><input placeholder="x"></div>';

/** Synthesize one DOM for all sheets of a case. */
export function synthesize(sheets, { maxSelectors = 60 } = {}) {
  const ctx = { unsupported: 0, rootAttrs: {} };
  const seen = new Set();
  const parts = [];
  const pseudos = new Set();
  let total = 0;
  for (const css of sheets) {
    const ast = parseSheet(css);
    if (!ast) continue;
    const found = collectSelectors(ast);
    found.pseudos.forEach((p) => pseudos.add(p));
    ctx.unsupported += found.unsupported;
    for (const steps of found.selectors) {
      total++;
      const key = JSON.stringify(steps.map((s) => [s.combinator, s.compound.map((n) => csstree.generate(n))]));
      if (seen.has(key)) continue;
      seen.add(key);
      if (parts.length >= maxSelectors) continue;
      const top = buildPath(steps, ctx);
      if (top) parts.push(`<div class="lcr-case">${render(top)}${(top.afterSiblings || []).map((x) => render(x)).join('')}</div>`);
    }
  }
  const html = parts.length ? parts.join('') : GENERIC_DOM;
  return { html, pseudos: [...pseudos].sort(), rootAttrs: ctx.rootAttrs, selectors: total, synthesized: parts.length, unsupported: ctx.unsupported, generic: !parts.length };
}

/** Readable pseudo-elements used by any of the sheets (for a DOM given by the case, not synthesized). */
export function collectPseudos(sheets) {
  const pseudos = new Set();
  for (const css of sheets) {
    const ast = parseSheet(css);
    if (ast) collectSelectors(ast).pseudos.forEach((p) => pseudos.add(p));
  }
  return [...pseudos].sort();
}

const CUSTOM_REF = /var\(\s*(--[A-Za-z0-9_\-\u0080-\uffff]+)\s*(,)?/g;
const COLOR_PROP = /(^|-)color$|^(fill|stroke|background|outline|text-decoration|text-emphasis|column-rule)$/;

/** Custom properties the sheet references without a fallback but never defines, each with a
 *  stand-in value typed after the first property that consumes it (`[name, value]`, sorted).
 *  Without a definition the consuming declaration is invalid at computed-value time and the input
 *  touches nothing, so the case could never be judged. */
export function undefinedCustomProperties(css) {
  const ast = parseSheet(css);
  if (!ast) return [];
  const defined = new Set();
  const used = new Map();
  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Atrule' && node.name.toLowerCase() === 'property' && node.prelude) {
        defined.add(csstree.generate(node.prelude).trim());
      }
      if (node.type !== 'Declaration' || !node.loc) return;
      if (node.property.startsWith('--')) defined.add(node.property);
      const text = css.slice(node.value.loc ? node.value.loc.start.offset : node.loc.start.offset, node.loc.end.offset);
      for (const m of text.matchAll(CUSTOM_REF)) {
        if (m[2] || used.has(m[1])) continue;
        used.set(m[1], COLOR_PROP.test(node.property.toLowerCase()) ? 'rgb(1, 2, 3)' : '5px');
      }
    },
  });
  return [...used].filter(([name]) => !defined.has(name)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Rewrite user-action pseudo-classes in style-rule preludes to attribute selectors, identically
 *  for every sheet, by editing exact source offsets (the rest of the text is untouched). */
export function rewriteStates(css) {
  const ast = parseSheet(css);
  if (!ast) return { css, rewrites: 0 };
  const edits = [];
  csstree.walk(ast, {
    visit: 'PseudoClassSelector',
    enter(node) {
      const attr = STATE_ATTRS[node.name.toLowerCase()];
      if (!attr || !node.loc || node.children) return;
      edits.push([node.loc.start.offset, node.loc.end.offset, `[${attr}]`]);
    },
  });
  edits.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [s, e, text] of edits) {
    if (s < at || !css.slice(s, e).startsWith(':')) continue;
    parts.push(css.slice(at, s), text);
    at = e;
  }
  parts.push(css.slice(at));
  return { css: parts.join(''), rewrites: edits.length };
}

const AT_KEYWORD = /@(?:[-\w]|\\[0-9a-fA-F]{1,6}\s?|\\.)+/y;

/** Whether parentheses and brackets balance outside strings and comments. */
export function balanced(text) {
  const stack = [];
  const close = { ')': '(', ']': '[' };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (ch === '(' || ch === '[') stack.push(ch);
    else if (close[ch] && stack.pop() !== close[ch]) return false;
  }
  return stack.length === 0;
}

/** Lists for the engine to test: declarations, selectors, conditional preludes (per sheet). */
export function validityProbe(css, limit = 400) {
  const ast = parseSheet(css);
  const decls = [];
  const selectors = [];
  const preludes = [];
  if (!ast) return { decls, selectors, preludes, parsed: false };
  // Probe the exact source text (loc offsets), never a re-serialization.
  const src = (node) => (node && node.loc ? css.slice(node.loc.start.offset, node.loc.end.offset) : node ? csstree.generate(node) : '');
  // css-tree's prelude loc can start after a leading `(` (`@supports ((a:b) or (c:d))`) and end
  // before the last `)`: the prelude is everything between the at-keyword and the block.
  const preludeSrc = (node) => {
    if (node.loc && node.block && node.block.loc) {
      AT_KEYWORD.lastIndex = node.loc.start.offset;
      if (AT_KEYWORD.exec(css)) {
        const text = css.slice(AT_KEYWORD.lastIndex, node.block.loc.start.offset).trim();
        if (balanced(text)) return text;
      }
    }
    return csstree.generate(node.prelude);
  };
  // Nested rule selectors are only valid relative to their parent, and keyframe selectors are
  // not selectors at all: neither is probed on its own.
  let rules = 0;
  let keyframes = 0;
  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Declaration' && decls.length < limit) {
        let value = src(node.value).trim();
        value = value.replace(/!\s*important\s*$/i, '').trim();
        decls.push([node.property, value, Boolean(node.important)]);
      } else if (node.type === 'Rule') {
        if (node.prelude && node.prelude.type === 'SelectorList' && selectors.length < limit && !rules && !keyframes) {
          const text = src(node.prelude).trim();
          if (!text.includes('&')) selectors.push(text);
        }
        rules++;
      } else if (node.type === 'Atrule') {
        if (isKeyframes(node)) keyframes++;
        if (['media', 'supports', 'container'].includes(node.name.toLowerCase()) && node.prelude && preludes.length < limit) preludes.push([node.name, preludeSrc(node).trim()]);
      }
    },
    leave(node) {
      if (node.type === 'Rule') rules--;
      else if (isKeyframes(node)) keyframes--;
    },
  });
  return { decls, selectors, preludes, parsed: true };
}
