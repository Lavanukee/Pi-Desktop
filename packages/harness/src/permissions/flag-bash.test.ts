import { describe, expect, it, vi } from 'vitest';
import type { CallModel } from '../model-call/call-model.js';
import { createBashFlagger, interpretFlagReply } from './flag-bash.js';

describe('interpretFlagReply', () => {
  it('treats SAFE (any casing/punctuation) as not scary', () => {
    expect(interpretFlagReply('SAFE')).toBeNull();
    expect(interpretFlagReply(' safe. ')).toBeNull();
    expect(interpretFlagReply('')).toBeNull();
  });

  it('returns a flagged reason for a dangerous verdict', () => {
    expect(interpretFlagReply('deletes the whole home directory')).toBe(
      'flagged by model: deletes the whole home directory',
    );
  });

  it('strips a leading verdict token', () => {
    expect(interpretFlagReply('DANGEROUS: wipes the disk')).toBe(
      'flagged by model: wipes the disk',
    );
  });
});

describe('createBashFlagger', () => {
  it('flags when the model judges the command dangerous', async () => {
    const callModel: CallModel = vi.fn(async () => 'reformats the primary disk');
    const flag = createBashFlagger(callModel);
    expect(await flag('mkfs.ext4 /dev/sda1')).toBe('flagged by model: reformats the primary disk');
  });

  it('passes a safe command', async () => {
    const callModel: CallModel = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(callModel);
    expect(await flag('ls -la')).toBeNull();
  });

  it('fails open (null) when the model throws', async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new Error('unreachable');
    });
    const flag = createBashFlagger(callModel);
    expect(await flag('rm something')).toBeNull();
  });

  it('does not call the model for an empty command', async () => {
    const callModel = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(callModel as CallModel);
    expect(await flag('   ')).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });
});
