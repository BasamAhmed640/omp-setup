import { parentPort, workerData } from 'node:worker_threads';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { PNG } from 'pngjs';

let library, document;
try {
  library = await PDFiumLibrary.init();
  document = await library.loadDocument(new Uint8Array(workerData.bytes));
  const totalPages = document.getPageCount();
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 2000) throw new Error('PDF must contain between 1 and 2000 pages.');
  if (workerData.pages.some(page => page > totalPages)) throw new Error(`PDF has ${totalPages} pages; requested page is out of range.`);
  const pages = [];
  for (const number of workerData.pages) {
    const page = document.getPage(number - 1);
    const original = page.getText().replace(/\r\n?/g, '\n').replaceAll('\0', '');
    const record = { number, text: original.slice(0, 24000), truncated: original.length > 24000 };
    if (workerData.includeImages) {
      const { originalWidth: width, originalHeight: height } = page.getOriginalSize();
      if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 100000)) throw new Error('PDF page dimensions are invalid or too large.');
      const scale = Math.min(2, 1600 / Math.max(width, height));
      const image = await page.render({ scale, renderFormFields: false, render: ({ data, width, height }) => {
        if (width < 1 || height < 1 || width * height > 2560000) throw new Error('PDF page preview exceeds the pixel limit.');
        return PNG.sync.write({ data: Buffer.from(data), width, height }, { colorType: 6 });
      } });
      if (image.data.length > 8 * 1024 * 1024) throw new Error('PDF preview exceeds 8 MiB.');
      record.image = { data: image.data, width: image.width, height: image.height };
    }
    pages.push(record);
  }
  parentPort.postMessage({ totalPages, pages });
} catch (error) {
  parentPort.postMessage({ error: `Could not read PDF: ${String(error.message || error).slice(0, 400)} Password-protected PDFs must be unlocked before attaching.` });
} finally {
  document?.destroy(); library?.destroy();
}
