# Scholar: cheap fast review, universal engines, beautiful notes, clean loads

Slug: `scholar-speed-engines`

Repo: `C:/Users/basam/.pi/agent/extensions/scholar` (local clone = `origin/main` = `c1a07e8` v0.7.1, clean). All paths below are relative to it.

## Context

Three requests, in the order the user ranked them:

1. **Speed and review cost.** Preparing a Learn section takes 20-30 minutes and spends tokens on every reviewer request. On the user's real interrupted *Griffiths E&M 1.2* run (12 pages, 20 `###` topics, 5 crops) the crew planned ~38-45 packets, `runReviewPass` executes them through `Math.min(REVIEW_CONCURRENCY, packets.length)` workers with `REVIEW_CONCURRENCY = 6` (`review-layer.ts:76,513`), and 26 checks finished in 8.6 minutes before the user cancelled. Three cost drivers are visible in the code: reviewers inherit the session's thinking level (`review-layer.ts:322`) while Pi reserves 16,384 output tokens for reasoning on every request (`review-runtime.ts:274`); every visual packet carries up to six full rendered pages (`VISUAL_PACKET_IMAGES = 6`, `learn-review.ts:63`); and question review runs a 2-3 request tool loop per question instead of one request. The author side also spends one model turn per page view and per crop, because the Learn contract never tells the author to issue independent source calls together even though pi 0.85.1 runs sibling tool calls from one assistant message concurrently.
2. **Universal engines.** Learn, Exam, and Tutor must share one definition each of the teach, question, presentation, and review engines; only mode specifics (surface, records, scope) may differ. Today: `examInstructions` composes only `QUESTION_ENGINE_POLICY` (`policies.ts:115-138`); `MODE_CAPABILITIES.exam` declares `teaches: false, assesses: false` (`modes.ts:46-47`); the review gate is hash-bound for Learn (`lesson.ts learnReviewIssues:266`) but ad-hoc and hash-free for Tutor/Exam (`tool-controller.ts` ~696-702, ~861-867); Exam re-declares the question engine's fairness rules (`exam.ts:22-26` and its catch-all regex vs `quiz-contract.ts:52-61`).
3. **Presentation.** The rendered Obsidian notes must look beautiful, not merely correct: section and tutor notes, the exam paper and answer key, and the home/book/chapter hubs.
4. **Load artifacts.** Opening a section shows leftovers from earlier program versions: review receipts bound to old engine keys, sources or models that can never be reused, and vault files written by the removed presentation-preview feature (`Scholar Presentation Preview.md`, `Preview assets/`, `.obsidian/snippets/scholar-presentation-preview.css` — grep finds no writer for any of them).

**Review stays, and is deliberately shallower.** 0.7.0 removed the reviewers and 0.7.1 restored them (`git log`: `5d959e2`, `c1a07e8`); the user accepts weaker review quality in exchange for far fewer tokens and much lower latency, so this plan spends review depth on purpose: reviewers run at a fixed low thinking level, the visual check judges saved crops instead of full pages, and question review inspects only the question's declared pages. Intended end state for the 1.2 shape: ~11 reviewer requests, zero full-page images, one model request per question, and an author that batches independent page reads/views/crops. Every step below is independently shippable and leaves `npm test` green.

## Approach

### Phase 1 — Review gets cheap, preparation gets fast

**Step 1 — Make the review crew cheap (`learn-review.ts`, `review-layer.ts`, `review-runtime.ts`)**

Add `const TEACHING_TOPICS_PER_PACKET = 4;` beside the constants at lines 62-63. `SOURCE_WINDOW_PAGES` stays 4 (4-page fidelity windows are a review property, not a bottleneck); `visualPacketImages` keeps its small-context derivation (line 100).

Replace the per-topic teaching loop (line 124) with consecutive slices of `TEACHING_TOPICS_PER_PACKET`:

- id stays `teaching:${sliceIndex + 1}`;
- instruction: `Crew assignment: topics ${first + 1}-${last + 1} of ${topics.length}, "A", "B", "C", "D". Review only these topics' explanations against their source pages; the outline shows where they sit, and earlier topics may already define terms. The objective check plan and whole-lesson flow are reviewed by a separate coherence check.` (`first = sliceStart`, `last = sliceStart + group.length - 1`, headings joined as `"A", "B"`);
- `reads`: `sorted(group.flatMap(topic => topic.pages))`;
- payload: `{ topics: group.map((topic, offset) => ({ index: sliceStart + offset + 1, heading: topic.heading, markdown: topic.markdown })), checklist: group.flatMap(topic => topic.coverage) }`.

The coherence packet (line 126) stays byte-identical, including id `teaching:coherence` and its payload. For the 1.2 shape this is 5 grouped packets + 1 coherence (was 21).

Convert the visual packer from one packet per topic to a greedy multi-topic packer:

