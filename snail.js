#!/usr/bin/env node
/**
 * 🐌 Snail — IMAP IDLE daemon
 *
 * Monitors an IMAP mailbox via IDLE, saves new emails to disk,
 * and wakes an agent with metadata only.
 *
 * Usage: node snail.js
 * Config: snail-config.json (see snail-config.example.json)
 */

'use strict';

const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { webcrypto } = require('crypto');
const WebSocket = require('ws');
const { simpleParser } = require('mailparser');

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(...args)   { console.log(new Date().toISOString(), ...args); }
function error(...args) { console.error(new Date().toISOString(), ...args); }

// ─── 1Password secret resolution ────────────────────────────────────────────

const OP_PY = path.join(__dirname, '../../op.py');

function resolveSecrets(obj) {
  // Collect all op:// references in the config
  const refs = [];
  function collect(v) {
    if (typeof v === 'string' && v.startsWith('op://')) refs.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  }
  collect(obj);
  if (refs.length === 0) return obj;

  const req = JSON.stringify({ ids: refs });
  let result;
  try {
    result = execFileSync('/usr/bin/python3', [OP_PY], { input: req, encoding: 'utf8' });
  } catch (e) {
    error('[snail] Failed to resolve secrets via op.py:', e.message);
    process.exit(1);
  }

  const resolved = JSON.parse(result).values;

  // Deep-replace op:// strings in config
  function replace(v) {
    if (typeof v === 'string' && v.startsWith('op://')) return resolved[v];
    if (v && typeof v === 'object') {
      return Array.isArray(v)
        ? v.map(replace)
        : Object.fromEntries(Object.entries(v).map(([k, val]) => [k, replace(val)]));
    }
    return v;
  }
  return replace(obj);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'snail-config.json');
const STATE_PATH  = path.join(__dirname, 'snail-state.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    error(`[snail] Config not found: ${CONFIG_PATH}`);
    error(`[snail] Copy snail-config.example.json → snail-config.json and fill it in.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  log('[snail] Resolving secrets via 1Password...');
  const config = resolveSecrets(raw);
  
  // Add defaults for new limits
  config.htmlLimit = config.htmlLimit || 100000;  // Default: 100K chars
  config.textLimit = config.textLimit || 10000;   // Default: 10K chars
  
  return config;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lastUID: 0 };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastUID: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Mail storage ─────────────────────────────────────────────────────────────

function ensureMailDir(mailDir) {
  if (!fs.existsSync(mailDir)) fs.mkdirSync(mailDir, { recursive: true });
}

function saveEmail(mailDir, uid, envelope, bodyText, htmlBody, attachments, config) {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}_uid-${String(uid).padStart(6, '0')}.json`;
  const filepath = path.join(mailDir, filename);
  const data = {
    uid,
    from:    envelope.from?.map(a => `${a.name || ''} <${a.address}>`).join(', ') || '',
    to:      envelope.to?.map(a => `${a.name || ''} <${a.address}>`).join(', ') || '',
    subject: envelope.subject || '(no subject)',
    date:    envelope.date?.toISOString() || new Date().toISOString(),
    body:    bodyText || '',
  };
  if (htmlBody) data.html_body = htmlBody.slice(0, config.htmlLimit);
  if (attachments && attachments.length > 0) {
    data.attachments = attachments.map(a => ({
      filename:     a.filename || 'unnamed',
      content_type: a.contentType || 'application/octet-stream',
      size:         a.size || a.content?.length || 0,
      content:      a.content?.toString('base64') || '',
    }));
  }
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filename;
}

// ─── Agent gateway WebSocket ─────────────────────────────────────────────────

// Persistent WS connection to the agent gateway
let _gatewayWs = null;
let _gatewayReady = false;
let _gatewayQueue = [];
let _reqId = 1;
let _pendingReqs = {};

async function generateDeviceKeypair() {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: 'Ed25519' }, true, ['sign', 'verify']
  );
  const pubRaw = await webcrypto.subtle.exportKey('raw', publicKey);
  const pubB64 = Buffer.from(pubRaw).toString('base64');
  // Device ID = SHA-256 fingerprint of the public key (hex)
  const hashRaw = await webcrypto.subtle.digest('SHA-256', pubRaw);
  const deviceId = Buffer.from(hashRaw).toString('hex');
  return { privateKey, publicKey, publicKeyB64: pubB64, deviceId };
}

async function signDevicePayload(privateKey, payload) {
  const enc = new TextEncoder();
  const sig = await webcrypto.subtle.sign('Ed25519', privateKey, enc.encode(payload));
  return Buffer.from(sig).toString('base64');
}

