# Validation — Discover 0.6.3

All 94 Node tests passed with no skips on Windows using Node 22 and Pi 0.85.1. Syntax, reproducible companion-bundle and package dry-run checks passed. No runtime dependency or model call was added; esbuild is used only to build the committed companion bundle during development.

Obsidian 1.13.7's installed loader evaluates `main.js` with a host-scoped `require`. The old companion used sibling-module imports, which failed under that loading contract. Tests now evaluate the actual shipping bundle with only the `obsidian` host API exposed, exercise plugin registration and chart rendering, and verify that a fresh vault needs only `main.js`, `styles.css` and `manifest.json`. The bundle is approximately 52 KiB.

Linking a vault installs the companion before saving the pointer. Opening a closed Discover checks and repairs the companion; unchanged files retain their timestamps. Tests cover repair of corrupted code, preservation of existing preferences and vault identity, failed setup without changing the pointer, and setup without agents, input ownership or writer locks. The real Pi loader also exercises automatic installation in a temporary vault. Obsidian's enabled-plugin list is unchanged.

The browser harness passed with the bundled plugin loaded using the same external-import restriction. It checked tables, interactive chart frames, Mermaid diagrams and presentation checks at 360px and 760px, including rejected invalid diagrams and low-contrast text. Both screenshots were inspected. These are loader-contract and browser tests, not a successful enable inside a live Obsidian window; the local Obsidian CLI was disabled, so live host verification remains a separate check after enabling the repaired companion.

## Earlier validation — 0.6.2

Command discovery and help passed all 27 extension lifecycle and real-SDK runtime tests with no skips, plus syntax checks. The native Pi autocomplete provider was exercised with `/discover `, partial commands and `help` topics, including inserting a trailing space for file arguments. Tests verify that descriptions are present, typed paths/titles/IDs are preserved, every suggested command appears in the help guide, and help does not load services, inspect a vault or interfere with an active turn. No dependency, model request or new agent is added for the command menu.

The guide is plain text rendered by Pi's existing notification UI; autocomplete uses the same public API as Scholar. Opening behavior, vault linking and saved data formats remain unchanged. The Obsidian companion has no rendering changes in this release.

## Earlier validation — 0.6.1

The command-menu cleanup passed all 25 extension lifecycle and real-SDK runtime tests, with no skipped tests, plus syntax and package dry-run checks. Discover registers only `/discover`; the obsolete `/pi-research` command alias is removed. The runtime, tools, companion rendering and saved data formats are unchanged from 0.6.0.

Pi's Git-source label was traced to its own command autocomplete formatter. It is normal provenance metadata, not a second extension or an activation error. Package display names do not override it in Pi 0.85.1. A local entry point can show a plain user-source label while forwarding to a Git-managed package; in that configuration, the package's direct extension loading must be filtered out to avoid duplicate registration. This is an optional local configuration, not a change to Pi itself or automatic behavior of Discover's installer.

## Earlier validation — 0.6.0

All 89 Node tests passed with no skipped tests on Windows using Node 22 and Pi 0.85.1. Syntax checks and the package dry run passed. No runtime dependencies were added; the Obsidian rendering code is unchanged.

New real-SDK tests use a scripted local provider to verify that:

- A reviewer responding to “Continue” receives an earlier user correction even when it is absent from the live compacted context, and can retrieve the original prior source result.
- A resumed lead can recover original text omitted by compaction without regenerating a summary. Recall in a fork includes its copied ancestry and excludes later parent messages.
- An overfilled reviewer stops before another provider request, records an incomplete report and lets the lead explain the limitation.
- Research-focused compaction retains custom host authentication and endpoints, small-window reserve/retention settings follow model changes, and a failed research summarization operation falls back to native compaction without rewriting history.
- New image submissions retain a usable vault reference in model context without adding path clutter to the readable user message.

Unit and vault integration checks cover exact excerpt paging, total character budgets, provenance, exclusion of unpublished drafts and review feedback, current-question priority in crowded packets, and retrieval beyond the first portion of long saved sources. Existing automatic threshold/overflow compaction, tool pairing, cancellation, provider/OAuth access, publication, image/PDF handling and dormant-extension lifecycle checks still pass.

These checks establish context delivery, retrieval, bounds and persistence. They do not measure live-model factual accuracy or prove that a model will preserve every detail in a summary. Recall uses keyword matching; token estimates and context allocations are heuristics. Missing evidence and incomplete reviews remain explicit. No new live Obsidian or clipboard test was run for this context update.

