import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ResearchVault } from '../src/vault.mjs';
import { ResearchController } from '../src/controller.mjs';
import { REVIEW_EVENT, REVIEW_LIMITS, REVIEW_TOOLS, evidencePacket, parseReview, shouldReview } from '../src/review.mjs';
import { readSessionEntries } from '../src/session-store.mjs';
import { createPiRuntime } from '../src/pi-models.mjs';

const sdkPath = process.env.PI_RESEARCH_SDK;
const sdk = sdkPath ? await import(pathToFileURL(sdkPath)) : null;
const ai = sdkPath ? await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', pathToFileURL(sdkPath))) : null;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const draft = 'DRAFT_WRONG: The measurement was 10 units. ' + 'The measurement affects the interpretation of the source. '.repeat(36);
const report = (verdict = 'incorrect') => JSON.stringify({ findings: [{ claim: 'The measurement was 10 units.', verdict,
  reason: 'The original passage reports 42 units.', evidence: [{ source: 'Knowledge/Original.md', excerpt: 'The measurement was 42 units.' }] }], clarity: [], limitations: ['Only the main measurement was checked.'] });

async function fixture(t, options = {}) {
  const { hostRegistry = false, modelOptions = {}, ...controllerOptions } = options;
  const directory = await mkdtemp(join(tmpdir(), 'discover-review-'));
  await mkdir(join(directory, 'vault', '.obsidian'), { recursive: true });
  const vault = await ResearchVault.bind(join(directory, 'vault'));
  const runtime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, modelsStorePath: join(directory, 'models.json'), refreshOnCreate: false });
  const fake = ai.fauxProvider({ provider: 'review-test', models: [{ id: 'same-model', input: ['text', 'image'], reasoning: true, ...modelOptions }], tokensPerSecond: 1000000 });
  runtime.registerNativeProvider(fake.provider);
  const model = runtime.getModel('review-test', 'same-model'), sessions = [];
  const observedSdk = { ...sdk, createAgentSession: async options => { const value = await sdk.createAgentSession(options); sessions.push(value.session); return value; } };
  const isolated = hostRegistry ? await createPiRuntime(sdk, { modelsStorePath: join(directory, 'isolated-models.json') }) : runtime;
  const controller = new ResearchController(observedSdk, vault, { modelRuntime: isolated, ...(hostRegistry ? { modelRegistry: new sdk.ModelRegistry(runtime) } : {}), presentationTimeoutMs: 1, ...controllerOptions });
  await controller.acquire();
  await controller.newConversation('Evidence review', { model, thinkingLevel: 'high' });
  controller.effort = 'deep';
  await vault.writeText('Knowledge/Original.md', '# Original study\nSOURCE_ORIGINAL: The measurement was 42 units.');
  t.after(async () => { await controller.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, vault, runtime, model, fake, controller, sessions };
}

test('a continuing Deep reviewer receives earlier corrections and can recover original evidence omitted by compaction', { skip: !sdk }, async t => {
  const { controller, fake, vault, model } = await fixture(t);
  controller.effort = 'ask';
  fake.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('An initial account of the source.'), ai.fauxAssistantMessage('I will retain that scope.'),
  ]);
  await controller.prompt('Compare the measurement.');
  await controller.prompt('USE_MG_ONLY: report milligrams and explain uncertainty.');
  const last = controller.manager.getEntries().findLast(entry => entry.message?.role === 'assistant');
  controller.manager.appendCompaction('DERIVED_SUMMARY: compare measurements; older source omitted.', last.id, 10000);
  await controller.select(await vault.getConversation(controller.conversation.id), { model });
  assert.doesNotMatch(JSON.stringify(controller.session.messages), /SOURCE_ORIGINAL|USE_MG_ONLY/);
  controller.effort = 'deep';
  fake.setResponses([
    ai.fauxAssistantMessage(draft),
    context => {
      const packet = JSON.parse(context.messages.at(-1).content[0].text);
      assert.equal(packet.materials[0].text, 'Continue.');
      assert.match(JSON.stringify(packet), /USE_MG_ONLY/);
      assert.ok(packet.materials.some(item => item.kind.includes('Derived compaction summary')));
      return ai.fauxAssistantMessage(ai.fauxToolCall('recall_conversation', { query: 'SOURCE_ORIGINAL', maxChars: 3000 }), { stopReason: 'toolUse' });
    },
    context => {
      const retrieved = JSON.parse(context.messages.findLast(message => message.role === 'toolResult').content[0].text);
      assert.match(retrieved.matches[0].text, /SOURCE_ORIGINAL: The measurement was 42 units/);
      assert.equal(retrieved.matches[0].toolName, 'read_note');
      return ai.fauxAssistantMessage(report('supported'));
    },
  ]);
  await controller.prompt('Continue.');
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.equal(final.review.status, 'reviewed');
  assert.equal(fake.state.callCount, 6, 'Two ordinary turns and a draft/reviewer retrieval/report; no memory model.');
  const packet = await vault.readJson(final.review.path.replace('Review.md', 'packet.json'));
  assert.match(JSON.stringify(packet), /USE_MG_ONLY/);
});

