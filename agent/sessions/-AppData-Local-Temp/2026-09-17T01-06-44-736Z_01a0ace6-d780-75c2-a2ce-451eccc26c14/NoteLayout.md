{
  "status": "complete",
  "filesChanged": [
    {
      "file": "render/section.ts",
      "change": "renderSection: chapter link moved out of the pre-lesson body into `content` (line 233, after the Learning record, before assessmentQuestionBlock); the pre-lesson status is now a single-line callout with the whole status in the title (status parts at :236-242, emitted at :247); unused statusCallout import dropped"
    },
    {
      "file": "note-records.ts",
      "change": "studyDocument (:144-153): the record metadata appendix `details(kind, metadata)` is emitted immediately before the re-inserted `## Questions` region / generated-end marker instead of right after the generated-start marker; questions are computed once (:148) and the appendix is inserted after the old question region is removed (:146, :152). attachDetails (top placement) is unchanged for book/exam/catalog notes"
    },
    {
      "file": "tests/verify-scholar-note-design.mjs",
      "change": "imports note-records/common helpers; two new checks pinning the layout and the position-tolerant round trip; tutor appendix assertion; entry-framing assertion"
    },
    {
      "file": "tests/verify-scholar-projection.mjs",
      "change": "writer-path assertions on the section note written by storage.saveBookState (one marker pair, status first, appendix after the Learning record and before END, handwritten tail once)"
    },
    {
      "file": "tests/verify-scholar-explanation-presentation.mjs",
      "change": "line 116 only: status-line assertion updated to the new single-line form (ownership granted by Main via IRC)"
    }
  ],
  "exactNewEmissionOrder": [
    "frontmatter - frontmatter() via renderSection (render/section.ts:243)",
    "<!-- scholar:generated:start --> - generatedDocument (render/common.ts:171)",
    "> [!scholar-status] In progress · Current section · Pages 4–12 · N short questions remaining - renderSection (render/section.ts:236-247) — the ONLY line between the start marker and the lesson",
    "## Lesson + entries (each preceded by its collapsed Scholar entry details and closed by <!-- scholar:entry:end -->) - renderSection content (render/section.ts:216-234) + transcriptBlock (note-records.ts:120-126)",
    "collapsed Source references - supplementalSourceFigureLines (render/section.ts:113)",
    "collapsed Recap and pitfalls - renderSection content",
    "collapsed Learning record - renderSection content (render/section.ts:229)",
    "[[../Chapters/…|Chapter N: Title]] chapter link - renderSection content (render/section.ts:233)",
    "collapsed `> [!info]- Scholar section details` JSON (exact attachDetails payload) - studyDocument (note-records.ts:152)",
    "## Questions + question blocks (question details remain inside each block as `> > [!info]- Scholar question details`) - studyDocument (note-records.ts:148,152)",
    "<!-- scholar:generated:end --> - unchanged",
    "handwritten tail after the end marker - preserveTail (note-storage.ts), untouched"
  ],
  "statusLineSettledOn": "`> [!scholar-status] <statusLabel> · [Current section · ]Pages X–Y · <progress line>` — single line, whole status in the title, no body lines, no chapter link above the lesson; progress-bar status callouts for home/book/chapter (and the tutor status callout) untouched",
  "parserScansVerified": [
    "readDetails (note-records.ts:14-27): anchored only on `^> [!info]- Scholar <kind> details`, scans the whole note — proven by parsing the same section record from three positions (appendix first, shipped placement, note bottom) plus the real writer output",
    "readQuestions/questionChunks (note-records.ts:60-79): opens at `## Questions`, closes at the next `## ` heading or END — the appendix now sits above that region, so the final question chunk is never polluted; `> > [!info]- Scholar question details` adjacency preserved",
    "readTranscript (note-records.ts:131-141): splits on entry-details callouts and requires `<!-- scholar:entry:end -->`; entry framing and markers untouched and asserted",
    "readStudyDocument round trip (note-records.ts:155-158): deep-equal (metadata JSON + entries + questions) across all three appendix placements, plus a byte-identical rewrite carrying a handwritten tail",
    "preserveTail contract: appendix is inside the generated region, so it is rebuilt each write and cannot leak into the tail; projection test confirms one START/END pair per note and OWNER tails preserved verbatim"
  ],
  "assertionsUpdated": [
    "tests/verify-scholar-explanation-presentation.mjs:116 → /^> \\[!scholar-status\\] In progress · Current section · Pages 1–16 · 3 short questions remaining$/m (the only line in that file touched; :117 and the <150-char header check still hold, header is ~93 chars)",
    "No change needed in tests/verify-scholar-ui-contract.mjs: 33/33 including the question-details adjacency checks at :569-583 and the completed-note check at :711-724"
  ],
  "placementNote": "Ticket wording said the appendix goes after the questions section; per Main's IRC recon I placed it immediately above `## Questions` (after the Learning record, chapter link alongside). Reason: questionChunks opens at `## Questions` and closes at the next `## ` heading or the end marker, so anything below the last question joins the final question chunk, and studyDocument's `^## Questions…(?=^## |END)` removal would eat the appendix on the next write. Approved by Main.",
  "tutorImpact": "Tutor notes share studyDocument, so `Scholar tutor details` moved to the same appendix position (verified); tutor pre-lesson status/book link/practice notice untouched, verify-scholar-note-design.mjs:149 tutor status assertion still passes",
  "verification": [
    "node tests/verify-scholar-note-design.mjs → 16 passed, 0 failed",
    "node tests/verify-scholar-projection.mjs → 4 passed, 0 failed",
    "node tests/verify-scholar-ui-contract.mjs → 33/33 checks passed",
    "node tests/verify-scholar-explanation-presentation.mjs → all checks passed"
  ],
  "caveats": [
    "verify-scholar-ui-contract.mjs showed transient failures while sibling slices were mid-edit in the review gate (learn-quality.ts/lesson.ts/learn-review.ts/tool-controller.ts); it passed 33/33 both before and after those windows with this change in place — the transient failures were in the lesson-commit review flow, never the layout assertions",
    "No unowned file needed changes beyond the one Main granted; the real vault was not touched"
  ]
}