1. `pack`'s first parameter becomes `topics: Topic[]` (was `topic: Topic | undefined`); each queued packet stores `topics`; the queue type becomes `Array<{ pages: number[]; crops: ScholarSnapshot[]; topics: Topic[] }>`. The filler body (lines 133-147) and its crop-travels-with-its-page flush rule stay byte-identical, including the crowded-page repeat.
2. Build units in topic order: for each topic take `topicCrops = crops.filter(crop => topic.cropIds.includes(crop.id))` and `math = topic.markdown.includes("$$")`; skip the topic when both are empty; otherwise one unit `{ topics: [topic], pages: sorted([...topicCrops.map(crop => crop.page), ...(math ? topic.pages : [])]), crops: topicCrops }`.
3. Merge units greedily into groups while `group.pages.length + group.crops.length + unit.pages.length + unit.crops.length <= visualPacketImages`; within a group keep `pages` sorted and append crops in unit order. Then `pack(group.topics, group.pages, group.crops)` per group.
4. The trailing loose packet keeps its current call shape with an empty topic list: `pack([], sorted([...pages.filter(page => !viewed.has(page)), ...loose.map(crop => crop.page)]), loose)`.
5. Packet rendering (lines 155-161): a topic packet's instruction is `Crew assignment: figures and equations for topic(s) "A", "B" (pages 1, 4, 5). Compare the listed crops with each topic's captions, explanations and Key equation callouts. Other crew members review the other topics and pages.` and its payload is `{ topics: packet.topics.map(({ heading, markdown }) => ({ heading, markdown })), figures: packet.crops }`. The loose packet's instruction becomes `Crew assignment: crops not placed in a lesson topic, from pages 1, 4, 5. Check each crop's completeness and labels against the figure inventory observations. Other crew members review placed figures and equations.` with its existing `{ pages, figureInventory, figures }` payload. Ids stay `visual:${index + 1}`. (Both instruction strings are part of the receipt cache key, so every changed packet re-runs once.)
6. Every visual packet publishes `views: []`: the visual reviewer inspects the saved crops, their captions and the inventory observations, never full rendered pages. This is the deliberate depth trade — a crop that clips its figure is no longer caught against its page — and it removes the single largest token consumer in the pipeline (full pages render at `PDF_RENDER_SCALE = 1800` longest side, `ingest.ts:479-556`, and the context guard charges 8192 tokens per image, `review-runtime.ts:262-277`; the measured 1.2 crew spent ~89k of ~206k input tokens on page images).

Invariants that must hold for any section (assert them in the verifier): every current crop appears in **exactly one** packet's `cropIds`; every packet holds `cropIds.length <= 6`; no packet is empty; every section page is read by exactly one source window; every material topic's heading appears in exactly one teaching packet, and `teaching:coherence` exists exactly once. (A crowded page may still repeat across packets: the filler flush rule is unchanged.)

**Step 1b — Reviewer economy: fixed low thinking and small caps (`review-layer.ts`, `review-runtime.ts`)**

Reviewers stop inheriting the learner's reasoning level. Add `const REVIEWER_THINKING_LEVEL = "low" as const;` beside `REVIEW_CONCURRENCY` (`review-layer.ts:76`) and pass it at line 322 (`thinkingLevel: REVIEWER_THINKING_LEVEL`, was `ctx.thinkingLevel`). Pi reserves 16,384 output tokens on every request while thinking is on (`review-runtime.ts:274`) and the provider bills every reasoning token, so this is the cheapest large win. Consequence to state in the code comment: reviewer verdicts are shallower than the author's reasoning; the user accepted that trade for latency and cost. `README.md`'s claim that reviewers use "the current Pi model and its supported thinking level" must be reworded in the docs step.

Bound the rest of each request:

- `review-layer.ts` `maxOutputTokens`: `Math.min(4_000, Math.max(1_024, model.maxTokens ? Math.min(model.maxTokens, 4_000) : Math.floor((model.contextWindow || 32_000) / 8)))`.
- `review-layer.ts` `maxImages`: `Math.max(4, Math.min(8, requiredViews.length + crops.length))`.
- `review-layer.ts` `maxToolCalls`: `Math.max(8, Math.min(16, allPages.length + crops.length + 4))`.
- `DEFAULT_REVIEWER_LIMITS` (`review-runtime.ts:53-65`): `maxTurns: 16` → `2`, `maxToolCalls: 48` → `8`, `maxImages: 24` → `8`, `maxToolTextChars: 120_000` → `40_000`, `maxOutputTokens: 12_000` → `4_000`, `maxTotalOutputTokens: 96_000` → `8_000`. Every production path now sets `prepared`, so a 24-turn tool loop must not survive as a default.
- `aggregateReviews` (`review-layer.ts:113`): `findings.slice(0, 40)` → `slice(0, 12)`.
- `REVIEW_INSTRUCTIONS` (`review-layer.ts:79`): append to each of the four role texts: `Report at most six blocking findings, the most consequential first; a short list of real defects is worth more than an exhaustive one.`

**Step 2 — Question review runs prepared and text only (`review-layer.ts`)**