test('a reviewer that fills a small context window returns incomplete and the lead can publish an honest limitation', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t, { modelOptions: { contextWindow: 8192, maxTokens: 2000 } });
  await vault.writeText('Knowledge/Original.md', 'Original evidence '.repeat(2000));
  fake.setResponses([ai.fauxAssistantMessage(draft),
    ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md', maxChars: 20000 }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('The evidence review could not finish within its context budget. This conclusion remains unverified.'),
  ]);
  await controller.prompt('Check this measurement.');
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.equal(final.review.status, 'incomplete');
  assert.match(final.text, /unverified/);
  const saved = await vault.readJson(final.review.path.replace('Review.md', 'report.json'));
  assert.match(saved.error, /context budget exhausted/);
  assert.equal(saved.stats.requests, 1, 'The over-budget second review request never reaches the provider.');
  assert.equal(fake.state.callCount, 3);
});

test('small-window automatic compaction keeps host authentication and follows model changes', { skip: !sdk }, async t => {
  const { controller, fake, vault, runtime, model } = await fixture(t, { hostRegistry: true, modelOptions: { contextWindow: 32768, maxTokens: 2000 } });
  controller.effort = 'ask';
  const seen = [];
  runtime.registerNativeProvider({ ...fake.provider, auth: { apiKey: { name: 'Fixture auth', resolve: async () => ({
    auth: { apiKey: 'compaction-fixture-token', headers: { 'x-context-fixture': 'present' }, baseUrl: 'https://fixture.invalid/context' }, source: 'test',
  }) } }, streamSimple: (selected, context, options) => { seen.push({ selected, options }); return fake.provider.streamSimple(selected, context, options); } });
  for (let index = 0; index < 3; index++) {
    controller.manager.appendMessage({ role: 'user', content: `Question ${index}: ` + 'research '.repeat(300), timestamp: Date.now() });
    const answer = ai.fauxAssistantMessage('Older source detail. '.repeat(500));
    controller.manager.appendMessage({ ...answer, api: model.api, provider: model.provider, model: model.id, usage: { ...answer.usage, input: 28000, totalTokens: 28000 } });
  }
  await controller.pending;
  await controller.select(await vault.getConversation(controller.conversation.id), { model });
  fake.setResponses([
    context => { assert.match(context.systemPrompt, /latest corrections/); return ai.fauxAssistantMessage('SMALL_WINDOW_RESEARCH_SUMMARY'); },
    ai.fauxAssistantMessage('A continued answer.'),
  ]);
  await controller.prompt('Continue.');
  assert.equal(fake.state.callCount, 2);
  assert.match(JSON.stringify(controller.session.messages), /SMALL_WINDOW_RESEARCH_SUMMARY/);
  assert.equal(controller.session.settingsManager.getCompactionReserveTokens(), 8192);
  assert.ok(seen.every(item => item.options.apiKey === 'compaction-fixture-token' && item.options.headers['x-context-fixture'] === 'present' && item.selected.baseUrl === 'https://fixture.invalid/context'));
  const other = ai.fauxProvider({ provider: 'larger-window', models: [{ id: 'large', contextWindow: 200000 }] });
  runtime.registerNativeProvider(other.provider);
  other.setResponses([ai.fauxAssistantMessage('A normal model switch.')]);
  await controller.prompt('One more answer.', [], { model: runtime.getModel('larger-window', 'large') });
  assert.equal(controller.session.settingsManager.getCompactionReserveTokens(), 16384);
  assert.equal(controller.session.settingsManager.getCompactionKeepRecentTokens(), 20000);
  const native = await vault.readText(controller.conversation.sessionFile || `${controller.conversation.path}/session.jsonl`);
  assert.doesNotMatch(native, /compaction-fixture-token/);
});

