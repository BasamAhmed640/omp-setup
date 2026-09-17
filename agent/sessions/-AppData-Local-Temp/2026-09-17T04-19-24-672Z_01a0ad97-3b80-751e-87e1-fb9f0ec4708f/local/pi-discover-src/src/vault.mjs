import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const locks = new Map();
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const META = '_Research/vault.json';
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', html: 'text/html', bin: 'application/octet-stream',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const slash = value => value.replaceAll('\\', '/');
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => fold(path.resolve(a)) === fold(path.resolve(b));
const within = (root, target) => {
  const relative = path.relative(fold(root), fold(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const validateId = value => {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid record ID');
  return value;
};
const titleText = value => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A non-empty title is required');
  return value.trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
};
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const sameJson = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const jsonText = value => {
  const result = JSON.stringify(value, null, 2);
  if (result === undefined) throw new Error('Value is not JSON serializable');
  return `${result}\n`;
};
const conflict = message => Object.assign(new Error(message), { code: 'ERR_RESEARCH_CONFLICT' });

async function serialized(key, work) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  locks.set(key, current);
  try { return await current; }
  finally { if (locks.get(key) === current) locks.delete(key); }
}

async function optional(work) {
  try { return await work(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('A vault-relative path is required');
  const normalized = slash(value);
  const parts = normalized.split('/');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || normalized.startsWith('/') || parts.some(part => part === '..' || part.includes(':'))) {
    throw Object.assign(new Error('Path must remain inside the linked vault'), { code: 'ERR_PATH_ESCAPE' });
  }
  if (parts.some(part => part && part !== '.' && /[. ]$/.test(part))) throw new Error('Path segments must not end with a dot or space');
  const clean = parts.filter(part => part && part !== '.').join('/');
  if (!clean) throw new Error('A file path inside the vault is required');
  return clean;
}

async function potentialRealPath(input) {
  let candidate = path.resolve(input);
  const suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(candidate), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function vaultRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Select an existing Obsidian vault');
  const root = await fs.realpath(path.resolve(input));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Vault path is not a directory');
  const obsidian = await fs.realpath(path.join(root, '.obsidian'));
  if (!within(root, obsidian) || !(await fs.stat(obsidian)).isDirectory()) throw new Error('The selected folder must contain its own .obsidian directory');
  return root;
}

function validVaultMeta(meta) {
  if (!meta || meta.version !== 1 || typeof meta.id !== 'string' || !ID.test(meta.id)) throw new Error('Invalid research vault metadata');
  return meta;
}

function timestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid message timestamp');
  return date.toISOString();
}

function frontmatter(values) {
  return `---\n${Object.entries(values).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n`;
}

function isNotePath(relative) {
  return !slash(relative).split('/').some(part => part.startsWith('.') || ['_research', 'sessions', 'node_modules'].includes(part.toLowerCase()));
}

function noteTitle(text, fallback) {
  const metadata = text.match(/^(?:research_title|title):\s*("[^\n]*")\s*$/m);
  if (metadata) { try { return JSON.parse(metadata[1]); } catch {} }
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function attachmentMarkdown(attachments = []) {
  return attachments.map(item => {
    const label = (item.name || 'Attachment').replace(/[\[\]\r\n]/g, '');
    return item.mimeType?.startsWith('image/') ? `![[${item.path}]]` : `[[${item.path}|${label}]]`;
  }).join('\n\n');
}

function reviewMarkdown(review) {
  return review ? `\n\n> ${review.summary} · [[${review.path}|Review notes]]` : '';
}

function messageMarkdown(conversationId, message) {
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : message.role;
  const attachments = attachmentMarkdown(message.attachments);
  return frontmatter({
    research_conversation: conversationId, research_message: message.id,
    research_entry_id: message.nativeEntryId, research_status: message.status,
    created: message.timestamp,
  }) + `# ${label}\n\n${message.text}${attachments ? `\n\n${attachments}` : ''}${reviewMarkdown(message.review)}\n`;
}

/** Local, dependency-free research persistence. Public paths are vault-relative unless documented otherwise. */
export class ResearchVault {
  constructor(root, id) { this.root = root; this.id = id; }

  static async bind(input, { scholarRoots = [] } = {}) {
    const root = await vaultRoot(input);
    for (const scholar of scholarRoots.filter(Boolean)) {
      const other = await potentialRealPath(scholar);
      if (within(root, other) || within(other, root)) throw new Error('Discover and Scholar vaults must be separate, non-nested folders');
    }
    return serialized(`bind:${fold(root)}`, async () => {
      const vault = new ResearchVault(root, null);
      let meta = await optional(() => vault.readJson(META));
      if (!meta) {
        meta = { version: 1, id: randomUUID(), createdAt: now() };
        await vault.writeJson(META, meta);
      }
      vault.id = validVaultMeta(meta).id;
      return vault;
    });
  }

  static async open(input, expectedId) {
    const root = await vaultRoot(input);
    const vault = new ResearchVault(root, null);
    const meta = validVaultMeta(await vault.readJson(META));
    if (expectedId !== undefined && meta.id !== expectedId) throw new Error('Discover vault identity does not match the saved binding');
    vault.id = meta.id;
    return vault;
  }

  /** Resolves existing symlinks/junctions and rejects escape. Does not create anything. */
  async safePath(relative) {
    const clean = relativePath(relative);
    const currentRoot = await fs.realpath(this.root);
    if (!samePath(currentRoot, this.root)) throw new Error('The linked vault location has changed');
    let resolved = currentRoot;
    const parts = clean.split('/');
    for (let index = 0; index < parts.length; index++) {
      const candidate = path.join(resolved, parts[index]);
      const stat = await optional(() => fs.lstat(candidate));
      if (stat === null) return path.join(resolved, ...parts.slice(index));
      resolved = await fs.realpath(candidate);
      if (!within(currentRoot, resolved)) throw Object.assign(new Error('Symlink or junction escapes the linked vault'), { code: 'ERR_PATH_ESCAPE' });
      if (index < parts.length - 1 && !(await fs.stat(resolved)).isDirectory()) throw new Error('A path component is not a directory');
    }
    return resolved;
  }

  async _atomic(relative, data) {
    return serialized(`file:${fold(this.root)}:${relativePath(relative)}`, async () => {
      let target = await this.safePath(relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      target = await this.safePath(relative);
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temp, 'wx');
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temp, target);
      } finally {
        if (handle) await handle.close();
        await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }

  async readText(relative) { return fs.readFile(await this.safePath(relative), 'utf8'); }
  async writeText(relative, text) {
    if (typeof text !== 'string') throw new TypeError('Text must be a string');
    await this._atomic(relative, text);
    return relativePath(relative);
  }
  async readJson(relative) {
    const text = await this.readText(relative);
    try { return JSON.parse(text); }
    catch (cause) { throw Object.assign(new Error(`Invalid JSON in ${relative}`, { cause }), { code: 'ERR_RESEARCH_JSON' }); }
  }
  async writeJson(relative, value) { return this.writeText(relative, jsonText(value)); }

  async createConversation(title = 'New conversation') {
    const id = randomUUID();
    const base = `Conversations/${id}`;
    const manifest = { version: 1, id, title: titleText(title), createdAt: now(), updatedAt: now(), sessionFile: null };
    await fs.mkdir(await this.safePath(`${base}/sessions`), { recursive: true });
    await this.writeJson(`${base}/manifest.json`, manifest);
    await this._projectConversation(id, []);
    return this.getConversation(id);
  }

  async getConversation(id) {
    validateId(id);
    const relative = `Conversations/${id}`;
    const manifest = await this.readJson(`${relative}/manifest.json`);
    if (manifest.version !== 1 || manifest.id !== id || typeof manifest.title !== 'string') throw new Error(`Invalid conversation manifest: ${id}`);
    return { ...manifest, path: relative, sessionDir: await this.safePath(`${relative}/sessions`) };
  }

  async listConversations() {
    const directory = await this.safePath('Conversations');
    const entries = await optional(() => fs.readdir(directory, { withFileTypes: true }));
    const records = [];
    for (const entry of entries || []) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && ID.test(entry.name)) records.push(await this.getConversation(entry.name));
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getMessages(conversationId) {
    await this.getConversation(conversationId);
    const base = `Conversations/${conversationId}/Messages`;
    const entries = await optional(async () => fs.readdir(await this.safePath(base)));
    const messages = [];
    for (const name of entries || []) {
      if (!name.endsWith('.json')) continue;
      const id = validateId(name.slice(0, -5));
      const record = await this.readJson(`${base}/${name}`);
      if (record.version !== 1 || record.id !== id || record.conversationId !== conversationId || typeof record.text !== 'string' || !Number.isInteger(record.sequence)) throw new Error(`Invalid message record: ${name}`);
      const { contentHash, ...content } = record;
      if (hash(JSON.stringify(stable(content))) !== contentHash) throw new Error(`Message integrity check failed: ${name}`);
      messages.push(record);
    }
    return messages.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  }

  async saveMessage(conversationId, input) {
    validateId(conversationId);
    const id = validateId(input.id);
    if (!['user', 'assistant', 'system', 'tool', 'toolResult'].includes(input.role)) throw new Error('Invalid message role');
    if (typeof input.text !== 'string') throw new TypeError('Message text must be a string');
    if (input.nativeEntryId != null) validateId(input.nativeEntryId);
    const attachments = JSON.parse(JSON.stringify(input.attachments || []));
    if (!Array.isArray(attachments)) throw new Error('Message attachments must be an array');
    for (const attachment of attachments) {
      validateId(attachment.id);
      attachment.path = relativePath(attachment.path);
      await this.safePath(attachment.path);
    }
    const status = input.status || 'complete';
    if (!['complete', 'partial', 'interrupted', 'error', 'pending'].includes(status)) throw new Error('Invalid message status');
    let review;
    if (input.review) {
      const value = input.review;
      if (!['reviewed', 'incomplete'].includes(value.status) || typeof value.summary !== 'string' || value.summary.length > 300 || /[\r\n<>\[\]]/.test(value.summary)) throw new Error('Invalid evidence-review metadata');
      const reviewPath = relativePath(value.path);
      if (!/^Conversations\/[A-Za-z0-9_-]+\/Reviews\/[A-Za-z0-9_-]+\/Review\.md$/.test(reviewPath)) throw new Error('Invalid evidence-review path');
      await this.safePath(reviewPath);
      review = { status: value.status, summary: value.summary, path: reviewPath };
    }
    return serialized(`conversation:${fold(this.root)}:${conversationId}`, async () => {
      const conversation = await this.getConversation(conversationId);
      const messages = await this.getMessages(conversationId);
      const existing = messages.find(message => message.id === id);
      const value = {
        version: 1, id, conversationId,
        sequence: existing?.sequence ?? Math.max(0, ...messages.map(message => message.sequence)) + 1,
        role: input.role, text: input.text,
        timestamp: input.timestamp === undefined && existing ? existing.timestamp : timestamp(input.timestamp),
        attachments, nativeEntryId: input.nativeEntryId ?? null, status,
        ...(review ? { review } : {}),
      };
      const record = { ...value, contentHash: hash(JSON.stringify(stable(value))) };
      if (existing && !sameJson(existing, record)) throw conflict(`Message ${id} is immutable; save a correction under a new ID`);
      if (!existing) {
        await this.writeJson(`${conversation.path}/Messages/${id}.json`, record);
        messages.push(record);
      }
      await this._projectConversation(conversationId, messages);
      if (!existing) {
        const { path: ignoredPath, sessionDir: ignoredDir, ...manifest } = conversation;
        manifest.updatedAt = now();
        await this.writeJson(`${conversation.path}/manifest.json`, manifest);
      }
      await this.clearStream(conversationId);
      return record;
    });
  }

  async _projectConversation(id, messages) {
    const conversation = await this.getConversation(id);
    const sections = [];
    for (const message of messages) {
      const relative = `${conversation.path}/Messages/${message.id}.md`;
      const projected = messageMarkdown(id, message);
      const previous = await optional(() => this.readText(relative));
      if (previous !== projected) {
        if (previous !== null) await this.writeText(`_Research/recovered-edits/${id}/${message.id}-${hash(previous).slice(0, 12)}.md`, previous);
        await this.writeText(relative, projected);
      }
      const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : message.role;
      const attachments = attachmentMarkdown(message.attachments);
      sections.push(`## [[${relative}|${label}]]\n\n${message.text}${attachments ? `\n\n${attachments}` : ''}${message.status !== 'complete' ? `\n\n*${message.status}*` : ''}${reviewMarkdown(message.review)}`);
    }
    const text = frontmatter({ research_conversation: id, research_title: conversation.title }) + `# ${conversation.title}\n\n${sections.join('\n\n---\n\n')}${sections.length ? '\n' : ''}`;
    await this.writeText(`${conversation.path}/Conversation.md`, text);
  }

  async recoverConversation(id) {
    validateId(id);
    return serialized(`conversation:${fold(this.root)}:${id}`, async () => {
      const messages = await this.getMessages(id);
      await this._projectConversation(id, messages);
      return { conversationId: id, messages: messages.length, path: `Conversations/${id}/Conversation.md` };
    });
  }

  async saveStream(id, { text = '', status = 'streaming', ...extra } = {}) {
    await this.getConversation(id);
    if (typeof text !== 'string') throw new TypeError('Stream text must be a string');
    await this.writeJson(`_Research/stream/${id}.json`, { ...extra, conversationId: id, text, status, updatedAt: now() });
  }

  async clearStream(id) { return this.saveStream(id, { text: '', status: 'complete' }); }

  async setSessionFile(id, relative) {
    validateId(id);
    const clean = relativePath(relative);
    if (clean !== `Conversations/${id}/session.jsonl` && !(clean.startsWith(`Conversations/${id}/sessions/`) && clean.endsWith('.jsonl'))) throw new Error('Native session must belong to this conversation’s vault sessions directory');
    await this.safePath(clean);
    return serialized(`conversation:${fold(this.root)}:${id}`, async () => {
      const { path: ignoredPath, sessionDir: ignoredDir, ...manifest } = await this.getConversation(id);
      manifest.sessionFile = clean;
      manifest.updatedAt = now();
      await this.writeJson(`Conversations/${id}/manifest.json`, manifest);
      return this.getConversation(id);
    });
  }

  async _notePaths() {
    const found = [];
    const visited = new Set();
    const walk = async relative => {
      if (found.length >= 1500) return;
      const absolute = relative ? await this.safePath(relative) : this.root;
      const canonical = fold(await fs.realpath(absolute));
      if (visited.has(canonical)) return;
      visited.add(canonical);
      for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
        if (found.length >= 1500) break;
        if (!isNotePath(entry.name)) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        let target;
        try { target = await this.safePath(child); }
        catch (error) { if (error.code === 'ERR_PATH_ESCAPE') continue; throw error; }
        if (!isNotePath(path.relative(this.root, target))) continue;
        const stat = await fs.stat(target);
        if (stat.isDirectory()) await walk(child);
        else if (stat.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(child);
      }
    };
    await walk('');
    return found;
  }

  async readNote(relativeOrTitle, { maxChars = 24000, offset = 0 } = {}) {
    const clean = relativePath(relativeOrTitle);
    if (!isNotePath(clean)) throw new Error('Internal runtime files are not research notes');
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) throw new Error('maxChars must be between 1 and 200000');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer');
    let relative = clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`;
    const read = async candidate => {
      const absolute = await this.safePath(candidate);
      if (!isNotePath(path.relative(this.root, absolute))) throw new Error('Internal runtime files are not research notes');
      if ((await fs.stat(absolute)).size > 2 * 1024 * 1024) throw new Error('This note exceeds the 2 MiB read limit; split it into smaller notes for research.');
      return fs.readFile(absolute, 'utf8');
    };
    let text = await optional(() => read(relative));
    if (text === null && !clean.includes('/')) {
      const wanted = clean.replace(/\.md$/i, '').toLowerCase();
      const candidates = await this._notePaths();
      const matches = candidates.filter(candidate => path.posix.basename(candidate, '.md').toLowerCase() === wanted || path.posix.basename(candidate, '.md').toLowerCase() === slug(wanted));
      if (!matches.length) {
        for (const candidate of candidates) {
          const absolute = await this.safePath(candidate);
          if ((await fs.stat(absolute)).size > 2 * 1024 * 1024) continue;
          const candidateText = await read(candidate);
          if (noteTitle(candidateText, '').toLowerCase() === wanted) matches.push(candidate);
        }
      }
      if (matches.length > 1) throw new Error(`Ambiguous note title; use a full vault-relative path: ${matches.join(', ')}`);
      if (matches.length === 1) { relative = matches[0]; text = await read(relative); }
    }
    if (text === null) throw Object.assign(new Error(`Note not found: ${clean}`), { code: 'ENOENT' });
    return { path: relative, text: text.slice(offset, offset + maxChars), revision: hash(text), offset,
      truncated: offset > 0 || text.length > offset + maxChars, totalChars: text.length,
      ...(offset + maxChars < text.length ? { nextOffset: offset + maxChars } : {}) };
  }

  async search(query, { limit = 8 } = {}) {
    if (typeof query !== 'string') throw new TypeError('Search query must be a string');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be between 1 and 50');
    const terms = [...new Set(query.toLowerCase().trim().split(/\s+/u))].filter(Boolean).slice(0, 12);
    if (!terms.length) return [];
    const results = [];
    for (const relative of await this._notePaths()) {
      if (relative.startsWith('Conversations/') && relative.endsWith('/Conversation.md')) continue;
      const absolute = await this.safePath(relative);
      const stat = await fs.stat(absolute);
      if (stat.size > 2 * 1024 * 1024) continue;
      const text = await fs.readFile(absolute, 'utf8');
      const bounded = text.slice(0, 128000);
      const title = noteTitle(bounded, path.posix.basename(relative, '.md'));
      const haystack = `${title}\n${bounded}`.toLowerCase();
      const hits = terms.filter(term => haystack.includes(term));
      if (!hits.length) continue;
      const lower = bounded.toLowerCase();
      const positions = hits.map(term => lower.indexOf(term)).filter(index => index >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 90);
      const score = hits.length * 5 + hits.filter(term => title.toLowerCase().includes(term)).length * 5 + (haystack.includes(query.toLowerCase().trim()) ? 4 : 0);
      results.push({ path: relative, title, snippet: bounded.slice(start, start + 360).replace(/\s+/g, ' ').trim(), revision: hash(text), score });
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  async importAttachment(input) {
    let bytes, name, mimeType;
    if (typeof input === 'string') {
      const stat = await fs.stat(input);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT) throw new Error('Attachment must be a file of at most 50 MB');
      bytes = await fs.readFile(input);
      name = path.basename(input);
      mimeType = MIME[path.extname(name).slice(1).toLowerCase()] || MIME.bin;
    } else {
      const data = input?.data ?? input?.source?.data;
      mimeType = input?.mimeType ?? input?.source?.mediaType;
      if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_ATTACHMENT * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error('Invalid or oversized base64 attachment');
      if (typeof mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Attachment MIME type is required');
      bytes = Buffer.from(data, 'base64');
      name = input?.name || 'Pasted image';
    }
    if (!bytes.length || bytes.length > MAX_ATTACHMENT) throw new Error('Attachment must contain between 1 byte and 50 MB');
    mimeType = detectMime(bytes) || mimeType;
    const ext = Object.keys(MIME).find(key => MIME[key] === mimeType) || 'bin';
    const sha256 = hash(bytes);
    const id = `${sha256.slice(0, 48)}-${ext}`;
    const relative = `Attachments/${id}.${ext}`;
    return serialized(`attachment:${fold(this.root)}:${id}`, async () => {
      const metaPath = `Attachments/${id}.json`;
      const existing = await optional(() => this.readJson(metaPath));
      if (existing) {
        const saved = await fs.readFile(await this.safePath(existing.path));
        if (hash(saved) !== sha256 || existing.sha256 !== sha256) throw new Error(`Attachment integrity check failed: ${id}`);
        return existing;
      }
      await this._atomic(relative, bytes);
      const record = { id, path: relative, mimeType, name: path.basename(String(name)).slice(0, 240), size: bytes.length, sha256 };
      await this.writeJson(metaPath, record);
      return record;
    });
  }

  async saveSource({ url = null, title, text, original, mimeType = 'text/markdown' }) {
    if (typeof text !== 'string') throw new TypeError('Source text must be a string');
    const id = randomUUID();
    const base = `Sources/${id}`;
    const name = titleText(title || url || 'Imported source');
    const originalAttachment = original ? await this.importAttachment(original) : null;
    const metadata = { version: 1, id, title: name, url, acquiredAt: now(), mimeType, textHash: hash(text), original: originalAttachment };
    const relative = `${base}/Source.md`;
    const markdown = frontmatter({ research_source: id, title: name, url, acquired: metadata.acquiredAt }) + `# ${name}\n\n${text}${originalAttachment ? `\n\nOriginal: [[${originalAttachment.path}]]` : ''}\n`;
    await this.writeText(relative, markdown);
    await this.writeJson(`${base}/metadata.json`, metadata);
    return { id, path: relative, title: name, url };
  }

  async saveKnowledge({ title, text, sources = [], expectedRevision }) {
    const name = titleText(title);
    if (typeof text !== 'string') throw new TypeError('Knowledge text must be a string');
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw new Error('Knowledge sources must be an array of strings');
    const key = slug(name);
    const relative = `Knowledge/${key}.md`;
    return serialized(`knowledge:${fold(this.root)}:${key}`, async () => {
      const previous = await optional(() => this.readText(relative));
      const previousRevision = previous === null ? null : hash(previous);
      const metadataPath = `_Research/knowledge/${key}.json`;
      const metadata = await optional(() => this.readJson(metadataPath));
      if (metadata && metadata.title.normalize('NFKC').toLowerCase() !== name.normalize('NFKC').toLowerCase()) throw conflict('Knowledge title collides with an existing page; choose a distinct title');
      if (expectedRevision !== undefined && expectedRevision !== previousRevision) throw conflict('Knowledge changed since it was read; read the current revision before saving');
      if (previous !== null && expectedRevision === undefined && metadata?.revision !== previousRevision) throw conflict('Knowledge was edited externally; read it and supply expectedRevision to preserve the edit');
      const markdown = frontmatter({ research_knowledge: true, research_title: name, research_sources: sources }) + `# ${name}\n\n${text}\n`;
      const revision = hash(markdown);
      if (previous === markdown) return { path: relative, revision, previousRevision };
      if (previous !== null) await this.writeText(`_Research/knowledge/${key}/revisions/${previousRevision}.md`, previous);
      await this.writeText(relative, markdown);
      await this.writeJson(metadataPath, { version: 1, title: name, path: relative, sources, revision, previousRevision, updatedAt: now() });
      return { path: relative, revision, previousRevision };
    });
  }
}

function slug(value) {
  const result = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result)) return `note-${result}`;
  return result || `note-${hash(value).slice(0, 12)}`;
}

function detectMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}
