import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { DocxExtractionResult } from '../types';
import { buildError, translateDocxError } from '../utils/errors';

export type { DocxExtractionResult };

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
];

/** mammoth HTML -> Markdown: ATX headings, `-` lists, GFM tables. */
function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  service.addRule('paragrapheDeCellule', {
    filter: (node) =>
      node.nodeName === 'P' &&
      (node.parentNode?.nodeName === 'TD' || node.parentNode?.nodeName === 'TH'),
    replacement: (content) => content.replace(/\n+/g, ' ').trim(),
  });

  service.use(gfm);
  return service;
}

function promoteFirstRowToHeader(html: string): string {
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const firstRow = /<tr\b[^>]*>[\s\S]*?<\/tr>/i.exec(table);
    if (!firstRow) return table;

    const row = firstRow[0];
    if (/<th\b/i.test(row)) return table;

    const promoted = row.replace(/<td\b([^>]*)>/gi, '<th$1>').replace(/<\/td>/gi, '</th>');
    return table.replace(row, () => promoted);
  });
}

function tightenListMarkers(markdown: string): string {
  return markdown.replace(/^(\s*)([-*+]|\d+[.)])\s{2,}/gm, '$1$2 ');
}

export async function extractDocx(data: ArrayBuffer): Promise<DocxExtractionResult> {
  let text: string;
  let html: string;

  try {
    const raw = await mammoth.extractRawText({ arrayBuffer: data });
    text = raw.value;

    const converted = await mammoth.convertToHtml({ arrayBuffer: data }, { styleMap: STYLE_MAP });
    html = converted.value;

    for (const message of converted.messages) {
      console.info('[docx] avertissement mammoth', message.message);
    }
  } catch (err) {
    console.error('[docx] extraction impossible', err);
    throw translateDocxError(err);
  }

  if (text.trim().length === 0) {
    throw buildError('DOCX_INVALID', 'Le document ne contient aucun texte exploitable.');
  }

  const warnings: string[] = [];
  let markdown = '';

  try {
    markdown = tightenListMarkers(
      createTurndown()
        .turndown(promoteFirstRowToHeader(html))
        .trim(),
    );
  } catch (err) {
    console.error('[docx] conversion markdown impossible', err);
    markdown = text.trim();
    warnings.push('La conversion Markdown a échoué, seul le texte brut a été conservé.');
  }

  return { text: text.trim(), markdown, warnings };
}
