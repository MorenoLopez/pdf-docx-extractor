import './style.css';
import { createAbyssBackground } from './components/AbyssBackground';
import { createToastHost } from './components/Toast';
import { extractDocx, type DocxExtractionResult } from './extractors/docx';
import { extractPdf, type PdfExtractionResult } from './extractors/pdf';
import { copyToClipboard } from './utils/clipboard';
import { buildFileName, downloadTextFile } from './utils/download';
import { el } from './utils/dom';
import {
  ExtractionError,
  MAX_FILE_SIZE,
  buildError,
  toExtractionError,
} from './utils/errors';
import { countWords, detectKind } from './utils/files';

type View = 'drop' | 'loading' | 'result' | 'error';

interface ExtractionResult {
  fileName: string;
  text: string;
  markdown: string;
  pages: number | null;
  warnings: string[];
  /** True when the Markdown came from a font-size heuristic, not real structure. */
  markdownIsHeuristic: boolean;
}

/** Full class strings per state: Tailwind scans the source, nothing is computed. */
const DROP_ZONE_STATES: Record<'idle' | 'dragover' | 'error', string> = {
  idle: 'border-white/15 bg-white/[0.04] hover:border-sky-400/70 hover:bg-white/[0.07]',
  dragover:
    'border-sky-400 bg-sky-400/10 ring-4 ring-sky-400/20 scale-[1.01]',
  error: 'border-red-400/70 bg-red-500/10 hover:border-red-400 hover:bg-red-500/15',
};

/** Translucent glass panel, so the abyss stays visible behind it. */
const GLASS_PANEL =
  'border border-white/10 bg-white/[0.06] backdrop-blur-xl shadow-xl shadow-black/20';

const ACCENT_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 backdrop-blur transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:scale-[0.98]';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Élément racine #app introuvable.');

const abyssHost = document.querySelector<HTMLElement>('#abyss');
if (abyssHost) {
  createAbyssBackground({
    container: abyssHost,
    colorScheme: 'deep',
    intensity: 0.45,
    particleCount: 110,
  });
}

// Toasts carry action feedback (download started, copy refused)
const toasts = createToastHost({ surfaceClass: GLASS_PANEL });

const elements = buildStaticUi();
let view: View = 'drop';
let result: ExtractionResult | null = null;
let error: ExtractionError | null = null;
let lastFile: File | null = null;
let runId = 0;
let progressLabel = '';
let copied = false;
let copiedTimer: number | undefined;

