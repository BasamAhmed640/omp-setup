import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const folder of ['src', 'obsidian', 'scripts', 'tests']) {
  for (const file of await readdir(folder)) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    execFileSync(process.execPath, ['--check', `${folder}/${file}`], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax checks passed.');
