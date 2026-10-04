import { buildError } from './errors';


// Copies `text` to the clipboard
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      console.warn('navigator.clipboard.writeText a échoué, repli sur execCommand.', err);
    }
  }

  if (legacyCopy(text)) return;

  throw buildError('CLIPBOARD_DENIED');
}

/** Fallback for old browsers, and whenever the modern API is refused. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  const previouslyFocused = document.activeElement as HTMLElement | null;

  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch (err) {
    console.warn('document.execCommand("copy") a échoué.', err);
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.({ preventScroll: true });
  }
}