/**
 * Renders pi's blocking extension_ui_request dialogs (confirm / select / input
 * / editor) with the design-system Dialog, answering via pi:respond-ui.
 * Fire-and-forget requests (notify/setStatus/…) never reach here — the router
 * handles them as store mutations. Only the oldest pending dialog is shown.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SidebarRow,
  TextArea,
} from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { respondUi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';

export function UiRequestDialogs() {
  const request = usePiStore((s) => s.uiRequests[0] ?? null);
  const [draft, setDraft] = useState('');

  // Reset the draft whenever a new dialog surfaces (prefill for editor/input).
  // biome-ignore lint/correctness/useExhaustiveDependencies: request.id triggers the reset on a new dialog
  useEffect(() => {
    setDraft(request?.prefill ?? '');
  }, [request?.id, request?.prefill]);

  if (request === null) return null;
  const cancel = () => void respondUi(request.id, { cancelled: true });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.title ?? 'Pi needs your input'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {request.method === 'confirm' ? (
            <p className="text-text-secondary">{request.message}</p>
          ) : null}

          {request.method === 'select' ? (
            <div className="flex flex-col gap-1">
              {(request.options ?? []).map((option) => (
                <SidebarRow
                  key={option}
                  label={option}
                  onClick={() => void respondUi(request.id, { value: option })}
                />
              ))}
            </div>
          ) : null}

          {request.method === 'input' ? (
            <Input
              autoFocus
              placeholder={request.placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void respondUi(request.id, { value: draft });
              }}
            />
          ) : null}

          {request.method === 'editor' ? (
            <TextArea
              autoFocus
              autoGrow
              rows={6}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : null}
        </DialogBody>

        {request.method !== 'select' ? (
          <DialogFooter>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            {request.method === 'confirm' ? (
              <Button
                variant="primary"
                onClick={() => void respondUi(request.id, { confirmed: true })}
              >
                Confirm
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void respondUi(request.id, { value: draft })}
              >
                Submit
              </Button>
            )}
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
