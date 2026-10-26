/**
 * Shared data shapes of the browser oracle (JSDoc only, no runtime code).
 *
 * Stage: oracle. The host driver writes `cases.jsonl`; prepare-jobs.mjs turns cases into jobs
 * (`jobs.jsonl`, `jobs.meta.jsonl`, `legacy-jobs.jsonl`); engine-runner.cjs writes one raw result
 * per job and engine (`results-<profile>.jsonl`); compare.mjs turns those into `verdicts.jsonl`.
 * These shapes are the contract between the scripts and with the host (lib/types.js mirrors the
 * verdict shapes). Key order matters: every file is written with JSON.stringify, so objects are
 * built in the order the shapes below list their keys.
 *
 * The engine runner imports these types in JSDoc only (`import('../lib/types.mjs')`); types are
 * erased, so the Node 14 runner never loads this file.
 */

// ---------------------------------------------------------------------------------------------
// Input cases (oracle/cases.jsonl)

/**
 * A sheet case: the input CSS and the base/head outputs, compared by computed style.
 *
 * @typedef {object} SheetCase
 * @property {string} id
 * @property {'sheet'} kind
 * @property {Record<string, string | null>} sheets `input`, `base`, `head`; null when a side has no output.
 * @property {Record<string, number> | null} [targets] LightningCSS browser targets (lowering cases).
 * @property {string | null} [dom] Hand-written HTML that replaces the synthesized DOM.
 * @property {string | null} [domFrom] The changed blocks of a large sheet: synthesize from these only.
 * @property {boolean} [visual] Take screenshots.
 * @property {boolean} [introduced] Base cannot run the request (a flag the PR adds).
 */

/**
 * A WPT property-parsing case: one declaration, checked through the CSSOM.
 *
 * @typedef {object} PropertyCase
 * @property {string} id
 * @property {'property'} kind
 * @property {string} property
 * @property {string} value
 * @property {string} wptKind `valid` or `invalid`.
 * @property {string | string[]} [expected] Serializations WPT accepts.
 * @property {Record<string, string | null>} outputs `base`, `head` declaration lists.
 * @property {Record<string, number> | null} [targets]
 * @property {boolean} [introduced]
 */

/** @typedef {SheetCase | PropertyCase} OracleCase */

// ---------------------------------------------------------------------------------------------
// Jobs (oracle/jobs.jsonl, oracle/legacy-jobs.jsonl)

/** @typedef {[property: string, value: string, important: boolean]} ProbeDecl */
/** @typedef {[atRule: string, prelude: string]} ProbePrelude */

/**
 * What an engine is asked to accept or reject, per sheet (exact source text).
 *
 * @typedef {object} ValidityProbe
 * @property {ProbeDecl[]} decls
 * @property {string[]} selectors Top-level style-rule selector lists.
 * @property {ProbePrelude[]} preludes `@media`, `@supports`, `@container` conditions.
 * @property {boolean} parsed False when css-tree could not parse the sheet at all.
 */

/**
 * A computed-style job: one DOM, several sheets, read in one engine.
 *
 * @typedef {object} SheetJob
 * @property {string} id Case id, plus `~dark` for the dark color-scheme twin.
 * @property {'sheet'} kind
 * @property {string} html Fragment placed in `#lcr-root`.
 * @property {Record<string, string>} rootAttrs Attributes set on `<html>` (`:root.dark`).
 * @property {string[]} pseudos Pseudo-elements read on every element (`::before`).
 * @property {Record<string, string>} sheets `empty` first, then the case's sheets after state rewriting.
 * @property {Record<string, ValidityProbe>} probe
 * @property {string} reference The variant other variants are diffed against (`input`).
 * @property {boolean} visual
 * @property {string[]} [sameAsInput] Variants whose text equals the input's up to whitespace and comments.
 * @property {'dark'} [colorScheme]
 * @property {string[]} [engines] Restrict the job to these engines.
 * @property {Record<string, string[]>} [propsByEngine] Legacy jobs: properties to read, per engine.
 * @property {Record<string, string[]>} [keysByEngine] Legacy jobs: element keys to read, per engine.
 * @property {string[]} [props] The engine's `propsByEngine` entry (set by the runner).
 * @property {string[] | null} [keys] The engine's `keysByEngine` entry (set by the runner).
 */

