'use strict';

const { loadSnailConfig, redactSecrets } = require('./config.js');
const { redactKnownSecrets } = require('./secrets.js');

const RELOAD_REJECT_PREFIX = 'config reload rejected: ';

/** @typedef {import('./config.js').SnailAccount} SnailAccount */

/**
 * @param {SnailAccount} a
 * @param {SnailAccount} b
 */
function accountRowEqual(a, b) {
  const keys = [
    'name',
    'host',
    'port',
    'tls',
    'user',
    'password',
    'mailbox',
    'mail_dir',
    'notifier',
    'webhook_url',
    'webhook_secret',
    'webhook_auth',
    'webhook_header',
    'openclaw_url',
    'openclaw_token',
    'textLimit',
    'htmlLimit',
    'attachmentLimit',
  ];
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * @param {{ textLimit: number, htmlLimit: number, attachmentLimit: number, accounts: SnailAccount[] }} a
 * @param {{ textLimit: number, htmlLimit: number, attachmentLimit: number, accounts: SnailAccount[] }} b
 */
function snailConfigsEqual(a, b) {
  if (
    a.textLimit !== b.textLimit ||
    a.htmlLimit !== b.htmlLimit ||
    a.attachmentLimit !== b.attachmentLimit
  ) {
    return false;
  }
  if (a.accounts.length !== b.accounts.length) return false;
  const byName = new Map(b.accounts.map((acct) => [acct.name, acct]));
  for (const acct of a.accounts) {
    const other = byName.get(acct.name);
    if (!other || !accountRowEqual(acct, other)) return false;
  }
  return true;
}

/**
 * @param {{ accounts: SnailAccount[] }} current
 * @param {{ accounts: SnailAccount[] }} updated
 */
function diffAccountRows(current, updated) {
  const curByName = new Map(current.accounts.map((a) => [a.name, a]));
  const newByName = new Map(updated.accounts.map((a) => [a.name, a]));
  /** @type {SnailAccount[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  /** @type {{ name: string, account: SnailAccount }[]} */
  const changed = [];

  for (const acct of updated.accounts) {
    const prev = curByName.get(acct.name);
    if (!prev) {
      added.push(acct);
    } else if (!accountRowEqual(prev, acct)) {
      changed.push({ name: acct.name, account: acct });
    }
  }
  for (const name of curByName.keys()) {
    if (!newByName.has(name)) {
      removed.push(name);
    }
  }
  return { added, removed, changed };
}

/**
 * @param {string} message
 * @param {Iterable<string>} knownSecrets
 * @param {Iterable<string>} [inlineFromText]
 */
function redactReloadReason(message, knownSecrets, inlineFromText = []) {
  let out = redactKnownSecrets(message, knownSecrets);
  out = redactSecrets(out, [...knownSecrets, ...inlineFromText]);
  return out;
}

/**
 * @param {string} configPath
 * @param {{ uid?: number }} [options]
 */
function rereadSnailConfig(configPath, options = {}) {
  return loadSnailConfig(configPath, { ...options, forReload: true });
}

/**
 * @param {{ textLimit: number, htmlLimit: number, attachmentLimit: number, accounts: SnailAccount[] }} currentConfig
 * @param {ReturnType<typeof loadSnailConfig>} loadResult
 * @param {Iterable<string>} [knownSecrets]
 * @param {Iterable<string>} [inlineFromRejectedText]
 */
function decideConfigReload(currentConfig, loadResult, knownSecrets = [], inlineFromRejectedText = []) {
  if (!loadResult.ok) {
    const reason = redactReloadReason(loadResult.message, knownSecrets, inlineFromRejectedText);
    return {
      kind: 'keepAndLog',
      logLine: `${RELOAD_REJECT_PREFIX}${reason}`,
    };
  }
  if (snailConfigsEqual(currentConfig, loadResult.config)) {
    return { kind: 'unchanged' };
  }
  return {
    kind: 'applyAndLog',
    config: loadResult.config,
    diff: diffAccountRows(currentConfig, loadResult.config),
  };
}

module.exports = {
  RELOAD_REJECT_PREFIX,
  accountRowEqual,
  snailConfigsEqual,
  diffAccountRows,
  rereadSnailConfig,
  decideConfigReload,
  redactReloadReason,
};
