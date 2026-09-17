# Bound Learn preparation to 20 minutes of active agent work

## Context

Learn authoring has no wall-clock bound in the clone at `C:/Users/basam/.pi/agent/extensions/scholar` (branch `main`, HEAD `869bbe1`, v0.7.0, working tree clean, 2 commits ahead of `origin/main`). The only limits left after `5d959e2` are counts: `consecutiveRejections >= 8`, `actionCallCount >= 250`, and `MAX_PREREVIEW_REJECTIONS = 4` rejected `lessonComplete` calls. That commit deleted v0.6.0's 15-minute stall stop (`PROGRESS_STALL_MS` plus its coordinator interval), which left `lastProgressAt`, `turnActive`, `clock()`/`ports.now` and `loading.stallElapsedMs` written but read nowhere. A Learn run that alternates successful saves with rejected repairs can therefore keep working for hours.

Goal: Learn preparation is capped at 20 minutes of active agent work, enforced in code at two points, stops stickily with the saved draft intact, and every instruction/doc/README claim about limits matches the shipped behavior. Exam and Tutor keep their existing count limits — this change bounds Learn preparation only.

## Approach

Steps 1-3 are the behavior change; 4-6 keep the instruction, docs and evidence true. Do them in order; the tree stays loadable after each.

### 1. The constant — `domain.ts`

Add beside `QUICK_QUESTIONS` (`domain.ts:127`-ish, in the `/** Learn ends with a few short questions. */` area):

```ts
/** Active agent work allowed for one Learn preparation window. */
export const LEARN_PREPARATION_MS = 20 * 60_000;
```

`domain.ts` imports only `./types.ts`, and `tool-controller.ts`, `runtime-coordinator.ts` and `policies.ts` all already import `domain.ts`, so no cycle is introduced. `20 * 60_000` mirrors the documented 0.5.4 Learn ceiling.

### 2. Own the work clock in `tool-controller.ts`

Replace the dead stall state with an active-work clock. Exact edits:

**a. Message builder** (new export, above `createScholarToolController`, near `MAX_PREREVIEW_REJECTIONS` at `:78`), importing `LEARN_PREPARATION_MS` from `./domain.ts`:

```ts
export function learnWorkLimitMessage(section: ScholarSection): string {
  return `Scholar stopped: Learn preparation reached its ${LEARN_PREPARATION_MS / 60_000}-minute work limit. The saved draft is kept.`
    + ` Chat will not resume it; nothing more runs until the learner enters /scholar learn "${section.number || section.id}".`;
}
```

`ScholarSection` is already imported from `./types.ts`; the resume command is the plain reopen form, because v0.7.0 removed the `continue` flag from `/scholar learn` (`commands.ts`).

**b. State block** at `:136-144` — delete `lastProgressAt`, keep every other counter:

```ts
  const clock = () => ports.now?.() ?? Date.now();
  let consecutiveRejections = 0;
  let actionCallCount = 0;
  let turnActive = false;
  let turnStartedAt = clock();
  let learnWorkMs = 0;
  const beginAgentTurn = (): void => {
    turnActive = true;
    turnStartedAt = clock();
  };
  const endAgentTurn = (): void => {
    if (turnActive) learnWorkMs += Math.max(0, clock() - turnStartedAt);
    turnActive = false;
  };
  /** Active work of the current Learn preparation window, including the turn in flight. */
  const learnWorkUsedMs = (): number => learnWorkMs + (turnActive ? Math.max(0, clock() - turnStartedAt) : 0);
  /** A saved lesson ends the current preparation window. */
  const restartLearnWorkWindow = (): void => {
    learnWorkMs = 0;
    turnStartedAt = clock();
  };
```

**c. `evaluateResult`** at `:470-482` — delete only the `lastProgressAt = clock();` write; keep `consecutiveRejections = 0;`.

**d. Guard block** at `:492-495` — replace `if (!turnActive) { turnActive = true; lastProgressAt = clock(); }` with `if (!turnActive) beginAgentTurn();` (keeps the clock valid for any caller that bypasses the coordinator).

**e. New chokepoint check** — insert immediately after the `if (session.mode && book.outlineStatus !== "ready")` throw and before `try { ports.onLoadingActivity?.(...) }` (`:~:505`), where `book` is loaded:

