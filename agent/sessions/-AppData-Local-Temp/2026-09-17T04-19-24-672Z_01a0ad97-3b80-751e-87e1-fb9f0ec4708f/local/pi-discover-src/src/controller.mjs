import { readFile, mkdir, open, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createResearchTools } from './tools.mjs';
import { durableSession, readSessionEntries } from './session-store.mjs';
import { researchPrompt } from './prompt.mjs';
import { REVIEW_EVENT, REVIEW_LIMITS, boundRequests, trackPublication, shouldReview, runReview } from './review.mjs';
import { checkPresentation } from './presentation.mjs';
import { bindPiModel, createPiRuntime } from './pi-models.mjs';
import { compactionSettings, RESEARCH_COMPACTION_GUIDE } from './context.mjs';

const textOf = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const isMissing = error => error.code === 'ENOENT';

export async function unlockVault(vault) {
  const path = await vault.safePath('_Research/writer.lock');
  let existing;
  try { existing = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (isMissing(error)) return; if (!(error instanceof SyntaxError)) throw error; }
  if (existing?.host === hostname() && Number.isInteger(existing.pid)) {
    try { process.kill(existing.pid, 0); throw new Error('A local Pi writer is still running. Close it before unlocking.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await unlink(path);
}

export class ResearchController {
  constructor(sdk, vault, { onStatus = () => {}, modelRuntime, modelRegistry, reviewLimits, presentationTimeoutMs } = {}) {
    this.sdk = sdk; this.vault = vault; this.onStatus = onStatus; this.modelRuntime = modelRuntime;
    this.effort = 'ask'; this.busy = false; this.pending = Promise.resolve(); this.attachments = [];
    this.reviewLimits = reviewLimits; this.presentationTimeoutMs = presentationTimeoutMs;
    this.modelRegistry = modelRegistry;
  }
  async acquire() {
    const path = await this.vault.safePath('_Research/writer.lock');
    await mkdir(join(this.vault.root, '_Research'), { recursive: true });
    const lock = { pid: process.pid, host: hostname(), token: randomUUID() };
    const temp = await this.vault.safePath(`_Research/writer-${lock.token}.tmp`);
    const fd = await open(temp, 'wx');
    try { await fd.writeFile(JSON.stringify(lock)); await fd.sync(); } finally { await fd.close(); }
    try {
      // Exclusive publication of complete metadata avoids half-written lock files.
      await link(temp, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new Error('Discover lock metadata is damaged. After closing other Pi writers, use /discover unlock.'); }
      if (existing.host !== hostname()) throw new Error('Discover lock belongs to another computer. After closing its Pi writer, use /discover unlock for this copy.');
      let alive = true;
      try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('This Discover vault is already open in another Pi session.');
      await unlink(path);
      return this.acquire();
    } finally { await unlink(temp).catch(() => {}); }
    this.lock = { ...lock, path };
  }
  async dispose() {
    if (this.disposed) return;
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = this.disposeResources();
    return this.disposePromise;
  }
  async disposeResources() {
    let failure;
    const finish = async job => { try { await job(); } catch (error) { failure ||= error; } };
    await finish(() => this.stop());
    await finish(() => this.promptDone);
    await finish(() => this.draftPending);
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    await finish(() => this.pending);
    await finish(() => this.session?.dispose());
    this.session = null;
    if (this.lock) {
      await finish(async () => {
        const existing = JSON.parse(await readFile(this.lock.path, 'utf8').catch(error => { if (isMissing(error)) return '{}'; throw error; }));
        if (existing.token === this.lock.token) await unlink(this.lock.path);
        this.lock = null;
      });
    }
    this.disposed = !this.lock;
    this.disposePromise = null;
    if (failure) throw failure;
  }
  enqueue(job) {
    this.pending = this.pending.then(job).catch(error => { this.saveError = error; this.onStatus('Save failed: ' + error.message, 'error'); });
  }
  async projectEntry(entry, conversationId = this.conversation.id, review) {
    if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message.role)) return;
    const message = entry.message;
    const text = textOf(message.content);
    const images = Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : [];
    const attachments = [];
    for (const image of images) attachments.push(await this.vault.importAttachment(image));
    if (!text && !attachments.length) return;
    await this.vault.saveMessage(conversationId, {
      id: entry.id, nativeEntryId: entry.id, role: message.role, text, attachments,
      timestamp: new Date(message.timestamp || entry.timestamp).toISOString(),
      status: ['aborted', 'error', 'length'].includes(message.stopReason) ? 'partial' : 'complete',
      ...(review ? { review } : {}),
    });
  }
  async select(conversation, { model, thinkingLevel, initialEntries } = {}) {
    if (this.busy) throw new Error('Stop the current answer before changing conversations.');
    await this.draftPending;
    await this.pending;
    this.session?.dispose(); this.session = null;
    this.conversation = conversation; this.saveError = null;
    this.contextNote = null;
    try {
      const origin = await this.vault.readJson(`${conversation.path}/origin.json`);
      if (origin.kind === 'note') this.contextNote = { path: origin.path };
    } catch (error) { if (!isMissing(error)) throw error; }
    const sessionPath = conversation.sessionFile || `${conversation.path}/session.jsonl`;
    const file = await this.vault.safePath(sessionPath);
    if (conversation.sessionFile) await readFile(file); // Missing exact history is never silently replaced.
    this.publication = { pending: null, hidden: new Set() };
    const manager = durableSession(this.sdk, {
      root: this.vault.root, file, id: conversation.id, initialEntries,
      onEntry: entry => {
        const visible = trackPublication(this.publication, entry, id => this.manager.getEntry(id));
        if (visible) this.enqueue(() => this.projectEntry(visible.entry, conversation.id, visible.review));
      },
    });
    this.manager = manager;
    await this.vault.setSessionFile(conversation.id, sessionPath);
    const saved = new Set((await this.vault.getMessages(conversation.id)).map(message => message.id));
    for (const entry of manager.getEntries()) {
      const visible = trackPublication(this.publication, entry, id => manager.getEntry(id));
      if (visible && !saved.has(visible.entry.id)) await this.projectEntry(visible.entry, conversation.id, visible.review);
    }
    const interrupted = Boolean(this.publication.pending);
    if (interrupted) manager.appendCustomEntry(REVIEW_EVENT, { phase: 'end', turnId: this.publication.pending.turnId, outcome: 'interrupted' });
    // Discover owns this setting: Pi compacts near the limit and handles overflow recovery.
    // Retain native budgets, scaled down for small model windows.
    const settings = this.sdk.SettingsManager.inMemory({
      packages: [], extensions: [], skills: [], promptTemplates: [],
      compaction: compactionSettings(model), retry: { enabled: true, maxRetries: 2 },
    });
    const loader = new this.sdk.DefaultResourceLoader({
      cwd: this.vault.root, agentDir: join(this.vault.root, '_Research', 'runtime'), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: researchPrompt(this.effort), appendSystemPrompt: [],
      extensionFactories: [api => {
        api.on('before_agent_start', () => ({ systemPrompt: researchPrompt(this.turnEffort || this.effort, this.voice || '') }));
        api.on('session_before_compact', async event => {
          // Use Pi's public compactor and prepared cut point, including its
          // split-turn handling. One summary operation, no second memory agent.
          const session = this.session;
          const stream = (model, context, options) => session.agent.streamFunction(model,
            { ...context, systemPrompt: `${context.systemPrompt}\n\n${RESEARCH_COMPACTION_GUIDE}` }, options);
          try {
            const compaction = await this.sdk.compact(event.preparation, session.model, undefined, undefined,
              event.customInstructions, event.signal, session.thinkingLevel, stream, undefined, settings.getRetrySettings(), undefined, manager.getSessionId());
            return { compaction };
          } catch (error) {
            if (event.signal.aborted) return { cancel: true };
            this.onStatus('Research summary failed; Pi will try its native fallback.', 'warning');
            // An absent result asks Pi to run its standard compactor. Original
            // history remains untouched if both attempts fail.
          }
        });
      }],
      agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    this.modelRuntime ||= this.modelRegistry ? await createPiRuntime(this.sdk) : await this.sdk.ModelRuntime.create({ allowModelNetwork: false });
    if (this.modelRegistry) {
      if (!model) throw new Error('Select a model in Pi before opening Discover.');
      bindPiModel(this.modelRuntime, this.modelRegistry, model);
    }
    const customTools = createResearchTools(this.vault, { getConversationId: () => this.conversation.id, getConversationEntries: () => this.manager.getBranch(), canReadImages: () => this.session?.model?.input?.includes('image') === true, presentationTimeoutMs: this.presentationTimeoutMs });
    const created = await this.sdk.createAgentSession({
      cwd: this.vault.root, agentDir: join(this.vault.root, '_Research', 'runtime'),
      modelRuntime: this.modelRuntime, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      settingsManager: settings, resourceLoader: loader, sessionManager: manager,
      tools: customTools.map(tool => tool.name), customTools,
    });
    this.session = created.session;
    this.session.subscribe(event => {
      if (event.type === 'agent_start' && this.stopRequested) this.session.agent.abort();
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
        this.streamText = '';
      }
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        this.streamText += event.assistantMessageEvent.delta;
        if (this.publication.pending) return;
        if (!this.streamTimer) this.streamTimer = setTimeout(() => {
          this.streamTimer = null;
          const text = this.streamText;
          this.enqueue(() => this.vault.saveStream(conversation.id, { text, status: 'working' }));
        }, 180);
      }
      if (event.type === 'message_start' && event.message.role === 'assistant') this.streamText = '';
      if (event.type === 'tool_execution_start') this.onStatus('Researching · ' + event.toolName);
    });
    await this.vault.recoverConversation(conversation.id);
    if (interrupted) await this.vault.saveStream(conversation.id, { text: '', status: 'error', phase: 'Draft saved; review was interrupted. Send a message to continue.' });
    else await this.vault.clearStream(conversation.id);
    await this.vault.writeJson('_Research/active.json', { conversationId: conversation.id });
    const hasUser = manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user');
    if (hasUser) this.contextNote = null;
    try {
      const draft = await this.vault.readJson(`${conversation.path}/draft.json`);
      this.attachments = draft.attachments || [];
    } catch (error) { if (!isMissing(error)) throw error; this.attachments = []; }
    this.onStatus('Ready · ' + conversation.title);
    return conversation;
  }
  async newConversation(title = 'New conversation', options = {}) {
    return this.select(await this.vault.createConversation(title), options);
  }
  async continueNote(note, options = {}) {
    const loaded = await this.vault.readNote(note, { maxChars: 24000 });
    await this.newConversation(loaded.path.split('/').at(-1).replace(/\.md$/, ''), options);
    this.contextNote = loaded;
    await this.vault.writeJson(`${this.conversation.path}/origin.json`, { kind: 'note', path: loaded.path, revision: loaded.revision });
    return loaded;
  }
  async fork(conversation, entryId, options = {}) {
    if (this.busy || this.closing) throw new Error('Stop the current answer before branching, and keep Discover open.');
    await this.draftPending;
    await this.pending;
    if (!conversation.sessionFile) throw new Error('This conversation has no saved Pi session.');
    const entries = readSessionEntries(await this.vault.safePath(conversation.sessionFile), { repair: false });
    if (entries[0].id !== conversation.id) throw new Error('Saved session belongs to a different conversation');
    const native = this.sdk.SessionManager.inMemory(this.vault.root, {}, entries);
    if (!native.getEntry(entryId)) throw new Error('Message entry was not found in this conversation.');
    const state = { pending: null, hidden: new Set() };
    for (const entry of native.getEntries()) trackPublication(state, entry, id => native.getEntry(id));
    if (state.hidden.has(entryId)) throw new Error('This entry is an unpublished draft. Branch from a published response or your question.');
    const publication = native.getEntries().find(entry => entry.type === 'custom' && entry.customType === REVIEW_EVENT && entry.data?.phase === 'publish' && entry.data.entryId === entryId);
    const target = await this.vault.createConversation(conversation.title + ' · branch');
    const header = { ...entries[0], id: target.id, cwd: this.vault.root, timestamp: new Date().toISOString() };
    delete header.parentSession;
    await this.vault.writeJson(`${target.path}/origin.json`, { kind: 'fork', conversationId: conversation.id, entryId });
    return this.select(target, { ...options, initialEntries: [header, ...native.getBranch(publication?.id || entryId)] });
  }
  async attach(file) {
    if (this.busy) throw new Error('Wait for this answer or stop it before staging attachments.');
    const attachment = await this.vault.importAttachment(file);
    this.attachments.push(attachment);
    if (this.conversation) await this.vault.writeJson(`${this.conversation.path}/draft.json`, { attachments: this.attachments });
    return attachment;
  }
  preserveDraft(text, images = []) {
    const path = this.conversation?.path;
    this.draftPending = (this.draftPending || Promise.resolve()).then(() => this._preserveDraft(path, text, images));
    return this.draftPending;
  }
  async _preserveDraft(path, text, images) {
    const attachments = [...this.attachments];
    for (const image of images) {
      const saved = await this.vault.importAttachment(image);
      if (!attachments.some(item => item.id === saved.id)) attachments.push(saved);
    }
    this.attachments = attachments;
    if (path) await this.vault.writeJson(`${path}/draft.json`, { text, attachments });
  }
  async prompt(text, images = [], { model, thinkingLevel } = {}) {
    if (!this.session) throw new Error('Open a Discover conversation first.');
    if (this.busy) throw new Error('An answer is still running. Your draft is preserved; use /discover stop to interrupt.');
    if (this.closing) throw new Error('Discover is closing.');
    this.busy = true; this.stopRequested = false; this.saveError = null; this.streamText = '';
    this.turnEffort = this.effort;
    this.turnAbort = new AbortController();
    let finishPrompt;
    this.promptDone = new Promise(resolve => { finishPrompt = resolve; });
    let accepted = false;
    const submittedAttachments = new Set(this.attachments.map(item => item.id));
    const checkStopped = () => { if (this.stopRequested || this.closing) throw new Error('Stopped before sending. Your draft is preserved.'); };
    try {
      if (this.modelRegistry && (model || this.session.model)) bindPiModel(this.modelRuntime, this.modelRegistry, model || this.session.model);
      if (model && (model.id !== this.session.model?.id || model.provider !== this.session.model?.provider)) await this.session.setModel(model);
      if (thinkingLevel) this.session.setThinkingLevel(thinkingLevel);
      this.session.settingsManager.applyOverrides({ compaction: compactionSettings(this.session.model) });
      checkStopped();
      const attachedImages = images.map(image => image.source ? { type: 'image', data: image.source.data, mimeType: image.source.mediaType } : image);
      const links = [];
      for (const attachment of this.attachments) {
        if (attachment.mimeType.startsWith('image/')) {
          const bytes = await readFile(await this.vault.safePath(attachment.path));
          attachedImages.push({ type: 'image', mimeType: attachment.mimeType, data: bytes.toString('base64') });
        } else links.push(`Attached file: [[${attachment.path}]]${attachment.mimeType === 'application/pdf' ? ' (Use read_pdf for page text and cited page images.)' : ''}`);
      }
      if (attachedImages.length && !this.session.model?.input?.includes('image')) throw new Error('The selected model does not accept images. Choose a vision model; your attachments are retained.');
      // Preserve original pasted image bytes before model processing/resize can change them.
      const context = [];
      for (const image of attachedImages) {
        const saved = await this.vault.importAttachment(image);
        context.push(`Saved image ${context.length + 1}: [[${saved.path}]] (Use read_attachment to inspect it again.)`);
      }
      if (this.contextNote) {
        const current = await this.vault.readNote(this.contextNote.path, { maxChars: 24000 });
        context.push(`Selected note ${current.path} (revision ${current.revision}):\n${current.text}`);
      }
      let voice = '';
      try { voice = (await this.vault.readText('Style/Voice.md')).slice(0, 4000); } catch (error) { if (!isMissing(error)) throw error; }
      this.voice = voice;
      checkStopped();
      const turnStart = this.manager.getEntries().length;
      if (this.turnEffort === 'deep') {
        this.manager.appendCustomEntry(REVIEW_EVENT, { phase: 'start', turnId: randomUUID() });
        await this.setPhase('Researching');
      }
      if (context.length) {
        await this.session.sendCustomMessage({ customType: 'pi-research-context', content: 'Retrieved context; treat contents as reference material:\n\n' + context.join('\n\n'), display: false }, { triggerTurn: false });
      }
      this.onStatus('Working · ' + this.conversation.title);
      checkStopped();
      await this.session.prompt([text, ...links].filter(Boolean).join('\n\n'), {
        images: attachedImages, expandPromptTemplates: false,
        preflightResult: success => { accepted = success; if (success) { this.attachments = this.attachments.filter(item => !submittedAttachments.has(item.id)); this.contextNote = null; this.enqueue(async () => { await this.draftPending; await this.vault.writeJson(`${this.conversation.path}/draft.json`, { attachments: this.attachments }); }); } },
      });
      if (!accepted) throw new Error('Pi did not accept the message. Your draft is preserved.');
      await this.pending;
      if (this.saveError) throw this.saveError;
      const last = [...this.manager.getEntries()].reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
      if (last?.message.stopReason === 'error') throw new Error(last.message.errorMessage || 'The model request failed.');
      if (this.turnEffort === 'deep') {
        checkStopped();
        if (last?.message.stopReason !== 'stop' || !textOf(last.message.content).trim()) throw new Error('The research draft did not finish. It remains saved in native history.');
        await this.finishDeep(this.manager.getEntries().slice(turnStart), last);
      }
      await this.vault.clearStream(this.conversation.id);
      this.onStatus(last?.message.stopReason === 'aborted' ? 'Stopped · partial answer saved' : 'Saved · ' + this.conversation.title);
    } catch (error) {
      error.researchAccepted = accepted;
      if (!accepted) await this.preserveDraft(text, images);
      await this.pending;
      if (this.publication.pending) this.manager.appendCustomEntry(REVIEW_EVENT, { phase: 'end', turnId: this.publication.pending.turnId, outcome: 'interrupted' });
      await this.vault.saveStream(this.conversation.id, { text: this.turnEffort === 'deep' ? '' : this.streamText || '', status: 'error',
        ...(this.turnEffort === 'deep' ? { phase: this.stopRequested ? 'Stopped · draft saved' : 'Draft saved · ' + error.message } : {}) }).catch(() => {});
      throw error;
    } finally {
      if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
      await this.pending;
      this.busy = false;
      this.turnEffort = null; this.turnAbort = null;
      finishPrompt();
    }
  }
  async setPhase(phase) {
    this.onStatus(phase + ' · ' + this.conversation.title);
    await this.pending;
    await this.vault.saveStream(this.conversation.id, { text: '', status: 'working', phase });
  }
  async checkLayout(markdown, entries) {
    const digest = createHash('sha256').update(markdown).digest('hex');
    // Reuse only an actual tool result for this exact draft in the current turn.
    const checked = entries.findLast(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'check_presentation'
      && !entry.message.isError && entry.message.details?.digest === digest)?.message.details;
    if (checked && ['passed', 'needs-fix', 'unverified'].includes(checked.status)) return checked;
    return checkPresentation(this.vault, markdown, { signal: this.turnAbort.signal, timeoutMs: this.presentationTimeoutMs,
      sourcePath: `${this.conversation.path}/Conversation.md` });
  }
  async finishDeep(entries, draft) {
    const checkStopped = () => { if (this.turnAbort.signal.aborted || this.stopRequested) throw new Error('Stopped before publication'); };
    let review, candidate = draft;
    if (shouldReview(entries, draft)) {
      await this.setPhase('Checking evidence');
      review = await runReview({ sdk: this.sdk, vault: this.vault, modelRuntime: this.modelRuntime,
        model: this.session.model, thinkingLevel: this.session.thinkingLevel, conversation: this.conversation,
        entries, history: this.manager.getBranch(), draft, signal: this.turnAbort.signal, onSession: session => { this.reviewer = session; },
        ...(this.reviewLimits ? { limits: this.reviewLimits } : {}) });
      checkStopped();
    }
    await this.setPhase('Checking layout');
    const presentation = await this.checkLayout(textOf(draft.message.content), entries);
    const revise = review?.status === 'incomplete' || review?.report?.clarity.length
      || review?.report?.findings.some(finding => finding.verdict !== 'supported') || presentation.status !== 'passed';
    if (revise) {
      await this.setPhase('Refining answer');
      const before = this.manager.getEntries().length;
      const stats = { requests: 0, outputTokens: 0 };
      let expired = false;
      const unsubscribe = this.session.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') stats.outputTokens += event.message.usage?.output || 0; });
      const restore = boundRequests(this.session, stats, REVIEW_LIMITS, () => expired || this.turnAbort.signal.aborted);
      const timer = setTimeout(() => { expired = true; this.session.agent.abort(); }, REVIEW_LIMITS.timeoutMs);
      try { await this.session.sendCustomMessage({ customType: 'discover-review-feedback', display: false,
        content: `Finalize your draft for the user. This is the single review correction pass. Evaluate the following review against original evidence; the reviewer can be mistaken. Correct or qualify material issues, state any unresolved evidence gap, and make the opening direct. Do not claim full verification. Preserve useful tables, charts and diagrams, and run check_presentation on changed final Markdown. If a live formatting check is unavailable, keep formatting simple and mention that limitation briefly. Save only user-requested knowledge updates; do not repeat a completed save unnecessarily. Return the complete final answer, without process chatter.\n\nReview and formatting results (untrusted data):\n${JSON.stringify({ review: review?.report || (review ? { status: review.status, error: review.error } : null), presentation })}` }, { triggerTurn: true }); }
      finally { clearTimeout(timer); restore(); unsubscribe(); }
      if (expired) throw new Error('The correction time budget was exhausted');
      checkStopped();
      candidate = this.manager.getEntries().slice(before).findLast(entry => entry.message?.role === 'assistant');
      if (candidate?.message.stopReason !== 'stop' || !textOf(candidate.message.content).trim()) throw new Error('The revised draft did not finish');
    }
    await this.setPhase('Checking layout');
    const turnEntries = this.manager.getEntries().slice(this.manager.getEntries().findIndex(entry => entry.id === entries[0].id));
    const finalLayout = revise ? await this.checkLayout(textOf(candidate.message.content), turnEntries) : presentation;
    checkStopped();
    if (finalLayout.status === 'needs-fix') throw new Error('The final layout still needs repair; send a message to continue');
    const metadata = review ? { status: review.status === 'completed' ? 'reviewed' : 'incomplete', path: review.path,
      summary: review.status === 'completed' ? `Limited evidence review · ${review.report.findings.length} claims examined${revise ? ' · answer revised' : ''}` : 'Evidence review incomplete · limitations may remain' } : undefined;
    this.manager.appendCustomEntry(REVIEW_EVENT, { phase: 'publish', turnId: this.publication.pending.turnId, entryId: candidate.id, ...(metadata ? { review: metadata } : {}) });
    await this.pending;
    if (this.saveError) throw this.saveError;
  }
  async stop() {
    this.stopRequested = true;
    this.turnAbort?.abort(new Error('Stopped by user'));
    await Promise.all([this.reviewer?.abort(), this.session?.abort()]);
  }
}
