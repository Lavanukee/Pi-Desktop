import type { Story } from '@ladle/react';
import { Button, Toast, ToastProvider, ToastViewport } from '../index.ts';
import { Story as Frame } from './helpers.tsx';

export const Toasts: Story = () => (
  <Frame>
    <div style={{ position: 'relative', height: 320 }}>
      <ToastProvider duration={Number.POSITIVE_INFINITY}>
        <Toast open title="Model ready" description="Qwen3.6-27B loaded in 3.2s." tone="success" />
        <Toast
          open
          title="Context almost full"
          description="82% of the window used."
          tone="warning"
        />
        <Toast
          open
          tone="danger"
          title="Download failed"
          description="Checksum mismatch — retrying."
          action={
            <Button size="sm" variant="outline">
              Retry
            </Button>
          }
        />
        <Toast open title="Copied to clipboard" showClose={false} />
        <ToastViewport style={{ position: 'absolute' }} />
      </ToastProvider>
    </div>
  </Frame>
);
