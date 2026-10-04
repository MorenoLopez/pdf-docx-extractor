import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfExtractionResult } from '../types';
import { buildError, translatePdfError } from '../utils/errors';

// Under Vite, `?url` gives the worker's public URL (relative, because `base: './'`),
// which is what pdf.js expects. `??=` lets a Node test supply its own path.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PdfExtractionResult };

export interface PdfExtractionOptions {
  /** Fires after each page, to show "page X / N". */
  onProgress?: (current: number, total: number) => void;
  /** User password of an encrypted PDF. Undefined/empty = none supplied yet. */
  password?: string;
}

/** A positioned text fragment, trimmed to the fields we actually use. */
interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

interface TextLine {
  y: number;
  fontSize: number;
  /** Line text once the fragments are merged. */
  text: string;
  /** Index of the paragraph this line belongs to. */
  paragraph: number;
}

/**
 * A rebuilt line, kept *with* its font size - that is what later lets us guess
 * headings. The size rides along with the text because two identical lines can
 * differ in size
 */
interface StyledLine {
  text: string;
  fontSize: number;
}

/** A paragraph: consecutive lines with no clear vertical gap. */
interface TextBlock {
  lines: StyledLine[];
}

interface LaidOutPage {
  lines: TextLine[];
  /** Rebuilt paragraphs, separated by a blank line in the plain text. */
  paragraphs: string[];
  /** Same paragraphs, with font size, for the Markdown conversion. */
  blocks: TextBlock[];
}

/**
 * Rebuilds a PDF's text layer by layer. `getTextContent` guarantees no spatial
 * order: items are grouped by Y to recover lines, then split into paragraphs
 * using the line spacing.
 */
export async function extractPdf(
  data: ArrayBuffer,
  options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
  // An empty password is what makes pdf.js reject an encrypted document; the
  // caller retries with the password the user typed.
  const password = options.password ?? '';

  let pdf: pdfjs.PDFDocumentProxy;
  try {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(data),
      password,
    }).promise;
  } catch (err) {
    // "No password yet" and "that password was wrong" need different wording:
    // the UI shows the field in one case and re-focuses it in the other.
    if (pdfErrorName(err) === 'PasswordException') {
      throw password
        ? buildError('PASSWORD_INCORRECT', undefined, err)
        : buildError('PASSWORD_REQUIRED', undefined, err);
    }
    throw translatePdfError(err);
  }

  const pages = pdf.numPages;
  if (pages === 0) {
    await pdf.destroy().catch(() => undefined);
    throw buildError('PDF_NO_TEXT');
  }

  const warnings: string[] = [];
  const laidOutPages: LaidOutPage[] = [];
  let failedPages = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const laidOut = layoutPage(toPositionedItems(content.items));
        page.cleanup();

        if (laidOut.blocks.some((block) => block.lines.some((line) => line.text.trim().length > 0))) {
          laidOutPages.push(laidOut);
        }
      } catch (err) {
        // One unreadable page must not fail the whole document.
        if (isFatalPdfError(err)) throw translatePdfError(err);
        console.warn(`[pdf] page ${pageNumber} illisible`, err);
        failedPages += 1;
        warnings.push(`La page ${pageNumber} n'a pas pu être lue.`);
      }

      options.onProgress?.(pageNumber, pages);
      // Let the event loop breathe so the UI stays responsive.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  } finally {
    // `finally` so the document is always closed, even on error.
    await pdf.destroy().catch(() => undefined);
  }

  const text = laidOutPages.map((page) => page.paragraphs.join('\n\n')).join('\n\n');

  if (text.trim().length === 0) {
    throw buildError(failedPages > 0 && failedPages === pages ? 'PDF_INVALID' : 'PDF_NO_TEXT');
  }

  return {
    text,
    markdown: buildMarkdown(laidOutPages, warnings),
    pages,
    warnings,
  };
}