test('review routing, bounded packets and report schema reject unverifiable success', () => {
  assert.equal(shouldReview([], { message: { content: 'Hello.' } }), false);
  assert.equal(shouldReview([], { message: { content: draft } }), true);
  assert.equal(shouldReview([{ message: { role: 'toolResult', toolName: 'read_pdf' } }], { message: { content: 'Evidence '.repeat(70) } }), true);
  const packet = evidencePacket([{ message: { role: 'user', content: [{ type: 'text', text: 'Question '.repeat(100) }, { type: 'image', mimeType: 'image/png', data: png }] } }],
    { id: 'draft', message: { content: draft } }, { ...REVIEW_LIMITS, packetChars: 100, images: 0 });
  assert.ok(packet.materials.reduce((sum, item) => sum + item.text.length, 0) <= 100);
  assert.equal(packet.images.length, 0);
  assert.ok(packet.limitations.length);
  assert.equal(parseReview(report()).findings[0].verdict, 'incorrect');
  assert.throws(() => parseReview('looks fine'), SyntaxError);
  assert.throws(() => parseReview('{"findings":[],"clarity":[],"limitations":[]}'), /invalid report/);
  const selected = evidencePacket([{ type: 'custom_message', customType: 'pi-research-context', content: 'SELECTED_NOTE' }], { id: 'draft', message: { content: draft } });
  assert.ok(selected.materials.some(item => item.text === 'SELECTED_NOTE'));
  const unsupported = JSON.parse(report()); unsupported.findings[0].evidence = [];
  assert.throws(() => parseReview(JSON.stringify(unsupported)), /invalid finding/);
});

