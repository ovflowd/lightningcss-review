/**
 * Risk flags: cheap, deterministic signals about a change that tell the reviewer where to look
 * (a core file, source changes without tests, removed test expectations, hand-edited generated
 * files, new `unwrap()`/`panic!`/`unsafe`, new public API, bindings, new properties, …).
 *
 * Stage: prepare (prepare.json `risk_flags`). Build reads `bindings`, `public-api` and
 * `ast-types-changed` to decide which JS-lane steps run; the report lists every flag.
 *
 * Invariant: flags come out in a fixed order and every `paths` list is sorted, so prepare.json
 * is byte-identical for the same diff.
 */
import { loadConfig } from '../core/paths.js';
import { pyRe } from '../core/py-re.js';
import { compareCodePoints } from '../core/py.js';

/** @import { AreasConfig, RiskFlag } from '../types.js' */
/** @import { FileHunks } from './diff.js' */

/**
 * @typedef {object} ChangedFileInfo prepare's working entry of one changed file.
 * @property {string} [status]
 * @property {string[]} [added_lines]
 * @property {string[]} [removed_lines]
 */

/** Above this many changed lines a diff is flagged as large. */
const LARGE_DIFF_LINES = 600;
const DEPENDENCY_MANIFESTS = ['Cargo.toml', 'Cargo.lock', 'package.json', 'yarn.lock'];
const BINDING_PREFIXES = ['node/', 'napi/', 'wasm/', 'c/'];
/** Generated files whose generator is scripts/build-prefixes.js. */
const PREFIX_GENERATED = ['src/compat.rs', 'src/prefixes.rs'];
const EM_DASH = String.fromCodePoint(0x2014);

/** Patterns over added library Rust lines, in report order: [id, pattern, detail]. */
const ADDED_LINE_PATTERNS = /** @type {const} */ ([
  [
    'added-unwrap',
    String.raw`\.unwrap\(\)|\.expect\(`,
    'new unwrap()/expect() in library code (panics on user input?)',
  ],
  [
    'added-panic',
    String.raw`\b(panic!|unreachable!|todo!|unimplemented!)\(`,
    'new panic!/unreachable!/todo! in library code',
  ],
  ['added-unsafe', String.raw`\bunsafe\b`, 'new unsafe code'],
  ['added-float-compare', String.raw`==\s*-?\d+\.\d+|\d+\.\d+\s*==`, 'float equality comparison'],
  ['added-clone-heavy', String.raw`\.to_vec\(\)|\.to_owned\(\)\.clone\(\)`, 'extra allocations in hot paths'],
]).map(([id, pattern, detail]) => ({ id, pattern: pyRe(pattern), detail }));

const PUB_ITEM = pyRe(String.raw`^\s*pub (fn|struct|enum|trait|mod|type|const|use)\b`);
const PROPERTY_ENTRY = pyRe(String.raw`^\s*"([a-z-]+)":`);

/**
 * Collects flags in order; paths are sorted on the way in.
 */
class FlagList {
  constructor() {
    /** @type {RiskFlag[]} */
    this.flags = [];
  }

  /**
   * @param {string} id
   * @param {string} detail
   * @param {Iterable<string>} [paths]
   */
  add(id, detail, paths = []) {
    this.flags.push({ id, detail, paths: [...paths].sort(compareCodePoints) });
  }
}

/**
 * The risk flags of a change.
 *
 * @param {Map<string, ChangedFileInfo>} files Every changed path with its added/removed lines.
 * @param {Map<string, FileHunks>} hunks `parseHunks` of the patch.
 * @returns {RiskFlag[]}
 */
export function riskFlags(files, hunks) {
  const config = /** @type {AreasConfig} */ (loadConfig('areas.json'));
  const paths = new Set(files.keys());
  const sourceChanges = [...paths].filter(
    (path) => (path.startsWith('src/') || path.startsWith('selectors/')) && path !== 'src/lib.rs',
  );
  const flags = new FlagList();

  addStructureFlags(flags, config, paths, sourceChanges, hunks);
  addAddedCodeFlags(flags, files, sourceChanges);
  addSurfaceFlags(flags, files, paths, sourceChanges);

  return flags.flags;
}

/**
 * Which files changed: core files, tests, generated files, the selectors crate, manifests, size.
 *
 * @param {FlagList} flags
 * @param {AreasConfig} config
 * @param {Set<string>} paths
 * @param {string[]} sourceChanges
 * @param {Map<string, FileHunks>} hunks
 * @returns {void}
 */
