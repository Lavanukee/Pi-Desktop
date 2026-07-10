import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { IconCheck, IconCopy } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import type { ArtifactContent } from '../model.ts';
import type { SurfaceProps } from '../registry.ts';
import { streamingUpdateSpec } from './code-append.ts';
import { languageExtension } from './languages.ts';

/** Base viewer theme — styled entirely through --pd-* tokens. */
const codeTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--pd-code-block-bg)',
    color: 'var(--pd-text-primary)',
    fontSize: 'var(--pd-font-size-code)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--pd-font-mono)',
    lineHeight: 'var(--pd-leading-code)',
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--pd-text-ghost)',
    border: 'none',
  },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
});

/** Editable overlay: restore a visible caret + a subtle active-line tint so the
 * raw source reads like an editor, not a static viewer. Applied AFTER codeTheme
 * (later extensions win) only when `editable`. */
const editableTheme = EditorView.theme({
  '.cm-content': { caretColor: 'var(--pd-text-primary)' },
  '.cm-activeLine': { backgroundColor: 'var(--pd-code-active-line, rgba(127,127,127,0.08))' },
});

/** How well-known renderable kinds map to a highlight language when the artifact
 * omits `language` (an html/svg/markdown artifact routed to canvas). */
const RAW_LANGUAGE_BY_KIND: Record<string, string> = {
  html: 'html',
  svg: 'svg',
  markdown: 'markdown',
};

/**
 * Coerce any artifact content into a `code` payload for the RAW source editor,
 * resolving a highlight language from the content language or its kind. Shared by
 * the docked canvas + the standalone `<Canvas>` so both render "raw" identically.
 */
export function rawSourceContent(content: ArtifactContent): ArtifactContent {
  return {
    kind: 'code',
    text: content.text,
    language: content.language ?? RAW_LANGUAGE_BY_KIND[content.kind] ?? content.kind,
  };
}

export interface CodeSurfaceProps extends SurfaceProps {
  /** Allow editing the buffer. Defaults to false → a read-only source viewer. */
  editable?: boolean;
  /** Fired (on user edits only) with the full buffer text; never on streaming
   * appends or programmatic reconciliation. */
  onChange?: (text: string) => void;
  /** Fired on an explicit save (⌘/Ctrl-S) with the full buffer text. */
  onSave?: (text: string) => void;
}

/**
 * Code surface — a CodeMirror 6 viewer with STREAMING APPEND. New text is
 * reconciled as the minimal change over the shared prefix (`streamingUpdateSpec`),
 * so appended deltas never reset scroll or selection. Language comes from
 * `content.language` via the installed `lang-*` packages and is swapped through a
 * Compartment without rebuilding the editor.
 *
 * `editable` promotes it to a live editor: ⌘/Ctrl-S calls `onSave` with the
 * buffer and user edits emit `onChange`. The reconcile effect only fires when the
 * `content.text` PROP changes, so typing never triggers a revert (the prop is
 * unchanged); an external update that equals the buffer is a no-op prefix diff.
 */
export function CodeSurface({
  content,
  onCopy,
  editable = false,
  onChange,
  onSave,
}: CodeSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef<Compartment | null>(null);
  // Latest callbacks read from refs so the mount-once editor never goes stale.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The editor is built once on mount; document/language changes are applied by
  // the dedicated effects below (rebuilding the view per delta would defeat
  // streaming). content.* / editable are intentionally read only for the initial
  // state — the raw↔rendered toggle remounts this surface, so `editable` is fresh
  // per mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langCompartment = new Compartment();
    langRef.current = langCompartment;
    const editExtensions = editable
      ? [
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: (view) => {
                onSaveRef.current?.(view.state.doc.toString());
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // Only user edits (typing/paste/delete carry a userEvent); the
            // streaming/reconcile dispatches below do not, so they don't echo.
            const userEdit = update.transactions.some(
              (tr) => tr.annotation(Transaction.userEvent) !== undefined,
            );
            if (userEdit) onChangeRef.current?.(update.state.doc.toString());
          }),
          editableTheme,
        ]
      : [EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const view = new EditorView({
      state: EditorState.create({
        doc: content.text,
        extensions: [
          lineNumbers(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          langCompartment.of(languageExtension(content.language)),
          codeTheme,
          ...editExtensions,
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const spec = streamingUpdateSpec(view.state, content.text);
    if (spec) view.dispatch(spec);
  }, [content.text]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = langRef.current;
    if (!view || !compartment) return;
    view.dispatch({ effects: compartment.reconfigure(languageExtension(content.language)) });
  }, [content.language]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const handleCopy = (): void => {
    if (onCopy) onCopy(content.text);
    else void navigator.clipboard?.writeText(content.text);
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pd-canvas-code">
      <div className="pd-canvas-code-rail">
        <button
          type="button"
          className="pd-btn pd-btn--ghost pd-icon-btn pd-btn--sm"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={handleCopy}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
      <div ref={hostRef} className="pd-canvas-code-host" />
    </div>
  );
}
