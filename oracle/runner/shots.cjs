/**
 * Screenshot file names, shared by the engine runner (writes them) and compare.mjs (reads them).
 *
 * Stage: oracle. Case ids contain `/` (`p-<area>/<slug>`), which must never become directories:
 * both separators are replaced by `__`.
 */
'use strict';

const path = require('path');

/**
 * The PNG file of one job, engine and sheet variant.
 *
 * @param {string} dir
 * @param {string} id Job id.
 * @param {string} engine
 * @param {string} variant
 * @returns {string}
 */
function shotFile(dir, id, engine, variant) {
  return path.join(dir, id.replace(/[\\/]/g, '__') + '.' + engine + '.' + variant + '.png');
}

module.exports = { shotFile };
