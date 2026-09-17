{
  "status": "complete",
  "guard_scoping": {
    "book_dependent_actions": [
      "learn",
      "exam",
      "tutor"
    ],
    "behavior": "The active-book guard now runs only for learn/exam/tutor: a thrown loadBookState notifies 'Scholar could not load the active book: ...' and returns before any work; a missing state file still clears the session as before. The later selected-book guard (learn/exam/tutor) is unchanged.",
    "book_independent_actions": [
      "close",
      "open",
      "obsidian",
      "library",
      "help",
      "default (bare /scholar)"
    ],
    "behavior_2": "close/open/obsidian/library skip the guard entirely and execute normally (close keeps its own recovery+deactivate; obsidian/library/open run their branches; nothing is deactivated by the guard). help and bare /scholar route through a new notifyScholarGuide helper: an unreadable selected book emits the standard load-failure warning, then the same guide still runs with the first line replaced by 'Selected book: state could not be read. Book-specific guidance is omitted; /scholar open can switch books.' instead of the false 'No book currently selected' claim. scholarGuide gained an optional unreadable flag for that line."
  },
  "readme_changes": {
    "passage_1_replaced": "Reopening a saved, unfinished lesson asks whether to continue preparing it now or only show its Obsidian draft location. Only viewing starts no generation and leaves Learn inactive, so chat cannot resume it. `/scholar learn \"9.3\" continue` skips the question; without an interactive UI, reopening only shows the draft. -> Viewing a saved, unfinished lesson only shows its Obsidian draft location: no generation starts and Learn stays inactive, so chat cannot resume it. A later `/scholar learn \"<scope>\"` starts a fresh, bounded preparation attempt.",
    "passage_2_replaced": "Reopening an unapproved draft with `/scholar learn \"9.3\"` and choosing to only view it leaves Learn inactive, so chat cannot resume preparation. Choosing to continue, or `/scholar learn \"9.3\" continue`, starts a fresh, bounded preparation attempt. -> Viewing an unapproved draft leaves Learn inactive, so chat cannot resume preparation. A later `/scholar learn \"9.3\"` starts a fresh, bounded preparation attempt."
  },
  "new_checks": [
    "guard-scoped-help (broken active book): guide reached, single load-failure warning first, session untouched",
    "guard-scoped-close: close notice with no load-failure notice; exactly one deactivation/persist from close itself",
    "guard-scoped-obsidian and guard-scoped-library: info notice only, no deactivation or pointer rewrite",
    "guard-scoped-open: chooseCandidate consulted once, no notices, session untouched",
    "help-load-failure: guide shown, load failure named first, no 'No book currently selected', no mutation",
    "default-load-failure: bare /scholar reaches the guide with the unreadable line, session untouched",
    "guard-load-failure strengthened: exactly one warning notice for a book-dependent command",
    "retained: dispatch-load-failure and guard-load-failure still assert load-failure notice, no deactivation/persist, no exam work"
  ],
  "verification": {
    "tests/verify-scholar-resume-determinism.mjs": "49 passed, 0 failed",
    "tests/verify-scholar-input-lock.mjs": "24 checks passed",
    "tests/verify-scholar-routing.mjs": "passed",
    "tests/verify-scholar-question-resume.mjs": "6 verifications passed"
  }
}