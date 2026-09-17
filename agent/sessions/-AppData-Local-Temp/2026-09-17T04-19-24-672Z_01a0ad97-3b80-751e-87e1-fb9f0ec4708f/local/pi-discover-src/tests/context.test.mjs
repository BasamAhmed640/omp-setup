import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationRecords, recallConversation, conversationBrief, compactionSettings } from '../src/context.mjs';
import { REVIEW_EVENT, REVIEW_LIMITS, evidencePacket, reviewLimitsForModel, boundRequests } from '../src/review.mjs';

const entry = (id, role, text, extra = {}) => ({ id, type: 'message', timestamp: '2026-09-11T00:00:00Z', message: { role, content: [{ type: 'text', text }], ...extra } });
const marker = (phase, data = {}) => ({ type: 'custom', customType: REVIEW_EVENT, data: { phase, turnId: 'turn', ...data } });

test('recall retrieves original text across compaction, pages exact excerpts and excludes unpublished drafts and feedback', () => {
  const original = 'Original page 7: 42 mg. ' + 'Exact preserved wording. '.repeat(1000);
  const entries = [entry('question', 'user', 'Use milligrams, not grams.'),
    entry('source', 'toolResult', original, { toolName: 'read_pdf' }), marker('start'),
    entry('hidden', 'assistant', 'PRIVATE_WRONG_DRAFT 42 grams'), entry('final', 'assistant', 'The source reports 42 mg.'), marker('publish', { entryId: 'final' }),
    { id: 'compacted', type: 'compaction', summary: 'INACCURATE_SUMMARY: 42 grams.' },
    { id: 'feedback', type: 'custom_message', customType: 'discover-review-feedback', content: 'PRIVATE_REVIEW_FEEDBACK' },
    entry('recursive', 'toolResult', 'RECURSIVE_RECALL_COPY', { toolName: 'recall_conversation' })];
  const result = recallConversation(entries, { query: 'milligrams' });
  assert.equal(result.matches[0].entryId, 'question');
  assert.equal(recallConversation(entries, { query: 'page 7' }).matches[0].entryId, 'source');
  const first = recallConversation(entries, { entryId: 'source', maxChars: 120 }).matches[0];
  const next = recallConversation(entries, { entryId: 'source', offset: first.nextOffset, maxChars: 120 }).matches[0];
  assert.equal(first.text + next.text, original.slice(0, 240));
  assert.equal(next.totalChars, original.length);
  assert.match(first.provenance, /untrusted evidence/);
  const recalled = JSON.stringify(conversationRecords(entries));
  assert.doesNotMatch(recalled, /PRIVATE_|INACCURATE_SUMMARY|RECURSIVE_RECALL_COPY/);
  assert.match(recalled, /Published assistant text; not independent evidence/);
  assert.throws(() => recallConversation(entries, { entryId: 'hidden' }), /not available/);
  assert.throws(() => recallConversation(entries, { entryId: 'other-branch' }), /not available/);
  assert.throws(() => recallConversation(entries, { offset: 10 }), /requires an entryId/);
  assert.throws(() => recallConversation(entries, { query: 'test', entryId: 'source' }), /not both/);
  assert.throws(() => recallConversation(entries, { maxChars: 20001 }), /maxChars/);
  assert.ok(recallConversation(entries, { maxChars: 99 }).matches.reduce((sum, match) => sum + match.text.length, 0) <= 99);
});

test('a selective review brief preserves recent corrections and labels summaries and note snapshots as derived or untrusted', () => {
  const prior = [entry('old', 'user', 'Compare study doses.'), entry('answer', 'assistant', 'The earlier assumption was 42 grams.'),
    { id: 'summary', type: 'compaction', summary: 'DERIVED_SUMMARY with source references.' },
    { id: 'note', type: 'custom_message', customType: 'pi-research-context', content: 'SELECTED_NOTE_SNAPSHOT' },
    entry('correction', 'user', 'LATEST_CORRECTION: it is milligrams. Include limitations.'),
    entry('source', 'toolResult', 'OLDER_EVIDENCE_NOT_AUTO_INJECTED', { toolName: 'read_pdf' })];
  const current = [entry('now', 'user', 'Continue.')];
  const brief = conversationBrief([...prior, ...current], current);
  assert.equal(brief.materials[0].entryId, 'correction');
  assert.match(JSON.stringify(brief), /LATEST_CORRECTION|DERIVED_SUMMARY|SELECTED_NOTE_SNAPSHOT/);
  assert.ok(brief.materials.find(item => item.entryId === 'summary').kind.includes('not original evidence'));
  assert.doesNotMatch(JSON.stringify(brief.materials), /OLDER_EVIDENCE_NOT_AUTO_INJECTED|Continue/);
  assert.ok(brief.limitations.length);
  assert.equal(recallConversation(prior, { entryId: 'note' }).matches[0].text, 'SELECTED_NOTE_SNAPSHOT');
});

test('a crowded review packet retains the current request before long drafts or sources and records omissions', () => {
  const prior = [entry('correction', 'user', 'LATEST_CORRECTION: units must be mg.')];
  const current = [entry('now', 'user', 'CURRENT_REQUEST: continue this comparison.'),
    entry('early', 'toolResult', 'EARLY_NOISE '.repeat(20000), { toolName: 'fetch_source' }),
    entry('recent', 'toolResult', 'RECENT_ORIGINAL_PASSAGE: 42 mg.', { toolName: 'read_pdf' })];
  const packet = evidencePacket(current, entry('draft', 'assistant', 'LONG_DRAFT '.repeat(10000)), { ...REVIEW_LIMITS, packetChars: 3000 }, [...prior, ...current]);
  assert.match(packet.materials[0].text, /CURRENT_REQUEST/);
  assert.match(JSON.stringify(packet.materials), /LATEST_CORRECTION/);
  assert.match(JSON.stringify(packet.materials), /RECENT_ORIGINAL_PASSAGE/);
  assert.ok(packet.materials.reduce((sum, material) => sum + material.text.length, 0) <= 3000);
  assert.ok(packet.limitations.some(item => item.includes('Draft')));
});

test('model-sized budgets bound small-window review requests before calling a provider', async () => {
  const model = { contextWindow: 8192, maxTokens: 2000 };
  const limits = reviewLimitsForModel(model);
  assert.equal(limits.requestTokens, 1024);
  assert.equal(limits.images, 0);
  assert.equal(compactionSettings(model).reserveTokens, 2048);
  assert.equal(compactionSettings(model).keepRecentTokens, 2048);
  assert.equal(compactionSettings({ contextWindow: 200000 }).reserveTokens, 16384);
  assert.equal(compactionSettings({ contextWindow: 200000 }).keepRecentTokens, 20000);
  let calls = 0;
  const original = async (_model, _context, options) => { calls++; return options; };
  const session = { agent: { streamFunction: original } }, stats = { requests: 0, outputTokens: 0 };
  const restore = boundRequests(session, stats, limits, () => false, message => message.content.length / 4);
  assert.equal((await session.agent.streamFunction(model, { messages: [{ content: 'A short input' }] }, {})).maxTokens, 1024);
  const refused = session.agent.streamFunction(model, { messages: [{ content: 'Huge tool output'.repeat(3000) }] }, {});
  assert.match((await refused.result()).errorMessage, /context budget exhausted/);
  assert.equal(calls, 1);
  assert.equal(stats.requests, 1, 'A local input refusal is not a model request.');
  restore(); assert.equal(session.agent.streamFunction, original);
});