/**
 * A WPT parsing job.
 *
 * @typedef {object} PropertyJob
 * @property {string} id
 * @property {'property'} kind
 * @property {string} property
 * @property {string} value
 * @property {string} wptKind
 * @property {string | string[]} [expected]
 * @property {Record<string, string | null>} outputs
 * @property {string[]} [engines]
 */

/** @typedef {SheetJob | PropertyJob} Job */

/**
 * The DOM synthesized for a sheet job, with coverage counters.
 *
 * @typedef {object} SynthesizedDom
 * @property {string} html
 * @property {string[]} pseudos
 * @property {Record<string, string>} rootAttrs
 * @property {number} selectors Selectors seen (before de-duplication and the cap).
 * @property {number} synthesized Selectors that produced a DOM fragment.
 * @property {number} unsupported Simple selectors the synthesizer cannot satisfy.
 * @property {boolean} generic The fallback DOM was used.
 * @property {boolean} [override] The case supplied its own DOM.
 * @property {boolean} [focused] Synthesized from `domFrom` only.
 */

/**
 * oracle/jobs.meta.jsonl row: how a case's jobs were built, or why they could not be.
 *
 * @typedef {object} JobMeta
 * @property {string} id
 * @property {{ selectors: number, synthesized: number, unsupported: number, generic: boolean,
 *   override: boolean, focused: boolean }} [dom]
 * @property {number} [rewrites] User-action pseudo-classes rewritten to attributes.
 * @property {string[]} [injectedVars] Custom properties given a stand-in definition.
 * @property {boolean} [dark] A `~dark` twin job exists.
 * @property {string} [error]
 */

// ---------------------------------------------------------------------------------------------
// Raw engine results (oracle/results-<profile>.jsonl)

/** @typedef {Record<string, Record<string, string>>} StyleMap Element key -> property -> value. */

/** @typedef {[key: string, prop: string, ref: string | null, val: string | null]} RawDiff */

/**
 * Whether the engine accepted each probed declaration, selector and prelude (same order as the probe).
 *
 * @typedef {object} ProbeInfo
 * @property {boolean[]} [decls]
 * @property {boolean[]} [selectors]
 * @property {boolean[]} [preludes]
 */

/**
 * One sheet as read by the engine. The reference variant carries `touched` (what differs from
 * the empty sheet), the others `diff` (what differs from the reference); lowering jobs carry the
 * raw `values` of the reference engine's touched properties instead.
 *
 * @typedef {object} SnapshotVariant
 * @property {ProbeInfo} info
 * @property {StyleMap} [touched]
 * @property {RawDiff[]} [diff]
 * @property {StyleMap} [values]
 */

/**
 * @typedef {object} SnapshotResult
 * @property {string[]} elements Element labels (`html`, `body`, `div#0`, …).
 * @property {Record<string, SnapshotVariant>} variants
 */

/**
 * @typedef {object} PropertyOutcome One output of a parsing job (`status` plus evidence).
 * @property {string} status
 */

/**
 * @typedef {object} PropertyResult
 * @property {({ status: string } & Record<string, unknown>) | null} baseline Set when the engine
 *   itself does not handle the input as WPT expects.
 * @property {Record<string, PropertyOutcome & Record<string, unknown>>} variants
 */

/**
 * One row of results-<profile>.jsonl.
 *
 * @typedef {object} EngineResult
 * @property {SnapshotResult & PropertyResult} [result] The page function's return value.
 * @property {string} [error] The job failed in this engine (first lines of the message).
 * @property {Record<string, string>} [shots] Variant -> screenshot hash.
 * @property {string} [visualError] Screenshots failed; the computed-style result stands.
 * @property {string} id
 * @property {string} engine
 * @property {string} version
 * @property {number} ms
 */

// ---------------------------------------------------------------------------------------------
// Verdicts (oracle/verdicts.jsonl)

/**
 * The comparison of two computed values (or of one token pair inside them).
 *
 * @typedef {object} ValueComparison
 * @property {string} level `equal`, `noise`, `space-changed`, `custom-changed`, `near`, `different`.
 * @property {string} [reason]
 * @property {ValueComparison[]} [details] Per-token comparisons that were not equal (first four).
 * @property {number} [deltaE] OKLab distance.
 * @property {number} [alpha] Alpha distance.
 * @property {number} [delta] Numeric distance.
 * @property {boolean} [spaceChanged] Legacy/modern color syntax switch.
 */