function buildStaticUi() {
  app!.replaceChildren(
    el('header', { class: 'border-b border-white/10 bg-slate-950/40 backdrop-blur-xl' }, [
      el('div', { class: 'mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6' }, [
        el('div', { class: 'min-w-0' }, [
          el('h1', {
            class: 'truncate text-lg font-bold tracking-tight text-slate-50 sm:text-xl',
            text: 'Extracteur PDF / DOCX',
          }),
          el('p', {
            class: 'text-xs text-slate-300 sm:text-sm',
            text: '100 % dans votre navigateur - aucun fichier n’est envoyé sur un serveur.',
          }),
        ]),
      ]),
    ]),
    el('main', { class: 'mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-10' }, [
      dropSection(),
      loadingSection(),
      resultSection(),
      errorSection(),
    ]),
    el('footer', { class: 'border-t border-white/10 py-6 text-center text-xs text-slate-400' }, [
      el('p', { text: 'Traitement local dans votre navigateur. Rien n’est stocké ni transmis.' }),
    ]),
  );

  const zone = must<HTMLElement>('[data-dropzone]');
  const input = must<HTMLInputElement>('[data-file-input]');
  const browseButton = must<HTMLButtonElement>('[data-browse]');
  const loadingProgress = must<HTMLElement>('[data-progress]');
  const errorBox = must<HTMLElement>('[data-error-box]');
  const errorText = must<HTMLElement>('[data-error-text]');
  const errorRetry = must<HTMLButtonElement>('[data-error-retry]');
  const errorNew = must<HTMLButtonElement>('[data-error-new]');
  const errorPassword = must<HTMLElement>('[data-error-password]');
  const errorPasswordInput = must<HTMLInputElement>('[data-error-password-input]');
  const noticeBox = must<HTMLElement>('[data-notice]');
  const metaFileName = must<HTMLElement>('[data-meta-filename]');
  const metaStats = must<HTMLElement>('[data-meta-stats]');
  const textarea = must<HTMLTextAreaElement>('[data-output]');
  const copyButton = must<HTMLButtonElement>('[data-copy]');
  const copyLabel = must<HTMLElement>('[data-copy-label]');
  const txtButton = must<HTMLButtonElement>('[data-download-txt]');
  const mdButton = must<HTMLButtonElement>('[data-download-md]');
  const mdNote = must<HTMLElement>('[data-md-note]');
  const resultNew = must<HTMLButtonElement>('[data-result-new]');
  const restartTop = must<HTMLButtonElement>('[data-restart-top]');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      input.click();
    }
  });
  browseButton.addEventListener('click', (event) => {
    event.stopPropagation();
    input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void handleFileSelection(file);
  });

  attachDragAndDrop(zone);
  wireActionButtons({ errorRetry, errorNew, resultNew, restartTop, copyButton, txtButton, mdButton, textarea, errorPassword, errorPasswordInput });

  return {
    zone, input, loadingProgress, errorBox, errorText, errorRetry, errorNew, errorPassword, errorPasswordInput,
    noticeBox, metaFileName, metaStats, textarea, copyButton, copyLabel,
    txtButton, mdButton, mdNote, resultNew, restartTop,
  };
}

function must<T extends Element>(selector: string): T {
  const found = app!.querySelector<T>(selector);
  if (!found) throw new Error(`Élément manquant : ${selector}`);
  return found;
}

function dropSection(): HTMLElement {
  const label = el('span', {
    class: 'text-base font-semibold text-slate-50 sm:text-lg',
    text: 'Déposez votre fichier ici',
  });
  const hint = el('span', {
    class: 'text-sm text-slate-300',
    text: 'ou cliquez pour parcourir - PDF ou DOCX, 50 Mo maximum',
  });

  const zone = el(
    'div',
    {
      'data-dropzone': true,
      role: 'button',
      tabindex: '0',
      'aria-label': 'Déposer un fichier PDF ou DOCX, ou appuyer sur Entrée pour parcourir',
      class: [
        'flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition duration-150 sm:py-20',
        'focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-sky-400',
        DROP_ZONE_STATES.idle,
      ].join(' '),
    },
    [
      uploadIcon(),
      el('span', { class: 'flex flex-col gap-1.5' }, [label, hint]),
      el('button', {
        type: 'button',
        'data-browse': true,
        class: `${SECONDARY_BUTTON} mt-2`,
        text: 'Choisir un fichier',
      }),
      el('input', {
        type: 'file',
        'data-file-input': true,
        accept: '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        class: 'sr-only',
        'aria-hidden': 'true',
        tabindex: '-1',
      }),
    ],
  );

  return el('section', { 'data-view': 'drop', class: 'space-y-4' }, [zone]);
}

function loadingSection(): HTMLElement {
  return el('section', { 'data-view': 'loading', class: 'space-y-4' }, [
    el('div', {
      class: `rounded-2xl ${GLASS_PANEL} p-6 sm:p-8`,
    }, [
      el('div', { class: 'flex items-center gap-3' }, [
        spinner(),
        el('div', { class: 'min-w-0' }, [
          el('p', {
            class: 'text-sm font-semibold text-slate-50',
            text: 'Extraction en cours…',
          }),
          el('p', {
            'data-progress': true,
            class: 'truncate text-sm text-slate-300',
            text: 'Lecture du fichier',
          }),
        ]),
      ]),
      el('div', {
        class: 'mt-5 h-1.5 w-full overflow-hidden rounded-full bg-white/10',
        role: 'progressbar',
        'aria-label': 'Progression de l’extraction',
      }, [el('div', {
        class: 'h-full w-1/3 animate-pulse rounded-full bg-sky-400',
      })]),
      el('button', {
        type: 'button',
        'data-cancel': true,
        class: `${SECONDARY_BUTTON} mt-5 w-full sm:w-auto`,
        text: 'Annuler',
      }),
    ]),
  ]);
}

