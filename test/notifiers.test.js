'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const {
  WEBHOOK_PAYLOAD_KEYS,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
  buildWebhookBody,
  notifyWebhook,
} = require('../src/notifiers/webhook.js');
const {
  OpenClawClient,
  formatWakeText,
  buildDeviceAuthPayload,
  notifyOpenClawWake,
} = require('../src/notifiers/openclaw.js');
const { NOTIFY_RETRY_DELAYS_MS } = require('../src/notifiers/retry.js');

/** @param {string[]=} events */
function sleeperIgnoringAttemptTimeout(events) {
  return async (ms) => {
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
      return new Promise(() => {});
    }
    if (events) {
      events.push(`sleep:${ms}`);
    }
  };
}

async function listenWss(wss) {
  await new Promise((resolve, reject) => {
    wss.on('listening', resolve);
    wss.on('error', reject);
  });
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

const sampleFields = {
  account: 'work',
  from: 'ada@example.com',
  subject: 'Hello',
  date: '2026-11-01T03:15:00.000Z',
  message_id: '<id@example.com>',
  path: '/abs/mail/work/20261101T031500Z_42_0000000123.json',
  mailbox: 'INBOX',
  uid: 123,
  uid_validity: 42,
};

test('AC7: webhook JSON has only D5 keys', () => {
  const body = buildWebhookBody(sampleFields);
  assert.deepEqual(Object.keys(body).sort(), [...WEBHOOK_PAYLOAD_KEYS].sort());
  for (const key of WEBHOOK_PAYLOAD_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, key));
  }
});

test('AC7: webhook from is bare first address and date matches file', async () => {
  /** @type {Record<string, unknown> | null} */
  let seenBody = null;
  let seenHeader = null;
  const fetchImpl = async (_url, init) => {
    seenBody = JSON.parse(String(init.body));
    seenHeader = init.headers.Authorization;
    return new Response('', { status: 200 });
  };
  const result = await notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook',
    secret: 'tok',
    webhookAuth: 'bearer',
    payload: buildWebhookBody({
      ...sampleFields,
      from: 'ada@example.com',
    }),
    fetchImpl,
    sleeper: sleeperIgnoringAttemptTimeout(),
  });
  assert.equal(result.ok, true);
  assert.equal(seenBody.from, 'ada@example.com');
  assert.equal(seenBody.date, sampleFields.date);
  assert.equal(seenHeader, 'Bearer tok');
  const forbidden = ['body', 'html_body', 'date_source', 'attachments', 'content'];
  for (const key of forbidden) {
    assert.equal(Object.prototype.hasOwnProperty.call(seenBody, key), false);
  }
});

test('AC7: raw auth sends secret as header value', async () => {
  let seenHeader = null;
  const fetchImpl = async (_url, init) => {
    seenHeader = init.headers['X-Custom'];
    return new Response('', { status: 200 });
  };
  await notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook',
    secret: 'raw-secret-value',
    webhookAuth: 'raw',
    webhookHeader: 'X-Custom',
    payload: buildWebhookBody(sampleFields),
    fetchImpl,
    sleeper: sleeperIgnoringAttemptTimeout(),
  });
  assert.equal(seenHeader, 'raw-secret-value');
});

test('AC7: fails when an extra key is present in payload object', () => {
  const body = buildWebhookBody(sampleFields);
  body.extra = 'not allowed';
  assert.throws(() => {
    for (const key of Object.keys(body)) {
      if (!WEBHOOK_PAYLOAD_KEYS.includes(key)) {
        throw new Error(`unexpected webhook key: ${key}`);
      }
    }
  }, /unexpected webhook key: extra/);
});

test('AC9: first webhook attempt is immediate', async () => {
  const events = [];
  const fetchImpl = async () => {
    events.push('fetch');
    return new Response('', { status: 500 });
  };
  const sleeper = sleeperIgnoringAttemptTimeout(events);
  await notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook',
    secret: 'tok',
    payload: buildWebhookBody(sampleFields),
    fetchImpl,
    sleeper,
  });
  assert.equal(events[0], 'fetch');
  assert.ok(events[1].startsWith('sleep:'));
});

