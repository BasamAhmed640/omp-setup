# Discover overhaul — chat answers that become Obsidian notes

## Context

`pi-discover` is a Pi extension (`pi install git:github.com/BasamAhmed640/pi-discover`, currently v0.6.3) that answers questions in the Pi composer and writes results into a linked Obsidian vault. Its current shape is the problem: two effort modes (`ask`/`deep`), a scripted evidence reviewer, an installed Obsidian companion plugin that renders answers as sandboxed-HTML chart iframes and `.html` "Reports", a browser-rendered layout checker, conversation forking, 11 model tools, and ~4.5 kLOC of source plus a committed plugin bundle.

The overhaul replaces that product shape: `/discover` becomes a chat — you type a question, the extension runs a small parallel research crew itself, streams back a short direct answer in the terminal, and appends a dense, information-heavy section to one Markdown note per chat in the vault. No modes, no plugin, no HTML, no layout checking, no forking. Vault linking and reconnect-to-a-linked-vault are kept exactly as they work today. Sources become real notes in the vault and are cited by wiki-link. Answers are concise and unsentimental: information first, no assistant warmth.

Decisions already fixed by the user: short brief in Pi + dense note in Obsidian; one running note per chat; adaptive agent fan-out; keep chats + images + PDFs (drop forking); related-chat links now via a cheap incremental index.

## Verified facts this plan relies on

Run of `main` @ `8195ae8a` fetched read-only into session scratch (`local://pi-discover-src/`); Pi SDK/SDK docs read from the installed `@earendil-works/pi-coding-agent@0.85.1`.

- Extension contract: `ExtensionAPI` gives `registerCommand`, `registerTool`, `on('input'|'session_start'|'session_shutdown'|…)`, `sendMessage({customType, content, display}, {triggerTurn})`, `appendEntry`, `registerMessageRenderer`, `setActiveTools`; `ExtensionContext` gives `ui` (`setStatus`, `setWidget`, `setEditorComponent`, `select`, `confirm`, `input`, `notify`, `getEditorText`, `setEditorText`), `model`, `thinkingLevel`, `modelRegistry`, `sessionManager`, `hasUI`, `isIdle()`.
- `ModelRegistry.complete(model, context, options)` and `ModelRuntime`'s `streamSimple(model, context, options)` take a plain `{systemPrompt, messages, tools}` context — stateless single-shot calls, no session required. A working precedent exists on this machine: `C:\Users\basam\.pi\agent\extensions\scholar\review-runtime.ts` runs a bounded tool loop with `modelRegistry.getProvider()` + `getApiKeyAndHeaders()` + `provider.streamSimple(..., {reasoning, signal, maxTokens, sessionId, transport:'sse', maxRetries:0})`, and `review-layer.ts` fans 12 of those out concurrently. `clampThinkingLevel` is imported from `@earendil-works/pi-ai`; `@earendil-works/pi-tui` is importable for widget components. Neither is declared as a dependency in that extension's `package.json`.
- `InputEvent` carries `text` and `images?: ImageContent[]` — pasted images arrive with the submitted message, no attach command needed for images.
- A message sent with `pi.sendMessage({customType, content, display:true})` is rendered by the host as a labeled box containing **Markdown** (`dist/modes/interactive/components/custom-message.js`: `new Markdown(text, 0, 0, markdownTheme, …)`); a custom renderer is optional.
- Current vault writes (to be replaced): `Conversations/`, `Sources/<uuid>/`, `Knowledge/`, `Visuals/<uuid>/`, `Attachments/`, `_Research/*`, and `.obsidian/plugins/pi-research/`. Machine-local vault pointer: `~/.pi/agent/research/config.json` = `{version:1, vaultRoot, vaultId}` (env override `PI_RESEARCH_CONFIG_DIR`); vault identity today at `<vault>/_Research/vault.json`.
- Dev loop command: `pi -e ./index.ts` (`docs/extensions.md:103-106`). Install/update: `pi install git:…`, `pi update git:…`.

---

## Approach

Ordered so the tree stays valid after each step: new modules land first (unreferenced), then the host surface switches to them, then the obsolete surface is deleted, then tests/docs.

### Step 1 — Land the new vault layer

New files: `src/vault.mjs`, `src/index-store.mjs`, `src/notes.mjs`.

**Folder and file contract** (all under the linked vault root; `_` prefix marks machine-owned dirs):