function resultSection(): HTMLElement {
  return el('section', { 'data-view': 'result', class: 'space-y-4' }, [
    noticeBox(),
    el('div', {
      class: `rounded-2xl ${GLASS_PANEL} p-5 sm:p-6`,
    }, [
      el('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [
        el('div', { class: 'min-w-0 flex-1' }, [
          el('p', {
            'data-meta-filename': true,
            class: 'truncate text-base font-bold text-slate-50 sm:text-lg',
            text: '',
          }),
          el('p', {
            'data-meta-stats': true,
            class: 'mt-1 text-sm text-slate-300',
            text: '',
          }),
        ]),
        el('button', {
          type: 'button',
          'data-result-new': true,
          class: SECONDARY_BUTTON,
          text: 'Nouveau fichier',
        }),
      ]),

      el('textarea', {
        'data-output': true,
        readonly: true,
        spellcheck: 'false',
        'aria-label': 'Texte extrait',
        class: [
          'mt-4 h-72 w-full resize-y rounded-xl border border-white/10 bg-slate-950/60 p-3 font-mono text-sm leading-relaxed text-slate-200 backdrop-blur',
          'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-400',
          'sm:h-96 sm:p-4',
        ].join(' '),
      }),

      el('div', { class: 'mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3' }, [
        el('button', { type: 'button', 'data-copy': true, class: ACCENT_BUTTON }, [
          copyIcon(),
          el('span', { 'data-copy-label': true, text: 'Copier' }),
        ]),
        el('button', {
          type: 'button',
          'data-download-txt': true,
          class: SECONDARY_BUTTON,
          text: 'Télécharger .txt',
        }),
        el('button', {
          type: 'button',
          'data-download-md': true,
          class: SECONDARY_BUTTON,
          text: 'Télécharger .md',
        }),
      ]),

      el('p', {
        'data-md-note': true,
        class: 'mt-4 hidden rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-xs leading-relaxed text-slate-300',
        text: '',
      }),
    ]),

    el('button', {
      type: 'button',
      'data-restart-top': true,
      class: `${SECONDARY_BUTTON} w-full`,
      text: 'Nouveau fichier',
    }),
  ]);
}

function errorSection(): HTMLElement {
  return el('section', { 'data-view': 'error', class: 'space-y-4' }, [
    el('div', {
      'data-error-box': true,
      role: 'alert',
      'aria-live': 'assertive',
      class: 'rounded-2xl border-2 border-red-400/40 bg-red-500/10 p-5 backdrop-blur-xl sm:p-6',
    }, [
      el('div', { class: 'flex items-start gap-3' }, [
        alertIcon(),
        el('div', { class: 'min-w-0 flex-1' }, [
          el('h2', {
            class: 'text-base font-bold text-red-100',
            text: 'Extraction impossible',
          }),
          el('p', {
            'data-error-text': true,
            class: 'mt-1 text-sm leading-relaxed text-red-200',
            text: '',
          }),
        ]),
      ]),
      el('div', { class: 'mt-5 flex flex-col gap-3 sm:flex-row' }, [
        el('button', {
          type: 'button',
          'data-error-retry': true,
          class: `${ACCENT_BUTTON} w-full sm:w-auto`,
          text: 'Réessayer',
        }),
        el('button', {
          type: 'button',
          'data-error-new': true,
          class: `${SECONDARY_BUTTON} w-full sm:w-auto`,
          text: 'Nouveau fichier',
        }),
      ]),
      passwordForm(),
    ]),
  ]);
}

/**
 * Password field, shown only for the two password error codes. A real form so
 * Enter submits without a keydown listener.
 */
