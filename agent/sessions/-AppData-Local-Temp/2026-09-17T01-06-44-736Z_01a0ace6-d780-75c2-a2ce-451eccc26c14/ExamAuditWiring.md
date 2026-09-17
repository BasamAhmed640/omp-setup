{
  "status": "complete",
  "accepted_by": "Main (confirmed 14/14 audit-as-you-go, 33/33 obsidian-exam, 32/32 exam-contract, 19/19 exam-size on their side; AuditFixes now owns tool-controller.ts and will verify the checkpoint change rather than re-implement it). Stopped editing per Main.",
  "exam_audit_unit": {
    "unit_key": "form:<examId>",
    "revision": "examFormFingerprint({ ...current, questions })",
    "roles": "[\"assessment\", \"teaching\"]",
    "packets": "planExamReviewPackets(current, questions, draft) at schedule time",
    "receipts_store": "exam.review via the new `\"questions\" in target` branch of reviewStore (persistReceipts + saveReviewCheckpoints reuse it)",
    "schedule": "scheduleExamAudit (tool-controller.ts ~363-376): reuses when unitAudited(receipts, unit, sourceHash) — one completed receipt per role bound to revision+source; aborts a same-key task for an older revision; otherwise starts exactly one audit",
    "finalization": "exam_build awaits outstanding tasks for this unit+revision+source, then handleExamBuild runs through a guarded MutateBook (tool-controller.ts ~1050-1065): the wrapper revalidates activation/authority/source hash and examFormFingerprint({...exam, questions}) === unit.revision inside the freeze mutation, evaluates examFormVerdict (reviewUnitIssues + unitBlockingFindings + unitReviewFailures on content-hash-filtered receipts, plus in-memory task failures as `thrown`), throws the ExamFormGate sentinel on any finding/failure/issue and only then runs the freeze write",
    "responses": "findingResponses merged into exam.review.responses in a guarded mutation before the gate (kept when findings remain open), and again by handleExamBuild on freeze"
  },
  "removed": [
    "the `exam:form:<id>` per-exam completed-pass latch (the generic completedPasses set still serves reviewQuestion)",
    "the synchronous withReview(...runReviewPass...) exam crew call plus its inline receipt/response mutation",
    "the reviewPassIssues import (no longer used in tool-controller.ts)"
  ],
  "post_review_fix": "DiffReview found that saveReviewCheckpoints.save dropped the assessment role, so an interrupted exam audit lost its finished question checks. Fixed in my file: the guard now admits \"assessment\" and reviewCheckpoint is called with `role as LessonReviewRole` (tool-controller.ts:297-306), with a new check `an interrupted exam audit resumes from its checkpointed question checks` that holds the form check, cancels via resetTransientState, and asserts the retry runs fewer than a full pass (>=1 and < questionCount+1 new checks) and still freezes. The pre-fix confirmation run was started then cancelled per Main's stop, so the 'fails without the guard' claim is inference from the dropped checkpoint, not an observed run.",
  "assertions_changed": {
    "tests/verify-scholar-obsidian-exam.mjs": "`exam_build ends with active paper and explicit submission...` now configures a passing reviewer (h.context.model + modelRegistry.complete). Contract change: a revision with no completed audit receipt can no longer approve, so the un-audited call that previously fell through to the freeze now stays a draft. Assertions unchanged.",
    "tests/verify-scholar-obsidian-exam.mjs (required checks)": "unchanged and still hold.",
    "tests/verify-scholar-audit-as-you-go.mjs": "existing 8 Learn/Tutor checks and their assertions unchanged; additive harness support (draft exam in the fixture, exam-mode activation, ui.notify stub, vault dir, holdRole) and 6 new Exam checks."
  },
  "new_exam_coverage": [
    "an exam form revision is audited once, and its findings reach the author in the same result (one prepared check per question + form; receipts per role bound to the fingerprint; formatted `role / severity / [F-<key>] / target / PDF pages: issue` + Repair; answered resubmission runs no new audit calls and freezes; answers stored)",
    "a changed form revision gets exactly one new audit the replaced receipts cannot freeze (old receipts kept but revision-bound, no old findings surface)",
    "a pending exam audit is awaited at freeze",
    "a failed exam audit leaves the exam unfrozen with a clear message (exam draft, `review incomplete (form:exam-1: provider)`, retry re-audits and can freeze)",
    "a form changed during its audit is never frozen (fingerprint revalidated inside the mutation)",
    "an interrupted exam audit resumes from its checkpointed question checks"
  ],
  "verification": {
    "node tests/verify-scholar-audit-as-you-go.mjs": "14 passed, 0 failed",
    "node tests/verify-scholar-obsidian-exam.mjs": "33 passed, 0 failed, 0 skipped",
    "node tests/verify-scholar-exam-contract.mjs": "32 passed, 0 failed",
    "node tests/verify-scholar-exam-size.mjs": "19 passed, 0 failed",
    "node tests/verify-scholar-ui-contract.mjs": "33/33 (extra sanity on the tool-driven exam_build path)"
  },
  "final_state": "tool-controller.ts contains the exam wiring, the assessment checkpoint guard and the LessonReviewRole type import; no other files were touched by me (Learn/Tutor behavior and the shared gate helpers are unchanged). No docs updated: neither AGENTS.md nor docs/architecture.md describes the exam audit flow. AuditFixes owns tool-controller.ts going forward; my edits were stopped before any hand-off collision."
}