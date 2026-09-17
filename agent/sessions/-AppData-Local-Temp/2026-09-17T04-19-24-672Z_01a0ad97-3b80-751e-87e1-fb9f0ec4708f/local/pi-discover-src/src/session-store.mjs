import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';

export function readSessionEntries(file, { repair = true } = {}) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const entries = [];
  let validBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line && i === lines.length - 1) break;
    try { entries.push(JSON.parse(line)); }
    catch {
      // Only a torn final append is recoverable; never skip malformed history.
      if (!repair || i !== lines.length - 1 || !entries.length) throw new Error('Corrupt Pi session at line ' + (i + 1));
      writeFileSync(file + '.interrupted', line, { flag: 'w', mode: 0o600 });
      truncateSync(file, validBytes);
      break;
    }
    validBytes += Buffer.byteLength(line + '\n');
    if (repair && i === lines.length - 1) {
      const fd = openSync(file, 'a');
      try { writeFileSync(fd, '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  if (entries[0]?.type !== 'session' || entries[0]?.version !== 3) throw new Error('Unsupported or missing Pi session header');
  const seen = new Set();
  for (const entry of entries.slice(1)) {
    if (!entry.id || seen.has(entry.id) || (entry.parentId !== null && !seen.has(entry.parentId))) throw new Error('Invalid Pi session entry ancestry');
    seen.add(entry.id);
  }
  return entries;
}

/** Public SessionManager API adapter: persist each append, including the first user message. */
export function durableSession(sdk, { root, file, id, initialEntries, onEntry = () => {} }) {
  const entries = existsSync(file) ? readSessionEntries(file) : initialEntries;
  if (entries?.[0]?.id !== undefined && entries[0].id !== id) throw new Error('Saved session belongs to a different conversation');
  const manager = sdk.SessionManager.inMemory(root, { id }, entries);
  let written = manager.getEntries().length;
  if (!existsSync(file)) {
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeFileSync(fd, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  let failed;
  function commit() {
    if (failed) throw failed;
    const added = manager.getEntries().slice(written);
    if (!added.length) return;
    try {
      const fd = openSync(file, 'a');
      try { writeFileSync(fd, added.map(entry => JSON.stringify(entry)).join('\n') + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      written += added.length;
      for (const entry of added) onEntry(entry);
    } catch (error) { failed = error; throw error; }
  }
  return new Proxy(manager, {
    get(target, prop) {
      if (prop === 'getSessionFile') return () => file;
      if (prop === 'getSessionDir') return () => dirname(file);
      if (prop === 'isPersisted') return () => true;
      if (prop === 'usesDefaultSessionDir') return () => false;
      if (['newSession', 'setSessionFile', 'branch', 'branchWithSummary', 'resetLeaf', 'createBranchedSession'].includes(prop)) return () => { throw new Error('Use Discover new/resume/continue/fork to change conversations'); };
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (String(prop).startsWith('append')) return (...args) => { if (failed) throw failed; const result = value.apply(target, args); commit(); return result; };
      return value.bind(target);
    },
  });
}
