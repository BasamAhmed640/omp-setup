import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ResearchVault } from '../src/vault.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-research-vault-'));
  // Targets are created by this fixture and remain below the resolved temporary root.
  t.after(async () => {
    const resolved = await fs.realpath(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('pi-research-vault-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(temp, 'Discover');
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
  const vault = await ResearchVault.bind(root);
  return { temp, root, vault };
}

test('binding requires an existing vault and open preserves identity without implicit initialization', async t => {
  const { temp, root, vault } = await fixture(t);
  assert.equal((await ResearchVault.bind(root)).id, vault.id);
  assert.equal((await ResearchVault.open(root, vault.id)).id, vault.id);
  await assert.rejects(ResearchVault.open(root, 'wrong-id'), /identity/);
  const empty = path.join(temp, 'Empty');
  await fs.mkdir(empty);
  await assert.rejects(ResearchVault.bind(empty));
  await fs.mkdir(path.join(empty, '.obsidian'));
  await assert.rejects(ResearchVault.open(empty), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(empty, '_Research')), { code: 'ENOENT' });
});

test('confinement rejects traversal, Windows alternate streams, and external junctions', async t => {
  const { temp, root, vault } = await fixture(t);
  for (const unsafe of ['../escape.md', '..\\escape.md', '/escape.md', 'C:\\escape.md', 'Note.md:stream', 'a/../../escape']) {
    await assert.rejects(vault.writeText(unsafe, 'no'), /inside|relative/);
  }
  const outside = path.join(temp, 'Outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'secret canary');
  await fs.symlink(outside, path.join(root, 'OutsideLink'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(vault.readText('OutsideLink/secret.md'), /escapes/);
  await assert.rejects(vault.writeText('OutsideLink/new.md', 'no'), /escapes/);
  assert.deepEqual(await vault.search('canary'), []);
  await assert.rejects(fs.stat(path.join(outside, 'new.md')), { code: 'ENOENT' });
  await vault.writeText('_Research/internal.md', 'runtime alias canary');
  await fs.symlink(path.join(root, '_Research'), path.join(root, 'FriendlyAlias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(vault.readNote('FriendlyAlias/internal.md'), /Internal/);
  assert.deepEqual(await vault.search('runtime alias canary'), []);
  await assert.rejects(vault.readNote('_research/internal.md'), /Internal/);
});

test('Scholar same, nested and aliased vaults are rejected', async t => {
  const { temp, root } = await fixture(t);
  await assert.rejects(ResearchVault.bind(root, { scholarRoots: [root] }), /separate/);
  await assert.rejects(ResearchVault.bind(root, { scholarRoots: [temp] }), /separate/);
  await assert.rejects(ResearchVault.bind(root, { scholarRoots: [path.join(root, 'future-scholar')] }), /separate/);
  const alias = path.join(temp, 'Alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ResearchVault.bind(root, { scholarRoots: [alias] }), /separate/);
});

test('messages are immutable, retries idempotent, concurrent appends ordered, and projections recover', async t => {
  const { root, vault } = await fixture(t);
  const conversation = await vault.createConversation('A saved discussion');
  assert.ok(path.isAbsolute(conversation.sessionDir));
  const original = { id: 'user-one', role: 'user', text: 'Explain this carefully.', timestamp: 1700000000000, nativeEntryId: 'entry1' };
  const saved = await vault.saveMessage(conversation.id, original);
  assert.deepEqual(await vault.saveMessage(conversation.id, original), saved);
  assert.deepEqual(await vault.saveMessage(conversation.id, { ...original, timestamp: undefined }), saved);
  await assert.rejects(vault.saveMessage(conversation.id, { ...original, text: 'Changed' }), { code: 'ERR_RESEARCH_CONFLICT' });
  await Promise.all(Array.from({ length: 4 }, (_, i) => vault.saveMessage(conversation.id, { id: `assistant-${i}`, role: 'assistant', text: `Original response ${i}.` })));
  const messages = await vault.getMessages(conversation.id);
  assert.equal(messages.length, 5);
  assert.deepEqual(messages.map(message => message.sequence), [1, 2, 3, 4, 5]);
  const projection = `${conversation.path}/Conversation.md`;
  const expected = await vault.readText(projection);
  await fs.writeFile(path.join(root, projection), 'damaged derived index');
  await fs.unlink(path.join(root, conversation.path, 'Messages', 'assistant-0.md'));
  await vault.recoverConversation(conversation.id);
  assert.equal(await vault.readText(projection), expected);
  assert.match(await vault.readText(`${conversation.path}/Messages/user-one.md`), /research_entry_id: "entry1"/);
  assert.match(await vault.readText(`${conversation.path}/Messages/assistant-0.md`), /Original response 0\./);
  const reopened = await ResearchVault.open(root, vault.id);
  assert.deepEqual(await reopened.getMessages(conversation.id), messages);
  assert.equal((await reopened.listConversations())[0].id, conversation.id);
});

test('explicit projection recovery preserves manual message amendments before restoring original', async t => {
  const { vault } = await fixture(t);
  const conversation = await vault.createConversation('Amendments');
  await vault.saveMessage(conversation.id, { id: 'm1', role: 'assistant', text: 'Frozen original' });
  await vault.writeText(`${conversation.path}/Messages/m1.md`, 'User annotation');
  await vault.recoverConversation(conversation.id);
  assert.match(await vault.readText(`${conversation.path}/Messages/m1.md`), /Frozen original/);
  const backups = await fs.readdir(await vault.safePath(`_Research/recovered-edits/${conversation.id}`));
  assert.equal(backups.length, 1);
  assert.equal(await vault.readText(`_Research/recovered-edits/${conversation.id}/${backups[0]}`), 'User annotation');
});

test('streams clear after commit and native sessions stay confined without a parallel checkpoint', async t => {
  const { vault } = await fixture(t);
  const conversation = await vault.createConversation('Streams');
  await vault.saveStream(conversation.id, { text: 'Partial response', status: 'streaming' });
  assert.equal((await vault.readJson(`_Research/stream/${conversation.id}.json`)).text, 'Partial response');
  await vault.saveMessage(conversation.id, { id: 'm1', role: 'assistant', text: 'Complete response' });
  assert.equal((await vault.readJson(`_Research/stream/${conversation.id}.json`)).text, '');
  assert.equal((await vault.readJson(`_Research/stream/${conversation.id}.json`)).status, 'complete');
  await assert.rejects(vault.readText(`${conversation.path}/Context.md`), { code: 'ENOENT' });
  const session = `${conversation.path}/sessions/native.jsonl`;
  await vault.setSessionFile(conversation.id, session);
  assert.equal((await vault.getConversation(conversation.id)).sessionFile, session);
  await vault.setSessionFile(conversation.id, `${conversation.path}/session.jsonl`);
  await assert.rejects(vault.setSessionFile(conversation.id, 'Other/native.jsonl'), /must belong/);
  await assert.rejects(vault.getConversation('../wrong'), /Invalid/);
});

test('attachment imports preserve bytes after source removal and are content-idempotent', async t => {
  const { temp, vault } = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const source = path.join(temp, 'photo.png');
  await fs.writeFile(source, png);
  const imported = await vault.importAttachment(source);
  await fs.unlink(source);
  assert.deepEqual(await fs.readFile(await vault.safePath(imported.path)), png);
  const second = await vault.importAttachment({ data: png.toString('base64'), mimeType: 'image/png', name: 'Screenshot' });
  assert.equal(second.id, imported.id);
  assert.equal(second.path, imported.path);
  const native = await vault.importAttachment({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png.toString('base64') } });
  assert.equal(native.id, imported.id);
  const conversation = await vault.createConversation('Photo');
  await vault.saveMessage(conversation.id, { id: 'photo-message', role: 'user', text: 'What is this?', attachments: [imported] });
  assert.match(await vault.readText(`${conversation.path}/Conversation.md`), new RegExp(imported.id));
  await assert.rejects(vault.importAttachment({ data: '%%%garbage', mimeType: 'image/png' }), /base64/);
});

test('knowledge conflicts preserve edits and revision snapshots; search is bounded and excludes runtime', async t => {
  const { vault } = await fixture(t);
  const source = await vault.saveSource({ title: 'Battery report', url: 'https://example.test/report', text: 'Battery capacity: 42 Wh.' });
  assert.match((await vault.readNote(source.path)).text, /Battery capacity: 42 Wh\./);
  assert.equal((await vault.readJson(`Sources/${source.id}/metadata.json`)).url, 'https://example.test/report');
  await assert.rejects(vault.readText(`Sources/${source.id}/extracted.md`), { code: 'ENOENT' });
  const first = await vault.saveKnowledge({ title: 'Battery capacity', text: 'A saved comparison.', sources: [source.id] });
  const note = await vault.readNote('Battery capacity', { maxChars: 12 });
  assert.equal(note.path, first.path);
  assert.equal(note.revision, first.revision);
  assert.equal(note.text.length, 12);
  assert.equal(note.truncated, true);
  const firstText = (await vault.readNote(first.path)).text;
  const second = await vault.saveKnowledge({ title: 'Battery capacity', text: 'Updated comparison.', expectedRevision: first.revision });
  assert.equal(second.previousRevision, first.revision);
  assert.equal(await vault.readText(`_Research/knowledge/battery-capacity/revisions/${first.revision}.md`), firstText);
  await assert.rejects(vault.saveKnowledge({ title: 'Battery capacity', text: 'Stale overwrite', expectedRevision: first.revision }), { code: 'ERR_RESEARCH_CONFLICT' });
  await vault.writeText(first.path, 'Human edited battery findings.');
  await assert.rejects(vault.saveKnowledge({ title: 'Battery capacity', text: 'Silent overwrite' }), { code: 'ERR_RESEARCH_CONFLICT' });
  assert.equal(await vault.readText(first.path), 'Human edited battery findings.');
  await vault.writeText('_Research/secret.md', 'Battery private-runtime-marker');
  await vault.writeText('.obsidian/internal.md', 'Battery internal-config-marker');
  assert.equal((await vault.search('battery', { limit: 1 })).length, 1);
  assert.deepEqual(await vault.search('private-runtime-marker'), []);
  assert.deepEqual(await vault.search('internal-config-marker'), []);
  await assert.rejects(vault.readNote('_Research/secret.md'), /Internal/);
  assert.match((await vault.readNote(source.path)).text, /42 Wh/);
  assert.equal((await vault.readNote('Battery report')).path, source.path);
});

test('copying the complete vault preserves identity, native session pointers, and frozen content', async t => {
  const { temp, root, vault } = await fixture(t);
  const conversation = await vault.createConversation('Portable');
  await vault.saveMessage(conversation.id, { id: 'm1', role: 'assistant', text: 'Portable original' });
  const nativePath = `${conversation.path}/session.jsonl`;
  await vault.writeText(nativePath, '{"type":"session","id":"native"}\n');
  await vault.setSessionFile(conversation.id, nativePath);
  const copy = path.join(temp, 'Moved');
  await fs.cp(root, copy, { recursive: true });
  const reopened = await ResearchVault.open(copy, vault.id);
  assert.equal((await reopened.getMessages(conversation.id))[0].text, 'Portable original');
  const manifest = await reopened.getConversation(conversation.id);
  assert.equal(manifest.sessionFile, nativePath);
  assert.match(await reopened.readText(manifest.sessionFile), /native/);
  assert.ok(manifest.sessionDir.startsWith(copy));
});

test('corrupt stored JSON and modified frozen records fail loudly', async t => {
  const { vault } = await fixture(t);
  await vault.writeText('corrupt.json', '{broken');
  await assert.rejects(vault.readJson('corrupt.json'), { code: 'ERR_RESEARCH_JSON' });
  const conversation = await vault.createConversation('Integrity');
  await vault.saveMessage(conversation.id, { id: 'm1', role: 'assistant', text: 'Unchanged' });
  const relative = `${conversation.path}/Messages/m1.json`;
  const record = await vault.readJson(relative);
  record.text = 'Tampered';
  await vault.writeJson(relative, record);
  await assert.rejects(vault.getMessages(conversation.id), /integrity/);
});
