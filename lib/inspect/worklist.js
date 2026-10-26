/**
 * `lcr worklist <run>`: write analysis.json with every slot the report needs and print the open
 * ones, so the reviewing agent fills in a fixed skeleton instead of guessing what the report
 * wants.
 *
 * Stage: analysis (between the oracle and the report). Reads the stage files through the report's
 * own evaluation (lib/report/evaluate.js), so the slots are exactly the ones the report will ask
 * for. Writes analysis.json; prints the open items as JSON on stdout.
 *
 * Invariants:
 * - Existing answers are never overwritten. New checklist items and delta slots are appended;
 *   a slot no open case needs any more is marked `_stale` instead of deleted, so the reviewer's
 *   text is not lost.
 * - Deltas of one mutation family share one glob slot (`m-<parent>-*`), unless a member is a case
 *   the browsers show head worse than base: such a case needs its own exact-id slot (check A3).
 * - Checklist items scoped to files the diff does not touch start as N/A (`_prefilled`); the
 *   reviewer can overrule them.
 */
import { join } from 'node:path';

import { readJson, writeJson } from '../core/files.js';
import { print } from '../core/log.js';
import { pyGet, pyGetIn, pyOr } from '../core/py-value.js';
import { pyTruthy } from '../core/py.js';
import { compareCodePoints, dumps } from '../core/pyjson.js';
import { matches } from '../report/cases.js';
import { loadChecklists, resolveAnswers, untouchedCovers } from '../report/checklists.js';
import { evaluate, openSlots } from '../report/evaluate.js';

/** @import { Analysis, ChecklistAnswer, DeltaClassification } from '../types.js' */
/** @import { CaseRecord } from '../report/cases.js' */
/** @import { ChecklistItem } from '../report/checklists.js' */
/** @import { ChecklistLoader } from '../report/context.js' */
/** @import { Evaluation } from '../report/evaluate.js' */

/**
 * One analysis.json delta slot to fill: a case id, or a glob naming a mutation family.
 *
 * @typedef {object} DeltaSlot
 * @property {string} id
 * @property {string[]} checks The checks that list its cases.
 * @property {number} count
 * @property {string[]} cases
 */

/**
 * What `lcr worklist` prints: everything still waiting for the reviewer.
 *
 * @typedef {object} OpenItems
 * @property {string[]} checklist Unanswered checklist items.
 * @property {string[]} prefilled_na Items answered N/A automatically (files not touched).
 * @property {{ id: string, checks: string[], count: number }[]} deltas
 * @property {(string | null)[]} stale_slots Delta slots no open case needs any more.
 * @property {number[]} linked_issues
 * @property {boolean} intent True while the intent summary is empty.
 */

/**
 * @typedef {object} WorklistOptions
 * @property {ChecklistLoader} [checklists] Reads the checklists of the run's areas (default: the
 *   files under references/checklists; tests inject their own items).
 */

/**
 * Refresh analysis.json (keeping existing answers), print the open items and return them.
 *
 * @param {string} runDir
 * @param {WorklistOptions} [options]
 * @returns {Promise<OpenItems>}
 */
export async function worklist(runDir, { checklists = loadChecklists } = {}) {
  const evaluation = evaluate(runDir, { checklists });
  const prep = evaluation.prep;
  const path = join(runDir, 'analysis.json');
  const analysis = /** @type {Analysis} */ (pyOr(readJson(path), emptyAnalysis(prep.run_id)));
  const checklist = checklists(pyGet(prep, 'areas', []));

  addChecklistSlots(analysis, checklist, Object.keys(pyGet(prep, 'files', {})).sort(compareCodePoints));

  const slots = deltaSlots(evaluation);

  addDeltaSlots(analysis, slots);

  const stale = markStaleSlots(analysis, slots, evaluation.cases);

  writeJson(path, analysis);

  const answers = resolveAnswers(analysis, checklist);
  /** @type {OpenItems} */
  const open = {
    checklist: checklist
      .filter((item) => !pyTruthy(pyGetIn(answers, item.item, 'answer')))
      .map((item) => item.item),
    prefilled_na: analysis.checklist
      .filter((answer) => pyTruthy(answer._prefilled) && answer.answer === 'N/A')
      .map((answer) => /** @type {string} */ (answer.item)),
    deltas: slots.map(({ id, checks, count }) => ({ id, checks, count })),
    stale_slots: stale,
    linked_issues: pyGet(prep, 'linked_issues', []).map((issue) => issue.number),
    intent: !pyTruthy(analysis.intent.summary),
  };

  // A fixed JSON format the agent parses: two-space indent, ASCII escapes, keys in insertion order.
  print(dumps(open, { indent: 2 }));

  return open;
}

/**
 * The skeleton of a new analysis.json.
 *
 * @param {string} runId
 * @returns {Analysis}
 */
