import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import type { Extension } from '@codemirror/state';

/** Resolve a CodeMirror language extension from an artifact `language` id. */
export function languageExtension(language?: string): Extension {
  switch ((language ?? '').toLowerCase()) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'javascript':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'py':
    case 'python':
      return python();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return [];
  }
}
