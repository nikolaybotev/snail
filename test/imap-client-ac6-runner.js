'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
/** @type {typeof originalLoad} */
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'imapflow') {
    let openCount = 0;
    return {
      ImapFlow: class {
        on() {}
        async connect() {}
        async mailboxOpen() {
          openCount += 1;
          if (openCount === 1) {
            return { uidValidity: 42n, uidNext: 101n };
          }
          return { uidValidity: 7n, uidNext: 55 };
        }
      },
    };
  }
  if (request === 'mailparser') {
    return {
      simpleParser: async () => ({ text: '', attachments: [] }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const snailPath = require.resolve('../snail.js');
delete require.cache[snailPath];

const { createImapFlowClient } = require('../snail.js');

(async () => {
  const client = createImapFlowClient(
    {
      name: 'work',
      host: 'imap.example.com',
      port: 993,
      tls: 'on',
      user: 'you@example.com',
      mailbox: 'INBOX',
    },
    'secret',
  );
  await client.connect();
  const mb = await client.mailboxOpen('INBOX');
  assert.equal(mb.uidValidity, 42);
  assert.equal(mb.uidNext, 101);
  assert.equal(typeof mb.uidValidity, 'number');
  assert.equal(typeof mb.uidNext, 'number');

  const mb2 = await client.mailboxOpen('INBOX');
  assert.equal(mb2.uidValidity, 7);
  assert.equal(mb2.uidNext, 55);
  assert.equal(typeof mb2.uidNext, 'number');
})().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