function emptyAnalysis(runId) {
  return {
    schema: 1,
    run_id: runId,
    intent: { kind: '', summary: '', claims: [], behind_flag: '' },
    checklist: [],
    deltas: [],
    findings: [],
    probes_written: [],
  };
}

/**
 * Append an entry for every checklist item that has none; prefill N/A for items about files the
 * diff does not touch.
 *
 * @param {Analysis} analysis
 * @param {readonly ChecklistItem[]} checklist
 * @param {readonly string[]} changedFiles
 * @returns {void}
 */
function addChecklistSlots(analysis, checklist, changedFiles) {
  /** @type {Map<string, ChecklistAnswer>} */
  const byItem = new Map();

  for (const answer of analysis.checklist) {
    if (answer.item && pyTruthy(answer.item)) {
      byItem.set(answer.item, answer);
    }
  }

  for (const item of checklist) {
    let entry = byItem.get(item.item);

    if (entry === undefined) {
      entry = {
        item: item.item,
        answer: '',
        evidence: '',
        note: '',
        _text: item.text,
        _severity: item.severity,
        _verify: pyGet(item, 'verify', ''),
      };
      analysis.checklist.push(entry);
    }

    if (!pyTruthy(entry.answer) && untouchedCovers(item, changedFiles)) {
      Object.assign(entry, {
        answer: 'N/A',
        evidence: `Covers ${item.covers.join(', ')}; diff touches none`,
        _prefilled: true,
      });
    }
  }
}

/**
 * Open delta slots grouped by mutation family. A family becomes one glob slot unless one of its
 * cases is head-worse-than-base in the browsers (those need an exact id, see check A3).
 *
 * @param {Pick<Evaluation, 'open' | 'cases' | 'oracleBad'>} evaluation
 * @returns {DeltaSlot[]}
 */
export function deltaSlots(evaluation) {
  const bad = new Set(evaluation.oracleBad);
  /** @type {Map<string, { id: string, checks: string[] }[]>} */
  const families = new Map();

  for (const slot of openSlots(evaluation)) {
    const key = familyGlob(evaluation.cases.get(slot.id)) ?? slot.id;
    const members = families.get(key) ?? [];

    families.set(key, members);
    members.push(slot);
  }

  /** @type {DeltaSlot[]} */
  const slots = [];

  for (const [key, members] of [...families].sort(([a], [b]) => compareCodePoints(a, b))) {
    if (key.endsWith('*') && members.length > 1 && !members.some((member) => bad.has(member.id))) {
      const checks = [...new Set(members.flatMap((member) => member.checks))].sort(compareCodePoints);

      slots.push({ id: key, checks, count: members.length, cases: members.map((member) => member.id) });
    } else {
      slots.push(...members.map(({ id, checks }) => ({ id, checks, count: 1, cases: [id] })));
    }
  }

  return slots;
}

/**
 * Glob naming every mutation of the same parent case, or null for other cases.
 *
 * @param {CaseRecord | undefined} entry
 * @returns {string | null}
 */
export function familyGlob(entry) {
  if (entry?.source === 'mutation' && entry.parent && pyTruthy(entry.parent)) {
    return `m-${entry.parent}-*`;
  }

  return null;
}

/**
 * Append a classification slot for every open slot analysis.json does not have yet.
 *
 * @param {Analysis} analysis
 * @param {readonly DeltaSlot[]} slots
 * @returns {void}
 */
function addDeltaSlots(analysis, slots) {
  const have = new Set(analysis.deltas.map((delta) => pyGet(delta, 'id', null)));

  for (const slot of slots) {
    if (have.has(slot.id)) {
      continue;
    }

    /** @type {DeltaClassification} */
    const entry = { id: slot.id, classification: '', reason: '', _check: slot.checks.join(', ') };

    if (slot.count > 1) {
      entry._count = slot.count;
    }

    analysis.deltas.push(entry);
    have.add(slot.id);
  }
}

/**
 * Mark (and list) the unclassified delta slots that no open case matches any more; clear the mark
 * on the others.
 *
 * @param {Analysis} analysis
 * @param {readonly DeltaSlot[]} slots
 * @param {Map<string, CaseRecord>} cases
 * @returns {(string | null)[]} Ids of the stale slots.
 */
function markStaleSlots(analysis, slots, cases) {
  const open = slots.flatMap((slot) =>
    slot.cases.map((id) => ({
      id,
      source: /** @type {string} */ (pyGet(cases.get(id) ?? {}, 'source', '')),
    })),
  );
  /** @type {(string | null)[]} */
  const stale = [];

  for (const delta of analysis.deltas) {
    const pattern = pyGet(delta, 'id', '');

    if (pyTruthy(delta.classification) || open.some(({ id, source }) => matches(pattern, id, source))) {
      delete delta._stale;
    } else {
      delta._stale = true;
      stale.push(pyGet(delta, 'id', null));
    }
  }

  return stale;
}
