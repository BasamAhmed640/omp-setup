{
  "status": "complete",
  "followup_fix": {
    "symptom": "Full suite: 56 passed, 1 failed — tests/verify-scholar-figure-coverage.mjs, check 'vector-only pages remain readable and require visual review despite absent captions', failing with finalization text 'Draft saved; review incomplete (lesson:lesson-physical-model: provider). Generation stopped...'. Standalone the file passed 19/0.",
    "root_cause": "Load-dependent overlap of two book mutations in that fixture. The per-unit audit's debounced checkpoint write (reviewCheckpoint via saveReviewCheckpoints) could still be in flight when the authoritative receipt write started, and that fixture's mutateBook loads a revision, mutates, then saveBookState(config, book, revision) — the write that went second threw ScholarRevisionConflictError. When the receipt write lost, the audit was recorded as failed and finalization reported 'review incomplete'. Which write lost depended on microtask/subprocess timing, hence suite-only.",
    "code_fix": "tool-controller.ts startUnitAudit now drains `await checkpoints.close()` immediately after runReviewPass and BEFORE persistReceipts, so the checkpoint and receipt writes can never overlap and a late checkpoint can never land after the receipts it belongs to; the finally block still closes (idempotent) and only then marks the task settled. Also labeled thrown audit-runner errors with code 'tool' instead of 'provider' (receipt-level provider failures keep 'provider').",
    "test_fix": "tests/verify-scholar-figure-coverage.mjs (now owned by me) serializes its mutateBook through a promise chain, mirroring the production single writer; the check itself is untouched and still asserts a caption-less vector page reaches the source reader (readPages.has(3)) with zero page renders (reviewedPages.size === 0) and that its crop reaches independent visual review (reviewedCrops.has(snapshot.sha256)).",
    "evidence": [
      "3 sequential runs: 19 passed, 0 failed each",
      "3 concurrent copies under load: all exit 0, 19/19 each",
      "1 run with the suite's exact env/cwd (PI_SCHOLAR_EXTENSION, PI_SCHOLAR_PI_PACKAGE, PI_SCHOLAR_STATE_ROOT, temp cwd): 19/19",
      "audit-as-you-go 8/8, simple-learn 5/5, learn-review 19/19, reviewed-progress 8/8, mode-figures 25/25, open-assessment pass, ui-contract 33/33, lesson-quality, review-runtime 20/20"
    ],
    "other_timing_dependencies": "None hidden: audit-as-you-go / mode-figures / open-assessment use explicit bounded polls (<=5s, fail with a clear message); simple-learn and reviewed-progress rely on deterministic awaits (finalization awaits the audit; handleNotes direct calls schedule no audits); the other edited fixtures are in-memory writers with no revision check."
  },
  "api_for_exam_wave": {
    "unit_type": "parse LessonReviewUnit = { key; entryId; revision; roles: ReviewRole[]; markdown; title; keyPoints: string[]; sourcePages: number[]; snapshotIds: string[] } (lesson.ts)",
    "enumerate": "lessonReviewUnits(section: ScholarSection, sourceHash: string): LessonReviewUnit[] | tutorReviewUnits(tutor: TutorSession): LessonReviewUnit[] (lesson.ts); controller wrapper recordUnits(target: ScholarSection|TutorSession, sourceHash): LessonReviewUnit[]",
    "schedule": "tool-controller scheduleUnitAudits(draft: ScholarBook, target: ScholarSection|TutorSession, ctx: ExtensionContext): void -> auditorFor(draft) -> skip if in-flight same (unitKey, revision, source hash, role set); skip if unitAudited(receipts, unit, sourceHash); else startUnitAudit(state, draft, target, unit, sourceHash, ctx)",
    "start_audit": "tool-controller startUnitAudit(state: PreparationAuditor, draft: ScholarBook, target, unit: LessonReviewUnit, sourceHash: string, ctx: ExtensionContext): void -> runReviewPass({ book, section?, config, ctx, signal, sourceHash, contentHash: unit.revision, snapshots, prepared: true, existingReviews, onCheckpoint }, packets) where packets = planLessonUnitPackets(unit, section, sourceHash, ctx.model?.contextWindow) or [planTutorExplanationPacket(...)]; results land via persistReceipts (mutateBook, the single writer)",
    "await_outstanding": "const currentUnits = new Map(lessonReviewUnits(section, sourceHash).map(u => [u.key, u.revision])); const outstanding = [...(auditor?.units.values() || [])].filter(t => !t.settled && !t.stop.signal.aborted && t.sourceHash === sourceHash && currentUnits.get(t.unit.key) === t.unit.revision); await Promise.allSettled(outstanding.map(t => t.done));",
    "read_back": "recordReviews(target): ReviewReceipt[] | persistReceipts(bookId, store: ReviewReceiptStore, activation, sourceHash, ctx, receipts) with ReviewReceiptStore = (state: ScholarBook) => { read(): ReviewReceipt[]; write(next: ReviewReceipt[]): void } | undefined | takePendingFindings(draft, target): string | auditFindingsForNextResult(): Promise<string>",
    "per_unit_filter": "unit.roles + contentHash: receipt.role === role && receipt.contentHash === unit.revision && receipt.sourceHash === sourceHash (unitAudited ignores failure receipts; unitReviewRoles/unitBlockingFindings/unitReviewFailures select the newest receipt per role at that revision+source; delivery ledger key = `${unit.key}\\u0000${unit.revision}\\u0000${findingKey}`)",
    "gate": "reviewUnitIssues(receipts, { contentHash, sourceHash, roles, responses }) wraps reviewPassIssues on contentHash-filtered receipts; learnReviewIssues(section, sourceHash) prefixes each issue with `lesson:<entryId>: `"
  },
  "files_changed": [
    "learn-review.ts",
    "learn-quality.ts",
    "lesson.ts",
    "tool-controller.ts",
    "review-layer.ts (comment only)",
    "AGENTS.md",
    "tool-actions/learning.ts (untouched)",
    "tests/verify-scholar-learn-review.mjs",
    "tests/verify-scholar-simple-learn.mjs",
    "tests/verify-scholar-reviewed-progress.mjs",
    "tests/verify-scholar-audit-as-you-go.mjs (new)",
    "tests/verify-scholar-mode-figures.mjs (authorized)",
    "tests/verify-scholar-open-assessment.mjs (authorized)",
    "tests/verify-scholar-figure-coverage.mjs (authorized)"
  ],
  "deleted": [
    "learn-review.ts: planReviewAssignments, reviewLearnDraft, ReviewAssignment, splitTopics and the section-crew constants",
    "tool-controller.ts: the awaited post-hoc Learn pass and its section-scoped saveReviewCheckpoints form, the blocking Tutor review pass and the lesson/tutor completedPasses latches",
    "learn-review.ts/lesson.ts dead imports (learnReviewHash usage in the notes path)"
  ],
  "wording_changes": [
    "Learn commit success is now always the pinned 'Full lesson committed after source, teaching and visual review. Now ask ...'",
    "Tutor saves return handleNotes' save message instead of 'Full explanation committed after teaching review.'",
    "execution-failure text names the unit (e.g. 'review incomplete (lesson:<id>: provider)')"
  ],
  "unowned_files_still_stale": [
    "policies.ts ~108-109 (Learn) and ~176-177 (Tutor) still describe the blocking post-hoc crew; they should describe per-saved-revision audits and findings arriving on the next tool result.",
    "docs/architecture.md:43 says review orchestration lives in review-layer.ts; it is now review-layer.ts + the tool-controller scheduler + learn-quality.ts/lesson.ts unit helpers."
  ]
}