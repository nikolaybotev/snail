#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { simpleParser } = require('mailparser');

/** imapflow socket inactivity default is 5 minutes; refresh IDLE one minute earlier. */
const IDLE_REFRESH_MS = 4 * 60 * 1000;

const { USAGE, loadSnailConfig } = require('./src/config.js');
const { startSupervisor, coerceImapInteger } = require('./src/supervisor.js');
const { runNotifyCommand } = require('./src/notify-cli.js');

const NODE_MAJOR_REQUIRED = 26;

/**
 * @param {string[]} argv
 */
function parseCli(argv) {
  const args = argv.slice(2);
  if (args[0] === 'notify-list' || args[0] === 'notify-redeliver') {
    const command = args[0];
    let configPath = null;
    /** @type {{ account?: string, uid?: number, file?: string }} */
    const opts = {};
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--config') {
        configPath = args[i + 1];
        i += 1;
        continue;
      }
      if (arg === '--account') {
        opts.account = args[i + 1];
        i += 1;
        continue;
      }
      if (arg === '--uid') {
        opts.uid = Number.parseInt(args[i + 1], 10);
        i += 1;
        continue;
      }
      if (arg === '--file') {
        opts.file = args[i + 1];
        i += 1;
        continue;
      }
      return { kind: 'usage' };
    }
    if (!configPath || !path.isAbsolute(configPath)) {
      return { kind: 'usage' };
    }
    return { kind: command, configPath, opts };
  }

  let configPath = null;
  let showVersion = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--version') {
      showVersion = true;
      if (args[i + 1] === '--verbose') {
        verbose = true;
        i += 1;
      }
      continue;
    }
    if (arg === '--config') {
      configPath = args[i + 1];
      i += 1;
      continue;
    }
    return { kind: 'usage' };
  }

  if (showVersion) {
    return { kind: 'version', verbose };
  }
  if (!configPath) {
    return { kind: 'usage' };
  }
  return { kind: 'run', configPath };
}