```text
_discover/vault.json         {"version":1,"id":<uuid>,"createdAt":<iso>}
_discover/active.json        {"version":1,"chatId":<uuid>}
_discover/writer.lock        {"version":1,"pid":<n>,"host":"<os.hostname()>","startedAt":<iso>,"token":<uuid>}
_discover/index.json         {"version":1,"updatedAt":<iso>,
                              "chats":{"<chatId>":{"path","title","topics":[],"sources":[<sourceId>],"updatedAt"}},
                              "sources":{"<sourceId>":{"path","url","title","kind":"web|pdf","hash","retrievedAt"}}}
_discover/chats/<chatId>.json {"version":1,"id","title","notePath","createdAt","updatedAt","model","topics":[],"sources":[],"turns":<n>}
_discover/pdf/<sha48>/…      extracted page text + page PNG cache (kept from current pdf.mjs)
Chats/<YYYY-MM-DD> <Title>.md
Sources/<Title> (<hash8>).md
Style/Voice.md               read-only, user-owned, optional, ≤4000 chars injected into the writer prompt
```

`src/notes.mjs` exports pure builders/parsers (no fs):

- `frontmatter(fields) -> string` — YAML block, keys in fixed order.
- `callout(kind, title, bodyLines, {collapsed}) -> string` — `> [!kind]- Title` + `> ` lines; emits `>` for blank lines inside the callout.
- `questionHeading(index, text) -> string` — `## <n>. <text>` (question verbatim, single line; newlines collapsed to spaces).
- `appendExchange(noteText, exchange) -> string` — appends `\n\n` + heading + provenance callout + body section before the trailing related-marker block when present, otherwise at end.
- `relatedBlock(entries) -> string` — wrapped in `<!-- discover:related:start -->` / `<!-- discover:related:end -->`.
- `rewriteBlock(noteText, marker, block) -> string` — replace between markers; missing markers → append at end.
- `splitExchanges(noteText) -> [{question, body}]` — split on `^## ` headings.
- `recentExchanges(noteText, count, charBudget) -> string` — last N exchanges, trimmed to the last `charBudget` characters on whole lines.
- `normalizeObsidianMarkdown(text) -> string` — outside fenced code blocks convert `\(…\)` → `$…$` and `\[…\]` → `$$…$$`; collapse 3+ blank lines to 2; strip trailing whitespace; guarantee a trailing newline.
- `sanitizeTitle(text) -> string` — strip `[\\/:*?"<>|#^\[\]]`, collapse whitespace, trim trailing dots/spaces, cap 80 chars, empty → `Untitled chat`.
- `sourceFileName(title, hash8) -> string`, `chatFileName(date, title) -> string`, `sourceRef(sourceId, title, hash8) -> "[[Sources/<Title> (<hash8>)|<Title>]]"` — the exact wiki-link string handed to the model.
- `uniquePath(exists, dir, baseName, ext) -> string` — appends ` 2`, ` 3`… on collision.

`src/vault.mjs` exports `openVault(root, {scholarRoots}) -> Vault` and class `Vault`:

