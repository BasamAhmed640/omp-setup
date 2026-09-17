{
  "status": "complete",
  "files_changed": [
    "commands.ts",
    "command-syntax.ts",
    "tests/verify-scholar-exam-experience.mjs",
    "tests/verify-scholar-exam-scope-prompt.mjs",
    "tests/verify-scholar-resume-determinism.mjs (new, 279 lines)"
  ],
  "resume_selection_contract": "Bare `/scholar exam` (non-submit, no scope) is now fully noninteractive: candidates = book.exams.filter(status !== 'graded'), sorted by (updatedAt ?? createdAt) desc, then createdAt desc, then id desc -- a total order, so identical state always selects the same exam and input array order is irrelevant. The first candidate is resumed (presentExam for active, answer-key restore for graded, activateBook + startScholarModeTurn otherwise) and one info notice reports `Resuming <title> [<id>] -- <state>.` plus `Other unfinished exams: <title> [<id>]; ...` for the rest, with no ctx.ui.select/ctx.ui.input call anywhere. With zero unfinished exams it emits one info notice `No unfinished exam to resume. Create one with /scholar exam \"<scope>\".` + examScopeGuidance(book) and returns before any mutation/prompt. Exam creation is now reachable only from an explicit scope (`/scholar exam \"1-2\"`), where an unmatched no-name scope goes to resolveExamScope (unchanged behavior: tried, then re-asked with the reason).",
  "load_error_contract": "commands.ts sites help(:307), session guard(:337) and dispatch(:455) no longer swallow throws. loadBookState returning undefined keeps today's behavior (guide without a book / guard deactivates + persists pointer / 'no selected book' notice). A thrown load now notifies `Scholar could not load <the selected book|the active book>: <reason>` (level warning) via the shared loadFailureMessage helper and returns immediately: no selection clearing, no deactivation, no pointer rewrite, no exam work.",
  "deleted": [
    "commands.ts: chooseUnfinishedExam, START_A_NEW_EXAM, the ExamResume type, and the now-unreachable `if (!exam) { resolveExamScope }` creation block (creation folded into the explicit-scope branch)",
    "commands.ts: MAX_EXAM_SCOPE_PROMPTS -> MAX_EXAM_SCOPE_ATTEMPTS (3 total attempts, the typed value is attempt 1; resolveExamScope's `provided` parameter is now `string`, not `string | undefined`)",
    "command-syntax.ts: `continue?: true` on ParsedScholarCommand, the `learn ... continue` parser branch, and the return-object spread (zero consumers repo-wide; the tool-surface `/scholar continue` in tool-actions/tool-controller is a different code path and was not touched)",
    "tests/verify-scholar-exam-experience.mjs: the picker-based resume section (solo/picker/cancel/currentExamId assertions) and its chooseUnfinishedExam import"
  ],
  "kept": [
    "unfinishedExams (still used by the bare-submit picker at commands.ts:528-531) now returns the deterministic total order",
    "examPaperLabel (submit picker), examResumeLabel (now includes [exam.id] so every resume notice names the exact record)",
    "tool-controller exam submit confirmation path is untouched",
    "command-syntax.ts silent completion providers are untouched"
  ],
  "assertions_rewritten": [
    {
      "file": "tests/verify-scholar-exam-scope-prompt.mjs",
      "what": "Removed the two `resolveExamScope(book, undefined, ctx)` cases (the function no longer accepts a missing scope).",
      "reason": "Re-ask coverage now starts from an unmatched explicit scope: `fakeCtx([\"1-2\"]) + provided \"quantum tunnelling\"` (1 prompt, reason shown), `fakeCtx([\"nonsense\",\"2-3\"]) + \"also nonsense\"` (2 prompts, first already explains), and give-up `fakeCtx([\"bad two\",\"bad three\",\"1-2\"]) + \"bad one\"` -> 2 prompts, valid answer left unused, single `No exam was created` notice. Cancel case now uses an unmatched scope plus `[undefined]`. No-UI case unchanged."
    },
    {
      "file": "tests/verify-scholar-exam-experience.mjs",
      "what": "Section 4 rewritten from picker semantics to the deterministic listing contract (`graded` excluded, `submitted` still unfinished, order exam-002 then exam-001), plus a pointer that the bare-command resume is gated by the new verifier.",
      "reason": "chooseUnfinishedExam/START_A_NEW_EXAM no longer exist; the picker assertions had no behavior left to test."
    }
  ],
  "verification": [
    "node tests/verify-scholar-resume-determinism.mjs -> 35 passed, 0 failed (zero/one/multiple candidates; activity ordering; shuffled-input and repeated-run stability; equal timestamps with 3 identical fresh runs yielding exam-003 and one identical notice; 0 select/0 input calls on the bare path; empty case notifies and creates nothing; thrown duplicate-authority load failure on the dispatch, session-guard and help paths reports `Scholar could not load ...` with catalog pointer + session pointer + deactivation/persist counters unchanged; undefined keeps the exact 'no selected book' string and the guard's deactivate+persist path). Temp root is removed in a finally block.",
    "node tests/verify-scholar-exam-experience.mjs -> 28 passed, 0 failed",
    "node tests/verify-scholar-exam-scope-prompt.mjs -> 24 passed, 0 failed",
    "Manually re-read the submit branch: `/scholar exam submit` still requires hasUI/select/confirm, still throws for an unmatched ID, still routes submitted/graded records to the resume route; `exam` is definitely assigned on every continuation path."
  ],
  "test_files_not_run": [
    "tests/verify-scholar-input-lock.mjs (its only related assertion is the unchanged 'no selected book' path at :887, so no edit was needed; left for the orchestrator's full run)"
  ],
  "unowned_file_needing_a_follow_up": {
    "path": "README.md",
    "lines": "544-546",
    "current_text": "`/scholar exam` with no scope resumes an unfinished exam. When several are unfinished it offers all of them, plus the option to start a new one; cancelling creates nothing.",
    "suggested_replacement": "`/scholar exam` with no scope resumes the most recently touched unfinished exam and names the other unfinished ones; it never opens a picker or prompts. With nothing unfinished it explains the creation syntax instead of creating an exam.",
    "note": "README.md is outside my Target list, so I did not edit it. I did update the in-file user guide (commands.ts scholarGuide) which had the same stale 'or begin a new one' wording."
  }
}