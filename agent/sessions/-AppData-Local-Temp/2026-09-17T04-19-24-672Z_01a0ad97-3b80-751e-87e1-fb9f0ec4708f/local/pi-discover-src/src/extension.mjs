import { parseCommand, scholarOwnsInput } from './config.mjs';
import { DISCOVER_COMMANDS, discoverHelp, getDiscoverArgumentCompletions } from './commands.mjs';

async function loadServices() {
  const [config, vault, controller, install] = await Promise.all([
    import('./config.mjs'), import('./vault.mjs'), import('./controller.mjs'), import('./install.mjs'),
  ]);
  return { ...config, ...vault, ...controller, ...install };
}

export function registerDiscover(pi, { loadSdk, services = loadServices }) {
  let controller = null, lastContext = null, starting = false, closing = false;
  let operation = Promise.resolve(), closePromise;
  const notify = (ctx, message, level = 'info') => ctx.ui.notify(message, level);
  const options = ctx => ({ model: ctx.model, thinkingLevel: ctx.thinkingLevel });
  function ready(ctx) {
    if (!ctx.isIdle()) throw new Error('Finish or stop the current Pi turn before entering Discover.');
    if (scholarOwnsInput(ctx.sessionManager.getBranch())) throw new Error('Leave the active Scholar mode before entering Discover.');
    if (controller?.busy) throw new Error('Use /discover stop before changing the active conversation.');
  }
  async function release(ctx) {
    const previous = controller;
    controller = null;
    if (!previous) return;
    try { await previous.dispose(); }
    finally { (ctx || lastContext)?.ui.setStatus('pi-research', undefined); }
  }
  async function close(ctx) {
    if (closing) return closePromise;
    if (!controller && !starting) return;
    closing = true;
    closePromise = (async () => {
      try { await operation; await release(ctx); }
      finally { lastContext = null; closing = false; }
    })();
    return closePromise;
  }
  async function linkedVault(deps) {
    const config = await deps.readConfig();
    if (!config) throw new Error('Link an existing vault first: /discover vault "C:\\path\\to\\Discover Vault"\nUse /discover help for setup and all commands.');
    const vault = await deps.ResearchVault.open(config.vaultRoot, config.vaultId);
    await deps.ResearchVault.bind(vault.root, { scholarRoots: await deps.scholarRoots() });
    return vault;
  }
  async function choose(vault, name, ctx) {
    const conversations = await vault.listConversations();
    if (!conversations.length) throw new Error('There are no saved conversations yet.');
    let match = name ? conversations.find(item => item.id === name || item.title === name) : undefined;
    if (!match && name) throw new Error('Conversation not found. Use its ID or exact title.');
    if (!match && ctx.hasUI) {
      const labels = conversations.map(item => `${item.title} · ${item.id}`);
      const selected = await ctx.ui.select('Resume Discover conversation', labels);
      if (!selected) return null;
      match = conversations[labels.indexOf(selected)];
    }
    return match || conversations[0];
  }
  async function reopen(instance, ctx) {
    if (instance.session) return;
    let pointer;
    try { pointer = await instance.vault.readJson('_Research/active.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pointer?.conversationId) await instance.select(await instance.vault.getConversation(pointer.conversationId), options(ctx));
    else await instance.newConversation('New conversation', options(ctx));
  }
  async function execute(command, argument, ctx) {
    ready(ctx);
    // These commands must never activate a conversation as a side effect.
    if (['attach', 'clear-attachments', 'repair'].includes(command)) {
      if (!controller?.session) throw new Error('Open a conversation with /discover first.');
      if (command === 'attach') {
        if (!argument) throw new Error('Provide an attachment path.');
        const attached = await controller.attach(argument);
        notify(ctx, `Attached ${attached.name}. ${controller.attachments.length} staged attachment(s).`);
      } else if (command === 'clear-attachments') {
        controller.attachments = []; await controller.preserveDraft(''); notify(ctx, 'Staged attachments cleared.');
      } else {
        await controller.vault.recoverConversation(controller.conversation.id); notify(ctx, 'Readable conversation rebuilt from saved messages.');
      }
      return;
    }
    if (command === 'vault' && !argument) throw new Error('Provide the path of an existing Obsidian vault.');
    if (command === 'continue' && !argument) throw new Error('Choose a note: /discover continue "Knowledge/your-note.md"');
    const parts = argument.split(/\s+/);
    if (['fork', 'branch'].includes(command) && parts.length !== 2) throw new Error(`Usage: /discover ${command} <conversation ID> <native entry ID>`);
    if (command === 'unlock' && controller) throw new Error('Exit Discover before unlocking.');
    const deps = await services();
    if (command === 'vault') {
      await release(ctx);
      const vault = await deps.ResearchVault.bind(argument, { scholarRoots: await deps.scholarRoots() });
      await deps.installCompanion(vault);
      await deps.writeConfig({ vaultRoot: vault.root, vaultId: vault.id });
      notify(ctx, 'Vault linked; Discover’s Obsidian companion is installed.\nEnable Discover once in Obsidian → Settings → Community plugins, then run /discover in Pi.'); return;
    }
    const vault = controller?.vault || await linkedVault(deps);
    if (command === 'install-plugin') {
      await deps.installCompanion(vault);
      notify(ctx, 'Companion installed. Enable Discover under Obsidian → Settings → Community plugins, then open its Discover view.'); return;
    }
    if (command === 'unlock') { await deps.unlockVault(vault); notify(ctx, 'Stale writer lock cleared.'); return; }
    const selected = command === 'resume' ? await choose(vault, argument, ctx) : null;
    if (command === 'resume' && !selected) return;
    const fresh = !controller;
    if (fresh) await deps.installCompanion(vault);
    const active = controller || new deps.ResearchController(await loadSdk(), vault, {
      modelRegistry: ctx.modelRegistry,
      onStatus: (message, level) => {
        if (controller !== active || closing) return;
        const target = lastContext || ctx;
        target.ui.setStatus('pi-research', `${active.effort === 'deep' ? 'Deep' : 'Ask'} · ${message}`);
        if (level === 'error') notify(target, message, 'error');
      },
    });
    try {
      if (fresh) await active.acquire();
      if (command === 'new') await active.newConversation(argument || 'New conversation', options(ctx));
      else if (command === 'resume') await active.select(selected, options(ctx));
      else if (command === 'continue') {
        const note = await active.continueNote(argument, options(ctx));
        notify(ctx, 'Selected ' + note.path + '. Type your question in Pi.');
      } else if (command === 'fork' || command === 'branch') {
        await active.fork(await vault.getConversation(parts[0]), parts[1], options(ctx));
        notify(ctx, 'Branch created. Type your next question in Pi.');
      } else {
        if (command === 'ask' || command === 'deep') active.effort = command;
        await reopen(active, ctx);
      }
      if (fresh) ready(ctx); // The host may have started a turn while the vault was opening.
      controller = active;
      active.onStatus('Ready · ' + active.conversation.title);
      if (!closing && ['', 'new', 'resume', 'ask', 'deep'].includes(command)) notify(ctx, 'Discover ready. Type here; read and explore in Obsidian.\n'
        + (command === '' ? '/discover ask — Direct answers\n/discover deep — Source-based research\n/discover attach "file path" — Add an image or PDF\n' : '')
        + '/discover help — All commands and setup\n/discover exit — Return to ordinary Pi');
    } catch (error) {
      // Failed activation cannot retain a lock, half-open session, or input ownership.
      if (fresh || !active.session) {
        if (controller === active) controller = null;
        try { await active.dispose(); }
        catch (cleanup) { error = new Error(`${error.message}; cleanup failed: ${cleanup.message}`); }
        if (!fresh) ctx.ui.setStatus('pi-research', undefined);
      }
      throw error;
    }
  }
  const command = {
    description: 'Ask questions and research deeply in Discover; read in Obsidian. Use /discover help for commands.',
    getArgumentCompletions: getDiscoverArgumentCompletions,
    handler: async (args, ctx) => {
      const { command, argument } = parseCommand(args);
      try {
        if (command && !DISCOVER_COMMANDS.some(item => item.name === command)) throw new Error('Unknown Discover command. Use /discover help.');
        if (command === 'help') {
          notify(ctx, discoverHelp(argument)); return;
        }
        if (command === 'exit') { await close(ctx); notify(ctx, 'Discover closed. Ordinary Pi input is restored.'); return; }
        if (command === 'stop') { await controller?.stop(); return; }
        if (closing || starting) throw new Error('Discover is still opening or closing.');
        lastContext = ctx; starting = true;
        operation = execute(command, argument, ctx).catch(error => notify(ctx, error.message || String(error), 'error')).finally(() => { starting = false; });
        await operation;
      } catch (error) { notify(ctx, error.message || String(error), 'error'); }
    },
  };
  pi.registerCommand('discover', command);
  pi.on('input', (event, ctx) => {
    if (!controller?.session || closing || event.source === 'extension') return { action: 'continue' };
    lastContext = ctx;
    if (scholarOwnsInput(ctx.sessionManager.getBranch())) {
      notify(ctx, 'Discover input is paused while Scholar is active. Exit Scholar or /discover exit.', 'warning');
      return { action: 'continue' };
    }
    const current = controller;
    if (starting || current.busy) {
      if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
      if (event.images?.length) void current.preserveDraft(event.text, event.images).catch(error => { if (controller === current && !closing) notify(ctx, error.message, 'error'); });
      notify(ctx, 'Still working. Your draft is preserved; /discover stop interrupts.', 'warning');
      return { action: 'handled' };
    }
    void current.prompt(event.text, event.images || [], options(ctx)).catch(error => {
      if (controller !== current || closing) return;
      if (!error.researchAccepted && !ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
      notify(ctx, error.message || String(error), 'error');
    });
    return { action: 'handled' };
  });
  pi.on('session_start', (_event, ctx) => close(ctx));
  pi.on('session_shutdown', (_event, ctx) => close(ctx));
}
