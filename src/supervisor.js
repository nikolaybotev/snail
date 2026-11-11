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
const { OpenClawClient } = require('./notifiers/openclaw.js');
const { defaultSleeper } = require('./notifiers/retry.js');
const { createNotifyDelivery, REQUEST_POLL_MS } = require('./notify-delivery.js');
const { hasRedeliverRequestFiles } = require('./notify-ledger.js');

const IDLE_KEEPALIVE_MS = 29 * 60 * 1000;
const CONNECT_INITIAL_BACKOFF_MS = INITIAL_BACKOFF_MS;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceImapInteger(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error('IMAP integer is not a safe integer');
    }
    return n;
  }
  return value;
}

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
 *   reloadState?: import('./supervisor.js').AccountReloadState,
 *   stopAfterSync?: boolean,
 *   globalStop?: { stopped: boolean },
 * }} ctx
 * @returns {Promise<import('./supervisor.js').AccountLoopResult>}
 */
async function runAccountLoop(ctx) {
  const account = ctx.account;
  const sleeper = ctx.sleeper ?? defaultSleeper;
  const now = ctx.now ?? (() => Date.now());
  const idleKeepaliveMs = ctx.idleKeepaliveMs ?? IDLE_KEEPALIVE_MS;
  const stopSignal = ctx.stopSignal ?? { stopped: false };
  const reloadState = ctx.reloadState ?? null;
  const renameInProgress = { value: false };

  const reloadHooks = () => ({
    shouldAbortBeforeUid: () => {
      if (reloadState?.pending && renameInProgress.value) {
        return false;
      }
      if (stopSignal.stopped) {
        return true;
      }
      if (reloadState?.pending) {
        return true;
      }
      return false;
    },
    renameInProgress,
  });

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

  const delivery = createNotifyDelivery({
    account,
    notifierSecret,
    openclawClient,
    log,
    fetchImpl: ctx.fetchImpl,
    sleeper,
    now,
    fs: ctx.fs,
  });

  if (delivery.outstandingCount() > 0) {
    delivery.logOutstandingCount();
  }
  await delivery.applyRedeliverRequests();
  await delivery.runDueTurn();

  const store = createMailStore({
    mailDir: account.mail_dir,
    textLimit: account.textLimit,
    htmlLimit: account.htmlLimit,
    attachmentLimit: account.attachmentLimit,
    accountName: account.name,
    mailbox: account.mailbox,
    accountLog: log,
    fs: ctx.fs,
    log: (line) => ctx.log(line),
    now,
  });

  const imapClient = ctx.imapFactory(account, password);
  if (typeof imapClient.setLog === 'function') {
    imapClient.setLog(log);
  }

  let connectBackoff = CONNECT_INITIAL_BACKOFF_MS;

  while (!stopSignal.stopped) {
    try {
      await imapClient.connect();
      connectBackoff = CONNECT_INITIAL_BACKOFF_MS;

      const mb = await imapClient.mailboxOpen(account.mailbox);
      const uidValidity = coerceImapInteger(mb.uidValidity);
      const uidNext = coerceImapInteger(mb.uidNext);
      const state = store.ensureMailboxState(
        /** @type {number} */ (uidValidity),
        /** @type {number} */ (uidNext),
      );

      await syncMessages(
        imapClient,
        store,
        state,
        /** @type {number} */ (uidNext),
        reloadHooks(),
        log,
        account.mailbox,
        delivery,
      );

      if (ctx.stopAfterSync) {
        while (
          !stopSignal.stopped &&
          !ctx.globalStop?.stopped &&
          !reloadState?.pending
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        stopSignal.stopped = true;
        break;
      }

      if (stopSignal.stopped) {
        break;
      }

      if (reloadState?.pending && !renameInProgress.value) {
        break;
      }

      let idleEnteredAt = now();
      while (!stopSignal.stopped) {
        let deliveryMs = delivery.msUntilDelivery();
        if (deliveryMs === 0) {
          await delivery.applyRedeliverRequests();
          await delivery.runDueTurn();
          deliveryMs = delivery.msUntilDelivery();
        }
        const idleResult = await raceIdle(
          imapClient,
          idleKeepaliveMs,
          idleEnteredAt,
          now,
          sleeper,
          stopSignal,
          {
            pollMs: REQUEST_POLL_MS,
            deliveryMs,
            mailDir: account.mail_dir,
            fs: ctx.fs ?? fs,
          }
        );
        if (stopSignal.stopped || idleResult === 'stop') {
          if (typeof imapClient.cancelIdle === 'function') {
            imapClient.cancelIdle();
          }
          break;
        }
        if (idleResult === 'poll' || idleResult === 'delivery') {
          if (typeof imapClient.cancelIdle === 'function') {
            imapClient.cancelIdle();
          }
          await delivery.applyRedeliverRequests();
          await delivery.runDueTurn();
          idleEnteredAt = now();
          continue;
        }
        if (idleResult === 'keepalive') {
          if (typeof imapClient.cancelIdle === 'function') {
            imapClient.cancelIdle();
          }
          if (delivery.outstandingCount() > 0) {
            delivery.logOutstandingCount();
          }
          await delivery.applyRedeliverRequests();
          await delivery.runDueTurn();
          idleEnteredAt = now();
          continue;
        }
        if (idleResult === 'exists') {
          if (stopSignal.stopped) {
            break;
          }
          const mb2 = await imapClient.mailboxOpen(account.mailbox);
          const uidNextAfterExists = coerceImapInteger(mb2.uidNext);
          let current = store.readState();
          if (current) {
            await syncMessages(
              imapClient,
              store,
              current,
              /** @type {number} */ (uidNextAfterExists),
              reloadHooks(),
              log,
              account.mailbox,
              delivery,
            );
          }
          if (reloadState?.pending && !renameInProgress.value) {
            break;
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

  if (reloadState?.pending?.kind === 'remove') {
    reloadState.pending = null;
    return { action: 'removed' };
  }
  if (reloadState?.pending?.kind === 'change') {
    const nextAccount = reloadState.pending.account;
    reloadState.pending = null;
    return { action: 'changed', nextAccount };
  }
  return { action: 'stopped' };
}

/**
 * @param {import('./supervisor.js').SnailImapClient} client
 * @param {ReturnType<typeof createMailStore>} store
 * @param {import('./mail-store.js').SnailState} state
 * @param {number} uidNext
 * @param {{
 *   shouldAbortBeforeUid?: () => boolean,
 *   renameInProgress?: { value: boolean },
 * }} [reload]
 */
async function syncMessages(client, store, state, uidNext, reload, logFn, mailbox, delivery) {
  let current = store.readState() ?? state;
  const uids = uidsToSync(current, uidNext);
  const encMailbox = encodeURIComponent(mailbox);
  for (const uid of uids) {
    if (reload?.shouldAbortBeforeUid?.()) {
      break;
    }
    if (logFn) {
      logFn(`fetch start mailbox ${encMailbox} uid ${uid}`);
    }
    const msg = await client.fetchOne(uid);
    if (logFn) {
      logFn(`fetch end mailbox ${encMailbox} uid ${uid}`);
    }
    if (!msg) continue;
    const saveResult = await store.saveOneMessage({
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
      beforeWrite: () => !(reload?.shouldAbortBeforeUid?.()),
      onRenamed: () => {
        if (reload?.renameInProgress) reload.renameInProgress.value = true;
      },
    });
    if (
      saveResult.attemptNotify &&
      delivery &&
      saveResult.path &&
      saveResult.uid != null &&
      saveResult.filename
    ) {
      await delivery.attemptAfterSave({
        uid: saveResult.uid,
        path: saveResult.path,
        from: saveResult.wakeFrom ?? 'unknown',
        subject: saveResult.wakeSubject ?? '(no subject)',
        filename: saveResult.filename,
      });
    }
    if (reload?.renameInProgress) {
      reload.renameInProgress.value = false;
    }
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
async function raceIdle(client, idleKeepaliveMs, idleEnteredAt, now, sleeper, stopSignal, extra) {
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
  /** @type {Promise<string>[]} */
  const timerPromises = [];
  if (remaining === 0) {
    timerPromises.push(Promise.resolve('keepalive'));
  } else {
    timerPromises.push(sleeper(remaining).then(() => 'keepalive'));
  }
  if (extra?.pollMs != null && extra.pollMs > 0 && extra.mailDir) {
    const pollFs = extra.fs ?? fs;
    timerPromises.push(
      (async () => {
        while (true) {
          await sleeper(extra.pollMs);
          if (hasRedeliverRequestFiles(extra.mailDir, pollFs)) {
            return 'poll';
          }
        }
      })()
    );
  }
  if (extra?.deliveryMs != null && extra.deliveryMs > 0) {
    timerPromises.push(sleeper(extra.deliveryMs).then(() => 'delivery'));
  }
  try {
    const result = await Promise.race([idlePromise, stopPromise, ...timerPromises]);
    if (
      result === 'keepalive' ||
      result === 'stop' ||
      result === 'poll' ||
      result === 'delivery'
    ) {
      if (typeof client.cancelIdle === 'function') {
        await client.cancelIdle();
      }
    }
    return result;
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
 *   fsFactory?: (account: import('./config.js').SnailAccount) => typeof fs,
 *   configPath?: string,
 *   enableReload?: boolean,
 *   stopAfterSync?: boolean,
 *   fsWatch?: typeof import('./config-watch.js').startConfigWatch,
 *   rereadConfig?: typeof import('./config-reload.js').rereadSnailConfig,
 *   decideReload?: typeof import('./config-reload.js').decideConfigReload,
 * }} options
 */
async function startSupervisor(options) {
  if (typeof options.imapFactory !== 'function') {
    throw new Error('imapFactory is required');
  }
  const log = options.log ?? (() => {});
  const globalStop = { stopped: false };

  /** @type {Map<string, import('./supervisor.js').AccountRunner>} */
  const runners = new Map();

  /** @type {import('./config.js').SnailConfig} */
  let liveConfig = options.config;

  /** @type {Set<string>} */
  const knownSecrets = new Set();

  function collectInlineSecrets(config) {
    for (const acct of config.accounts) {
      for (const field of [acct.password, acct.webhook_secret, acct.openclaw_token]) {
        if (typeof field === 'string' && field.length > 0 && !field.startsWith('keychain://') && !field.startsWith('op://')) {
          knownSecrets.add(field);
        }
      }
    }
  }
  collectInlineSecrets(liveConfig);

  /**
   * @param {import('./config.js').SnailAccount} account
   */
  function createRunner(account) {
    const stopSignal = { stopped: false };
    /** @type {import('./supervisor.js').AccountReloadState} */
    const reloadState = { pending: null };
    const runner = {
      account,
      stopSignal,
      reloadState,
      loopPromise: null,
      imapClient: null,
    };
    runners.set(account.name, runner);
    return runner;
  }

  /** @type {Promise<void>[]} */
  const loopPromises = [];

  /**
   * @param {import('./config.js').SnailAccount} account
   */
  function startAccountRunner(account) {
    let runner = runners.get(account.name);
    if (!runner) {
      runner = createRunner(account);
    } else {
      runner.account = account;
    }

    const runWorker = async () => {
      let currentAccount = account;
      while (!globalStop.stopped) {
        const secrets =
          options.secretResolverFactory?.(currentAccount) ??
          createAccountSecretResolver({
            platform: options.platform,
            log: (line) => log(formatLogLine(currentAccount.name, line)),
            sleeper: options.sleeper,
          });

        runner.reloadState.pending = null;
        runner.stopSignal.stopped = false;

        const result = await runAccountLoop({
          account: currentAccount,
          secrets,
          log,
          sleeper: options.sleeper,
          now: options.now,
          idleKeepaliveMs: options.idleKeepaliveMs,
          imapFactory: (acct, password) => {
            const client = options.imapFactory(acct, password);
            runner.imapClient = client;
            return client;
          },
          fs: options.fsFactory?.(currentAccount),
          fetchImpl: options.fetchImpl,
          openclawWebSocketImpl: options.openclawWebSocketImpl,
          stopSignal: runner.stopSignal,
          reloadState: runner.reloadState,
          stopAfterSync: options.stopAfterSync,
          globalStop,
        });

        runner.imapClient = null;

        if (result.action === 'removed') {
          runners.delete(currentAccount.name);
          break;
        }
        if (result.action === 'changed' && result.nextAccount) {
          currentAccount = result.nextAccount;
          runner.account = currentAccount;
          collectInlineSecrets({
            accounts: [currentAccount],
            textLimit: liveConfig.textLimit,
            htmlLimit: liveConfig.htmlLimit,
            attachmentLimit: liveConfig.attachmentLimit,
          });
          continue;
        }
        break;
      }
    };

    runner.loopPromise = runWorker();
    loopPromises.push(runner.loopPromise);
    return runner.loopPromise;
  }

  for (const account of liveConfig.accounts) {
    startAccountRunner(account);
  }

  const rereadConfigFn = options.rereadConfig ?? require('./config-reload.js').rereadSnailConfig;
  const decideReloadFn = options.decideReload ?? require('./config-reload.js').decideConfigReload;
  const startWatchFn = options.fsWatch ?? require('./config-watch.js').startConfigWatch;

  /** @type {ReturnType<typeof startWatchFn> | null} */
  let watchHandle = null;

  /**
   * @param {string | null} _filename
   */
  function handleConfigEvent(_filename) {
    if (globalStop.stopped || !options.configPath) return;
    const loadResult = rereadConfigFn(options.configPath);
    const decision = decideReloadFn(liveConfig, loadResult, knownSecrets);
    if (decision.kind === 'keepAndLog') {
      log(`${new Date().toISOString()} [snail] ${decision.logLine}`);
      return;
    }
    if (decision.kind === 'unchanged') {
      return;
    }

    log(`${new Date().toISOString()} [snail] config reloaded`);

    liveConfig = decision.config;
    collectInlineSecrets(liveConfig);

    for (const name of decision.diff.removed) {
      const runner = runners.get(name);
      if (runner) {
        runner.reloadState.pending = { kind: 'remove' };
        runner.stopSignal.stopped = true;
        if (typeof runner.imapClient?.cancelIdle === 'function') {
          runner.imapClient.cancelIdle();
        }
      }
    }
    for (const { name, account: nextAccount } of decision.diff.changed) {
      const runner = runners.get(name);
      if (runner) {
        runner.reloadState.pending = { kind: 'change', account: nextAccount };
        runner.stopSignal.stopped = true;
        if (typeof runner.imapClient?.cancelIdle === 'function') {
          runner.imapClient.cancelIdle();
        }
      }
    }
    for (const acct of decision.diff.added) {
      startAccountRunner(acct);
    }
  }

  if (options.enableReload !== false && options.configPath) {
    watchHandle = startWatchFn({
      configPath: options.configPath,
      onEvent: handleConfigEvent,
      log,
    });
    watchHandle.reloadNow();
  }

  return {
    stop() {
      globalStop.stopped = true;
      for (const runner of runners.values()) {
        runner.stopSignal.stopped = true;
        if (typeof runner.imapClient?.cancelIdle === 'function') {
          runner.imapClient.cancelIdle();
        }
      }
      watchHandle?.close();
    },
    async stopAndWait() {
      this.stop();
      await Promise.all(loopPromises);
    },
    waitForDone() {
      return Promise.all(loopPromises);
    },
    done: Promise.all(loopPromises),
    reloadNow() {
      handleConfigEvent(null);
    },
    getRunners: () => runners,
    getLiveConfig: () => liveConfig,
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
  const hangLogout = options.hangLogout ?? false;
  const isStopped = options.isStopped ?? (() => false);
  /** @type {(() => void) | null} */
  let releaseLogout = null;

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
      if (hangLogout) {
        await new Promise((resolve) => {
          releaseLogout = resolve;
        });
      }
      connected = false;
    },
    releaseLogout() {
      if (releaseLogout) {
        const r = releaseLogout;
        releaseLogout = null;
        r();
      }
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
  };
}

module.exports = {
  IDLE_KEEPALIVE_MS,
  coerceImapInteger,
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
 * @typedef {{ pending: null | { kind: 'remove' } | { kind: 'change', account: import('./config.js').SnailAccount } }} AccountReloadState
 */

/**
 * @typedef {{ action: 'stopped' | 'removed' | 'changed', nextAccount?: import('./config.js').SnailAccount }} AccountLoopResult
 */

/**
 * @typedef {{
 *   account: import('./config.js').SnailAccount,
 *   stopSignal: { stopped: boolean },
 *   reloadState: AccountReloadState,
 *   loopPromise: Promise<void> | null,
 *   imapClient: import('./supervisor.js').SnailImapClient | null,
 * }} AccountRunner
 */

/**
 * @typedef {{
 *   id?: string,
 *   uidValidity?: number,
 *   uidNext?: number,
 *   messages?: Record<number, import('./supervisor.js').FakeImapMessage>,
 *   connectDelayMs?: number,
 *   connectFailUntil?: number,
 *   hangConnect?: boolean,
 *   hangLogout?: boolean,
 *   sleeper?: (ms: number) => Promise<void>,
 *   isStopped?: () => boolean,
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
