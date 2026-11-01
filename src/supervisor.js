'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createMailStore } = require('./mail-store.js');
const {
  createAccountSecretResolver,
  redactKnownSecrets,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} = require('./secrets.js');
const { OpenClawClient, notifyOpenClawWake } = require('./notifiers/openclaw.js');
const { buildWebhookBody, notifyWebhook } = require('./notifiers/webhook.js');
const { defaultSleeper } = require('./notifiers/retry.js');

const IDLE_KEEPALIVE_MS = 29 * 60 * 1000;
const CONNECT_INITIAL_BACKOFF_MS = INITIAL_BACKOFF_MS;

/**
 * @param {string | null | undefined} accountName
 * @param {string} message
 * @param {Iterable<string>} [secrets]
 */
function formatLogLine(accountName, message, secrets = []) {
  const ts = new Date().toISOString();
  const prefix = accountName ? `[snail] [${accountName}]` : `[snail]`;
  const body = redactKnownSecrets(message, secrets);
  return `${ts} ${prefix} ${body}`;
}

/**
 * @param {string} mailDir
 * @param {typeof fs} [fsImpl]
 */
function removeLeftoverTmpFiles(mailDir, fsImpl = fs) {
  if (!fsImpl.existsSync(mailDir)) return;
  let names;
  try {
    names = fsImpl.readdirSync(mailDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.includes('.tmp-')) {
      try {
        fsImpl.unlinkSync(path.join(mailDir, name));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {import('./mail-store.js').SnailState} state
 * @param {number} uidNext
 * @returns {number[]}
 */
function uidsToSync(state, uidNext) {
  const maxUid = uidNext - 1;
  if (maxUid < 1) return [];
  /** @type {number[]} */
  const uids = [];
  const seen = new Set();
  const push = (u) => {
    if (u < 1 || u > maxUid || seen.has(u)) return;
    seen.add(u);
    uids.push(u);
  };
  for (let u = state.backlogUid + 1; u < state.notifyBoundary; u++) {
    push(u);
  }
  const newStart = Math.max(state.lastUid + 1, state.notifyBoundary);
  for (let u = newStart; u <= maxUid; u++) {
    push(u);
  }
  uids.sort((a, b) => a - b);
  return uids;
}

/**
 * @param {import('./notifiers/openclaw.js').OpenClawClient} client
 * @param {(line: string) => void} log
 * @param {string} accountName
 */
function wrapOpenClawReconnect(client, log, accountName) {
  let allowReconnect = true;
  const origConnect = client.connect.bind(client);
  const origClose = client.close.bind(client);
  client.close = function wrappedClose() {
    allowReconnect = false;
    origClose();
  };
  client.connect = async function wrappedConnect() {
    const ws = await origConnect();
    if (client.ws && allowReconnect) {
      client.ws.once('close', () => {
        if (!allowReconnect) {
          return;
        }
        void origConnect().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(formatLogLine(accountName, `gateway reconnect failed: ${msg}`, [client.token]));
        });
      });
    }
    return ws;
  };
}

/**
 * @param {{
 *   account: import('./config.js').SnailAccount,
 *   secrets: ReturnType<typeof createAccountSecretResolver>,
 *   log: (line: string) => void,
 *   sleeper?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   idleKeepaliveMs?: number,
 *   imapFactory: (account: import('./config.js').SnailAccount, password: string) => import('./supervisor.js').SnailImapClient,
 *   fs?: typeof fs,
 *   fetchImpl?: typeof fetch,
 *   openclawWebSocketImpl?: typeof import('ws'),
 *   stopAfterSync?: boolean,
 *   stopSignal?: { stopped: boolean },
 * }} ctx
 */
async function runAccountLoop(ctx) {
  const account = ctx.account;
  const sleeper = ctx.sleeper ?? defaultSleeper;
  const now = ctx.now ?? (() => Date.now());
  const idleKeepaliveMs = ctx.idleKeepaliveMs ?? IDLE_KEEPALIVE_MS;
  const stopSignal = ctx.stopSignal ?? { stopped: false };

  const logSecrets = new Set();
  const log = (msg) => ctx.log(formatLogLine(account.name, msg, logSecrets));

  removeLeftoverTmpFiles(account.mail_dir);

  const password = await ctx.secrets.resolve(account.password);
  logSecrets.add(password);
  /** @type {string | undefined} */
  let notifierSecret;
  if (account.notifier === 'webhook') {
    notifierSecret = await ctx.secrets.resolve(account.webhook_secret);
    logSecrets.add(notifierSecret);
  } else {
    notifierSecret = await ctx.secrets.resolve(account.openclaw_token);
    logSecrets.add(notifierSecret);
  }

  /** @type {import('./notifiers/openclaw.js').OpenClawClient | null} */
  let openclawClient = null;
  if (account.notifier === 'openclaw') {
    openclawClient = new OpenClawClient({
      gatewayUrl: account.openclaw_url,
      token: notifierSecret,
      WebSocketImpl: ctx.openclawWebSocketImpl,
    });
    wrapOpenClawReconnect(openclawClient, (line) => ctx.log(line), account.name);
    try {
      await openclawClient.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`gateway connect failed: ${msg}`);
    }
  }

  const store = createMailStore({
    mailDir: account.mail_dir,
    textLimit: account.textLimit,
    htmlLimit: account.htmlLimit,
    attachmentLimit: account.attachmentLimit,
    accountName: account.name,
    fs: ctx.fs,
    log: (line) => ctx.log(line),
    onWake: async (wakeCtx) => {
      let result;
      if (account.notifier === 'webhook') {
        const recordPath = wakeCtx.path;
        let record;
        try {
          record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        } catch {
          record = {};
        }
        const payload = buildWebhookBody({
          account: account.name,
          from: wakeCtx.from,
          subject: wakeCtx.subject,
          date: record.date ?? new Date().toISOString(),
          message_id: record.message_id ?? '',
          path: recordPath,
          mailbox: account.mailbox,
          uid: wakeCtx.uid,
          uid_validity: record.uid_validity ?? store.readState()?.uidValidity ?? 0,
        });
        result = await notifyWebhook({
          webhookUrl: account.webhook_url,
          secret: notifierSecret,
          webhookAuth: account.webhook_auth,
          webhookHeader: account.webhook_header,
          payload,
          fetchImpl: ctx.fetchImpl,
          sleeper,
        });
      } else {
        result = await notifyOpenClawWake({
          client: openclawClient,
          from: wakeCtx.from,
          subject: wakeCtx.subject,
          path: wakeCtx.path,
          sleeper,
        });
      }
      const outcome = result.ok ? 'notify ok' : 'notify failed';
      log(`${outcome} uid ${wakeCtx.uid} attempts ${result.attempts}`);
      return result.ok ? 'ok' : 'failed';
    },
  });

  const imapClient = ctx.imapFactory(account, password);

  let connectBackoff = CONNECT_INITIAL_BACKOFF_MS;

  while (!stopSignal.stopped) {
    try {
      await imapClient.connect();
      connectBackoff = CONNECT_INITIAL_BACKOFF_MS;

      const mb = await imapClient.mailboxOpen(account.mailbox);
      const state = store.ensureMailboxState(mb.uidValidity, mb.uidNext);

      await syncMessages(imapClient, store, state, mb.uidNext);

      if (ctx.stopAfterSync || stopSignal.stopped) {
        break;
      }

      let idleEnteredAt = now();
      while (!stopSignal.stopped) {
        const idleResult = await raceIdle(
          imapClient,
          idleKeepaliveMs,
          idleEnteredAt,
          now,
          sleeper,
          stopSignal
        );
        if (stopSignal.stopped || idleResult === 'stop') {
          if (typeof imapClient.cancelIdle === 'function') {
            imapClient.cancelIdle();
          }
          break;
        }
        if (idleResult === 'keepalive') {
          if (typeof imapClient.cancelIdle === 'function') {
            imapClient.cancelIdle();
          }
          idleEnteredAt = now();
          continue;
        }
        if (idleResult === 'exists') {
          const mb2 = await imapClient.mailboxOpen(account.mailbox);
          let current = store.readState();
          if (current) {
            await syncMessages(imapClient, store, current, mb2.uidNext);
          }
          idleEnteredAt = now();
          continue;
        }
        break;
      }
    } catch (err) {
      if (stopSignal.stopped) break;
      const msg = err instanceof Error ? err.message : String(err);
      log(`imap disconnected: ${msg}`);
      await sleeper(connectBackoff);
      if (stopSignal.stopped) break;
      connectBackoff = Math.min(connectBackoff * 2, MAX_BACKOFF_MS);
    } finally {
      try {
        await imapClient.logout();
      } catch {
        /* ignore */
      }
    }
  }

  if (openclawClient) {
    openclawClient.close();
  }
}

/**
 * @param {import('./supervisor.js').SnailImapClient} client
 * @param {ReturnType<typeof createMailStore>} store
 * @param {import('./mail-store.js').SnailState} state
 * @param {number} uidNext
 */
async function syncMessages(client, store, state, uidNext) {
  let current = store.readState() ?? state;
  const uids = uidsToSync(current, uidNext);
  for (const uid of uids) {
    const msg = await client.fetchOne(uid);
    if (!msg) continue;
    await store.saveOneMessage({
      uid,
      uidValidity: current.uidValidity,
      messageId: msg.messageId,
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      envelopeDate: msg.envelopeDate,
      body: msg.body,
      htmlBody: msg.htmlBody,
      attachments: msg.attachments,
    });
    current = store.readState() ?? current;
  }
}

/**
 * @param {import('./supervisor.js').SnailImapClient} client
 * @param {number} idleKeepaliveMs
 * @param {number} idleEnteredAt
 * @param {() => number} now
 * @param {(ms: number) => Promise<void>} sleeper
 * @param {{ stopped: boolean }} [stopSignal]
 */
async function raceIdle(client, idleKeepaliveMs, idleEnteredAt, now, sleeper, stopSignal) {
  if (stopSignal?.stopped) {
    return 'stop';
  }
  const elapsed = now() - idleEnteredAt;
  const remaining = Math.max(0, idleKeepaliveMs - elapsed);
  const idlePromise = client.idle().then(() => 'exists');
  let stopInterval;
  const stopPromise = new Promise((resolve) => {
    if (stopSignal?.stopped) {
      resolve('stop');
      return;
    }
    stopInterval = setInterval(() => {
      if (stopSignal?.stopped) {
        clearInterval(stopInterval);
        resolve('stop');
      }
    }, 5);
  });
  try {
    if (remaining === 0) {
      return await Promise.race([stopPromise, Promise.resolve('keepalive')]);
    }
    const timerPromise = sleeper(remaining).then(() => 'keepalive');
    return await Promise.race([idlePromise, timerPromise, stopPromise]);
  } finally {
    if (stopInterval) {
      clearInterval(stopInterval);
    }
  }
}

/**
 * @param {{
 *   config: { accounts: import('./config.js').SnailAccount[], text_limit?: number, html_limit?: number, attachment_limit?: number },
 *   log?: (line: string) => void,
 *   sleeper?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   idleKeepaliveMs?: number,
 *   imapFactory: (account: import('./config.js').SnailAccount, password: string) => import('./supervisor.js').SnailImapClient,
 *   secretResolverFactory?: (account: import('./config.js').SnailAccount) => ReturnType<typeof createAccountSecretResolver>,
 *   fetchImpl?: typeof fetch,
 *   openclawWebSocketImpl?: typeof import('ws'),
 *   platform?: string,
 * }} options
 */
async function startSupervisor(options) {
  if (typeof options.imapFactory !== 'function') {
    throw new Error('imapFactory is required');
  }
  const log = options.log ?? (() => {});
  const stopSignal = { stopped: false };
  /** @type {Promise<void>[]} */
  const loops = [];

  for (const account of options.config.accounts) {
    const secrets =
      options.secretResolverFactory?.(account) ??
      createAccountSecretResolver({
        platform: options.platform,
        log: (line) => log(formatLogLine(account.name, line)),
        sleeper: options.sleeper,
      });

    loops.push(
      runAccountLoop({
        account,
        secrets,
        log,
        sleeper: options.sleeper,
        now: options.now,
        idleKeepaliveMs: options.idleKeepaliveMs,
        imapFactory: options.imapFactory,
        fs: options.fsFactory?.(account),
        fetchImpl: options.fetchImpl,
        openclawWebSocketImpl: options.openclawWebSocketImpl,
        stopSignal,
      })
    );
  }

  const all = Promise.all(loops);
  return {
    stop() {
      stopSignal.stopped = true;
    },
    done: all,
  };
}

/**
 * @param {Partial<import('./supervisor.js').FakeImapOptions>} [options]
 */
function createFakeImapClient(options = {}) {
  const emitter = new EventEmitter();
  let connected = false;
  let idleResolve = null;
  const messages = new Map(Object.entries(options.messages ?? {}).map(([k, v]) => [Number(k), v]));
  let uidValidity = options.uidValidity ?? 1;
  let uidNext = options.uidNext ?? 100;
  const connectDelayMs = options.connectDelayMs ?? 0;
  let connectAttempts = 0;
  const hangConnect = options.hangConnect ?? false;
  const isStopped = options.isStopped ?? (() => false);

  return {
    id: options.id ?? 'fake-imap',
    get uidValidity() {
      return uidValidity;
    },
    get uidNext() {
      return uidNext;
    },
    setUidNext(n) {
      uidNext = n;
    },
    setUidValidity(v) {
      uidValidity = v;
    },
    addMessage(uid, msg) {
      messages.set(uid, msg);
      if (uid >= uidNext) uidNext = uid + 1;
    },
    async connect() {
      connectAttempts += 1;
      if (options.connectFailUntil != null && connectAttempts <= options.connectFailUntil) {
        throw new Error('connect failed');
      }
      if (hangConnect) {
        while (!isStopped()) {
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error('connect stopped');
      }
      if (connectDelayMs > 0 && options.sleeper) {
        await options.sleeper(connectDelayMs);
      }
      connected = true;
    },
    async mailboxOpen(_mailbox) {
      if (!connected) throw new Error('not connected');
      return { uidValidity, uidNext, exists: messages.size };
    },
    async fetchOne(uid) {
      return messages.get(uid) ?? null;
    },
    async idle() {
      return new Promise((resolve) => {
        idleResolve = resolve;
      });
    },
    cancelIdle() {
      if (idleResolve) {
        const r = idleResolve;
        idleResolve = null;
        r();
      }
    },
    triggerExists() {
      if (idleResolve) {
        const r = idleResolve;
        idleResolve = null;
        r();
      }
    },
    async logout() {
      connected = false;
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
  };
}

module.exports = {
  IDLE_KEEPALIVE_MS,
  formatLogLine,
  removeLeftoverTmpFiles,
  uidsToSync,
  runAccountLoop,
  startSupervisor,
  createFakeImapClient,
  syncMessages,
  raceIdle,
};

/**
 * @typedef {{
 *   id?: string,
 *   uidValidity?: number,
 *   uidNext?: number,
 *   messages?: Record<number, import('./supervisor.js').FakeImapMessage>,
 *   connectDelayMs?: number,
 *   connectFailUntil?: number,
 *   hangConnect?: boolean,
 *   sleeper?: (ms: number) => Promise<void>,
 * }} FakeImapOptions
 */

/**
 * @typedef {{
 *   messageId?: string,
 *   from?: { name?: string, address?: string }[],
 *   to?: { name?: string, address?: string }[],
 *   subject?: string,
 *   envelopeDate?: Date | null,
 *   body?: string,
 *   htmlBody?: string,
 *   attachments?: { filename?: string, contentType?: string, content?: Buffer }[],
 * }} FakeImapMessage
 */

/**
 * @typedef {{
 *   id?: string,
 *   connect(): Promise<void>,
 *   mailboxOpen(mailbox: string): Promise<{ uidValidity: number, uidNext: number, exists?: number }>,
 *   fetchOne(uid: number): Promise<FakeImapMessage | null>,
 *   idle(): Promise<void>,
 *   logout(): Promise<void>,
 *   on?(event: string, handler: (...args: unknown[]) => void): void,
 * }} SnailImapClient
 */
