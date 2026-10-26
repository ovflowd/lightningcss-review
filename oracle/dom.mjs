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
export const READABLE_PSEUDOS = new Set(['before', 'after', 'marker', 'first-line', 'first-letter', 'placeholder']);

const decodeIdent = (s) => (csstree.ident && csstree.ident.decode ? csstree.ident.decode(s) : s);
const decodeString = (s) => (csstree.string && csstree.string.decode ? csstree.string.decode(s) : s.replace(/^['"]|['"]$/g, ''));

/** Parse leniently; returns null if css-tree cannot parse at all. */
export function parseSheet(css) {
  try {
    return csstree.parse(css, { positions: true, parseValue: true, parseCustomProperty: false, onParseError: () => {} });
  } catch {
    return null;
  }
}

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
    } else if (node.type === 'Atrule') {
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
        if (n.type === 'PseudoElementSelector') {
          if (READABLE_PSEUDOS.has(n.name.toLowerCase())) pseudos.add('::' + n.name.toLowerCase());
          else unsupported++;
        }
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
        applyPseudoClass(el, n, ctx);
        break;
      case 'PseudoElementSelector': {
        const name = n.name.toLowerCase();
        if (name === 'marker' && el.tag === 'div') el.tag = 'li';
        if (name === 'placeholder' || name === '-webkit-input-placeholder' || name === '-moz-placeholder') {
          el.tag = 'input';
          el.attrs.placeholder = 'x';
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
      if (arg) el.attrs.dir = arg.name || 'ltr';
      return;
    case 'lang':
      if (arg) el.attrs.lang = arg.name || (arg.value ? decodeString(arg.value) : 'en');
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
  edits.sort((a, b) => b[0] - a[0]);
  let out = css;
  for (const [s, e, text] of edits) {
    if (out.slice(s, e).toLowerCase().startsWith(':')) out = out.slice(0, s) + text + out.slice(e);
  }
  return { css: out, rewrites: edits.length };
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
  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Declaration' && decls.length < limit) {
        let value = src(node.value).trim();
        value = value.replace(/!\s*important\s*$/i, '').trim();
        decls.push([node.property, value, Boolean(node.important)]);
      } else if (node.type === 'Rule' && node.prelude && node.prelude.type === 'SelectorList' && selectors.length < limit) {
        const text = src(node.prelude).trim();
        if (!text.includes('&')) selectors.push(text);
      } else if (node.type === 'Atrule' && ['media', 'supports', 'container'].includes(node.name) && node.prelude && preludes.length < limit) {
        preludes.push([node.name, src(node.prelude).trim()]);
      }
    },
  });
  return { decls, selectors, preludes, parsed: true };
}
