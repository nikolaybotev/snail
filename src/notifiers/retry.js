'use strict';

/** Delays after failed attempts (FR9). First attempt has no preceding delay. */
const NOTIFY_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * @param {{
 *   attempt: () => Promise<boolean>,
 *   sleeper?: (ms: number) => Promise<void>,
 *   delays?: number[],
 * }} options
 * @returns {Promise<{ ok: boolean, attempts: number }>}
 */
async function notifyWithRetries({ attempt, sleeper = defaultSleeper, delays = NOTIFY_RETRY_DELAYS_MS }) {
  let attempts = 0;
  if (await attempt()) {
    return { ok: true, attempts: 1 };
  }
  attempts = 1;
  for (const delayMs of delays) {
    await sleeper(delayMs);
    attempts += 1;
    if (await attempt()) {
      return { ok: true, attempts };
    }
  }
  return { ok: false, attempts };
}

/**
 * @param {number} ms
 */
function defaultSleeper(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  NOTIFY_RETRY_DELAYS_MS,
  notifyWithRetries,
  defaultSleeper,
};