test('same-model reviewer inspects original evidence and photos before one corrected answer is published', { skip: !sdk }, async t => {
  const { controller, fake, vault, sessions } = await fixture(t);
  let reviewRequest, correctionRequest;
  const visibleAnswers = [], save = vault.saveMessage.bind(vault);
  vault.saveMessage = async (id, input) => { if (input.role === 'assistant') visibleAnswers.push(input.text); return save(id, input); };
  fake.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(draft),
    async context => {
      reviewRequest = context;
      assert.deepEqual((await vault.getMessages(controller.conversation.id)).map(message => message.role), ['user']);
      const stream = await vault.readJson(`_Research/stream/${controller.conversation.id}.json`);
      assert.equal(stream.phase, 'Checking evidence'); assert.equal(stream.text, '');
      return ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md' }), { stopReason: 'toolUse' });
    },
    ai.fauxAssistantMessage(report()),
    context => { correctionRequest = context; return ai.fauxAssistantMessage('The measurement was 42 units. The original study supports that value.'); },
  ]);
  await controller.prompt('Explain the measurement and inspect the attached image.', [{ type: 'image', mimeType: 'image/png', data: png }]);
  assert.equal(sessions.length, 2, 'One lead session and one temporary reviewer; no fleet.');
  assert.equal(sessions[1].model.id, sessions[0].model.id);
  assert.equal(sessions[1].model.provider, sessions[0].model.provider);
  assert.equal(sessions[1].thinkingLevel, sessions[0].thinkingLevel);
  assert.deepEqual(reviewRequest.tools.map(tool => tool.name).sort(), [...REVIEW_TOOLS].sort());
  assert.match(JSON.stringify(reviewRequest.messages), /SOURCE_ORIGINAL/);
  assert.ok(reviewRequest.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image')));
  assert.match(JSON.stringify(correctionRequest.messages), /incorrect/);
  assert.deepEqual(visibleAnswers, ['The measurement was 42 units. The original study supports that value.']);
  const messages = await vault.getMessages(controller.conversation.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].review.status, 'reviewed');
  assert.match(await vault.readText(messages[1].review.path), /Only the main measurement was checked/);
  const entries = controller.manager.getEntries();
  assert.ok(entries.some(entry => entry.message?.content?.some?.(part => part.text === draft)), 'Original draft remains in native vault history.');
  assert.equal(entries.filter(entry => entry.customType === REVIEW_EVENT && entry.data.phase === 'publish').length, 1);
  assert.equal(fake.state.callCount, 5);
  const conversation = await vault.getConversation(controller.conversation.id);
  await controller.select(conversation);
  assert.equal((await vault.getMessages(conversation.id)).length, 2, 'Replay cannot leak the draft or add a reviewer message.');
  const sourceBytes = await readFile(await vault.safePath(conversation.sessionFile));
  await controller.fork(conversation, messages[1].nativeEntryId);
  assert.equal((await vault.getMessages(controller.conversation.id)).length, 2);
  assert.equal((await vault.getMessages(controller.conversation.id))[1].review.path, messages[1].review.path);
  assert.equal(fake.state.callCount, 5, 'Reopen and fork make no model requests.');
  assert.deepEqual(await readFile(await vault.safePath(conversation.sessionFile)), sourceBytes);
});

test('Ask and short Deep answers avoid the reviewer; a clean substantial draft needs no correction request', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  controller.effort = 'ask';
  fake.setResponses([ai.fauxAssistantMessage('A direct answer.')]);
  await controller.prompt('A simple question');
  assert.equal(fake.state.callCount, 1);
  controller.effort = 'deep';
  fake.setResponses([ai.fauxAssistantMessage('A short clarification.')]);
  await controller.prompt('A short clarification');
  assert.equal(fake.state.callCount, 2);
  fake.setResponses([ai.fauxAssistantMessage(draft), ai.fauxAssistantMessage(report('supported'))]);
  await controller.prompt('Give a substantial explanation');
  assert.equal(fake.state.callCount, 4);
  assert.equal((await vault.getMessages(controller.conversation.id)).at(-1).text, draft);
});

test('malformed review reports remain explicitly incomplete and receive one bounded lead correction', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  fake.setResponses([ai.fauxAssistantMessage(draft), ai.fauxAssistantMessage('Everything is verified!'), ai.fauxAssistantMessage('The evidence review was unavailable. Treat the measurement as unresolved.')]);
  await controller.prompt('Explain this in detail');
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.equal(final.review.status, 'incomplete');
  assert.match(await vault.readText(final.review.path), /Review incomplete/);
  assert.equal(fake.state.callCount, 3);
  controller.effort = 'ask';
  fake.setResponses([ai.fauxAssistantMessage('The next answer works normally.')]);
  await controller.prompt('Continue normally');
  assert.equal(fake.state.callCount, 4, 'Temporary request limits are restored after correction.');
});

test('reviewer retrieval and model-call budgets stop repeated tool requests', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t, { reviewLimits: { ...REVIEW_LIMITS, requests: 2, tools: 1 } });
  fake.setResponses([ai.fauxAssistantMessage(draft),
    ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('The review reached its budget. The original measurement remains 42 units.')]);
  await controller.prompt('Investigate the measurement');
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.equal(final.review.status, 'incomplete');
  assert.equal(fake.state.callCount, 4, 'The third reviewer request never reaches the model provider.');
  const result = await vault.readJson(final.review.path.replace('Review.md', 'report.json'));
  assert.equal(result.stats.requests, 2);
});