function pdfErrorName(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/** Document structure errors are not recoverable page by page. */
function isFatalPdfError(err: unknown): boolean {
  const name = pdfErrorName(err);
  return name === 'PasswordException' || name === 'InvalidPDFException';
}

function toPositionedItems(items: unknown[]): PositionedItem[] {
  const result: PositionedItem[] = [];

  for (const raw of items) {
    const item = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
    if (typeof item.str !== 'string' || item.str.trim().length === 0) continue;

    const transform = Array.isArray(item.transform) ? (item.transform as number[]) : [];
    // transform = [a, b, c, d, e, f]: e = x, f = y, d is the vertical scale.
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const height = typeof item.height === 'number' ? item.height : 0;
    const fontSize = Math.abs(transform[3] ?? 0) || Math.abs(height) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    result.push({
      str: item.str,
      x,
      y,
      width: typeof item.width === 'number' ? item.width : 0,
      fontSize: fontSize > 0 ? fontSize : 10,
    });
  }

  return result;
}

function groupIntoLines(items: PositionedItem[]): Array<Omit<TextLine, 'paragraph'>> {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; fontSize: number; items: PositionedItem[] }> = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];

    if (current) {
      // Tolerance scales with font size: fragments of one visual line can differ
      // by a few points depending on the font.
      const tolerance = Math.max(current.fontSize, item.fontSize) * 0.5;
      if (Math.abs(current.y - item.y) <= tolerance) {
        current.items.push(item);
        current.fontSize = Math.max(current.fontSize, item.fontSize);
        continue;
      }
    }

    lines.push({ y: item.y, fontSize: item.fontSize, items: [item] });
  }

  return lines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    return { y: line.y, fontSize: line.fontSize, text: renderLine(line.items) };
  });
}

/** Median "normal" line spacing, the reference for spotting new paragraphs. */
function medianLineSpacing(lines: Array<{ y: number }>): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function layoutPage(items: PositionedItem[]): LaidOutPage {
  const grouped = groupIntoLines(items);
  const normalSpacing = medianLineSpacing(grouped);

  const lines: TextLine[] = [];
  const blocks: TextBlock[] = [];
  let buffer: StyledLine[] = [];
  let paragraph = 0;

  const flush = () => {
    // A hyphenation dash has no size of its own, so the re-joined line keeps the
    // largest of the two and the pre-join copy is the one whose size means something.
    const linesOnly = joinStyledLines(buffer);
    if (linesOnly.length > 0) blocks.push({ lines: linesOnly });
    buffer = [];
    paragraph += 1;
  };

  for (let i = 0; i < grouped.length; i += 1) {
    const line = grouped[i];
    lines.push({ ...line, paragraph });

    // Blank line (pdf.js filler) or non-text item: skip.
    if (line.text.trim().length === 0) continue;

    buffer.push({ text: line.text, fontSize: line.fontSize });

    if (i === grouped.length - 1) break;

    // A spacing clearly above normal marks a new paragraph.
    const spacing = grouped[i].y - grouped[i + 1].y;
    const threshold = Math.max(normalSpacing * 1.6, line.fontSize * 1.2);
    if (spacing > threshold) flush();
  }

  flush();

  const paragraphs = blocks.map((block) => block.lines.map((line) => line.text).join('\n'));

  return { lines, paragraphs, blocks };
}

/** Joins a line's fragments, inserting a space only when the gap warrants it. */
function renderLine(items: PositionedItem[]): string {
  let text = '';
  let previous: PositionedItem | null = null;

  for (const item of items) {
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const spaceWidth = Math.max(previous.fontSize * 0.25, 1);
      // Under the threshold the two fragments continue the same word.
      if (gap > spaceWidth * 0.3) text += ' ';
    }

    text += item.str;
    previous = item;
  }

  return text.replace(/\s+$/, '');
}

/**
 * Rejoins words cut by a trailing hyphen, leaving every other line break alone.
 * The re-joined line inherits the larger font size: a hyphenation dash has none.
 */
function joinStyledLines(lines: StyledLine[]): StyledLine[] {
  const result: StyledLine[] = [];

  for (const line of lines) {
    const previous = result[result.length - 1];

    if (previous && /[\u2010\u2011\u2012-]$/.test(previous.text)) {
      result[result.length - 1] = {
        text: `${previous.text.slice(0, -1)}${line.text.trimStart()}`,
        fontSize: Math.max(previous.fontSize, line.fontSize),
      };
      continue;
    }

    result.push({ ...line });
  }

  return result
    .map((line) => ({ ...line, text: line.text.trim() }))
    .filter((line) => line.text.length > 0);
}

