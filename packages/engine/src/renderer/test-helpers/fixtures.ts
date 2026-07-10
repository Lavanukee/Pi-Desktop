/**
 * Loads mock-pi transcript fixtures and extracts the event stream a live
 * bridge would deliver, so router tests replay exactly what mock-pi emits
 * (including `$repeat:` template expansion, mirroring mock-pi.mjs).
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PiBridgeEvent } from '../../types/rpc';

export interface FixtureStep {
  emit?: Record<string, unknown>;
  emitRaw?: string;
  awaitUi?: string;
  delayMs?: number;
  splitChunks?: number;
}

export interface FixturePrompt {
  match?: string;
  response?: Record<string, unknown>;
  steps?: FixtureStep[];
  abortSteps?: FixtureStep[];
}

export interface MockPiFixture {
  name: string;
  state?: Record<string, unknown>;
  models?: unknown[];
  greeting?: FixtureStep[];
  prompts?: FixturePrompt[];
}

const here = path.dirname(fileURLToPath(import.meta.url));

export const MOCK_PI_DIR = path.resolve(here, '../../../tools/mock-pi');

export function loadFixture(name: string): MockPiFixture {
  const file = path.join(MOCK_PI_DIR, 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as MockPiFixture;
}

/** Mirrors mock-pi.mjs `$repeat:<count>:<unit>` expansion. */
export function expandTemplates<T>(value: T): T {
  if (typeof value === 'string') {
    const match = value.match(/^\$repeat:(\d+):([\s\S]*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return match[2].repeat(Number(match[1])) as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => expandTemplates(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandTemplates(entry);
    }
    return out as unknown as T;
  }
  return value;
}

function stepEvents(steps: FixtureStep[] | undefined): PiBridgeEvent[] {
  const events: PiBridgeEvent[] = [];
  for (const step of steps ?? []) {
    if (step.emit !== undefined) {
      events.push(expandTemplates(step.emit) as unknown as PiBridgeEvent);
    }
  }
  return events;
}

/** The events one scripted prompt streams (what the bridge would forward). */
export function promptEvents(fixture: MockPiFixture, index: number): PiBridgeEvent[] {
  const prompt = fixture.prompts?.[index];
  if (prompt === undefined) throw new Error(`fixture has no prompt #${index}`);
  return stepEvents(prompt.steps);
}

/** The events an abort interrupting the prompt would stream (abortSteps). */
export function abortEvents(fixture: MockPiFixture, index: number): PiBridgeEvent[] {
  const prompt = fixture.prompts?.[index];
  if (prompt === undefined) throw new Error(`fixture has no prompt #${index}`);
  return stepEvents(prompt.abortSteps);
}
