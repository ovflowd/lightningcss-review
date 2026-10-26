/**
 * Shared data shapes of the host side: config files, every stage file of a run directory, the
 * adapter protocol and the cache-level files.
 *
 * Stage: all. This module has no runtime code; import its types with
 * `/** @import { CorpusCase, OracleSummary } from '../types.js' *\/`.
 *
 * Each section is headed with the files it describes and the stage that writes them. A shape here
 * is a file format: existing run directories, baselines and analyses must keep loading, so a
 * change keeps the same keys, the same optional keys and the same nullability (or bumps the
 * format and says so in CHANGELOG.md). Shapes internal to one module stay in that module.
 *
 * Number fields typed `PyNumber` are Python floats (they may hold a `PyFloat`, see
 * core/pyjson.js); `number` fields are Python ints.
 */

/** @import { PyNumber } from './core/pyjson.js' */

// =============================================================================================
// Shared vocabulary

/** @typedef {'base' | 'head'} Side One of the two builds every case runs through. */
/** @typedef {'chromium' | 'firefox' | 'webkit'} Engine A browser engine of an engine profile. */
/** @typedef {'BLOCKER' | 'MAJOR' | 'MINOR' | 'NOTE'} Severity */
/** @typedef {'UNSAFE' | 'NEEDS_CHANGES' | 'SAFE_WITH_NITS' | 'SAFE' | 'INCONCLUSIVE'} Verdict */
/** @typedef {'tuple' | 'probe' | 'mutation' | 'wpt' | 'realworld'} CaseSource */

/**
 * Lightning CSS browser targets: browser key -> version encoded as `major << 16 | minor << 8 | patch`.
 * Keys: android, chrome, edge, firefox, ie, ios_saf, opera, safari, samsung.
 *
 * @typedef {Record<string, number>} Targets
 */

// =============================================================================================
// config/ (read-only data, edited by hand)

/**
 * @typedef {object} EngineProfileConfig config/engines.json `profiles.<name>`. The profile's
 *   Playwright release is not here: compose.yaml pins it (lib/setup/pins.js reads it).
 * @property {'reference' | 'legacy'} role
 * @property {boolean} [analysis] The analysis image (css-tree, colorjs.io, `@webref/css`).
 * @property {boolean} [optional]
 * @property {Record<Engine, string>} expected
 * @property {string} [lacks] What the legacy engines are missing.
 */

/**
 * @typedef {object} EnginesConfig config/engines.json
 * @property {string[]} default_profiles
 * @property {Record<string, EngineProfileConfig>} profiles
 * @property {Record<Engine, string>} engine_to_target
 */

/**
 * @typedef {object} ModeConfig config/modes.json `modes.<name>`.
 * @property {boolean} minify
 * @property {boolean} compact
 * @property {string} targets A preset name from `targets`.
 */

/**
 * @typedef {object} ModesConfig config/modes.json
 * @property {Record<string, string | null>} targets Preset name -> target string.
 * @property {Record<string, ModeConfig>} modes
 * @property {Record<string, string[]>} matrix Lane -> mode names.
 */

/**
 * @typedef {object} AreaConfig config/areas.json `areas.<name>`.
 * @property {string[]} [tests] Test function names of src/lib.rs that belong to the area.
 * @property {string[]} [wpt] WPT property directories.
 * @property {boolean} [visual] Compare screenshots for cases of this area.
 */

/**
 * @typedef {object} AreasConfig config/areas.json
 * @property {Record<string, AreaConfig>} areas
 * @property {[string, string[]][]} files `[glob, areas]` rules, first match wins.
 * @property {string[]} core_files
 * @property {Record<string, string>} generated_files Path -> command that regenerates it.
 */

/**
 * @typedef {object} CheckConfig config/checks.json `checks[]`.
 * @property {string} id e.g. `O1`.
 * @property {string} group
 * @property {string} title The pass condition.
 * @property {string} [fail_title] The failure, as a finding title.
 * @property {Severity | string} fail Severity of a FAIL.
 * @property {Severity} [partial] Severity of a PARTIAL (default NOTE).
 */

