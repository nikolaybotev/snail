'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildNotifyId,
  readNotifyLedger,
  upsertNotifyItem,
  removeNotifyItem,
  dueNotifyItems,
  msUntilNextDue,
  msUntilNextDueAll,
  notifyDelayMs,
  isoFromMs,
  msFromIso,
  listRedeliverRequestFiles,
  parseMessageBasename,
  readLedgerRetryQueue,
  writeLedgerRetryQueue,
  upsertLedgerRetryItem,
} = require('./notify-ledger.js');
const { notifyWebhookOnce, buildWebhookBody } = require('./notifiers/webhook.js');
const { notifyOpenClawWakeOnce } = require('./notifiers/openclaw.js');
const { readSnailState, writeSnailState } = require('./mail-store.js');

const REQUEST_POLL_MS = 1000;

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

  function logOutstandingCount() {
    let items;
    try {
      items = readNotifyLedger(mailDir, fsImpl);
    } catch {
      return;
    }
    const n = items.length;
    if (n !== lastLoggedCount) {
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
      return;
    }

    let record;
    try {
      record = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      record = {};
    }

    const from = overrides?.from ?? bareFrom(record.from);
    const subject =
      overrides?.subject ??
      (typeof record.subject === 'string' && record.subject.length > 0
        ? record.subject
        : '(no subject)');
    const notifyId = buildNotifyId(ctx.account.name, row.uid_validity, row.uid);
    const attemptNum = row.attempts + 1;

    let result;
    if (ctx.account.notifier === 'webhook') {
      const payload = buildWebhookBody({
        account: ctx.account.name,
        from,
        subject,
        date: record.date ?? new Date().toISOString(),
        message_id: record.message_id ?? '',
        path: filePath,
        mailbox: ctx.account.mailbox,
        uid: row.uid,
        uid_validity: row.uid_validity,
        notify_id: notifyId,
      });
      const requestId =
        row.request_id && row.request_id.length > 0 ? row.request_id : crypto.randomUUID();
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
        ctx.log(`notify ok uid ${row.uid} attempts ${attemptNum}`);
        logOutstandingCount();
      } catch {
        /* row stays for retry */
      }
      return;
    }

    const nextMs = now() + notifyDelayMs(attemptNum);
    upsertNotifyItem(
      mailDir,
      {
        ...row,
        attempts: attemptNum,
        last_status: result.statusToken,
        next_attempt_at: isoFromMs(nextMs),
      },
      fsImpl
    );
    ctx.log(`notify failed uid ${row.uid} attempts ${attemptNum} status ${result.statusToken}`);
  }

  async function attemptLedgerRetryRow(row) {
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
      const { attempts } = upsertLedgerRetryItem(mailDir, { ...row, request_id: requestId }, now(), fsImpl);
      ctx.log(`notify failed uid ${row.uid} attempts ${attempts} status ledger`);
    }
  }

  async function runDueTurn() {
    let items;
    let retryItems;
    try {
      items = readNotifyLedger(mailDir, fsImpl);
      retryItems = readLedgerRetryQueue(mailDir, fsImpl);
    } catch {
      return;
    }
    const nowMs = now();
    const dueRetry = dueNotifyItems(retryItems, nowMs);
    for (const row of dueRetry) {
      await attemptLedgerRetryRow(row);
    }
    try {
      items = readNotifyLedger(mailDir, fsImpl);
    } catch {
      return;
    }
    const due = dueNotifyItems(items, nowMs);
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
    upsertNotifyItem(
      mailDir,
      { ...row, next_attempt_at: isoFromMs(nowMs) },
      fsImpl
    );
    if (!existing) {
      ctx.log(`notify pending uid ${uid} file ${basename}`);
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
      const row = readNotifyLedger(mailDir, fsImpl).find(
        (r) => r.notify_id === buildNotifyId(ctx.account.name, parsed.uidValidity, parsed.uid)
      );
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
    await attemptRow(row, {
      from: wakeCtx.from,
      subject: wakeCtx.subject,
    });
  }

  function msUntilDelivery() {
    try {
      const items = readNotifyLedger(mailDir, fsImpl);
      const retryItems = readLedgerRetryQueue(mailDir, fsImpl);
      return msUntilNextDueAll(items, retryItems, now());
    } catch {
      return null;
    }
  }

  function outstandingCount() {
    try {
      return readNotifyLedger(mailDir, fsImpl).length;
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
  REQUEST_POLL_MS: 1000,
};
