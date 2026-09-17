import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDiscover } from '../src/extension.mjs';

function fixture() {
  const commands = new Map(), events = new Map(), calls = [], instances = [], notices = [], statuses = [];
  const state = { selected: null, failOpen: false };
  const vault = { root: 'vault', id: 'vault-id',
    listConversations: async () => [{ id: 'saved', title: 'Saved conversation' }],
    getConversation: async id => ({ id, title: 'Saved conversation' }),
    readJson: async () => ({ conversationId: 'saved' }),
  };
  class Controller {
    constructor(sdk, value, options) {
      assert.equal(sdk, 'sdk'); this.vault = value; this.onStatus = options.onStatus;
      this.effort = 'ask'; this.attachments = []; instances.push(this);
    }
    async acquire() { calls.push('acquire'); this.lock = true; }
    async select(conversation) {
      this.session = null;
      if (state.openGate) await state.openGate;
      if (state.failOpen) throw new Error('Cannot open saved history');
      this.session = {}; this.conversation = conversation;
    }
    async newConversation(title) { return this.select({ id: 'new', title }); }
    async continueNote(path) { await this.newConversation(path); return { path }; }
    async fork(conversation) { await this.select(conversation); }
    async prompt(text, images) { calls.push(['prompt', text, images]); if (state.promptGate) await state.promptGate; }
    async stop() { calls.push('stop'); }
    async dispose() {
      calls.push('dispose'); this.session = null; this.lock = false;
      this.onStatus('Late status during shutdown');
      if (state.failDispose) throw new Error('Draft save failed');
    }
  }
  const deps = {
    ResearchController: Controller,
    ResearchVault: { open: async () => { calls.push('vault.open'); return vault; }, bind: async () => { calls.push('vault.bind'); return vault; } },
    readConfig: async () => { calls.push('config.read'); return { vaultRoot: 'vault', vaultId: 'vault-id' }; },
    writeConfig: async () => { calls.push('config.write'); }, scholarRoots: async () => [],
    installCompanion: async () => { calls.push('install'); if(state.failInstall)throw new Error('Companion folder is read-only'); }, unlockVault: async () => { calls.push('unlock'); },
  };
  const pi = { registerCommand: (name, command) => commands.set(name, command), on: (name, handler) => events.set(name, handler) };
  registerDiscover(pi, { loadSdk: async () => { calls.push('sdk'); return 'sdk'; }, services: async () => { calls.push('services'); return deps; } });
  const ctx = { isIdle: () => true, hasUI: true, sessionManager: { getBranch: () => [] },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args),
      select: async () => state.selected, getEditorText: () => '', setEditorText: text => calls.push(['editor', text]) },
  };
  return { commands, events, calls, instances, notices, statuses, state, ctx,
    command: text => commands.get('discover').handler(text, ctx),
    input: (text = 'Ordinary question', extra = {}) => events.get('input')({ text, source: 'interactive', ...extra }, ctx),
  };
}

test('registration and inactive Pi events load nothing, inspect no context and leave input untouched', async () => {
  const f = fixture();
  const untouched = new Proxy({}, { get() { throw new Error('Inactive Discover touched host context'); } });
  assert.deepEqual([...f.commands.keys()], ['discover']);
  assert.deepEqual([...f.events.keys()], ['input', 'session_start', 'session_shutdown']);
  for (const source of ['interactive', 'rpc', 'extension']) {
    assert.deepEqual(f.events.get('input')({ text: 'hello', source, images: [{ type: 'image' }] }, untouched), { action: 'continue' });
  }
  await f.events.get('session_start')({ reason: 'startup' }, untouched);
  await f.events.get('session_shutdown')({ reason: 'quit' }, untouched);
  for (const command of ['help', 'stop', 'exit', 'unknown', 'attach "photo.png"', 'clear-attachments', 'repair', 'fork incomplete']) await f.command(command);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.statuses, []);
});

