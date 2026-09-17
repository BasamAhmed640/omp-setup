import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ResearchVault } from '../src/vault.mjs';
import { ResearchController } from '../src/controller.mjs';
import { durableSession, readSessionEntries } from '../src/session-store.mjs';
import { parseCommand, scholarOwnsInput } from '../src/config.mjs';
import { ANSWER_GUIDE } from '../src/prompt.mjs';
import { RESEARCH_COMPACTION_GUIDE } from '../src/context.mjs';

const sdkPath = process.env.PI_RESEARCH_SDK;
const sdk = sdkPath ? await import(pathToFileURL(sdkPath)) : null;
const ai = sdkPath ? await import(process.env.PI_RESEARCH_AI ? pathToFileURL(process.env.PI_RESEARCH_AI) : new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', pathToFileURL(sdkPath))) : null;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-research-runtime-'));
  await mkdir(join(directory, 'vault', '.obsidian'), { recursive: true });
  const vault = await ResearchVault.bind(join(directory, 'vault'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, vault };
}
async function modelFixture(t, modelOptions = {}) {
  const fixtureData = await fixture(t);
  const runtime = await sdk.ModelRuntime.create({ authPath: join(fixtureData.directory, 'auth.json'), modelsPath: null, modelsStorePath: join(fixtureData.directory, 'models.json'), refreshOnCreate: false });
  const fake = ai.fauxProvider({ provider: 'research-test', models: [{ id: 'test', input: ['text', 'image'], ...modelOptions }], tokensPerSecond: 100000 });
  runtime.registerNativeProvider(fake.provider);
  const model = runtime.getModel('research-test', 'test');
  assert.ok(model);
  const controller = new ResearchController(sdk, fixtureData.vault, { modelRuntime: runtime });
  await controller.acquire();
  t.after(() => controller.dispose());
  return { ...fixtureData, runtime, fake, model, controller };
}

async function longConversation({ controller, model, vault }, lastUsage) {
  await controller.newConversation('Long investigation', { model });
  // Complete turns cross Pi's default recent-history budget without changing its settings.
  for (let turn = 0; turn < 3; turn++) {
    const timestamp = Date.now() - 10000 + turn * 2;
    controller.manager.appendMessage({ role: 'user', content: `QUESTION_${turn} ` + 'source question '.repeat(1100), timestamp });
    const answer = ai.fauxAssistantMessage(`EVIDENCE_${turn} [[Sources/study.md]] page 7: uncertainty remains. ` + 'study evidence '.repeat(4800), { timestamp: timestamp + 1 });
    controller.manager.appendMessage({ ...answer, api: model.api, provider: model.provider, model: model.id,
      usage: { ...answer.usage, input: lastUsage, totalTokens: lastUsage } });
  }
  await controller.pending;
  const conversation = await vault.getConversation(controller.conversation.id);
  await controller.select(conversation, { model });
  return conversation;
}

test('a failed research summary falls back to native compaction without modifying original history', { skip: !sdk }, async t => {
  const data = await modelFixture(t, { contextWindow: 200000 });
  const { controller, fake, vault } = data;
  const conversation = await longConversation(data, 190000), before = await readFile(await vault.safePath(conversation.sessionFile));
  let attempts = 0;
  controller.sdk = { ...sdk, compact: async () => { attempts++; throw new Error('Unavailable research summary'); } };
  fake.setResponses([ai.fauxAssistantMessage('FALLBACK_NATIVE_SUMMARY'), ai.fauxAssistantMessage('The conversation continues after fallback.')]);
  await controller.prompt('Continue.');
  assert.equal(attempts, 1);
  assert.equal(fake.state.callCount, 2);
  assert.deepEqual((await readFile(await vault.safePath(conversation.sessionFile))).subarray(0, before.length), before);
  assert.match(JSON.stringify(controller.session.messages), /FALLBACK_NATIVE_SUMMARY/);
});

