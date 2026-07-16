import { describe, expect, it, vi } from 'vitest';
import {
  balanceJson,
  DEFAULT_TOOL_NAME_MATCH_THRESHOLD,
  fuzzyMatchToolName,
  nameSimilarity,
  reconstructToolCallFromContent,
  relaxToolSchema,
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

describe('deeper schema validation (rung 2)', () => {
  it('flags unknown props only under additionalProperties:false', () => {
    const strict: ToolSchemaLike = {
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: false,
    };
    expect(validateAgainstSchema({ x: 'a' }, strict).valid).toBe(true);
    const bad = validateAgainstSchema({ x: 'a', y: 1 }, strict);
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(' ')).toContain('y');

    // A schema WITHOUT additionalProperties:false permits extras (JSON-Schema default).
    const loose: ToolSchemaLike = { type: 'object', properties: { x: { type: 'string' } } };
    expect(validateAgainstSchema({ x: 'a', y: 1 }, loose).valid).toBe(true);
  });

  it('validates nested object shape (missing + typed nested props)', () => {
    const schema: ToolSchemaLike = {
      type: 'object',
      properties: {
        user: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      },
      required: ['user'],
    };
    expect(validateAgainstSchema({ user: { id: 5 } }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ user: {} }, schema).valid).toBe(false); // missing nested id
    expect(validateAgainstSchema({ user: { id: 'x' } }, schema).valid).toBe(false); // nested type
  });

  it('validates array shape (minItems + item type)', () => {
    const schema: ToolSchemaLike = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tags'],
    };
    expect(validateAgainstSchema({ tags: ['a', 'b'] }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ tags: [] }, schema).valid).toBe(false); // minItems
    expect(validateAgainstSchema({ tags: [1] }, schema).valid).toBe(false); // item type
  });

  it('validates enums (JSON-Schema enum AND TypeBox anyOf/const unions)', () => {
    const enumSchema: ToolSchemaLike = {
      type: 'object',
      properties: { color: { enum: ['red', 'green'] } },
    };
    expect(validateAgainstSchema({ color: 'red' }, enumSchema).valid).toBe(true);
    expect(validateAgainstSchema({ color: 'blue' }, enumSchema).valid).toBe(false);

    // TypeBox emits Type.Union([Literal('a'), Literal('b')]) as anyOf-of-const.
    const unionSchema: ToolSchemaLike = {
      type: 'object',
      properties: {
        mode: {
          anyOf: [
            { const: 'a', type: 'string' },
            { const: 'b', type: 'string' },
          ],
        },
      },
      required: ['mode'],
    };
    expect(validateAgainstSchema({ mode: 'a' }, unionSchema).valid).toBe(true);
    expect(validateAgainstSchema({ mode: 'c' }, unionSchema).valid).toBe(false);
  });

  it('validates simple string/number bounds', () => {
    const schema: ToolSchemaLike = {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 2 },
        n: { type: 'integer', minimum: 0, maximum: 9 },
      },
    };
    expect(validateAgainstSchema({ q: 'hi', n: 5 }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ q: 'h', n: 5 }, schema).valid).toBe(false); // minLength
    expect(validateAgainstSchema({ q: 'hi', n: -1 }, schema).valid).toBe(false); // minimum
    expect(validateAgainstSchema({ q: 'hi', n: 10 }, schema).valid).toBe(false); // maximum
  });

  it('still passes a top-level valid call and flags missing/typed props (regression)', () => {
    const schema: ToolSchemaLike = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    expect(validateAgainstSchema({ path: '/x' }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ wrong: 1 }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ path: 5 }, schema).valid).toBe(false);
  });
});

describe('fuzzy tool-name matching', () => {
  const registered = ['web_search', 'read', 'bash', 'get_time'];

  it('maps a misspelled name to the nearest registered tool', () => {
    expect(fuzzyMatchToolName('web_serch', registered)?.name).toBe('web_search');
    expect(fuzzyMatchToolName('reed', registered)?.name).toBe('read');
  });

  it('treats case/punctuation-only differences as an exact (score 1) match', () => {
    expect(nameSimilarity('Web-Search', 'web_search')).toBe(1);
    const m = fuzzyMatchToolName('Web-Search', registered);
    expect(m).toEqual({ name: 'web_search', score: 1 });
  });

  it('returns undefined for a name below the threshold (left to not-found path)', () => {
    expect(fuzzyMatchToolName('xyzzy', registered)).toBeUndefined();
    expect(fuzzyMatchToolName('', registered)).toBeUndefined();
  });

  it('honors the confidence threshold argument', () => {
    // "read" vs "red": normalized dist 1 / 4 = 0.75 similarity.
    expect(fuzzyMatchToolName('read', ['red'])?.name).toBe('red'); // 0.75 >= default 0.72
    expect(fuzzyMatchToolName('read', ['red'], 0.9)).toBeUndefined(); // 0.75 < 0.9
    expect(DEFAULT_TOOL_NAME_MATCH_THRESHOLD).toBeGreaterThan(0.5);
  });
});