function passwordForm(): HTMLElement {
  return el(
    'form',
    {
      'data-error-password': true,
      // Hidden attribute, not a `hidden` class: Tailwind preflight makes it win
      // over the `flex` display utility.
      hidden: true,
      novalidate: true,
      class: 'mt-5 flex flex-col gap-2 border-t border-red-400/20 pt-5',
    },
    [
      el('label', {
        for: 'pdf-password',
        class: 'text-sm font-semibold text-red-100',
        text: 'Mot de passe du fichier',
      }),
      el('input', {
        id: 'pdf-password',
        type: 'password',
        autocomplete: 'current-password',
        'data-error-password-input': true,
        placeholder: 'Mot de passe',
        class:
          'w-full rounded-lg border border-white/15 bg-slate-950/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 backdrop-blur focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-400',
      }),
      el('button', {
        type: 'submit',
        class: `${ACCENT_BUTTON} mt-1 w-full sm:w-auto sm:self-start`,
        text: 'Déverrouiller et extraire',
      }),
    ],
  );
}

function noticeBox(): HTMLElement {
  return el('div', {
    'data-notice': true,
    role: 'status',
    'aria-live': 'polite',
    class: 'hidden rounded-xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm leading-relaxed text-amber-100 backdrop-blur',
  });
}

function spinner(): HTMLElement {
  return el('span', {
    class: 'h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-white/15 border-t-sky-400',
    role: 'status',
    'aria-label': 'Chargement',
  });
}

function uploadIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'h-10 w-10 text-sky-400');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V4.5m0 0L7.5 9M12 4.5 16.5 9M4.5 15v2.25A2.25 2.25 0 006.75 19.5h10.5A2.25 2.25 0 0019.5 17.25V15" />';
  return svg;
}

function copyIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'h-4 w-4');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />';
  return svg;
}

function alertIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'h-6 w-6 shrink-0 text-red-400');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />';
  return svg;
}

function attachDragAndDrop(zone: HTMLElement): void {
  let depth = 0;

  const IDLE = DROP_ZONE_STATES.idle.split(' ');
  const DRAGOVER = DROP_ZONE_STATES.dragover.split(' ');

  const setDragState = (active: boolean) => {
    zone.classList.remove(...(active ? IDLE : DRAGOVER));
    zone.classList.add(...(active ? DRAGOVER : IDLE));
  };

  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (!hasFiles(event)) return;
    depth += 1;
    setDragState(true);
  });

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  zone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragState(false);
  });

  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    setDragState(false);

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      showErrorState(buildError('UNSUPPORTED_FORMAT'));
      return;
    }
    void handleFileSelection(files[0], files.length);
  });

  // Stops the browser from opening the file when it lands outside the zone.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function wireActionButtons(buttons: {
  errorRetry: HTMLButtonElement;
  errorNew: HTMLButtonElement;
  resultNew: HTMLButtonElement;
  restartTop: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  txtButton: HTMLButtonElement;
  mdButton: HTMLButtonElement;
  textarea: HTMLTextAreaElement;
  errorPassword: HTMLElement;
  errorPasswordInput: HTMLInputElement;
}): void {
  const reset = () => resetToDrop();

  buttons.errorNew.addEventListener('click', reset);
  buttons.resultNew.addEventListener('click', reset);
  buttons.restartTop.addEventListener('click', reset);

  buttons.errorRetry.addEventListener('click', () => {
    if (lastFile) {
      const file = lastFile;
      void handleFileSelection(file);
    } else {
      elements.zone.click();
    }
  });

  // Same file, now with the password: retries the extraction instead of
  // asking the user to pick the file again.
  buttons.errorPassword.addEventListener('submit', (event) => {
    event.preventDefault();
    const password = buttons.errorPasswordInput.value;
    if (!lastFile || password.length === 0) return;
    const file = lastFile;
    void handleFileSelection(file, 1, password);
  });

  buttons.copyButton.addEventListener('click', () => void handleCopy());
  buttons.txtButton.addEventListener('click', () => handleDownload('txt'));
  buttons.mdButton.addEventListener('click', () => handleDownload('md'));

  // Stop propagation: a click inside the zone must not reopen the file dialog.
  buttons.textarea.addEventListener('click', (event) => event.stopPropagation());

  const cancel = app!.querySelector<HTMLButtonElement>('[data-cancel]');
  cancel?.addEventListener('click', reset);
}

