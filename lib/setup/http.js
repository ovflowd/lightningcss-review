/**
 * HTTP requests with a timeout, and failures as `LcrError`s that say why.
 *
 * Stage: `lcr realworld` (downloading the pinned stylesheets) and `lcr setup --update` (the npm
 * registry and mcr.microsoft.com). These are the host's only network calls besides git, gh and
 * Docker; a failure is an expected condition (offline, a moved file), never a stack trace.
 */
import { LcrError } from '../core/errors.js';

/**
 * @typedef {object} FetchOptions
 * @property {string} [method] Default GET.
 * @property {Record<string, string>} [headers]
 * @property {readonly number[]} [allow] Statuses besides 2xx that are answers, not failures
 *   (404 for "does this exist?").
 * @property {number} timeoutMs
 * @property {string} remedy What the user can do when the request fails.
 */

/**
 * `fetch(url)`, resolving to the response once it has an acceptable status.
 *
 * @param {string} url
 * @param {FetchOptions} options
 * @returns {Promise<Response>}
 */
export async function fetchChecked(url, { method = 'GET', headers = {}, allow = [], timeoutMs, remedy }) {
  let response;

  try {
    response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new LcrError(`could not fetch ${url}: ${networkReason(error)}`, { remedy, cause: error });
  }

  if (!response.ok && !allow.includes(response.status)) {
    throw new LcrError(`could not fetch ${url}: HTTP ${response.status} ${response.statusText}`, { remedy });
  }

  return response;
}

/**
 * Why a request failed. undici's own message is only "fetch failed"; the reason (DNS, a refused
 * connection, TLS) is its cause.
 *
 * @param {unknown} error
 * @returns {string}
 */
function networkReason(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.cause instanceof Error ? error.cause.message : error.message;
}