test('Discover automatically compacts near the limit, preserves originals, and resumes the compacted context', { skip: !sdk }, async t => {
  const data = await modelFixture(t, { contextWindow: 200000 });
  const { vault, controller, model, fake, runtime } = data;
  // Provider-reported usage is above Pi's default reserve threshold but below the model limit.
  const conversation = await longConversation(data, 190000);
  const file = await vault.safePath(conversation.sessionFile);
  const before = await readFile(file);
  const events = [];
  controller.session.subscribe(event => { if (event.type === 'compaction_end') events.push(event); });
  let summaryRequest, answerRequest;
  fake.setResponses([
    context => { summaryRequest = context; return ai.fauxAssistantMessage('RESEARCH_SUMMARY: compare the studies; [[Sources/study.md]] page 7; uncertainty remains.'); },
    context => { answerRequest = context; return ai.fauxAssistantMessage('The investigation continues.'); },
  ]);
  await controller.prompt('Continue comparing the studies.', [], { model });
  assert.equal(fake.state.callCount, 2, 'Native compaction and the answer each make one request; no manual command or reviewer.');
  assert.match(JSON.stringify(summaryRequest.messages), /EVIDENCE_0/);
  assert.ok(summaryRequest.systemPrompt.includes(RESEARCH_COMPACTION_GUIDE));
  assert.match(JSON.stringify(answerRequest.messages), /RESEARCH_SUMMARY/);
  assert.match(JSON.stringify(answerRequest.messages), /EVIDENCE_2/);
  assert.doesNotMatch(JSON.stringify(answerRequest.messages), /EVIDENCE_0/);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'threshold');
  assert.equal(events[0].aborted, false);
  assert.ok(events[0].result.estimatedTokensAfter < events[0].result.tokensBefore);
  const entries = readSessionEntries(file);
  assert.equal(entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.deepEqual((await readFile(file)).subarray(0, before.length), before, 'Compaction appends a summary without rewriting original history.');
  const visible = await vault.getMessages(conversation.id);
  assert.equal(visible.length, 8);
  assert.ok(visible.some(message => message.text.includes('EVIDENCE_0')));
  assert.ok(!visible.some(message => message.text.includes('RESEARCH_SUMMARY')), 'Internal compaction does not become an extra answer in Obsidian.');
  await controller.dispose();
  const resumed = new ResearchController(sdk, vault, { modelRuntime: runtime });
  t.after(() => resumed.dispose());
  await resumed.acquire(); await resumed.select(conversation, { model });
  assert.equal(fake.state.callCount, 2, 'Reopening restores the saved summary without a new summarization request.');
  assert.match(JSON.stringify(resumed.session.messages), /RESEARCH_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(resumed.session.messages), /EVIDENCE_0/);
  assert.equal((await vault.getMessages(conversation.id)).length, visible.length);
  fake.setResponses([ai.fauxAssistantMessage('Continuing after reopening.')]);
  await resumed.prompt('What remains uncertain?', [], { model });
  assert.equal(fake.state.callCount, 3, 'Stale pre-compaction token usage must not trigger another summary.');
  fake.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('recall_conversation', { query: 'EVIDENCE_0', maxChars: 500 }), { stopReason: 'toolUse' }),
    context => {
      const result = context.messages.findLast(message => message.role === 'toolResult');
      const match = JSON.parse(result.content[0].text).matches.find(item => item.role === 'assistant');
      assert.match(match.text, /EVIDENCE_0.*page 7/);
      assert.match(match.provenance, /not independent evidence/);
      assert.equal(match.entryId, entries.find(entry => entry.message?.role === 'assistant' && JSON.stringify(entry.message.content).includes('EVIDENCE_0')).id);
      return ai.fauxAssistantMessage('I recovered the archived passage; it remains an earlier answer, not independent proof.');
    },
  ]);
  await resumed.prompt('Recover the EVIDENCE_0 passage.', [], { model });
  assert.equal(fake.state.callCount, 5, 'Original recall uses a tool round trip, with no new summary or memory agent.');
});

test('a context overflow compacts and retries the Discover answer automatically without duplicating the question', { skip: !sdk }, async t => {
  const data = await modelFixture(t, { contextWindow: 200000 });
  const { vault, controller, model, fake } = data;
  const conversation = await longConversation(data, 40000);
  const events = [];
  controller.session.subscribe(event => { if (event.type === 'compaction_end') events.push(event); });
  let retryRequest;
  fake.setResponses([
    ai.fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'maximum context length exceeded' }),
    ai.fauxAssistantMessage('OVERFLOW_SUMMARY: studies, sources and unresolved disagreements.'),
    context => { retryRequest = context; return ai.fauxAssistantMessage('Recovered answer without user intervention.'); },
  ]);
  await controller.prompt('Compare the strongest evidence.', [], { model });
  assert.equal(fake.state.callCount, 3, 'Failed request, native summary and automatic retry.');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'overflow');
  assert.equal(events[0].willRetry, true);
  assert.equal(events[0].aborted, false);
  assert.match(JSON.stringify(retryRequest.messages), /OVERFLOW_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(retryRequest.messages), /maximum context length exceeded/);
  const entries = readSessionEntries(await vault.safePath(conversation.sessionFile));
  assert.ok(entries.some(entry => entry.type === 'compaction'));
  assert.ok(entries.some(entry => entry.type === 'message' && entry.message.errorMessage === 'maximum context length exceeded'), 'Native error history remains archived.');
  const visible = await vault.getMessages(conversation.id);
  assert.equal(visible.filter(message => message.role === 'user' && message.text === 'Compare the strongest evidence.').length, 1);
  assert.equal(visible.at(-1).text, 'Recovered answer without user intervention.');
  assert.equal(controller.busy, false);
  const stream = await vault.readJson(`_Research/stream/${conversation.id}.json`);
  assert.equal(stream.status, 'complete');
  assert.equal(stream.text, '');
});

