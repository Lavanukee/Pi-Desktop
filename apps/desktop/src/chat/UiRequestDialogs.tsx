/**
 * Renders pi's blocking extension_ui_request dialogs with the design system.
 *
 * The richer methods — the harness `ask_user` tool's synthetic `askUser` (choice
 * / multi-select / slider / free-text), plus pi's native `select` / `input` /
 * `editor` — render through the design-system QuestionCard, answering via
 * pi:respond-ui. `confirm` stays a plain two-button dialog (QuestionCard has no
 * yes/no mode). Fire-and-forget requests (notify/setStatus/…) never reach here —
 * the router handles them as store mutations. Only the oldest pending dialog is
 * shown.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type QuestionAnswer,
  QuestionCard,
  type QuestionOption,
} from '@pi-desktop/ui';
import { respondUi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';

export function UiRequestDialogs() {
  const request = usePiStore((s) => s.uiRequests[0] ?? null);

  if (request === null) return null;
  const cancel = () => void respondUi(request.id, { cancelled: true });
  const onOpenChange = (open: boolean) => {
    if (!open) cancel();
  };

  // confirm — a plain yes/no dialog (QuestionCard has no confirm mode).
  if (request.method === 'confirm') {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{request.title ?? 'Pi needs your input'}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-text-secondary">{request.message}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void respondUi(request.id, { confirmed: true })}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Everything else → QuestionCard inside the modal shell.
  const card = renderQuestionCard(request, cancel);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>{card}</DialogContent>
    </Dialog>
  );
}

type UiRequest = NonNullable<ReturnType<typeof usePiStore.getState>['uiRequests'][number]>;

function renderQuestionCard(request: UiRequest, onCancel: () => void) {
  const title = request.title ?? 'Pi needs your input';

  // The harness ask_user tool — a rich spec decoded by the event-router. The
  // answer round-trips back as the input's string value (JSON), which the tool
  // parses. multi-select maps to a multiple-choice QuestionCard.
  if (request.method === 'askUser' && request.ask !== undefined) {
    const spec = request.ask;
    const options: QuestionOption[] = (spec.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
      info: o.info,
    }));
    const mode = spec.mode === 'multi' ? 'choice' : spec.mode;
    return (
      <QuestionCard
        data-testid="question-card"
        question={spec.question}
        mode={mode}
        options={options}
        multiple={spec.mode === 'multi'}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        defaultValue={spec.defaultValue}
        placeholder={spec.placeholder}
        submitLabel={spec.submitLabel}
        onSubmit={(answer: QuestionAnswer) =>
          void respondUi(request.id, { value: JSON.stringify(answer) })
        }
        onCancel={onCancel}
      />
    );
  }

  // pi native `select` — a single-choice list.
  if (request.method === 'select') {
    const options: QuestionOption[] = (request.options ?? []).map((o) => ({ value: o, label: o }));
    return (
      <QuestionCard
        data-testid="question-card"
        question={title}
        mode="choice"
        options={options}
        onSubmit={(answer: QuestionAnswer) => {
          const value = answer.mode === 'choice' ? (answer.values[0] ?? '') : '';
          void respondUi(request.id, { value });
        }}
        onCancel={onCancel}
      />
    );
  }

  // pi native `input` / `editor` — free text (editor prefills its contents).
  return (
    <QuestionCard
      data-testid="question-card"
      question={title}
      mode="free"
      placeholder={request.placeholder}
      defaultText={request.method === 'editor' ? (request.prefill ?? '') : ''}
      onSubmit={(answer: QuestionAnswer) => {
        const text = answer.mode === 'free' ? answer.text : '';
        void respondUi(request.id, { value: text });
      }}
      onCancel={onCancel}
    />
  );
}