/**
 * @typedef {object} ChecksConfig config/checks.json
 * @property {CheckConfig[]} checks Catalog order is report order.
 * @property {ChecksThresholds} thresholds
 */

/**
 * @typedef {object} ChecksThresholds
 * @property {PyNumber} size_growth_ratio
 * @property {number} max_listed_cases
 * @property {number} snippet_chars
 * @property {PyNumber} perf_total_ratio
 * @property {PyNumber} perf_slower_share
 * @property {PyNumber} binary_growth_ratio
 */

/**
 * @typedef {object} PropertyEntry config/properties.json `[]`.
 * @property {string} name
 * @property {string} [area]
 * @property {string} [file] Handler file under src/.
 * @property {string[]} [prefixes]
 */

// =============================================================================================
// Adapter protocol (lib/adapter/client.js and adapter/lcr_adapter.rs)

/**
 * One request to the JSONL adapter (`adapter/lcr_adapter.rs`). Keys starting with `_` are host-side
 * only and stripped before sending (`_timeout`: seconds).
 *
 * @typedef {object} AdapterRequest
 * @property {string} [id]
 * @property {'sheet' | 'attr' | 'property' | 'value'} kind
 * @property {string} [css]
 * @property {string} [property]
 * @property {string} [value]
 * @property {boolean} [minify]
 * @property {boolean} [compact]
 * @property {Targets | null} [targets]
 * @property {number} [include] Features bits forced on.
 * @property {number} [exclude] Features bits forced off.
 * @property {{ browsers: Targets | null, include: number, exclude: number } | null} [printer_targets]
 * @property {string[]} [flags] Parser flag names (`custom-media`, `nesting`, …).
 * @property {boolean} [error_recovery]
 * @property {CssModulesConfig} [css_modules]
 * @property {string} [filename]
 * @property {string[]} [unused_symbols]
 * @property {PyNumber} [_timeout]
 */

/**
 * @typedef {object} CssModulesConfig
 * @property {string} [pattern]
 * @property {boolean} [dashed_idents]
 * @property {boolean} [animation]
 * @property {boolean} [grid]
 * @property {boolean} [custom_idents]
 * @property {boolean} [container]
 * @property {boolean} [pure]
 */

/**
 * An adapter answer, as stored in outputs-{base,head}.jsonl (with `id`).
 *
 * @typedef {object} AdapterResponse
 * @property {string} id
 * @property {boolean} ok
 * @property {string} [code] Printed CSS when ok.
 * @property {Record<string, string> | null} [exports] CSS modules exports.
 * @property {'typed' | 'unparsed' | 'custom' | string} [recognition] For `property`/`value` requests.
 * @property {string[]} [warnings]
 * @property {'parse' | 'minify' | 'print' | 'request' | 'panic' | 'crash' | 'timeout' | 'protocol' | string} [stage]
 *   Where it failed.
 * @property {string} [error]
 */

/**
 * The behavior-defining part of a response (`normalize_response`): what deltas compare.
 *
 * @typedef {{ ok: true, code: string | null, exports?: Record<string, string>, recognition?: string }
 *   | { ok: false, stage: string | null, kind: string }} NormalizedResponse
 */

// =============================================================================================
// prepare.json, diff.patch, issues/<n>.json (written by `lcr prepare`, lib/prepare/)

/**
 * @typedef {object} ChangedFile prepare.json `files.<path>`.
 * @property {string} status git name-status letter(s): `M`, `A`, `D`, `R100`, …
 * @property {[number, number][]} head Changed line ranges on head (hunk ranges).
 * @property {[number, number][]} base Changed line ranges on base.
 * @property {number} added
 * @property {number} removed
 */

/**
 * @typedef {object} ChangedItem prepare.json `changed_items[]`.
 * @property {string} file
 * @property {Side} side
 * @property {[number, number]} range
 * @property {{ kind: string, name: string, line: number } | null} item Nearest enclosing fn/struct/….
 * @property {{ trait: string | null, type: string, line: number } | null} impl
 */

/**
 * @typedef {object} RiskFlag
 * @property {string} id e.g. `core-file`, `no-tests`, `public-api`.
 * @property {string} detail
 * @property {string[]} paths
 */