test('command suggestions explain actions without loading services or overwriting arguments', () => {
  const f = fixture(), complete = f.commands.get('discover').getArgumentCompletions;
  const all = complete('');
  assert.ok(all.some(item => item.value === 'help ' && item.description.includes('guide')));
  assert.ok(all.some(item => item.value === 'attach ' && item.description.includes('PDF')));
  assert.ok(all.some(item => item.value === 'vault ' && item.description.includes('outside Scholar')));
  assert.ok(all.every(item => item.description && !item.value.includes('<') && !item.value.includes('[')));
  assert.deepEqual(complete('  DE').map(item => item.value), ['deep']);
  assert.equal(complete('nonexistent'), null);
  for (const prefix of ['attach "C:\\My Papers\\paper.pdf"', 'new My next topic', 'resume Saved title', 'fork conversation entry', 'vault\t"C:\\Notes"']) assert.equal(complete(prefix), null);
  assert.deepEqual(complete('help att').map(item => item.value), ['help attach']);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.instances, []);
  assert.deepEqual(f.input(), { action: 'continue' });
});

test('help covers every suggested command and stays available while idle, closed or busy', async () => {
  const f = fixture();
  f.ctx.isIdle = () => { throw new Error('Help must not inspect or interrupt a running agent'); };
  await f.command('help');
  const guide = f.notices.at(-1)[0];
  for (const item of f.commands.get('discover').getArgumentCompletions('')) assert.ok(guide.includes(`/discover ${item.label}`), item.label);
  for (const group of ['Conversations', 'Attachments', 'Session', 'Setup', 'Help and recovery']) assert.ok(guide.includes(`\n${group}\n`));
  assert.match(guide, /C:\\Papers\\study.pdf/);
  await f.command('help attach');
  assert.match(f.notices.at(-1)[0], /\/discover attach "file path"/);
  assert.doesNotMatch(f.notices.at(-1)[0], /\/discover fork/);
  await f.command('help nonexistent');
  assert.match(f.notices.at(-1)[0], /Unknown help topic/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.instances, []);
  assert.deepEqual(f.input(), { action: 'continue' });
});

test('vault linking, companion installation and unlock never activate the SDK or intercept messages', async () => {
  const f = fixture();
  for (const command of ['vault "C:\\Notes"', 'install-plugin', 'unlock']) {
    await f.command(command);
    assert.deepEqual(f.input(), { action: 'continue' });
  }
  assert.ok(f.calls.includes('install'));
  assert.ok(f.calls.includes('config.write'));
  assert.ok(f.calls.includes('unlock'));
  assert.ok(!f.calls.includes('sdk'));
  assert.deepEqual(f.instances, []);
  assert.deepEqual(f.statuses, []);
});

test('linking installs before saving the pointer; opening refreshes once and preserves normal input on installation failure',async()=>{
  const linked=fixture();
  await linked.command('vault "C:\\Notes"');
  assert.ok(linked.calls.indexOf('install')<linked.calls.indexOf('config.write'));
  assert.equal(linked.calls.filter(call=>call==='install').length,1);
  assert.equal(linked.instances.length,0);
  assert.deepEqual(linked.input(),{action:'continue'});
  const failed=fixture();failed.state.failInstall=true;
  await failed.command('vault "C:\\Notes"');
  assert.ok(!failed.calls.includes('config.write'),'A failed relink must preserve the previous vault pointer.');
  await failed.command('');
  assert.equal(failed.instances.length,0);
  assert.ok(!failed.calls.includes('sdk'));
  assert.deepEqual(failed.input(),{action:'continue'});
  assert.match(failed.notices.at(-1)[0],/read-only/);
  failed.state.failInstall=false;
  await failed.command('');
  const count=failed.calls.filter(call=>call==='install').length;
  await failed.command('deep');
  assert.equal(failed.calls.filter(call=>call==='install').length,count,'Switching an active mode should not reinstall.');
  await failed.command('exit');
  await failed.command('');
  assert.equal(failed.calls.filter(call=>call==='install').length,count+1);
});