```ts
            const learnSection = session.mode === "learn" ? findSection(book, session.recordId) : undefined;
            if (learnSection && params.action !== "status" && !lessonReady(learnSection, book.source.fingerprint.sha256)
              && learnWorkUsedMs() >= LEARN_PREPARATION_MS) {
              const message = learnWorkLimitMessage(learnSection);
              stopDelivery(message, ctx);
              throw new Error(message);
            }
```

`findSection` is already imported from `./types.ts`; add `lessonReady` to the existing `./lesson.ts` import at `:2` (`lessonHash, lessonCoverageIssues, commitLesson, lessonReady`). The `throw` reuses the same shape as the 250-action stop, so the existing catch converts it to a `tone: "error"` tool result. Readiness is the window predicate: an unready lesson means authoring is still in progress.

**f. End the window on a committed lesson** — in the `notes` handler, after the `await mutateBook(draft.id, ...)` that calls `commitLesson(current, state)` and `recomputeProgress(...)` (`:~:637-641`) returns, add `restartLearnWorkWindow();`. The three short questions that follow are then never cut short by preparation time, while a later revision (which makes the lesson unready again) starts with a full window.

**g. Public API** — in the `ScholarToolController` type (`:104-116`) add next to `endAgentTurn`:

```ts
  /** Starts the active-work clock for one Scholar turn. */
  beginAgentTurn(): void;
  /** Active agent work (ms) in the current Learn preparation window. */
  learnWorkUsedMs(): number;
```

and return both (`beginAgentTurn, learnWorkUsedMs,`) in the object at `:785-795`. Update the stale comment at `:128-130` to name the wall-clock budget.

**h. `resetTransientState`** at `:767-783` — replace the `lastProgressAt = clock();` line with `restartLearnWorkWindow();` (it already sets `turnActive = false`), so a Scholar command activation clears the budget like the other counters. Keep `endAgentTurn` in the returned API — it is called by `index.ts:177`.

### 3. Second enforcement point: the watchdog — `runtime-coordinator.ts`

`ensureScholarTurnInputLock` (`:558-581`) already computes `const newLesson = section && !lessonReady(section, book.source.fingerprint.sha256);`. Inside the same `if (!this.scholarTurnRun || ...)` init block add `this.toolController.beginAgentTurn();` beside `this.loading.start(...)`, and restore the removed interval shape after `this.loadingSourcePrepared = false;`:

```ts
      if (newLesson) {
        const run = this.scholarTurnRun, token = this.loading.token;
        const releaseInput = run.releaseInput;
        const deadline = setInterval(() => {
          if (this.scholarTurnRun !== run || this.loading.token !== token || !this.loading.active) { clearInterval(deadline); return; }
          if (this.toolController.learnWorkUsedMs() >= LEARN_PREPARATION_MS) {
            clearInterval(deadline);
            this.toolController.stopDelivery(learnWorkLimitMessage(section!), ctx as ExtensionContext);
          }
        }, 1000);
        deadline.unref?.();
        run.releaseInput = () => { clearInterval(deadline); releaseInput(); };
      }
```

`stopDelivery` latches, notifies, and calls `ctx.abort()`, so a run that never issues another tool call (hung provider, one endless generation) is stopped too. Imports to add: `learnWorkLimitMessage` in the `./tool-controller.ts` import (`:64-67`) and `LEARN_PREPARATION_MS` in the `./domain.ts` import.

### 4. Tell the model the bound — `policies.ts`

