/**
 * Typed application errors. Extractors only ever throw `ExtractionError`:
 * `code` drives logic and logging, `userMessage` is the only text that reaches
 * the screen. No technical wording ever gets displayed.
 */

export type ExtractionErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_INCORRECT'
  | 'ENCRYPTION_UNSUPPORTED'
  | 'PDF_INVALID'
  | 'PDF_NO_TEXT'
  | 'DOCX_INVALID'
  | 'READ_FAILED'
  | 'CLIPBOARD_DENIED'
  | 'UNEXPECTED'
  | 'OCR_FAILED';

/** Largest accepted file: 50 MB. */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** User-facing message per code */
export const MESSAGES: Record<ExtractionErrorCode, string> = {
  UNSUPPORTED_FORMAT: 'Format non pris en charge. Déposez un fichier PDF ou DOCX.',
  EMPTY_FILE: 'Ce fichier est vide, il ne contient aucune donnée.',
  FILE_TOO_LARGE: 'Ce fichier est trop volumineux (50 Mo maximum).',
  PASSWORD_REQUIRED:
    'Ce fichier est protégé par un mot de passe. Saisissez-le pour extraire le texte.',
  PASSWORD_INCORRECT: 'Mot de passe incorrect. Vérifiez la casse et réessayez.',
  ENCRYPTION_UNSUPPORTED:
    'Ce document utilise un chiffrement trop ancien pour être ouvert. Ré-enregistrez-le depuis Word ou LibreOffice.',
  PDF_INVALID: 'Ce fichier PDF est corrompu ou illisible.',
  PDF_NO_TEXT: "Ce PDF semble être un scan, il ne contient pas de texte extractible.",
  DOCX_INVALID:
    "Ce fichier DOCX est illisible. Vérifiez qu'il s'agit bien d'un document Word récent (.docx).",
  READ_FAILED: 'Ce fichier a été modifié ou supprimé pendant sa lecture.',
  CLIPBOARD_DENIED: 'Copie impossible, sélectionnez le texte manuellement.',
  UNEXPECTED: 'Une erreur inattendue est survenue.',
  OCR_FAILED: 'L\'extraction OCR a échoué. Le PDF scanné peut être corrompu ou utilise un format non supporté.',
};

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  readonly userMessage: string;
  /** True when retrying can plausibly help; the UI reads it to show the retry button. */
  recoverable: boolean;

  constructor(
    code: ExtractionErrorCode,
    userMessage: string = MESSAGES[code],
    cause?: unknown,
  ) {
    super(userMessage, cause === undefined ? undefined : { cause });
    this.name = 'ExtractionError';
    this.code = code;
    this.userMessage = userMessage;
    this.recoverable = false;
  }
}

/** Builds an application error, optionally with a dedicated message. */
export function buildError(
  code: ExtractionErrorCode,
  message?: string,
  cause?: unknown,
): ExtractionError {
  return new ExtractionError(code, message ?? MESSAGES[code], cause);
}

/** `true` when `err` is one of our own `ExtractionError`s. */
export function isExtractionError(err: unknown): err is ExtractionError {
  return err instanceof ExtractionError || (err as ExtractionError)?.name === 'ExtractionError';
}

function errorName(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function errorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err ?? '');
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : String(message ?? '');
}

/** Translates a pdf.js exception */
export function translatePdfError(err: unknown): ExtractionError {
  if (isExtractionError(err)) return err;

  const name = errorName(err);
  const message = errorMessage(err);

  switch (name) {
    case 'PasswordException':
      // The extractor refines this into PASSWORD_INCORRECT when it had a password
      // to try; this stays the safe default.
      return buildError('PASSWORD_REQUIRED', undefined, err);
    case 'InvalidPDFException':
    case 'MissingPDFException':
    case 'UnexpectedResponseException':
    case 'UnknownErrorException':
      return buildError('PDF_INVALID', undefined, err);
    default:
      break;
  }

  // Some wrappers give only a message: fall back to matching on the text.
  const haystack = `${name} ${message}`.toLowerCase();
  if (haystack.includes('password')) return buildError('PASSWORD_REQUIRED', undefined, err);
  if (
    haystack.includes('invalid pdf') ||
    haystack.includes('missing pdf') ||
    haystack.includes('corrupt') ||
    haystack.includes('structure')
  ) {
    return buildError('PDF_INVALID', undefined, err);
  }

  return buildError('UNEXPECTED', undefined, err);
}

/** mammoth has untyped errors: a renamed `.txt` or an old `.doc` fails as a plain `Error`. */
export function translateDocxError(err: unknown): ExtractionError {
  if (isExtractionError(err)) return err;
  return buildError('DOCX_INVALID', undefined, err);
}

/** Safety net: any unknown value becomes a generic `ExtractionError`, never a bare `Error`. */
export function toExtractionError(err: unknown): ExtractionError {
  if (isExtractionError(err)) return err;

  // The file itself could not be read (deleted, edited, permission).
  const name = errorName(err);
  if (name === 'NotReadableError' || name === 'NotFoundError') {
    return buildError('READ_FAILED', undefined, err);
  }

  return buildError('UNEXPECTED', undefined, err);
}