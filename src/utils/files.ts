/** Accepted extensions, dot included. */
const PDF_EXTENSION = '.pdf';
const DOCX_EXTENSION = '.docx';

/** Lowercased extension, dot included (`.pdf`), or an empty string. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return '';
  return fileName.slice(dot).toLowerCase();
}

/**
 * The extension is authoritative: it picks the extractor, and it always yields a
 * relevant error - a `notes.txt` renamed to `notes.pdf` is treated as a PDF and
 * reported as "corrupt or unreadable", which beats "unsupported format". MIME
 * type would be a better hint but browsers report it as empty or made up, so
 * trusting it would reject perfectly valid files.
 * @returns `'pdf'`, `'docx'`, or `null` when the extension is not accepted.
 */
export function detectKind(fileName: string): 'pdf' | 'docx' | null {
  const extension = extensionOf(fileName);
  if (extension === PDF_EXTENSION) return 'pdf';
  if (extension === DOCX_EXTENSION) return 'docx';
  return null;
}

/** `report.pdf` -> `report.txt` / `report.md`. Names without an extension are kept as-is. */
export function replaceExtension(fileName: string, newExtension: '.txt' | '.md'): string {
  const extension = extensionOf(fileName);
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${base || 'extrait'}${newExtension}`;
}

/** Word count: sequences separated by spaces or line breaks. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).filter(Boolean).length;
}