test('stopping during review cancels publication and never starts a correction agent turn', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  let begin, release;
  const began = new Promise(resolve => { begin = resolve; }), gate = new Promise(resolve => { release = resolve; });
  fake.setResponses([ai.fauxAssistantMessage(draft), async () => { begin(); await gate; return ai.fauxAssistantMessage(report()); }]);
  const running = controller.prompt('A long investigation');
  const rejected = assert.rejects(running, /Stopped/);
  await began;
  const stopping = controller.stop(); release();
  await stopping; await rejected;
  assert.equal(fake.state.callCount, 2);
  assert.equal(controller.busy, false);
  assert.equal(controller.reviewer, null);
  assert.equal((await vault.getMessages(controller.conversation.id)).length, 1);
  assert.equal((await vault.readJson(`_Research/stream/${controller.conversation.id}.json`)).phase, 'Stopped · draft saved');
});

test('review deadline is bounded and an unavailable review never receives a success label', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t, { reviewLimits: { ...REVIEW_LIMITS, timeoutMs: 5 } });
  fake.setResponses([ai.fauxAssistantMessage(draft), async () => { await new Promise(resolve => setTimeout(resolve, 30)); return ai.fauxAssistantMessage(report()); },
    ai.fauxAssistantMessage('The review timed out. This conclusion needs further verification.')]);
  await controller.prompt('Investigate this question');
  assert.equal((await vault.getMessages(controller.conversation.id)).at(-1).review.status, 'incomplete');
  assert.equal(fake.state.callCount, 3);
});

test('interrupted native drafts stay unpublished after restart and cannot be used as a public fork point', { skip: !sdk }, async t => {
  const { controller, vault, fake } = await fixture(t);
  controller.manager.appendCustomEntry(REVIEW_EVENT, { phase: 'start', turnId: 'interrupted-turn' });
  controller.manager.appendMessage({ role: 'user', content: 'Original question', timestamp: Date.now() });
  const draftId = controller.manager.appendMessage(ai.fauxAssistantMessage(draft));
  await controller.pending;
  const conversation = await vault.getConversation(controller.conversation.id);
  await controller.select(conversation);
  assert.equal(fake.state.callCount, 0);
  assert.equal((await vault.getMessages(conversation.id)).length, 1);
  assert.match((await vault.readJson(`_Research/stream/${conversation.id}.json`)).phase, /interrupted/);
  await assert.rejects(controller.fork(conversation, draftId), /unpublished draft/);
  const history = readSessionEntries(await vault.safePath(conversation.sessionFile));
  assert.ok(history.some(entry => entry.id === draftId));
  assert.ok(history.some(entry => entry.customType === REVIEW_EVENT && entry.data.phase === 'end'));
});

test('a final formatting failure preserves native drafts without publishing a broken visual answer', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  const malformed = '| A | B |\n| --- | --- |\n| one | two | extra |';
  fake.setResponses([ai.fauxAssistantMessage(malformed), ai.fauxAssistantMessage(malformed)]);
  await assert.rejects(controller.prompt('Compare these items'), /layout still needs repair/);
  assert.equal((await vault.getMessages(controller.conversation.id)).length, 1);
  assert.equal(fake.state.callCount, 2);
});

test('final layout reuses an exact current-turn check, but checks changed Markdown and later turns again', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  let requests = 0;
  const write = vault.writeJson.bind(vault);
  vault.writeJson = async (path, value) => { if (path.endsWith('.request.json')) requests++; return write(path, value); };
  const table = '| A | B |\n| --- | --- |\n| one | two |';
  fake.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('check_presentation', { markdown: table }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(table), ai.fauxAssistantMessage(table),
  ]);
  await controller.prompt('Compare these items');
  assert.equal(requests, 1, 'Reuse the exact draft check, including an honest unverified result.');
  fake.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('check_presentation', { markdown: table }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(table + '\n\nA changed explanation.'), ai.fauxAssistantMessage('One and two are the compared items.'),
  ]);
  await controller.prompt('Explain the comparison');
  assert.equal(requests, 3, 'Changed final Markdown gets its own rendered request.');
  fake.setResponses([ai.fauxAssistantMessage(table), ai.fauxAssistantMessage('One and two.')]);
  await controller.prompt('Compare again');
  assert.equal(requests, 4, 'Earlier-turn checks are not reused.');
});

