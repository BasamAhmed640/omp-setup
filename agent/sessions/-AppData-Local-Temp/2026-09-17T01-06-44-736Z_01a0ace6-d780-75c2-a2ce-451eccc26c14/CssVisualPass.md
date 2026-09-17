{
  "file": "C:/Users/basam/.pi/agent/extensions/scholar/scholar.css",
  "line_count": 311,
  "previous_line_count": 177,
  "modified_files": [
    "scholar.css"
  ],
  "acceptance_commands": {
    "brace_balance_and_lines": "0 311",
    "hex_test": "false",
    "extra": "url( false, @import false"
  },
  "preservation_diff": {
    "original_rules": 70,
    "current_rules": 110,
    "missing_selectors": 0,
    "lost_declarations": 0,
    "new_duplicate_selectors": 0
  },
  "added_selectors": [
    ".scholar-note hr",
    ".scholar-note .callout + :is(h2, h3)",
    ".scholar-note .callout[data-callout=\"scholar-status\"]",
    ".scholar-note .callout[data-callout=\"scholar-status\"] .callout-icon",
    ".scholar-note .callout[data-callout=\"scholar-status\"] > .callout-title",
    ".scholar-note .callout[data-callout=\"scholar-status\"] .callout-content",
    ".scholar-note .callout[data-callout=\"scholar-status\"] .callout-content > p",
    ".scholar-note .callout[data-callout=\"scholar-status\"] + :is(h2, h3)",
    ".scholar-note .callout[data-callout=\"scholar-equation\"]",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] > .callout-title",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] .math-block",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] .callout-content > p > strong:first-child",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] .callout-content ul",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] .callout-content ul > li",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] .callout-content ul > li + li",
    ".scholar-note .callout[data-callout=\"scholar-equation\"] .callout-content > p:last-child",
    ".scholar-note .callout[data-callout=\"scholar-figure\"]",
    ".scholar-note .callout[data-callout=\"scholar-figure\"] > .callout-title",
    ".scholar-note .callout[data-callout=\"scholar-figure\"] .image-embed",
    ".scholar-note .callout[data-callout=\"scholar-figure\"] .image-embed img",
    ".scholar-note .callout[data-callout=\"scholar-figure\"] .callout-content > p",
    ".scholar-note .callout[data-callout=\"scholar-figure\"] .callout-content > p:last-child",
    ".scholar-note .scholar-progress",
    ".scholar-note .scholar-progress > span",
    ".scholar-note .scholar-score",
    ".scholar-home",
    ".scholar-note.scholar-home :is(h2, .HyperMD-header-2)",
    ".scholar-note.scholar-home table",
    ".scholar-note.scholar-home td:first-child",
    ".scholar-exam",
    ".scholar-note.scholar-exam .callout[data-callout=\"question\"]",
    ".scholar-note.scholar-exam table",
    ".scholar-note.scholar-exam .scholar-score",
    ".scholar-answer-key",
    ".scholar-note.scholar-answer-key :is(h2, .HyperMD-header-2)",
    ".scholar-note.scholar-answer-key h3",
    ".scholar-note.scholar-answer-key td:first-child",
    ".scholar-note.scholar-answer-key .scholar-score",
    "@media print -> .scholar-note .callout[data-callout=\"scholar-figure\"] :is(img, .image-embed)",
    "@media (prefers-reduced-motion: reduce) -> .scholar-note .scholar-progress span"
  ],
  "looks_like": {
    "scholar-equation": "An accent-left-bordered, faintly accent-tinted box with a small accent title, the $$ block centred at 1.12em, muted Symbols/Assumptions/Meaning labels, the symbol bullets as a marker-less definition list with hairline separators, and a small muted italic Source line last (--callout-icon: sigma).",
    "scholar-figure": "A plain-background box whose image embed is a 12.8px-padded, 1px-bordered, 0.6rem-radius frame with the image exactly centred (measured centring delta 0.0px), the caption paragraph in normal body text, and a small muted Source line.",
    "scholar-status": "A compact, faintly tinted muted strip (tight 6.4/12.8px vertical margins, icon hidden, 0.86em muted title and body) that sits directly above the first heading with a calm 1.2rem step to it, plus the progress bar when the note is home/book/chapter.",
    "scholar-progress": "A 6.4px (0.4rem) fully rounded track in var(--background-modifier-border) with an accent-filled inner span at var(--scholar-progress) (42% rendered 42.0%) that animates width over 200ms, timing out to 0s under prefers-reduced-motion: reduce.",
    "scholar-score": "An inline-block, non-wrapping chip with 0.1em/0.45em padding, 0.4em radius, tabular numerals and a 15% accent tint via color-mix, rendered as a small lavender pill in both themes."
  },
  "verification": {
    "selector_declaration_diff": "Parsed both versions (media-aware rule keying) and compared per-rule declaration sets against the pristine revision from `git show HEAD:scholar.css` (byte-identical 8366 bytes to the pre-edit file): 70/70 original rules present with every original declaration intact; the only duplicate selectors in the file are the four that were already duplicated before my change.",
    "chromium_parse": "Injected the file into a real Chromium page: 110/110 rules parsed (no rule silently dropped) and every declaration of every rule round-tripped, with the only serialization differences being Chromium normalizing `border: 0` -> per-side `0px`, `border-inline: none` -> expanded longhands, and merging `margin-inline-start/-end` into `margin-inline`.",
    "computed_style_smoke_test": "Rendered synthetic Obsidian callout DOM (status + progress bar, equation with Symbols list, figure with image embed, question with score chip) against the real file under light and dark shim themes: status icon display:none, margins 6.4/12.8px, muted title/body; equation --callout-icon: sigma, 3px inline-start accent border, computed background color-mix resolving in both themes, .math-block text-align center, muted labels/source, list-style none, 1px separators; figure frame 1px solid / 9.6px radius / background-secondary, image centring delta 0.0px, caption normal + muted source; track height 6.4px, radius 999px, fill exactly 42%, transition width 0.2s; score chip inline-block, tabular-nums, nowrap, 5.6px radius, accent tint. No page overflow (0px) in either theme.",
    "media_behaviour": "With prefers-reduced-motion: reduce the fill's transition-duration computes to 0s (vs 0.2s normally); under print emulation break-inside computes to avoid on the scholar-figure callout and on its image frame.",
    "visual_check": "Screenshots at 900px in light and dark (throwaway page in Temp, since deleted) confirmed the status strip and progress bar above the heading, centred maths with muted labels and hairline-separated symbol rows, the framed centred figure with normal caption and muted source, and the 2/3 pill; no overlap, misalignment or unreadable contrast. The literal `$…$` delimiters in the symbol rows are the shim's missing MathJax, not a CSS defect."
  },
  "notes": [
    "Kept every pre-existing declaration byte-for-byte, including --file-line-width (78ch / 74ch for section+tutor / 76ch for exam paper) and --line-height-normal: 1.65; no renderer, test or other file was touched.",
    "Spacing scale --scholar-space-1..4 (0.4/0.8/1.2/1.6rem) is declared on .scholar-note and used 25 times across the new callout margins, the progress bar and heading steps, lesson-unit separators (hr) and the per-artifact rhythm rules.",
    "File kept to nine `/* ---- … ---- */` sections; the print block keeps its two original rules and gained a figure-frame break-inside guard; the reduced-motion override uses a distinct selector (.scholar-progress span) so no new selector text appears twice."
  ]
}