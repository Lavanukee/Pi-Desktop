/**
 * The Lexical plain-text editor that lives inside the composer shell. Owns
 * text/selection sync (for autocomplete token detection), Enter-to-submit with
 * Shift+Enter newline, autocomplete keyboard nav, and an imperative API
 * (insert token / clear / focus) exposed to the parent through a ref.
 */
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  INSERT_LINE_BREAK_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { type AcToken, detectToken, EMPTY_TOKEN } from './tokens';

export interface ComposerEditorApi {
  /** Replace the active trigger token (offset within the current text node). */
  insertToken: (tokenStart: number, value: string) => void;
  /** Replace the whole editor content (suggestion chips, templates). */
  setText: (value: string) => void;
  clear: () => void;
  focus: () => void;
}

export interface ComposerKeymap {
  isAcOpen: () => boolean;
  moveSelection: (delta: number) => void;
  /** Accept the highlighted autocomplete item; returns true if one was accepted. */
  acceptAc: () => boolean;
  /** Move the active suggestion (autocomplete closed); returns true if consumed. */
  moveSuggestion: (delta: number) => boolean;
  /** Tab with no autocomplete open: accept the ACTIVE suggestion if any. */
  acceptSuggestion: () => boolean;
  /** Esc with no autocomplete open: dismiss the suggestion overlay if shown. */
  dismissSuggestions: () => boolean;
  close: () => void;
}

interface ComposerEditorProps {
  placeholder: string;
  disabled?: boolean;
  onTextChange: (text: string) => void;
  onTokenChange: (token: AcToken) => void;
  onSubmit: () => void;
  keymap: ComposerKeymap;
  apiRef: MutableRefObject<ComposerEditorApi | null>;
}

function readSync(
  editorState: EditorState,
  onTextChange: (text: string) => void,
  onTokenChange: (token: AcToken) => void,
): void {
  editorState.read(() => {
    onTextChange($getRoot().getTextContent());
    const selection = $getSelection();
    if ($isRangeSelection(selection) && selection.isCollapsed()) {
      const node = selection.anchor.getNode();
      const upTo = $isTextNode(node) ? node.getTextContent().slice(0, selection.anchor.offset) : '';
      onTokenChange(detectToken(upTo));
    } else {
      onTokenChange(EMPTY_TOKEN);
    }
  });
}

/** Wires the imperative API + command handlers to the live editor. */
function EditorBridge(props: Omit<ComposerEditorProps, 'placeholder' | 'disabled'>): null {
  const [editor] = useLexicalComposerContext();
  const cb = useRef(props);
  cb.current = props;

  // Imperative API for the parent (token insertion, clear, focus).
  useEffect(() => {
    props.apiRef.current = {
      insertToken: (tokenStart, value) => {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const node = selection.anchor.getNode();
          if (!$isTextNode(node)) return;
          node.spliceText(tokenStart, selection.anchor.offset - tokenStart, `${value} `, true);
        });
      },
      setText: (value) => {
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          if (value.length > 0) paragraph.append($createTextNode(value));
          root.append(paragraph);
          paragraph.selectEnd();
        });
      },
      clear: () => {
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      },
      focus: () => editor.focus(),
    };
    return () => {
      props.apiRef.current = null;
    };
  }, [editor, props.apiRef]);

  // Keyboard: submit / newline / autocomplete nav. Registered once; reads the
  // latest callbacks through the ref so it never re-subscribes.
  useEffect(() => {
    const unregister = [
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          const { keymap, onSubmit } = cb.current;
          if (keymap.isAcOpen() && keymap.acceptAc()) {
            event?.preventDefault();
            return true;
          }
          if (event?.shiftKey === true) {
            editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
            event.preventDefault();
            return true;
          }
          event?.preventDefault();
          onSubmit();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event: KeyboardEvent) => {
          const { keymap } = cb.current;
          if (keymap.isAcOpen()) {
            keymap.moveSelection(1);
            event.preventDefault();
            return true;
          }
          // Suggestions open (autocomplete closed): navigate the overlay.
          if (keymap.moveSuggestion(1)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event: KeyboardEvent) => {
          const { keymap } = cb.current;
          if (keymap.isAcOpen()) {
            keymap.moveSelection(-1);
            event.preventDefault();
            return true;
          }
          if (keymap.moveSuggestion(-1)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event: KeyboardEvent) => {
          const { keymap } = cb.current;
          const handled = keymap.isAcOpen() ? keymap.acceptAc() : keymap.acceptSuggestion();
          if (handled) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          const { keymap } = cb.current;
          if (keymap.isAcOpen()) {
            keymap.close();
            return true;
          }
          return keymap.dismissSuggestions();
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // OnChangePlugin ignores selection-only updates; re-detect on caret move.
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          readSync(editor.getEditorState(), cb.current.onTextChange, cb.current.onTokenChange);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    ];
    return () => {
      for (const u of unregister) u();
    };
  }, [editor]);

  return null;
}

export function ComposerEditor(props: ComposerEditorProps) {
  const { placeholder, disabled, onTextChange, onTokenChange } = props;
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'pi-composer',
        editable: disabled !== true,
        onError: (error) => {
          console.error('[composer] lexical error', error);
        },
        theme: {},
      }}
    >
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className="pd-composer-input outline-none"
            aria-label="Message input"
            data-testid="composer-input"
          />
        }
        placeholder={
          <div className="pd-composer-placeholder pointer-events-none absolute text-text-muted">
            {placeholder}
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin
        onChange={(editorState) => readSync(editorState, onTextChange, onTokenChange)}
      />
      <EditorBridge {...props} />
    </LexicalComposer>
  );
}
