/**
 * `lcr baseline`'s bookkeeping without Docker (no py-final unit test; py-final's baseline.json and
 * oracle cases for a canned run and oracle result are in test/fixtures/driver/python-golden.json):
 * which probes go to the oracle, and why a probe fails on master.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { driverGolden, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { tempDir } from '../../../test/helpers/index.js';
import { readJsonl } from '../../core/files.js';
import { jsonFileText, jsonLineText } from '../../core/pyjson.js';
import { baselineProbes, probeOracleCases, uniqueCases } from '../baseline.js';
import { outputsById } from '../select.js';

/** @import { AnyCase } from '../../inspect/rows.js' */

describe('baseline', () => {
  test('oracle cases and baseline.json match py-final', () => {
    const scenario = driverGolden().baseline;

    using dir = tempDir();
    const run = writeScenario(dir.path, scenario);
    const cases = uniqueCases(/** @type {AnyCase[]} */ (readJsonl(join(run, 'corpus', 'cases.jsonl'))));
    const head = outputsById(join(run, 'corpus', 'outputs-head.jsonl'));
    const { summary, result } = scenario;

    assert.equal(jsonLineText(probeOracleCases(cases, head)), scenario.oracle_cases);

    const probes = baselineProbes(cases, { summary, head, verdicts: result.verdicts });

    assert.equal(
      jsonFileText({ master: 'c'.repeat(40), profiles: result.profiles, probes }),
      scenario.baseline,
    );
  });

  test('a repeated case id keeps its last row; cases come out sorted by id', () => {
    const rows = /** @type {AnyCase[]} */ ([
      { id: 'p-b', source: 'probe', request: {}, n: 1 },
      { id: 'p-a', source: 'probe', request: {} },
      { id: 'p-b', source: 'probe', request: {}, n: 2 },
    ]);

    assert.deepEqual(
      uniqueCases(rows).map((entry) => [entry.id, /** @type {any} */ (entry).n]),
      [
        ['p-a', undefined],
        ['p-b', 2],
      ],
    );
  });
});
