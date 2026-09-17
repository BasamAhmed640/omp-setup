import { createHash, randomUUID } from 'node:crypto';
import { unlink, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import presentation from '../obsidian/presentation.cjs';

export async function checkPresentation(vault, markdown, { signal, timeoutMs = 8000, sourcePath = 'Knowledge/Preview.md' } = {}) {
  const issues = presentation.markdownIssues(markdown);
  const digest = createHash('sha256').update(markdown).digest('hex');
  if (issues.length) return { status: 'needs-fix', digest, checked: 'markdown', issues };
  if (!presentation.hasPresentation(markdown)) return { status: 'passed', digest, checked: 'markdown', issues: [] };
  if (signal?.aborted) throw signal.reason || new Error('Formatting check cancelled.');
  const id = randomUUID(), base = `_Research/presentation/${id}`;
  const expiresAt = Date.now() + timeoutMs;
  const deadline = performance.now() + timeoutMs;
  await vault.writeJson(base + '.request.json', { version: 1, id, digest, sourcePath, markdown, expiresAt });
  try {
    while (performance.now() < deadline) {
      if (signal?.aborted) throw signal.reason || new Error('Formatting check cancelled.');
      try {
        const file = await vault.safePath(base + '.result.json');
        if ((await stat(file)).size > 50000) throw new Error('Formatting report exceeds the read limit.');
        const report = await vault.readJson(base + '.result.json');
        if (report.id === id && report.digest === digest && ['passed', 'needs-fix', 'unverified'].includes(report.status) && Array.isArray(report.issues) && report.issues.length <= 30 && report.issues.every(issue=>typeof issue.code==='string'&&typeof issue.message==='string'&&issue.message.length<=1000)) return report;
      } catch (error) { if (!['ENOENT','ERR_RESEARCH_JSON'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
      await delay(100, undefined, { signal });
    }
    return { status: 'unverified', digest, checked: 'markdown only', issues: [], message: 'Obsidian did not return a rendered layout check. Open this vault with the updated Discover companion enabled. Do not claim visual verification; use simple formatting until it is available.' };
  } finally {
    for (const suffix of ['.request.json', '.result.json']) await unlink(await vault.safePath(base + suffix)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