`reviewTargetQuestion` (lines 582-616) builds `reviewOpts` (591-596) and calls `reviewOne(reviewOpts, "assessment", { value, sourcePages })`; add `prepared: true` to that object. Keep the retry-once call (599) and both error strings (602, and the failure path) unchanged. Add one comment line beside it: `// Prepared: the reviewer inspects exactly this question's declared sourcePages (and their crops); it cannot pull adjacent pages.`

`reviewOne`'s prepared path already fills `read`/`viewed`/`cropped` from `requiredReads`/`requiredViews`/crops (`review-layer.ts:338-360`), so the "Reviewer did not read page N" guard still enforces completeness, and `assertQuestionGrounding` already requires those pages to be in scope. Result: one model request per question review instead of a 2-3 request tool loop (`maxTurns` becomes 2 via `options.prepared`, line 355).

Two further trims, both in `reviewOne`, apply when `options.prepared` and a `question` is present:

- **Images only for a figure question.** Include crop images only when the serialized `proposedQuestion` names a figure (`/Figure|Fig\.|!\[\[/`); otherwise the reviewer receives the declared pages' text and no images. Crop tokens are charged like page images (`review-runtime.ts:262-277`).
- **Trim the payload to the question.** The fallback payload (`review-layer.ts:301-315`) embeds `section.transcript.filter(entry => entry.lesson).map(entry => ({ id, markdown }))` — the whole lesson — in every question review. Under `prepared`, replace that list with only the entries whose `lesson.sourcePages` intersect `question.sourcePages`; when the intersection is empty, keep every entry whose `lesson.sourcePages` is empty and otherwise fall back to the full list (a question that cites no page must still see what was taught).

**Step 3 — Raise reviewer concurrency (`review-layer.ts:76`)**

`export const REVIEW_CONCURRENCY = 6;` → `12`. `runReviewPass` is a single work queue across all roles (line 513), so this is the only knob; per-packet retry-once and the resumable checkpoint path are unchanged. With ~11 packets this becomes a single wave.

**Step 4 — The author batches independent source calls (`policies.ts`)**

In `learnInstructions`, append to the bullet that starts `- During initial source preparation, before the first practice or mastery question, read and view every active-section page.` (line ~103) this sentence:

`Issue independent source calls together in one message — up to four \`read\`/\`view\` calls for different pages at a time; the harness runs them concurrently and each still records its own durable receipt. Then issue the crops for the pages you just viewed together (up to four per message), then account for every page's visuals in one \`notes.figureReviews\` call. On reopening an unfinished section, prepare only the pages without a saved read/view receipt.`

Bullet order (views → crops → inventory) is unchanged: a `snapshot` needs the canvas dimensions its `view` returned, so only truly independent calls may be batched. Add the same first sentence to the Tutor contract's explanation bullet. No code change: `scholar` declares no `executionMode: "sequential"` (the only one in the repo is `tool-controller.ts:538` for the notes tool), and `book-service.ts` queues mutations per (vault, bookId) and reloads state per queued mutation, so concurrent `view`/`snapshot` calls cannot lose receipts.

### Phase 2 — One definition per engine, used by all three modes

**Step 5 — Every mode composes every engine (`policies.ts`)**

`learnInstructions` (71), `examInstructions` (115), and `tutorInstructions` (141) each compose, in this order and exactly once: `SOURCE_AND_PRIVACY`, `TEACHING_ENGINE_POLICY`, `EXPLANATION_POLICY`, `PRESENTATION_POLICY`, `QUESTION_ENGINE_POLICY`, `QUESTION_GROUNDING_POLICY`. `SHORT_QUESTION_POLICY` is the one mode-scoped engine block: include it in Learn and Tutor only (its rule is the interactive answer surface, not the question engine).

Move mode-scoped sentences out of the engine blocks into the mode contracts:

- `SOURCE_AND_PRIVACY` line 16: replace `In Exam or Tutor only, an external image may be a presentation aid …` with `An external image may be a presentation aid when a visual materially improves the task and the PDF has no suitable reusable figure.` The Exam and Tutor contracts already say which modes may search the web; Learn's contract gains `Never use web images: the selected PDF is the only visual source.` (matches the enforced behavior at `tool-controller.ts:466`).
- `SHORT_QUESTION_POLICY` line 30 header becomes `Short questions (interactive delivery surfaces):`. Learn's question bullet gains `The learner answers in Pi: a choice, a number, or one short sentence.`; Tutor's diagnostic bullet gains the same clause.
- `QUESTION_GROUNDING_POLICY` lines 38 and 41: `Before every Learn or Tutor question, declare grounding with:` → `Before every question, declare grounding with:`; `Keep Learn and Tutor questions short.` → `Keep interactive questions short, and keep the same declarations on the frozen exam item: rubric criteria, the correct response, and the misconception each distractor encodes.`

**Step 6 — Declare engine participation, rename surface capabilities (`modes.ts`)**

