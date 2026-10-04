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

/** File type recognised by the application. */
export type FileKind = 'pdf' | 'docx';