test('AC9: redirects are not followed', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:9/other' } });
  };
  const result = await notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook',
    secret: 'tok',
    payload: buildWebhookBody(sampleFields),
    fetchImpl,
    sleeper: sleeperIgnoringAttemptTimeout(),
    attemptTimeoutMs: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(fetchCount, 1 + NOTIFY_RETRY_DELAYS_MS.length);
});

test('AC9: no response within 10 seconds counts as failure', async () => {
  let hangingFetches = 0;
  const fetchImpl = () =>
    new Promise(() => {
      hangingFetches += 1;
    });
  const sleeper = async (ms) => {
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
      return;
    }
  };
  const notifyPromise = notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook',
    secret: 'tok',
    payload: buildWebhookBody(sampleFields),
    fetchImpl,
    sleeper,
    attemptTimeoutMs: WEBHOOK_ATTEMPT_TIMEOUT_MS,
  });
  const result = await notifyPromise;
  assert.equal(result.ok, false);
  assert.equal(hangingFetches, 1 + NOTIFY_RETRY_DELAYS_MS.length);
});

test('AC8: OpenClaw handshake and wake on fake gateway', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  after(() => wss.close());

  /** @type {object | null} */
  let connectParams = null;
  /** @type {object | null} */
  let wakeParams = null;
  let connections = 0;

  wss.on('connection', (ws) => {
    connections += 1;
    ws.send(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'connect') {
        connectParams = msg.params;
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, method: 'connect' }));
      }
      if (msg.method === 'wake') {
        wakeParams = msg.params;
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }));
      }
    });
  });

  const gatewayUrl = await listenWss(wss);

  const client = new OpenClawClient({ gatewayUrl, token: 'gateway-token' });
  const absPath = path.resolve('/abs/mail/work/msg.json');
  const text = formatWakeText('ada@example.com', 'Hello', absPath);
  await client.wake(text);
  client.close();

  assert.equal(connections, 1);
  assert.ok(connectParams);
  assert.equal(connectParams.minProtocol, 3);
  assert.equal(connectParams.maxProtocol, 3);
  assert.equal(connectParams.client.id, 'cli');
  assert.match(connectParams.device.signature, /^[A-Za-z0-9+/=]+$/);
  const payloadCheck = buildDeviceAuthPayload({
    deviceId: connectParams.device.id,
    role: connectParams.role,
    scopes: connectParams.scopes,
    token: 'gateway-token',
    nonce: 'nonce-1',
    signedAt: connectParams.device.signedAt,
  });
  assert.equal(payloadCheck.split('|')[0], 'v2');

  assert.deepEqual(wakeParams, { text, mode: 'now' });
  assert.match(text, /^New email arrived\. From: ada@example\.com \| Subject: Hello \| File: /);
  assert.ok(path.isAbsolute(text.split('File: ')[1]));
});

test('AC8: each OpenClaw client uses its own connection', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  after(() => wss.close());

  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    ws.send(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'connect') {
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, method: 'connect' }));
      }
      if (msg.method === 'wake') {
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }));
      }
    });
  });

  const gatewayUrl = await listenWss(wss);

  const a = new OpenClawClient({ gatewayUrl, token: 'a' });
  const b = new OpenClawClient({ gatewayUrl, token: 'b' });
  await a.connect();
  await b.connect();
  assert.equal(connections, 2);
  a.close();
  b.close();
});

test('notifyOpenClawWake retries with injected sleeper', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  after(() => wss.close());

  let wakeAttempts = 0;
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'connect') {
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, method: 'connect' }));
      }
      if (msg.method === 'wake') {
        wakeAttempts += 1;
        const ok = wakeAttempts >= 2;
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok, error: ok ? undefined : { message: 'fail' } }));
      }
    });
  });

  const gatewayUrl = await listenWss(wss);

  const client = new OpenClawClient({ gatewayUrl, token: 't' });
  const sleeps = [];
  const result = await notifyOpenClawWake({
    client,
    from: 'x@example.com',
    subject: 'Subj',
    path: '/abs/x.json',
    sleeper: async (ms) => {
      if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
        return new Promise(() => {});
      }
      sleeps.push(ms);
    },
  });
  client.close();
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [NOTIFY_RETRY_DELAYS_MS[0]]);
});
