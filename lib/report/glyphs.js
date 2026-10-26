/**
 * The non-ASCII characters report.md, report.json and the chat summary print.
 *
 * Stage: report. py-final wrote these characters literally; they are spelled here by code point so
 * the sources stay ASCII (editors and tools sometimes turn escapes into look-alike characters, and
 * a wrong dash or ellipsis would break byte parity with existing reports).
 */

/** Marks a cut snippet (`…`). */
export const ELLIPSIS = String.fromCodePoint(0x2026);

/** Stands for a missing value in a snippet (`∅`). */
export const EMPTY_SET = String.fromCodePoint(0x2205);

/** Separates a label from its explanation (`—`). */
export const EM_DASH = String.fromCodePoint(0x2014);

/** Base to head, or an old value to a new one (`→`). */
export const ARROW = String.fromCodePoint(0x2192);

/** Separates the facts of one header line (`·`). */
export const MIDDLE_DOT = String.fromCodePoint(0x00b7);

/** A stage that ran (`✓`). */
export const CHECK_MARK = String.fromCodePoint(0x2713);

/** A stage that did not run (`✗`). */
export const CROSS_MARK = String.fromCodePoint(0x2717);

/** The size-change column heading (`Δ`). */
export const DELTA = String.fromCodePoint(0x0394);

/** "base differs from head" in the delta table heading (`≠`). */
export const NOT_EQUAL = String.fromCodePoint(0x2260);

/** Section reference (`§`). */
export const SECTION = String.fromCodePoint(0x00a7);