/**
 * @typedef {object} ValueDiff One property that computes differently from the reference.
 * @property {string} key
 * @property {string} prop
 * @property {string | null | undefined} ref
 * @property {string | null} val
 * @property {string} level
 * @property {ValueComparison[] | undefined} details
 * @property {'engine-input'} [refFrom] Compared with the legacy engine's own input value.
 */

/**
 * @typedef {object} RejectedDecl A declaration the engine rejects in an output but not in the input.
 * @property {string} prop
 * @property {string} value
 * @property {boolean} important
 * @property {boolean} fallbackSurvives Another declaration of the property is accepted.
 * @property {boolean} inInput The input declares the property too.
 * @property {boolean} [carrierRejected] The input carried this value in a declaration the engine rejects.
 */

/**
 * @typedef {object} Rejections
 * @property {RejectedDecl[]} decls
 * @property {string[]} selectors
 * @property {ProbePrelude[]} preludes
 */

/**
 * A base or head side of one engine entry.
 *
 * @typedef {object} VariantVerdict
 * @property {string} status `equivalent`, `near`, `different`, `no-coverage`, `unknown`, `error`.
 * @property {string} [reason]
 * @property {ValueDiff[]} [diffs] Worst first, at most twelve.
 * @property {number} [diffCount]
 * @property {Record<string, number>} [levels] Level -> count.
 * @property {string} [sig] What differs from the input; equal on both sides means a neutral change.
 * @property {Rejections} [rejected]
 * @property {number} [hardRejected]
 * @property {PropertyOutcome & Record<string, unknown>} [detail] Parsing jobs: the page's outcome.
 */

/**
 * One engine's entry for one job in one profile.
 *
 * @typedef {object} EngineEntry
 * @property {string} version
 * @property {string} [error]
 * @property {string} [skipped] Legacy lanes: why the engine does not judge this case.
 * @property {({ status: string } & Record<string, unknown>) | null} [baseline]
 * @property {number} [touched] Input properties that differ from the empty sheet.
 * @property {{ base: VariantVerdict, head: VariantVerdict }} [variants]
 * @property {number} [shared] Lowering: differences base and head share exactly (dropped).
 * @property {{ baseOnly: number, headOnly: number }} [overlap]
 * @property {string} [inputSig] Which input parts the engine rejects (`decls/selectors/preludes`).
 * @property {boolean} [inputRejected]
 * @property {{ base: string | null, head: string | null }} [visual]
 * @property {string} [visualError]
 */

/** @typedef {Record<string, EngineEntry>} EngineBucket Engine -> entry, for one profile. */

/**
 * @typedef {object} EngineSplit Engines that are fine and wrong on one side.
 * @property {string[]} ok
 * @property {string[]} bad
 * @property {boolean} divergent
 */

/**
 * The per-profile summary of a case.
 *
 * @typedef {object} ProfileSummary
 * @property {string} base
 * @property {string} head
 * @property {string} transition
 * @property {number} rejectedBase
 * @property {number} rejectedHead
 * @property {boolean} visualBase
 * @property {boolean} visualHead
 * @property {string[]} visualErrors
 * @property {EngineSplit} enginesBase
 * @property {EngineSplit} enginesHead
 * @property {Record<string, { base: string, head: string, reason?: string }>} engines
 * @property {string[]} errored
 * @property {string[]} inert
 * @property {string[]} inertLive
 * @property {boolean} inputDependent
 * @property {boolean} divergent
 * @property {boolean} neutral
 */

/**
 * One row of oracle/verdicts.jsonl.
 *
 * @typedef {object} CaseVerdict
 * @property {string} id
 * @property {string} case
 * @property {'sheet' | 'property'} kind
 * @property {'light' | 'dark'} scheme
 * @property {EngineBucket} latest
 * @property {Record<string, EngineBucket>} legacy
 * @property {{ latest: ProfileSummary, legacy: Record<string, ProfileSummary> }} [summary]
 */
