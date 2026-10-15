import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  McdClient, McdError, ALLOWED_TOOLS, MCP_ENDPOINT, MCP_PROTOCOL_VERSION,
  NUTRITION_FIELDS, parseNutrition,
} from '../mcp-client.mjs';

const token = 'test-private-token-never-log';
const schema = { type: 'object', properties: { storeCode: { type: 'string' } }, required: ['storeCode'] };
const fixtureTools = [
  ...ALLOWED_TOOLS.map(name => ({ name, inputSchema: schema })),
  { name: 'create-order', inputSchema: { type: 'object' } },
];
const json = (request, result, options = {}) => new Response(
  JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
  { headers: { 'Content-Type': 'application/json', ...options.headers }, status: options.status || 200 },
);
function mockServer(onCall = () => ({ content: [] }), options = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url, ...init, request });
    if (request.method === 'initialize') return json(request, {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} },
      serverInfo: { name: 'mock', version: '1' },
    }, { headers: { 'mcp-session-id': 'mock-session' } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') return json(request, { tools: options.tools || fixtureTools });
    return onCall(request, init);
  };
  return { fetchImpl, requests };
}

test('JSON handshake, session/version headers, schema discovery, unchanged tool arguments', async () => {
  const response = { structuredContent: { success: true, code: 200, data: [{ productName: '中薯', energyKcal: 289 }] } };
  const server = mockServer(request => json(request, response));
  const client = new McdClient(token, { fetchImpl: server.fetchImpl });
  const result = await client.initialize();
  assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
  const discovered = await client.tools();
  assert.deepEqual(discovered.tools.map(t => t.name), ALLOWED_TOOLS);
  assert.deepEqual(discovered.tools[0].inputSchema, schema);
  const args = { storeCode: 'real-user-selected-store', orderType: 1, beType: 1, code: 'official-code' };
  assert.deepEqual(await client.call('query-meal-detail', args), response);
  assert.equal(server.requests.length, 4);
  const [initialize, notification, list, call] = server.requests;
  assert.equal(initialize.request.method, 'initialize');
  assert.equal(initialize.request.params.protocolVersion, '2025-06-18');
  assert.deepEqual(initialize.request.params.capabilities, {});
  assert.equal(notification.request.method, 'notifications/initialized');
  assert.equal(Object.hasOwn(notification.request, 'id'), false);
  assert.deepEqual(call.request.params, { name: 'query-meal-detail', arguments: args });
  for (const sent of server.requests) {
    assert.equal(sent.url, MCP_ENDPOINT);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.redirect, 'error');
    assert.equal(sent.headers.Authorization, `Bearer ${token}`);
    assert.equal(sent.headers.Accept, 'application/json, text/event-stream');
  }
  for (const sent of [notification, list, call]) {
    assert.equal(sent.headers['Mcp-Session-Id'], 'mock-session');
    assert.equal(sent.headers['MCP-Protocol-Version'], '2025-06-18');
  }
  const count = server.requests.length;
  client.close();
  assert.equal(server.requests.length, count, 'close is local cleanup, not another remote request');
  await assert.rejects(client.tools(), { code: 'CLIENT_CLOSED' });
});

test('reject disallowed/unavailable tools and non-object arguments without unsafe calls', async () => {
  const server = mockServer(undefined, { tools: [] });
  const client = new McdClient(token, { fetchImpl: server.fetchImpl });
  await assert.rejects(client.call('create-order', {}), { code: 'TOOL_NOT_ALLOWED' });
  await assert.rejects(client.call('cancel-order', {}), { code: 'TOOL_NOT_ALLOWED' });
  await assert.rejects(client.call('list-nutrition-foods', []), { code: 'INVALID_ARGUMENTS' });
  assert.equal(server.requests.length, 0);
  await assert.rejects(client.call('list-nutrition-foods', {}), { code: 'TOOL_UNAVAILABLE' });
  assert.equal(server.requests.some(r => r.request.method === 'tools/call'), false);
  client.close();
});

