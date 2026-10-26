/// <reference lib="dom" />
/**
 * In-page computed-style snapshot of a sheet job.
 *
 * Stage: oracle (engine runner). `pageSnapshot` is passed to `page.evaluate`, which serializes it
 * with `toString()` and runs it inside the browser: it must be self-contained (no module-scope
 * references, so its helpers are nested) and run in the oldest engines we drive (Chromium 97,
 * Firefox 93, WebKit 15.4).
 *
 * For each sheet of the job it reads the computed style of every element (and of each readable
 * pseudo-element) and asks the engine which declarations, selectors and conditions it accepts.
 * To keep result files small it returns only what the comparison needs:
 * - the reference variant (`input`): the properties it changes versus the empty sheet (`touched`);
 * - every other variant: the properties that differ from the reference (`diff`);
 * - lowering jobs (`job.props`, legacy profiles): the raw values of the elements and properties
 *   the reference engine saw the input touch (`values`), for every variant but `empty`.
 */
'use strict';

/** @import { SheetJob, SnapshotResult, SnapshotVariant, StyleMap, ProbeInfo, ValidityProbe, RawDiff } from '../../lib/types.mjs' */

/* eslint-disable max-lines-per-function -- serialized into the page with toString(): its helpers must be nested */
/**
 * Read every sheet of a job in the current page.
 *
 * @param {SheetJob} job
 * @returns {SnapshotResult}
 */
