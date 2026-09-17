import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function installCompanion(vault) {
  // Retain the plugin ID and directory so existing enabled plugins and view settings survive the Discover rename.
  const dest = await vault.safePath('.obsidian/plugins/pi-research');
  const source = fileURLToPath(new URL('../obsidian/', import.meta.url));
  await mkdir(dest, { recursive: true });
  // Compare bytes: opening Discover can repair a missing or damaged companion
  // without rewriting unchanged files or triggering unnecessary vault events.
  // Publish the manifest last. No preferences or enabled-plugin lists are edited.
  for (const file of ['main.js', 'styles.css', 'manifest.json']) {
    const target = await vault.safePath('.obsidian/plugins/pi-research/' + file);
    const content = await readFile(join(source, file));
    let existing;
    try { existing = await readFile(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing?.equals(content)) continue;
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, content, { flag: 'wx' });
      await rename(temp, target);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return dest;
}