test('SSE handles split UTF-8/CRLF, comments, progress, multiline data, and cancels after matching response', async () => {
  let cancelled = false;
  const result = { content: [{ type: 'text', text: '真实响应：猪柳麦满分' }] };
  const server = mockServer(request => {
    const sse = ': keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n' +
      'data: {"jsonrpc":"2.0","id":999,"result":{}}\r\n\r\n' +
      `event: message\r\ndata: {"jsonrpc":"2.0","id":${request.id},\r\ndata: "result":${JSON.stringify(result)}}\r\n\r\n`;
    const bytes = new TextEncoder().encode(sse);
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset += 1));
        }
        // Keep the stream open: receiving the result must end our read promptly.
      },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  });
  const client = new McdClient(token, { fetchImpl: server.fetchImpl, timeoutMs: 1000 });
  assert.deepEqual(await client.call('list-nutrition-foods'), result);
  assert.equal(cancelled, true);
  client.close();
});

test('401 and 429 preserve status/retry-after and redact any echoed token', async () => {
  for (const status of [401, 429]) {
    const client = new McdClient(token, { fetchImpl: async () => new Response(
      JSON.stringify({ message: `upstream says Bearer ${token}` }),
      { status, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } },
    ) });
    await assert.rejects(client.initialize(), error => {
      assert.ok(error instanceof McdError);
      assert.equal(error.status, status);
      assert.equal(error.code, `HTTP_${status}`);
      assert.equal(error.retryAfter, '30');
      assert.equal(inspect(error).includes(token), false);
      return true;
    });
    client.close();
  }
});

test('JSON-RPC errors, isError, and HTTP-200 business errors stop with upstream messages', async () => {
  const cases = [
    request => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32602, message: '缺少门店编码' } }), { headers: { 'Content-Type': 'application/json' } }),
    request => json(request, { isError: true, content: [{ type: 'text', text: '餐品已售罄' }] }),
    request => json(request, { content: [{ type: 'text', text: JSON.stringify({ success: false, code: 4001, message: '门店当前不可用', data: null }) }] }),
    request => json(request, { structuredContent: { success: false, code: 4002, message: '不支持该取餐方式', data: null } }),
  ];
  for (let index = 0; index < cases.length; index++) {
    const server = mockServer(cases[index]);
    const client = new McdClient(token, { fetchImpl: server.fetchImpl });
    await assert.rejects(client.call('query-meals', {}), /缺少门店编码|餐品已售罄|门店当前不可用|不支持该取餐方式/);
    assert.equal(server.requests.filter(r => r.request.method === 'tools/call').length, 1, 'no retry');
    client.close();
  }
});