function buildPayload({ deviceId, role, scopes, token, nonce, signedAt }) {
  // v2 payload format
  return ['v2', deviceId, 'cli', 'cli', role, scopes.join(','), String(signedAt), token, nonce].join('|');
}

async function connectGateway(gatewayUrl, gatewayToken) {
  const wsUrl = gatewayUrl.replace(/^http/, 'ws');
  const keypair = await generateDeviceKeypair();
  const deviceId = keypair.deviceId;
  const role = 'operator';
  const scopes = ['operator.read', 'operator.write', 'operator.admin'];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.on('message', async raw => {
      const msg = JSON.parse(raw);

      if (msg.event === 'connect.challenge') {
        const { nonce } = msg.payload;
        const signedAt = Date.now();
        const payload = buildPayload({ deviceId, publicKeyB64: keypair.publicKeyB64, role, scopes, token: gatewayToken, nonce, signedAt });
        const signature = await signDevicePayload(keypair.privateKey, payload);

        ws.send(JSON.stringify({
          type: 'req', id: String(_reqId++), method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' },
            role, scopes, caps: [], commands: [], permissions: {},
            auth: { token: gatewayToken },
            locale: 'en-US', userAgent: 'snail/1.0.0',
            device: { id: deviceId, publicKey: keypair.publicKeyB64, signature, signedAt, nonce },
          },
        }));
        return;
      }

      if (msg.type === 'res') {
        if (msg.method === 'connect' || (msg.id && !_pendingReqs[msg.id])) {
          // connect response
          if (!msg.ok) {
            reject(new Error(`Gateway connect failed: ${msg.error?.message}`));
            ws.close();
            return;
          }
          _gatewayWs = ws;
          _gatewayReady = true;
          log('[snail] Gateway WS connected');
          // flush queued sends
          for (const queued of _gatewayQueue) ws.send(queued);
          _gatewayQueue = [];
          resolve(ws);
          return;
        }
        // response to a pending req
        const cb = _pendingReqs[msg.id];
        if (cb) { delete _pendingReqs[msg.id]; cb(msg); }
      }
    });

    ws.on('close', () => {
      log('[snail] Gateway WS disconnected');
      _gatewayWs = null;
      _gatewayReady = false;
    });

    ws.on('error', err => {
      error('[snail] Gateway WS error:', err.message);
      if (!_gatewayReady) reject(err);
    });
  });
}

function sendGatewayReq(method, params) {
  return new Promise((resolve, reject) => {
    const id = String(_reqId++);
    const frame = JSON.stringify({ type: 'req', id, method, params });
    _pendingReqs[id] = msg => {
      if (msg.ok) resolve(msg.payload);
      else reject(new Error(`${method} failed: ${msg.error?.message}`));
    };
    if (_gatewayReady && _gatewayWs) {
      _gatewayWs.send(frame);
    } else {
      _gatewayQueue.push(frame);
    }
  });
}

async function injectEvent(gatewayUrl, gatewayToken, text) {
  // Reconnect if needed
  if (!_gatewayReady) {
    await connectGateway(gatewayUrl, gatewayToken);
  }
  await sendGatewayReq('wake', { text, mode: 'now' });
}

// ─── IMAP IDLE loop ───────────────────────────────────────────────────────────

async function fetchNewMessages(client, state, config) {
  const mailDir = path.resolve(__dirname, config.mailDir || '../mail');
  ensureMailDir(mailDir);

  const since = state.lastUID;
  const range = since > 0 ? `${since + 1}:*` : '1:*';

  let maxUID = state.lastUID;
  const newFiles = [];

  // Pass 1: collect envelopes (no nested fetch inside the iterator)
  log(`[snail] Fetching range: ${range}`);
  const messages = [];
  for await (const msg of client.fetch(range, { envelope: true, uid: true }, { uid: true })) {
    if (msg.uid <= state.lastUID) continue;
    log(`[snail] Got message UID ${msg.uid}: ${msg.envelope?.subject}`);
    messages.push(msg);
    if (msg.uid > maxUID) maxUID = msg.uid;
  }

  // Pass 2: fetch bodies one at a time (outside the iterator)
  for (const msg of messages) {
    let bodyText = '';
    let htmlBody = null;
    let attachments = [];
    try {
      log(`[snail] Fetching body for UID ${msg.uid}...`);
      const bodyMsg = await client.fetchOne(`${msg.uid}`, { source: true }, { uid: true });
      if (bodyMsg?.source) {
        const parsed = await simpleParser(bodyMsg.source);
        bodyText = (parsed.text || '').slice(0, 2000);
        htmlBody = parsed.html || null;
        attachments = parsed.attachments || [];
        if (attachments.length) log(`[snail] Attachments: ${attachments.map(a => a.filename).join(', ')}`);
      }
      log(`[snail] Body fetched, length: ${bodyText.length}`);
    } catch (e) {
      error(`[snail] Body fetch failed for UID ${msg.uid}:`, e.message);
    }

    const filename = saveEmail(mailDir, msg.uid, msg.envelope, bodyText, htmlBody, attachments, config);
    newFiles.push({ uid: msg.uid, filename, subject: msg.envelope.subject, from: msg.envelope.from?.[0]?.address });
  }

  if (maxUID > state.lastUID) {
    state.lastUID = maxUID;
    saveState(state);
  }

  return newFiles;
}

