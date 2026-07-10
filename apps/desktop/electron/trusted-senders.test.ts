import { describe, expect, it } from 'vitest';
import {
  isTrustedIpcEvent,
  registerTrustedSender,
  type TrustedSenderCandidate,
} from './trusted-senders';

function makeSender(): TrustedSenderCandidate & { mainFrame: object } {
  return { mainFrame: { url: 'file:///index.html' } };
}

describe('isTrustedIpcEvent', () => {
  it('accepts a main-frame invoke from a registered sender', () => {
    const sender = makeSender();
    registerTrustedSender(sender);

    expect(isTrustedIpcEvent({ sender, senderFrame: sender.mainFrame })).toBe(true);
  });

  it('rejects senders that were never registered', () => {
    const sender = makeSender();

    expect(isTrustedIpcEvent({ sender, senderFrame: sender.mainFrame })).toBe(false);
  });

  it('rejects invokes from a child frame of a trusted sender', () => {
    const sender = makeSender();
    registerTrustedSender(sender);
    const childFrame = { url: 'file:///iframe.html' };

    expect(isTrustedIpcEvent({ sender, senderFrame: childFrame })).toBe(false);
  });

  it('rejects invokes whose sender frame was destroyed mid-flight', () => {
    const sender = makeSender();
    registerTrustedSender(sender);

    expect(isTrustedIpcEvent({ sender, senderFrame: null })).toBe(false);
  });

  it('keeps distinct senders independent', () => {
    const trusted = makeSender();
    const other = makeSender();
    registerTrustedSender(trusted);

    expect(isTrustedIpcEvent({ sender: other, senderFrame: other.mainFrame })).toBe(false);
    expect(isTrustedIpcEvent({ sender: trusted, senderFrame: trusted.mainFrame })).toBe(true);
  });
});
