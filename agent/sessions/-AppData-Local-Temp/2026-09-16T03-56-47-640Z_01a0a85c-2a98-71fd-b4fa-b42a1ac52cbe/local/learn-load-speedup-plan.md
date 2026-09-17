# Learn section loading and review speedup

Slug: `learn-load-speedup`

## Context

Loading a new Learn section takes too long. Measured on the user's real interrupted run of *Griffiths E&M / 1.2 Differential Calculus* (PDF pages 32–43 = 12 pages, 20 `###` topics, math in most topics): the review pass planned `source 3 + teaching 21 + visual ≥14` ≈ 38–45 packets, the crew runs `REVIEW_CONCURRENCY = 6` packets at a time, so the pass needed ~7 waves; 26 requests finished in the 8.6 min before the user cancelled it. Author-side, `view` (1 page/call, `tool-actions/source.ts:89`) and `snapshot` (1 rectangle/call, `tool-actions/visuals.ts:49`) are strictly one unit per call, so a 12-page section costs ~12 sequential view turns plus one turn per figure before any writing starts.

Intended end state: the same evidence is inspected by the same three reviewer roles under the same gates and receipts, but the pass runs ~2 waves instead of ~7 (packets ~45 → ~10), each question review costs one model request instead of a 2–3 request tool loop, and the author can render pages concurrently. Review coverage per mode stays as shipped: Learn = lesson crew + every question; Tutor = explanation + every question; Exam = the frozen form (all questions inside that pass). Grading is not reviewed.

Verified host facts the plan relies on:
- pi 0.85.1 runs sibling tool calls from ONE assistant message concurrently (`Promise.all`, `@earendil-works/pi-agent-core/dist/agent-loop.js:372`), with no per-message cap; a tool opts out only via `executionMode: "sequential"` (Scholar declares none).
- Scholar's book mutations are queued per (vault, bookId) and each queued mutation reloads state (`book-service.ts:113-166`), so concurrent `view`/`snapshot` calls cannot lose receipts.
- pi's extension API exposes no subagent/model API of its own (only `ctx.modelRegistry`); the reviewer crew already is the extension's parallel fan-out. No new agent infrastructure is possible or needed.

## Approach

### Step 1 — `learn-review.ts`: pack visual review across topics

`planReviewAssignments` (lines 97–168) currently runs `for (const topic of topics) … pack(topic, pages, topicCrops)` (line 148), so every math/figure topic flushes its own packet. Replace the per-topic flush with a greedy multi-topic packer; keep the existing `pack()` filler (lines 133–147) and its crop-travels-with-its-page flush rule byte-identical.

1. Change `pack`'s first parameter from `topic: Topic | undefined` to `topics: Topic[]`, and store `topics` on each packet object instead of `topic`.
2. Build units in topic order:
   `const units = topics.flatMap(topic => { const topicCrops = crops.filter(crop => topic.cropIds.includes(crop.id)), math = topic.markdown.includes("$$"); if (!topicCrops.length && !math) return []; return [{ topics: [topic], pages: sorted([...topicCrops.map(crop => crop.page), ...(math ? topic.pages : [])]), crops: topicCrops }]; });`
3. Merge units greedily while the combined image count (`pages.length + crops.length`) stays `≤ visualPacketImages`, then `pack(group.topics, sorted(group.pages), sortedCrops)` per group. Preserve page order; crops keep their topic order.
4. Keep the trailing loose packet exactly as today: `pack([], sorted([...pages.filter(page => !viewed.has(page)), ...loose.map(crop => crop.page)]), loose)` (line 154).
5. Packet rendering (lines 155–166): for `packet.topics.length`, the instruction becomes `Crew assignment: figures and equations for topic(s) "A", "B" (pages 1, 4, 5). Compare the listed full pages and crops with each topic's captions, explanations and Key equation callouts. Other crew members review the other topics and pages.` and the payload becomes `{ topics: packet.topics.map(({ heading, markdown }) => ({ heading, markdown })), figures: packet.crops }`. The loose packet keeps its current instruction and `{ pages, figureInventory, figures }` payload. Ids stay `visual:${index + 1}`.

Invariants that must hold for any section (assert them): every section page appears in **exactly one** visual packet's `views`; every current crop appears in **exactly one** packet's `cropIds` and its page is in that packet's `views`; every packet holds `views.length + cropIds.length ≤ 6`; no packet is empty. Baseline for the observed shape (12 pages, 20 math topics, crops on 5 pages): 21 packets → 2.

### Step 2 — `learn-review.ts`: group teaching topic checks

