import { clsx } from 'clsx';
import type { DragEvent, HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useRef, useState } from 'react';
import { IconPaperclip } from './icons.tsx';

/*
 * File-input UI (jedd round-1 feedback #7). A drop zone + click-to-browse that
 * hosts a row of AttachmentPill for already-added files. Functional (real drag
 * + hidden picker) but layout-only — the host decides what to do with files.
 */

export interface FileDropZoneProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onDrop'> {
  /** Files chosen via drop or the picker. */
  onFiles?: (files: File[]) => void;
  label?: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  /** `accept` for the underlying file input. */
  accept?: string;
  multiple?: boolean;
  /** Attachment pills (compose <AttachmentPill/>) rendered under the zone. */
  attachments?: ReactNode;
  /** Force the drag-active look (galleries/screenshots). */
  active?: boolean;
}

export const FileDropZone = forwardRef<HTMLDivElement, FileDropZoneProps>(function FileDropZone(
  {
    onFiles,
    label = 'Drag files or photos here',
    hint = 'or click to browse',
    icon = <IconPaperclip size={20} />,
    accept,
    multiple = true,
    attachments,
    active = false,
    className,
    ...rest
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const emit = (list: FileList | null) => {
    if (list && list.length > 0) onFiles?.(Array.from(list));
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    emit(event.dataTransfer.files);
  };

  const onDragOver = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!dragging) setDragging(true);
  };

  return (
    <div ref={ref} className={clsx('pd-dropzone-wrap', className)} {...rest}>
      <button
        type="button"
        className={clsx('pd-dropzone', (dragging || active) && 'pd-dropzone--active')}
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={() => setDragging(false)}
      >
        <span className="pd-dropzone-icon">{icon}</span>
        <span className="pd-dropzone-label">{label}</span>
        {hint !== undefined ? <span className="pd-dropzone-hint">{hint}</span> : null}
      </button>
      {attachments !== undefined ? <div className="pd-dropzone-files">{attachments}</div> : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="pd-visually-hidden"
        onChange={(event) => {
          emit(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
});
