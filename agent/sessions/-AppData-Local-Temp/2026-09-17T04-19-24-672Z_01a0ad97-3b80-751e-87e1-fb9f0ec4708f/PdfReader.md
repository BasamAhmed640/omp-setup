{
  "status": "complete",
  "file": "C:/Users/basam/pi-discover/src/pdf.mjs",
  "exports": [
    "readPdfPages"
  ],
  "exportLines": {
    "readPdfPages": 93
  },
  "lineCount": 174,
  "unchanged": [
    "src/pdf-worker.mjs"
  ],
  "acceptance": {
    "nodeCheck": "pass",
    "grepExport": "exactly one: readPdfPages (line 93)",
    "forbiddenMentions": "none of Attachments/, Sources/, readPdf (old export), extractPdf, safeTitle, MAX_PDF, relative, old vault helpers (_atomic/writeText/writeJson) remain",
    "imports": [
      "node:fs/promises open",
      "node:crypto createHash",
      "node:worker_threads Worker"
    ]
  },
  "behavior": {
    "signature": "readPdfPages({ file, vault, pages, includeImages = false, signal })",
    "errors": [
      "<path>: file not found. (ENOENT, EISDIR, or non-file)",
      "The PDF is larger than 50 MiB.",
      "That file is not a PDF.",
      "Reading the PDF timed out. (60 s, worker terminated)",
      "worker error string wrapped in Error, e.g. Could not read PDF: ...",
      "signal.reason when it is an Error, else new Error('PDF reading cancelled.')"
    ],
    "cache": "_discover/pdf/<sha48>/meta.json {version:'pdfium-2.1.13-v1', sha256, totalPages, extractedAt} + page-NNNN.txt per extracted page; text-only calls reuse cached text, empty/corrupt cache simply re-extracts",
    "pages": "default 1..20; provided lists deduped/sorted/integer-filtered, intersected with 1..totalPages; unknown page count learned from a one-page probe before the rest is requested (the worker rejects out-of-range pages); truncatedPages = totalPages - 20 only when the list was defaulted",
    "returns": "{ sha256, sha48, totalPages, truncatedPages, pages:[{number,text,truncated,imagePath?}], images:[{number,data:base64 PNG,mimeType:'image/png'}] }"
  },
  "judgmentCalls": [
    "includeImages=true re-extracts only the first two in-range requested pages (the ones whose renders can be kept) and extracts the rest text-only; output is identical to the literal 'worker returns N, parent keeps 2' rule but the worker never renders more than two pages. Needed because vault.readFile returns text, so cached text can never yield PNG bytes, and because the landed consumer src/attachments.mjs passes includeImages=true for every vision model with the default 1..20 page list.",
    "A cached page's truncated flag is text.length >= 24000: page-NNNN.txt stores text only and meta.json's field set is fixed, so the worker's flag is not persisted. First-read output still uses the worker's flag.",
    "vault.writeFile receives a Buffer for page PNGs (binary), which its atomic fs.writeFile must pass through; flagged to Main via hub."
  ],
  "verification": {
    "stubWorkerHarness": "37/37 checks (throwaway, removed) — missing file/directory/non-PDF/51 MiB errors; 25-page fresh default -> probe [1] then [2..20], truncatedPages 5, meta.json + 20 text files; cache hits spawn no worker even with the worker rigged to fail; out-of-range and dedup/invalid page handling; renders written as binary PNGs with imagePath on the first two pages and extra pages dropped; >8 MiB render dropped; abort before/during the worker; hanging worker terminated on abort",
    "realPdfium": "13/13 checks (throwaway, removed) — real pdfium worker over generated 1- and 3-page PDFs: page text extracted, probe discovery, cached rereads, real 21 KB PNG renders written to _discover/pdf/<sha48>/page-0002.png and byte-identical to the returned base64, default-list image request returns two renders plus all page text",
    "workspaceNotes": [
      "node_modules/ is now populated (npm ci --ignore-scripts --legacy-peer-deps, 4 packages) so the real worker and npm test can run; package.json/package-lock.json untouched",
      "tests/pdf.test.mjs (old suite, slated for replacement in Step 7) still imports the deleted readPdf/extractPdf and will fail until it is deleted — outside my scope, flagged"
    ]
  }
}