/**
 * @typedef {object} PrMeta prepare.json `pr`.
 * @property {number} number
 * @property {string} title
 * @property {string | null} author
 * @property {string} url
 * @property {string} state
 * @property {boolean | null} draft
 * @property {string} created YYYY-MM-DD
 * @property {string} updated YYYY-MM-DD
 * @property {string[]} labels
 * @property {string} body
 * @property {number} commits
 * @property {string | null} head_ref
 * @property {string | null} mergeable
 */

/**
 * @typedef {object} LinkedIssue
 * @property {number} number
 * @property {string} title
 * @property {string} state
 * @property {boolean} closing The PR says it closes the issue.
 */

/**
 * @typedef {object} OverlappingPr
 * @property {number} number
 * @property {string} title
 * @property {string | null} author
 * @property {string[]} shared_files
 * @property {number[]} linked_issues
 */

/**
 * @typedef {object} CiCheck `gh pr checks` row.
 * @property {string} name
 * @property {string} state
 * @property {'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string} bucket
 * @property {string} link
 */

/**
 * prepare.json: the resolved base/head pair and the change classification.
 *
 * @typedef {object} Prepare
 * @property {number} schema
 * @property {string} skill_version
 * @property {string} repo Path of the Lightning CSS clone.
 * @property {'pr' | 'range'} kind
 * @property {PrMeta} [pr] PR runs only.
 * @property {string} [range] Range runs only: `<base>..<head>`.
 * @property {string} pr_head
 * @property {string} run_id `pr<N>-h<head8>-b<base8>` or `range-h<head8>-b<base8>`.
 * @property {string} run_dir
 * @property {string} base Base commit.
 * @property {string} master
 * @property {string} head_tree Head tree id.
 * @property {'merged-into-master' | 'pr-head-vs-merge-base' | 'local-range'} strategy
 * @property {string[]} conflicts
 * @property {Record<string, ChangedFile>} files
 * @property {Record<string, string[]>} file_areas
 * @property {ChangedItem[]} changed_items
 * @property {Partial<Record<Side, string[]>>} changed_tests Test fns of src/lib.rs with changed lines.
 * @property {string[]} test_areas
 * @property {string[]} areas
 * @property {{ name: string, files: string[], areas: string[] }[]} blast_radius
 * @property {string[]} radius_areas
 * @property {string[]} compat_variants
 * @property {RiskFlag[]} risk_flags
 * @property {string | null} toolchain Head's rust-toolchain.toml text.
 * @property {LinkedIssue[]} [linked_issues] PR runs fetched online.
 * @property {OverlappingPr[]} [overlapping_prs]
 * @property {CiCheck[]} [ci_checks]
 */

// =============================================================================================
// build.json, build/<side>/tests.json, build/<side>/tuples.jsonl, perf.json (`lcr build` and
// `lcr perf`, lib/build/)

/**
 * @typedef {object} BuildLane build.json `<side>.lanes.<name>`.
 * @property {number} exit
 * @property {number | null} seconds
 * @property {string[]} errors
 * @property {string} tail
 */

/**
 * @typedef {object} BuildSide build.json `base` / `head`.
 * @property {Side} side
 * @property {string} toolchain Rust channel.
 * @property {string} image Builder image tag, or `host`.
 * @property {boolean} fmt_ok
 * @property {string[]} fmt_files
 * @property {{ helpers: { name: string, fields: string[], skipped: string[] }[] } | { error: string }} injection
 * @property {{ rustflags: string, locked: boolean, exit: number | null }[]} attempts
 * @property {number | null} test_exit
 * @property {number | null} test_seconds
 * @property {boolean} adapter_ok
 * @property {string[]} adapter_errors
 * @property {number} tuples
 * @property {Record<string, BuildLane>} lanes
 * @property {number} seconds
 * @property {{ passed: number, failed: number, ignored: number }} summary
 * @property {string[] | null} compile_errors
 * @property {boolean} warnings_as_errors
 * @property {boolean} lockfile_outdated
 */

