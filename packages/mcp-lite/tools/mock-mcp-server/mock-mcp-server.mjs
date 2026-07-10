#!/usr/bin/env node
/**
 * mock-mcp-server — a deterministic MCP server over stdio (newline-delimited
 * JSON-RPC 2.0), the MCP-side analogue of engine's mock-pi.
 *
 * It speaks the real protocol so the production McpStdioClient / ConnectorHost
 * exercise their handshake, discovery, call, resource/prompt, and teardown
 * paths end to end with zero network. This doubles as the client's own proof
 * that its framing and correlation consume protocol-correct input.
 *
 * Behaviour env vars (all optional):
 *   MOCK_MCP_HANG=1        never reply to initialize (drives client timeout)
 *   MOCK_MCP_INIT_DELAY=ms delay the initialize reply by N ms
 *   MOCK_MCP_NO_TOOLS=1    advertise an empty tool list
 *   MOCK_MCP_NAME=str      serverInfo.name (default "mock-mcp-server")
 *
 * Tools: echo, add, make_image, boom (returns isError), slow (delays by args.ms).
 */

const HANG = process.env.MOCK_MCP_HANG === '1';
const INIT_DELAY = Number(process.env.MOCK_MCP_INIT_DELAY ?? '0') || 0;
const NO_TOOLS = process.env.MOCK_MCP_NO_TOOLS === '1';
const SERVER_NAME = process.env.MOCK_MCP_NAME ?? 'mock-mcp-server';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = NO_TOOLS
  ? []
  : [
      {
        name: 'echo',
        description: 'Echo the given message back as text.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', description: 'Text to echo.' } },
          required: ['message'],
        },
      },
      {
        name: 'add',
        description: 'Add two numbers and return the sum.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
      {
        name: 'make_image',
        description: 'Return a tiny 1x1 PNG as image content.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'boom',
        description: 'Return an error result (isError=true).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'slow',
        description: 'Reply after args.ms milliseconds.',
        inputSchema: {
          type: 'object',
          properties: { ms: { type: 'number' } },
          required: ['ms'],
        },
      },
    ];

const RESOURCES = [
  { uri: 'mock://readme', name: 'readme', description: 'A mock resource.', mimeType: 'text/plain' },
];
const PROMPTS = [{ name: 'greet', description: 'A mock prompt.', arguments: [] }];

// 1x1 transparent PNG.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, result) {
  writeLine({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  writeLine({ jsonrpc: '2.0', id, error: { code, message } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  switch (name) {
    case 'echo':
      reply(id, { content: [{ type: 'text', text: String(args.message ?? '') }] });
      return;
    case 'add':
      reply(id, {
        content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
      });
      return;
    case 'make_image':
      reply(id, { content: [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }] });
      return;
    case 'boom':
      reply(id, { content: [{ type: 'text', text: 'boom' }], isError: true });
      return;
    case 'slow':
      await sleep(Number(args.ms) || 0);
      reply(id, { content: [{ type: 'text', text: 'done' }] });
      return;
    default:
      replyError(id, -32602, `Unknown tool: ${name}`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) are acknowledged silently.
  if (id === undefined) return;

  switch (method) {
    case 'initialize':
      if (HANG) return; // never reply → client times out
      if (INIT_DELAY > 0) await sleep(INIT_DELAY);
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: SERVER_NAME, version: '0.0.0' },
      });
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      await handleToolCall(id, params);
      return;
    case 'resources/list':
      reply(id, { resources: RESOURCES });
      return;
    case 'prompts/list':
      reply(id, { prompts: PROMPTS });
      return;
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Fire and forget; ordering per-line is preserved by the await chain not
    // being required here (each response carries its own id).
    handle(msg);
  }
});

process.stdin.on('end', () => process.exit(0));
