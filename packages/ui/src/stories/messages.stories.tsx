import type { Story } from '@ladle/react';
import { useState } from 'react';
import {
  BranchSwitcher,
  DropdownMenuItem,
  DropdownMenuSeparator,
  EditableMessage,
  MessageActions,
  MessageFootnote,
  MessageRow,
  ModelFootnote,
  Prose,
  ResponseSpeed,
  Thread,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const noop = () => {};

/**
 * Reworked user bubble (feedback #5) + under-message action bar & footnotes
 * (feedback #6). The bubble is a right-aligned subtle pill in both flavors;
 * assistant messages carry a hover-revealed action bar and speed/model
 * footnotes.
 */
export const MessagesReworked: Story = () => (
  <div style={{ padding: '24px 0' }}>
    <Thread>
      <MessageRow
        kind="user"
        actions={<MessageActions onCopy={noop} onEdit={noop} tokenCount={42} />}
      >
        What local model should I run on a 24GB MacBook for coding?
      </MessageRow>
      <MessageRow
        kind="assistant"
        actions={
          <MessageActions
            onCopy={noop}
            onThumbsUp={noop}
            onThumbsDown={noop}
            onRetry={noop}
            onShare={noop}
            tokenCount={1240}
            onContext={noop}
            overflow={
              <>
                <DropdownMenuItem>Copy markdown</DropdownMenuItem>
                <DropdownMenuItem>Report response</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger>Delete message</DropdownMenuItem>
              </>
            }
          />
        }
      >
        <Prose>
          <p>
            For 24GB of unified memory, <strong>Qwen3.6-27B at Q4_K_M</strong> is the sweet spot —
            about 16.4GB, leaving headroom for a <code>32k</code> context window.
          </p>
        </Prose>
        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          <ResponseSpeed tokensPerSecond={180} />
          <ModelFootnote model="Qwen3.6 27B · Q4_K_M" />
        </div>
      </MessageRow>
      <MessageRow kind="user">Sounds good — set it up.</MessageRow>
    </Thread>
  </div>
);

/**
 * Inline message edit (round-3 #P3): clicking Edit flips the user bubble into an
 * editable textarea with Save/Cancel — shown here both resting and mid-edit.
 */
export const InlineEdit: Story = () => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('What local model should I run on a 24GB MacBook for coding?');
  return (
    <div style={{ padding: '24px 0' }}>
      <Thread>
        <MessageRow
          kind="user"
          actions={<MessageActions onCopy={noop} onEdit={() => setEditing(true)} />}
        >
          {text}
        </MessageRow>
        <EditableMessage
          value={text}
          editing={editing}
          onSave={(next) => {
            setText(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
        {!editing ? (
          <p style={{ color: 'var(--pd-text-muted)', fontSize: 13 }}>
            Click Edit above to flip the second bubble into its editor.
          </p>
        ) : null}
      </Thread>
    </div>
  );
};

/** Static snapshot of the editor open (for the contact sheet). */
export const InlineEditOpen: Story = () => (
  <div style={{ padding: '24px 0' }}>
    <Thread>
      <EditableMessage
        value="What local model should I run on a 24GB MacBook for coding?"
        editing
        onSave={noop}
        onCancel={noop}
      />
    </Thread>
  </div>
);

/** Branch switcher `‹ n / m ›` sitting inline with copy/edit under a message. */
export const Branches: Story = () => {
  const [index, setIndex] = useState(1);
  const total = 3;
  return (
    <Frame>
      <Row label="branch switcher alongside the action bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BranchSwitcher
            index={index}
            total={total}
            onPrev={() => setIndex((i) => Math.max(0, i - 1))}
            onNext={() => setIndex((i) => Math.min(total - 1, i + 1))}
          />
          <MessageActions onCopy={noop} onEdit={noop} />
        </div>
      </Row>
      <Row label="first branch (prev disabled) / last branch (next disabled)">
        <BranchSwitcher index={0} total={2} onNext={noop} />
        <BranchSwitcher index={1} total={2} onPrev={noop} />
      </Row>
    </Frame>
  );
};

export const ActionBarStates: Story = () => (
  <Frame>
    <Row label="assistant action bar (all controls)">
      <MessageActions
        onCopy={noop}
        onThumbsUp={noop}
        onThumbsDown={noop}
        onRetry={noop}
        onShare={noop}
        tokenCount={1240}
        onContext={noop}
        overflow={<DropdownMenuItem>Copy markdown</DropdownMenuItem>}
      />
    </Row>
    <Row label="user action bar (copy / edit / context)">
      <MessageActions onCopy={noop} onEdit={noop} tokenCount={42} />
    </Row>
    <Row label="footnotes">
      <ResponseSpeed tokensPerSecond={180} />
      <ModelFootnote model="Qwen3.6 27B" />
      <MessageFootnote>Generated locally · 3.2s</MessageFootnote>
    </Row>
  </Frame>
);