/**
 * @typedef {object} JsLane build.json `js`.
 * @property {boolean} ran
 * @property {string} [skipped]
 * @property {string[]} [steps]
 * @property {string | null} [failed_step]
 * @property {Record<string, string>} [drift] Generated file -> drift signature.
 * @property {string} [log]
 * @property {boolean} [js_tests]
 * @property {boolean} [regen_compat]
 * @property {boolean} [regen_ast]
 * @property {string | null} [base_failed_step]
 * @property {string} [base_log]
 * @property {Record<string, string>} [base_drift]
 * @property {string[]} [drift_new]
 */

/**
 * @typedef {object} Build build.json
 * @property {BuildSide} base
 * @property {BuildSide} head
 * @property {JsLane} js
 */

/**
 * @typedef {object} TestsFile build/<side>/tests.json
 * @property {Record<string, 'ok' | 'failed' | 'ignored'>} tests `<suite>::<test>` -> status.
 * @property {Record<string, string>} failures Test -> first lines of its output.
 */

/**
 * One recorded test-helper call (build/<side>/tuples.jsonl row, written by the injected recorder).
 *
 * @typedef {object} TupleRecord
 * @property {string} test
 * @property {string} helper
 * @property {string} file
 * @property {number} line
 * @property {Record<string, unknown>} fields The helper's arguments (strings, bools, ints, Debug text).
 */

/**
 * @typedef {object} PerfFile perf.json (optional stage).
 * @property {string} [skip_reason] Set when the release binaries look stale; nothing was timed.
 * @property {number} repeats
 * @property {{ base: number, head: number }} binary_bytes
 * @property {PyNumber} binary_ratio
 * @property {{ base: PyNumber, head: PyNumber }} total_ms
 * @property {PyNumber | null} total_ratio
 * @property {PyNumber} slower_share
 * @property {string[]} failed_files
 * @property {{ name: string, base_ms: PyNumber, head_ms: PyNumber, ratio: PyNumber | null }[]} files
 */

// =============================================================================================
// corpus/cases.jsonl, outputs-*.jsonl, deltas.jsonl, corpus.json (`lcr corpus`, lib/corpus/)

/**
 * Fields every corpus case has.
 *
 * @typedef {object} CaseBase
 * @property {string} id `t-…`, `p-<probe id>`, `m-<parent>-<mutation>`, `w-…`, `r-<name>-<mode>`.
 * @property {AdapterRequest} request Without `id`.
 * @property {PyNumber} [timeout] Seconds (probes and their mutations).
 */

/**
 * @typedef {object} TupleCaseFields
 * @property {'tuple'} source
 * @property {'base' | 'head' | 'both'} side Which side's tests recorded it.
 * @property {string} helper
 * @property {string} test
 * @property {number} line
 * @property {Side} line_side
 * @property {boolean} in_diff
 * @property {TupleExpectation} expectation
 * @property {string} suffix `''` or the property_range_test sub-id.
 */

/**
 * @typedef {{ type: 'code', code: string | null }
 *   | { type: 'value', code: string }
 *   | { type: 'value-unparsed' }
 *   | { type: 'error', stage: 'parse' | 'minify', error: string | null }
 *   | { type: 'warnings' }} TupleExpectation
 */

/**
 * @typedef {object} ProbeMeta The `probe` object of a probe case.
 * @property {string} id `<area>/<slug>`.
 * @property {string} area
 * @property {string} title
 * @property {'print' | 'minify' | 'lower' | 'lower-minify'} mode
 * @property {string} targets The header's targets text.
 * @property {string[]} expect
 * @property {string} known
 * @property {string[]} refs
 * @property {string} path
 * @property {string | null} dom
 * @property {string | null} note
 * @property {number | null} repro
 */

/**
 * @typedef {object} ProbeCaseFields
 * @property {'probe'} source
 * @property {'curated' | 'pr' | 'cli'} origin
 * @property {ProbeMeta} probe
 * @property {string} area
 */

/**
 * @typedef {object} MutationCaseFields
 * @property {'mutation'} source
 * @property {string} mutation
 * @property {string} parent The parent case id.
 * @property {string | null} area
 * @property {string} [dom]
 */