function resetToDrop(): void {
  window.clearTimeout(copiedTimer);
  view = 'drop';
  result = null;
  error = null;
  lastFile = null;
  progressLabel = '';
  copied = false;
  elements.textarea.value = '';
  render();
  elements.zone.focus();
}

async function handleCopy(): Promise<void> {
  if (!result) return;

  try {
    await copyToClipboard(result.text);
    showCopiedFeedback(true);
  } catch (err) {
    const appError = toExtractionError(err);
    // The clipboard often fails for lack of context: keep the extraction, report
    // it and let the user copy by hand.
    toasts.error(appError.userMessage);
  }
}

function showCopiedFeedback(active: boolean): void {
  window.clearTimeout(copiedTimer);
  copied = active;
  renderCopyButton();

  if (active) {
    copiedTimer = window.setTimeout(() => {
      copied = false;
      renderCopyButton();
    }, 2000);
  }
}

function renderCopyButton(): void {
  elements.copyLabel.textContent = copied ? 'Copié !' : 'Copier';
  elements.copyButton.setAttribute('aria-live', 'polite');
}

function handleDownload(extension: 'txt' | 'md'): void {
  if (!result) return;
  try {
    const content = extension === 'txt' ? result.text : result.markdown;
    const fileName = buildFileName(result.fileName, extension);
    downloadTextFile(fileName, content, extension);
    toasts.success(`Téléchargement de « ${fileName} » lancé.`);
  } catch (err) {
    console.error('[download] échec', err);
    toasts.error('Téléchargement impossible, utilisez « Copier » puis collez le texte ailleurs.');
  }
}

async function handleFileSelection(file: File, totalFiles = 1, password?: string): Promise<void> {
  const warnings: string[] = [];
  if (totalFiles > 1) warnings.push(buildFileWarning(totalFiles));

  view = 'loading';
  error = null;
  result = null;
  copied = false;
  lastFile = file;
  progressLabel = 'Lecture du fichier';
  runId += 1;
  const currentRunId = runId;
  render();

  try {
    validateFile(file);

    const buffer = await file.arrayBuffer();
    const kind = detectKind(file.name);
    if (!kind) throw buildError('UNSUPPORTED_FORMAT');

    progressLabel = 'Extraction en cours…';
    render();

    const extracted: PdfExtractionResult | DocxExtractionResult =
      kind === 'pdf'
        ? await extractPdf(buffer, {
            password,
            onProgress: (current, total) => {
              progressLabel = `Page ${current} / ${total}`;
              elements.loadingProgress.textContent = progressLabel;
            },
          })
        : await extractDocx(buffer, password);

    const text = extracted.text;
    if (text.trim().length === 0) {
      throw kind === 'pdf'
        ? buildError('PDF_NO_TEXT')
        : buildError('DOCX_INVALID', 'Le document ne contient aucun texte exploitable.');
    }

    // Only PDF reports a page count.
    const pages = isPdfResult(extracted) ? extracted.pages : null;

    result = {
      fileName: file.name,
      text,
      markdown: extracted.markdown,
      pages,
      warnings: [...warnings, ...extracted.warnings],
      markdownIsHeuristic: kind === 'pdf',
    };
    view = 'result';
  } catch (err) {
    console.error('[extract] échec', err);
    const appError = toExtractionError(err);
    if (appError.code === 'READ_FAILED' || appError.code === 'UNEXPECTED') {
      // The file may have been moved, edited or deleted while we read it.
      appError.recoverable = lastFile !== null;
    }
    error = appError;
    view = 'error';
  } finally {
    // Drop the loading state on every path, but not after the user cancelled
    // (a newer runId means this run is stale).
    if (runId !== currentRunId) return;
    progressLabel = '';
    render();
  }
}

