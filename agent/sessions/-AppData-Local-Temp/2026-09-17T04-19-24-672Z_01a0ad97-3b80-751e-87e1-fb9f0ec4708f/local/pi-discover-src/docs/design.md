# Design decisions

Pi is the sole message composer. Obsidian is the reading and interaction surface. The two cooperate through saved vault files, with no local server or required database.

Vault linking installs the Obsidian companion automatically; opening a closed Discover also repairs missing or outdated companion files. The companion is a committed standalone bundle, manifest and stylesheet. It supplies the custom reading pane, interactive charts and rendered presentation checks; ordinary notes, Mermaid, photos and static previews remain readable through Obsidian's core features. Installation preserves plugin preferences and Obsidian's enabled-plugin list. Explicitly enabling the companion opens its reading pane; routine Obsidian startup does not steal focus.

Discover knowledge follows a small version of the LLM Wiki pattern: preserve fetched sources, write linked synthesis when asked, retain provenance, and retrieve relevant material on demand. Native conversation history and editable knowledge have distinct purposes. Generated summaries are never independent corroboration.

The Pi extension registers commands and inert event handlers at startup. Its SDK and research services load only on demand; setup commands do not activate the composer or acquire a writer. An explicit conversation command starts an isolated SDK session with only the research tools. It does not invoke the host's ordinary model turn or load Scholar hooks, global skills, prompts, or context files. The selected model and authentication are reused; Scholar content is excluded. Exit, host session replacement, reload, and shutdown release the session and writer; failed or cancelled activation cannot retain input ownership.

Agent responsibilities are independent of model vendors. The current lead and reviewer inherit Pi's selected provider/model through its public model registry, including custom providers and current authentication. A separate evidence assistant remains planned. If role-specific model choices are added, each must resolve a provider/model pair from Pi's registry and check capabilities; the default remains the user's selected model. No role is tied to a vendor, named model family or silent vendor fallback.

One lead agent offers two explicit effort choices. Ask, the default, favors direct answers and research when needed. Deep calls for deliberate investigation and comparison of primary sources. The choice applies to the next turn and remains active until changed or Discover is closed. Both reuse the selected model and lead tools; the initial investigation has no hard token budget. Deep now stages its answer and conditionally runs one bounded evidence reviewer before final publication. There is no automatic vault scan, separate checkpoint tool, or general subagent framework. Native Pi session history and compaction preserve conversational context; a selected note supplies explicit context for a new discussion.

Version 0.3.1 introduced a shared writing guide and a brief self-check within the same model response. The guide reaches Ask, Deep and tool continuations through the existing system-prompt path. Version 0.5.0 adds the bounded Deep evidence review alongside that guide. See the [engine, explanation principles and evaluation limits](response-engine.md).

Version 0.6.0 adds research instructions to the native compaction operation, branch-scoped recall of original messages/evidence, bounded source paging and a selective conversation brief for the reviewer. Context budgets follow the selected model's window. The lead and reviewer can recover exact evidence without importing an entire transcript or vault. Summaries and earlier answers remain labeled as derived context; no memory agent or MCP dependency is introduced. The [response engine](response-engine.md#context-retrieval) documents limits and the distinction between conversation recall and ordinary vault-note access.

| Action | Contract |
| --- | --- |
| Open a saved node | Local rendering only, without Pi or network |
| Continue a note | Start a linked discussion with the selected note's current contents |
| Resume a conversation | Restore its native saved history |
| Fork or branch at an entry | Copy native history through that published response and its publication marker; preserve the source and review link, keep internal drafts hidden, and exclude later turns and unsent attachments |
| Recover missing output | Deterministically project preserved native records |
| Change an answer/visual | New model work produces a separate saved snapshot |

Vault selection is mandatory and can be changed later. Discover content never lives in the package installation directory. Only the selected vault pointer is machine-local. Relinking never copies content between vaults. The native session and frozen presentations remain portable with the vault.

The Obsidian companion is vanilla JavaScript and scoped CSS. Declarative charts use a small local SVG renderer with series toggles and hover details. Controls stay within the open frame and reset on reopening. Each save creates an independent immutable chart, eliminating chart revision locks and mutable latest-version pointers. The chart frame is opaque-origin, script-only sandboxed, and network-restricted. Static previews and offline HTML remain portable. Mermaid supplies simple diagrams.

The visual direction uses neutral Obsidian-style charcoal surfaces, a comfortable reading measure, serif body text, quiet metadata, generous spacing, and a restrained purple accent. The reading pane, charts, and new exported previews always use dark mode, independent of the host or system theme. Styling is scoped to Discover and supports narrow panes. It exposes no second chat composer.

Web tools retrieve public pages, preserve source snapshots, and report access limits. Full browser automation, embeddings, OCR, automatic broad wiki maintenance, and arbitrary interactive code generation are explicitly outside the lightweight first release.

PDFium and pngjs are the only added runtime dependencies. A worker loads the local WebAssembly parser on demand and is terminated after the operation, error, cancellation or timeout. Reads accept imported PDFs up to 50 MiB, at most eight text pages or two page images per call, and documents up to 2000 pages. Each extraction worker has a 20-second deadline and JavaScript heap limits; this is not an operating-system memory sandbox for WebAssembly. Preview dimensions are bounded to a 1600-pixel longest edge. Source identities derive from original bytes; cached text/previews are stored under `Sources/pdf-<hash>/` and damaged derived caches are rebuilt. Original attachment hashes remain authoritative. Scans require visual inspection by the existing vision model; there is no OCR service.

Formatting uses a small request/reply protocol entirely inside `_Research/presentation/`. The companion processes fresh requests through Obsidian's Markdown renderer, scoped Discover CSS and the actual isolated chart renderer. It tests 360px and 760px pane widths. Chart frames return token-bound layout reports; diagram labels and table/content bounds are measured in the host. The tool rejects malformed tables, wide matrices and excessive Mermaid blocks before rendering. An unavailable renderer returns `unverified`. Known formatting failures block chart/note publication; Ask drafts use the tool through explicit agent instructions; Deep final publication additionally enforces the check in code. History is never rewritten to hide a failed attempt.

The compare, critique and figure recipes are original focused instructions informed by [Feynman's workflows](https://github.com/advaitpaliwal/feynman). They adapt the research method to this vault and tool set without importing Feynman's runtime or installing its global extensions.

Search-result lists remain in tool history; fetched pages receive one readable source note plus provenance metadata. Existing vault files are never removed by the simplification. Earlier fork sessions, versioned chart references, and checkpoint notes remain readable. The [feature audit](feature-audit.md) records the full decisions.
