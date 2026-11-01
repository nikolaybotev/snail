'use strict';

const fs = require('node:fs');
const { parseTomlSubset, configPermissionsAcceptable } = require('./toml-subset.js');

const USAGE = 'usage: snail --config /abs/config.toml';
const ERR_PERMISSIONS = 'config permissions too open';
const ERR_OWNER = 'config owner is not the service user';

const DEFAULT_TEXT_LIMIT = 10000;
const DEFAULT_HTML_LIMIT = 100000;
const DEFAULT_ATTACHMENT_LIMIT = 10485760;
const DEFAULT_PORT = 993;
const DEFAULT_TLS = 'on';
const DEFAULT_MAILBOX = 'INBOX';
const DEFAULT_OPENCLAW_URL = 'http://127.0.0.1:18789';
const DEFAULT_WEBHOOK_AUTH = 'bearer';
const DEFAULT_WEBHOOK_HEADER = 'Authorization';

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const TOP_LEVEL_KEYS = new Set(['text_limit', 'html_limit', 'attachment_limit', 'account']);

/**
 * @param {string} path
 * @returns {string | null} error message if not absolute
 */
function configPathMustBeAbsolute(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return USAGE;
  }
  return null;
}

function webhookURLAllowed(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return true;
  if (scheme !== 'http') return false;
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') return false;
  return url.port !== '';
}

function openclawUrlAllowed(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const scheme = url.protocol.toLowerCase();
  return scheme === 'http:' || scheme === 'https:';
}

function isSecretReference(value) {
  if (value.startsWith('keychain://')) {
    const rest = value.slice('keychain://'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return false;
    const service = rest.slice(0, slash);
    const account = rest.slice(slash + 1);
    return service.length > 0 && account.length > 0 && !account.includes('/');
  }
  if (value.startsWith('op://')) {
    const rest = value.slice('op://'.length);
    const parts = rest.split('/');
    return parts.length === 3 && parts.every((p) => p.length > 0);
  }
  return true;
}

function normalizeMailDir(path) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function sameMailDir(a, b) {
  return (
    normalizeMailDir(a).localeCompare(normalizeMailDir(b), undefined, {
      sensitivity: 'accent',
    }) === 0
  );
}

function requireString(tomlValue, key) {
  if (!tomlValue || tomlValue.content.type !== 'string') {
    return {
      ok: false,
      message: `line ${tomlValue?.line ?? 0}: expected a string for ${key}`,
    };
  }
  return { ok: true, value: tomlValue.content.value, line: tomlValue.line };
}

function requireIntegerAtLeast(tomlValue, key, min) {
  if (!tomlValue || tomlValue.content.type !== 'integer') {
    return {
      ok: false,
      message: `line ${tomlValue?.line ?? 0}: expected an integer for ${key}`,
    };
  }
  const number = tomlValue.content.value;
  if (number < min) {
    return {
      ok: false,
      message: `line ${tomlValue.line}: ${key} must be an integer greater than or equal to ${min}`,
    };
  }
  return { ok: true, value: number, line: tomlValue.line };
}

function absolutePath(tomlValue, key) {
  const s = requireString(tomlValue, key);
  if (!s.ok) return s;
  if (!s.value.startsWith('/')) {
    return { ok: false, message: `line ${s.line}: ${key} must be an absolute path` };
  }
  return s;
}

function redactSecrets(message, secrets) {
  let out = message;
  const sorted = [...secrets]
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * @param {string} text
 * @returns {{ ok: true, config: object } | { ok: false, message: string }}
 */
function parseSnailConfig(text) {
  const parsed = parseTomlSubset(text);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }
  const root = parsed.table;

  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      const line = root[key].line;
      return { ok: false, message: `line ${line}: unknown key ${key}` };
    }
  }

  let textLimit = DEFAULT_TEXT_LIMIT;
  let htmlLimit = DEFAULT_HTML_LIMIT;
  let attachmentLimit = DEFAULT_ATTACHMENT_LIMIT;

  if (root.text_limit) {
    const r = requireIntegerAtLeast(root.text_limit, 'text_limit', 1);
    if (!r.ok) return { ok: false, message: r.message };
    textLimit = r.value;
  }
  if (root.html_limit) {
    const r = requireIntegerAtLeast(root.html_limit, 'html_limit', 1);
    if (!r.ok) return { ok: false, message: r.message };
    htmlLimit = r.value;
  }
  if (root.attachment_limit) {
    const r = requireIntegerAtLeast(root.attachment_limit, 'attachment_limit', 1);
    if (!r.ok) return { ok: false, message: r.message };
    attachmentLimit = r.value;
  }

  if (!root.account) {
    return { ok: false, message: 'missing account' };
  }
  if (root.account.content.type !== 'arrayOfTables') {
    return {
      ok: false,
      message: `line ${root.account.line}: expected an array of tables for account`,
    };
  }
  const rows = root.account.content.value;
  if (rows.length === 0) {
    return { ok: false, message: 'missing account' };
  }

  const accounts = [];
  const namesSeen = new Map();
  const mailDirs = [];

  for (const row of rows) {
    const accountResult = parseAccountRow(row, { textLimit, htmlLimit, attachmentLimit });
    if (!accountResult.ok) {
      const secrets = extractSecretLiteralsFromText(text);
      return { ok: false, message: redactSecrets(accountResult.message, secrets) };
    }
    const acct = accountResult.account;
    if (namesSeen.has(acct.name)) {
      return {
        ok: false,
        message: `line ${acct.nameLine}: duplicate name`,
      };
    }
    namesSeen.set(acct.name, acct.nameLine);
    for (const prev of mailDirs) {
      if (sameMailDir(prev.path, acct.mail_dir)) {
        return {
          ok: false,
          message: `line ${acct.mail_dirLine}: duplicate mail_dir`,
        };
      }
    }
    mailDirs.push({ path: acct.mail_dir, line: acct.mail_dirLine });
    accounts.push(acct);
  }

  return {
    ok: true,
    config: {
      textLimit,
      htmlLimit,
      attachmentLimit,
      accounts,
    },
  };
}

