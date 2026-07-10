/**
 * Top-bar chat title (round-5 #13). Sits just RIGHT of the left sidebar (not
 * centered). At rest it shows the chat name; on HOVER it reveals a breadcrumb
 * "<project> / <chat name>" (project is "" for now — the structure is wired so
 * a real project label slots straight in). CLICKING the title flips it into an
 * inline rename field that persists the session name (pi:set-session-name via
 * the RPC) on Enter/blur; Escape cancels.
 */
import { useEffect, useRef, useState } from 'react';

export function ChatTitle({
  title,
  project = '',
  onRename,
}: {
  title: string;
  /** Owning project label; "" until projects ship (breadcrumb prefix hidden). */
  project?: string;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const start = () => {
    setDraft(title);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next.length > 0 && next !== title) onRename(next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="pd-chat-title-input pd-focusable [-webkit-app-region:no-drag]"
        data-testid="chat-title-input"
        aria-label="Rename chat"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="pd-chat-title pd-focusable [-webkit-app-region:no-drag]"
      data-testid="chat-title"
      title="Rename chat"
      onClick={start}
    >
      {project.length > 0 ? (
        <span className="pd-chat-title-crumb" aria-hidden>
          <span className="pd-chat-title-project">{project}</span>
          <span className="pd-chat-title-sep">/</span>
        </span>
      ) : null}
      <span className="pd-chat-title-name">{title}</span>
    </button>
  );
}
