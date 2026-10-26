/**
 * Validity rejections: what an output makes an engine reject that the input did not.
 *
 * Stage: oracle (analysis image, compare.mjs). The engine runner reports, per sheet, whether the
 * engine accepted each probed declaration, selector and conditional prelude (probes.mjs). An
 * output that a browser partly throws away is broken in that browser even when nothing computes
 * differently on our DOM (the rejected part may target elements we did not synthesize).
 *
 * Not reported: custom properties (any value is valid), vendor prefixes of other engines
 * (`-moz-` in Chromium), and parts the input already had rejected.
 */

/** @import { ProbeInfo, ValidityProbe, Rejections, RejectedDecl, ProbeDecl } from './types.mjs' */

/** Vendor prefixes an engine does not implement: rejecting them is expected. */
const FOREIGN_PREFIXES = /** @type {Record<string, RegExp>} */ ({
  chromium: /-(moz|ms|o)-/i,
  webkit: /-(moz|ms|o)-/i,
  firefox: /-(webkit|ms|o)-/i,
});

/** Matches nothing: an unknown engine has no foreign prefixes. */
const NOTHING = /^$/;

/** `:lang()` lists longer than this are stored as a count. */
const MAX_LISTED_LANGUAGES = 4;

/**
 * Long `:lang()` lists (lowered `:dir()`) repeat in every stored selector; keep their length only.
 *
 * @param {unknown} selector
 * @returns {string}
 */
export function compactSelector(selector) {
  return String(selector).replace(/:lang\(([^()]*)\)/gi, (match, list) => {
    const count = list.split(',').length;

    return count > MAX_LISTED_LANGUAGES ? `:lang(<${count} languages>)` : match;
  });
}

/**
 * The foreign-prefix pattern of an engine.
 *
 * @param {string} engine
 * @returns {RegExp}
 */
export function foreignPrefix(engine) {
  return FOREIGN_PREFIXES[engine] || NOTHING;
}

/**
 * A value with case, whitespace and spacing around `( ) , /` normalized, for substring tests.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function squash(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),/])\s*/g, '$1')
    .trim();
}

/**
 * The input's declarations the engine rejects: exact `prop:value` keys, and `[prop, squashed value]`
 * carriers for the substring test.
 *
 * @param {ValidityProbe | undefined} inputProbe
 * @param {ProbeInfo} inputInfo
 * @returns {{ keys: Set<string>, carriers: [string, string][] }}
 */
function inputRejectedDecls(inputProbe, inputInfo) {
  const keys = new Set();
  /** @type {[string, string][]} */
  const carriers = [];

  (inputProbe ? inputProbe.decls : []).forEach((decl, index) => {
    if (inputInfo.decls && inputInfo.decls[index] === false) {
      keys.add(decl[0] + ':' + decl[1]);
      carriers.push([decl[0], squash(decl[1])]);
    }
  });

  return { keys, carriers };
}

/**
 * Declarations of one side the engine rejects and the input did not.
 *
 * @param {ProbeDecl[]} sideDecls
 * @param {ProbeInfo} sideInfo
 * @param {ValidityProbe | undefined} inputProbe
 * @param {ProbeInfo} inputInfo
 * @param {RegExp} foreign
 * @returns {RejectedDecl[]}
 */
function rejectedDecls(sideDecls, sideInfo, inputProbe, inputInfo, foreign) {
  const fromInput = inputRejectedDecls(inputProbe, inputInfo);
  const inputProps = new Set((inputProbe ? inputProbe.decls : []).map((decl) => decl[0]));
  const acceptedProps = new Set();
  /** @type {RejectedDecl[]} */
  const rejected = [];

  // The input already carried this value inside a declaration the engine rejects (a rejected
  // shorthand whose part is now printed as a longhand): the rejection predates the output.
  /** @type {(prop: string, value: string) => boolean} */
  const carried = (prop, value) => {
    const squashed = squash(value);

    return (
      squashed !== '' &&
      fromInput.carriers.some(
        ([carrier, text]) => (prop === carrier || prop.startsWith(carrier + '-')) && text.includes(squashed),
      )
    );
  };

  sideDecls.forEach((decl, index) => {
    if (sideInfo.decls && sideInfo.decls[index]) {
      acceptedProps.add(decl[0]);
    }
  });
  sideDecls.forEach((decl, index) => {
    if (!sideInfo.decls || sideInfo.decls[index] !== false) {
      return;
    }

    if (decl[0].startsWith('--') || foreign.test(decl[0]) || foreign.test(decl[1])) {
      return;
    }

    if (fromInput.keys.has(decl[0] + ':' + decl[1])) {
      return;
    }

    // A rejected declaration is a fallback chain member when another declaration of the same
    // property is accepted; only report it as hard when nothing for that property survives.
    /** @type {RejectedDecl} */
    const entry = {
      prop: decl[0],
      value: decl[1],
      important: decl[2],
      fallbackSurvives: acceptedProps.has(decl[0]),
      inInput: inputProps.has(decl[0]),
    };

    if (carried(decl[0], decl[1])) {
      entry.carrierRejected = true;
    }

    rejected.push(entry);
  });

  return rejected;
}

/**
 * Everything one side makes the engine reject that the input did not (uncapped).
 *
 * @param {Record<string, ValidityProbe>} probe The job's probes by variant.
 * @param {string} side `base` or `head`.
 * @param {ProbeInfo} sideInfo
 * @param {ProbeInfo} inputInfo
 * @param {string} engine
 * @returns {Rejections}
 */
export function sideRejections(probe, side, sideInfo, inputInfo, engine) {
  const foreign = foreignPrefix(engine);
  const inputProbe = probe.input;
  const sideProbe = probe[side];
  /** @type {Rejections} */
  const rejected = {
    decls: rejectedDecls(sideProbe ? sideProbe.decls : [], sideInfo, inputProbe, inputInfo, foreign),
    selectors: [],
    preludes: [],
  };

  (sideProbe ? sideProbe.selectors : []).forEach((selector, index) => {
    if (!(sideInfo.selectors && sideInfo.selectors[index] === false) || foreign.test(selector)) {
      return;
    }

    const inInput = (inputProbe ? inputProbe.selectors : []).some(
      (other, j) => other === selector && inputInfo.selectors && inputInfo.selectors[j] === false,
    );

    if (!inInput) {
      rejected.selectors.push(compactSelector(selector));
    }
  });

  (sideProbe ? sideProbe.preludes : []).forEach((prelude, index) => {
    if (!(sideInfo.preludes && sideInfo.preludes[index] === false) || foreign.test(prelude[1])) {
      return;
    }

    const inInput = (inputProbe ? inputProbe.preludes : []).some(
      (other, j) =>
        other[0] === prelude[0] &&
        other[1] === prelude[1] &&
        inputInfo.preludes &&
        inputInfo.preludes[j] === false,
    );

    if (!inInput) {
      rejected.preludes.push(prelude);
    }
  });

  return rejected;
}
