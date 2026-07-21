/**
 * Power-user "advanced parameters" panel (the brain/gear entry). Two things:
 *
 *   1. GROUND TRUTH (read-only) — the exact system prompt + tool defs + message
 *      list the pi child last sent to llama-server, pushed out of the child by
 *      its provider hook (see {@link useGroundTruth}). This is what the model
 *      actually reads, not a reconstruction.
 *   2. KNOBS — sampling params applied to the NEXT request (no relaunch) and
 *      reasoning params applied on the next server relaunch. Persisted to
 *      settings.json via the advanced store; a fresh install is byte-identical
 *      until a control is touched.
 *
 * Rendered only for power users (userMode === 'power'); the trigger icon lives
 * in the chat top bar (see ChatApp).
 */
import { Button, Dialog, DialogContent, SegmentedControl, Slider } from '@pi-desktop/ui';
import { type ReactNode, useState } from 'react';
import { DEFAULT_ADVANCED } from '../../electron/settings/settings-contract';
import { useGroundTruth } from '../state/advanced-store';
import { setAdvanced, useAdvancedSettings } from '../state/settings-store';

/** A labeled slider row with a live numeric readout on the right. */
function ParamSlider(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}): ReactNode {
  const { label, hint, value, min, max, step, format, onChange } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body text-text-primary">{label}</span>
        <span className="text-caption tabular-nums text-text-muted">
          {format ? format(value) : String(value)}
        </span>
      </div>
      {hint !== undefined ? <span className="text-footnote text-text-muted">{hint}</span> : null}
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onValueChange={onChange}
      />
    </div>
  );
}

/** Section header + a small "Reset" affordance. */
function SectionHead({
  title,
  sub,
  onReset,
}: {
  title: string;
  sub?: string;
  onReset?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <h3 className="text-heading text-text-primary">{title}</h3>
        {sub !== undefined ? <p className="mt-0.5 text-footnote text-text-muted">{sub}</p> : null}
      </div>
      {onReset !== undefined ? (
        <Button variant="ghost" className="pd-btn--sm shrink-0" onClick={onReset}>
          Reset
        </Button>
      ) : null}
    </div>
  );
}

