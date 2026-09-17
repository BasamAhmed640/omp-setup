import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep the original pointer location and override compatible; a display rename must not unlink a vault.
export const configPath = () => join(process.env.PI_RESEARCH_CONFIG_DIR || join(homedir(), '.pi', 'agent', 'research'), 'config.json');
export async function readConfig() {
  try {
    const value = JSON.parse(await readFile(configPath(), 'utf8'));
    if (value.version !== 1 || typeof value.vaultRoot !== 'string' || typeof value.vaultId !== 'string') throw new Error('Invalid Discover configuration');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeConfig(value) {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify({ version: 1, ...value }, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
// Read only Scholar's location pointer, never its books or conversation contents.
export async function scholarRoots() {
  const roots = [process.env.PI_SCHOLAR_OBSIDIAN_ROOT].filter(Boolean);
  const state = process.env.PI_SCHOLAR_STATE_ROOT || join(homedir(), '.pi', 'agent', 'scholar');
  try {
    const config = JSON.parse(await readFile(join(state, 'config.json'), 'utf8'));
    if (config.obsidianRoot) roots.push(resolve(config.obsidianRoot));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot validate Scholar separation: ' + error.message); }
  return roots;
}
export function scholarOwnsInput(entries) {
  const pointer = [...entries].reverse().find(entry => entry.type === 'custom' && entry.customType === 'scholar-active-v3');
  return Boolean(pointer?.data?.active && pointer.data.mode);
}
export function parseCommand(input) {
  const match = String(input || '').trim().match(/^(\S+)?\s*([\s\S]*)$/);
  let argument = (match?.[2] || '').trim();
  if (argument.length >= 2 && ((argument.startsWith('"') && argument.endsWith('"')) || (argument.startsWith("'") && argument.endsWith("'")))) argument = argument.slice(1, -1);
  return { command: (match?.[1] || '').toLowerCase(), argument };
}
