import type { Story } from '@ladle/react';
import { AttachmentPill, ComposerAddMenu, FileDropZone } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const noop = () => {};

/**
 * File-input UI (feedback #7): a drop zone with attachment pills, and the
 * composer "+" attach-menu variant (files / screenshot). The active-drag look
 * is forced on the second zone; the menu is forced open for the contact sheet.
 */
export const FileInput: Story = () => (
  <Frame>
    <Row label="drop zone (resting) with attachment pills">
      <div style={{ width: 420 }}>
        <FileDropZone
          onFiles={noop}
          attachments={
            <>
              <AttachmentPill name="pi-bridge.ts" meta="12 KB" onRemove={noop} />
              <AttachmentPill name="screenshot.png" meta="240 KB" onRemove={noop} />
            </>
          }
        />
      </div>
    </Row>
    <Row label="drop zone (drag-active)">
      <div style={{ width: 420 }}>
        <FileDropZone active label="Drop to attach" hint="Release the files" />
      </div>
    </Row>
    <Row label="composer + add-menu (attach variant, forced open)">
      <div style={{ height: 260, display: 'flex', alignItems: 'flex-end' }}>
        <ComposerAddMenu variant="attach" open onAddFiles={noop} onTakeScreenshot={noop} />
      </div>
    </Row>
  </Frame>
);