Update with `pi update git:github.com/BasamAhmed640/pi-discover`, then reload Pi. This release needs no new Obsidian companion code or vault migration.

## Earlier validation — 0.5.2

All 81 Node tests passed with no skipped tests on Windows using Node 22 and Pi 0.85.1. Syntax checks and the package dry run passed. No runtime dependencies were added; the Obsidian rendering code is unchanged.

Eight extension lifecycle tests cover inactive input and session events, setup without activation, explicit conversation commands, cancelled and failed opening, failed conversation switches, shutdown during opening, host session changes, and late callbacks after exit. Inactive-event checks use a host-context sentinel that throws on any access, and verify that neither the SDK nor the lazy services are requested. A real Pi extension-loader test also installs the companion into a temporary vault without acquiring a writer or intercepting input, opens Deep with zero model calls, and verifies lock release and ordinary image-input passthrough on shutdown. A real controller test injects a draft-write failure and verifies that its session and writer lock are still released.

These are local lifecycle and SDK checks with a scripted provider, not a live terminal/clipboard or Obsidian UI test. Native pasted-file importing and Office document reading remain separate work; the README now states the current image-path limitation accurately.

## Earlier validation — 0.5.1

All 72 Node tests passed with no skipped tests on Windows using Node 22 and Pi 0.85.1. Syntax checks and the package dry run passed. No runtime dependencies were added.

The provider compatibility update adds real-SDK tests with two scripted provider/auth scenarios: switching to a host-registered custom provider with the same model ID, and using an OAuth login that remains in the host runtime. Both lead and reviewer receive the selected provider, current authentication, headers and endpoint. Tests also cover fresh credentials between requests, reasoning-capability adjustment, model output limits, image rejection without fallback, removed providers and exclusion of credentials from saved history. These are local orchestration tests, not live tests of every commercial provider.

## Earlier validation — 0.5.0

All 70 Node tests passed with no skipped tests on Windows using Node 22 and the installed Pi 0.85.1 SDK. JavaScript syntax checks and the package dry run also passed. The release adds no runtime dependencies.

The new review coverage uses the real SDK with a scripted local provider. It verifies:

- Ask and short Deep responses skip review; substantial Deep responses use one temporary reviewer with the lead's exact model, provider and thinking setting.
- The reviewer receives bounded original-source material and actual image attachments. It can retrieve evidence but cannot execute a knowledge-writing tool, even when the scripted model requests it.
- Only the chosen final response enters the readable transcript. Raw drafts, review reports and worker sessions remain in the vault. Reopening and forking preserve review links without extra model requests or exposing drafts.
- Empty, malformed, timed-out and budget-exhausted reports cannot receive a successful review label. Cancellation prevents publication. An exhausted correction pass leaves its drafts unpublished and restores normal requests for the next question.
- A failed final-answer save is recovered from native publication history without rerunning the review. Known final formatting failures prevent publication. Exact current-turn formatting checks are reused; changed Markdown and later turns are checked again.

The browser harness loads the actual companion code, dark CSS, chart renderer and Mermaid. It passed at 360px and 760px, including phase-only progress, safely rendered interruption text, completion hiding, review-note links and the existing invalid-layout/contrast cases. The refreshed screenshots were visually inspected for table wrapping, chart labels, diagram readability and the quiet review footer.

These tests establish orchestration, permissions, persistence and rendering behavior. They do not measure live-model answer quality, reviewer accuracy or a token-cost multiplier, and they do not run inside an actual Obsidian installation. Source checks remain limited model judgments. A live renderer that is unavailable stays unverified, never passed. The lead receives that limitation; final Deep answers with known layout failures remain unpublished. Ask keeps its existing streaming behavior.

To update, run `pi update git:github.com/BasamAhmed640/pi-discover`, reload Pi, run `/discover install-plugin` in the linked vault, and disable/re-enable the Obsidian companion. Existing installations using the old repository address can update their existing package entry through GitHub's redirect.

## Earlier validation — 0.4.0

The Discover rename passed all 57 Node tests, including the real Pi 0.85.1 SDK tests with a scripted provider. Both `/discover` and the original `/pi-research` alias share the same handler. An upgrade test verifies that the companion displays Discover while retaining its original plugin ID, enabled-plugin list, workspace state, reading preferences and vault identity. Existing history, compaction and chart-embed compatibility remain covered.