test('invalid response/version, incomplete SSE, and timeout are explicit errors', async () => {
  const wrongVersion = new McdClient(token, { fetchImpl: async (url, init) => json(JSON.parse(init.body), { protocolVersion: '2024-11-05' }) });
  await assert.rejects(wrongVersion.initialize(), { code: 'PROTOCOL_VERSION' });
  wrongVersion.close();
  const wrongId = new McdClient(token, { fetchImpl: async () => json({ id: 999 }, {}) });
  await assert.rejects(wrongId.initialize(), { code: 'INVALID_RPC' });
  wrongId.close();
  const server = mockServer(() => new Response('data: {"jsonrpc":"2.0","id":999,"result":{}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const incomplete = new McdClient(token, { fetchImpl: server.fetchImpl });
  await assert.rejects(incomplete.call('list-nutrition-foods'), { code: 'INVALID_SSE' });
  incomplete.close();
  let aborted = false;
  const timeout = new McdClient(token, { timeoutMs: 15, fetchImpl: async (url, init) => {
    init.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  await assert.rejects(timeout.initialize(), { code: 'TIMEOUT' });
  assert.equal(aborted, true);
  timeout.close();
});

test('expired session stops current operation and reinitializes only on the next explicit call', async () => {
  let expired = true;
  const server = mockServer(request => expired ? new Response('session expired', { status: 404 }) : json(request, { content: [] }));
  const client = new McdClient(token, { fetchImpl: server.fetchImpl });
  await assert.rejects(client.call('query-meals', {}), { status: 404 });
  assert.equal(server.requests.filter(r => r.request.method === 'initialize').length, 1);
  expired = false;
  await client.call('query-meals', {});
  assert.equal(server.requests.filter(r => r.request.method === 'initialize').length, 2);
  client.close();
});

test('no logging or token exposure through enumerable/client inspection/error surfaces', async () => {
  const recorded = [];
  const originals = {};
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[key] = console[key];
    console[key] = (...values) => recorded.push(values);
  }
  try {
    const server = mockServer(() => { throw new Error(`network echo ${token}`); });
    const client = new McdClient(token, { fetchImpl: server.fetchImpl });
    assert.equal(JSON.stringify(client).includes(token), false);
    assert.equal(inspect(client, { showHidden: true }).includes(token), false);
    await assert.rejects(client.call('query-meals', {}), error => !inspect(error).includes(token));
    client.close();
  } finally {
    for (const key of Object.keys(originals)) console[key] = originals[key];
  }
  assert.deepEqual(recorded, []);
});

const officialToon = '[1]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  猪柳麦满分,null,1288,308,16,16,24,781,213\n ';
test('official nine-field TOON in text business envelope preserves actual values and units', () => {
  const rows = parseNutrition({ content: [{ type: 'text', text: JSON.stringify({
    success: true, code: 200, message: '请求成功', datetime: '2026-01-23 09:32:44', data: officialToon,
  }) }] });
  assert.deepEqual(rows, [{ productName: '猪柳麦满分', nutritionDescription: null, energyKj: 1288,
    energyKcal: 308, protein: 16, fat: 16, carbohydrate: 24, sodium: 781, calcium: 213 }]);
});

test('JSON alternatives and missing values: preserve zero; do not guess from kJ or unit strings', () => {
  const row = { productName: '测试零度', energyKj: 100, protein: '0', sodium: '35', fat: '1g', calcium: '' };
  const expected = { productName: '测试零度', nutritionDescription: null, energyKj: 100,
    energyKcal: null, protein: 0, fat: null, carbohydrate: null, sodium: 35, calcium: null };
  for (const wrapper of [[row], { data: [row] }, { structuredContent: { success: true, code: 200, data: { foods: [row] } } },
    { content: [{ type: 'text', text: JSON.stringify({ data: [row] }) }] }]) {
    assert.deepEqual(parseNutrition(wrapper), [expected]);
  }
  assert.deepEqual(Object.keys(parseNutrition([row])[0]), NUTRITION_FIELDS);
});

test('TOON respects field names/order, quoted commas/escapes, and null vs quoted null', () => {
  const rows = parseNutrition('[2]{sodium,productName,energyKcal,nutritionDescription}:\n' +
    '  0,"餐品,小份",0,"null"\n  100,"餐品\\"B",100,null');
  assert.equal(rows[0].productName, '餐品,小份');
  assert.equal(rows[0].nutritionDescription, 'null');
  assert.equal(rows[1].productName, '餐品"B');
  assert.equal(rows[1].protein, null);
  assert.deepEqual(parseNutrition('[0]{productName,energyKcal}:\n'), []);
});

test('malformed/failed nutrition never silently becomes a complete zero-calorie menu', () => {
  for (const input of [
    '[2]{productName,energyKcal}:\n  食物,100',
    '[1]{productName,energyKcal}:\n  食物,100,extra',
    '[1]{unknown,kcal}:\n  食物,100',
    '[1]{productName,energyKcal}:\n  "未闭合,100',
    { success: false, code: 400, message: '营养数据暂不可用', data: null },
    { isError: true, content: [] }, {}, null,
  ]) assert.throws(() => parseNutrition(input), McdError);
});
