# Feature audit

Discover has three jobs: ask questions in Pi, read and explore the answers beautifully in Obsidian, and return to useful saved work. A feature earns its place by serving those jobs and giving useful control without repeated storage or hidden work. These decisions are updated for version 0.6.0.

## Keep

| Feature | Why it earns its place |
| --- | --- |
| Explicit vault linking and relinking; separation from Scholar | The user controls the destination. Content stays in that vault and never mixes automatically with Scholar or another vault. |
| Pi composer and isolated research session | One place to write, with the selected model and a small, explicit set of tools. |
| Ask/Deep effort choice | A visible choice lets the user request a direct answer or deliberate investigation. Both use the selected model; only substantial Deep answers receive an evidence review. The initial investigation has no hard token budget. |
| One bounded evidence reviewer for substantial Deep drafts | A fresh session checks selected consequential claims against original evidence and flags major explanation gaps. It cannot edit or publish; the lead decides how to resolve findings. Fixed limits and no model-routing setup keep the extra work predictable. |
| Dark Obsidian reader, photos, Markdown tables and Mermaid | The reading experience is the purpose of the product. Styling and diagrams use the existing rendering surface. |
| Line, bar and scatter charts; hover details, series toggles and data tables | These explain common research relationships through one small shared renderer. |
| Saved chart specification, static preview and offline HTML | Visuals remain useful with Pi closed and without a network connection. The existing note tool can reread chart data when a later question needs it. |
| New conversation, resume and continue a note | Native history preserves a conversation; selecting a note starts a focused discussion from its current contents. |
| Fork/branch through a selected historical entry | Explore an alternative direction without changing the source conversation or carrying later turns into the branch. Copy native history, without a second checkpoint system or staged drafts. |
| Attachments, image paste and clearing staged attachments | Original files belong with the discussion. Users must be able to remove a mistaken attachment before sending. |
| Searchable conversation picker and Follow Pi | Readers can browse older work or follow the live conversation without unexpected navigation. |
| Source snapshots and source-backed knowledge notes | Original evidence and reusable synthesis have distinct purposes. Knowledge edits retain revision checks and previous contents. |
| Durable history, recovery, writer isolation and bounded file access | These protect saved work. They are reliability requirements rather than optional interface features. |
| Optional vault-local `Style/Voice.md` | A small customization point directly serves the requested writing style. |
| Shared response guide and brief writing self-check | Direct answers and clear explanations need consistent instructions across modes and tool turns. The lead uses this guide; substantial Deep answers now also receive a bounded evidence review. |
| PDF text, page previews and original-page citations | PDF questions are a frequent user workflow. Read selected pages in a short-lived worker and reuse extracted material in the vault. |
| Comparison, critique and figure recipes | Focused guidance is loaded when relevant, using the existing agent and tools. |
| Rendered formatting check | Catch unreadable or broken visuals at narrow and wide pane widths before publishing a chart/note or final Deep answer. Reuse exact current-turn checks to avoid redundant rendering. |

The lead has eleven tools: `web_search`, `fetch_source`, `search_notes`, `read_note`, `read_attachment`, `read_pdf`, `recall_conversation`, `research_workflow`, `check_presentation`, `save_knowledge` and `save_visual`. Conversation recall earns its place by recovering exact evidence and user corrections after compaction without a new database, memory agent or blanket transcript injection. Research-focused compaction instructions and the reviewer's selective conversation brief use the existing runtime and vault history.

## Cut or simplify

| Previous feature | Decision and reason |
| --- | --- |
| Automatic vault search on every prompt | Retrieve on demand through the agent's note tools. A trivial follow-up should not trigger a vault scan or inject unrelated snippets. |
| Separate conversation checkpoint tool and repeated checkpoint injection | Use native conversation history and Pi's compaction. A second generated memory record can become stale and compete with the actual discussion. |
| Context command | Remove alongside automatic context injection. Selecting a note remains an explicit action; note reads remain visible in saved tool history. |
| Persisted chart controls | Keep interaction within the open chart. Reopening starts with all series visible, avoiding mutable preference files and their failure modes. |
| Editable chart identity and numbered revisions | Every save creates a new immutable chart. A revised answer gets a new chart; earlier answers keep their original artifact. |
| Archiving search snippets as sources | Search discovers evidence. Its results already live in tool history; only fetched original pages become source snapshots. |
| Duplicate source `extracted.md` | Write the readable source note and provenance metadata. A second copy of the same extracted text has no active consumer. |
| Separate Home dashboard | Keep the searchable conversation picker, Follow Pi and a quiet empty state. Another recent-conversation list duplicates navigation. |
| Automatic knowledge writing at research milestones | Save knowledge when the user asks to remember, save or update it. Ordinary answers stay in conversation history. |
| Repair and unlock commands | Retain as recovery diagnostics, outside the everyday workflow. |

## Defer

Larger agent teams, recursive delegation, model routing, authenticated browser automation, automatic OCR, embeddings, automatic wiki maintenance, arbitrary generated interactive code, cloud synchronization and a second chat composer remain outside this release. The wiki is still an intended optional integration.

## Compatibility

Version 0.3.0 preserves Ask/Deep, forks and the storage/context simplifications. It does not delete or migrate existing vault files. Existing conversations and earlier forks remain resumable. Legacy `Context.md` files remain readable as notes, but are no longer automatically injected into prompts. Existing source snapshots, extracted files and knowledge revisions remain intact.

The companion continues to render legacy chart references as well as newly saved artifacts. Existing saved chart HTML remains frozen with the renderer and behavior embedded when it was created. New saves use the simplified artifact format; they do not rewrite earlier charts or their historical answers.
