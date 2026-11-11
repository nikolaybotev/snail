'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fileSuffixForUid,
  messageFilenameFor,
  readSnailState,
  initialSnailState,
  persistInitialSnailState,
  lookupExistingMessageFile,
  buildMessagePayload,
  createMailStore,
  STATE_BASENAME,
} = require('../src/mail-store.js');
const { readNotifyLedger } = require('../src/notify-ledger.js');

function tempMailDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snail-mail-'));
}

test('AC17: four-field state is written before any message body', () => {
  const mailDir = tempMailDir();
  let bodyOffered = false;
  const origWrite = fs.writeFileSync;
  const spyFs = {
    ...fs,
    writeFileSync(file, data, opts) {
      if (typeof data === 'string' && data.includes('"body"')) {
        bodyOffered = true;
      }
      return origWrite.call(fs, file, data, opts);
    },
    readFileSync: fs.readFileSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
  };
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    fs: spyFs,
  });
  assert.equal(bodyOffered, false);
  const state = store.ensureMailboxState(42, 1000);
  assert.deepEqual(state, initialSnailState(42, 1000));
  assert.equal(bodyOffered, false);
  const onDisk = readSnailState(mailDir);
  assert.deepEqual(onDisk, initialSnailState(42, 1000));
});

test('AC17: missing state file uses four-field write, not lastUID 0 fallback', () => {
  const mailDir = tempMailDir();
  persistInitialSnailState(mailDir, 7, 50);
  const s = readSnailState(mailDir);
  assert.deepEqual(s, {
    uidValidity: 7,
    notifyBoundary: 50,
    backlogUid: 0,
    lastUid: 49,
  });
});

test('AC17: UID below notifyBoundary is saved and not woken when lastUid is still 0', async () => {
  const mailDir = tempMailDir();
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    accountName: 'work',
  });
  store.ensureMailboxState(1, 100);
  const stateOnDisk = readSnailState(mailDir);
  assert.equal(stateOnDisk.lastUid, 99);
  const result = await store.saveOneMessage({
    uid: 10,
    uidValidity: 1,
    body: 'backlog',
  });
  assert.equal(result.saved, true);
  assert.equal(result.attemptNotify, false);
  assert.equal(readNotifyLedger(mailDir).length, 0);
  const after = readSnailState(mailDir);
  assert.equal(after.backlogUid, 10);
  assert.equal(after.lastUid, 99);
});

test('AC17: new UID at or above boundary is woken while backlog is in progress', async () => {
  const mailDir = tempMailDir();
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    accountName: 'work',
  });
  store.ensureMailboxState(1, 100);
  await store.saveOneMessage({ uid: 5, uidValidity: 1, body: 'backlog-a' });
  const notify = await store.saveOneMessage({ uid: 100, uidValidity: 1, body: 'new-mail' });
  assert.equal(notify.attemptNotify, true);
  assert.equal(readNotifyLedger(mailDir).length, 1);
  const after = readSnailState(mailDir);
  assert.equal(after.backlogUid, 5);
  assert.equal(after.lastUid, 100);
});

test('AC17: failed write leaves backlogUid unchanged and does not wake', async () => {
  const mailDir = tempMailDir();
  let failNext = true;
  const failingFs = {
    ...fs,
    writeFileSync(file, data, opts) {
      const isMessageTmp =
        failNext &&
        String(file).includes('.tmp-') &&
        typeof data === 'string' &&
        data.includes('"uid"') &&
        !String(file).includes(STATE_BASENAME);
      if (isMessageTmp) {
        failNext = false;
        const err = new Error('ENOSPC');
        err.code = 'ENOSPC';
        throw err;
      }
      return fs.writeFileSync(file, data, opts);
    },
    readFileSync: fs.readFileSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
  };
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    fs: failingFs,
    accountName: 'work',
    log: () => {},
  });
  store.ensureMailboxState(1, 100);
  const before = readSnailState(mailDir);
  const result = await store.saveOneMessage({ uid: 3, uidValidity: 1, body: 'x' });
  assert.equal(result.saved, false);
  assert.equal(result.attemptNotify, false);
  const after = readSnailState(mailDir);
  assert.deepEqual(after, before);
});