In the Learn contract template returned by `learnInstructions`, insert one bullet after the `notes.lessonPatch` bullet and before the `lessonComplete` bullet (v0.7.0's text: "When every objective, essential equation and figure is explained ... set notes.lessonComplete=true. Scholar checks the coverage checklist automatically..."):

```
- Learn preparation is bounded: ${LEARN_PREPARATION_MS / 60_000} minutes of your active work without a ready saved lesson ends this generation and keeps the saved draft; only the learner can restart it with /scholar learn. Work in one pass, fix the gaps Scholar names, and do not rewrite units that are already saved.
```

Add `LEARN_PREPARATION_MS` to the existing `./domain.ts` import. Do not touch the shared `QUESTION_ENGINE_POLICY` / `TEACHING_ENGINE_POLICY` / `SHORT_QUESTION_POLICY` templates — `tests/verify-scholar-engine-contract.mjs` asserts each appears exactly once, and this edit is in the per-mode Learn contract only.

### 5. Claims that describe limits

- `README.md`: add a new release section directly above `### Simplified study flow (0.7.0)`:

```markdown
### Learn work limit (0.7.1)

Learn preparation is capped at **20 minutes of active agent work**. The clock runs while a Scholar
turn is active and stops when the turn settles, so time you spend away between turns is not counted.
The limit is enforced twice: at the Scholar tool chokepoint, and by a watchdog that stops a run which
makes no further tool call. Reaching it stops that generation and keeps the saved draft byte-for-byte;
`/scholar learn "<section>"` starts a fresh window.
A saved lesson ends the current window, so the three short questions and later practice are never cut
short by preparation time.
Count limits remain unchanged: 8 rejections in a row, 250 actions, and four rejected `lessonComplete`
submissions.
```

- `README.md:50` (0.7.0 section): replace `Count limits remain (8 rejections in a row and 250 actions); the 15-minute stall stop is removed.` with `Count limits remain (8 rejections in a row and 250 actions). The 15-minute stall stop was removed here and is replaced in 0.7.1 by the Learn work limit above.` Older release sections are history and stay untouched.
- `docs/architecture.md` (~`:40`): replace the sentence `Count-based action budgets, stall detection, and tool isolation prevent runaway execution while ensuring model independence.` with `Count-based action budgets, the Learn preparation work limit, and tool isolation prevent runaway execution while ensuring model independence.` Leave the surrounding `review-layer.ts` sentences alone; the orphaned reviewer modules are a separate cleanup.
- `AGENTS.md`: insert one invariant bullet after the `**Approval is hash-bound.**` bullet:

```markdown
- **Learn preparation is wall-clock bounded.** An unready lesson may not consume
  more than `LEARN_PREPARATION_MS` (20 minutes) of active agent work. The tool
  chokepoint and the coordinator watchdog both enforce it, and a stop keeps the
  draft. Never leave a Learn run bounded by counts alone.
```

- `package.json` (`"version": "0.7.1"`) and `npm-shrinkwrap.json` (both `version` fields, root and `packages[""]`) — keeps the manifest/README release labels consistent. `tests/verify-scholar-package.mjs` only checks `pi.extensions` and directory discovery, so the bump is safe.

### 6. Deterministic proof — extend `tests/verify-scholar-simple-learn.mjs`

The runner discovers `verify-scholar-*.mjs` by filename (`tests/run.mjs`), so extending this existing verifier keeps the count at 55 and `AGENTS.md`'s "55 verifiers" claim true.

In `harness(caseId)` (`:59-75`): add `let fakeNowMs = Date.parse(now);`, pass `now: () => fakeNowMs` to `createScholarToolController`, capture the controller (`const controller = createScholarToolController({...}); controller.ensureRegistered();`) and return it with `advance: (ms) => { fakeNowMs += ms; }`. Load the constant with the existing `domain` handle (`const { LEARN_PREPARATION_MS } = domain;` at the top of the file).

Add three checks (keep the existing four unchanged). The probe action is `{ action: "assess", outcome: "pending", kind: "conceptual" }`, which reaches the guard before any grounding work; `{ action: "status" }` starts the turn and is never stopped by a budget.

1. `"the Learn work limit stops preparation and the stop is sticky"` — `harness("worklimit")`; `await h.execute({ action: "status" })`; `h.advance(LEARN_PREPARATION_MS)`; probe → assert `details.tone === "error"` and `/20-minute work limit/` in `content[0].text`; probe again → still `error`; `await h.execute({ action: "status" })` → `details.action === "status"`.
2. `"time between agent turns does not spend the Learn work limit"` — `harness("idle")`; `status`; `h.advance(LEARN_PREPARATION_MS * 0.9)`; `h.controller.endAgentTurn()`; `h.advance(6 * 60 * 60_000)`; `h.controller.beginAgentTurn()`; probe → `details.tone !== "error"` and no `/work limit/` text; `h.advance(LEARN_PREPARATION_MS * 0.2)`; probe → `error` with `/20-minute work limit/`.
3. `"questions after a ready lesson are not blocked by the work limit"` — `harness("worklimit-ready")`; `await h.execute({ action: "notes", lessonComplete: true })` (mirrors the existing commit check; commits and ends the window); `h.advance(LEARN_PREPARATION_MS * 3)`; probe → `details.tone !== "error"` and no `/work limit/` text.

## Critical files & anchors

- `tool-controller.ts` — `:2` (lesson import), `:78` (new message export), `:104-116` (controller API), `:136-144` (state), `:470-482` (`evaluateResult`), `:492-505` (chokepoint), `:~637-641` (`commitLesson` path), `:767-783` (`resetTransientState`).
- `runtime-coordinator.ts` — `:558-581` (`ensureScholarTurnInputLock`; `newLesson`, `loading.start`, and where the v0.6.0 interval sat), `:64-67` (import).
- `domain.ts` — `QUICK_QUESTIONS`/`assertShortQuestion` area (limit constants live here).
- `index.ts` — `:52` **must keep the exact text** `  const toolController = createScholarToolController({`; `tests/verify-scholar-completion-practice.mjs:106` and `tests/verify-scholar-input-lock.mjs:232` inject a hook by matching that literal and fail otherwise. `index.ts:177` already calls `endAgentTurn()` on `agent_settled`; no change needed there.
- `tests/verify-scholar-simple-learn.mjs` — `:59-75` harness, `:127-139` existing bound check to mirror.

## Verification

Run from `C:/Users/basam/.pi/agent/extensions/scholar` (verified present in this environment: Poppler 25.07.0 `pdfinfo`/`pdftotext`/`pdftoppm`, node v22.23.2, npm 10.9.8, `node_modules` installed):

1. `npm test` → expect `Scholar: 55 verifier(s) passed, 0 failed.` and `[PASS] verify-scholar-simple-learn.mjs` whose summary line reports 7 passed, 0 failed. If anything fails before the edits are complete, establish whether it was already failing at HEAD (`git stash`) and report it rather than silently widening the change.
2. `npm run test:list` → still `55 packaged verifiers` (confirms `AGENTS.md`'s count claim).
3. `npm test -- --preflight` → `[PASS] SDK and test dependencies load.`
4. Behavior proof is check 1 of step 6: with an unready Learn lesson, an action after 20 minutes of active work returns `tone: "error"` carrying `Scholar stopped: Learn preparation reached its 20-minute work limit.`, later actions stay refused, `status` still answers; check 2 proves idle time between turns is not charged; check 3 proves post-commit questions are unaffected.
5. Claim sweep: `git grep -n "stall\|20-minute\|work limit" -- README.md docs/architecture.md AGENTS.md` → no current-state claim of a 15-minute stall stop remains, and the new 0.7.1 section is the only place stating the 20-minute ceiling.
6. Not executable here: a live Pi-host Learn run against a real book (no Pi host or PDF book in this environment). `npm test` drives the real extension through the pinned Pi SDK host and is this package's declared evidence.

## Assumptions & contingencies

- 20 minutes of active work is the chosen "reasonable" ceiling, matching the 0.5.4 Learn limit. Changing it later means editing `LEARN_PREPARATION_MS` alone; every message, instruction line and README sentence derives from it.
- A stop keeps the draft and is sticky by design: only a Scholar command (`resetTransientState` via `commands.ts:385/423/438`, `activateBook`, or session start) clears it.
- The clock is `ports.now?.() ?? Date.now()`, already injectable for tests; production wiring in `index.ts:52` is unchanged.
- If a verifier pins the exact Learn-contract text or the edited 0.7.0 README sentence, update that expectation to the new truth instead of reverting the claim.
- If `npm test` reports verification-as-blocked (missing Poppler/SDK), re-check `pdfinfo -v` and the SDK path rather than treating it as a pass; the runner exits non-zero for blocked prerequisites.
- The orphaned reviewer modules (`review-layer.ts`, `learn-review.ts`, `review-runtime.ts`) and the historical README/architecture sentences that reference them stay as they are; this change only makes limit claims true.