function parseAccountRow(row, defaults) {
  let name;
  let nameLine = 0;
  let host;
  let port = DEFAULT_PORT;
  let tls = DEFAULT_TLS;
  let user;
  let password;
  let mailbox = DEFAULT_MAILBOX;
  let mail_dir;
  let mail_dirLine = 0;
  let notifier;
  let webhook_url;
  let webhook_secret;
  let webhook_auth = DEFAULT_WEBHOOK_AUTH;
  let webhook_header = DEFAULT_WEBHOOK_HEADER;
  let openclaw_url = DEFAULT_OPENCLAW_URL;
  let openclaw_token;
  let textLimit = defaults.textLimit;
  let htmlLimit = defaults.htmlLimit;
  let attachmentLimit = defaults.attachmentLimit;

  for (const key of Object.keys(row)) {
    const value = row[key];
    switch (key) {
      case 'name': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (!NAME_PATTERN.test(s.value)) {
          return { ok: false, message: `line ${s.line}: expected a string for name` };
        }
        name = s.value;
        nameLine = s.line;
        break;
      }
      case 'host': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        host = s.value;
        break;
      }
      case 'port': {
        const r = requireIntegerAtLeast(value, key, 1);
        if (!r.ok) return { ok: false, message: r.message };
        if (r.value > 65535) {
          return { ok: false, message: `line ${r.line}: port must be an integer from 1 to 65535` };
        }
        port = r.value;
        break;
      }
      case 'tls': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (s.value !== 'on' && s.value !== 'off') {
          return { ok: false, message: `line ${s.line}: expected a string for tls` };
        }
        tls = s.value;
        break;
      }
      case 'user': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        user = s.value;
        break;
      }
      case 'password': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (!isSecretReference(s.value)) {
          return { ok: false, message: `line ${s.line}: expected a string for password` };
        }
        password = s.value;
        break;
      }
      case 'mailbox': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        mailbox = s.value;
        break;
      }
      case 'mail_dir': {
        const s = absolutePath(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        mail_dir = s.value;
        mail_dirLine = s.line;
        break;
      }
      case 'notifier': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (s.value !== 'webhook' && s.value !== 'openclaw') {
          return { ok: false, message: `line ${s.line}: expected a string for notifier` };
        }
        notifier = s.value;
        break;
      }
      case 'webhook_url': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        webhook_url = s.value;
        break;
      }
      case 'webhook_secret': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (!isSecretReference(s.value)) {
          return { ok: false, message: `line ${s.line}: expected a string for webhook_secret` };
        }
        webhook_secret = s.value;
        break;
      }
      case 'webhook_auth': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (s.value !== 'bearer' && s.value !== 'raw') {
          return { ok: false, message: `line ${s.line}: expected a string for webhook_auth` };
        }
        webhook_auth = s.value;
        break;
      }
      case 'webhook_header': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (/\s/.test(s.value) || s.value.includes('\n')) {
          return { ok: false, message: `line ${s.line}: expected a string for webhook_header` };
        }
        webhook_header = s.value;
        break;
      }
      case 'openclaw_url': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        openclaw_url = s.value;
        break;
      }
      case 'openclaw_token': {
        const s = requireString(value, key);
        if (!s.ok) return { ok: false, message: s.message };
        if (!isSecretReference(s.value)) {
          return { ok: false, message: `line ${s.line}: expected a string for openclaw_token` };
        }
        openclaw_token = s.value;
        break;
      }
      case 'text_limit': {
        const r = requireIntegerAtLeast(value, key, 1);
        if (!r.ok) return { ok: false, message: r.message };
        textLimit = r.value;
        break;
      }
      case 'html_limit': {
        const r = requireIntegerAtLeast(value, key, 1);
        if (!r.ok) return { ok: false, message: r.message };
        htmlLimit = r.value;
        break;
      }
      case 'attachment_limit': {
        const r = requireIntegerAtLeast(value, key, 1);
        if (!r.ok) return { ok: false, message: r.message };
        attachmentLimit = r.value;
        break;
      }
      default:
        return { ok: false, message: `line ${value.line}: unknown key ${key}` };
    }
  }

  const required = [
    ['name', name],
    ['host', host],
    ['user', user],
    ['password', password],
    ['mail_dir', mail_dir],
    ['notifier', notifier],
  ];
  for (const [key, val] of required) {
    if (val === undefined) {
      return { ok: false, message: `missing ${key}` };
    }
  }

  if (notifier === 'webhook') {
    if (openclaw_token !== undefined) {
      const line = row.openclaw_token?.line ?? nameLine;
      return {
        ok: false,
        message: `line ${line}: openclaw_token is only valid when notifier is openclaw`,
      };
    }
    if (webhook_url === undefined) {
      return { ok: false, message: 'missing webhook_url' };
    }
    if (webhook_secret === undefined) {
      return { ok: false, message: 'missing webhook_secret' };
    }
    const urlLine = row.webhook_url?.line ?? 0;
    if (!webhookURLAllowed(webhook_url)) {
      return { ok: false, message: `line ${urlLine}: webhook url not allowed` };
    }
  } else {
    if (webhook_url !== undefined) {
      const line = row.webhook_url?.line ?? 0;
      return {
        ok: false,
        message: `line ${line}: webhook_url is only valid when notifier is webhook`,
      };
    }
    if (webhook_secret !== undefined) {
      const line = row.webhook_secret?.line ?? 0;
      return {
        ok: false,
        message: `line ${line}: webhook_secret is only valid when notifier is webhook`,
      };
    }
    if (webhook_auth !== DEFAULT_WEBHOOK_AUTH && row.webhook_auth) {
      const line = row.webhook_auth.line;
      return {
        ok: false,
        message: `line ${line}: webhook_auth is only valid when notifier is webhook`,
      };
    }
    if (webhook_header !== DEFAULT_WEBHOOK_HEADER && row.webhook_header) {
      const line = row.webhook_header.line;
      return {
        ok: false,
        message: `line ${line}: webhook_header is only valid when notifier is webhook`,
      };
    }
    if (openclaw_token === undefined) {
      return { ok: false, message: 'missing openclaw_token' };
    }
    const urlLine = row.openclaw_url?.line ?? 0;
    if (!openclawUrlAllowed(openclaw_url)) {
      return {
        ok: false,
        message: `line ${urlLine}: openclaw_url must not contain credentials`,
      };
    }
  }

  return {
    ok: true,
    account: {
      name,
      nameLine,
      host,
      port,
      tls,
      user,
      password,
      mailbox,
      mail_dir,
      mail_dirLine,
      notifier,
      webhook_url,
      webhook_secret,
      webhook_auth,
      webhook_header,
      openclaw_url,
      openclaw_token,
      textLimit,
      htmlLimit,
      attachmentLimit,
    },
  };
}