function addStructureFlags(flags, config, paths, sourceChanges, hunks) {
  const testChanges = [...paths].filter(
    (path) => path === 'src/lib.rs' || path.startsWith('tests/') || path.startsWith('node/test/'),
  );
  const core = [...paths].filter((path) => config.core_files.includes(path));
  const libHunks = hunks.get('src/lib.rs');

  if (core.length > 0) {
    flags.add('core-file', 'touches files with a wide blast radius', core);
  }

  if (sourceChanges.length > 0 && testChanges.length === 0) {
    flags.add('no-tests', 'source changes without test changes', sourceChanges);
  }

  if (libHunks?.removed) {
    flags.add(
      'test-lines-removed',
      `${libHunks.removed} line(s) removed from src/lib.rs (expectations changed or deleted)`,
      ['src/lib.rs'],
    );
  }

  addGeneratedFlags(flags, config, paths);

  const selectors = [...paths].filter((path) => path.startsWith('selectors/'));

  if (selectors.length > 0) {
    flags.add(
      'selectors-crate',
      'touches the forked parcel_selectors crate (published separately)',
      selectors,
    );
  }

  const manifests = DEPENDENCY_MANIFESTS.filter((path) => paths.has(path));

  if (manifests.length > 0) {
    flags.add('dependencies', 'dependency manifests changed', manifests);
  }

  const added = [...hunks.values()].reduce((sum, hunk) => sum + hunk.added, 0);
  const removed = [...hunks.values()].reduce((sum, hunk) => sum + hunk.removed, 0);

  if (added + removed > LARGE_DIFF_LINES) {
    flags.add('large-diff', `+${added}/-${removed} lines`, []);
  }
}

/**
 * Generated files edited in the diff, in config order. src/compat.rs and src/prefixes.rs are fine
 * when their generator changed too (then they were regenerated).
 *
 * @param {FlagList} flags
 * @param {AreasConfig} config
 * @param {Set<string>} paths
 * @returns {void}
 */
function addGeneratedFlags(flags, config, paths) {
  for (const [generated, command] of Object.entries(config.generated_files)) {
    if (!paths.has(generated)) {
      continue;
    }

    if (PREFIX_GENERATED.includes(generated) && !paths.has('scripts/build-prefixes.js')) {
      flags.add(
        'generated-edited',
        `${generated} changed; it is generated by \`${command}\` ${EM_DASH} verify it was regenerated, not hand-edited`,
        [generated],
      );
    } else if (generated === 'node/ast.d.ts') {
      flags.add('ast-types-changed', 'node/ast.d.ts changed; verify it matches `yarn build-ast` output', [
        generated,
      ]);
    }
  }
}

/**
 * Suspicious patterns in added library Rust lines, one flag per pattern (sorted by id).
 *
 * @param {FlagList} flags
 * @param {Map<string, ChangedFileInfo>} files
 * @param {string[]} sourceChanges
 * @returns {void}
 */
function addAddedCodeFlags(flags, files, sourceChanges) {
  /** @type {Map<string, Set<string>>} */
  const hits = new Map();

  for (const path of sourceChanges.filter((candidate) => candidate.endsWith('.rs'))) {
    for (const line of files.get(path)?.added_lines ?? []) {
      for (const { id, pattern } of ADDED_LINE_PATTERNS) {
        if (pattern.test(line)) {
          hits.set(id, (hits.get(id) ?? new Set()).add(path));
        }
      }
    }
  }

  for (const { id, detail } of [...ADDED_LINE_PATTERNS].sort((a, b) => compareCodePoints(a.id, b.id))) {
    const paths = hits.get(id);

    if (paths) {
      flags.add(id, detail, paths);
    }
  }
}

/**
 * The surface a change reaches: public Rust API, bindings and the visitor, new properties.
 *
 * @param {FlagList} flags
 * @param {Map<string, ChangedFileInfo>} files
 * @param {Set<string>} paths
 * @param {string[]} sourceChanges
 * @returns {void}
 */
function addSurfaceFlags(flags, files, paths, sourceChanges) {
  const publicApi = sourceChanges.filter((path) =>
    (files.get(path)?.added_lines ?? []).some((line) => PUB_ITEM.test(line)),
  );

  if (publicApi.length > 0) {
    flags.add(
      'public-api',
      'new or changed `pub` items (Rust API / AST / TS types surface)',
      new Set(publicApi),
    );
  }

  const bindings = [...paths].filter((path) => BINDING_PREFIXES.some((prefix) => path.startsWith(prefix)));

  if (bindings.length > 0 || paths.has('src/visitor.rs')) {
    flags.add('bindings', 'touches bindings or the visitor API; run the JS lane', bindings);
  }

  /** @type {Set<string>} */
  const properties = new Set();

  for (const line of files.get('src/properties/mod.rs')?.added_lines ?? []) {
    const match = PROPERTY_ENTRY.exec(line);

    if (match) {
      properties.add(match[1]);
    }
  }

  if (properties.size > 0) {
    flags.add(
      'new-property',
      `new properties registered: ${[...properties].sort(compareCodePoints).join(', ')}`,
      ['src/properties/mod.rs'],
    );
  }
}