Add, next to `MODE_CAPABILITIES`:

```ts
/** The four engines are universal: every mode uses every engine. Only the delivery surface differs. */
export type ModeEngines = { teaching: boolean; question: boolean; presentation: boolean; review: boolean };
export const MODE_ENGINES: Readonly<Record<ScholarMode, Readonly<ModeEngines>>> = Object.freeze({
  learn: Object.freeze({ teaching: true, question: true, presentation: true, review: true }),
  exam: Object.freeze({ teaching: true, question: true, presentation: true, review: true }),
  tutor: Object.freeze({ teaching: true, question: true, presentation: true, review: true }),
});
```

Rename the surface capabilities and update every callsite: `teaches` → `interactiveTeaching`, `assesses` → `interactiveQuestions`. Callsites: `modes.ts:20,22,37,38,46,47,56,57`; `index.ts:301,408,434`; `runtime-coordinator.ts:306,487,489`; `tool-controller.ts:236`; `tests/verify-scholar-modes.mjs:38,49`. Rewrite the two comments (modes.ts:36, 45) so they read as surface facts, not engine exclusions: `// Learn teaches interactively and owns section progress; it is barred from the internet: the book is its only visual source.` and `// Exam delivers through a frozen paper in Obsidian: no interactive teaching or questions in Pi; its teaching artifact is the graded answer key.`

**Step 7 — One review gate for every mode (`tool-controller.ts`, `learn-quality.ts`)**

Learn already gates on `reviewGateIssues(receipts, { contentHash, sourceHash, roles })` (`learn-quality.ts:310`, used at `lesson.ts:266`). Replace the two hash-free ad-hoc checks with the same call, using the fingerprints those passes already stamp on their receipts:

- Tutor (`tool-controller.ts` ~696-702): `roles: ["teaching"]`, `contentHash: lessonHash(params.lesson!.markdown)`, `sourceHash: book.source.fingerprint.sha256`.
- Exam (`tool-controller.ts` ~861-867): `roles: ["assessment", "teaching"]`, `contentHash: examFormFingerprint({ ...current, questions })`, `sourceHash: book.source.fingerprint.sha256`.

Keep the existing `unresponded` blocking-finding message and the `markPassCompleted`/`findingResponses` flow unchanged; only the approval gate changes. Consequence to accept and state in a comment: a Tutor explanation edited after approval, or an Exam form re-frozen after approval, now re-runs one review pass instead of silently reusing a stale receipt.

**Step 8 — One source for the question engine's rules (`quiz-contract.ts`, `exam.ts`)**

Export from `quiz-contract.ts`: `CATCH_ALL_OPTION` (move the literal from `exam.ts:26`), `MIN_MCQ_OPTIONS = 3`, `MIN_RUBRIC_CRITERIA = 2`, `MIXED_FORM_THRESHOLD = 4`, `MAX_RECOGNITION_SHARE = 0.7` (move from `exam.ts:22-25`), and

```ts
export type QuestionOptionIssue = "catch-all" | "missing-misconception" | "duplicate-misconception";
export function optionIssues(options: ScholarQuizOption[], correctValues: string[]): QuestionOptionIssue[];
```

`assertScholarQuizDistractors` (quiz-contract.ts:52-61) throws its current messages by mapping those codes; `exam.ts` `validateExamQuestions` (125) consumes the same codes and keeps its current message text. Delete the local copies in `exam.ts`. The exam answer key's "grade so the answer key teaches" prose and the Learn/Tutor grounding receipts are two surfaces of the one question engine, which is what Step 5's shared policy blocks now state.

**Step 9 — Delete the Learn review facade (`learn-review.ts`, `tool-controller.ts`)**

`learn-review.ts` stops re-exporting the review engine (lines 19-51) and the imported symbols it only forwards, and drops the unused `const instructions = REVIEW_INSTRUCTIONS` (line 64). `tool-controller.ts:3` imports `REVIEW_CHECKPOINT_MESSAGE`, `runReviewPass`, `planExamReviewPackets`, `planTutorExplanationPacket`, `reviewTargetQuestion`, and their types directly from `review-layer.ts`. Keep in `learn-review.ts` only what is Learn-specific: `planReviewAssignments`, `currentReviewSnapshots`, `reviewCheckpoint`, `reviewLearnDraft`, `reviewLearnQuestion`, `reviewLearnDraft`'s role-reuse logic. Delete the duplicated `currentReviewSnapshots`/`uniqueBatches` in `learn-review.ts` and import the `review-layer.ts` copies.

**Step 10 — Docs state the architecture**

- `docs/architecture.md`: replace the "There is deliberately one definition of each engine" table with four rows — Teaching / Question / Presentation / Review — all `Yes` for Learn, Exam, Tutor, plus one sentence: `A mode supplies only its surface: which record it writes, where the learner answers, and which scope it freezes. Engine definitions, gates and receipts are shared code.`
- `AGENTS.md`: add the invariant `**Engines are universal.** Teach, question, presentation, and review are defined once (policies.ts, review-layer.ts, render/, quiz-contract.ts) and every mode uses all four; a mode may add only its own surface rules.`; regroup the Layout table rows by engine (Entry/commands, Teach, Question, Presentation, Review, Contract/state, Obsidian, Source PDFs, Tool actions).
- `README.md`: state the same in the "Your learning workspace" prose; no test or version edits.

