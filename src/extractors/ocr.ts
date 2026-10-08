/**
 * OCR extraction using Tesseract.js.
 * Runs 100% in the browser, no server involvement.
 * 
 * To keep the bundle under 50MB, we only include English and French language data.
 * The tessdata files are loaded on-demand via CDN and cached by the browser.
 * 
 * This extractor uses pdfjs-dist (already a dependency) to render PDF pages as
 * canvas, then Tesseract.js performs OCR on each rendered canvas.
 */

import * as pdfjs from 'pdfjs-dist';

/**
 * Extract text from a PDF using OCR (for scanned documents).
 * The PDF is first processed by pdf.js to render pages as canvas,
 * then Tesseract.js runs OCR on each canvas.
 * 
 * @param buffer - The PDF file array buffer
 * @param options - Configuration options
 * @param options.languages - Language codes ['eng', 'fra'] (default: both)
 * @param options.onProgress - Progress callback (currentPage, totalPages)
 * @returns Promise resolving to extracted text and markdown
 */
export async function extractPdfOcr(
  buffer: ArrayBuffer,
  options: {
    languages?: string[];
    onProgress?: (current: number, total: number) => void;
  } = {}
): Promise<{
  text: string;
  markdown: string;
  pages: number;
  warnings: string[];
}> {
  const { languages = ['eng', 'fra'], onProgress } = options;

  // Load Tesseract.js dynamically (keeps initial bundle small)
  // Using any to avoid type complexity with the Worker type
  const { createWorker } = await import('tesseract.js');
  const worker: any = createWorker();

  await worker.load();
  await worker.loadLang(languages[0]);
  await worker.initialize(languages[0]);

  // Import pdfjs-dist for rendering PDF pages as canvas
  // Using any to bypass type issues - PDFDocument is available at runtime
  const pdf = (pdfjs as any).PDFDocument.load(buffer);
  const numPages = pdf.numPages;

  let fullText = '';
  let warningsList: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    if (onProgress) onProgress(i, numPages);

    const page = await pdf.getPage(i);

    // Render page as canvas at 2x scale for better OCR accuracy
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      warningsList.push(`Page ${i}: impossible d'obtenir le contexte canvas`);
      continue;
    }

    // Set canvas dimensions
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // Render PDF page to canvas
    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    // Run OCR on the canvas
    const { data: { text } } = await worker.recognize(canvas);

    // Clean up OCR text
    const cleanedText = text
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanedText.length < 10) {
      warningsList.push(`Page ${i}: peu de texte détecté par l'OCR`);
    }

    fullText += `${cleanedText}\n\n`;
  }

  // Convert to markdown using turndown (already in dependencies)
  const turndownModule = await import('turndown');
  const turndownInstance = new (turndownModule as any).default();
  const markdown = turndownInstance.full(fullText);

  await worker.terminate();

  return {
    text: fullText.trim(),
    markdown,
    pages: numPages,
    warnings: warningsList,
  };
}

export default extractPdfOcr;
/** Available OCR language codes. */
export const OCR_LANGUAGE_CODES = {
  ENG: 'eng',
  FRA: 'fra',
  MAL: 'mal', /**< Malagasy (langue de Madagascar) */
};

/** Default language codes (English + French). */
export const DEFAULT_OCR_LANGUAGES = ['eng', 'fra'];

/** All available languages. */
export const ALL_OCR_LANGUAGES = ['eng', 'fra', 'mal'];
