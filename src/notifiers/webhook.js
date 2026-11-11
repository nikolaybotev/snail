'use strict';

const crypto = require('node:crypto');
const { notifyWithRetries, defaultSleeper } = require('./retry.js');

const WEBHOOK_PAYLOAD_KEYS = [
  'account',
  'from',
  'subject',
  'date',
  'message_id',
  'path',
  'mailbox',
  'uid',
  'uid_validity',
  'notify_id',
];

const WEBHOOK_ATTEMPT_TIMEOUT_MS = 10_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * @param {{
 *   account: string,
 *   from: string,
 *   subject: string,
 *   date: string,
 *   message_id: string,
 *   path: string,
 *   mailbox: string,
 *   uid: number,
 *   uid_validity: number,
 * }} fields
 */
function buildWebhookBody(fields) {
  /** @type {Record<string, string | number>} */
  const body = {};
  for (const key of WEBHOOK_PAYLOAD_KEYS) {
    body[key] = fields[key];
  }
  return body;
}

/**
 * @param {Response} res
 */
function isWebhookSuccess(res) {
  return res.status >= 200 && res.status <= 299;
}

/**
 * @param {{
 *   webhookUrl: string,
 *   secret: string,
 *   webhookAuth?: 'bearer' | 'raw',
 *   webhookHeader?: string,
 *   payload: ReturnType<typeof buildWebhookBody>,
 *   fetchImpl?: typeof fetch,
 *   sleeper?: (ms: number) => Promise<void>,
 *   attemptTimeoutMs?: number,
 *   log?: (msg: string) => void,
 *   requestId?: string,
 *   now?: () => number,
 *   attemptNumber?: number,
 * }} options
 * @returns {Promise<{ ok: boolean, statusToken: string }>}
 */
async function notifyWebhookOnce({
  webhookUrl,
  secret,
  webhookAuth = 'bearer',
  webhookHeader = 'Authorization',
  payload,
  fetchImpl = fetch,
  sleeper = defaultSleeper,
  attemptTimeoutMs = WEBHOOK_ATTEMPT_TIMEOUT_MS,
  log,
  requestId: injectedRequestId,
  now = Date.now,
  attemptNumber = 1,
}) {
  const headerName = webhookHeader;
  const headerValue = webhookAuth === 'raw' ? secret : `Bearer ${secret}`;
  const requestId = injectedRequestId ?? crypto.randomUUID();
  const encMailbox = encodeURIComponent(payload.mailbox);
  const uid = payload.uid;
  const n = attemptNumber;
  if (log) {
    log(`webhook start mailbox ${encMailbox} uid ${uid} request ${requestId} attempt ${n}`);
  }
  let timedOut = false;
  const timeoutPromise = sleeper(attemptTimeoutMs).then(() => {
    timedOut = true;
    return /** @type {Response | null} */ (null);
  });
  const startedAt = now();
  /** @type {Response | null} */
  let res = null;
  try {
    res = await Promise.race([
      fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          [headerName]: headerValue,
        },
        body: JSON.stringify(payload),
        redirect: 'manual',
      }),
      timeoutPromise,
    ]);
    if (timedOut || res === null) {
      return { ok: false, statusToken: 'timeout' };
    }
    const durationMs = now() - startedAt;
    if (log) {
      log(
        `webhook response mailbox ${encMailbox} uid ${uid} request ${requestId} attempt ${n} status ${res.status} duration ${durationMs}`,
      );
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      return { ok: false, statusToken: String(res.status) };
    }
    return isWebhookSuccess(res)
      ? { ok: true, statusToken: String(res.status) }
      : { ok: false, statusToken: String(res.status) };
  } catch {
    return { ok: false, statusToken: 'error' };
  }
}

/**
 * @param {{
 *   webhookUrl: string,
 *   secret: string,
 *   webhookAuth?: 'bearer' | 'raw',
 *   webhookHeader?: string,
 *   payload: ReturnType<typeof buildWebhookBody>,
 *   fetchImpl?: typeof fetch,
 *   sleeper?: (ms: number) => Promise<void>,
 *   attemptTimeoutMs?: number,
 *   log?: (msg: string) => void,
 *   requestId?: string,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ ok: boolean, attempts: number }>}
 */
async function notifyWebhook({
  webhookUrl,
  secret,
  webhookAuth = 'bearer',
  webhookHeader = 'Authorization',
  payload,
  fetchImpl = fetch,
  sleeper = defaultSleeper,
  attemptTimeoutMs = WEBHOOK_ATTEMPT_TIMEOUT_MS,
  log,
  requestId: injectedRequestId,
  now = Date.now,
}) {
  const headerName = webhookHeader;
  const headerValue =
    webhookAuth === 'raw' ? secret : `Bearer ${secret}`;
  let attemptNumber = 0;

  const attempt = async () => {
    attemptNumber += 1;
    const once = await notifyWebhookOnce({
      webhookUrl,
      secret,
      webhookAuth,
      webhookHeader: headerName,
      payload,
      fetchImpl,
      sleeper,
      attemptTimeoutMs,
      log,
      requestId: injectedRequestId,
      now,
      attemptNumber,
    });
    return once.ok;
  };

  return notifyWithRetries({ attempt, sleeper });
}

module.exports = {
  WEBHOOK_PAYLOAD_KEYS,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
  buildWebhookBody,
  notifyWebhook,
  notifyWebhookOnce,
  isWebhookSuccess,
};
