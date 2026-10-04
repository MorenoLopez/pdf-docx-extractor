# PDF / DOCX Extractor

A small, 100% client-side web app that extracts text from PDF or DOCX files, letting you copy it or download it as `.txt` or `.md`.

**No backend.** Files are read in the browser via the File API, processed in memory, and discarded. Nothing is ever sent to a server or stored.

## Usage

1. Drag & drop a `.pdf` or `.docx` file into the dotted area, or click to open the file picker.
2. The extracted text is displayed in a read-only field, along with the filename, number of pages, and word count.
3. **Copy** puts the text on the clipboard, **Download .txt** and **Download .md** save files named after the source (`report.pdf` → `report.txt` / `report.md`).
4. **New file** returns to the home screen.

Accessibility shortcuts: the drop zone is focusable (`Tab`) and can be activated with `Enter` or `Space`.

### Known limitations

- **Text-only PDFs.** No OCR. Scanned PDFs with no extractable text are detected and reported.
- **Markdown from PDFs is an approximation.** Headings are inferred from font sizes, bullets and numbered lists are converted, but tables are not detected. Markdown from **DOCX** is faithful (mammoth + Turndown + GFM).
- **50 MB max** per file.
- Password-protected PDFs open on a password prompt (the user password only, never the owner/permissions password). The password is used in memory by pdf.js and never stored.

## Handled cases

Unsupported formats, multiple files dropped (only the first is processed with a warning), empty file, file too large, password-protected PDF (prompt, then wrong password), corrupted PDF, PDF with no extractable text, unreadable PDF page (extraction continues), unreadable DOCX, clipboard denied, unexpected errors. Non-blocking warnings are shown separately from the result.

## Tech stack

| Item | Choice |
|---|---|
| Build | Vite 6 + strict TypeScript, no framework |
| Styles | Tailwind CSS **v4** via `@tailwindcss/vite` (no `tailwind.config.js`, no PostCSS) |
| Background | Custom 2D Canvas (`src/components/AbyssBackground.ts`), no dependency |
| Notifications | Custom DOM-based toasts (`src/components/Toast.ts`), no dependency |
| PDF | `pdfjs-dist` (ESM worker via `?url`) |
| DOCX | `mammoth` |
| Markdown | `turndown` + `turndown-plugin-gfm` |

`vite.config.ts` sets `base: './'` so the `dist/` folder works as-is on any subpath.

## Notifications

Two distinct channels:

- **Warnings** (amber box, on the result screen): describe the displayed result — unreadable PDF page, multiple files dropped, estimated Markdown. They stay while that result is shown.
- **Toasts** (`src/components/Toast.ts`): ephemeral action feedback — download started, clipboard denied. They appear bottom-right (`z-50`, out of flow) and auto-dismiss.

```ts
const toasts = createToastHost({ surfaceClass: GLASS_PANEL });
toasts.success('Download of "report.txt" started.');
toasts.error('Download failed, use "Copy".');
```

Key details:

- 4s for success, 6s for errors (with a fallback action) — typical 3–5s range.
- Timer is **paused on hover and on focus** (WCAG 2.2.1). A close button allows manual dismissal.
- **Single live region** (`role="status"`, `aria-live="polite"`) for all toasts. Error tone is conveyed by color and label, not a second assertive region (which would compete).
- Above 3 toasts, the oldest is removed — a burst of downloads won't cover the screen.
- Entry/exit only use `translate` if `prefers-reduced-motion` is not set.
- `classList.add`/`remove` handle only **one** token, so entry/exit class sets are spread arrays, never a space-separated string (`add('a b')` throws `InvalidCharacterError`).

## Abyss background

`src/components/AbyssBackground.ts` draws a particle background (glowing points connected by lines, plus ambient glow) on a `<canvas>`. Pure `CanvasRenderingContext2D`.

```ts
createAbyssBackground({
  container: document.getElementById('abyss')!,
  colorScheme: 'deep',   // 'deep' | 'light'
  intensity: 0.45,       // 0 → 1
  particleCount: 110,
});
```

The instance exposes `setColorScheme`, `setIntensity`, `setParticleCount`, and `destroy`. Settings are applied at creation time in `src/main.ts`.

### Implementation notes

- **`<div id="abyss">` is in `index.html`**, not created by JS. It's present before script execution — no white flash on load. `position: fixed; inset: 0; z-index: 0`; `#app` is `relative z-10`.
- **Dark by default.** No `dark:` classes, and `html { color-scheme: dark }` locks the appearance. Surfaces use translucent `GLASS_PANEL` (`src/main.ts`) to let the abyss motion show through. A previous `@custom-variant dark` was removed since no `dark:` classes remained.
- **Cursor listener is on `window`, not the canvas.** The canvas is `pointer-events: none`, so a `mousemove` on it never fires.
- **`prefers-reduced-motion` actually stops the `requestAnimationFrame` loop:** a single static frame is shown, and resuming happens on preference change.
- **Resizing scales particles, doesn't re-randomize:** each particle keeps normalized anchors (`ax`/`ay`) in addition to position.
- **Particle glow uses a cached sprite**, not a `createRadialGradient` per particle per frame.
- **Movement is in px/s** (`SPRING_RATE = 1.2`, `MAX_DELTA_SECONDS = 1/30`): motion is consistent at 30, 60, or 144 Hz.
- **Pair loop uses distance squared** and `MIN_STROKE_ALPHA` threshold to avoid `sqrt` and per-frame state changes.

## Privacy

Everything happens in-tab: `FileReader` / `File.arrayBuffer()` for reading, `pdfjs` and `mammoth` for parsing, `Blob` + `URL.createObjectURL` for downloading. No network calls, no local storage, no cookies.
