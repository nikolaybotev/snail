'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildNotifyId,
  readNotifyLedger,
  upsertNotifyItem,
  removeNotifyItem,
  msUntilNextDue,
  notifyDelayMs,
  isoFromMs,
  msFromIso,
  listRedeliverRequestFiles,
  parseMessageBasename,
  readLedgerRetryQueue,
  writeLedgerRetryQueue,
  upsertLedgerRetryItem,
  hasRedeliverRequestFiles,
} = require('./notify-ledger.js');
const { notifyWebhookOnce, buildWebhookBody } = require('./notifiers/webhook.js');
const { notifyOpenClawWakeOnce } = require('./notifiers/openclaw.js');
const { readSnailState, writeSnailState } = require('./mail-store.js');

/** Poll interval for redeliver request files; not in NOTIFY_DELAY_MS (starts at 1000). */
const REQUEST_POLL_MS = 900;

/**
 * One poll loop per account. `waitForRequest` is used inside each `raceIdle` without starting new loops.
 * @param {{
 *   mailDir: string,
 *   pollMs: number,
 *   sleeper: (ms: number) => Promise<void>,
 *   stopSignal: { stopped: boolean },
 *   fsImpl?: typeof fs,
 * }} opts
 */
function createRedeliverPollWatcher(opts) {
  const fsImpl = opts.fsImpl ?? fs;
  let stopped = false;
  let started = false;
  /** @type {(() => void)[]} */
  let waiters = [];

  function wakeWaiters() {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  async function pollLoop() {
    while (!opts.stopSignal.stopped && !stopped) {
      await opts.sleeper(opts.pollMs);
      if (opts.stopSignal.stopped || stopped) {
        break;
      }
      if (hasRedeliverRequestFiles(opts.mailDir, fsImpl)) {
        wakeWaiters();
      }
    }
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      void pollLoop();
    },
    stop() {
      stopped = true;
      wakeWaiters();
    },
    discardPendingWaiters() {
      waiters = [];
    },
    waitForRequest() {
      if (stopped || opts.stopSignal.stopped) {
        return Promise.resolve();
      }
      if (hasRedeliverRequestFiles(opts.mailDir, fsImpl)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

/**
 * @param {{
 *   account: import('./config.js').SnailAccount,
 *   notifierSecret: string,
 *   openclawClient: import('./notifiers/openclaw.js').OpenClawClient | null,
 *   log: (msg: string) => void,
 *   fetchImpl?: typeof fetch,
 *   sleeper?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   fs?: typeof fs,
 * }} ctx
 */
function createNotifyDelivery(ctx) {
  const fsImpl = ctx.fs ?? fs;
  const now = ctx.now ?? (() => Date.now());
  const mailDir = ctx.account.mail_dir;
  let lastLoggedCount = -1;
  /** @type {Map<string, number>} */
  const removalHoldUntil = new Map();

  /**
   * @param {import('./notify-ledger.js').NotifyLedgerItem} row
   * @param {number} nowMs
   */
  function effectiveDueMs(row, nowMs) {
    const hold = removalHoldUntil.get(row.notify_id);
    const at = msFromIso(row.next_attempt_at);
    if (hold != null && hold > at) {
      return hold;
    }
    return at;
  }

  /**
   * @param {import('./notify-ledger.js').NotifyLedgerItem[]} items
   * @param {number} nowMs
   */
  function dueRows(items, nowMs) {
    return items.filter((row) => effectiveDueMs(row, nowMs) <= nowMs);
  }

  /**
   * @param {import('./notify-ledger.js').NotifyLedgerItem[]} ledgerItems
   * @param {import('./notify-ledger.js').NotifyLedgerItem[]} retryItems
   * @param {number} nowMs
   */
  function msUntilNextDueEffective(ledgerItems, retryItems, nowMs) {
    const merged = [...ledgerItems, ...retryItems];
    if (merged.length === 0) return null;
    let soonest = Infinity;
    for (const row of merged) {
      const t = effectiveDueMs(row, nowMs);
      if (t <= nowMs) return 0;
      if (t < soonest) soonest = t;
    }
    return soonest === Infinity ? null : Math.max(0, soonest - nowMs);
  }

  function outstandingTotal() {
    let n = 0;
    try {
      n += readNotifyLedger(mailDir, fsImpl).length;
    } catch {
      throw new Error('ledger unreadable');
    }
    try {
      n += readLedgerRetryQueue(mailDir, fsImpl).length;
    } catch {
      throw new Error('ledger retry unreadable');
    }
    return n;
  }

  /**
   * @param {{ force?: boolean }} [options]
   */
  function logOutstandingCount(options = {}) {
    const force = options.force === true;
    let n;
    try {
      n = outstandingTotal();
    } catch {
      return;
    }
    if (force || n !== lastLoggedCount) {
      lastLoggedCount = n;
      ctx.log(`notify outstanding count ${n}`);
    }
  }

  /**
   * @param {string | undefined} fromField
   */
  function bareFrom(fromField) {
    if (typeof fromField !== 'string' || fromField.length === 0) return 'unknown';
    const m = /<([^>]+)>/.exec(fromField);
    if (m) return m[1];
    if (fromField.includes('@')) return fromField.trim();
    return 'unknown';
  }

  /**
   * @param {import('./notify-ledger.js').NotifyLedgerItem} row
   * @param {{ from?: string, subject?: string }} [overrides]
   */
  async function attemptRow(row, overrides) {
    const filePath = path.join(mailDir, row.file);
    if (!fsImpl.existsSync(filePath)) {
      const attempts = row.attempts + 1;
      const nextMs = now() + notifyDelayMs(attempts);
      try {
        upsertNotifyItem(
          mailDir,
          {
            ...row,
            attempts,
            last_status: 'missing',
            next_attempt_at: isoFromMs(nextMs),
          },
          fsImpl
        );
        ctx.log(`notify failed uid ${row.uid} attempts ${attempts} status missing`);
      } catch {
        ctx.log(`notify failed uid ${row.uid} attempts ${attempts} status ledger`);
      }
      return;
    }

    let record;
    try {
      record = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      record = {};
    }

    const from =
      overrides && Object.prototype.hasOwnProperty.call(overrides, 'from')
        ? overrides.from
        : bareFrom(record.from);
    const subject =
      overrides && Object.prototype.hasOwnProperty.call(overrides, 'subject')
        ? overrides.subject
        : typeof record.subject === 'string' && record.subject.length > 0
          ? record.subject
          : '(no subject)';
    const notifyId = buildNotifyId(ctx.account.name, row.uid_validity, row.uid);
    const attemptNum = row.attempts + 1;
    let requestId =
      row.request_id && row.request_id.length > 0 ? row.request_id : crypto.randomUUID();
    if (!row.request_id || row.request_id.length === 0) {
      row = { ...row, request_id: requestId };
      try {
        upsertNotifyItem(mailDir, row, fsImpl);
      } catch {
        ctx.log(`notify failed uid ${row.uid} attempts ${attemptNum} status ledger`);
        return;
      }
    }

    let result;
    if (ctx.account.notifier === 'webhook') {
      const payload = buildWebhookBody({
        account: ctx.account.name,
        from,
        subject,
        date: record.date ?? isoFromMs(now()),
        message_id: record.message_id ?? '',
        path: filePath,
        mailbox: ctx.account.mailbox,
        uid: row.uid,
        uid_validity: row.uid_validity,
        notify_id: notifyId,
      });
      result = await notifyWebhookOnce({
        webhookUrl: ctx.account.webhook_url,
        secret: ctx.notifierSecret,
        webhookAuth: ctx.account.webhook_auth,
        webhookHeader: ctx.account.webhook_header,
        payload,
        fetchImpl: ctx.fetchImpl,
        sleeper: ctx.sleeper,
        log: ctx.log,
        now,
        attemptNumber: attemptNum,
        requestId,
      });
    } else if (ctx.openclawClient) {
      result = await notifyOpenClawWakeOnce({
        client: ctx.openclawClient,
        from,
        subject,
        path: filePath,
        notifyId,
      });
    } else {
      result = { ok: false, statusToken: 'error' };
    }

    if (result.ok) {
      try {
        removeNotifyItem(mailDir, row.notify_id, fsImpl);
        removalHoldUntil.delete(row.notify_id);
        ctx.log(`notify ok uid ${row.uid} attempts ${attemptNum}`);
        logOutstandingCount({ force: true });
      } catch {
        const nextMs = now() + notifyDelayMs(attemptNum);
        try {
          upsertNotifyItem(
            mailDir,
            {
              ...row,
              attempts: attemptNum,
              last_status: 'ledger',
              next_attempt_at: isoFromMs(nextMs),
            },
            fsImpl
          );
          removalHoldUntil.delete(row.notify_id);
          ctx.log(`notify failed uid ${row.uid} attempts ${attemptNum} status ledger`);
        } catch {
          removalHoldUntil.set(row.notify_id, nextMs);
          ctx.log(`notify failed uid ${row.uid} attempts ${attemptNum} status ledger`);
        }
      }
      return;
    }

    const nextMs = now() + notifyDelayMs(attemptNum);
    try {
      upsertNotifyItem(
        mailDir,
        {
          ...row,
          attempts: attemptNum,
          last_status: result.statusToken,
          next_attempt_at: isoFromMs(nextMs),
          request_id: requestId,
        },
        fsImpl
      );
      ctx.log(`notify failed uid ${row.uid} attempts ${attemptNum} status ${result.statusToken}`);
    } catch {
      removalHoldUntil.set(row.notify_id, nextMs);
      ctx.log(`notify failed uid ${row.uid} attempts ${attemptNum} status ledger`);
    }
  }

  async function attemptLedgerRetryRow(row) {
    const nowMs = now();
    if (effectiveDueMs(row, nowMs) > nowMs) {
      return;
    }
    const requestId =
      row.request_id && row.request_id.length > 0 ? row.request_id : crypto.randomUUID();
    try {
      const { isNew } = upsertNotifyItem(
        mailDir,
        {
          notify_id: row.notify_id,
          account: row.account,
          uid: row.uid,
          uid_validity: row.uid_validity,
          file: row.file,
          attempts: 0,
          last_status: 'none',
          next_attempt_at: isoFromMs(now()),
          request_id: requestId,
        },
        fsImpl
      );
      const intake = readSnailState(mailDir, fsImpl);
      if (
        intake &&
        row.uid_validity === intake.uidValidity &&
        row.uid > intake.lastUid &&
        row.uid >= intake.notifyBoundary
      ) {
        writeSnailState(mailDir, { ...intake, lastUid: row.uid }, fsImpl);
      }
      const remaining = readLedgerRetryQueue(mailDir, fsImpl).filter(
        (r) => r.notify_id !== row.notify_id
      );
      writeLedgerRetryQueue(mailDir, remaining, fsImpl);
      if (isNew) {
        ctx.log(`notify pending uid ${row.uid} file ${row.file}`);
      }
      const written = readNotifyLedger(mailDir, fsImpl).find((r) => r.notify_id === row.notify_id);
      if (written) {
        await attemptRow(written);
      }
    } catch {
      try {
        const { attempts } = upsertLedgerRetryItem(
          mailDir,
          { ...row, request_id: requestId },
          now(),
          fsImpl
        );
        ctx.log(`notify failed uid ${row.uid} attempts ${attempts} status ledger`);
      } catch {
        const attempts = (row.attempts || 0) + 1;
        const nextMs = now() + notifyDelayMs(attempts);
        removalHoldUntil.set(row.notify_id, nextMs);
        ctx.log(`notify failed uid ${row.uid} attempts ${attempts} status ledger`);
      }
    }
  }

  async function runDueTurn() {
    let retryItems = [];
    try {
      retryItems = readLedgerRetryQueue(mailDir, fsImpl);
    } catch {
      ctx.log('notify ledger retry unreadable');
      retryItems = [];
    }
    let items;
    try {
      items = readNotifyLedger(mailDir, fsImpl);
    } catch {
      ctx.log('notify failed uid 0 attempts 0 status ledger');
      return;
    }
    const nowMs = now();
    const dueRetry = dueRows(retryItems, nowMs);
    for (const row of dueRetry) {
      await attemptLedgerRetryRow(row);
    }
    try {
      items = readNotifyLedger(mailDir, fsImpl);
    } catch {
      ctx.log('notify failed uid 0 attempts 0 status ledger');
      return;
    }
    const due = dueRows(items, nowMs);
    for (const row of due) {
      await attemptRow(row);
    }
  }

  function queueRowNow(basename, uid, uidValidity) {
    const notifyId = buildNotifyId(ctx.account.name, uidValidity, uid);
    let items;
    try {
      items = readNotifyLedger(mailDir, fsImpl);
    } catch {
      return;
    }
    const existing = items.find((r) => r.notify_id === notifyId);
    const nowMs = now();
    const row = existing ?? {
      notify_id: notifyId,
      account: ctx.account.name,
      uid,
      uid_validity: uidValidity,
      file: basename,
      attempts: 0,
      last_status: 'none',
      next_attempt_at: isoFromMs(nowMs),
      request_id: crypto.randomUUID(),
    };
    try {
      upsertNotifyItem(
        mailDir,
        { ...row, next_attempt_at: isoFromMs(nowMs) },
        fsImpl
      );
    } catch {
      ctx.log(`notify failed uid ${uid} attempts ${row.attempts || 0} status ledger`);
      return;
    }
    if (!existing) {
      ctx.log(`notify pending uid ${uid} file ${basename}`);
      logOutstandingCount({ force: true });
    }
    ctx.log(`notify redeliver uid ${uid} file ${basename}`);
  }

  function isEligibleRedeliver(basename, parsed) {
    const intake = readSnailState(mailDir, fsImpl);
    if (!intake) return { ok: false, reason: 'state' };
    if (!fsImpl.existsSync(path.join(mailDir, basename))) {
      return { ok: false, reason: 'missing' };
    }
    if (parsed.uidValidity !== intake.uidValidity) {
      const notifyId = buildNotifyId(ctx.account.name, parsed.uidValidity, parsed.uid);
      try {
        const items = readNotifyLedger(mailDir, fsImpl);
        if (!items.some((r) => r.notify_id === notifyId)) {
          return { ok: false, reason: 'resync' };
        }
      } catch {
        return { ok: false, reason: 'resync' };
      }
    }
    if (parsed.uid < intake.notifyBoundary) {
      return { ok: false, reason: 'backlog' };
    }
    return { ok: true, intake, parsed };
  }

  async function applyRedeliverRequests() {
    const paths = listRedeliverRequestFiles(mailDir, fsImpl);
    for (const reqPath of paths) {
      let basename;
      try {
        const raw = fsImpl.readFileSync(reqPath, 'utf8');
        const data = JSON.parse(raw);
        basename = data.file;
      } catch {
        ctx.log('notify redeliver refused uid 0 reason invalid');
        try {
          fsImpl.unlinkSync(reqPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      const parsed = parseMessageBasename(basename);
      if (!parsed) {
        try {
          fsImpl.unlinkSync(reqPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      const check = isEligibleRedeliver(basename, parsed);
      if (!check.ok) {
        ctx.log(`notify redeliver refused uid ${parsed.uid} reason ${check.reason}`);
        try {
          fsImpl.unlinkSync(reqPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      queueRowNow(basename, parsed.uid, parsed.uidValidity);
      try {
        fsImpl.unlinkSync(reqPath);
      } catch {
        /* ignore */
      }
      let row;
      try {
        row = readNotifyLedger(mailDir, fsImpl).find(
          (r) => r.notify_id === buildNotifyId(ctx.account.name, parsed.uidValidity, parsed.uid)
        );
      } catch {
        ctx.log(`notify failed uid ${parsed.uid} attempts 0 status ledger`);
        continue;
      }
      if (row) {
        await attemptRow(row);
      }
    }
  }

  /**
   * @param {{ uid: number, path: string, from: string, subject: string, filename: string }} wakeCtx
   */
  async function attemptAfterSave(wakeCtx) {
    const notifyId = buildNotifyId(
      ctx.account.name,
      readSnailState(mailDir, fsImpl)?.uidValidity ?? 0,
      wakeCtx.uid
    );
    let row;
    try {
      row = readNotifyLedger(mailDir, fsImpl).find((r) => r.notify_id === notifyId);
    } catch {
      return;
    }
    if (!row) return;
    /** @type {{ from?: string, subject?: string }} */
    const overrides = {};
    if (wakeCtx.from !== undefined) {
      overrides.from = wakeCtx.from;
    }
    if (wakeCtx.subject !== undefined) {
      overrides.subject = wakeCtx.subject;
    }
    await attemptRow(
      row,
      Object.keys(overrides).length > 0 ? overrides : undefined
    );
  }

  function msUntilDelivery() {
    const nowMs = now();
    let retryItems = [];
    try {
      retryItems = readLedgerRetryQueue(mailDir, fsImpl);
    } catch {
      ctx.log('notify ledger retry unreadable');
      retryItems = [];
    }
    let items;
    try {
      items = readNotifyLedger(mailDir, fsImpl);
    } catch {
      ctx.log('notify failed uid 0 attempts 0 status ledger');
      return null;
    }
    return msUntilNextDueEffective(items, retryItems, nowMs);
  }

  function outstandingCount() {
    try {
      return outstandingTotal();
    } catch {
      return 0;
    }
  }

  return {
    REQUEST_POLL_MS,
    logOutstandingCount,
    runDueTurn,
    applyRedeliverRequests,
    attemptAfterSave,
    msUntilDelivery,
    outstandingCount,
    attemptRow,
  };
}

module.exports = {
  createNotifyDelivery,
  createRedeliverPollWatcher,
  REQUEST_POLL_MS: 900,
};