test('automatic compaction continues a tool-driven investigation within the same submitted question', { skip: !sdk }, async t => {
  const data = await modelFixture(t, { contextWindow: 150000 });
  const { vault, controller, model, fake } = data;
  await longConversation(data, 40000);
  await vault.writeText('Knowledge/Latest.md', '# Latest source\nCURRENT_SOURCE_POINT\n' + 'relevant detail '.repeat(150));
  const events = [];
  controller.session.subscribe(event => { if (['tool_execution_end', 'compaction_start'].includes(event.type)) events.push(event.type); });
  let answerRequest;
  fake.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Latest.md' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('TOOL_TURN_SUMMARY: compare studies and retain their source references.'),
    context => { answerRequest = context; return ai.fauxAssistantMessage('The new source supports a qualified conclusion.'); },
  ]);
  await controller.prompt('Check the latest source and finish the comparison.', [], { model });
  assert.equal(fake.state.callCount, 3, 'Tool request, automatic summary, then continuation without another user prompt.');
  assert.deepEqual(events, ['tool_execution_end', 'compaction_start']);
  assert.match(JSON.stringify(answerRequest.messages), /TOOL_TURN_SUMMARY/);
  const result = answerRequest.messages.find(message => message.role === 'toolResult' && message.toolName === 'read_note');
  assert.ok(result);
  assert.match(JSON.stringify(result), /CURRENT_SOURCE_POINT/);
  assert.ok(answerRequest.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.id === result.toolCallId)), 'Compaction keeps the retained result paired with its tool call.');
  const visible = await vault.getMessages(controller.conversation.id);
  assert.equal(visible.at(-1).text, 'The new source supports a qualified conclusion.');
});

test('command paths preserve Windows backslashes; Scholar ownership is branch-local', () => {
  assert.deepEqual(parseCommand('vault "C:\\My Notes\\Discover"'), { command: 'vault', argument: 'C:\\My Notes\\Discover' });
  assert.equal(scholarOwnsInput([{ type: 'custom', customType: 'scholar-active-v3', data: { active: true, mode: 'learn' } }]), true);
  assert.equal(scholarOwnsInput([{ type: 'custom', customType: 'scholar-active-v3', data: { active: true, mode: 'learn' } }, { type: 'custom', customType: 'scholar-active-v3', data: { active: false } }]), false);
});

test('native session persists the first user message and repairs only a torn final append', { skip: !sdk }, async t => {
  const { vault } = await fixture(t);
  const conversation = await vault.createConversation('Durability');
  const file = await vault.safePath(conversation.path + '/session.jsonl');
  const manager = durableSession(sdk, { root: vault.root, file, id: conversation.id });
  const userId = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Before the first response' }], timestamp: Date.now() });
  const saved = readSessionEntries(file);
  assert.equal(saved.at(-1).id, userId);
  await writeFile(file, '{"type":', { flag: 'a' });
  assert.equal(readSessionEntries(file).at(-1).id, userId);
  assert.equal(await readFile(file + '.interrupted', 'utf8'), '{"type":');
  assert.throws(() => durableSession(sdk, { root: vault.root, file, id: 'different' }), /different conversation/);
  const loaded = sdk.SessionManager.open(file);
  assert.equal(loaded.getEntry(userId).message.role, 'user');
});

