'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
 *   fs?: typeof fs,
 *   log?: (line: string) => void,
 *   onWake?: (ctx: { uid: number, path: string, from: string, subject: string }) => Promise<'ok' | 'failed'>,
 *   now?: () => Date,
 * }} options
 */
function createMailStore(options) {
  const fsImpl = options.fs ?? fs;
  const log = options.log ?? (() => {});
  const onWake = options.onWake ?? (async () => 'ok');
  const now = options.now ?? (() => new Date());
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
   * @returns {Promise<{ skipped: boolean, saved: boolean, woke: boolean, path?: string, state: import('./mail-store.js').SnailState }>}
   */
  async function saveOneMessage(msg) {
    ensureMailDir();
    let state = readState();
    if (state === null) {
      throw new Error('mailbox state is not initialized');
    }

    const existingPath = lookupExistingMessageFile(mailDir, msg.uidValidity, msg.uid, fsImpl);
    if (existingPath) {
      return { skipped: true, saved: false, woke: false, path: existingPath, state };
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
        saveTime: now(),
      },
      mailDir
    );

    const tmpPath = path.join(
      mailDir,
      `${built.filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    const finalPath = built.absolutePath;

    if (msg.beforeWrite && msg.beforeWrite() === false) {
      return { skipped: false, saved: false, woke: false, state };
    }

    try {
      fsImpl.writeFileSync(tmpPath, JSON.stringify(built.record, null, 2), { mode: 0o600 });
      fsImpl.renameSync(tmpPath, finalPath);
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
      return { skipped: false, saved: false, woke: false, state };
    }

    const isBacklog = msg.uid < state.notifyBoundary;

    if (isBacklog) {
      if (msg.uid > state.backlogUid) {
        state = updateState(state, { backlogUid: msg.uid });
      }
      return { skipped: false, saved: true, woke: false, path: finalPath, state };
    }

    let woke = false;
    if (msg.uid >= state.notifyBoundary) {
      await onWake({
        uid: msg.uid,
        path: finalPath,
        from: built.wakeFrom,
        subject: built.wakeSubject,
      });
      woke = true;
      if (msg.uid > state.lastUid) {
        state = updateState(state, { lastUid: msg.uid });
      }
    }

    return { skipped: false, saved: true, woke, path: finalPath, state };
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