/** Shows an error without going through an extraction. */
function showErrorState(appError: ExtractionError): void {
  view = 'error';
  error = appError;
  result = null;
  progressLabel = '';
  render();
}

function isPdfResult(
  value: PdfExtractionResult | DocxExtractionResult,
): value is PdfExtractionResult {
  return 'pages' in value;
}

function buildFileWarning(total: number): string {
  return `Plusieurs fichiers déposés (${total}) : seul le premier a été traité.`;
}

function validateFile(file: File): void {
  if (file.size === 0) throw buildError('EMPTY_FILE');
  if (file.size > MAX_FILE_SIZE) throw buildError('FILE_TOO_LARGE');
  if (!detectKind(file.name)) throw buildError('UNSUPPORTED_FORMAT');
}

function render(): void {
  for (const section of app!.querySelectorAll<HTMLElement>('[data-view]')) {
    section.hidden = section.dataset.view !== view;
  }

  if (view === 'result' && result) renderResult();
  if (view === 'error' && error) renderError();

  renderNotice();
}

function renderResult(): void {
  if (!result) return;

  elements.metaFileName.textContent = result.fileName;
  elements.metaFileName.title = result.fileName;

  const parts: string[] = [];
  if (result.pages !== null) {
    parts.push(`${result.pages} page${result.pages > 1 ? 's' : ''}`);
  }
  const words = countWords(result.text);
  parts.push(`${words.toLocaleString('fr-FR')} mot${words > 1 ? 's' : ''}`);
  parts.push(`${result.text.length.toLocaleString('fr-FR')} caractères`);
  elements.metaStats.textContent = parts.join(' · ');

  elements.textarea.value = result.text;
  renderCopyButton();

  if (result.markdownIsHeuristic) {
    elements.mdNote.textContent =
      "Le Markdown téléchargé depuis un PDF est une estimation : les titres sont déduits des tailles de police. Le texte n'est pas restructuré en tableaux.";
    elements.mdNote.classList.remove('hidden');
  } else {
    elements.mdNote.classList.add('hidden');
  }
}

function renderError(): void {
  if (!error) return;
  elements.errorText.textContent = error.userMessage;
  elements.errorBox.classList.toggle('hidden', false);
  must<HTMLElement>('[data-error-retry]').hidden = !error.recoverable;

  // The field stays up between attempts so a wrong password can be corrected.
  const needsPassword = error.code === 'PASSWORD_REQUIRED' || error.code === 'PASSWORD_INCORRECT';
  elements.errorPassword.hidden = !needsPassword;
  if (needsPassword) {
    elements.errorPasswordInput.value = '';
    elements.errorPasswordInput.focus();
  }
}

/**
 * Warnings describe the result on screen (unreadable page, several files,
 * estimated Markdown)
 */
function renderNotice(): void {
  const warnings = view === 'result' && result ? result.warnings : [];

  if (warnings.length === 0) {
    elements.noticeBox.classList.add('hidden');
    elements.noticeBox.textContent = '';
    return;
  }

  elements.noticeBox.textContent = '';
  elements.noticeBox.append(
    el('span', { class: 'font-semibold text-amber-200', text: warnings.length > 1 ? 'Avertissements' : 'Avertissement' }),
    el('span', { text: ` - ${warnings.join(' ')}` }),
  );
  elements.noticeBox.classList.remove('hidden');
}

function reportUnexpected(err: unknown): void {
  console.error('[app] erreur inattendue', err);
  if (view === 'loading') {
    view = 'error';
    error = toExtractionError(err);
    progressLabel = '';
    render();
  }
}

window.addEventListener('unhandledrejection', (event) => {
  reportUnexpected(event.reason);
});

window.addEventListener('error', (event) => {
  reportUnexpected(event.error ?? event.message);
});

render();