Add `const TEACHING_TOPICS_PER_PACKET = 4;` beside `SOURCE_WINDOW_PAGES`/`VISUAL_PACKET_IMAGES` (lines 62–63). `SOURCE_WINDOW_PAGES` stays 4 (4-page fidelity windows are a review property, not a bottleneck).

Replace `topics.forEach((topic, index) => add("teaching", \`teaching:${index + 1}\`, …))` (line 124) with a loop over consecutive slices of 4:

- id stays `teaching:${sliceIndex + 1}`.
- instruction: `Crew assignment: topics ${first + 1}-${last + 1} of ${topics.length}, "A", "B", "C", "D". Review only these topics' explanations against their source pages; the outline shows where they sit, and earlier topics may already define terms. The objective check plan and whole-lesson flow are reviewed by a separate coherence check.`
- `reads`: sorted union of the group's topic pages.
- payload: `{ topics: group.map((topic, offset) => ({ index: first + offset + 1, heading: topic.heading, markdown: topic.markdown })), checklist: group.flatMap(topic => topic.coverage) }`.

The coherence packet (line 126) stays byte-identical, including its `teaching:coherence` id and `{ checks, requiredChecks, recap, keyPoints, checklist, keyEquations }` payload. Baseline: 20 topics → 5 grouped packets + 1 coherence = 6 (was 21).

### Step 3 — `review-layer.ts`: question reviews inspect prepared evidence

`reviewTargetQuestion` (lines 582–616) currently runs `reviewOne(reviewOpts, "assessment", { value, sourcePages })` without `prepared`, so the assessment reviewer gets the `read_source`/`view_source`/`view_crop` tools and spends 2–3 sequential requests per question (observed in the current verifiers). Add `prepared: true` to the `reviewOpts` object it passes, keeping `sourcePages`, the retry-once behavior, and both error strings unchanged.

Consequence to accept and state in the code comment: the reviewer inspects exactly the question's declared `sourcePages` (plus crops on those pages for vision models) — it can no longer pull adjacent pages. `assertQuestionGrounding` already requires those pages to be in scope. The prepared collector inside `reviewOne` (lines 338–360) fills `read`/`viewed`/`cropped`, so the existing "Reviewer did not read page N" guard still enforces completeness.

### Step 4 — `policies.ts`: let the author's independent calls run together

In `learnInstructions`, the source-preparation bullet (line 103, starting `- During initial source preparation…`) gains this sentence, and the bullets keep their order (views → crops → inventory), because a crop needs the canvas dimensions its `view` returned:

`Issue independent source calls together in one message — up to four \`read\`/\`view\` calls for different pages at a time; the harness runs them concurrently and each still records its own durable receipt. Then issue the crops for the pages you just viewed together (up to four per message), then account for every page's visuals in one \`notes.figureReviews\` call.`

No code change: the controller tolerates concurrent calls, and `sourceFigureViews` is keyed per page. Do not instruct batching of calls that depend on another call's result (`snapshot` needs the `view` result's `canvasWidth`/`canvasHeight`).

### Step 5 — update the verifiers that pin the old packing

`tests/verify-scholar-learn-review.mjs` is the only file asserting packet structure (ids are never asserted). Expected new literals for its shape-mapping check (`options.section.endPage = 9`, topics `Alpha`/`Beta`, crops `crop-1`@p2 and `crop-2`@p8, coverage p2 and p5/p7):

- source: `[[1, 2, 3, 4], [5, 6, 7, 8], [9]]` — unchanged.
- teaching (line 129): `[[2, 5, 7], []]` (one grouped packet + coherence); coherence is now index **1** (lines 130–131 move from `[2]` to `[1]`).
- visual (line 132): `[[[2, 5, 7], ["crop-1"]], [[1, 3, 4, 6, 8], ["crop-2"]], [[9], []]]` (4 packets → 3).
- the bounded-runs check (line 139): teaching index `[0]`, expected reads `[[2, 2], [5, 5], [7, 7]]`.
- the "eleven-page source" check (line 333): recompute `event.batches` from the new deterministic plan and assert the literal (`plan.length`), never a loose `>=`.
- crowded-crop checks (lines 297–319): single-topic packing is unchanged — confirm they pass untouched; if the packet count changes, keep `views`/`crops` union assertions and update only counts.

