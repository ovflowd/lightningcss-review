/// <reference lib="dom" />
/**
 * In-page helpers for screenshots of a sheet job.
 *
 * Stage: oracle (engine runner). Passed to `page.evaluate` (serialized with `toString()`), so each
 * function is self-contained.
 */
'use strict';

/**
 * Show one variant: the case's DOM with one sheet.
 *
 * @param {{ html: string, css: string }} variant
 * @returns {void}
 */
function showVariant(variant) {
  /** @type {HTMLElement} */ (document.getElementById('lcr-root')).innerHTML = variant.html;
  /** @type {HTMLElement} */ (document.getElementById('lcr-style')).textContent = variant.css;
}

/**
 * Remove the screenshot sheet, so the next job starts from the skeleton's styles.
 *
 * @returns {void}
 */
function clearStyle() {
  /** @type {HTMLElement} */ (document.getElementById('lcr-style')).textContent = '';
}

module.exports = { showVariant, clearStyle };
