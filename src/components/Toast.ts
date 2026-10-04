/**
 * Transient toasts for action feedback (download started, clipboard refused),
 * distinct from the persistent in-flow warnings about the extraction itself.
 * A single live region serves every toast; errors are styled, not assertive.
 */

import { el } from '../utils/dom';

export type ToastTone = 'success' | 'error';

export interface ToastHost {
  success(message: string): void;
  error(message: string): void;
  destroy(): void;
}

export interface ToastHostOptions {
  /** Surface classes shared with the rest of the UI, typically `GLASS_PANEL`. */
  surfaceClass?: string;
  /** Display time in ms for a success toast. */
  duration?: number;
  /** Maximum number of stacked toasts. */
  max?: number;
}

const BASE_DURATION = 4000;
/** Errors linger longer because they carry a fallback action. */
const ERROR_BONUS = 2000;
const MAX_TOASTS = 3;
/** Must outlast the CSS transition, otherwise the fade-out gets cut. */
const EXIT_DURATION = 220;

/**
 * Enter/exit class sets, as arrays: `classList` takes one token per argument, so
 * `add('a b')` throws. They are never both present, or Tailwind's cascade order
 * would arbitrarily decide between `translate-y-2` and `translate-y-0`.
 */
const HIDDEN = ['translate-y-2', 'opacity-0', 'motion-reduce:translate-y-0'];
const SHOWN = ['translate-y-0', 'opacity-100'];

/** Tick for success, warning triangle for failure. */
const CHECK_PATH =
  '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />';
const ALERT_PATH =
  '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />';
const CLOSE_PATH = '<path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />';

const TONES: Record<ToastTone, { surface: string; icon: string; path: string }> = {
  success: { surface: 'border-emerald-400/30 bg-emerald-400/10', icon: 'text-emerald-300', path: CHECK_PATH },
  error: { surface: 'border-red-400/40 bg-red-500/10', icon: 'text-red-300', path: ALERT_PATH },
};

export function createToastHost(options: ToastHostOptions = {}): ToastHost {
  const duration = options.duration ?? BASE_DURATION;
  const surfaceClass = options.surfaceClass ?? '';
  const max = Math.max(1, options.max ?? MAX_TOASTS);

  // The container spans the viewport but must never eat a click; only the toasts
  // themselves re-enable pointer events, so their close button stays clickable.
  const container = el('div', {
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false',
    class: [
      'pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2',
      'px-4 pb-4 sm:inset-x-auto sm:items-end sm:px-6 sm:pb-6',
    ].join(' '),
  });
  document.body.append(container);

  /** Live toasts, oldest first. */
  const toasts: Array<{ close: () => void }> = [];

  function push(tone: ToastTone, message: string): void {
    const life = tone === 'error' ? duration + ERROR_BONUS : duration;

    const closeButton = el('button', {
      type: 'button',
      'aria-label': 'Masquer la notification',
      class: [
        '-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-slate-400',
        'transition hover:bg-white/10 hover:text-slate-100',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400',
      ].join(' '),
    }, [icon(CLOSE_PATH, 'size-4', '2')]);

    const node = el('div', {
      class: [
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3',
        'text-sm leading-relaxed shadow-xl shadow-black/20 backdrop-blur-xl',
        'transition-all duration-200 ease-out motion-reduce:transition-none',
        TONES[tone].surface,
        surfaceClass,
        ...HIDDEN,
      ].join(' '),
    }, [
      icon(TONES[tone].path, `size-5 shrink-0 ${TONES[tone].icon}`, '1.8'),
      el('p', { class: 'min-w-0 flex-1 text-slate-100', text: message }),
      closeButton,
    ]);

    // `dismiss` is a hoisted declaration, so `entry.close` can point at it here.
    const entry = { node, timer: 0, resume: 0, deadline: 0, close: dismiss };

    function dismiss(): void {
      const index = toasts.indexOf(entry);
      if (index !== -1) toasts.splice(index, 1);
      window.clearTimeout(entry.timer);
      node.removeEventListener('mouseenter', pause);
      node.removeEventListener('mouseleave', unpause);
      node.removeEventListener('focusin', pause);
      node.removeEventListener('focusout', unpause);
      if (!node.isConnected) return;
      node.classList.remove(...SHOWN);
      node.classList.add(...HIDDEN);
      window.setTimeout(() => node.remove(), EXIT_DURATION);
    }

    // Hover and focus pause the timer, so reading time is never counted.
    function pause(): void {
      window.clearTimeout(entry.timer);
      entry.resume = Math.max(0, entry.deadline - performance.now());
    }

    function unpause(): void {
      window.clearTimeout(entry.timer);
      entry.timer = window.setTimeout(dismiss, entry.resume);
    }

    entry.timer = window.setTimeout(dismiss, life);
    entry.deadline = performance.now() + life;

    closeButton.addEventListener('click', dismiss);
    node.addEventListener('mouseenter', pause);
    node.addEventListener('mouseleave', unpause);
    node.addEventListener('focusin', pause);
    node.addEventListener('focusout', unpause);

    container.append(node);
    // Only flip to the shown classes on the next frame: applied in the same
    // frame, both class sets coexist and no transition ever runs.
    requestAnimationFrame(() => {
      node.classList.remove(...HIDDEN);
      node.classList.add(...SHOWN);
    });

    toasts.push(entry);
    while (toasts.length > max) {
      const oldest = toasts[0];
      oldest?.close();
    }
  }

  return {
    success: (message) => push('success', message),
    error: (message) => push('error', message),
    destroy: () => {
      for (const entry of [...toasts]) entry.close();
      container.remove();
    },
  };
}

function icon(path: string, className: string, strokeWidth: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}