function pageSnapshot(job) {
  const root = /** @type {HTMLElement} */ (document.getElementById('lcr-root'));
  const styleElement = /** @type {HTMLStyleElement} */ (document.getElementById('lcr-style'));
  const rootAttrs = job.rootAttrs || {};
  const referenceName = job.reference || 'input';

  root.innerHTML = job.html || '';
  Object.keys(rootAttrs).forEach((name) => {
    document.documentElement.setAttribute(name, rootAttrs[name]);
  });

  const descendants = root.querySelectorAll('*');
  /** @type {Element[]} */
  const elements = [document.documentElement, document.body];

  for (let i = 0; i < descendants.length; i++) {
    elements.push(descendants[i]);
  }

  /** @type {(string | null)[]} */
  const pseudos = [/** @type {string | null} */ (null)].concat(job.pseudos || []);
  const propsFilter = job.props ? new Set(job.props) : null;
  const keysFilter = job.keys ? new Set(job.keys) : null;

  /**
   * Computed values of one element or pseudo-element (all properties, or the job's subset).
   *
   * @param {Element} element
   * @param {string | null} pseudo
   * @returns {Record<string, string>}
   */
  function readStyle(element, pseudo) {
    const style = getComputedStyle(element, pseudo);
    /** @type {Record<string, string>} */
    const values = {};

    if (propsFilter) {
      propsFilter.forEach((prop) => {
        values[prop] = style.getPropertyValue(prop);
      });
    } else {
      for (let i = 0; i < style.length; i++) {
        values[style[i]] = style.getPropertyValue(style[i]);
      }
    }

    return values;
  }

  /**
   * Stable element key: `html`, `body`, or `<tag>#<document-order index under #lcr-root>`.
   *
   * @param {Element} element
   * @returns {string}
   */
  function label(element) {
    if (element === document.documentElement) {
      return 'html';
    }

    if (element === document.body) {
      return 'body';
    }

    return element.tagName.toLowerCase() + '#' + Array.prototype.indexOf.call(descendants, element);
  }

  // Validity probes insert into a scratch sheet, never into the sheet being read.
  const scratch = document.createElement('style');

  document.head.appendChild(scratch);

  const scratchSheet = /** @type {CSSStyleSheet} */ (scratch.sheet);

  /**
   * @param {string} prop
   * @param {string} value
   * @param {boolean} important
   * @returns {boolean}
   */
  function acceptsDecl(prop, value, important) {
    const style = document.createElement('div').style;

    style.setProperty(prop, value, important ? 'important' : '');

    return style.length > 0 || style.getPropertyValue(prop) !== '';
  }

  /**
   * @param {string} selector
   * @returns {boolean}
   */
  function acceptsSelector(selector) {
    try {
      scratchSheet.insertRule(selector + '{}', 0);
      scratchSheet.deleteRule(0);

      return true;
    } catch {
      return false;
    }
  }

  // An unknown media query parses as `not all` instead of throwing.
  /**
   * @param {string} kind
   * @param {string} prelude
   * @returns {boolean}
   */
  function acceptsPrelude(kind, prelude) {
    try {
      scratchSheet.insertRule('@' + kind + ' ' + prelude + '{}', 0);

      const rule = /** @type {CSSMediaRule} */ (scratchSheet.cssRules[0]);
      let accepted = true;

      if (kind === 'media' && rule.media) {
        accepted = rule.media.mediaText !== 'not all';
      }

      scratchSheet.deleteRule(0);

      return accepted;
    } catch {
      return false;
    }
  }

  /**
   * @param {ValidityProbe | null} probe
   * @returns {ProbeInfo}
   */
  function probeValidity(probe) {
    /** @type {ProbeInfo} */
    const info = {};

    if (probe) {
      info.decls = (probe.decls || []).map((decl) => acceptsDecl(decl[0], decl[1], decl[2]));
      info.selectors = (probe.selectors || []).map(acceptsSelector);
      info.preludes = (probe.preludes || []).map((prelude) => acceptsPrelude(prelude[0], prelude[1]));
    }

    return info;
  }

  /** @returns {StyleMap} */
  function readAll() {
    /** @type {StyleMap} */
    const snap = {};

    for (let e = 0; e < elements.length; e++) {
      for (let p = 0; p < pseudos.length; p++) {
        snap[label(elements[e]) + (pseudos[p] || '')] = readStyle(elements[e], pseudos[p]);
      }
    }

    return snap;
  }

  const variantNames = Object.keys(job.sheets);
  /** @type {Record<string, { snap: StyleMap, info: ProbeInfo }>} */
  const read = {};

  for (let v = 0; v < variantNames.length; v++) {
    const name = variantNames[v];

    styleElement.textContent = job.sheets[name];
    read[name] = { snap: readAll(), info: probeValidity((job.probe && job.probe[name]) || null) };
  }

  styleElement.textContent = '';
  scratch.remove();

  const reference = read[referenceName];
  const empty = read.empty;

  /**
   * Lowering jobs: the raw values of the requested element keys.
   *
   * @param {StyleMap} snap
   * @returns {StyleMap}
   */
  function selectedValues(snap) {
    /** @type {StyleMap} */
    const values = {};

    Object.keys(snap).forEach((key) => {
      if (!keysFilter || keysFilter.has(key)) {
        values[key] = snap[key];
      }
    });

    return values;
  }

  /**
   * The reference variant: what it changes versus the empty sheet.
   *
   * @param {StyleMap} snap
   * @returns {StyleMap}
   */
  function touchedValues(snap) {
    /** @type {StyleMap} */
    const touched = {};

    Object.keys(snap).forEach((key) => {
      const values = snap[key];
      const base = empty ? empty.snap[key] : null;

      Object.keys(values).forEach((prop) => {
        if (!base || base[prop] !== values[prop]) {
          (touched[key] = touched[key] || {})[prop] = values[prop];
        }
      });
    });

    return touched;
  }

  /**
   * Another variant: every (element, property) whose value differs from the reference's.
   *
   * @param {StyleMap} snap
   * @returns {RawDiff[]}
   */
  function diffFromReference(snap) {
    /** @type {RawDiff[]} */
    const diff = [];

    Object.keys(snap).forEach((key) => {
      const values = snap[key];
      const ref = reference.snap[key] || {};

      Object.keys(values).forEach((prop) => {
        if (ref[prop] !== values[prop]) {
          diff.push([key, prop, ref[prop] === undefined ? null : ref[prop], values[prop]]);
        }
      });
      Object.keys(ref).forEach((prop) => {
        if (!(prop in values)) {
          diff.push([key, prop, ref[prop], null]);
        }
      });
    });

    return diff;
  }

  /** @type {SnapshotResult} */
  const packed = { elements: elements.map(label), variants: {} };

  variantNames.forEach((name) => {
    const current = read[name];
    /** @type {SnapshotVariant} */
    const entry = { info: current.info };

    if (job.props) {
      if (name !== 'empty') {
        entry.values = selectedValues(current.snap);
      }
    } else if (name === referenceName) {
      entry.touched = touchedValues(current.snap);
    } else if (name !== 'empty') {
      entry.diff = diffFromReference(current.snap);
    }

    packed.variants[name] = entry;
  });

  return packed;
}
/* eslint-enable max-lines-per-function */

module.exports = { pageSnapshot };
