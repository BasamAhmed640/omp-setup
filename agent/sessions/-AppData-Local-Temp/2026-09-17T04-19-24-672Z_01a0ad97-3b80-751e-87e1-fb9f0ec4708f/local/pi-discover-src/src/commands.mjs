// One static catalogue keeps autocomplete, help and accepted command names in
// sync. Browsing it must not read a vault, load the SDK or activate an agent.
export const DISCOVER_COMMANDS = Object.freeze([
  { name: 'ask', group: 'Conversations', description: 'Direct answers; research when needed.' },
  { name: 'deep', group: 'Conversations', description: 'Investigate sources and review substantial answers.' },
  { name: 'help', args: '[command]', group: 'Help and recovery', description: 'Show this guide, or help for one command.' },
  { name: 'new', args: '[title]', group: 'Conversations', description: 'Start a fresh conversation, with an optional title.' },
  { name: 'resume', args: '[title or ID]', group: 'Conversations', description: 'Choose a saved conversation, or reopen one by title or ID.' },
  { name: 'attach', args: '"file path"', group: 'Attachments', description: 'Stage an image, PDF or file for your next message; open Discover first.' },
  { name: 'continue', args: '"note path"', group: 'Conversations', description: 'Start a new discussion using the selected vault note.' },
  { name: 'fork', args: '<conversation ID> <entry ID>', group: 'Conversations', description: 'Branch from a published response; keeps the original conversation.' },
  { name: 'branch', args: '<conversation ID> <entry ID>', group: 'Conversations', description: 'Alias for fork; explore another direction from a saved response.' },
  { name: 'clear-attachments', group: 'Attachments', description: 'Remove staged files from the next message; keeps saved originals.' },
  { name: 'stop', group: 'Session', description: 'Stop the current answer or review; preserve the draft.' },
  { name: 'exit', group: 'Session', description: 'Close Discover and return to ordinary Pi input.' },
  { name: 'vault', args: '"folder path"', group: 'Setup', description: 'Link a vault outside Scholar\'s vault and install its companion automatically.' },
  { name: 'install-plugin', group: 'Help and recovery', description: 'Repair or refresh the Obsidian companion; normal setup installs it automatically.' },
  { name: 'repair', group: 'Help and recovery', description: 'Rebuild the open conversation\'s readable notes from saved messages.' },
  { name: 'unlock', group: 'Help and recovery', description: 'Clear a stale vault lock after closing other Pi writers.' },
].map(item => Object.freeze(item)));

export function getDiscoverArgumentCompletions(prefix) {
  const input = prefix.trimStart();
  const help = /^help\s+(\S*)$/i.exec(input);
  if (!help && /\s/.test(input)) return null; // Preserve filenames, titles and IDs.
  const query = (help ? help[1] : input).toLowerCase();
  const matches = DISCOVER_COMMANDS.filter(item => item.name.startsWith(query));
  return matches.length ? matches.map(item => ({
    value: help ? `help ${item.name}` : item.name + (item.args ? ' ' : ''),
    label: item.name, description: item.description,
  })) : null;
}

const usage = item => `/discover ${item.name}${item.args ? ` ${item.args}` : ''}`;
export function discoverHelp(topic = '') {
  if (topic.trim()) {
    const command = DISCOVER_COMMANDS.find(item => item.name === topic.trim().toLowerCase());
    if (!command) throw new Error('Unknown help topic. Use /discover help to see all commands.');
    return `Discover: ${command.name}\n\n${usage(command)}\n${command.description}\n\n<...> is required; [...] is optional. Quote paths or titles containing spaces.\n/discover help shows the full guide.`;
  }
  const sections = ['Conversations', 'Attachments', 'Session', 'Setup', 'Help and recovery'].map(group => {
    const commands = DISCOVER_COMMANDS.filter(item => item.group === group).map(item => `  ${usage(item)}\n    ${item.description}`);
    if (group === 'Conversations') commands.unshift('  /discover\n    Open Discover and reopen the last conversation.');
    return `${group}\n${commands.join('\n')}`;
  });
  return `Discover: write in Pi; read answers and visuals in Obsidian.\nType /discover followed by a space to browse commands.\n\n${sections.join('\n\n')}\n\nFirst use: /discover vault installs the companion automatically. Enable Discover once in Obsidian, then run /discover in Pi.\n<...> is required; [...] is optional. Quote paths or titles containing spaces.\nExample: /discover attach "C:\\Papers\\study.pdf"`;
}