/**
 * @typedef {object} WptCaseFields
 * @property {'wpt'} source
 * @property {{ id: string, file: string, kind: string, property: string, value: string, expected: unknown }} wpt
 * @property {string} mode
 */

/**
 * @typedef {object} RealworldCaseFields
 * @property {'realworld'} source
 * @property {string} name
 * @property {string} mode
 */

/**
 * One row of corpus/cases.jsonl.
 *
 * @typedef {CaseBase & (TupleCaseFields | ProbeCaseFields | MutationCaseFields | WptCaseFields | RealworldCaseFields)} CorpusCase
 */

/**
 * @typedef {object} Delta corpus/deltas.jsonl row: base and head behave differently.
 * @property {string} id
 * @property {CaseSource} source
 * @property {NormalizedResponse} base
 * @property {NormalizedResponse} head
 */

/**
 * @typedef {object} TupleEntry A tuple case in a corpus.json `tuples` bucket.
 * @property {string} id
 * @property {string} helper
 * @property {string} test
 * @property {number} line
 * @property {boolean} in_diff
 * @property {string | null} [got] head_mismatch: head's code or error.
 * @property {string} [head_id] modified: the head tuple replacing this base tuple.
 * @property {number} [head_line] modified.
 */

/**
 * @typedef {object} UnmappableTuple corpus.json `tuple_stats.unmappable_cases[]`.
 * @property {string} helper
 * @property {string} test
 * @property {number} line
 * @property {'base' | 'head' | 'both'} side
 * @property {boolean} in_diff
 * @property {string} reason
 * @property {string} [id] When the head adapter rejected the request.
 * @property {number} count
 */

/**
 * @typedef {object} ProbeResult corpus.json `probes[]`.
 * @property {string} id Case id (`p-…`).
 * @property {string} probe Probe id.
 * @property {string} origin
 * @property {string} known
 * @property {number | null} repro
 * @property {boolean} changed
 * @property {Record<Side, Record<string, boolean | null>>} assert Assertion -> pass/fail/undecided.
 * @property {Partial<Record<Side, string>>} [crash]
 */

/**
 * @typedef {object} IdempotencyEntry
 * @property {boolean} stable
 * @property {string | null | undefined} second The second pass's code, or its error.
 */

/**
 * @typedef {object} RobustnessEntry
 * @property {string} id
 * @property {CaseSource} source
 * @property {string} stage `panic`, `crash` or `timeout`.
 * @property {string} error
 */

/**
 * corpus.json: the summary of the differential runs.
 *
 * @typedef {object} CorpusSummary
 * @property {Partial<Record<CaseSource, number>>} cases
 * @property {Partial<Record<CaseSource, number>>} deltas
 * @property {{ base_tuples: number, head_tuples: number, unmappable: number, unmappable_helpers: string[], unmappable_cases: UnmappableTuple[] }} tuple_stats
 * @property {Record<'head_mismatch' | 'new_failing_on_base' | 'new_passing_on_base' | 'modified' | 'removed_changed' | 'removed_same' | 'base_mismatch', TupleEntry[]>} tuples
 * @property {Record<Side, RobustnessEntry[]>} robustness
 * @property {string[]} idempotency_failures
 * @property {string[]} idempotency_preexisting
 * @property {Record<string, IdempotencyEntry>} idempotency Head's second pass.
 * @property {Record<string, IdempotencyEntry>} idempotency_base
 * @property {Record<string, string[]>} flag_only Parser flag -> case ids only head can run.
 * @property {ProbeResult[]} probes
 * @property {string[]} probe_problems
 * @property {string} probe_files Fingerprint of <run>/probes.
 * @property {{ name: string, mode: string, base: number, head: number }[]} size Real-world output bytes.
 */

// =============================================================================================
// oracle/ files, oracle.json, spec-cards.json, baseline.json (`lcr oracle`, lib/oracle-driver/).
// The oracle scripts type the rows they write in oracle/lib/types.mjs; the shapes here are those
// rows as the host reads them, from this version or an older run, so fields that older runs lack
// are optional here and engine names are the `Engine` union. Change both files together.

