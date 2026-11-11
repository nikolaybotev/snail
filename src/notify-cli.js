'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSnailConfig } = require('./config.js');
const { readSnailState } = require('./mail-store.js');
const {
  readNotifyLedger,
  writeRedeliverRequest,
  parseMessageBasename,
  buildNotifyId,
} = require('./notify-ledger.js');

/**
 * @param {import('./config.js').SnailConfig} config
 */
function runNotifyList(config) {
  /** @type {import('./notify-ledger.js').NotifyLedgerItem[]} */
  const rows = [];
  let unreadable = false;
  for (const account of config.accounts) {
    let items;
    try {
      items = readNotifyLedger(account.mail_dir);
    } catch {
      console.error(`notify ledger unreadable account ${account.name}`);
      unreadable = true;
      continue;
    }
    for (const row of items) {
      rows.push(row);
    }
  }
  rows.sort((a, b) => {
    if (a.account !== b.account) return a.account.localeCompare(b.account);
    if (a.uid_validity !== b.uid_validity) return a.uid_validity - b.uid_validity;
    return a.uid - b.uid;
  });
  for (const row of rows) {
    const state = row.attempts === 0 ? 'pending' : 'failed';
    const lastStatus = row.last_status === 'none' && row.attempts === 0 ? 'none' : row.last_status;
    console.log(
      `account ${row.account} uid ${row.uid} uid_validity ${row.uid_validity} file ${row.file} state ${state} attempts ${row.attempts} last_status ${lastStatus} next_attempt ${row.next_attempt_at}`
    );
  }
  if (unreadable) {
    process.exit(2);
  }
  process.exit(rows.length > 0 ? 1 : 0);
}

/**
 * @param {import('./config.js').SnailConfig} config
 * @param {{ account?: string, uid?: number, file?: string }} opts
 */
function runNotifyRedeliver(config, opts) {
  if (opts.file && (opts.file.includes('/') || opts.file.includes('..'))) {
    console.error('notify redeliver refused: invalid');
    process.exit(2);
  }
  const account = config.accounts.find((a) => a.name === opts.account);
  if (!account) {
    console.error('notify redeliver refused: account');
    process.exit(2);
  }
  const intake = readSnailState(account.mail_dir);
  if (!intake) {
    console.error('notify redeliver refused: state');
    process.exit(2);
  }

  let basename = opts.file;
  let parsed = basename ? parseMessageBasename(basename) : null;
  if (!basename && opts.uid != null) {
    const suffix = `_${intake.uidValidity}_${String(opts.uid).padStart(10, '0')}.json`;
    let names;
    try {
      names = fs.readdirSync(account.mail_dir).filter((n) => n.endsWith(suffix));
    } catch {
      console.error('notify redeliver refused: missing');
      process.exit(2);
    }
    if (names.length > 1) {
      console.error('notify redeliver refused: ambiguous');
      process.exit(2);
    }
    if (names.length === 0) {
      console.error('notify redeliver refused: missing');
      process.exit(2);
    }
    basename = names[0];
    parsed = parseMessageBasename(basename);
  }
  if (!basename || !parsed) {
    console.error('notify redeliver refused: missing');
    process.exit(2);
  }
  const filePath = path.join(account.mail_dir, basename);
  if (!fs.existsSync(filePath)) {
    console.error('notify redeliver refused: missing');
    process.exit(2);
  }
  if (parsed.uid < intake.notifyBoundary) {
    console.error('notify redeliver refused: backlog');
    process.exit(2);
  }
  if (parsed.uidValidity !== intake.uidValidity) {
    const notifyId = buildNotifyId(account.name, parsed.uidValidity, parsed.uid);
    let items;
    try {
      items = readNotifyLedger(account.mail_dir);
    } catch {
      console.error('notify redeliver refused: resync');
      process.exit(2);
    }
    if (!items.some((r) => r.notify_id === notifyId)) {
      console.error('notify redeliver refused: resync');
      process.exit(2);
    }
  }

  writeRedeliverRequest(account.mail_dir, basename);
  console.log(
    `notify redeliver queued account ${account.name} uid ${parsed.uid} file ${basename}`
  );
  process.exit(0);
}

/**
 * @param {string} configPath
 * @param {'notify-list' | 'notify-redeliver'} command
 * @param {{ account?: string, uid?: number, file?: string }} opts
 */
function runNotifyCommand(configPath, command, opts) {
  const loaded = loadSnailConfig(configPath);
  if (!loaded.ok) {
    console.error(loaded.message);
    process.exit(loaded.exitCode);
  }
  if (command === 'notify-list') {
    runNotifyList(loaded.config);
    return;
  }
  if (command === 'notify-redeliver') {
    if (!opts.account) {
      console.error('usage: snail notify-redeliver --config /abs/config.toml --account NAME (--uid UID | --file FILE)');
      process.exit(2);
    }
    if (opts.uid == null && !opts.file) {
      console.error('usage: snail notify-redeliver --config /abs/config.toml --account NAME (--uid UID | --file FILE)');
      process.exit(2);
    }
    runNotifyRedeliver(loaded.config, opts);
  }
}

module.exports = {
  runNotifyList,
  runNotifyRedeliver,
  runNotifyCommand,
};