test('AC17: crash resume advances backlogUid only for durable saves', async () => {
  const mailDir = tempMailDir();
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
  });
  store.ensureMailboxState(2, 20);
  await store.saveOneMessage({ uid: 1, uidValidity: 2, body: 'one' });
  await store.saveOneMessage({ uid: 2, uidValidity: 2, body: 'two' });
  let state = readSnailState(mailDir);
  assert.equal(state.backlogUid, 2);
  const secondPass = await store.saveOneMessage({ uid: 2, uidValidity: 2, body: 'two-again' });
  assert.equal(secondPass.skipped, true);
  assert.equal(readSnailState(mailDir).backlogUid, 2);
});

test('AC5: existing file is not rewritten when envelope date would differ', async () => {
  const mailDir = tempMailDir();
  const suffix = fileSuffixForUid(9, 55);
  const fixedName = `20260101T120000Z_9_0000000055.json`;
  assert.ok(fixedName.endsWith(suffix.slice(1)) || fixedName.endsWith(suffix));
  fs.mkdirSync(mailDir, { recursive: true });
  const existingPath = path.join(mailDir, fixedName);
  fs.writeFileSync(existingPath, '{"uid":55}', { mode: 0o600 });
  persistInitialSnailState(mailDir, 9, 100);
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    now: () => new Date('2026-06-01T00:00:00.000Z'),
  });
  const wakes = [];
  const result = await store.saveOneMessage({
    uid: 55,
    uidValidity: 9,
    envelopeDate: new Date('2026-12-25T00:00:00.000Z'),
    body: 'would-be-different',
  });
  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(existingPath, 'utf8'), '{"uid":55}');
  const store2 = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    accountName: 'work',
  });
  const again = await store2.saveOneMessage({
    uid: 55,
    uidValidity: 9,
    body: 'again',
  });
  assert.equal(again.skipped, true);
  assert.equal(again.attemptNotify, false);
});

test('FR3 recovery: existing file notify uses from and subject on disk', async () => {
  const mailDir = tempMailDir();
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    accountName: 'work',
  });
  store.ensureMailboxState(7, 10);
  const first = await store.saveOneMessage({
    uid: 10,
    uidValidity: 7,
    body: 'body',
    subject: 'Recovery subject',
    from: [{ address: 'sender@example.com', name: 'Ada' }],
  });
  assert.equal(first.saved, true);
  assert.equal(first.attemptNotify, true);
  const filePath = path.join(mailDir, first.filename);
  const ledgerPath = path.join(mailDir, '.snail-notify.json');
  fs.unlinkSync(ledgerPath);
  const intake = readSnailState(mailDir);
  const { writeSnailState } = require('../src/mail-store.js');
  writeSnailState(mailDir, { ...intake, lastUid: 9 });

  const recovered = await store.saveOneMessage({
    uid: 10,
    uidValidity: 7,
    body: 'ignored',
    subject: 'ignored',
    from: [{ address: 'wrong@example.com' }],
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovered.attemptNotify, true);
  assert.equal(recovered.wakeFrom, 'sender@example.com');
  assert.equal(recovered.wakeSubject, 'Recovery subject');
  assert.equal(readSnailState(mailDir).lastUid, 10);
  const onDisk = fs.readFileSync(filePath, 'utf8');
  assert.ok(onDisk.includes('Recovery subject'));
  assert.ok(onDisk.includes('sender@example.com'));
});

test('AC5: backlog UID is not woken; new UID woken once then lastUid updated', async () => {
  const mailDir = tempMailDir();
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    accountName: 'work',
  });
  store.ensureMailboxState(3, 200);
  const backlog = await store.saveOneMessage({ uid: 50, uidValidity: 3, body: 'b' });
  assert.equal(backlog.attemptNotify, false);
  const fresh = await store.saveOneMessage({ uid: 200, uidValidity: 3, body: 'n' });
  assert.equal(fresh.attemptNotify, true);
  assert.equal(readNotifyLedger(mailDir).length, 1);
  const state = readSnailState(mailDir);
  assert.equal(state.lastUid, 200);
  const again = await store.saveOneMessage({ uid: 200, uidValidity: 3, body: 'n2' });
  assert.equal(again.attemptNotify, false);
});