test('real Pi SDK routes a photo and tool turn, isolates ambient instructions, and resumes offline history', { skip: !sdk }, async t => {
  const { vault, controller, fake, model, runtime } = await modelFixture(t);
  await writeFile(join(vault.root, 'AGENTS.md'), 'SCHOLAR_AMBIENT_MARKER_MUST_NOT_ENTER_THE_MODEL');
  await vault.writeText('Knowledge/Photo.md', '# Photo notes\nInspect the visible details.');
  let request;
  const toolRequests = [];
  fake.setResponses([
    context => { request = context; toolRequests.push(context.systemPrompt); return ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Photo.md' }), { stopReason: 'toolUse' }); },
    context => { toolRequests.push(context.systemPrompt); return ai.fauxAssistantMessage('A calm answer with a saved photo.'); },
  ]);
  await controller.newConversation('Photo research', { model });
  await controller.prompt('Describe this image.', [{ type: 'image', mimeType: 'image/png', data: png }], { model });
  assert.equal(fake.state.callCount, 2, 'A tool round trip uses no additional writing/reviewer request.');
  for (const prompt of toolRequests) assert.equal(prompt.split(ANSWER_GUIDE).length, 2, 'The response guide reaches the model once on each side of a tool call.');
  assert.ok(request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image' && part.data === png)));
  assert.ok(!JSON.stringify(request).includes('SCHOLAR_AMBIENT_MARKER'));
  const names = request.tools.map(tool => tool.name);
  assert.ok(names.includes('save_visual'));
  assert.equal(names.length, 11);
  assert.ok(!names.some(name => ['bash', 'write', 'scholar_quiz', 'read', 'save_context'].includes(name)));
  const messages = await vault.getMessages(controller.conversation.id);
  await assert.rejects(vault.readText(`${controller.conversation.path}/Context.md`), { code: 'ENOENT' });
  assert.ok(!controller.manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.isError));
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  assert.equal(messages.filter(message => message.text.includes('calm answer')).length, 1);
  assert.ok(messages.find(message => message.role === 'user').attachments.length);
  const imagePath = messages.find(message => message.role === 'user').attachments[0].path;
  assert.ok(JSON.stringify(request.messages).includes(imagePath), 'The model receives a stable vault reference for reopening the image.');
  assert.equal(messages.find(message => message.role === 'user').text, 'Describe this image.', 'Internal image references do not clutter the visible message.');
  const selected = await vault.getConversation(controller.conversation.id);
  assert.ok((await readFile(await vault.safePath(selected.sessionFile), 'utf8')).includes('Describe this image.'));
  const callCount = fake.state.callCount;
  await controller.dispose();
  const next = new ResearchController(sdk, vault, { modelRuntime: runtime });
  t.after(() => next.dispose());
  await next.acquire(); await next.select(selected, { model });
  assert.equal(fake.state.callCount, callCount);
  assert.equal((await vault.getMessages(selected.id)).length, messages.length);
});

test('Ask and Deep change the next model request without changing models, tools, or invoking a turn', { skip: !sdk }, async t => {
  const { vault, controller, fake, model } = await modelFixture(t);
  await vault.writeText('Style/Voice.md', 'VOICE_PREFERENCE_REMAINS_IN_BOTH_MODES');
  const requests = [];
  fake.setResponses(Array.from({ length: 3 }, () => (context, options, state, requestedModel) => {
    requests.push({ prompt: context.systemPrompt, tools: context.tools.map(tool => tool.name), model: [requestedModel.provider, requestedModel.id] });
    return ai.fauxAssistantMessage('A mode-appropriate response.');
  }));
  await controller.newConversation('Effort choices', { model });
  assert.equal(controller.effort, 'ask');
  assert.equal(fake.state.callCount, 0);
  await controller.prompt('Explain the topic.', [], { model });
  const session = controller.session;
  controller.effort = 'deep';
  assert.equal(fake.state.callCount, 1);
  await controller.prompt('Investigate further.', [], { model });
  controller.effort = 'ask';
  assert.equal(fake.state.callCount, 2);
  await controller.prompt('Give me the short answer.', [], { model });
  assert.equal(controller.session, session);
  assert.equal(fake.state.callCount, 3);
  assert.notEqual(requests[0].prompt, requests[1].prompt);
  assert.equal(requests[0].prompt, requests[2].prompt);
  assert.match(requests[0].prompt, /\bAsk\b/i);
  assert.match(requests[1].prompt, /\bDeep\b/i);
  for (const request of requests) {
    assert.equal(request.prompt.split(ANSWER_GUIDE).length, 2, 'Ask and Deep both carry the response guide exactly once.');
    assert.match(request.prompt, /VOICE_PREFERENCE_REMAINS_IN_BOTH_MODES/);
    assert.deepEqual(request.model, [model.provider, model.id]);
    assert.deepEqual(request.tools, requests[0].tools);
    assert.equal(request.tools.length, 11);
  }
});

test('new forks copy exact ancestry and resume independently without later history, drafts, or checkpoints', { skip: !sdk }, async t => {
  const { vault, controller, fake, model, runtime } = await modelFixture(t);
  await vault.writeText('Knowledge/Origin.md', '# Origin\nORIGINAL_NOTE_AT_FORK_POINT');
  await controller.continueNote('Knowledge/Origin.md', { model });
  fake.setResponses([ai.fauxAssistantMessage('FORK_POINT_FACT'), ai.fauxAssistantMessage('LATER_SOURCE_FACT')]);
  await controller.prompt('Start from this note.', [], { model });
  const point = controller.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
  const ancestry = JSON.parse(JSON.stringify(controller.manager.getBranch(point.id)));
  await controller.prompt('A later source question.', [], { model });
  controller.manager.appendCompaction('LATER_COMPACTION_MUST_NOT_LEAK', point.id, 100);
  await controller.pending;
  const source = await vault.getConversation(controller.conversation.id);
  await vault.writeText('Knowledge/Origin.md', '# Origin\nLATER_NOTE_EDIT_MUST_NOT_LEAK');
  await vault.writeText(`${source.path}/Context.md`, 'LATER_CHECKPOINT_MUST_NOT_LEAK');
  await controller.preserveDraft('SOURCE_DRAFT_MUST_NOT_LEAK', [{ type: 'image', mimeType: 'image/png', data: png }]);
  const sourceFile = await vault.safePath(source.sessionFile);
  const sourceBytes = await readFile(sourceFile);
  const sourceMessages = await vault.getMessages(source.id);
  const sourceDraft = await vault.readText(`${source.path}/draft.json`);
  const calls = fake.state.callCount;
  vault.search = async () => { throw new Error('Forking must not scan the vault.'); };
  await controller.fork(source, point.id, { model });
  const child = await vault.getConversation(controller.conversation.id);
  assert.notEqual(child.id, source.id);
  assert.equal(fake.state.callCount, calls);
  assert.deepEqual(controller.manager.getBranch(point.id), ancestry);
  const copied = readSessionEntries(await vault.safePath(child.sessionFile));
  assert.equal(copied[0].id, child.id);
  assert.deepEqual(copied.slice(1, ancestry.length + 1), ancestry);
  assert.doesNotMatch(JSON.stringify(copied), /LATER_SOURCE_FACT|LATER_COMPACTION_MUST_NOT_LEAK|SOURCE_DRAFT_MUST_NOT_LEAK/);
  const origin = await vault.readJson(`${child.path}/origin.json`);
  assert.equal(origin.kind, 'fork');
  assert.equal(origin.conversationId, source.id);
  assert.equal(origin.entryId, point.id);
  assert.equal(controller.contextNote, null);
  assert.deepEqual(controller.attachments, []);
  assert.equal((await vault.getMessages(child.id)).length, 2);
  await controller.dispose();
  const resumed = new ResearchController(sdk, vault, { modelRuntime: runtime });
  t.after(() => resumed.dispose());
  await resumed.acquire(); await resumed.select(child, { model });
  assert.equal(fake.state.callCount, calls);
  let request;
  fake.setResponses([
    context => { request = context; return ai.fauxAssistantMessage(ai.fauxToolCall('recall_conversation', { query: 'FACT', maxChars: 2000 }), { stopReason: 'toolUse' }); },
    context => {
      const recalled = JSON.stringify(context.messages.findLast(message => message.role === 'toolResult'));
      assert.match(recalled, /FORK_POINT_FACT/);
      assert.doesNotMatch(recalled, /LATER_SOURCE_FACT/);
      return ai.fauxAssistantMessage('INDEPENDENT_CHILD_ANSWER');
    },
  ]);
  await resumed.prompt('Take a different direction.', [], { model });
  assert.match(JSON.stringify(request), /FORK_POINT_FACT/);
  assert.match(JSON.stringify(request), /ORIGINAL_NOTE_AT_FORK_POINT/);
  assert.doesNotMatch(JSON.stringify(request), /LATER_SOURCE_FACT|LATER_COMPACTION_MUST_NOT_LEAK|LATER_NOTE_EDIT_MUST_NOT_LEAK|LATER_CHECKPOINT_MUST_NOT_LEAK|SOURCE_DRAFT_MUST_NOT_LEAK/);
  assert.equal((await vault.getMessages(child.id)).length, 4);
  assert.deepEqual(await readFile(sourceFile), sourceBytes);
  assert.deepEqual(await vault.getMessages(source.id), sourceMessages);
  assert.equal(await vault.readText(`${source.path}/draft.json`), sourceDraft);
});

test('invalid fork points and an active answer cannot create orphan conversations', { skip: !sdk }, async t => {
  const { vault, controller, fake, model } = await modelFixture(t);
  await controller.newConversation('Source', { model });
  fake.setResponses([ai.fauxAssistantMessage('First saved answer.')]);
  await controller.prompt('First question.', [], { model });
  const source = await vault.getConversation(controller.conversation.id);
  const point = controller.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
  const directory = await vault.safePath('Conversations');
  const before = await readdir(directory);
  await assert.rejects(controller.fork(source, 'missing-entry', { model }), /entry|point|found/i);
  assert.deepEqual(await readdir(directory), before);
  assert.equal(controller.conversation.id, source.id);
  const calls = fake.state.callCount;
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fake.setResponses([async () => { began(); await gate; return ai.fauxAssistantMessage('Second saved answer.'); }]);
  const running = controller.prompt('Stay busy for this check.', [], { model });
  try {
    await started;
    await assert.rejects(controller.fork(source, point.id, { model }), /stop|running|answer/i);
    assert.deepEqual(await readdir(directory), before);
    assert.equal(controller.conversation.id, source.id);
    assert.equal(fake.state.callCount, calls + 1);
  } finally { release(); await running; }
});

test('fork reads never repair or rewrite the source session file', { skip: !sdk }, async t => {
  const { vault, controller, fake, model } = await modelFixture(t);
  await controller.newConversation('Source file preservation', { model });
  fake.setResponses([ai.fauxAssistantMessage('A saved branch point.')]);
  await controller.prompt('Keep this exact source.', [], { model });
  const source = await vault.getConversation(controller.conversation.id);
  const point = controller.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
  const sourceFile = await vault.safePath(source.sessionFile);
  const original = await readFile(sourceFile);
  const torn = Buffer.concat([original, Buffer.from('{"type":')]);
  const directory = await vault.safePath('Conversations');
  const before = await readdir(directory);
  await writeFile(sourceFile, torn);
  await assert.rejects(controller.fork(source, point.id, { model }), /Corrupt Pi session/);
  assert.deepEqual(await readFile(sourceFile), torn);
  await assert.rejects(readFile(sourceFile + '.interrupted'), { code: 'ENOENT' });
  assert.deepEqual(await readdir(directory), before);
  assert.equal(controller.conversation.id, source.id);
  assert.equal(original.at(-1), 10);
  const withoutNewline = original.subarray(0, -1);
  await writeFile(sourceFile, withoutNewline);
  await controller.fork(source, point.id, { model });
  assert.notEqual(controller.conversation.id, source.id);
  assert.equal((await vault.getMessages(controller.conversation.id)).length, 2);
  assert.deepEqual(await readFile(sourceFile), withoutNewline);
  await assert.rejects(readFile(sourceFile + '.interrupted'), { code: 'ENOENT' });
  assert.equal(fake.state.callCount, 1);
});

test('legacy forks resume exact saved ancestry without injecting later notes or checkpoints', { skip: !sdk }, async t => {
  const { vault, controller, fake, model } = await modelFixture(t);
  fake.setResponses([ai.fauxAssistantMessage('FIRST_BRANCH_FACT'), ai.fauxAssistantMessage('LATER_BRANCH_FACT')]);
  await controller.newConversation('Branches', { model });
  await controller.prompt('First question', [], { model });
  const first = controller.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
  await controller.prompt('Later question', [], { model });
  const original = await vault.getConversation(controller.conversation.id);
  await vault.writeText(`${original.path}/Context.md`, 'LATER_CHECKPOINT_SHOULD_NOT_LEAK');
  // A 0.1.x fork is a normal native session with its saved branch and origin metadata.
  const target = await vault.createConversation('Existing 0.1.x fork');
  const entries = readSessionEntries(await vault.safePath(original.sessionFile));
  const native = sdk.SessionManager.inMemory(vault.root, {}, entries);
  const sessionFile = `${target.path}/session.jsonl`;
  const header = { ...entries[0], id: target.id };
  await writeFile(await vault.safePath(sessionFile), [header, ...native.getBranch(first.id)].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const legacy = await vault.setSessionFile(target.id, sessionFile);
  await vault.writeJson(`${target.path}/origin.json`, { kind: 'fork', conversationId: original.id, entryId: first.id });
  await vault.writeText(`${target.path}/Context.md`, 'LEGACY_CHECKPOINT_REMAINS_READABLE');
  await controller.select(legacy, { model });
  const forkContext = JSON.stringify(controller.session.messages);
  assert.match(forkContext, /FIRST_BRANCH_FACT/);
  assert.doesNotMatch(forkContext, /LATER_BRANCH_FACT|LATER_CHECKPOINT_SHOULD_NOT_LEAK/);
  let request;
  vault.search = async () => { throw new Error('Ordinary turns must not scan the vault.'); };
  fake.setResponses([context => { request = context; return ai.fauxAssistantMessage('Continuing the saved branch.'); }]);
  await controller.prompt('Continue our discussion.', [], { model });
  assert.doesNotMatch(JSON.stringify(request), /LATER_BRANCH_FACT|LATER_CHECKPOINT_SHOULD_NOT_LEAK|LEGACY_CHECKPOINT_REMAINS_READABLE/);
  assert.equal((await vault.readNote(`${target.path}/Context.md`)).text, 'LEGACY_CHECKPOINT_REMAINS_READABLE');
});

test('note continuation reads the current human edit without scanning unrelated vault material', { skip: !sdk }, async t => {
  const { vault, controller, fake, model } = await modelFixture(t);
  await vault.writeText('Knowledge/Example.md', '# Example\nCURRENT_NOTE_REVISION');
  await vault.writeText('Knowledge/Unrelated.md', '# Unrelated\nUNRELATED_NOTE_MUST_NOT_BE_INJECTED');
  await controller.continueNote('Knowledge/Example.md', { model });
  await vault.writeText('Knowledge/Example.md', '# Example\nUSER_EDIT_BEFORE_QUESTION');
  vault.search = async () => { throw new Error('Note continuation must not scan the vault.'); };
  let noteContext;
  fake.setResponses([context => { noteContext = context; return ai.fauxAssistantMessage('A note-based answer.'); }]);
  await controller.prompt('Explain this note', [], { model });
  assert.match(JSON.stringify(noteContext), /USER_EDIT_BEFORE_QUESTION/);
  assert.doesNotMatch(JSON.stringify(noteContext), /CURRENT_NOTE_REVISION|UNRELATED_NOTE_MUST_NOT_BE_INJECTED/);
  await assert.rejects(vault.readText(`${controller.conversation.path}/loaded-context.json`), { code: 'ENOENT' });
});

test('vault writer lock rejects a second owner and is released on exit', { skip: !sdk }, async t => {
  const { vault, controller } = await modelFixture(t);
  const second = new ResearchController(sdk, vault);
  await assert.rejects(second.acquire(), /already open/);
  await controller.dispose();
  await second.acquire(); await second.dispose();
});

test('a rejected draft save cannot prevent session disposal or writer lock release', { skip: !sdk }, async t => {
  const { vault, controller, model } = await modelFixture(t);
  await controller.newConversation('Cleanup after failure', { model });
  controller.draftPending = Promise.reject(new Error('Draft write failed'));
  void controller.draftPending.catch(() => {});
  await assert.rejects(controller.dispose(), /Draft write failed/);
  assert.equal(controller.session, null);
  assert.equal(controller.streamTimer || null, null);
  await assert.rejects(readFile(await vault.safePath('_Research/writer.lock')), { code: 'ENOENT' });
  const next = new ResearchController(sdk, vault);
  await next.acquire(); await next.dispose();
  await controller.dispose();
});

test('stop during preflight sends no request and preserves the draft photo in the vault', { skip: !sdk }, async t => {
  const { vault, controller, model, fake } = await modelFixture(t);
  await controller.newConversation('Interrupted preflight', { model });
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalImport = vault.importAttachment.bind(vault);
  vault.importAttachment = async image => { began(); await gate; return originalImport(image); };
  const attempt = controller.prompt('Keep my question', [{ type: 'image', mimeType: 'image/png', data: png }], { model });
  const rejected = assert.rejects(attempt, /Stopped before sending/);
  await started; await controller.stop(); release(); await rejected;
  assert.equal(fake.state.callCount, 0);
  const draft = await vault.readJson(`${controller.conversation.path}/draft.json`);
  assert.equal(draft.text, 'Keep my question');
  assert.equal(draft.attachments.length, 1);
  assert.ok(await readFile(await vault.safePath(draft.attachments[0].path)));
});

test('the actual Pi extension loader imports the package and registers its composer commands', { skip: !sdk }, async t => {
  const { directory, vault } = await fixture(t);
  const loader = new sdk.DefaultResourceLoader({
    cwd: vault.root, agentDir: join(directory, 'isolated-agent'), settingsManager: sdk.SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../index.ts', import.meta.url))],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has('discover'));
  assert.deepEqual([...loaded.extensions[0].commands.keys()], ['discover'], 'The command menu uses only the current product name.');
  const tui = await import(new URL('../node_modules/@earendil-works/pi-tui/dist/index.js', pathToFileURL(sdkPath)));
  const autocomplete = new tui.CombinedAutocompleteProvider([{ name: 'discover', ...loaded.extensions[0].commands.get('discover') }], directory);
  for (const [input, expected] of [['/discover de', '/discover deep'], ['/discover att', '/discover attach '], ['/discover help va', '/discover help vault']]) {
    const suggestions = await autocomplete.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
    assert.equal(suggestions.items.length, 1);
    assert.ok(suggestions.items[0].description);
    const applied = autocomplete.applyCompletion([input], 0, input.length, suggestions.items[0], suggestions.prefix);
    assert.equal(applied.lines[0], expected);
  }
  const menu = await autocomplete.getSuggestions(['/discover '], 0, 10, { signal: new AbortController().signal });
  assert.ok(menu.items.some(item => item.label === 'help'));
  assert.ok(menu.items.some(item => item.label === 'ask'));
  assert.ok(menu.items.some(item => item.label === 'vault'));
  assert.ok(loaded.extensions[0].handlers.has('input'));
  const notifications = [];
  const ctx = { ui: { notify: message => notifications.push(message) } };
  for (const [name, command] of [['discover', 'context'], ['discover', 'invalid-command']]) {
    // No configured vault or other context is needed to reject retired commands.
    await loaded.extensions[0].commands.get(name).handler(command, ctx);
  }
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(message => message.includes('Unknown Discover command')));
  notifications.length = 0;
  ctx.isIdle = () => false;
  for (const command of ['ask', 'deep', 'fork source entry', 'branch source entry']) {
    // The idle guard verifies recognized commands without opening the user's configured vault.
    await loaded.extensions[0].commands.get('discover').handler(command, ctx);
  }
  assert.equal(notifications.length, 4);
  assert.ok(notifications.every(message => message.includes('Finish or stop the current Pi turn')));

  // Exercise the real lazy SDK import and controller, not only command registration.
  const savedEnv = Object.fromEntries(['PI_RESEARCH_CONFIG_DIR', 'PI_SCHOLAR_STATE_ROOT', 'PI_SCHOLAR_OBSIDIAN_ROOT'].map(key => [key, process.env[key]]));
  process.env.PI_RESEARCH_CONFIG_DIR = join(directory, 'discover-config');
  process.env.PI_SCHOLAR_STATE_ROOT = join(directory, 'no-scholar');
  delete process.env.PI_SCHOLAR_OBSIDIAN_ROOT;
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await mkdir(process.env.PI_RESEARCH_CONFIG_DIR);
  await writeFile(join(process.env.PI_RESEARCH_CONFIG_DIR, 'config.json'), JSON.stringify({ version: 1, vaultRoot: vault.root, vaultId: vault.id }));
  const runtime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, modelsStorePath: join(directory, 'models.json'), refreshOnCreate: false });
  const fake = ai.fauxProvider({ provider: 'activation-test', models: [{ id: 'test' }], tokensPerSecond: 100000 });
  runtime.registerNativeProvider(fake.provider);
  Object.assign(ctx, { isIdle: () => true, hasUI: false, sessionManager: { getBranch: () => [] }, modelRegistry: new sdk.ModelRegistry(runtime), model: runtime.getModel('activation-test', 'test') });
  const statuses = [];
  Object.assign(ctx.ui, { setStatus: (...args) => statuses.push(args), getEditorText: () => '', setEditorText: () => assert.fail('Ordinary input was altered') });
  const extension = loaded.extensions[0];
  const input = event => extension.handlers.get('input')[0](event, ctx);
  const shutdown = () => extension.handlers.get('session_shutdown')[0]({ reason: 'reload' }, ctx);
  t.after(shutdown);
  notifications.length = 0;
  await extension.commands.get('discover').handler(`vault "${vault.root}"`, ctx);
  assert.match(notifications.at(-1), /companion is installed/);
  for(const name of ['main.js','styles.css','manifest.json'])assert.ok(await readFile(await vault.safePath(`.obsidian/plugins/pi-research/${name}`)));
  assert.deepEqual(input({ text: 'ordinary', source: 'interactive' }), { action: 'continue' });
  assert.deepEqual(statuses, []);
  await assert.rejects(readFile(await vault.safePath('_Research/writer.lock')), { code: 'ENOENT' });
  await extension.commands.get('discover').handler('deep', ctx);
  assert.match(notifications.at(-1), /Discover ready/);
  assert.match(statuses.at(-1)[1], /^Deep/);
  assert.ok(await readFile(await vault.safePath('_Research/writer.lock')));
  assert.equal(fake.state.callCount, 0, 'Opening alone must not ask any model to do work.');
  await shutdown();
  assert.deepEqual(input({ text: 'ordinary photo', images: [{ type: 'image', mimeType: 'image/png', data: png }], source: 'interactive' }), { action: 'continue' });
  assert.deepEqual(statuses.at(-1), ['pi-research', undefined]);
  await assert.rejects(readFile(await vault.safePath('_Research/writer.lock')), { code: 'ENOENT' });
  assert.equal(fake.state.callCount, 0);
});
