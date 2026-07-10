/**
 * RecordingSink — a StoreSink that records every mutation as
 * [method, ...args] for order-sensitive snapshot assertions.
 * Long strings are truncated so huge-block fixtures stay snapshot-friendly.
 */
import type { StoreSink } from '../store-sink';

export type RecordedCall = [string, ...unknown[]];

const TRUNCATE_AT = 120;

function compact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > TRUNCATE_AT
      ? `${value.slice(0, TRUNCATE_AT)}…<len=${value.length}>`
      : value;
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = compact(entry);
    return out;
  }
  return value;
}

export class RecordingSink implements StoreSink {
  readonly calls: RecordedCall[] = [];

  private record(method: string, ...args: unknown[]): void {
    this.calls.push([method, ...args.map(compact)]);
  }

  callsFor(method: string): RecordedCall[] {
    return this.calls.filter(([name]) => name === method);
  }

  agentStart: StoreSink['agentStart'] = () => this.record('agentStart');
  agentEnd: StoreSink['agentEnd'] = () => this.record('agentEnd');
  beginAssistantTurn: StoreSink['beginAssistantTurn'] = (id) =>
    this.record('beginAssistantTurn', id);
  endTurn: StoreSink['endTurn'] = (id, stopReason, message) =>
    this.record('endTurn', id, stopReason, message);
  appendTextDelta: StoreSink['appendTextDelta'] = (id, delta) =>
    this.record('appendTextDelta', id, delta);
  appendThinkingDelta: StoreSink['appendThinkingDelta'] = (id, delta) =>
    this.record('appendThinkingDelta', id, delta);
  beginToolCall: StoreSink['beginToolCall'] = (id, call) => this.record('beginToolCall', id, call);
  appendToolCallArgs: StoreSink['appendToolCallArgs'] = (id, callId, argsDelta) =>
    this.record('appendToolCallArgs', id, callId, argsDelta);
  finalizeToolCall: StoreSink['finalizeToolCall'] = (id, callId, toolCall) =>
    this.record('finalizeToolCall', id, callId, toolCall);
  toolExecutionStart: StoreSink['toolExecutionStart'] = (callId, toolName, args) =>
    this.record('toolExecutionStart', callId, toolName, args);
  toolExecutionUpdate: StoreSink['toolExecutionUpdate'] = (callId, toolName, partialResult) =>
    this.record('toolExecutionUpdate', callId, toolName, partialResult);
  upsertToolResult: StoreSink['upsertToolResult'] = (result) =>
    this.record('upsertToolResult', result);
  setAgentStatus: StoreSink['setAgentStatus'] = (patch) => this.record('setAgentStatus', patch);
  sessionChanged: StoreSink['sessionChanged'] = (info) => this.record('sessionChanged', info);
  setMessages: StoreSink['setMessages'] = (messages) => this.record('setMessages', messages);
  notify: StoreSink['notify'] = (level, message) => this.record('notify', level, message);
  uiRequest: StoreSink['uiRequest'] = (request) => this.record('uiRequest', request);
  resolveUiRequest: StoreSink['resolveUiRequest'] = (id) => this.record('resolveUiRequest', id);
  setExtensionStatus: StoreSink['setExtensionStatus'] = (key, text) =>
    this.record('setExtensionStatus', key, text);
  setWidget: StoreSink['setWidget'] = (key, lines, placement) =>
    this.record('setWidget', key, lines, placement);
  setTitle: StoreSink['setTitle'] = (title) => this.record('setTitle', title);
  setComposerText: StoreSink['setComposerText'] = (text) => this.record('setComposerText', text);
  artifactCandidate: StoreSink['artifactCandidate'] = (candidate) =>
    this.record('artifactCandidate', candidate);
  stderrText: NonNullable<StoreSink['stderrText']> = (text) => this.record('stderrText', text);
  bridgeExit: NonNullable<StoreSink['bridgeExit']> = (info) => this.record('bridgeExit', info);
}