const BULLET_RE = /^\s*[•‣▪·*+\u2013\u2014-]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const FONT_SIZE_QUANTUM = 0.5;

function quantize(size: number): number {
  return Math.round(size / FONT_SIZE_QUANTUM) * FONT_SIZE_QUANTUM;
}

/**
 * Most frequent font size = the document's body size. Each size is weighted by
 * how many characters are rendered at it, so body text outvotes a heading and
 * the title of a short document cannot win by being unique.
 */
function bodyFontSize(pages: LaidOutPage[]): number {
  const weights = new Map<number, number>();

  for (const page of pages) {
    for (const line of page.lines) {
      const text = line.text.trim();
      if (text.length === 0) continue;
      const key = quantize(line.fontSize);
      weights.set(key, (weights.get(key) ?? 0) + text.length);
    }
  }

  let bestKey = 10;
  let bestWeight = 0;
  for (const [key, weight] of weights) {
    // On a tie, keep the smaller size (body rather than heading).
    if (weight > bestWeight || (weight === bestWeight && key < bestKey)) {
      bestKey = key;
      bestWeight = weight;
    }
  }

  return bestWeight > 0 ? bestKey : 10;
}

/**
 * Maps each heading font size to a heading level. Ratio thresholds fail on real
 * documents - an 18 pt title and a 16 pt section over 12 pt body have similar
 * ratios yet are distinct levels - so the sizes actually present are ranked
 * largest first. @returns quantised size -> level 1..3, empty if no heading.
 */
function rankHeadingSizes(pages: LaidOutPage[], bodySize: number): Map<number, number> {
  /** Below this ratio the difference is just anti-aliasing. */
  const MIN_HEADING_RATIO = 1.15;
  /** Headings never go past 3 levels (`###`). */
  const MAX_HEADING_LEVEL = 3;

  const sizes = new Set<number>();
  for (const page of pages) {
    for (const line of page.lines) {
      const size = quantize(line.fontSize);
      if (line.text.trim().length > 0 && size >= bodySize * MIN_HEADING_RATIO) {
        sizes.add(size);
      }
    }
  }

  const levels = new Map<number, number>();
  // Largest first, so the largest becomes `#`.
  const sorted = [...sizes].sort((a, b) => b - a);
  sorted.forEach((size, index) => {
    if (index < MAX_HEADING_LEVEL) levels.set(size, index + 1);
  });

  return levels;
}

function buildMarkdown(pages: LaidOutPage[], warnings: string[]): string {
  const bodySize = bodyFontSize(pages);
  const headingLevels = rankHeadingSizes(pages, bodySize);
  const blocks = pages.map((page) => convertPageToMarkdown(page, headingLevels));

  let markdown = blocks.filter((block) => block.length > 0).join('\n\n');
  if (warnings.length > 0) {
    // HTML comment: invisible when rendered, still present in the file.
    markdown = `${markdown}\n\n<!-- ${warnings.join(' ')} -->`;
  }
  return markdown;
}

/** Converts one page to Markdown blocks. @param headingLevels `rankHeadingSizes` output. */
function convertPageToMarkdown(page: LaidOutPage, headingLevels: Map<number, number>): string {
  const blocks: string[] = [];

  for (const block of page.blocks) {
    const outLines: string[] = [];

    for (const { text, fontSize } of block.lines) {
      const line = text.trim();
      if (line.length === 0) continue;

      // The level comes from the document-wide ranking in `headingLevels`, not from
      // a ratio computed here.
      const level = headingLevels.get(quantize(fontSize));
      if (level !== undefined) {
        outLines.push(`${'#'.repeat(level)} ${stripLeadingBullet(line)}`);
        continue;
      }

      const numbered = line.match(NUMBERED_RE);
      if (numbered) {
        outLines.push(`${numbered[1]}. ${numbered[2]}`);
        continue;
      }

      const bulleted = line.match(BULLET_RE);
      if (bulleted) {
        outLines.push(`- ${bulleted[1]}`);
        continue;
      }

      outLines.push(line);
    }

    if (outLines.length > 0) blocks.push(outLines.join('\n'));
  }

  return blocks.join('\n\n');
}

function stripLeadingBullet(line: string): string {
  return line.replace(BULLET_RE, '$1').replace(NUMBERED_RE, '$2').trim();
}