/**
 * An oracle input case (oracle/cases.jsonl, written by the driver for prepare-jobs.mjs).
 *
 * @typedef {{ id: string, kind: 'sheet', sheets: { input: string | null, base: string | null, head: string | null },
 *   targets: Targets | null, dom: string | null | undefined, domFrom?: string | null, visual: boolean,
 *   introduced?: boolean, flagOnly?: string }
 *   | { id: string, kind: 'property', property: string, value: string, wptKind: string, expected: unknown,
 *   outputs: { base: string | null, head: string | null }, targets: Targets | null }} OracleCase
 */

/**
 * @typedef {object} JobMeta oracle/jobs.meta.jsonl row (oracle.json `dom.<id>`).
 * @property {string} id
 * @property {{ selectors: number, synthesized: number, unsupported: number, generic: boolean, override: boolean, focused: boolean }} [dom]
 * @property {number} [rewrites]
 * @property {string[]} [injectedVars]
 * @property {boolean} [dark]
 * @property {string} [error]
 */

/**
 * @typedef {'equivalent' | 'near' | 'different' | 'no-coverage' | 'unknown' | 'error' | string} EngineStatus
 */

/**
 * One property difference in an engine variant.
 *
 * @typedef {object} ValueDiff
 * @property {string} key Element (and pseudo-element) label, e.g. `div#3::before`.
 * @property {string} prop
 * @property {string} ref The reference (input) value.
 * @property {string} val This variant's value.
 * @property {string} level `noise`, `near`, `different`, `space-changed`, `custom-changed`.
 * @property {Record<string, unknown>[]} [details] Per-token comparisons (`deltaE`, `delta`, …).
 */

/**
 * @typedef {object} EngineVariant A base/head variant of one engine entry.
 * @property {EngineStatus} status
 * @property {ValueDiff[]} [diffs]
 * @property {number} [diffCount]
 * @property {number} [hardRejected]
 * @property {Record<string, number>} [levels]
 * @property {{ decls?: { prop: string, value: string, important?: boolean, inInput?: boolean, carrierRejected?: boolean, fallbackSurvives?: boolean }[], selectors?: string[], preludes?: string[] } & Record<string, unknown>} [rejected]
 * @property {string} [sig]
 * @property {string} [reason]
 * @property {{ status: string } & Record<string, unknown>} [detail]
 */

/**
 * One engine's result for a case in one profile.
 *
 * @typedef {object} EngineEntry
 * @property {string} [version]
 * @property {string} [error]
 * @property {string} [skipped]
 * @property {number} [touched] Properties the input changed versus the empty sheet.
 * @property {number} [shared]
 * @property {{ base: EngineVariant, head: EngineVariant }} [variants]
 * @property {{ base: string | null, head: string | null }} [visual]
 * @property {string} [visualError]
 * @property {boolean} [inputRejected]
 * @property {string} [inputSig]
 * @property {{ baseOnly: number, headOnly: number }} [overlap]
 * @property {unknown} [baseline]
 */

/**
 * @typedef {object} EngineSplit
 * @property {Engine[]} ok
 * @property {Engine[]} bad
 * @property {boolean} divergent
 */

/**
 * The per-profile summary of a case (verdict `summary.latest`, `summary.legacy.<profile>`).
 *
 * @typedef {object} ProfileSummary
 * @property {EngineStatus} base
 * @property {EngineStatus} head
 * @property {string} transition `both-equivalent`, `fixed`, `regressed`, `worsened`, `still-different`,
 *   `introduced`, `near-introduced`, `unverified`, `errored`, `input-rejected`, …
 * @property {number} rejectedBase
 * @property {number} rejectedHead
 * @property {boolean} visualBase
 * @property {boolean} visualHead
 * @property {string[]} [visualErrors]
 * @property {EngineSplit} enginesBase
 * @property {EngineSplit} enginesHead
 * @property {Partial<Record<Engine, { base: EngineStatus, head: EngineStatus, reason?: string }>>} engines
 * @property {Engine[]} inert Engines where the input does nothing.
 * @property {Engine[]} [inertLive] Inert input, live output.
 * @property {Engine[]} errored
 * @property {boolean} divergent
 * @property {boolean} neutral Head has exactly base's differences.
 * @property {boolean} [inputDependent]
 */