test('AC5: directory lookup uses uidValidity and uid suffix', () => {
  const mailDir = tempMailDir();
  fs.mkdirSync(mailDir, { recursive: true });
  const name = messageFilenameFor(new Date('2026-01-01T12:00:00.000Z'), 42, 7, new Date()).filename;
  fs.writeFileSync(path.join(mailDir, name), '{}', { mode: 0o600 });
  assert.ok(lookupExistingMessageFile(mailDir, 42, 7));
  assert.equal(lookupExistingMessageFile(mailDir, 42, 8), null);
  assert.equal(lookupExistingMessageFile(mailDir, 43, 7), null);
});

test('AC6: over-long text and html are truncated and flagged', () => {
  const mailDir = tempMailDir();
  const long = 'x'.repeat(50);
  const { record } = buildMessagePayload(
    {
      uid: 1,
      uidValidity: 1,
      body: long,
      htmlBody: long,
      textLimit: 10,
      htmlLimit: 15,
      attachmentLimit: 100,
    },
    mailDir
  );
  assert.equal(record.body.length, 10);
  assert.equal(record.text_truncated, true);
  assert.equal(record.html_body.length, 15);
  assert.equal(record.html_truncated, true);
});

test('AC6: oversized attachment stores metadata with omitted true and no content', () => {
  const mailDir = tempMailDir();
  const big = Buffer.alloc(200);
  const { record } = buildMessagePayload(
    {
      uid: 1,
      uidValidity: 1,
      attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', content: big }],
      textLimit: 10000,
      htmlLimit: 100000,
      attachmentLimit: 100,
    },
    mailDir
  );
  assert.equal(record.attachments.length, 1);
  assert.equal(record.attachments[0].omitted, true);
  assert.equal(record.attachments[0].content, undefined);
  assert.equal(record.attachments[0].size, 200);
});

test('AC6: small attachment includes base64 content', () => {
  const mailDir = tempMailDir();
  const { record } = buildMessagePayload(
    {
      uid: 1,
      uidValidity: 1,
      attachments: [{ filename: 'a.txt', content: Buffer.from('hi') }],
      textLimit: 10000,
      htmlLimit: 100000,
      attachmentLimit: 100,
    },
    mailDir
  );
  assert.equal(record.attachments[0].omitted, false);
  assert.equal(record.attachments[0].content, Buffer.from('hi').toString('base64'));
});

test('saved message uses temp file then rename with mode 0600', async () => {
  const mailDir = tempMailDir();
  const renames = [];
  const wrapFs = {
    ...fs,
    renameSync(from, to) {
      renames.push({ from: path.basename(from), to: path.basename(to) });
      return fs.renameSync(from, to);
    },
    writeFileSync: fs.writeFileSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
  };
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    fs: wrapFs,
  });
  store.ensureMailboxState(1, 10);
  await store.saveOneMessage({ uid: 1, uidValidity: 1, body: 'hi' });
  const messageRenames = renames.filter((r) => !r.to.includes(STATE_BASENAME));
  assert.equal(messageRenames.length, 1);
  assert.match(messageRenames[0].from, /\.tmp-/);
  const files = fs.readdirSync(mailDir).filter((f) => f.endsWith('.json') && f !== STATE_BASENAME);
  assert.equal(files.length, 1);
  const st = fs.statSync(path.join(mailDir, files[0]));
  assert.equal(st.mode & 0o777, 0o600);
});

test('UIDVALIDITY change resets state with four-field write before bodies', async () => {
  const mailDir = tempMailDir();
  persistInitialSnailState(mailDir, 1, 100);
  writeSnailState(mailDir, {
    uidValidity: 1,
    notifyBoundary: 100,
    backlogUid: 50,
    lastUid: 105,
  });
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
  });
  const state = store.ensureMailboxState(2, 500);
  assert.deepEqual(state, initialSnailState(2, 500));
});

test('lastUid update preserves notifyBoundary and does not drop below boundary', async () => {
  const mailDir = tempMailDir();
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    accountName: 'work',
  });
  store.ensureMailboxState(1, 100);
  await store.saveOneMessage({ uid: 100, uidValidity: 1, body: 'new' });
  const after = readSnailState(mailDir);
  assert.equal(after.notifyBoundary, 100);
  assert.equal(after.lastUid, 100);
  assert.equal(after.backlogUid, 0);
});

function writeSnailState(mailDir, state) {
  const { writeSnailState: write } = require('../src/mail-store.js');
  write(mailDir, state);
}