test('explicit conversation commands activate; exit restores ordinary input and suppresses late callbacks', async () => {
  const f = fixture();
  for (const command of ['', 'ask', 'deep', 'new Example', 'resume saved', 'continue "Knowledge/Note.md"', 'fork saved entry', 'branch saved entry']) {
    await f.command(command);
    const active = f.instances.at(-1);
    assert.ok(active.session);
    if (command === 'deep') assert.equal(active.effort, 'deep');
    assert.deepEqual(f.input('Discover question', { images: [{ type: 'image' }] }), { action: 'handled' });
    assert.deepEqual(f.calls.at(-1), ['prompt', 'Discover question', [{ type: 'image' }]]);
    assert.deepEqual(f.input('Other extension', { source: 'extension' }), { action: 'continue' });
    await f.command('exit');
    assert.equal(active.lock, false);
    assert.equal(active.session, null);
    assert.deepEqual(f.statuses.at(-1), ['pi-research', undefined]);
    const count = f.statuses.length;
    active.onStatus('Stale callback');
    assert.equal(f.statuses.length, count);
    assert.deepEqual(f.input(), { action: 'continue' });
  }
});

test('cancelled resume and failed activation leave no owner or lock', async () => {
  const f = fixture();
  await f.command('resume');
  assert.equal(f.instances.length, 0);
  assert.ok(!f.calls.includes('sdk'));
  assert.deepEqual(f.input(), { action: 'continue' });
  f.state.failOpen = true;
  await f.command('');
  assert.match(f.notices.at(-1)[0], /Cannot open saved history/);
  assert.equal(f.instances.at(-1).lock, false);
  assert.deepEqual(f.input(), { action: 'continue' });
  f.state.failOpen = false;
  await f.command('');
  assert.deepEqual(f.input(), { action: 'handled' });
  await f.command('exit');
});

test('a failed switch that disposes the old session also releases Discover input and status', async () => {
  const f = fixture();
  await f.command('');
  f.state.failOpen = true;
  await f.command('new Another topic');
  assert.equal(f.instances[0].lock, false);
  assert.deepEqual(f.input(), { action: 'continue' });
  assert.deepEqual(f.statuses.at(-1), ['pi-research', undefined]);
});

test('shutdown racing with opening waits for cleanup and cannot leave Discover active', async () => {
  const f = fixture();
  let release;
  f.state.openGate = new Promise(resolve => { release = resolve; });
  const opening = f.command('');
  // Allow asynchronous config/SDK loading to reach the deliberately blocked select.
  while (!f.calls.includes('acquire')) await new Promise(resolve => setImmediate(resolve));
  const shutdown = f.events.get('session_shutdown')({ reason: 'reload' }, f.ctx);
  assert.deepEqual(f.input(), { action: 'continue' });
  release(); await opening; await shutdown;
  assert.equal(f.instances[0].lock, false);
  assert.deepEqual(f.input(), { action: 'continue' });
  assert.equal(f.calls.filter(value => value === 'dispose').length, 1);
});

test('new, resumed, forked and reloaded host sessions stay inactive until explicitly reopened', async () => {
  const f = fixture();
  for (const reason of ['new', 'resume', 'fork', 'reload']) {
    await f.command('');
    await f.events.get('session_start')({ reason }, f.ctx);
    assert.equal(f.instances.at(-1).lock, false);
    assert.deepEqual(f.input(), { action: 'continue' });
  }
});

test('exit reports a cleanup error without leaving input ownership or late editor changes', async () => {
  const f = fixture();
  await f.command('');
  let rejectPrompt;
  f.state.promptGate = new Promise((_resolve, reject) => { rejectPrompt = reject; });
  assert.deepEqual(f.input('Discover draft'), { action: 'handled' });
  f.state.failDispose = true;
  await f.command('exit');
  assert.match(f.notices.at(-1)[0], /Draft save failed/);
  assert.deepEqual(f.input(), { action: 'continue' });
  const count = f.notices.length;
  rejectPrompt(new Error('Aborted old prompt')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notices.length, count);
  assert.ok(!f.calls.some(value => Array.isArray(value) && value[0] === 'editor'));
});