- `ensure()` — create `_discover/`, `_discover/chats/`, `Chats/`, `Sources/`; write `_discover/vault.json` when absent, adopting the id from `_Research/vault.json` when that legacy file exists and parses (keeps an existing linked vault's identity stable). Identity mismatch against the stored pointer throws `'Discover vault identity does not match the saved binding'`.
- `acquireLock()` / `releaseLock()` / `unlockStale()` — token/pid/host lock. Stale when `host === os.hostname()` and the pid is not alive → steal silently; a live lock from another host throws `'This vault is being written by <host>. Close that Pi instance or run /discover unlock.'`.
- `writeFile(relPath, text)` / `readFile(relPath)` — atomic temp-file + rename, `mkdir -p`, per-path promise serialization, path-escape and symlink guard (copy the guard rules from the current `src/vault.mjs:safePath`).
- `storeSource({url, title, kind, text, hash}) -> {id, path, ref, title, reused}` — dedupe key `sha256(normalizedUrl)` for `web` (lowercase scheme+host, no fragment, drop `utm_*`/`fbclid`/`gclid`/`ref`, remaining query params sorted) and `sha256(fileBytes)` for `pdf`; reuse the existing `Sources/<Title> (<hash8>).md` when the id is already indexed by recording a new reference entry, else write it (template below).
- `noteSourceReference(sourceId, chatPath)` — rewrite the source note's `## Referenced by` block between `<!-- discover:refs:start -->`/`:end -->` with `- [[<chat note>]]` lines, deduped, sorted.
- `relatedChats(chatId, {limit:3})` — from the index: other chats with `sharedSources >= 2 || sharedTopics >= 3`, ties broken by most recent `updatedAt`.
- `upsertIndexChat(record)` / `upsertIndexSource(record)` / `setActive(chatId)` / `getActive()` / `getChat(id)` / `listChats()` / `saveChat(record)`.

**Chat note template** (`Chats/<date> <Title>.md`):

```markdown
---
discover: chat
chat: <chatId>
title: <title>
created: <iso>
updated: <iso>
topics: [a, b]
tags: [discover/a, discover/b]
sources: 3
model: <provider/model-id>
---

# <title>

## 1. <question 1 verbatim>

> [!info]- Asked 2026-09-17 09:12 · 3 sources · <provider/model-id>
> [[Sources/AlphaEvolve (1b5c7b49)|AlphaEvolve]] · [[Sources/…]]

<note body>

<!-- discover:related:start -->
> [!link]- Related
> - [[Chats/2026-09-14 …]] — shares [[Sources/…]]
<!-- discover:related:end -->
```

Second and later turns append the same `## <n>. <question>` + provenance callout + body block; only the current note's related block is rewritten per turn. The related block is omitted entirely when the chat has no related notes, and removed when a rewrite finds none. Existing content outside the markers is never modified.

**Source note template** (`Sources/<Title> (<hash8>).md`):

```markdown
---
discover: source
title: <page title>
url: <url>
kind: web|pdf
retrieved: <iso>
hash: <sha256/16>
---

# <title>

<readable text; for kind:pdf, `## Page <n>` sections>

<!-- discover:refs:start -->
## Referenced by
- [[Chats/2026-09-17 …]]
<!-- discover:refs:end -->
```

**Vault pointer**: keep the existing machine-local path and fields verbatim — `join(process.env.PI_RESEARCH_CONFIG_DIR || join(homedir(), '.pi','agent','research'), 'config.json')`, `{version:1, vaultRoot, vaultId}`, mode `0o600`, atomic write. `src/config.mjs` also keeps `scholarRoots()` (Scholar pointer + `PI_SCHOLAR_OBSIDIAN_ROOT`) so `/discover vault` still rejects the Scholar vault and nested/aliased roots with the existing messages.

Empty/missing/error handling: missing vault pointer → the existing hint string `'Link an existing vault first: /discover vault "C:\\path\\to\\Vault"'`; vault path missing or not a directory → `'That vault folder does not exist.'`; `_discover/index.json` unreadable/corrupt → rebuild from `_discover/chats/*.json` and `Sources/*.md` frontmatter (index is derived data, never authoritative); a chat record whose note file is gone → drop the chat from `listChats()` and report `'<title>: note file is missing; the chat was skipped.'`.

### Step 2 — Land the research layer

New files: `src/tools.mjs` (web only), `src/research.mjs`, `src/citations.mjs`.

`src/tools.mjs` exports `createWebTools({vault, model, fetchImpl, lookupImpl}) -> Tool[]` with exactly two tools, each `{name, description, parameters, execute}` in the plain shape `modelRegistry.complete` expects:

| Tool | Parameters | Returns |
| --- | --- | --- |
| `web_search` | `query: string (≤500, required)`, `limit: integer 1–8 (default 5)` | `{results: [{title, url, snippet}]}` |
| `fetch_source` | `url: string (≤4096, required)`, `refresh: boolean` | `{sourceId, ref, title, url, text (≤24000 chars, `truncated` flag on the result), cached: boolean}` |

Keep the current hand-rolled keyless search + SSRF-guarded `pinnedFetch` implementation (the web-only subset of today's `src/tools.mjs`, unchanged in behavior: DNS-pinned lookup, size cap, redirect cap, content-type allowlist, HTML→text extraction). `fetch_source` resolves through the vault index first: an already-stored URL returns the stored text with `cached: true` unless `refresh: true`, in which case it refetches and rewrites the source note. Every successful fetch calls `vault.storySource(...)`, so the returned `sourceId`/`ref` is already backed by a file in `Sources/`. Failure returns `{error: '<kind>', url}` (`blocked`, `http-<code>`, `too-large`, `timeout`, `unsupported-type`) — never throws into the loop.

`src/research.mjs` exports:

- `route({model, registry, thinkingLevel, question, recentContext, signal}) -> {research: boolean, queries: string[], reason: string}` — one `streamSimple` call, tools `[]`, ≤400 output tokens, 45 s timeout; malformed JSON → one retry with `"Return only the JSON object."`; second failure → `{research:false, queries:[], reason:'routing failed'}`.
- `runWorker({model, registry, thinkingLevel, query, tools, signal, onProgress}) -> {query, findings:[{claim, quote, sourceId, ref}], gaps:string[], toolCalls:number, tokens:number}` — the bounded loop, adapted verbatim in structure from `scholar/review-runtime.ts:180-400`: build `context = {systemPrompt, messages:[{role:'user', content: prompt}], tools}`; loop `MAX_TURNS = 8`; each turn call `provider.streamSimple(requestModel, context, {reasoning, signal, maxTokens: min(6000, remaining), sessionId, transport:'sse', maxRetries:0})`, race against a 90 s no-event stall watchdog, append the assistant message, execute each `toolCall` block through the tool map, push `{role:'toolResult', …}` messages; stop on no tool calls. Enforce `MAX_TOOL_CALLS = 6` and `MAX_OUTPUT_TOKENS = 12000` per worker; on limit or provider error, return the packet with `gaps:['<reason>']` rather than throwing. Parse the final text as JSON; malformed → one repair request; still malformed → `{query, findings:[], gaps:['packet malformed']}`.
- `runCrew({queries, …}) -> packets[]` — `Promise.all` over at most 4 queries (`MAX_WORKERS = 4`); each worker gets its own `AbortController` linked to the turn signal; a rejected worker becomes `{query, findings:[], gaps:['<error>']}`.

Packets carry `ref` strings copied from `fetch_source` results; `citations.mjs` and the writer both use that exact string.

`src/citations.mjs` exports `checkCitations(noteBody, allowedRefs) -> {body, unresolved: string[], cited: number}`: find `\[\[Sources/[^\]|]+(\|[^\]]*)?\]\]`, keep only those whose target matches an `allowedRefs` entry (this turn's sources plus sources already indexed for this chat), and replace every other occurrence with its display text as plain text plus ` (unresolved source)`. `cited` counts surviving links. No model call.

### Step 3 — Land the answer layer

New file: `src/answer.mjs` — the writer prompt, the outcome parser, and the writer call.

- `WRITER_PROMPT` (literal, assembled with the context sections appended):

```
You write one answer for a competent reader who wants the answer, not a lesson.
The user's question is in the current Obsidian vault conversation. The host prints the question above
your note body and shows your brief in the terminal.

Return exactly three sections in this order, each marker alone on its own line:

<<<META>>>
{"title": "...", "topics": ["..."], "confidence": "high|medium|low", "open": ["..."]}
<<<BRIEF>>>
<2-5 sentences, at most 700 characters>
<<<NOTE>>>
<the note body>

META. title: 4-8 words naming the question, no trailing period. topics: 1-5 lowercase kebab-case subject
tags. confidence: how well the evidence supports the answer. open: 0-3 unresolved questions worth
revisiting.

BRIEF. Lead with the answer. Plain, direct, no greeting, no restating the question, no "sure"/"great
question", no lists, no headings, no links. Include the numbers and the one caveat that decides how the
answer should be read.

NOTE. The durable record.
- Never restate the question; the host prints it above the body.
- First sentence answers. Then the mechanism, evidence or reasoning that makes it true, in the order a
  reader needs it. No preamble, no "in this note", no roadmap.
- Length follows the question. A fact gets two sentences; a mechanism gets its reasoning chain. Never pad
  to look thorough. Ceiling 700 words unless the question explicitly asks for depth.
- Structure with Obsidian callouts, not headings. `> [!abstract]` for the bottom line when the body runs
  past about 250 words. `> [!important]` for the decisive fact or condition. `> [!note]` for supporting
  detail. `> [!example]` for a worked example with units and intermediate steps. `> [!warning]` for
  limits, counterevidence, contested claims, or evidence you could not get. `> [!quote]` for a verbatim
  source quote, with its source link on the following line. At most four callouts; each must carry
  something prose would bury. Leave a blank `>` line inside a callout before a new paragraph.
- Other structure only when it beats prose: a Markdown table when three or more items are compared
  across two or more dimensions; a ```mermaid block for a mechanism, timeline, hierarchy, or decision
  flow; a numbered list for a procedure. Mermaid: at most 12 nodes, quoted labels, no styling
  directives, never `xychart-beta`.
- Math: `$...$` inline and `$$...$$` display. Never `\(` or `\[`.
- Headings inside the body: `###` at most twice.
- Every factual claim taken from the research packets carries that packet's source link verbatim,
  beside the claim. Never invent a link and never cite a source you were not given. Write from the
  conversation and general knowledge when there are no packets, and say so when that is the basis.
- Keep observation, evidence, inference and assumption distinct. Never present correlation as cause.
  Keep the quantities, dates and uncertainty the sources give; never invent precision.
- No filler: no praise, no "it's worth noting", no "in conclusion", no closing summary that repeats the
  answer, no offers to continue, no apologies, no emoji, no horizontal rules, no exclamation marks, no
  second-person coaching. Warmth is not information.
```

  Context sections appended, in this order, omitting empty ones: `## Question` (verbatim), `## Conversation so far` (last 3 exchanges, ≤6000 chars), `## Research packets` (JSON, ≤24000 chars, each finding carrying `claim`/`quote`/`ref`), `## Attachments` (extracted text ≤12000 chars; images as content blocks), `## User writing preferences` (`Style/Voice.md`, ≤4000 chars).
- `writerContext({question, recent, packets, attachmentText, voice}) -> {systemPrompt, userContent}`; `WriterOutcome = {meta, brief, note: string}`.
- `parseOutcome(text) -> {outcome, error?}` — split on the three markers; validate `META` as JSON with `title` string, `topics` array of ≤5 kebab-case strings, `confidence` in `high|medium|low`, `open` array of ≤3 strings; `BRIEF` non-empty; `NOTE` non-empty. Any violation → `error`.
- `writeAnswer({model, registry, thinkingLevel, …}) -> {outcome, usage}` — one `streamSimple` call (`MAX_OUTPUT_TOKENS = 12000`, 180 s timeout, 90 s stall watchdog, images only when `model.input.includes('image')`). On `parseOutcome` error: one repair call appending `'Return the three sections again, in the required format, with no other text.'`; on a second failure use the deterministic fallback — `note` = the raw response with any markers stripped, `brief` = the first 700 characters up to the first sentence boundary, `meta = {title: sanitizeTitle(question), topics: [], confidence: 'low', open: []}` — and report `'Answer format was malformed; the note was saved without structure.'` as a warning. A turn never fails on formatting.

### Step 4 — Land the chat orchestration

New file: `src/chat.mjs` — `class Chat` and `class ChatSession` (the turn state machine). No SDK session, no `createAgentSession`, no session JSONL, no compaction hook, no publication staging.

`ChatSession` methods and exact sequence for `runTurn({text, images, ctx})`:

1. Refuse when a turn is in flight (`'Still working. Your draft is preserved; /discover stop interrupts.'` — reuse today's string).
2. `vault.ensure()`, `vault.acquireLock()`; resolve the chat: active chat from `_discover/active.json` when one exists and its note file is present, otherwise create one (id `randomUUID()`, note path `Chats/<YYYY-MM-DD> <sanitizeTitle(title)>.md`, unique on collision). Title precedence: an explicit `/discover new "<title>"` argument, else the writer's `META.title`, else `sanitizeTitle(question)`. The filename is written once, on the chat's first note write. If a recorded `notePath` is missing at turn time, search `Chats/*.md` frontmatter for `chat: <chatId>`; found → update `notePath` to the found file and continue; not found → recreate the note at the recorded path.
3. `recent = recentExchanges(noteText, 3, 6000)`.
4. Stage attachments: staged PDFs are extracted now (`src/pdf.mjs`, text of pages 1–20 in `## Page <n>` sections, hashed into `_discover/pdf/<sha48>/`; page images only for up to two page numbers named in the question text when the model accepts images); images from `input.images` pass through as content blocks. Images — pasted or PDF page renders — are content blocks on the **writer** call only; the router and workers never receive images. When images are present and the selected model's `input` lacks `'image'`, drop them and notify `'The selected model cannot read images; the attachment was ignored.'`.
5. `route(...)` → progress `routing`.
6. When `research`, `runCrew(...)` → progress `researching <done>/<total>` with one widget line per query.
7. `writeAnswer(...)` → progress `writing`.
8. `normalizeObsidianMarkdown(note)` then `checkCitations(note, allowedRefs)`; unresolved refs are reported as a `> [!warning]- <n> citation(s) could not be resolved` callout appended to the section, listing them.
9. Assemble the section (heading, provenance callout, body, warnings), append to the note, recompute the related block in place, `upsertIndexChat`, `upsertIndexSource` for each fetched source, `noteSourceReference` for each cited source, `setActive`, `saveChat` (turns+1), `releaseLock()`.
10. `pi.sendMessage({customType:'discover', content: outcome.brief, display:true}, {triggerTurn:false})`.
11. Clear staged attachments on success; keep them on failure.

`src/attachments.mjs` exports `createAttachments({vault, pdf})` with `stage(path)`, `clear()`, `list()`, `evidence({question, model, signal})`. `stage` rejects a missing path (`'<path>: file not found.'`), a directory, a file over 50 MiB, and any non-`.pdf` extension (`'Only PDF files can be staged; paste images with Alt+V.'`), and returns the staged entry list for the status line. `evidence` calls `pdf.readPdf` for pages 1–20, stores the extracted text through `vault.storeSource({kind:'pdf', hash: sha256(bytes)})` so the PDF is citable like a web page, and returns `{text (≤12000 chars), images: []|[≤2 page renders], sources: [refs]}`; page renders are produced only when the question contains a page number (`page 7`, `p. 7`, `§7`) or the PDF has ≤2 pages, and only when the model accepts images. Staged entries persist until the next successful turn or `/discover clear`; a failed turn keeps them.

Turn caps: ≤4 workers, ≤4+1 model calls per worker, writer ≤2 calls, total ≤8 model calls; wall clock 5 minutes (`/discover stop` aborts the shared `AbortController`). A turn that fails before writing leaves the note untouched and restores the draft (`ctx.ui.setEditorText`) when the editor is empty, matching today's behavior. Cancelled or failed turns write nothing.

Progress/telemetry: status key `discover` with `discover · routing`, `discover · researching 2/3 · 12s`, `discover · writing`, `discover · saving note`, cleared on completion; a widget keyed `discover` renders one line per worker (`<query> — searching|reading|done (3 findings)|failed`) using the `setWidget(key, (tui, theme) => ({render, invalidate}))` + `tui.requestRender()` pattern copied from `scholar/loading-progress.ts:66-78`; the final status line `discover · 3 sources · 41s · 9.4k tok` stays until the next turn.

### Step 5 — Switch the host surface

Rewrite `src/extension.mjs` and `src/commands.mjs`; add `src/progress.mjs`.

- `index.ts` stays as it is: `pi` type import + `registerDiscover(pi, {...})` with the lazy `loadSdk`.
- `registerDiscover(pi, {loadRuntime})` registers exactly these commands (single table in `src/commands.mjs`, used for dispatch, `/discover` argument completions and `/discover help`):

| Command | Args | Effect |
| --- | --- | --- |
| `/discover` | — | open; reconnect to the linked vault and reopen the active chat, else start a new one |
| `/discover new` | `[title]` | start a new chat (title optional; defaults to the first question's title) |
| `/discover pick` | — | `ctx.ui.select` over `vault.listChats()` (`<date> · <title> · <n> turns`), reopen the selection |
| `/discover attach` | `"path"` | stage a file (PDF) for the next message |
| `/discover clear` | — | clear staged files |
| `/discover stop` | — | abort the in-flight turn |
| `/discover exit` | — | close and release the vault writer |
| `/discover vault` | `"path"` | link/relink a vault (unchanged validation + Scholar rejection) |
| `/discover unlock` | — | remove a stale writer lock |
| `/discover help` | `[command]` | guide from the same table |

  Every row also carries a one-line `description`; that string is what `/discover <name>` argument completions show and what `/discover help` prints per command (`/discover attach — stage a file (PDF) for the next message`), and `/discover help <name>` prints the same line plus the argument form. Unknown subcommand → `'Unknown Discover command. Use /discover help.'` (existing string).

  `src/config.mjs` keeps only `configPath`, `readConfig`, `writeConfig` (existing shapes and env override) and `scholarRoots`; argument quoting/unquoting moves into `parseCommand` in `src/commands.mjs`.
- `pi.on('input', …)` — copy today's handler shape: return `{action:'continue'}` when there is no open chat, when `event.source === 'extension'`, or when Scholar owns input; otherwise dispatch `chat.runTurn(...)` and return `{action:'handled'}`. While busy: preserve the draft + warn. Keep the Scholar guard (`scholarOwnsInput`) exactly as it is so the two extensions do not fight over input.
- `pi.on('session_start'|'session_shutdown', …)` → close: abort the turn, release the lock, restore the editor.
- `src/progress.mjs` owns the status/widget strings above and is the only module that touches `ctx.ui`.

### Step 6 — Delete the removed surface

Delete exactly: `obsidian/` (whole directory), `scripts/build-companion.mjs`, `src/controller.mjs`, `src/review.mjs`, `src/presentation.mjs`, `src/publication.mjs`, `src/context.mjs`, `src/session-store.mjs`, `src/workflows.mjs`, `src/pi-models.mjs`, `src/install.mjs`, `src/prompt.mjs` (superseded by `src/answer.mjs`), `docs/feature-audit.md`, `docs/response-engine.md`, `docs/validation.md`, `docs/design.md`, `docs/formatting-preview-360.png`, `docs/formatting-preview-760.png`, `docs/preview-dark.png`, `tests/browser/`, and all ten old `tests/*.test.mjs` files (Step 7 replaces them).

After Step 6 the extension consists of: `index.ts`; `src/extension.mjs`, `src/commands.mjs`, `src/config.mjs`, `src/chat.mjs`, `src/progress.mjs` (host/session); `src/answer.mjs`, `src/research.mjs`, `src/tools.mjs`, `src/citations.mjs` (pipeline); `src/vault.mjs`, `src/index-store.mjs`, `src/notes.mjs`, `src/attachments.mjs`, `src/pdf.mjs`, `src/pdf-worker.mjs` (storage and documents); `scripts/check.mjs`; `tests/`.

`package.json`: version `0.7.0`; remove the `build` script and the `esbuild` devDependency; `check` becomes `node scripts/check.mjs` (trim `scripts/check.mjs` to `node --check` every `.mjs`/`.js` under `src`, `scripts`, `tests`); keep `test` = `node --test tests/*.test.mjs`; keep `dependencies` (`@hyzyla/pdfium`, `pngjs`) and the optional peer `@earendil-works/pi-coding-agent >=0.85.1 <0.86`; add nothing else — `@earendil-works/pi-ai` and `@earendil-works/pi-tui` are host-provided and imported directly, as `scholar` does.

Also delete the now-dead code inside the kept files: `src/pdf.mjs` keeps `readPdf` + the page cache and drops every vault/attachment/visual coupling it inherited; `src/attachments.mjs` is new and owns image passthrough plus PDF staging.

Nothing in the user's existing vault is deleted or migrated: `Conversations/`, `Reports/*.html`, `Visuals/`, `Knowledge/`, `Attachments/`, `Sessions/`, `_Research/` and the installed `.obsidian/plugins/pi-research/` companion all stay exactly as they are. The extension stops installing, referencing or writing them; new content goes only to `Chats/`, `Sources/` and `_discover/`.

### Step 7 — Tests

`npm test` runs `node --test tests/*.test.mjs`. New files, each testing behavior that a plausible regression would break:

- `tests/notes.test.mjs` — `appendExchange` keeps existing content byte-identical outside the new section; `rewriteBlock` is idempotent and appends when markers are missing; `splitExchanges` round-trips a two-exchange note; `normalizeObsidianMarkdown` converts `\(x\)` but not inside a fenced block; `sanitizeTitle` strips forbidden characters and caps at 80; `uniquePath` collision suffixes.
- `tests/citations.test.mjs` — a resolvable ref survives; an unknown ref becomes plain text + `(unresolved source)` and is reported; counts are right with mixed refs.
- `tests/index-store.test.mjs` — source dedupe by normalized URL (tracking params/fragment ignored) reuses one file and appends a reference; PDF dedupe by content hash; corrupt `index.json` rebuilds from `_discover/chats/*.json`; `relatedChats` returns the shared-2-sources case and excludes the shared-1-source case.
- `tests/answer.test.mjs` — `parseOutcome` accepts a well-formed triple; rejects a missing `<<<NOTE>>>`, bad `confidence`, and non-JSON META; the repair path issues exactly one extra call and the fallback yields a usable note when both fail (drive it with a stub `streamSimple`).
- `tests/research.test.mjs` — the worker loop executes at most 6 tool calls / 8 turns, feeds tool results back, and returns `gaps` instead of throwing when the provider errors or the packet is malformed; `runCrew` isolates one failing worker and still returns the other packets.
- `tests/vault.test.mjs` — path escape (`../`), symlinked target and absolute-path writes are refused; lock steal only when the pid is dead and the host matches; identity mismatch throws.
- `tests/commands.test.mjs` — the command table drives dispatch, completions and help; unknown subcommand message; `/discover` with no linked vault returns the hint string.

### Step 8 — README

Rewrite `README.md` for the new surface: install/update commands, `/discover` usage table, vault layout (`Chats/`, `Sources/`, `_discover/`, `Style/Voice.md`), the number of model calls per turn, what is written where, and the note that existing `Pi Research`/`Discover` vault content and the old companion plugin are untouched by the upgrade. No other documentation is required.

---

## Critical files & anchors

- `src/notes.mjs` — every literal the notes are made of (frontmatter keys, callout kinds, markers, titles). Implementer writes this first; the writer prompt and the note tests both depend on it.
- `src/chat.mjs` — the only place with the turn order and the caps; step ordering here defines behavior.
- `src/extension.mjs` + `src/commands.mjs` — the entire Pi contract; copy the input-handler and Scholar-guard shape from the current `src/extension.mjs:155-200` (already fetched to `local://pi-discover-src/src/extension.mjs`).
- `C:\Users\basam\.pi\agent\extensions\scholar\review-runtime.ts:180-400` — the proven bounded tool loop to adapt (provider + auth + `streamSimple` + stall watchdog) instead of inventing one.
- Current `src/tools.mjs` — the web-search/SSRF/fetch implementation to keep (drop the PDF, attachment, note, visual and knowledge tools around it).

## Verification

Prerequisites: repo at `~/.pi/agent/extensions/…` or a clone; `npm ci --ignore-scripts --legacy-peer-deps` (needs `@hyzyla/pdfium` + `pngjs`); Pi `0.85.1` on PATH (`pi --version`); a scratch vault: `mkdir "C:\Users\basam\Desktop\discover-test"` with an empty `.obsidian` folder.

1. `npm test` from the repo root — all new tests pass; `npm run check` reports no syntax errors.
2. Deterministic layer without a model: `node --test tests/notes.test.mjs tests/citations.test.mjs tests/index-store.test.mjs tests/vault.test.mjs` proves note assembly, citation repair, dedupe/index/related and vault confinement.
3. Live chat turn: `pi -e ./index.ts`, then `/discover vault "C:\Users\basam\Desktop\discover-test"`, then ask *"What did the EU AI Act's transparency obligations change in 2026?"*. Expect: `discover · researching 2/…` progresses, then a labeled markdown message in the terminal whose first sentence answers the question, in ≤5 sentences, with no preamble. Open `Chats/2026-09-17 <title>.md`: frontmatter with `discover: chat`, `topics`, `tags: [discover/…]`, `sources: ≥1`; an H2 with the question verbatim; a collapsed `> [!info]-` provenance line; body with at least two `[[Sources/…]]` links and at least one callout; and a `Sources/<Title> (<hash8>).md` for every cited link whose text is a readable copy of the page (not a stub), with the chat listed under `## Referenced by`.
4. Follow-up turn: ask *"And what happens to general-purpose models under that rule?"* in the same chat. Expect a second `## 2. …` section appended, turn 1's section byte-identical to before, `sources` and `updated` refreshed in frontmatter only, and the related block rewritten in place between its markers.
5. No-research turn: ask *"Explain why a Mersenne prime can't be even."* Expect no `researching` phase, no new `Sources/` note, and a note whose body is prose plus at most one callout — proving the router skipped the crew.
6. Reconnect: exit Pi, relaunch `pi -e ./index.ts`, run `/discover`. Expect the same vault and the same chat (`_discover/active.json`), and `/discover pick` listing it.
7. Attachment: paste an image with Alt+V and ask about it (model must accept images); then `/discover attach "<a real pdf>"` and ask a question about page 3; expect `_discover/pdf/<sha48>/` content, PDF text in the writer context, and a `Sources/<file> (<hash8>).md` note with `kind: pdf`.
8. Citation repair end-to-end: hand-edit a copied note body to cite `[[Sources/Nope (00000000)|Nope]]`, then re-run one turn in that chat and confirm the fabricated link is present only as plain text and the section carries the unresolved-citation warning.
9. Old vault untouched: snapshot `find "C:\Users\basam\Desktop\Discover\Research Studio" -type f -printf '%p %s %T@\n' | sort` before and after a session against that vault and diff the snapshots — no differences, and no file written under `.obsidian/plugins/pi-research/`.

## Assumptions & contingencies

- `@earendil-works/pi-ai` and `@earendil-works/pi-tui` resolve from an extension at runtime (true for `scholar` on this machine at SDK 0.85.1). If a runtime import fails, drop explicit thinking-level control and use `modelRegistry.complete(model, context, {signal, maxTokens, sessionId, transport:'sse', maxRetries:0})`, and render progress with `ctx.ui.setStatus` only.
- Obsidian's bundled Mermaid handles `flowchart`, `sequenceDiagram`, `stateDiagram`, `timeline`, `pie`, `gantt`, `quadrantChart`, `mindmap`; `xychart-beta` support is version-dependent, so the prompt forbids it and numeric series go into tables. If the implementer verifies the bundled version supports it, the prompt rule may be relaxed.
- The keyless DuckDuckGo/Bing search path may rate-limit or challenge; that is already reported as a gap in the worker packet, and a worker that cannot retrieve anything produces an answer marked with the `> [!warning]` evidence limit rather than a silent claim.
- The user's existing vault pointer at `~/.pi/agent/research/config.json` and `_Research/vault.json` must keep working without relinking; if the implementer finds either file unreadable in the test vault, link it explicitly with `/discover vault` and record the failure in the final report instead of guessing at a new format.
- If the writer exceeds its 12k output budget on a long answer, the truncated response is treated as malformed and goes through the same repair/fallback path; the plan does not add a second long-form call.