/**
 * One row of oracle/verdicts.jsonl (and an item of oracle.json `verdicts.<case>[]`).
 *
 * @typedef {object} CaseVerdict
 * @property {string} id Job id (`<case>` or `<case>~dark`).
 * @property {string} case
 * @property {'sheet' | 'property'} kind
 * @property {'light' | 'dark'} scheme
 * @property {Partial<Record<Engine, EngineEntry>>} latest
 * @property {Record<string, Partial<Record<Engine, EngineEntry>>>} legacy Profile -> engines.
 * @property {{ latest: ProfileSummary, legacy: Record<string, ProfileSummary> }} summary
 */

/** @typedef {Record<string, string>} EngineVersions Engine (and `node`, `playwright`) -> version. */

/**
 * oracle.json
 *
 * @typedef {object} OracleSummary
 * @property {{ candidates: number, selected: number, dropped: number, by_reason: Record<string, number>, reruns?: string[] }} stats
 * @property {Record<string, CaseVerdict[]>} verdicts Case id -> verdicts (light, and dark when needed).
 * @property {Record<string, EngineVersions>} profiles Profiles that ran.
 * @property {Record<string, JobMeta>} [dom]
 * @property {{ cases: string | null, 'outputs-base': string | null, 'outputs-head': string | null, probe_files: string | null | undefined }} [inputs]
 *   Fingerprints of what was judged (stale detection).
 */

/**
 * @typedef {object} SpecCard spec-cards.json `cards.<property>`.
 * @property {boolean} [missing]
 * @property {string} [href]
 * @property {string} [syntax]
 * @property {string} [initial]
 * @property {string} [inherited]
 * @property {string} [computedValue]
 * @property {string} [animationType]
 * @property {string} [percentages]
 * @property {string} [appliesTo]
 * @property {string} [canonicalOrder]
 * @property {string[] | null} [longhands]
 * @property {string | null} [legacyAliasOf]
 * @property {Record<string, string>} [types]
 */

/**
 * @typedef {object} SpecCards spec-cards.json
 * @property {string[]} order Priority order (deltas first, then handler files).
 * @property {Record<string, SpecCard>} cards
 */

/**
 * @typedef {object} BaselineProbe <cache>/baseline.json `probes.<probe id>`.
 * @property {string} probe
 * @property {string} area
 * @property {string} known
 * @property {string} path
 * @property {string[]} expect
 * @property {Record<string, boolean | null>} asserts
 * @property {string | null} stage Head's failing stage, when it failed.
 * @property {Record<string, EngineStatus>} latest Scheme -> head status.
 * @property {Record<string, EngineStatus>} legacy `<profile>[~dark]` -> head status.
 * @property {string[]} fails_on_master
 */

/**
 * @typedef {object} Baseline <cache>/baseline.json
 * @property {string} master
 * @property {Record<string, EngineVersions>} profiles
 * @property {Record<string, BaselineProbe>} probes
 */

// =============================================================================================
// analysis.json (written by the reviewer, slots by `lcr worklist`), report.json (`lcr report`,
// lib/report/)

/**
 * @typedef {object} ChecklistAnswer analysis.json `checklist[]`.
 * @property {string} [item] e.g. `COL-3`.
 * @property {string} [area] Area-level N/A: answers every unanswered item of that list.
 * @property {'PASS' | 'FAIL' | 'FAIL_PRE_EXISTING' | 'N/A' | ''} answer
 * @property {string} evidence
 * @property {string} [note]
 * @property {string} [finding] Links an analysis finding id.
 * @property {Severity} [effective_severity] May only lower the item's severity.
 * @property {string} [severity_reason]
 * @property {string} [_text] Worklist hints (ignored by the report).
 * @property {Severity} [_severity]
 * @property {string} [_verify]
 * @property {boolean} [_prefilled]
 */

