'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildNotifyId,
  upsertNotifyItem,
  readNotifyLedger,
  isoFromMs,
  upsertLedgerRetryItem,
} = require('./notify-ledger.js');

const STATE_BASENAME = '.snail-state.json';

/**
 * @param {number} uid
 * @returns {string}
 */
function padUid(uid) {
  return String(uid).padStart(10, '0');
}

/**
 * @param {number} uidValidity
 * @param {number} uid
 * @returns {string} suffix for directory lookup
 */
function fileSuffixForUid(uidValidity, uid) {
  return `_${uidValidity}_${padUid(uid)}.json`;
}

/**
 * @param {Date} d
 * @returns {string} YYYYMMDDTHHMMSSZ in UTC
 */
function formatTimestampUtc(d) {
  const iso = d.toISOString();
  return iso.slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

/**
 * @param {Date | null | undefined} envelopeDate
 * @param {number} uidValidity
 * @param {number} uid
 * @param {Date} saveTime
 * @returns {{ filename: string, dateSource: 'message' | 'saved', dateIso: string }}
 */
function messageFilenameFor(envelopeDate, uidValidity, uid, saveTime) {
  let tsDate;
  let dateSource;
  if (envelopeDate instanceof Date && !Number.isNaN(envelopeDate.getTime())) {
    tsDate = envelopeDate;
    dateSource = 'message';
  } else {
    tsDate = saveTime;
    dateSource = 'saved';
  }
  const stamp = formatTimestampUtc(tsDate);
  const filename = `${stamp}_${uidValidity}_${padUid(uid)}.json`;
  const dateIso = tsDate.toISOString();
  return { filename, dateSource, dateIso };
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 * @returns {string}
 */
function stateFilePath(mailDir, fsImpl = fs) {
  return path.join(mailDir, STATE_BASENAME);
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 * @returns {import('./mail-store.js').SnailState | null}
 */
function readSnailState(mailDir, fsImpl = fs) {
  const p = stateFilePath(mailDir, fsImpl);
  if (!fsImpl.existsSync(p)) return null;
  let raw;
  try {
    raw = fsImpl.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.uidValidity !== 'number' ||
      typeof parsed.notifyBoundary !== 'number' ||
      typeof parsed.backlogUid !== 'number' ||
      typeof parsed.lastUid !== 'number'
    ) {
      return null;
    }
    return {
      uidValidity: parsed.uidValidity,
      notifyBoundary: parsed.notifyBoundary,
      backlogUid: parsed.backlogUid,
      lastUid: parsed.lastUid,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} mailDir
 * @param {import('./mail-store.js').SnailState} state
 * @param {typeof fs} [fsImpl]
 */
function writeSnailState(mailDir, state, fsImpl = fs) {
  const p = stateFilePath(mailDir, fsImpl);
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(state, null, 2);
  fsImpl.writeFileSync(tmp, body, { mode: 0o600 });
  fsImpl.renameSync(tmp, p);
}

/**
 * @param {number} uidValidity
 * @param {number} uidNext
 * @returns {import('./mail-store.js').SnailState}
 */
function initialSnailState(uidValidity, uidNext) {
  return {
    uidValidity,
    notifyBoundary: uidNext,
    backlogUid: 0,
    lastUid: uidNext - 1,
  };
}

/**
 * @param {string} mailDir
 * @param {number} uidValidity
 * @param {number} uidNext
 * @param {typeof fs} [fsImpl]
 * @returns {import('./mail-store.js').SnailState}
 */
function persistInitialSnailState(mailDir, uidValidity, uidNext, fsImpl = fs) {
  const state = initialSnailState(uidValidity, uidNext);
  writeSnailState(mailDir, state, fsImpl);
  return state;
}

/**
 * @param {string} mailDir
 * @param {number} uidValidity
 * @param {number} uid
 * @param {typeof fs} [fsImpl]
 * @returns {string | null} absolute path to existing file
 */
function lookupExistingMessageFile(mailDir, uidValidity, uid, fsImpl = fs) {
  const suffix = fileSuffixForUid(uidValidity, uid);
  let names;
  try {
    names = fsImpl.readdirSync(mailDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.endsWith(suffix)) {
      return path.join(mailDir, name);
    }
  }
  return null;
}

/**
 * @param {{ name?: string, address?: string }[]} addrs
 * @returns {string}
 */
function formatAddressList(addrs) {
  if (!addrs || addrs.length === 0) return '';
  return addrs
    .map((a) => {
      const addr = a.address || '';
      const name = a.name || '';
      if (!addr) return '';
      if (name) return `${name} <${addr}>`;
      return `<${addr}>`;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * @param {{ name?: string, address?: string }[]} addrs
 * @returns {string}
 */
function firstBareAddress(addrs) {
  if (!addrs || addrs.length === 0) return 'unknown';
  const addr = addrs[0]?.address;
  return typeof addr === 'string' && addr.length > 0 ? addr : 'unknown';
}

/**
 * @param {string | unknown} fromField stored `from` on a message file
 * @returns {string}
 */
function bareFromStoredField(fromField) {
  if (typeof fromField !== 'string' || fromField.length === 0) return 'unknown';
  const m = /<([^>]+)>/.exec(fromField);
  if (m) return m[1];
  if (fromField.includes('@')) return fromField.trim();
  return 'unknown';
}

/**
 * @param {string} filePath
 * @param {typeof fs} [fsImpl]
 */
function readWakeFieldsFromMessageFile(filePath, fsImpl = fs) {
  try {
    const record = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    const wakeSubject =
      typeof record.subject === 'string' && record.subject.length > 0
        ? record.subject
        : '(no subject)';
    return { wakeFrom: bareFromStoredField(record.from), wakeSubject };
  } catch {
    return { wakeFrom: 'unknown', wakeSubject: '(no subject)' };
  }
}

/**
 * @param {{
 *   uid: number,
 *   uidValidity: number,
 *   messageId?: string,
 *   from?: { name?: string, address?: string }[],
 *   to?: { name?: string, address?: string }[],
 *   subject?: string,
 *   envelopeDate?: Date | null,
 *   body?: string,
 *   htmlBody?: string,
 *   attachments?: { filename?: string, contentType?: string, content?: Buffer }[],
 *   textLimit: number,
 *   htmlLimit: number,
 *   attachmentLimit: number,
 *   saveTime?: Date,
 * }} input
 * @returns {{ record: object, filename: string, absolutePath: string, wakeFrom: string, wakeSubject: string }}
 */
function buildMessagePayload(input, mailDir) {
  const saveTime = input.saveTime ?? new Date();
  const { filename, dateSource, dateIso } = messageFilenameFor(
    input.envelopeDate,
    input.uidValidity,
    input.uid,
    saveTime
  );
  const subject =
    typeof input.subject === 'string' && input.subject.length > 0
      ? input.subject
      : '(no subject)';

  let body = input.body ?? '';
  let textTruncated = false;
  if (body.length > input.textLimit) {
    body = body.slice(0, input.textLimit);
    textTruncated = true;
  }

  /** @type {Record<string, unknown>} */
  const record = {
    uid: input.uid,
    uid_validity: input.uidValidity,
    message_id: input.messageId ?? '',
    from: formatAddressList(input.from),
    to: formatAddressList(input.to),
    subject,
    date: dateIso,
    date_source: dateSource,
    body,
    text_truncated: textTruncated,
  };

  if (input.htmlBody !== undefined && input.htmlBody !== null && input.htmlBody !== '') {
    let html = input.htmlBody;
    let htmlTruncated = false;
    if (html.length > input.htmlLimit) {
      html = html.slice(0, input.htmlLimit);
      htmlTruncated = true;
    }
    record.html_body = html;
    record.html_truncated = htmlTruncated;
  }

  const attachments = input.attachments ?? [];
  if (attachments.length > 0) {
    record.attachments = attachments.map((a) => {
      const content = a.content ?? Buffer.alloc(0);
      const decodedBytes = content.length;
      const base = {
        filename: a.filename || 'unnamed',
        content_type: a.contentType || 'application/octet-stream',
        size: decodedBytes,
      };
      if (decodedBytes > input.attachmentLimit) {
        return { ...base, omitted: true };
      }
      return {
        ...base,
        content: content.toString('base64'),
        omitted: false,
      };
    });
  }

  const absolutePath = path.join(mailDir, filename);
  return {
    record,
    filename,
    absolutePath,
    wakeFrom: firstBareAddress(input.from),
    wakeSubject: subject,
  };
}

/**
 * @param {{
 *   mailDir: string,
 *   textLimit: number,
 *   htmlLimit: number,
 *   attachmentLimit: number,
 *   accountName?: string,
 *   mailbox?: string,
 *   accountLog?: (msg: string) => void,
 *   fs?: typeof fs,
 *   log?: (line: string) => void,
 *   now?: () => number,
 * }} options
 */
function createMailStore(options) {
  const fsImpl = options.fs ?? fs;
  const log = options.log ?? (() => {});
  const accountLog = options.accountLog;
  const mailboxName = options.mailbox;
  const accountName = options.accountName ?? 'account';
  const nowMs = options.now ?? (() => Date.now());
  const saveNow = options.saveNow ?? (() => new Date(nowMs()));
  const mailDir = options.mailDir;
  const limits = {
    textLimit: options.textLimit,
    htmlLimit: options.htmlLimit,
    attachmentLimit: options.attachmentLimit,
  };

  function ensureMailDir() {
    if (!fsImpl.existsSync(mailDir)) {
      fsImpl.mkdirSync(mailDir, { recursive: true });
    }
  }

  /**
   * @returns {import('./mail-store.js').SnailState | null}
   */
  function readState() {
    return readSnailState(mailDir, fsImpl);
  }

  /**
   * Before any body fetch: first run or UIDVALIDITY resync.
   * @param {number} uidValidity
   * @param {number} uidNext
   */
  function ensureMailboxState(uidValidity, uidNext) {
    ensureMailDir();
    const existing = readState();
    if (existing === null || existing.uidValidity !== uidValidity) {
      return persistInitialSnailState(mailDir, uidValidity, uidNext, fsImpl);
    }
    return existing;
  }

  /**
   * @param {import('./mail-store.js').SnailState} state
   * @param {number} uid
   * @param {Partial<import('./mail-store.js').SnailState>} patch
   */
  function updateState(state, patch) {
    const next = {
      uidValidity: state.uidValidity,
      notifyBoundary: state.notifyBoundary,
      backlogUid: state.backlogUid,
      lastUid: state.lastUid,
      ...patch,
    };
    if (next.lastUid < next.notifyBoundary) {
      next.lastUid = state.lastUid;
    }
    writeSnailState(mailDir, next, fsImpl);
    return next;
  }

  /**
   * @param {object} msg
   * @param {number} msg.uid
   * @param {number} msg.uidValidity
   * @param {string} [msg.messageId]
   * @param {{ name?: string, address?: string }[]} [msg.from]
   * @param {{ name?: string, address?: string }[]} [msg.to]
   * @param {string} [msg.subject]
   * @param {Date | null} [msg.envelopeDate]
   * @param {string} [msg.body]
   * @param {string} [msg.htmlBody]
   * @param {{ filename?: string, contentType?: string, content?: Buffer }[]} [msg.attachments]
   * @returns {Promise<{ skipped: boolean, saved: boolean, attemptNotify: boolean, path?: string, filename?: string, wakeFrom?: string, wakeSubject?: string, uid?: number, state: import('./mail-store.js').SnailState }>}
   */
  async function saveOneMessage(msg) {
    ensureMailDir();
    let state = readState();
    if (state === null) {
      throw new Error('mailbox state is not initialized');
    }

    const existingPath = lookupExistingMessageFile(mailDir, msg.uidValidity, msg.uid, fsImpl);
    if (existingPath) {
      const basename = path.basename(existingPath);
      if (
        msg.uid > state.lastUid &&
        msg.uid >= state.notifyBoundary &&
        msg.uidValidity === state.uidValidity
      ) {
        const { wakeFrom, wakeSubject } = readWakeFieldsFromMessageFile(existingPath, fsImpl);
        const prepared = prepareLedgerRow(
          msg.uid,
          msg.uidValidity,
          basename,
          state,
          wakeFrom,
          wakeSubject
        );
        if (prepared.attemptNotify) {
          return {
            skipped: true,
            saved: false,
            attemptNotify: true,
            path: existingPath,
            filename: basename,
            wakeFrom,
            wakeSubject,
            uid: msg.uid,
            state: prepared.state,
          };
        }
      }
      return {
        skipped: true,
        saved: false,
        attemptNotify: false,
        path: existingPath,
        state,
      };
    }

    const built = buildMessagePayload(
      {
        uid: msg.uid,
        uidValidity: msg.uidValidity,
        messageId: msg.messageId,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        envelopeDate: msg.envelopeDate,
        body: msg.body,
        htmlBody: msg.htmlBody,
        attachments: msg.attachments,
        ...limits,
        saveTime: saveNow(),
      },
      mailDir
    );

    const tmpPath = path.join(
      mailDir,
      `${built.filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    const finalPath = built.absolutePath;

    if (msg.beforeWrite && msg.beforeWrite() === false) {
      return { skipped: false, saved: false, attemptNotify: false, state };
    }

    try {
      fsImpl.writeFileSync(tmpPath, JSON.stringify(built.record, null, 2), { mode: 0o600 });
      fsImpl.renameSync(tmpPath, finalPath);
      if (accountLog && mailboxName !== undefined) {
        accountLog(`file write mailbox ${encodeURIComponent(mailboxName)} uid ${msg.uid}`);
      }
      msg.onRenamed?.();
    } catch (err) {
      try {
        if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup failure */
      }
      const name = options.accountName ?? 'account';
      const message = err instanceof Error ? err.message : String(err);
      log(`[snail] [${name}] mail save failed uid ${msg.uid}: ${message}`);
      return { skipped: false, saved: false, attemptNotify: false, state };
    }

    const isBacklog = msg.uid < state.notifyBoundary;

    if (isBacklog) {
      if (msg.uid > state.backlogUid) {
        state = updateState(state, { backlogUid: msg.uid });
      }
      return {
        skipped: false,
        saved: true,
        attemptNotify: false,
        path: finalPath,
        state,
      };
    }

    if (msg.uid >= state.notifyBoundary) {
      const prepared = prepareLedgerRow(
        msg.uid,
        msg.uidValidity,
        built.filename,
        state,
        built.wakeFrom,
        built.wakeSubject
      );
      return {
        skipped: false,
        saved: true,
        attemptNotify: prepared.attemptNotify,
        path: finalPath,
        filename: built.filename,
        wakeFrom: built.wakeFrom,
        wakeSubject: built.wakeSubject,
        uid: msg.uid,
        state: prepared.state,
      };
    }

    return { skipped: false, saved: true, attemptNotify: false, path: finalPath, state };
  }

  /**
   * @param {number} uid
   * @param {number} uidValidity
   * @param {string} basename
   * @param {import('./mail-store.js').SnailState} state
   * @param {string} wakeFrom
   * @param {string} wakeSubject
   */
  function prepareLedgerRow(uid, uidValidity, basename, state, _wakeFrom, _wakeSubject) {
    if (uidValidity !== state.uidValidity) {
      return { attemptNotify: false, state };
    }
    try {
      const notifyId = buildNotifyId(accountName, uidValidity, uid);
      const nowMsVal = nowMs();
      let existing;
      try {
        existing = readNotifyLedger(mailDir, fsImpl).find((r) => r.notify_id === notifyId);
      } catch {
        existing = undefined;
      }
      const requestId =
        existing?.request_id && existing.request_id.length > 0
          ? existing.request_id
          : crypto.randomUUID();
      const { isNew } = upsertNotifyItem(
        mailDir,
        {
          notify_id: notifyId,
          account: accountName,
          uid,
          uid_validity: uidValidity,
          file: basename,
          attempts: existing?.attempts ?? 0,
          last_status: existing?.last_status ?? 'none',
          next_attempt_at: existing?.next_attempt_at ?? isoFromMs(nowMsVal),
          request_id: requestId,
        },
        fsImpl
      );
      if (isNew && accountLog) {
        accountLog(`notify pending uid ${uid} file ${basename}`);
      }
      let nextState = state;
      if (uid > state.lastUid) {
        try {
          nextState = updateState(state, { lastUid: uid });
        } catch {
          const notifyIdOnStateFail = buildNotifyId(accountName, uidValidity, uid);
          const { attempts } = upsertLedgerRetryItem(
            mailDir,
            {
              notify_id: notifyIdOnStateFail,
              account: accountName,
              uid,
              uid_validity: uidValidity,
              file: basename,
              attempts: 0,
              last_status: 'none',
              next_attempt_at: isoFromMs(nowMs()),
              request_id: requestId,
            },
            nowMs(),
            fsImpl
          );
          if (accountLog) {
            accountLog(`notify failed uid ${uid} attempts ${attempts} status ledger`);
          }
          return { attemptNotify: false, state };
        }
      }
      return { attemptNotify: true, state: nextState };
    } catch {
      const notifyId = buildNotifyId(accountName, uidValidity, uid);
      const { attempts } = upsertLedgerRetryItem(
        mailDir,
        {
          notify_id: notifyId,
          account: accountName,
          uid,
          uid_validity: uidValidity,
          file: basename,
          attempts: 0,
          last_status: 'none',
          next_attempt_at: isoFromMs(nowMs()),
        },
        nowMs(),
        fsImpl
      );
      if (accountLog) {
        accountLog(`notify failed uid ${uid} attempts ${attempts} status ledger`);
      }
      return { attemptNotify: false, state };
    }
  }

  return {
    ensureMailDir,
    readState,
    ensureMailboxState,
    saveOneMessage,
    lookupExistingMessageFile: (uidValidity, uid) =>
      lookupExistingMessageFile(mailDir, uidValidity, uid, fsImpl),
  };
}

module.exports = {
  STATE_BASENAME,
  padUid,
  fileSuffixForUid,
  formatTimestampUtc,
  messageFilenameFor,
  stateFilePath,
  readSnailState,
  writeSnailState,
  initialSnailState,
  persistInitialSnailState,
  lookupExistingMessageFile,
  formatAddressList,
  firstBareAddress,
  buildMessagePayload,
  createMailStore,
};

/**
 * @typedef {{ uidValidity: number, notifyBoundary: number, backlogUid: number, lastUid: number }} SnailState
 */