/**
 * @param {string} configPath absolute path
 * @param {{ uid?: number }} [options]
 */
function loadSnailConfig(configPath, options = {}) {
  const absErr = configPathMustBeAbsolute(configPath);
  if (absErr) {
    return { ok: false, exitCode: 2, message: absErr };
  }

  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch (err) {
    return { ok: false, exitCode: 2, message: `config io error: ${err.message}` };
  }

  if (!configPermissionsAcceptable(stat.mode)) {
    return { ok: false, exitCode: 2, message: ERR_PERMISSIONS };
  }

  const processUid = options.uid ?? process.getuid?.();
  if (typeof processUid === 'number' && stat.uid !== processUid) {
    return { ok: false, exitCode: 2, message: ERR_OWNER };
  }

  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return { ok: false, exitCode: 2, message: `config io error: ${err.message}` };
  }

  const configResult = parseSnailConfig(text);
  if (!configResult.ok) {
    const secrets = extractSecretLiteralsFromText(text);
    const msg = redactSecrets(`config parse error: ${configResult.message}`, secrets);
    return { ok: false, exitCode: 2, message: msg };
  }

  return { ok: true, config: configResult.config };
}

function extractSecretLiteralsFromText(text) {
  const secrets = [];
  const re = /^(?:password|webhook_secret|openclaw_token)\s*=\s*"((?:\\.|[^"\\])*)"/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    secrets.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return secrets;
}

function looksLikeJsonConfig(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

module.exports = {
  USAGE,
  ERR_PERMISSIONS,
  ERR_OWNER,
  configPathMustBeAbsolute,
  configPermissionsAcceptable,
  parseSnailConfig,
  loadSnailConfig,
  looksLikeJsonConfig,
  webhookURLAllowed,
  openclawUrlAllowed,
  redactSecrets,
};
