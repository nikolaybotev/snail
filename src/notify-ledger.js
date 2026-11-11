'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEDGER_BASENAME = '.snail-notify.json';
const LEDGER_RETRY_BASENAME = '.snail-notify-ledger-retry.json';
const REQUESTS_DIRNAME = '.snail-notify-requests';

const NOTIFY_DELAY_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * @param {number} attempts after a finished failed attempt
 * @returns {number}
 */
function notifyDelayMs(attempts) {
  if (attempts <= 0) return NOTIFY_DELAY_MS[0];
  if (attempts <= NOTIFY_DELAY_MS.length) {
    return NOTIFY_DELAY_MS[attempts - 1];
  }
  return 60000;
}

/**
 * @param {string} account
 * @param {number} uidValidity
 * @param {number} uid
 */
function buildNotifyId(account, uidValidity, uid) {
  return `${account}/${uidValidity}/${uid}`;
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 */
function ledgerPath(mailDir, fsImpl = fs) {
  return path.join(mailDir, LEDGER_BASENAME);
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 */
function requestsDir(mailDir, fsImpl = fs) {
  return path.join(mailDir, REQUESTS_DIRNAME);
}

/**
 * @typedef {{
 *   notify_id: string,
 *   account: string,
 *   uid: number,
 *   uid_validity: number,
 *   file: string,
 *   attempts: number,
 *   last_status: string,
 *   next_attempt_at: string,
 *   request_id: string,
 * }} NotifyLedgerItem
 */

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 * @returns {NotifyLedgerItem[]}
 */
function readNotifyLedger(mailDir, fsImpl = fs) {
  const p = ledgerPath(mailDir, fsImpl);
  if (!fsImpl.existsSync(p)) return [];
  let raw;
  try {
    raw = fsImpl.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error('ledger unreadable');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return [];
    /** @type {NotifyLedgerItem[]} */
    const items = [];
    for (const row of parsed.items) {
      if (
        typeof row.notify_id !== 'string' ||
        typeof row.account !== 'string' ||
        typeof row.uid !== 'number' ||
        typeof row.uid_validity !== 'number' ||
        typeof row.file !== 'string' ||
        typeof row.attempts !== 'number' ||
        typeof row.last_status !== 'string' ||
        typeof row.next_attempt_at !== 'string'
      ) {
        continue;
      }
      items.push({
        notify_id: row.notify_id,
        account: row.account,
        uid: row.uid,
        uid_validity: row.uid_validity,
        file: row.file,
        attempts: row.attempts,
        last_status: row.last_status,
        next_attempt_at: row.next_attempt_at,
        request_id: typeof row.request_id === 'string' ? row.request_id : '',
      });
    }
    return items;
  } catch {
    throw new Error('ledger unreadable');
  }
}

/**
 * @param {string} mailDir
 * @param {NotifyLedgerItem[]} items
 * @param {typeof fs} [fsImpl]
 */
function writeNotifyLedger(mailDir, items, fsImpl = fs) {
  const p = ledgerPath(mailDir, fsImpl);
  const tmp = path.join(
    mailDir,
    `${LEDGER_BASENAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  const body = JSON.stringify({ items }, null, 2);
  fsImpl.writeFileSync(tmp, body, { mode: 0o600 });
  fsImpl.renameSync(tmp, p);
}

/**
 * @param {string} mailDir
 * @param {NotifyLedgerItem} item
 * @param {typeof fs} [fsImpl]
 * @returns {{ items: NotifyLedgerItem[], isNew: boolean }}
 */
function upsertNotifyItem(mailDir, item, fsImpl = fs) {
  const items = readNotifyLedger(mailDir, fsImpl);
  const idx = items.findIndex((r) => r.notify_id === item.notify_id);
  let isNew = false;
  if (idx >= 0) {
    items[idx] = item;
  } else {
    items.push(item);
    isNew = true;
  }
  writeNotifyLedger(mailDir, items, fsImpl);
  return { items, isNew };
}

/**
 * @param {string} mailDir
 * @param {string} notifyId
 * @param {typeof fs} [fsImpl]
 */
function removeNotifyItem(mailDir, notifyId, fsImpl = fs) {
  const items = readNotifyLedger(mailDir, fsImpl);
  const next = items.filter((r) => r.notify_id !== notifyId);
  writeNotifyLedger(mailDir, next, fsImpl);
  return next;
}

/**
 * @param {string} basename
 * @returns {{ uidValidity: number, uid: number } | null}
 */
function parseMessageBasename(basename) {
  const m = /^[0-9TZ]+_(\d+)_(\d{10})\.json$/.exec(basename);
  if (!m) return null;
  return {
    uidValidity: Number.parseInt(m[1], 10),
    uid: Number.parseInt(m[2], 10),
  };
}

/**
 * @param {number} nowMs
 * @returns {string}
 */
function isoFromMs(nowMs) {
  return new Date(nowMs).toISOString();
}

/**
 * @param {string} iso
 * @returns {number}
 */
function msFromIso(iso) {
  return Date.parse(iso);
}

/**
 * @param {NotifyLedgerItem[]} items
 * @param {number} nowMs
 */
function dueNotifyItems(items, nowMs) {
  return items.filter((row) => msFromIso(row.next_attempt_at) <= nowMs);
}

/**
 * @param {NotifyLedgerItem[]} items
 * @param {number} nowMs
 * @returns {number | null} ms until soonest due, or null if none
 */
function msUntilNextDue(items, nowMs) {
  if (items.length === 0) return null;
  let soonest = Infinity;
  for (const row of items) {
    const t = msFromIso(row.next_attempt_at);
    if (t <= nowMs) return 0;
    if (t < soonest) soonest = t;
  }
  return soonest === Infinity ? null : Math.max(0, soonest - nowMs);
}

/**
 * @param {string} mailDir
 * @param {string} basename
 * @param {typeof fs} [fsImpl]
 */
/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 * @returns {NotifyLedgerItem[]}
 */
function readLedgerRetryQueue(mailDir, fsImpl = fs) {
  const p = path.join(mailDir, LEDGER_RETRY_BASENAME);
  if (!fsImpl.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(p, 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter(
      (row) =>
        typeof row.notify_id === 'string' &&
        typeof row.uid === 'number' &&
        typeof row.next_attempt_at === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * @param {string} mailDir
 * @param {NotifyLedgerItem[]} items
 * @param {typeof fs} [fsImpl]
 */
function writeLedgerRetryQueue(mailDir, items, fsImpl = fs) {
  const p = path.join(mailDir, LEDGER_RETRY_BASENAME);
  if (items.length === 0) {
    if (fsImpl.existsSync(p)) {
      try {
        fsImpl.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const tmp = path.join(
    mailDir,
    `${LEDGER_RETRY_BASENAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  fsImpl.writeFileSync(tmp, JSON.stringify({ items }, null, 2), { mode: 0o600 });
  fsImpl.renameSync(tmp, p);
}

/**
 * @param {NotifyLedgerItem[]} ledgerItems
 * @param {NotifyLedgerItem[]} retryItems
 * @param {number} nowMs
 */
function msUntilNextDueAll(ledgerItems, retryItems, nowMs) {
  let soonest = msUntilNextDue(ledgerItems, nowMs);
  const retryDue = msUntilNextDue(retryItems, nowMs);
  if (retryDue === 0) return 0;
  if (soonest === null) return retryDue;
  if (retryDue === null) return soonest;
  return Math.min(soonest, retryDue);
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 * @returns {boolean}
 */
function hasRedeliverRequestFiles(mailDir, fsImpl = fs) {
  return listRedeliverRequestFiles(mailDir, fsImpl).length > 0;
}

/**
 * @param {string} mailDir
 * @param {Omit<NotifyLedgerItem, 'request_id'> & { request_id?: string }} item
 * @param {number} nowMs
 * @param {typeof fs} [fsImpl]
 */
function upsertLedgerRetryItem(mailDir, item, nowMs, fsImpl = fs) {
  const items = readLedgerRetryQueue(mailDir, fsImpl);
  const attempts = item.attempts + 1;
  const next = {
    ...item,
    attempts,
    last_status: 'ledger',
    next_attempt_at: isoFromMs(nowMs + notifyDelayMs(attempts)),
    request_id: item.request_id ?? crypto.randomUUID(),
  };
  const idx = items.findIndex((r) => r.notify_id === item.notify_id);
  if (idx >= 0) {
    items[idx] = next;
  } else {
    items.push(next);
  }
  writeLedgerRetryQueue(mailDir, items, fsImpl);
  return { attempts, next };
}

function writeRedeliverRequest(mailDir, basename, fsImpl = fs) {
  const dir = requestsDir(mailDir, fsImpl);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { mode: 0o700 });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(dir, `req-${id}.tmp`);
  const final = path.join(dir, `req-${id}.json`);
  fsImpl.writeFileSync(tmp, JSON.stringify({ file: basename }), { mode: 0o600 });
  fsImpl.renameSync(tmp, final);
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 * @returns {string[]}
 */
function listRedeliverRequestFiles(mailDir, fsImpl = fs) {
  const dir = requestsDir(mailDir, fsImpl);
  if (!fsImpl.existsSync(dir)) return [];
  try {
    return fsImpl
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

module.exports = {
  LEDGER_BASENAME,
  LEDGER_RETRY_BASENAME,
  REQUESTS_DIRNAME,
  NOTIFY_DELAY_MS,
  notifyDelayMs,
  buildNotifyId,
  ledgerPath,
  requestsDir,
  readNotifyLedger,
  writeNotifyLedger,
  upsertNotifyItem,
  removeNotifyItem,
  parseMessageBasename,
  isoFromMs,
  msFromIso,
  dueNotifyItems,
  msUntilNextDue,
  writeRedeliverRequest,
  listRedeliverRequestFiles,
  readLedgerRetryQueue,
  writeLedgerRetryQueue,
  msUntilNextDueAll,
  hasRedeliverRequestFiles,
  upsertLedgerRetryItem,
};
