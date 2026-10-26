import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { pyEquals, pyGet, pyGetIn, pyIncludes, pyList, pyOr } from '../py-value.js';
import { pyFloat } from '../pyjson.js';

describe('python values', () => {
  test('pyGet returns a stored null and the fallback only for a missing key', () => {
    assert.equal(pyGet({ a: null }, 'a', 'x'), null);
    assert.equal(pyGet({}, 'a', 'x'), 'x');
    assert.equal(pyGet(null, 'a', 'x'), 'x');
    assert.equal(pyGet(Object.create({ inherited: 1 }), 'inherited', 0), 0);
  });

  test('pyOr treats empty containers as false', () => {
    assert.deepEqual(pyOr([], 'x'), 'x');
    assert.deepEqual(pyOr({}, 'x'), 'x');
    assert.equal(pyOr(0, null), null);
    assert.equal(pyOr('a', 'b'), 'a');
  });

  test('pyGetIn reads a nested key and treats a falsy outer value as an empty mapping', () => {
    assert.equal(pyGetIn({ probe: { dom: 'x' } }, 'probe', 'dom'), 'x');
    assert.equal(pyGetIn({ probe: { dom: null } }, 'probe', 'dom'), null);
    assert.equal(pyGetIn({ probe: { dom: '' } }, 'probe', 'dom'), '');
    assert.equal(pyGetIn({ probe: {} }, 'probe', 'dom'), null);
    assert.equal(pyGetIn({ probe: null }, 'probe', 'dom'), null);
    assert.equal(pyGetIn({ probe: [] }, 'probe', 'dom'), null);
    assert.equal(pyGetIn({ probe: '' }, 'probe', 'dom'), null);
    assert.equal(pyGetIn({}, 'probe', 'dom'), null);
    assert.equal(pyGetIn(null, 'probe', 'dom'), null);
    assert.equal(pyGetIn(undefined, 'probe', 'dom'), null);
    assert.equal(pyGetIn({ probe: Object.create({ dom: 'x' }) }, 'probe', 'dom'), null);
  });

  test('pyList iterates like list()', () => {
    assert.deepEqual(pyList('ab'), ['a', 'b']);
    assert.deepEqual(pyList(['a']), ['a']);
    assert.deepEqual(pyList({ k: 1 }), ['k']);
    assert.deepEqual(pyList(3), []);
  });

  test('pyEquals compares like ==', () => {
    assert.ok(pyEquals(1, pyFloat(1)));
    assert.ok(pyEquals(true, 1));
    assert.ok(pyEquals({ a: [1, 'x'] }, { a: [1, 'x'] }));
    assert.ok(!pyEquals({ a: 1 }, { a: 1, b: 2 }));
    assert.ok(!pyEquals('1', 1));
    assert.ok(pyIncludes(['x', 2], pyFloat(2)));
  });
});
