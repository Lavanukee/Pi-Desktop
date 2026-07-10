import { describe, expect, it, vi } from 'vitest';
import {
  balanceJson,
  repairToolCallArguments,
  repairToolCallJson,
  stripCodeFences,
  type ToolSchemaLike,
  validateAgainstSchema,
} from './repair.js';

describe('rung 1 — syntactic repair', () => {
  it('parses already-valid JSON', () => {
    expect(repairToolCallJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json code fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(repairToolCallJson('```json\n{"path":"/x"}\n```')).toEqual({ path: '/x' });
  });

  it('drops trailing commas', () => {
    expect(repairToolCallJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('terminates an unterminated string and closes braces (truncation)', () => {
    expect(balanceJson('{"cmd":"ls -la')).toBe('{"cmd":"ls -la"}');
    expect(repairToolCallJson('{"cmd":"ls -la')).toEqual({ cmd: 'ls -la' });
  });

  it('closes nested truncated structures', () => {
    expect(repairToolCallJson('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    expect(repairToolCallJson('Sure! {"ok":true} done')).toEqual({ ok: true });
  });

  it('returns undefined for hopeless input', () => {
    expect(repairToolCallJson('not json at all')).toBeUndefined();
  });
});

describe('rung 2 — schema validation', () => {
  const schema: ToolSchemaLike = {
    type: 'object',
    properties: { path: { type: 'string' }, count: { type: 'integer' } },
    required: ['path'],
  };

  it('passes when required props are present with correct types', () => {
    expect(validateAgainstSchema({ path: '/x', count: 3 }, schema).valid).toBe(true);
  });

  it('flags missing required props', () => {
    const r = validateAgainstSchema({ count: 3 }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('path');
  });

  it('flags type mismatches', () => {
    const r = validateAgainstSchema({ path: 5 }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('path');
  });

  it('no schema → always valid', () => {
    expect(validateAgainstSchema({ anything: 1 }, undefined).valid).toBe(true);
  });
});

describe('repairToolCallArguments (ladder)', () => {
  const schema: ToolSchemaLike = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  };

  it('rung 1: fixes a truncated call and validates against schema', async () => {
    const result = await repairToolCallArguments('{"path":"/etc/hosts', {
      toolName: 'read',
      schema,
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ path: '/etc/hosts' });
    expect(result.rung).toBe(2);
  });

  it('rung 1 alone (no schema) reports rung 1', async () => {
    const result = await repairToolCallArguments('{"path":"/x",}', { toolName: 'read' });
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(1);
  });

  it('rung 2: calls the injected fixer when the repaired args fail schema', async () => {
    // Syntactically valid but schema-invalid (missing required "path").
    const fixer = vi.fn(async () => ({ path: '/fixed' }));
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema,
      fixer,
    });
    expect(fixer).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ path: '/fixed' });
    expect(result.rung).toBe(2);
  });

  it('rung 2: fixer rescues completely unparseable input', async () => {
    const fixer = vi.fn(async () => ({ path: '/rescued' }));
    const result = await repairToolCallArguments('total garbage {{{', {
      toolName: 'read',
      schema,
      fixer,
    });
    expect(fixer).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ path: '/rescued' });
  });

  it('fails cleanly when no fixer and schema is unmet', async () => {
    const result = await repairToolCallArguments('{"wrong":1}', { toolName: 'read', schema });
    expect(result.ok).toBe(false);
  });

  it('runs W5 extra rungs (3–5 seam) after rung 2', async () => {
    const rung3 = vi.fn(async () => ({ ok: true, value: { path: '/from-rung-3' }, rung: 3 }));
    const result = await repairToolCallArguments('nonsense', {
      toolName: 'read',
      schema,
      extraRungs: [rung3],
    });
    expect(rung3).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(3);
  });
});
