'use strict';

const { webcrypto } = require('node:crypto');
const WebSocket = require('ws');

const { notifyWithRetries, defaultSleeper } = require('./retry.js');

/**
 * @param {string} from
 * @param {string} subject
 * @param {string} absolutePath
 */
function formatWakeText(from, subject, absolutePath) {
  return `New email arrived. From: ${from} | Subject: ${subject} | File: ${absolutePath}`;
}

async function generateDeviceKeypair() {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );
  const pubRaw = await webcrypto.subtle.exportKey('raw', publicKey);
  const pubB64 = Buffer.from(pubRaw).toString('base64');
  const hashRaw = await webcrypto.subtle.digest('SHA-256', pubRaw);
  const deviceId = Buffer.from(hashRaw).toString('hex');
  return { privateKey, publicKey, publicKeyB64: pubB64, deviceId };
}

/**
 * @param {CryptoKey} privateKey
 * @param {string} payload
 */
async function signDevicePayload(privateKey, payload) {
  const enc = new TextEncoder();
  const sig = await webcrypto.subtle.sign('Ed25519', privateKey, enc.encode(payload));
  return Buffer.from(sig).toString('base64');
}

/**
 * @param {{
 *   deviceId: string,
 *   role: string,
 *   scopes: string[],
 *   token: string,
 *   nonce: string,
 *   signedAt: number,
 * }} parts
 */
function buildDeviceAuthPayload(parts) {
  return [
    'v2',
    parts.deviceId,
    'cli',
    'cli',
    parts.role,
    parts.scopes.join(','),
    String(parts.signedAt),
    parts.token,
    parts.nonce,
  ].join('|');
}

class OpenClawClient {
  /**
   * @param {{
   *   gatewayUrl: string,
   *   token: string,
   *   WebSocketImpl?: typeof WebSocket,
   * }} options
   */
  constructor({ gatewayUrl, token, WebSocketImpl = WebSocket }) {
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    /** @type {import('ws') | null} */
    this.ws = null;
    this.ready = false;
    /** @type {string[]} */
    this.queue = [];
    this.reqId = 1;
    /** @type {Record<string, (msg: object) => void>} */
    this.pendingReqs = {};
  }

  get wsUrl() {
    return this.gatewayUrl.replace(/^http/, 'ws');
  }

  async connect() {
    if (this.ready && this.ws) {
      return this.ws;
    }
    const keypair = await generateDeviceKeypair();
    const deviceId = keypair.deviceId;
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    const token = this.token;
    const WebSocketImpl = this.WebSocketImpl;

    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(this.wsUrl);

      ws.on('message', async (raw) => {
        const msg = JSON.parse(String(raw));

        if (msg.event === 'connect.challenge') {
          const { nonce } = msg.payload;
          const signedAt = Date.now();
          const payload = buildDeviceAuthPayload({
            deviceId,
            role,
            scopes,
            token,
            nonce,
            signedAt,
          });
          const signature = await signDevicePayload(keypair.privateKey, payload);

          ws.send(
            JSON.stringify({
              type: 'req',
              id: String(this.reqId++),
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' },
                role,
                scopes,
                caps: [],
                commands: [],
                permissions: {},
                auth: { token },
                locale: 'en-US',
                userAgent: 'snail/1.0.0',
                device: {
                  id: deviceId,
                  publicKey: keypair.publicKeyB64,
                  signature,
                  signedAt,
                  nonce,
                },
              },
            })
          );
          return;
        }

        if (msg.type === 'res') {
          if (msg.method === 'connect' || (msg.id && !this.pendingReqs[msg.id])) {
            if (!msg.ok) {
              reject(new Error(`Gateway connect failed: ${msg.error?.message ?? 'unknown'}`));
              ws.close();
              return;
            }
            this.ws = ws;
            this.ready = true;
            for (const queued of this.queue) {
              ws.send(queued);
            }
            this.queue = [];
            resolve(ws);
            return;
          }
          const cb = this.pendingReqs[msg.id];
          if (cb) {
            delete this.pendingReqs[msg.id];
            cb(msg);
          }
        }
      });

      ws.on('close', () => {
        this.ws = null;
        this.ready = false;
      });

      ws.on('error', (err) => {
        if (!this.ready) {
          reject(err);
        }
      });
    });
  }

  /**
   * @param {string} method
   * @param {object} params
   */
  sendGatewayReq(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(this.reqId++);
      const frame = JSON.stringify({ type: 'req', id, method, params });
      this.pendingReqs[id] = (msg) => {
        if (msg.ok) {
          resolve(msg.payload);
        } else {
          reject(new Error(`${method} failed: ${msg.error?.message ?? 'unknown'}`));
        }
      };
      if (this.ready && this.ws) {
        this.ws.send(frame);
      } else {
        this.queue.push(frame);
      }
    });
  }

  async wake(text) {
    if (!this.ready) {
      await this.connect();
    }
    await this.sendGatewayReq('wake', { text, mode: 'now' });
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
    this.ready = false;
  }
}

/**
 * @param {{
 *   client: OpenClawClient,
 *   from: string,
 *   subject: string,
 *   path: string,
 *   sleeper?: (ms: number) => Promise<void>,
 * }} options
 */
async function notifyOpenClawWake({ client, from, subject, path, sleeper = defaultSleeper }) {
  const text = formatWakeText(from, subject, path);

  const attempt = async () => {
    try {
      if (!client.ready) {
        await client.connect();
      }
      await client.wake(text);
      return true;
    } catch {
      client.close();
      return false;
    }
  };

  return notifyWithRetries({ attempt, sleeper });
}

module.exports = {
  OpenClawClient,
  formatWakeText,
  buildDeviceAuthPayload,
  notifyOpenClawWake,
};