test('the reviewer cannot call a knowledge-writing tool even when it tries', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  fake.setResponses([ai.fauxAssistantMessage(draft),
    ai.fauxAssistantMessage(ai.fauxToolCall('save_knowledge', { title: 'Unauthorized', text: 'A reviewer edit', sources: [] }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(report('supported'))]);
  await controller.prompt('Explain the evidence');
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  const history = readSessionEntries(await vault.safePath(final.review.path.replace('Review.md', 'session.jsonl')));
  assert.ok(history.some(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'save_knowledge' && entry.message.isError));
  await assert.rejects(vault.readText('Knowledge/Unauthorized.md'), { code: 'ENOENT' });
  assert.equal(fake.state.callCount, 3);
});

test('an exhausted correction pass stays unpublished and restores normal model requests afterward', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  fake.setResponses([ai.fauxAssistantMessage(draft), ai.fauxAssistantMessage(report()),
    ...Array.from({ length: REVIEW_LIMITS.requests }, () => ai.fauxAssistantMessage(ai.fauxToolCall('read_note', { path: 'Knowledge/Original.md' }), { stopReason: 'toolUse' }))]);
  await assert.rejects(controller.prompt('Investigate this measurement'), /revised draft did not finish/);
  assert.equal(fake.state.callCount, 2 + REVIEW_LIMITS.requests);
  assert.equal((await vault.getMessages(controller.conversation.id)).length, 1);
  controller.effort = 'ask';
  fake.setResponses([ai.fauxAssistantMessage('A normal follow-up answer.')]);
  await controller.prompt('Give a brief follow-up');
  assert.equal((await vault.getMessages(controller.conversation.id)).at(-1).text, 'A normal follow-up answer.');
});

test('a failed final-answer save is recovered from publication history without rerunning review', { skip: !sdk }, async t => {
  const { controller, fake, vault } = await fixture(t);
  const save = vault.saveMessage.bind(vault);
  let fail = true;
  vault.saveMessage = async (id, input) => {
    if (fail && input.role === 'assistant') { fail = false; throw new Error('Simulated disk failure'); }
    return save(id, input);
  };
  fake.setResponses([ai.fauxAssistantMessage(draft), ai.fauxAssistantMessage(report('supported'))]);
  await assert.rejects(controller.prompt('Explain this measurement'), /Simulated disk failure/);
  assert.equal((await vault.getMessages(controller.conversation.id)).length, 1);
  await controller.select(await vault.getConversation(controller.conversation.id));
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.equal(final.text, draft);
  assert.equal(final.review.status, 'reviewed');
  assert.equal(fake.state.callCount, 2);
});