Question-review checks to rewrite for prepared evidence (`tests/verify-scholar-learn-review.mjs` lines 196–218): "Question review reads its source and blocks a unique correct-option explanation cue" and "Question approval requires its source figure and full page, without unrelated-page requirements". New assertions: the review rejects with the same `/Repair the proposed question.*revealing the answer/s` and passes on a `pass` verdict; the completion is called exactly once per review; the request carries `tools: []`, `messages.length === 2`, and evidence for page 1 (+ `crop-1` for a vision model); a text-only model gets crop metadata instead of the image and still passes. Drop the now-impossible "reviewer omitted a tool call" cases.

`tests/verify-scholar-open-assessment.mjs` (the check added in 0.7.1, lines 169–226): the stub no longer issues a `read_source` tool call. Count one request per question review (`requests.filter(entry => entry === "assessment")`), assert the request had `tools.length === 0`, and keep the existing `changes`-refuses / `pass`-stores assertions. Re-run `tests/verify-scholar-ui-contract.mjs` unchanged: its stub's tool-call branches fire only for `messages.length === 1`, which prepared runs no longer produce.

## Critical files & anchors

- `learn-review.ts` — `planReviewAssignments` (97–168), constants (62–63), `pack` filler (133–147), per-topic flush (148), loose packet (154), packet rendering (155–166).
- `review-layer.ts` — `reviewTargetQuestion` (582–616); prepared collector and required-read sets in `reviewOne` (180–215, 338–360) show what `prepared: true` implies.
- `policies.ts` — Learn contract bullets (100–112); line 103 is the bullet that gains the batching sentence.
- `tests/verify-scholar-learn-review.mjs` — the only packet-shape verifier: 94, 102–103, 127–141, 196–218, 297–319, 331–333, 425–430.
- `tests/verify-scholar-open-assessment.mjs` — 169–226 (question-review stub and assertions).

## Verification

Run from `C:/Users/basam/.pi/agent/extensions/scholar`.

1. `npm test` → `Scholar: 55 verifier(s) passed, 0 failed.` (no new verifier files; the count stays 55).
2. Packing invariants, in `tests/verify-scholar-learn-review.mjs`: for the 9-page shape-mapping fixture assert the exact visual packet list from Step 5, plus explicit invariant assertions that (a) every page 1–9 appears exactly once across visual `views`, (b) every current crop appears exactly once with its page present, (c) every packet ≤ 6 images, (d) each material topic is named by exactly one teaching packet and the coherence packet exists exactly once.
3. Regression-proof baseline, in the same file: extend the shape-mapping fixture to the observed section shape (12 pages, 20 math topics, 5 crops) and assert `plan.length <= 12` with the per-role counts `source 3`, `teaching 6`, `visual <= 3`, and print the counts; the pre-change planner produces ~45 packets for that shape.
4. Question review cost: in `tests/verify-scholar-open-assessment.mjs` assert exactly one `modelRegistry.complete` call per question review and `messages.length === 2` with `tools.length === 0` (prepared), for both the pass and the changes verdict.
5. Author batching is instructed: add one assertion to `tests/verify-scholar-explanation-presentation.mjs` (it already asserts policy substrings against `learnPolicy`/`tutorPolicy`) that the Learn instructions contain `Issue independent source calls together in one message`.
6. End-to-end Learn flows still commit after the crew: `tests/verify-scholar-figure-coverage.mjs` (every page read+viewed, crops to the visual reviewer), `tests/verify-scholar-simple-learn.mjs` (three pass receipts, commit wording), `tests/verify-scholar-ui-contract.mjs` (production loader + preflight) — all green inside `npm test`.

## Assumptions & contingencies

- Concurrency of sibling tool calls is a host property (verified for pi 0.85.1); if a future host serializes them, Step 4's sentence simply stops paying off and nothing else changes. No plan step depends on it for correctness.
- Reviewer load stays bounded as today: `REVIEW_CONCURRENCY` stays 6, images per packet stay ≤ 6, source windows stay 4 pages. If the user later wants more, that is one constant plus the packet census above.
- Checkpoint reuse: receipts persist batch keys derived from each packet's instruction/read/views/crops/payload, so the repacking invalidates previously finished checks (including the 26 finished checks of the interrupted 1.2 run). The first `lessonComplete` after this change re-runs them once under the new packing, then checkpoints as usual. If a specific long section still feels slow, `TEACHING_TOPICS_PER_PACKET` (4 → 2) and `VISUAL_PACKET_IMAGES` are the single knobs; do not raise `REVIEW_CONCURRENCY` without measuring the provider's rate limits.
- If `TEACHING_TOPICS_PER_PACKET = 4` makes a reviewer miss a per-topic defect in practice, lower it to 2 rather than reverting the packing: the grouped payload still carries each topic's markdown and the reviewer is instructed to name the exact topic in `target`.
