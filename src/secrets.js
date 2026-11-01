'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const SECURITY_BIN = '/usr/bin/security';
const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;

/**
 * @param {string} value
 * @returns {{ service: string, account: string } | null}
 */
function parseKeychainReference(value) {
  if (!value.startsWith('keychain://')) return null;
  const rest = value.slice('keychain://'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const service = rest.slice(0, slash);
  const account = rest.slice(slash + 1);
  if (service.length === 0 || account.length === 0 || account.includes('/')) return null;
  return { service, account };
}

/**
 * @param {string} value
 * @returns {{ vault: string, item: string, field: string } | null}
 */
function parseOpReference(value) {
  if (!value.startsWith('op://')) return null;
  const rest = value.slice('op://'.length);
  const parts = rest.split('/');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  return { vault: parts[0], item: parts[1], field: parts[2] };
}

function isInlineSecret(value) {
  return parseKeychainReference(value) === null && parseOpReference(value) === null;
}

/**
 * argv for tests and production; secret is never an argument.
 * @param {string} service
 * @param {string} account
 */
function keychainExecArgs(service, account) {
  return {
    file: SECURITY_BIN,
    args: ['find-generic-password', '-s', service, '-a', account, '-w'],
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function readOpServiceAccountToken(env = process.env) {
  const tokenFile = env.SNAIL_OP_TOKEN_FILE;
  if (typeof tokenFile === 'string' && tokenFile.length > 0) {
    return fs.readFileSync(tokenFile, 'utf8').replace(/\n$/, '');
  }
  const credDir = env.CREDENTIALS_DIRECTORY;
  if (typeof credDir === 'string' && credDir.length > 0) {
    const p = path.join(credDir, 'op-token');
    return fs.readFileSync(p, 'utf8').replace(/\n$/, '');
  }
  return null;
}

/**
 * @param {string} text
 * @param {Iterable<string>} secrets
 */
function redactKnownSecrets(text, secrets) {
  let out = text;
  const sorted = [...secrets]
    .filter((s) => typeof s === 'string' && s.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out;
}

async function defaultKeychainRunner(service, account, execImpl = execFileAsync) {
  const { file, args } = keychainExecArgs(service, account);
  const { stdout } = await execImpl(file, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.replace(/\n$/, '');
}

async function defaultOpRunner(opReference, token, execImpl = execFileAsync) {
  const childEnv = {
    ...process.env,
    OP_SERVICE_ACCOUNT_TOKEN: token,
    OP_BIOMETRIC_UNLOCK_ENABLED: 'false',
  };
  const { stdout } = await execImpl('op', ['read', opReference], {
    encoding: 'utf8',
    env: childEnv,
    maxBuffer: 1024 * 1024,
  });
  return stdout.replace(/\n$/, '');
}

/**
 * @param {{
 *   platform?: string,
 *   log?: (line: string) => void,
 *   sleeper?: (ms: number) => Promise<void>,
 *   keychainRunner?: (service: string, account: string) => Promise<string>,
 *   opRunner?: (opReference: string, token: string) => Promise<string>,
 *   readOpToken?: (env?: NodeJS.ProcessEnv) => string | null,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 */
function createAccountSecretResolver(options = {}) {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  const sleeper = options.sleeper ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const keychainRunner = options.keychainRunner ?? defaultKeychainRunner;
  const opRunner = options.opRunner ?? defaultOpRunner;
  const readOpToken = options.readOpToken ?? readOpServiceAccountToken;
  const env = options.env ?? process.env;
  const secretLiteralsForRedaction = new Set(options.secretLiteralsForRedaction ?? []);

  /** @type {Map<string, string>} */
  const cache = new Map();
  let backoffMs = INITIAL_BACKOFF_MS;

  function redactPoolFor(configValue) {
    const pool = [...secretLiteralsForRedaction, ...cache.values()];
    if (isInlineSecret(configValue) && configValue.length >= 8) {
      pool.push(configValue);
    }
    return pool;
  }

  async function resolveReferenceOnce(configValue) {
    const keychain = parseKeychainReference(configValue);
    if (keychain) {
      if (platform !== 'darwin') {
        throw new Error('keychain reference is not supported on this platform');
      }
      return keychainRunner(keychain.service, keychain.account);
    }

    const opRef = parseOpReference(configValue);
    if (opRef) {
      const token = readOpToken(env);
      if (!token) {
        throw new Error('op service account token is not configured');
      }
      return opRunner(configValue, token);
    }

    return configValue;
  }

  /**
   * Resolve one secret field value (inline or reference). Retries with FR6 backoff on failure.
   * @param {string} configValue
   * @returns {Promise<string>}
   */
  async function resolve(configValue) {
    const cached = cache.get(configValue);
    if (cached !== undefined) {
      return cached;
    }

    while (true) {
      try {
        const secret = await resolveReferenceOnce(configValue);
        cache.set(configValue, secret);
        backoffMs = INITIAL_BACKOFF_MS;
        return secret;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const line = redactKnownSecrets(`secret resolve failed: ${message}`, redactPoolFor(configValue));
        log(line);
        await sleeper(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  function clearCache() {
    cache.clear();
    backoffMs = INITIAL_BACKOFF_MS;
  }

  return { resolve, clearCache };
}

module.exports = {
  parseKeychainReference,
  parseOpReference,
  isInlineSecret,
  keychainExecArgs,
  readOpServiceAccountToken,
  redactKnownSecrets,
  defaultKeychainRunner,
  defaultOpRunner,
  createAccountSecretResolver,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
};