The actual companion renderer also passed the browser formatting checks at 360px and 760px. Refreshed screenshots show Discover in the dark reading pane with a chart, table and Mermaid diagram; deliberate invalid-layout and low-contrast cases remain rejected. This uses the documented browser harness, not an actual Obsidian installation.

Automatic context management is covered by real Pi 0.85.1 SDK integration tests using a scripted local provider. These exercise threshold compaction with default reserve/retention settings, continuation within a tool-driven turn, overflow compaction and retry, append-only preservation of original history, and reopening with the saved summary without an extra summary request. The summary stays out of the Obsidian conversation, retained tool calls/results remain paired, and overflow recovery does not duplicate the user's question. These tests validate orchestration and persistence, not a live model's summary quality. Automatic compaction was already enabled in 0.3.1; this verification adds no runtime dependency or new user control.

This verification passed all 56 Node tests, including 15 real-SDK runtime tests, with no skipped tests. JavaScript syntax checks also passed.

The 0.3.1 writing update passed all 12 real-SDK runtime tests using a scripted provider. Updated assertions verify that the shared response guide reaches both Ask and Deep exactly once and survives a tool round trip, with no additional writer/reviewer model request. These checks validate integration, not real-model prose quality. The [response guide](response-engine.md) includes manual evaluation cases and the limits of the learning-science evidence.

The following broader validation was completed for 0.3.0; the PDF, persistence and rendering implementations are unchanged in 0.3.1.

Tested on Windows with Node 22 and the installed Pi 0.85.1 SDK. This is still an early release, with bounded document processing and explicit layout-check limitations.

## Automated checks

- 53 Node tests cover persistence, the real Pi SDK, tools, PDF extraction/rendering, formatting transport, and chart rendering. The SDK tests use a scripted local provider rather than paid model calls.
- The real Pi extension loader imports the package. Ask/Deep use the same model and ten tools, changing no model calls merely by switching effort. Fork/resume, history isolation, recovery, and preservation of user edits remain covered.
- Real generated two-page PDF fixtures verify text extraction, original-page citations, colored vector rendering into PNG, blank-text detection, bounded excerpts, cache reuse and repair, and byte-for-byte preservation of the original.
- PDF tests exercise malformed files, excessive page ranges, oversized originals, unavailable vision, changed original hashes, cancellation, and forced worker timeouts. Public PDF retrieval retains provenance usable by saved charts.
- Formatting tests reject malformed/wide tables and unclosed fences; unrelated code examples remain untouched. A missing renderer is unverified. Reply digests must match the requested draft, and request/result files are cleaned on completion or cancellation.
- Existing source tests cover SSRF protection, redirects, bounded transfers, search fallbacks and source attribution. Chart and knowledge persistence retain revision and interruption checks.

## Browser and visual checks

`tests/browser/formatting.cjs` loads the actual companion JavaScript/CSS and chart renderer in headless Edge, with a local Mermaid 11.4.1 bundle. Only Obsidian host APIs and the outer Markdown conversion are mocked. No personal vault is linked or changed by this harness.

- A combined answer containing a chart, comparison table and real Mermaid flowchart passes at 360px and 760px pane widths.
- A wide diagram whose labels shrink to about 4px is rejected with actionable formatting feedback.
- Invalid Mermaid syntax returns a rendering error; deliberately low-contrast table text is rejected.
- Rendered screenshots are inspected for typography, table readability, chart labels and diagram appearance. This caught and fixed a table text-color inheritance issue; chart checking also waits for iframe layout before reporting.
- The existing chart browser harness checks toggles, hover details, all data, lack of persistence messages, dark mode across host/system themes and offline operation.

To repeat the browser check, provide local `playwright` and `marked` packages through `NODE_PATH`, set `MERMAID_BUNDLE` to a local `mermaid/dist/mermaid.min.js`, and run `node tests/browser/formatting.cjs`. Set `QA_BROWSER` if the Playwright browser channel differs. These packages are development tooling, not runtime dependencies.

## Practical limits

This is not a test inside the user's actual Obsidian installation. The final host check is to update/re-enable the companion in the selected vault, attach a PDF in Pi, ask for a page-cited comparison with a visual, and confirm the tool reports an Obsidian-rendered pass.

Layout checks cannot prove factual correctness or aesthetic excellence. Final-answer checks are agent instructions; chart and knowledge-note saves enforce known formatting failures in code. If the renderer is unavailable, structurally valid content can still be saved and is explicitly reported as visually unverified. PDF extraction does not perform automatic OCR; image-based inspection requires a vision model. No subagents, wiki backend or authenticated browser automation were added.
