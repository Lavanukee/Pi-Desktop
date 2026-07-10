import type { Story } from '@ladle/react';
import {
  Button,
  Curtain,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProgressBar,
  Spinner,
} from '../index.ts';
import { Story as Frame } from './helpers.tsx';

export const DialogOpen: Story = () => (
  <Frame>
    <div style={{ height: 360 }}>
      <Dialog open modal={false}>
        <DialogContent style={{ position: 'absolute' }}>
          <DialogHeader>
            <div>
              <DialogTitle>Download model?</DialogTitle>
              <DialogDescription>
                Qwen3.6-27B (Q4_K_M) is 16.4 GB. Pi verifies the checksum after download.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody>
            <ProgressBar value={0.42} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Download</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  </Frame>
);

export const CurtainBlocking: Story = () => (
  <Frame>
    <div style={{ position: 'relative', height: 280, overflow: 'hidden' }}>
      <p>Content behind the curtain.</p>
      <Curtain style={{ position: 'absolute' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Spinner size={24} />
          <span>Preparing model…</span>
        </div>
      </Curtain>
    </div>
  </Frame>
);