/**
 * @typedef {object} DeltaClassification analysis.json `deltas[]`.
 * @property {string} id Case id, glob, or `source:<source>`.
 * @property {'INTENDED' | 'ACCEPTABLE_SIDE_EFFECT' | 'REGRESSION' | 'NEEDS_MAINTAINER_DECISION' | 'ORACLE_NOISE' | 'PRE_EXISTING' | ''} classification
 * @property {string} reason
 * @property {string} [evidence]
 * @property {string} [finding]
 * @property {string} [_check] Worklist hints.
 * @property {number} [_count]
 * @property {boolean} [_stale]
 */

/**
 * @typedef {object} AnalysisFinding analysis.json `findings[]`.
 * @property {string} [id] Default `F<n>`.
 * @property {Severity} severity
 * @property {string} title
 * @property {string[]} evidence
 * @property {string} [detail]
 * @property {string} [suggested_test]
 */

/**
 * analysis.json: the reviewer's judgment, the only non-mechanical input of the report.
 *
 * @typedef {object} Analysis
 * @property {number} schema
 * @property {string} run_id
 * @property {{ kind: string, summary: string, claims: string[], behind_flag: string }} intent
 * @property {ChecklistAnswer[]} checklist
 * @property {DeltaClassification[]} deltas
 * @property {AnalysisFinding[]} findings
 * @property {string[]} probes_written
 */

/**
 * @typedef {'PASS' | 'FAIL' | 'PARTIAL' | 'SKIP' | 'INCONCLUSIVE'} CheckStatus
 */

/**
 * @typedef {object} CheckRow report.json `checks[]`, in catalog order.
 * @property {string} id
 * @property {string} group
 * @property {string} title
 * @property {CheckStatus} status
 * @property {Severity | null} severity
 * @property {string} evidence
 * @property {string[]} items Capped list (`… N more`).
 */

/**
 * @typedef {object} Finding report.json `findings[]`. Fields copied from an analysis finding keep
 *   the reviewer's values as written (`evidence` items and `detail` are usually strings).
 * @property {string} [id] Analysis findings only (`F<n>` when the reviewer gave none).
 * @property {number} n
 * @property {Severity} severity
 * @property {string} title
 * @property {'analysis' | 'checklist' | 'classification' | 'check'} source
 * @property {string | null} check The check or checklist item; null for analysis findings and
 *   classifications.
 * @property {unknown[]} evidence
 * @property {unknown} [detail]
 * @property {unknown} [suggested_test] Analysis findings only.
 * @property {{ check: string | null, severity: Severity, source: string, title: string }[]} [folded]
 *   Entries folded into this finding (absent when none).
 * @property {string[]} [related] Standalone check findings: `<finding id>: <title>` of analysis
 *   findings citing some of its cases.
 */

/**
 * report.json
 *
 * @typedef {object} ReportFile
 * @property {number} schema
 * @property {string} run_id
 * @property {number | null} pr
 * @property {Verdict} verdict
 * @property {string | null} verdict_scope e.g. `flag custom-functions only`.
 * @property {number | null} default_requests
 * @property {string[]} decision_needed
 * @property {Record<Severity, number>} counts
 * @property {CheckRow[]} checks
 * @property {Finding[]} findings
 * @property {Record<'prepare' | 'build' | 'corpus' | 'oracle' | 'analysis', boolean>} stages
 * @property {string} base
 * @property {string} head_tree
 * @property {Record<string, EngineVersions>} engines
 * @property {string} skill_version
 */

// =============================================================================================
// <cache>/env.json (`lcr setup`, lib/setup/)

/**
 * @typedef {object} EnvProfile
 * @property {string} image `lcr-browsers:pw-<version>[-analysis]`.
 * @property {string | null} image_id
 * @property {'reference' | 'legacy'} role
 * @property {EngineVersions} versions As the container reports them.
 */

/**
 * <cache>/env.json: what `lcr setup` built and the exact engine versions.
 *
 * @typedef {object} EnvFile
 * @property {Record<string, EnvProfile>} profiles
 * @property {{ image: string, image_id: string | null, channel: string }} [builder]
 * @property {string} [skill_version]
 */

export {};
