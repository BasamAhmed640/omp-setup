{
  "status": "complete",
  "fixes": [
    {
      "defect": 1,
      "title": "Unit evidence identity is the audited evidence, not the markdown hash alone",
      "files": [
        "lesson.ts:269 lessonUnitRevision(contentHash, sourcePages, snapshotIds) derives the evidence revision",
        "lesson.ts:277-303 LessonReviewUnit now carries both: revision (audited evidence: markdown + cited pages + current crops) and contentHash (the lesson revision stored receipts bind to); tutorReviewUnits:305-312 sets both to the markdown hash",
        "lesson.ts:316-321 learnReviewIssues binds receipts to unit.contentHash; validLessonEntries:121-125 keeps matching lessonHash(markdown), untouched",
        "tool-controller.ts:344 unitAudited compares receipt.contentHash === unit.contentHash",
        "tool-controller.ts:349-363 evidenceIdentities + retireSupersededEvidence: a save that keeps the text but changes cited pages/crops retires the unit's receipts, so they can never approve the replacement",
        "tool-controller.ts:970-981 the notes save mutation captures the pre-save evidence identity and retires inside the same atomic write",
        "tool-controller.ts:293-314 unitIsCurrent + persistReceipts guard, and 316-340 the checkpoint guard: a superseded/discarded audit's late verdict or checkpoint is never stored for a revision it did not audit",
        "tool-controller.ts:1040-1047 finalization merges only still-current tasks' receipts and reports evidence drift; takePendingFindings (464-478) filters in-memory receipts to current revisions",
        "tests/verify-scholar-audit-as-you-go.mjs fixture: the real PDF fixture is now two pages (section 1-2, page-2 figure coverage recorded) so a page-list-only change stays in scope"
      ],
      "design_note": "ReviewReceipt has no evidence field, and tests/verify-scholar-simple-learn.mjs + verify-scholar-reviewed-progress.mjs pin ReviewReceipt.contentHash to lessonHash(markdown) and must keep passing. So the per-unit gate still binds receipts to the lesson revision, and the evidence revision is enforced by the single writer: audits are scheduled/drift-checked on unit.revision and receipts for evidence a unit no longer cites are retired, never evidence."
    },
    {
      "defect": 2,
      "title": "A discarded audit explains itself instead of reporting a review nobody produced",
      "files": [
        "tool-controller.ts:244-256 discardAudits records book+unit -> evidence revision for every in-flight audit it drops",
        "tool-controller.ts:390 a real verdict clears the record; 1047-1048 finalization detects a discarded current revision that still has no verdict",
        "tool-controller.ts:1054/1063-1065 the discard branch is returned before any findings claim and skips stopDelivery; the approval guard now also requires discarded.length === 0",
        "message: 'Draft saved; the audit of the saved explanations was discarded because the active preparation changed (<units>). Save the current revision again, then resubmit lessonComplete.'",
        "note: the reviewer's literal reopen-then-lessonComplete path already self-heals (the notes call re-schedules and awaits a real audit; verified with a throwaway repro), so the message covers the genuinely unrecoverable case - the preparation changing while finalization waits"
      ],
      "checks": [
        "tests/verify-scholar-audit-as-you-go.mjs:384 'a discarded audit returns an actionable repair path and approves nothing' - asserts the message, the absence of 'review incomplete'/'found repairs'/'Full lesson committed', no stored receipt, no lessonCommit, lessonReady false. Proven to fail with the discarded branch neutralised."
      ]
    },
    {
      "defect": 3,
      "title": "No full book load per tool result",
      "files": [
        "tool-controller.ts:157-159 PreparationAuditor.pendingFindings",
        "tool-controller.ts:390-392 set when a finished audit carries an undelivered blocking finding; 412-419 set when a stored verdict is reused and still undelivered",
        "tool-controller.ts:484-491 the delivery probe returns before loadBook unless pendingFindings is set, then clears it after the scan"
      ],
      "checks": [
        "tests/verify-scholar-audit-as-you-go.mjs:346 'a tool result with nothing to deliver performs no delivery book load' - harness now counts loadBook calls (bookLoads()); a passing audit -> a read costs exactly one load, a pending finding -> two and rides the result. Proven to fail with the gate disabled."
      ],
      "semantics": "unchanged: once per (unit, evidence revision, finding key), current revisions only, text only - never an approval"
    },
    {
      "defect": 4,
      "title": "Exam assessment-role checkpoints",
      "status": "already correct in the tree",
      "evidence": [
        "tool-controller.ts:334 the guard admits assessment; 328 reviewCheckpoint receives role as LessonReviewRole",
        "tool-controller.ts:385-388 (and the finally at 399) await checkpoints.close() before persistReceipts, so checkpoint writes are drained before the authoritative receipt write",
        "proven by the existing check tests/verify-scholar-audit-as-you-go.mjs:563 'an interrupted exam audit resumes from its checkpointed question checks' (finished question checks persisted and reused, exam stays a draft), and by the learn-review deadline check proving a checkpoint is never approval"
      ],
      "note": "no duplicate check added (ExamAuditWiring landed both). My only change in that path: exam units now carry contentHash = form fingerprint (tool-controller.ts:1117-1119) so the shared guards keep working."
    },
    {
      "defect": 5,
      "title": "AGENTS.md review-scope invariant",
      "files": [
        "AGENTS.md:49-52 now reads: a unit's audit reads bounded windows over the pages that unit cites and inspects only that unit's current saved crops; never accept a summary of evidence in place of the evidence, and never use a page render for review"
      ]
    }
  ],
  "new_coverage": {
    "tests/verify-scholar-audit-as-you-go.mjs": [
      "268 a page-list-only revision change re-audits and the replaced receipts never approve it (receipts retired, gate refuses until the new audit lands, lesson receipt still lessonHash(markdown), unchanged unit reuses its receipts) - fails pre-fix with retirement disabled",
      "306 a superseded audit's late verdict never lands as current evidence (concurrent-writer simulation) - fails pre-fix when the revision comparison is weakened",
      "346 nothing to deliver performs no delivery book load - fails pre-fix when the pending gate is removed",
      "384 discarded audit returns an actionable repair path and approves nothing - fails pre-fix when the discard branch is neutralised",
      "17 -> 18 checks"
    ],
    "tests/verify-scholar-learn-review.mjs": [
      "123 the unit revision covers the audited evidence and only an evidence change moves it (page-list and crop changes move revision; contentHash stays lessonHash(markdown); receipts bind to it)",
      "updated pinned assertions that encoded the old single-hash semantics (auditOptions now passes unit.contentHash, gate contexts use contentHash, the unit revision expectation is now lessonUnitRevision(...)) - none weakened, the old lines were the bug",
      "19 -> 20 checks"
    ]
  },
  "verification": [
    "node tests/verify-scholar-audit-as-you-go.mjs -> 18 passed, 0 failed",
    "node tests/verify-scholar-learn-review.mjs -> 20 checks passed",
    "node tests/verify-scholar-simple-learn.mjs -> 5 passed, 0 failed",
    "node tests/verify-scholar-mode-figures.mjs -> 25 passed, 0 failed",
    "neighbours green: reviewed-progress 8/8, learn-quality, math-formatting, history 11/11, lesson-delivery, figure-coverage 19/19, open-assessment, resume-determinism 49/49, note-design 16/16, explanation-presentation, round3-grading 47/47, obsidian-exam 33/33"
  ],
  "left_alone": [
    "learn-quality.ts, review-layer.ts, learn-review.ts, docs/architecture.md and every other non-owned file: untouched",
    "ReviewReceipt.contentHash semantics and schema (no new field, no marker): required by simple-learn/reviewed-progress; the singleton-batch/diagnostics tricks were rejected as schema abuse",
    "evidence changed outside the tool's save mutation (hand-edited note details) is still not detected by the retirement - note details are already outside the schema/authentication boundary",
    "resetTransientState deliberately does not clear discardedAudits: that record is what makes the next finalization explain the discard; entries stay keyed by book+unit and are cleared by a real verdict",
    "no npm test, formatter, linter or typecheck run (per instructions); the throwaway repro script used to probe the discard path was deleted"
  ]
}