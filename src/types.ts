/** Types shared by the extractors and the UI. */

/** The neutral result (DOCX). */
export interface ExtractionResult {
  /** Rebuilt text, used for the `.txt` export and the preview. */
  text: string;
  /** Markdown, used for the `.md` export. */
  markdown: string;
  /** Non-blocking warnings (unreadable page, etc.). */
  warnings: string[];
}

/** A DOCX result: nothing beyond the neutral one. */
export type DocxExtractionResult = ExtractionResult;

/** A PDF result: the neutral one plus a page count. */
export interface PdfExtractionResult extends ExtractionResult {
  pages: number;
}

/** OCR extraction result: extends the base result with OCR metadata. */
export interface OcrExtractionResult extends ExtractionResult {
  /** True when OCR was used instead of direct text extraction. */
  ocrUsed: true;
  /** Languages used for OCR. */
  ocrLanguages: string[];
}

/** File type recognised by the application. */
export type FileKind = 'pdf' | 'docx';