### Phase 3 — Load-time leftovers

**Step 11 — Prune superseded review receipts (`tool-controller.ts`, `learn-quality.ts`)**

Add one helper to `learn-quality.ts` (beside `reviewGateIssues`, line 310) and call it in every place that writes a target's review store — the checkpoint write (`tool-controller.ts:195-213`) and the Learn/Tutor/Exam approval writes (~763-819, ~694-762, ~859-898):

`function pruneReviewReceipts(receipts: ReviewReceipt[], current: { sourceHash: string; model: string }): ReviewReceipt[]`

Rules, in order: (1) drop receipts whose `sourceHash` or `model` differs from `current`; (2) keep the newest completed receipt per `(role, contentHash)`; (3) drop checkpoint receipts (`failure?.code === "cancelled"` and `failure.message === REVIEW_CHECKPOINT_MESSAGE`) whose `(role, contentHash)` already has a completed receipt; (4) never drop a receipt the current gate consumes (the surviving newest per `(role, contentHash)`). `learnQuality.reviews`, `tutor.review.receipts`, and `exam.review.receipts` all use this one function.

**Step 12 — Remove the removed-feature artifacts from the vault**

The three paths below are generated by the deleted presentation-preview feature (grep: no writer, no reader in the repo). Move, do not delete: `C:\Users\basam\Desktop\Basam's_Vault\Scholar Presentation Preview.md`, `…\Preview assets\`, and `…\.obsidian\snippets\scholar-presentation-preview.css` → `%TEMP%\scholar-artifact-backup-<YYYYMMDD>\`, creating the directory if needed and preserving relative paths. Leave every other vault file untouched, including `Scholar\Books\…\Legacy notes\` (that directory is the migration's intentional preservation of pre-migration content, written by `note-storage.ts:213`) and the nested `Scholar\.obsidian\` (Obsidian's own config directory).

### Phase 4 — Beautiful notes (independent of Phases 2-3; may ship first)

**Step 13 — A Scholar callout family and note headers (`render/`, `equation-presentation.ts`)**

Obsidian gives every callout a `data-callout` attribute, which is the only styling hook that survives its editor; the current notes use generic `[!note]`, `[!example]`, `[!info]` types, so the CSS cannot distinguish a key equation from an ordinary note. Introduce three Scholar-owned types and move the loose status text into one of them:

- `[!scholar-equation]` — `equation-presentation.ts renderEquation`: `callout("note", "Key equation · …")` → `callout("scholar-equation", "Key equation · …")`. Marker placement, validation and the `[[scholar-equation:ID]]` contract are unchanged.
- `[!scholar-figure]` — `render/section.ts sourceFigureLines` (93), `referencedFigureLines` (141), `supplementalSourceFigureLines` (130) and the exam paper's figure block in `render/assessment.ts`: `callout("example", "Figure · PDF page N")` → `callout("scholar-figure", …)`.
- `[!scholar-status]` — one header callout replacing the loose leading lines in `renderSection` (`render/section.ts:239-241`: the italic `*in progress · Current section · pp. 32–43*` line, the `**Progress:** …` paragraph and the `**Section complete.** …` line), `renderTutorSession` and `renderExam` (`render/assessment.ts`), and `renderScholarHome`, `renderBook`, `renderChapter` (`render/navigation.ts`), where the existing `> [!info|success|warning] …` + `> x/y sections complete` pair becomes `> [!scholar-status] …` with the same text. Body stays one short line: status · pages (or sections) · progress. Reuse the existing `statusLabel`, `statusGlyph` and `progress` helpers in `render/common.ts` rather than adding new ones — `statusGlyph` and `progress` are currently computed and discarded.
- Home, book and chapter notes additionally emit a progress bar inside the status callout: `<div class="scholar-progress" style="--scholar-progress: 42%"><span></span></div>` with the percent from `progress(completed, total).percent`. Obsidian renders inline HTML in notes; no other generated markup uses HTML today, so this stays the only HTML the renderers emit.
- Answer-key feedback: emit `<span class="scholar-score">2/3</span>` around the numeric score in `gradedQuestionLines` (`render/assessment.ts:147`) so the CSS can chip it; the rest of the line is unchanged.
- Leave `[!question]`, `[!info]-`, `[!success]`, `[!warning]`, `[!note]-` and the `alvar-learning` cssclass alone — the first set is already styled and the last is the user's theme class.

**Step 14 — Key equation bodies become scannable (`equation-presentation.ts`)**

`renderEquation` currently flattens the symbol table into one paragraph: `**Symbols:** $dx$ → …; $df$ → …`. Replace that paragraph with a definition list and keep the other labels:

```
**Symbols**
- $dx$ — infinitesimal change in the argument $x$
- $df$ — resulting change in $f$
```

then `**Assumptions:** …`, `**Meaning:** …` and the existing `*Source: PDF page N.*` line, each as its own paragraph, exactly as today. `content()`/`math()` validation, the forbidden-markdown checks and `wrapEquationGroup` behaviour are untouched.

**Step 15 — `scholar.css` visual pass (`scholar.css`, 176 → ~300 lines)**

- Callout family: `.scholar-note .callout[data-callout="scholar-equation"]` (`--callout-icon: sigma`, accent left border, centred `.math-block`, muted `Symbols`/`Assumptions`/`Meaning` labels, muted last paragraph), `…[data-callout="scholar-figure"]` (framed image: 1px border, 0.6rem radius, `background-secondary`, centred `img`, caption paragraph, muted source line), `…[data-callout="scholar-status"]` (no icon padding waste, muted metadata, compact margins).
- `.scholar-progress`: height 0.4rem, `border-radius: 999px`, `background: var(--background-modifier-border)`, inner `span` width `var(--scholar-progress)`, `background: var(--interactive-accent)`, plus a `transition: width 200ms ease` disabled under `@media (prefers-reduced-motion: reduce)`.
- `.scholar-score`: tabular numerals, padding `0.1em 0.45em`, `border-radius: 0.4em`, accent tint via `color-mix`.
- Per-artifact rules for the classes the renderers already emit but nothing styles: `.scholar-home`, `.scholar-exam`, `.scholar-answer-key` (they inherit `.scholar-note`; give each its own line width and table/score treatment, matching the existing `.scholar-book`, `.scholar-chapter`, `.scholar-section`, `.scholar-tutor`, `.scholar-exam-paper` blocks).
- Rhythm: one spacing scale (custom properties `--scholar-space-1: 0.4rem` … `--scholar-space-4: 1.6rem`) used by callout margins, heading steps and lesson-unit separators; keep the existing `--file-line-width` and `--line-height-normal` values.
- Every colour resolves through `var(…)` or `color-mix(in srgb, …)` — no literal hex — so light and dark themes both work; keep the existing `@media print` block and add `break-inside: avoid` for `[data-callout="scholar-figure"]`.

**Step 16 — Appearance install still refreshes (`appearance.ts`, verification only)**

`installScholarAppearance` hashes `scholar.css` into `.obsidian/scholar-appearance.json` (`installedCssSha256`) and rewrites `.obsidian/snippets/scholar.css` plus `enabledCssSnippets` when the hash changes, and it refuses to overwrite a snippet the user customized. So no code change is required; verification must confirm the receipt's `installedCssSha256` equals the new `scholar.css` hash and that `appearance.json` still lists `scholar` in `enabledCssSnippets` after the CSS edit.

**Step 17 — See it, don't assume it (evidence)**

Build a throwaway preview: render one synthetic section note, one exam paper and one answer key through the real renderers (jiti, as the verifiers do), convert with the pinned `marked` devDependency, wrap in a small HTML page that loads `scholar.css` plus a minimal Obsidian-callout shim (`blockquote[data-callout]` → the box/icon rules Obsidian applies), open it with the harness browser tool and screenshot light and dark at 900 px and 1440 px. Delete the preview script and HTML afterwards. Report the screenshots and the four checks: equation callout, figure frame, status bar with progress, question/score chips.



## Critical files & anchors

- `learn-review.ts` — crew planner (97-168), constants (62-63), teaching loop (124), coherence (126), pack (133-147), loose packet (154), rendering (155-161), facade re-exports (19-51), unused alias (64).
- `review-layer.ts` — `REVIEW_CONCURRENCY` (76), `reviewOne` prepared path (338-360), worker queue (513), `planExamReviewPackets` (524), `planTutorExplanationPacket` (566), `reviewTargetQuestion` (582-616).
- `policies.ts` — engine blocks (10-69), the three mode builders (71, 115, 141), `modeInstructions` (172).
- `tool-controller.ts` — checkpoint write (195-213), question review (215-228), Tutor pass/gate (694-762), Learn pass (763-819), Exam pass/gate (859-898).
- `tests/verify-scholar-learn-review.mjs` — the only packet-shape verifier (fixture 49-74, prompt scrapers 31-40, shape mapping 94-141, question checks 195-243, crowded crops 297-319, eleven-page check 331-333).
- `equation-presentation.ts` (24-120: `content`/`math` validation, `wrapEquationGroup`, `renderEquation`), `render/section.ts` (93-150: `sourceFigureLines`, `referencedFigureLines`, `supplementalSourceFigureLines`), `render/navigation.ts` (home/book/chapter status lines), `render/assessment.ts` (104-190: paper, graded key, tutor session), `render/common.ts` (148-154: the only `cssclasses` emitter), `scholar.css` (whole file), `appearance.ts` (73-133: snippet install and `installedCssSha256` receipt) — the presentation surface for Phase 4.

## Verification

Run from `C:/Users/basam/.pi/agent/extensions/scholar` (`npm ci --ignore-scripts` first only if `node_modules` is absent; `pdfinfo`, `pdftotext`, `pdftoppm` must be on PATH).

1. `npm test` → `Scholar: 55 verifier(s) passed, 0 failed.` No new verifier files; the count stays 55.
2. Packing (Step 1), in `tests/verify-scholar-learn-review.mjs`: for the existing shape-mapping fixture, update the teaching expectation to `[[2, 5, 7], []]` with coherence at index 1 and recompute the visual expectation from the new planner — every visual packet now reports `views: []`, so the assertion becomes `[[[], cropIds…], …]` and the crop lists must still match the greedy packing; update the bounded-run check to teaching index `[0]` with reads `[[2, 2], [5, 5], [7, 7]]`. Then assert the invariants explicitly (each current crop in exactly one packet; `cropIds.length + pages.length <= 6`; no empty packet; every page in exactly one source window; every material topic exactly once; `teaching:coherence` exactly once) and extend the fixture to the observed 1.2 shape (12 pages, 20 math topics, 5 crops) asserting `plan.length <= 12` with per-role counts `source 3`, `teaching 6`, `visual <= 3`, printing the counts. The pre-change planner produced 38 packets for that shape (3 source, 21 teaching, 14 visual).
2b. Crew cost (Step 1b and Step 2), in the same verifier: assert every prepared request carries `tools: []` and no image content for the `source`, `teaching` and `assessment` roles; assert a `visual` packet's evidence holds only crop images (count == `cropIds.length`, never a page render); assert `maxImages` never exceeds 8 for any request; and assert the assessment payload for a question whose `sourcePages` are `[1]` contains the lesson entry citing page 1 but not an entry citing page 7.
3. Question review (Step 2), in `tests/verify-scholar-open-assessment.mjs`: assert exactly one `modelRegistry.complete` call per question review, `tools.length === 0` and `messages.length === 2`, for both the pass and the changes verdict; in `tests/verify-scholar-learn-review.mjs` rewrite the two question checks to the same shape and drop the now-impossible "reviewer omitted a tool call" cases; in `tests/verify-scholar-ui-contract.mjs` delete the `messages.length === 1` tool-call branch (162-168), which can no longer fire.
4. Concurrency (Step 3): no verifier change (`verify-scholar-simple-learn.mjs` requires `>= 3` requests, all three roles, exactly 3 receipts — still true).
5. Universal engines (Steps 5-8): in `tests/verify-scholar-engine-contract.mjs` invert `Exam excludes the teaching engine` into `every mode includes every engine exactly once` over `TEACHING_ENGINE_POLICY`, `EXPLANATION_POLICY`, `PRESENTATION_POLICY`, `QUESTION_ENGINE_POLICY`, `QUESTION_GROUNDING_POLICY` (extend the single-definition checks to all five/six templates), and keep `SHORT_QUESTION_POLICY` asserted for Learn and Tutor only; in `tests/verify-scholar-modes.mjs` replace the `policies match teaches=…` loop with `MODE_ENGINES[mode]` all-true plus the engine-presence check, and keep the "no compound mode disjunctions outside modes.ts" check green; add to `tests/verify-scholar-review-runtime.mjs` (or the Learn review verifier) one check that a Tutor receipt with a foreign `contentHash` no longer satisfies the gate. `tests/verify-scholar-exam-contract.mjs` must stay green (the code-mapped messages are unchanged).
6. Batching instruction (Step 4): add one assertion to `tests/verify-scholar-explanation-presentation.mjs`, which already matches policy substrings, that the Learn instructions contain `Issue independent source calls together in one message`.
7. Receipt pruning (Step 11): in `tests/verify-scholar-learn-review.mjs` save a checkpoint receipt plus a receipt with a foreign `sourceHash`/`model` and a completed receipt, run one checkpoint write, and assert the section note's `learnQuality.reviews` holds only the current-source receipts with one completed receipt per role.
8. Live end-to-end timing and cost (Step 1, 1b, 2, 3): run `/scholar learn "1.2"` on the Griffiths book in Pi, then read the crew receipts in `Scholar/Books/Griffiths E&M/Sections/1.2 - Differential Calculus.md` section details and compare against the measured baseline (38 packets, ~206k input tokens, 26 checks in 8.6 minutes before the user cancelled):
   - each crew receipt: `toolCalls === 0`, `modelTurns === 1`;
   - crew wall time: max `diagnostics.elapsedMs` ≤ 90_000 for the whole crew, ≤ 12 packets in the loading widget;
   - crew tokens: sum of `diagnostics.inputTokens` ≤ 60_000 and `diagnostics.outputTokens` ≤ 6_000;
   - question reviews: one receipt per question with `toolCalls === 0`;
   - author side: assistant turns between the first `read` and `lessonComplete` ≤ 10 for a 12-page section (observed ~25 before).
   Report every number. If wall time or tokens miss, apply the Assumptions fallbacks in order before recording the result.
9. Step 12: after the move, list the vault root and `.obsidian\snippets\` and confirm the three artifact paths are gone and `%TEMP%\scholar-artifact-backup-<date>\` contains exactly those files; confirm no other vault file changed.
10. Presentation renderers (Steps 13-14), in the verifiers that already assert note text: `tests/verify-scholar-note-design.mjs`, `tests/verify-scholar-equation-presentation.mjs`, `tests/verify-scholar-presentation.mjs`, `tests/verify-scholar-callout-boundaries.mjs`, `tests/verify-scholar-obsidian-exam.mjs` assert (a) a key equation renders as `> [!scholar-equation] Key equation · …` with a `**Symbols**` block whose entries are one `- $symbol$ — definition` per symbol and no inline `**Symbols:** …; …` paragraph, (b) a figure renders as `> [!scholar-figure] Figure · PDF page N`, (c) a section note's first block is `> [!scholar-status] …` with no leading italic status line or `**Progress:** …` paragraph, (d) `<div class="scholar-progress"` appears in home, book and chapter notes and nowhere else, (e) the answer key carries `class="scholar-score"`.
11. Appearance refresh (Step 16): after `ensureScholarAppearance`, `.obsidian/scholar-appearance.json`'s `installedCssSha256` equals the sha256 of the repo's `scholar.css` and `.obsidian/appearance.json` still lists `scholar` in `enabledCssSnippets`. If the receipt does not update, the user's snippet was customized: report that instead of overwriting it.
12. Visual proof (Step 17): the four screenshots (light 900 px, light 1440 px, dark 900 px, dark 1440 px) of the synthetic section note, exam paper and answer key, each showing (a) a key equation callout with centred maths and a symbol list, (b) a framed figure with caption, (c) the status header with a progress bar, (d) a question block with a score chip. Report the images; a change that cannot be seen in them is not done.

## Assumptions & contingencies

- **Review stays, at reduced depth — on purpose.** Removing it is not an option (0.7.0 removed the reviewers, 0.7.1 restored them, and the crew is the only source-grounding gate), but the user asked for fewer tokens and lower latency and accepted weaker review. Reviewers therefore run at a fixed `low` thinking level, the visual role inspects crops instead of full pages, question review inspects only the declared pages, findings are capped at 12 per pass with at most six requested per reviewer, and a crew budgets ≤ 12 requests. Do not restore session-level thinking or full-page evidence to "improve quality"; that depth was traded away deliberately.
- **Budget fallbacks, in order.** If a 12-page section's crew still exceeds 90 s or 60k input tokens after Steps 1, 1b, 2 and 3: (1) `REVIEW_CONCURRENCY` 12 → 16; (2) `TEACHING_TOPICS_PER_PACKET` 4 → 8; (3) `SOURCE_WINDOW_PAGES` 4 → 8, halving source packets at the cost of a coarser fidelity window; (4) drop the visual role for that section and let the commit path emit its existing `> [!warning] Not independently reviewed: visual …` line. Stop there; never silently approve unreviewed content.
- **Provider limits.** If concurrency 12 produces 429/timeout failures, the pass stops with resumable checkpoints (existing behavior); set `REVIEW_CONCURRENCY = 8` and stop. If single-request latency on the user's model exceeds ~2 minutes, packet counts are still guaranteed while wall time scales linearly — report the measured number rather than loosening a gate.
- **Receipt invalidation is expected.** The pass cache key includes each packet's instruction, reads, views, crops, and payload, so the first delivery after Steps 1, 1b and 2 re-runs its crew once; Step 11 then removes the receipts that can never be reused.
- **Hash-bound Tutor/Exam gates (Step 7)** mean an edited Tutor explanation or a re-frozen Exam form re-runs one review pass (one request per packet, at the new low thinking level). Accepted; the alternative is approving stale content.
- **Small-context models** (contextWindow < 64000) keep their 2-page windows (`learn-review.ts:99-100`); with images gone from the source, teaching and assessment roles, those models now fit more evidence per request than before, but the split rule stays as written so packet sizes stay predictable.
- **Large figure sets.** The visual packer keeps the page+crop budget at 6 per packet, so a section with more than ~15 current crops plans more than three visual packets. Beyond four visual packets, the remaining crops are covered by the inventory text alone and that packet's receipt carries an `advice` finding naming the crops that were not inspected.
- **Presentation order.** Phase 4 is independent of Phases 2 and 3; run it first if the visual result matters sooner, or last to keep the diff focused. If the vault's `.obsidian/snippets/scholar.css` was customized, `installScholarAppearance` refuses to overwrite it, so the new CSS applies only after the user merges it — report that instead of overwriting.
- **HTML in notes.** The progress bar is the only HTML the renderers emit; if inline HTML ever stops rendering, the bar degrades to an empty `div` and the status callout still reads correctly.