function readBuildStamp() {
  const stampPath = path.join(__dirname, 'build-stamp.json');
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {boolean} verbose
 */
function printVersion(verbose) {
  const stamp = readBuildStamp();
  if (!stamp) {
    console.error('snail: build stamp missing');
    process.exit(1);
  }
  const shortSha = String(stamp.commitSHA).slice(0, 12);
  if (verbose) {
    console.log(
      `snail ${stamp.version} (${stamp.commitSHA}) built ${stamp.buildTimestamp}`
    );
  } else {
    console.log(`snail ${stamp.version} (${shortSha})`);
  }
  process.exit(0);
}

function requireNodeMajor() {
  const major = Number.parseInt(process.version.slice(1).split('.')[0], 10);
  if (major !== NODE_MAJOR_REQUIRED) {
    console.error(`snail: requires Node.js ${NODE_MAJOR_REQUIRED}`);
    process.exit(1);
  }
}

/**
 * @param {string} configPath
 */
function assertCleanArgv(configPath) {
  const scriptPath = path.resolve(__filename);
  const expected = [
    process.execPath,
    scriptPath,
    '--config',
    path.resolve(configPath),
  ];
  if (process.argv.length !== expected.length) {
    console.error(USAGE);
    process.exit(2);
  }
  for (let i = 0; i < expected.length; i++) {
    if (process.argv[i] !== expected[i]) {
      console.error(USAGE);
      process.exit(2);
    }
  }
}

/**
 * @param {import('./src/config.js').SnailConfig['accounts'][0]} account
 * @param {string} password
 * @param {{ maxIdleTime?: number | false, socketTimeout?: number }} [imapOverrides]
 */
function createImapFlowClient(account, password, imapOverrides) {
  /** @type {import('imapflow').ImapFlow | null} */
  let client = null;
  /** @type {{ cleanup: () => void, reject: (err: Error) => void, cancelled: boolean } | null} */
  let activeIdleWait = null;
  /** @type {((msg: string) => void) | null} */
  let accountLog = null;

  return {
    id: `imapflow-${account.name}`,
    setLog(fn) {
      accountLog = fn;
    },
    async connect() {
      const { ImapFlow } = require('imapflow');
      /** @type {import('imapflow').ImapFlowOptions} */
      const flowOptions = {
        host: account.host,
        port: account.port,
        secure: account.tls === 'on',
        disableAutoIdle: true,
        maxIdleTime: IDLE_REFRESH_MS,
        auth: { user: account.user, pass: password },
        logger: false,
      };
      if (imapOverrides) {
        if (Object.prototype.hasOwnProperty.call(imapOverrides, 'maxIdleTime')) {
          flowOptions.maxIdleTime = imapOverrides.maxIdleTime;
        }
        if (Object.prototype.hasOwnProperty.call(imapOverrides, 'socketTimeout')) {
          flowOptions.socketTimeout = imapOverrides.socketTimeout;
        }
      }
      client = new ImapFlow(flowOptions);
      client.on('error', () => {});
      await client.connect();
    },
    async mailboxOpen(mailbox) {
      if (!client) throw new Error('not connected');
      const box = await client.mailboxOpen(mailbox);
      return {
        uidValidity: coerceImapInteger(box.uidValidity),
        uidNext: coerceImapInteger(box.uidNext),
      };
    },
    async fetchOne(uid) {
      if (!client) throw new Error('not connected');
      const msg = await client.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      if (!msg) return null;
      let body = '';
      let htmlBody;
      /** @type {{ filename?: string, contentType?: string, content?: Buffer }[]} */
      let attachments = [];
      if (msg.source) {
        const parsed = await simpleParser(msg.source);
        body = parsed.text || '';
        htmlBody = parsed.html || undefined;
        attachments = (parsed.attachments || []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content,
        }));
      }
      return {
        messageId: msg.envelope?.messageId,
        from: msg.envelope?.from,
        to: msg.envelope?.to,
        subject: msg.envelope?.subject,
        envelopeDate: msg.envelope?.date ?? null,
        body,
        htmlBody,
        attachments,
      };
    },
    async idle() {
      if (!client) throw new Error('not connected');
      if (activeIdleWait) {
        await this.cancelIdle();
      }
      return new Promise((resolve, reject) => {
        /** @type {{ cleanup: () => void, reject: (err: Error) => void, cancelled: boolean }} */
        const wait = {
          cancelled: false,
          cleanup: () => {},
          reject,
        };
        const onExists = (event) => {
          if (wait.cancelled) return;
          if (accountLog) {
            try {
              let line = `exists mailbox ${encodeURIComponent(account.mailbox)}`;
              if (event !== null && event !== undefined && typeof event === 'object') {
                if (Object.prototype.hasOwnProperty.call(event, 'path')) {
                  line += ` path ${encodeURIComponent(event.path)}`;
                }
                if (Object.prototype.hasOwnProperty.call(event, 'count')) {
                  line += ` count ${event.count}`;
                }
                if (Object.prototype.hasOwnProperty.call(event, 'prevCount')) {
                  line += ` prevCount ${event.prevCount}`;
                }
              }
              accountLog(line);
            } catch {
              /* log failure must not block resolve */
            }
          }
          wait.cleanup();
          activeIdleWait = null;
          resolve();
        };
        const onClose = () => {
          if (wait.cancelled) return;
          wait.cleanup();
          activeIdleWait = null;
          reject(new Error('IMAP connection closed'));
        };
        const onError = (err) => {
          if (wait.cancelled) return;
          wait.cleanup();
          activeIdleWait = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        wait.cleanup = () => {
          client.off('exists', onExists);
          client.off('close', onClose);
          client.off('error', onError);
        };
        client.once('exists', onExists);
        client.once('close', onClose);
        client.once('error', onError);
        activeIdleWait = wait;
        client.idle().catch((err) => {
          if (wait.cancelled) return;
          wait.cleanup();
          activeIdleWait = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
    async cancelIdle() {
      if (!activeIdleWait || activeIdleWait.cancelled) {
        return;
      }
      activeIdleWait.cancelled = true;
      activeIdleWait.cleanup();
      const reject = activeIdleWait.reject;
      activeIdleWait = null;
      try {
        if (client && typeof client.preCheck === 'function') {
          await client.preCheck();
        }
      } catch {
        /* ignore */
      }
      reject(new Error('idle cancelled'));
    },
    async logout() {
      try {
        await client?.logout();
      } catch {
        /* ignore */
      }
      client = null;
    },
  };
}

async function main() {
  const cli = parseCli(process.argv);

  if (cli.kind === 'version') {
    printVersion(cli.verbose);
    return;
  }

  if (cli.kind === 'usage') {
    console.error(USAGE);
    process.exit(2);
  }

  if (cli.kind === 'notify-list' || cli.kind === 'notify-redeliver') {
    requireNodeMajor();
    runNotifyCommand(path.resolve(cli.configPath), cli.kind, cli.opts);
    return;
  }

  requireNodeMajor();
  assertCleanArgv(cli.configPath);

  const configPath = path.resolve(cli.configPath);
  const loaded = loadSnailConfig(configPath);
  if (!loaded.ok) {
    console.error(loaded.message);
    process.exit(loaded.exitCode);
  }

  const log = (line) => {
    console.log(line);
  };

  log(`${new Date().toISOString()} [snail] starting`);

  await startSupervisor({
    config: loaded.config,
    configPath,
    log,
    imapFactory: (account, password) => createImapFlowClient(account, password),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${new Date().toISOString()} [snail] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseCli,
  readBuildStamp,
  printVersion,
  requireNodeMajor,
  assertCleanArgv,
  createImapFlowClient,
  IDLE_REFRESH_MS,
  NODE_MAJOR_REQUIRED,
};