async function run() {
  const config = loadConfig();
  const state  = loadState();

  const gatewayUrl   = config.gatewayUrl   || 'http://127.0.0.1:18789';
  const gatewayToken = config.gatewayToken;
  const mailSubdir   = config.mailDir      || '../mail';

  log(`[snail] 🐌 Starting up. Last UID: ${state.lastUID}`);

  // Connect to the agent gateway over persistent WebSocket
  try {
    await connectGateway(gatewayUrl, gatewayToken);
  } catch (e) {
    error('[snail] Failed to connect to gateway:', e.message);
    error('[snail] Will retry inject on first email...');
  }

  let client;
  let retryDelay = 5000;

  async function connect() {
    client = new ImapFlow({
      host:   config.imap.host,
      port:   config.imap.port || 993,
      secure: config.imap.secure !== false, // default true
      auth: {
        user: config.imap.user,
        pass: config.imap.pass,
      },
      logger: false, // quiet — set to console for debug
    });

    client.on('error', err => {
      error('[snail] Connection error:', err.message);
    });

    await client.connect();
    retryDelay = 5000; // reset on successful connect
    log(`[snail] Connected to ${config.imap.host}`);

    await client.mailboxOpen(config.imap.mailbox || 'INBOX');

    // Catch up on anything missed while offline
    const catchUp = await fetchNewMessages(client, state, config);
    for (const m of catchUp) {
      log(`[snail] Catch-up: UID ${m.uid} — ${m.subject}`);
      await notifyNewEmail(m, mailSubdir, gatewayUrl, gatewayToken);
    }

    // IDLE loop — re-enter after each EXISTS notification
    while (true) {
      log('[snail] Entering IDLE...');

      // idle() resolves when the server sends EXISTS (new mail) or connection drops
      await new Promise((resolve, reject) => {
        const onExists = () => { resolve('exists'); };
        const onClose  = () => { resolve('close'); };
        const onError  = (e) => { reject(e); };
        client.once('exists', onExists);
        client.once('close',  onClose);
        client.once('error',  onError);
        client.idle().catch(reject);
      });

      // Now IDLE has exited — safe to fetch
      log('[snail] EXISTS — checking for new messages');
      try {
        const newMsgs = await fetchNewMessages(client, state, config);
        for (const m of newMsgs) {
          log(`[snail] New mail: UID ${m.uid} — ${m.subject}`);
          await notifyNewEmail(m, mailSubdir, gatewayUrl, gatewayToken);
        }
      } catch (e) {
        error('[snail] Error fetching new messages:', e.message);
        break; // reconnect
      }
    }
  }

  async function notifyNewEmail(msg, mailSubdir, gatewayUrl, gatewayToken) {
    const relPath = path.join(mailSubdir, msg.filename);
    const text = `New email arrived. From: ${msg.from || 'unknown'} | Subject: ${msg.subject || '(no subject)'} | File: ${relPath}`;
    try {
      await injectEvent(gatewayUrl, gatewayToken, text);
      log(`[snail] Injected event for UID ${msg.uid}`);
    } catch (e) {
      error('[snail] Failed to inject event:', e.message);
    }
  }

  // Reconnect loop with exponential backoff
  while (true) {
    try {
      await connect();
    } catch (err) {
      error(`[snail] Disconnected: ${err.message}. Retrying in ${retryDelay / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 60000); // cap at 60s
    } finally {
      try { await client?.logout(); } catch {}
    }
  }
}

run().catch(err => {
  error('[snail] Fatal:', err);
  process.exit(1);
});