describe('relaxToolSchema (rung-4 relaxation)', () => {
  it('produces an any-object schema that accepts previously-rejected args', () => {
    const strict: ToolSchemaLike = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    expect(validateAgainstSchema({ wrong: 1 }, strict).valid).toBe(false);
    const relaxed = relaxToolSchema(strict);
    expect(relaxed).toEqual({ type: 'object', additionalProperties: true });
    expect(validateAgainstSchema({ wrong: 1 }, relaxed).valid).toBe(true);
    expect(validateAgainstSchema({ anything: [1, 2], nested: { a: 1 } }, relaxed).valid).toBe(true);
  });
});

describe('rung 0 — text-content tool-call reconstructor', () => {
  const registered = ['web_search', 'read', 'get_time'];

  it('reconstructs a fenced JSON envelope naming a tool + args', () => {
    const content = 'Sure!\n```json\n{"name":"web_search","arguments":{"query":"cats"}}\n```';
    const r = reconstructToolCallFromContent(content, registered);
    expect(r).toMatchObject({
      toolName: 'web_search',
      arguments: { query: 'cats' },
      shape: 'envelope-json',
    });
  });

  it('reconstructs an OpenAI-style nested function envelope with stringified args', () => {
    const content = '{"function":{"name":"read","arguments":"{\\"path\\":\\"/x\\"}"}}';
    const r = reconstructToolCallFromContent(content, registered);
    expect(r).toMatchObject({ toolName: 'read', arguments: { path: '/x' } });
  });

  it('reconstructs a <tool_call> envelope tag', () => {
    const content = '<tool_call>{"name":"read","arguments":{"path":"/y"}}</tool_call>';
    const r = reconstructToolCallFromContent(content, registered);
    expect(r).toMatchObject({ toolName: 'read', arguments: { path: '/y' } });
  });

  it('reconstructs a <function=NAME>{…}</function> call', () => {
    const r = reconstructToolCallFromContent('<function=read>{"path":"/z"}</function>', registered);
    expect(r).toMatchObject({ toolName: 'read', arguments: { path: '/z' }, shape: 'function-tag' });
  });

  it('reconstructs a <NAME>{…}</NAME> tag for a registered tool', () => {
    const r = reconstructToolCallFromContent('<read>{"path":"/n"}</read>', registered);
    expect(r).toMatchObject({ toolName: 'read', arguments: { path: '/n' }, shape: 'name-tag' });
  });

  it('reconstructs a paren-style call, incl. no-arg', () => {
    expect(reconstructToolCallFromContent('read({"path":"/p"})', registered)).toMatchObject({
      toolName: 'read',
      arguments: { path: '/p' },
      shape: 'paren-call',
    });
    expect(reconstructToolCallFromContent('get_time()', registered)).toMatchObject({
      toolName: 'get_time',
      arguments: {},
      shape: 'paren-call',
    });
  });

  it('reconstructs a prose call ("I\'ll call web_search with {…}")', () => {
    const r = reconstructToolCallFromContent(
      'I\'ll call web_search with {"query": "dogs"} now.',
      registered,
    );
    expect(r).toMatchObject({
      toolName: 'web_search',
      arguments: { query: 'dogs' },
      shape: 'prose-json',
    });
  });

  it('reconstructs a bare no-arg envelope only when every key is a name key', () => {
    expect(reconstructToolCallFromContent('{"name":"get_time"}', registered)).toMatchObject({
      toolName: 'get_time',
      arguments: {},
    });
  });

  // --- false-positive guards ------------------------------------------------

  it('does NOT fire on prose that merely mentions a tool', () => {
    expect(
      reconstructToolCallFromContent('You can use web_search to find pages.', registered),
    ).toBeUndefined();
    // A registered name near braces but with no call connective is not a call.
    expect(
      reconstructToolCallFromContent('web_search returns JSON like {"query":"x"}.', registered),
    ).toBeUndefined();
  });

  it('does NOT fire on an envelope naming an UNREGISTERED tool', () => {
    expect(
      reconstructToolCallFromContent('{"name":"delete_all","arguments":{}}', registered),
    ).toBeUndefined();
  });

  it('does NOT fire when the args are unparseable', () => {
    expect(
      reconstructToolCallFromContent('{"name":"read","arguments":"not json at all"}', registered),
    ).toBeUndefined();
  });

  it('does NOT treat a data object with a stray "name" field as a call', () => {
    // "content" is not an args key and not a name key → not a call envelope.
    expect(
      reconstructToolCallFromContent('{"name":"read","content":"hello world"}', registered),
    ).toBeUndefined();
  });

  it('returns undefined with no registered tools or empty content', () => {
    expect(reconstructToolCallFromContent('{"name":"read","arguments":{}}', [])).toBeUndefined();
    expect(reconstructToolCallFromContent('', registered)).toBeUndefined();
  });
});