/** The read-only "what the model actually got" view. */
function GroundTruthView(): ReactNode {
  const gt = useGroundTruth();
  const [tab, setTab] = useState<'prompt' | 'tools' | 'raw'>('prompt');
  if (gt === null) {
    return (
      <p className="rounded-xl border border-dashed border-border-default bg-bg-raised px-4 py-6 text-center text-footnote text-text-muted">
        Send a message — the exact system prompt, tool definitions, and context the model receives
        will appear here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        aria-label="Ground-truth view"
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        options={[
          { value: 'prompt', label: 'System prompt' },
          { value: 'tools', label: `Tools (${gt.tools.length})` },
          { value: 'raw', label: 'Raw context' },
        ]}
      />
      {tab === 'prompt' ? (
        <pre className="max-h-[36vh] overflow-auto whitespace-pre-wrap rounded-xl border border-border-default bg-bg-sunken p-3 text-caption text-text-primary">
          {gt.systemPrompt || '(empty system prompt)'}
        </pre>
      ) : null}
      {tab === 'tools' ? (
        <div className="max-h-[36vh] overflow-auto rounded-xl border border-border-default bg-bg-sunken p-3">
          {gt.tools.length === 0 ? (
            <p className="text-caption text-text-muted">No tools were sent this turn.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {gt.tools.map((t) => (
                <li key={t.name} className="text-caption">
                  <span className="font-mono text-text-primary">{t.name}</span>
                  {t.description ? (
                    <span className="text-text-muted"> — {t.description}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {tab === 'raw' ? (
        <pre className="max-h-[36vh] overflow-auto whitespace-pre-wrap rounded-xl border border-border-default bg-bg-sunken p-3 text-caption text-text-primary">
          {JSON.stringify({ model: gt.model, messages: gt.messages, tools: gt.tools }, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function AdvancedParamsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const adv = useAdvancedSettings();
  const s = adv.sampling;
  const r = adv.reasoning;

  const patchSampling = (p: Partial<typeof s>): void =>
    void setAdvanced({ sampling: { ...s, ...p } });
  const patchReasoning = (p: Partial<typeof r>): void =>
    void setAdvanced({ reasoning: { ...r, ...p } });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="Advanced parameters"
        className="pd-adv-panel"
        style={{ width: 'min(560px, 92vw)', maxWidth: '92vw' }}
      >
        <header className="mb-4">
          <h2 className="text-title text-text-primary">Advanced parameters</h2>
          <p className="mt-1 text-footnote text-text-muted">
            Power-user knobs and the live context sent to the local model.
          </p>
        </header>

        <div className="flex flex-col gap-7 overflow-y-auto pr-1" style={{ maxHeight: '70vh' }}>
          {/* GROUND TRUTH ---------------------------------------------------- */}
          <section className="flex flex-col gap-3">
            <SectionHead
              title="Live context"
              sub="Ground truth — the exact prompt, tools, and messages of the most recent turn."
            />
            <GroundTruthView />
          </section>

          {/* SAMPLING (per-request) ----------------------------------------- */}
          <section className="flex flex-col gap-4">
            <SectionHead
              title="Sampling"
              sub="Applied to the next request — no restart. Sent with every subsequent turn."
              onReset={() => patchSampling(DEFAULT_ADVANCED.sampling)}
            />
            <ParamSlider
              label="Temperature"
              value={s.temperature}
              min={0}
              max={2}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(v) => patchSampling({ temperature: v })}
            />
            <ParamSlider
              label="Top P"
              value={s.topP}
              min={0}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
              onChange={(v) => patchSampling({ topP: v })}
            />
            <ParamSlider
              label="Top K"
              value={s.topK}
              min={0}
              max={200}
              step={1}
              format={(v) => (v === 0 ? 'Off' : String(v))}
              onChange={(v) => patchSampling({ topK: v })}
            />
            <ParamSlider
              label="Min P"
              value={s.minP}
              min={0}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
              onChange={(v) => patchSampling({ minP: v })}
            />
            <ParamSlider
              label="Repetition penalty"
              hint="1.00 = off. DRY handles anti-looping; a flat penalty here hurts code."
              value={s.repetitionPenalty}
              min={0.8}
              max={1.5}
              step={0.01}
              format={(v) => (v === 1 ? 'Off (1.00)' : v.toFixed(2))}
              onChange={(v) => patchSampling({ repetitionPenalty: v })}
            />
            <ParamSlider
              label="Presence penalty"
              value={s.presencePenalty}
              min={-2}
              max={2}
              step={0.1}
              format={(v) => v.toFixed(1)}
              onChange={(v) => patchSampling({ presencePenalty: v })}
            />
            <ParamSlider
              label="Max tokens"
              hint="Per-request output cap. 0 = model default."
              value={s.maxTokens}
              min={0}
              max={32768}
              step={256}
              format={(v) => (v === 0 ? 'Model default' : String(v))}
              onChange={(v) => patchSampling({ maxTokens: v })}
            />
          </section>

          {/* REASONING (launch-time) ---------------------------------------- */}
          <section className="flex flex-col gap-4">
            <SectionHead
              title="Reasoning"
              sub="Thinking controls — applied on the next server relaunch."
              onReset={() => patchReasoning(DEFAULT_ADVANCED.reasoning)}
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-body text-text-primary">Preserve thinking</span>
                <span className="text-footnote text-text-muted">
                  Keep &lt;think&gt; across the whole history, not just the last turn.
                </span>
              </div>
              <SegmentedControl
                aria-label="Preserve thinking"
                value={r.preserve ? 'on' : 'off'}
                onValueChange={(v) => patchReasoning({ preserve: v === 'on' })}
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </div>
            <ParamSlider
              label="Reasoning budget"
              hint="Token cap on thinking. -1 = unrestricted; 0 = no thinking."
              value={r.budget}
              min={-1}
              max={8192}
              step={128}
              format={(v) => (v === -1 ? 'Unrestricted' : v === 0 ? 'Off' : `${v} tokens`)}
              onChange={(v) => patchReasoning({ budget: v })}
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-body text-text-primary">Budget-reached message</span>
              <span className="text-footnote text-text-muted">
                Injected before the end-of-thinking tag when the budget runs out.
              </span>
              <input
                type="text"
                className="rounded-lg border border-border-default bg-bg-sunken px-3 py-2 text-body text-text-primary outline-none focus:border-border-strong"
                value={r.budgetMessage}
                onChange={(e) => patchReasoning({ budgetMessage: e.target.value })}
              />
            </label>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
