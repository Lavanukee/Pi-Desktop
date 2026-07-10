import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { IconCheck, IconCopy } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import type { SurfaceProps } from '../registry.ts';
import { streamingUpdateSpec } from './code-append.ts';
import { languageExtension } from './languages.ts';

/** Read-only viewer theme — styled entirely through --pd-* tokens. */
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

/**
 * Code surface — a read-only CodeMirror 6 viewer with STREAMING APPEND. New
 * text is reconciled as the minimal change over the shared prefix
 * (`streamingUpdateSpec`), so appended deltas never reset scroll or selection.
 * Language comes from `content.language` via the installed `lang-*` packages and
 * is swapped through a Compartment without rebuilding the editor.
 */
export function CodeSurface({ content, onCopy }: SurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef<Compartment | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The editor is built once on mount; document/language changes are applied by
  // the dedicated effects below (rebuilding the view per delta would defeat
  // streaming). content.* is intentionally read only for the initial state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langCompartment = new Compartment();
    langRef.current = langCompartment;
    const view = new EditorView({
      state: EditorState.create({
        doc: content.text,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          langCompartment.of(languageExtension(content.language)),
          codeTheme,
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