test('host-registered providers and per-request authentication reach both agents across a provider switch', { skip: !sdk }, async t => {
  const { controller, fake, vault, runtime, sessions } = await fixture(t, { hostRegistry: true });
  const other = ai.fauxProvider({ provider: 'custom-local-provider', models: [{ id: 'same-model', input: ['text'], reasoning: false, maxTokens: 512 }], tokensPerSecond: 1000000 });
  const seen = [];
  let hostToken = 'fixture-credential-one';
  runtime.registerNativeProvider({ ...other.provider,
    auth: { apiKey: { name: 'Fixture auth', resolve: async () => ({
      auth: { apiKey: hostToken, headers: { 'x-fixture-auth': hostToken }, baseUrl: 'https://fixture.invalid/api' },
      env: { FIXTURE_PROVIDER_CONTEXT: 'host-memory' }, source: 'test host runtime',
    }) } },
    streamSimple: (model, context, options) => {
      seen.push({ model, options });
      return other.provider.streamSimple(model, context, options);
    },
  });
  const model = runtime.getModel('custom-local-provider', 'same-model');
  assert.equal(controller.modelRuntime.getProvider(model.provider), undefined, 'Provider initially exists only in the host registry.');
  other.setResponses([() => { hostToken = 'fixture-credential-two'; return ai.fauxAssistantMessage(draft); }, ai.fauxAssistantMessage(report('supported'))]);
  await controller.prompt('Investigate with the selected custom provider', [], { model, thinkingLevel: 'high' });
  assert.equal(fake.state.callCount, 0, 'No call leaks to the previous provider with the same model ID.');
  assert.equal(other.state.callCount, 2);
  assert.equal(sessions.at(-1).model.provider, model.provider);
  assert.equal(controller.session.thinkingLevel, 'off');
  assert.equal(sessions.at(-1).thinkingLevel, 'off', 'Pi clamps reasoning to the selected model capabilities.');
  assert.deepEqual(seen.map(item => item.options.apiKey), ['fixture-credential-one', 'fixture-credential-two']);
  assert.equal(seen[1].options.maxTokens, 512, 'The review budget also respects the selected model output limit.');
  assert.ok(seen.every(item => item.model.baseUrl === 'https://fixture.invalid/api' && item.options.env.FIXTURE_PROVIDER_CONTEXT === 'host-memory'));
  assert.deepEqual(seen.map(item => item.options.headers['x-fixture-auth']), ['fixture-credential-one', 'fixture-credential-two']);
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.deepEqual((await vault.readJson(final.review.path.replace('Review.md', 'report.json'))).model, { provider: model.provider, id: model.id });
  assert.doesNotMatch(await vault.readText(controller.conversation.sessionFile || `${controller.conversation.path}/session.jsonl`), /fixture-credential/);
  await assert.rejects(controller.prompt('Inspect this photo', [{ type: 'image', mimeType: 'image/png', data: png }], { model }), /does not accept images/);
  assert.equal(other.state.callCount, 2, 'Unsupported images do not trigger a fallback model.');
  runtime.unregisterProvider(model.provider);
  await assert.rejects(controller.prompt('Try the removed provider', [], { model }), /no longer available/);
  assert.equal(fake.state.callCount, 0);
});

test('OAuth stays in the host Pi runtime and authenticates both Discover agents', { skip: !sdk }, async t => {
  const { controller, vault, runtime } = await fixture(t, { hostRegistry: true });
  const other = ai.fauxProvider({ provider: 'oauth-fixture', models: [{ id: 'oauth-model' }], tokensPerSecond: 1000000 });
  const headers = [];
  runtime.registerNativeProvider({ ...other.provider,
    auth: { oauth: { name: 'Fixture OAuth', isSubscription: true,
      login: async () => ({ type: 'oauth', access: 'fixture-oauth-access', refresh: 'fixture-oauth-refresh', expires: Date.now() + 3600000 }),
      refresh: async credential => credential,
      toAuth: async credential => ({ headers: { authorization: `Bearer ${credential.access}` } }),
    } },
    streamSimple: (model, context, options) => { headers.push(options.headers.authorization); return other.provider.streamSimple(model, context, options); },
  });
  await runtime.login(other.provider.id, 'oauth', {});
  other.setResponses([ai.fauxAssistantMessage(draft), ai.fauxAssistantMessage(report('supported'))]);
  await controller.prompt('Use my Pi login', [], { model: runtime.getModel(other.provider.id, 'oauth-model') });
  assert.deepEqual(headers, ['Bearer fixture-oauth-access', 'Bearer fixture-oauth-access']);
  assert.equal((await runtime.listCredentials()).length, 1);
  assert.deepEqual(await controller.modelRuntime.listCredentials(), [], 'Discover has no separate copy of the login.');
  const final = (await vault.getMessages(controller.conversation.id)).at(-1);
  assert.doesNotMatch(await vault.readText(final.review.path.replace('Review.md', 'session.jsonl')), /fixture-oauth-(?:access|refresh)/);
});
