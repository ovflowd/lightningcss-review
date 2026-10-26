/**
 * The page every job runs in, and the browser context settings.
 *
 * Stage: oracle (engine runner). One fixed document for every case and engine: a 800px wide root
 * for the case's DOM and an empty `<style>` element the job fills with each sheet in turn, so the
 * sheets are the only thing that differs between the variants of a job.
 */
'use strict';

/** The document loaded into every page (`#lcr-root` holds the DOM, `#lcr-style` the sheet). */
const SKELETON =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<style>html,body{margin:0;padding:0}#lcr-root{width:800px}</style>' +
  '<style id="lcr-style"></style></head><body><div id="lcr-root"></div></body></html>';

/**
 * Browser context options: a fixed viewport, 1x pixels and the light scheme, so screenshots and
 * layout-derived values are reproducible.
 */
const CONTEXT_OPTIONS = {
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
  /** @type {'light'} */
  colorScheme: 'light',
};

module.exports = { SKELETON, CONTEXT_OPTIONS };
