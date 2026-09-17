{
  "changed_files": [
    "policies.ts",
    "docs/architecture.md",
    "README.md"
  ],
  "unchanged_targets": [
    "tests/verify-scholar-explanation-presentation.mjs",
    "tests/verify-scholar-engine-contract.mjs"
  ],
  "policies_rewrites": [
    {
      "location": "policies.ts:108 (Learn-mode contract bullet)",
      "before": "- Complete the source-grounded explanations of every objective and essential equation/figure, perform the focused editorial review, and save repairs before setting notes.lessonComplete=true. For new Learn deliveries this automatically runs independent source, teaching and math/visual reviews in parallel against the actual source pages, crops and saved explanations, using the current Pi model and a fixed low reviewer reasoning level. Read their concrete findings, repair the affected passages with the current expectedContentHash, update the checklist's exact evidence and resubmit. A resubmission after findings checks your recorded findingResponses instead of running the crew again; a fresh crew run happens only after an intentional revision of a committed lesson or a new /scholar learn activation. An interrupted, stale or unavailable review is never an approval.",
      "after": "- Complete the source-grounded explanations of every objective and essential equation/figure, perform the focused editorial review, and save repairs before setting notes.lessonComplete=true. Each saved explanation revision is audited once, as it is saved, while you continue authoring, using the current Pi model and a fixed low reviewer reasoning level; unchanged content is never audited again. Unresolved blocking findings arrive on your next Scholar tool result as [F-<key>] blocks naming the repair. Repair them with real edits to the saved revision (a lesson save or notes.lessonPatch with the current expectedContentHash), update the checklist's exact evidence, and supply findingResponses: [{ key, action: 'fixed' | 'declined', note }] when you resubmit; the repaired revision is audited in turn, and an unresolved rejected revision is not audited again. lessonComplete waits only for the outstanding audits of the current revisions, and a pending, failed, stale or unresolved audit is never an approval."
    },
    {
      "location": "policies.ts:177 (Tutor-mode contract bullet)",
      "before": "- Saved tutor explanations and every practice/mastery question are independently reviewed before delivery. Repair blocking findings and supply findingResponses: [{ key, action: 'fixed' | 'declined', note }]; a question review that fails blocks the question, never the learner's answer.",
      "after": "- Each saved tutor explanation revision is audited once, as it is saved, while you continue authoring; unchanged content is never audited again, and unresolved blocking findings arrive on your next Scholar tool result as [F-<key>] blocks. Repair them with real edits to the saved revision (a lesson save or notes.lessonPatch with the current expectedContentHash) and supply findingResponses: [{ key, action: 'fixed' | 'declined', note }]. Every practice/mastery question is independently reviewed before delivery; a question review that fails blocks the question, never the learner's answer."
    }
  ],
  "policies_untouched": [
    "policies.ts:109 (execution-failure bullet) - still accurate: a failed audit stops generation before delivery and the saved draft/checkpoints are preserved",
    "policies.ts:59 EXPLANATION_POLICY and every engine constant - kept verbatim (one focused editorial review; one definition per engine)",
    "policies.ts:144 Exam gate bullet - its one-pass + answered-resubmission behavior still matches tool-controller, left as-is",
    "short-question policy, 3-short-questions bullets, and all engine-composition lines untouched"
  ],
  "docs_updated": {
    "docs/architecture.md": [
      "intro paragraph: 'Source, teaching and math/visual reviewers run after the saved draft is prepared' -> 'audit each saved explanation revision as it is saved, while the author continues working'",
      "## Code boundaries, first paragraph: replaced 'single-pass review pipeline'/'commit immediately after one review pass' with the ownership split - review-layer.ts + review-runtime.ts plan each audit unit's packets and run the bounded reviewer pass; tool-controller.ts owns the per-preparation audit scheduler, findings delivery into later tool results, and finalization; per-unit gates in learn-quality.ts + lesson.ts",
      "same block: added the one-line invariant 'Audit-as-you-go; one audit pass per saved unit revision; no re-review of unchanged work; delivery stays controller-owned and hash-bound.'",
      "learn-quality/learn-review paragraph: replaced the 'parallel crew of scoped checks' sentence with per-unit packets (bounded source windows, one explanation check, visual check only over embedded current crops); corrected 'visual review must see each full page and saved crop' -> 'inspects every current saved crop and never a full page render'",
      "tool-controller paragraph: 'Network review runs outside the book's mutation queue. It then reloads...' -> 'Audits run outside the book's mutation queue; finalization waits for the outstanding audits of the current revisions, then reloads and checks...'"
    ],
    "README.md": [
      "'### Independent review restored (0.7.1)' only. Replaced the crew/before-they-commit sentence with: revisions audited once as they are saved while the author continues, questions inspected before shown, Exam form before it freezes. Replaced the findings sentence with: [F-<key>] blocks on the author's next Scholar tool result, answered with findingResponses, repair resolved by the audit of its new revision, unchanged content never re-audited, no second review round. Added: lessonComplete waits only for outstanding audits of current revisions; approval controller-owned and hash-bound. Kept the prepared-request/crop-quality sentence, the deliberate-trade sentence, and the wall-clock/count-limits sentence.",
      "version sections 0.7.0 and older left verbatim per the 'do not rewrite history' constraint; no version numbers or package.json touched"
    ]
  },
  "test_assertions": "No changes required. Neither owned test file contains an assertion that quotes the policy text I changed (verified by grep and by reading both files): verify-scholar-explanation-presentation.mjs asserts only engine-constant phrases (`/one focused editorial review/`, `/notes\\.lessonComplete=true/`, batching strings) which I kept, and verify-scholar-engine-contract.mjs asserts only template definitions/occurrence counts, which my in-template edits do not affect. Note: verify-scholar-explanation-presentation.mjs already shows as modified in the working tree from another agent's status-header hunk; I did not edit it.",
  "verification": [
    "node tests/verify-scholar-explanation-presentation.mjs -> all 7 [PASS] groups",
    "node tests/verify-scholar-engine-contract.mjs -> 26 passed, 0 failed (six templates, every mode x every engine exactly once, SHORT_QUESTION 0 in Exam)",
    "throwaway smoke script (executed, then deleted): loaded policies.ts via jiti and confirmed the five new Learn phrases and three new Tutor phrases render, and that the old crew/`automatically runs independent source, teaching and math/visual reviews`/`An interrupted, stale or unavailable review` text and standalone `crew` are absent from both policies"
  ],
  "notes": [
    "The README review prose lives only inside the version-blurb list; I updated the newest entry (the one describing the review model readers currently see) and left superseded release notes (0.7.0, 0.6.0, 0.5.x, 0.4.0) untouched as history.",
    "git status footprint for my targets: policies.ts, README.md, docs/architecture.md (verify-scholar-engine-contract.mjs clean; no scaffolding left behind)."
  ]
}