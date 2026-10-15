import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';

const SECRET = 'private-test-token-must-not-appear';

async function fixture(t, { fail = false, deferred = null, initializeError = null, callImpl = null } = {}) {
  const calls = [];
  const clients = [];
  class Client {
    constructor(token) { this.token = token; this.closed = false; clients.push(this); }
    async initialize() {
      if (deferred) await deferred;
      if (initializeError) throw initializeError;
      if (fail || this.token === 'bad') throw new Error(`upstream accidentally echoed ${this.token}`);
    }
    async tools() { return [{ name: 'query-meals', description: '菜单', inputSchema: { type: 'object' }, internal: SECRET }]; }
    async call(name, args) {
      calls.push({ name, args });
      if (callImpl) return callImpl.call(this, name, args);
      if (args.fail) throw new Error(SECRET);
      return { content: [{ type: 'text', text: '{"foods":[]}' }] };
    }
    async close() { this.closed = true; this.token = null; }
  }
  const server = createAppServer({ port: 0, Client, parseNutrition: () => [{ id: 'official-1', kcal: 100 }] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  function request(path, { method = 'GET', body, headers = {}, raw } = {}) {
    return new Promise((resolveResponse, reject) => {
      const payload = raw ?? (body === undefined ? '' : JSON.stringify(body));
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(method === 'POST' ? { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  return { request, calls, clients, port };
}

test('import 不监听；状态、握手、工具目录和断开正确且不返回 Token', async (t) => {
  const { request, clients } = await fixture(t);
  assert.deepEqual((await request('/api/status')).json(), { local: true, connected: false });
  const response = await request('/api/connect', { method: 'POST', body: { token: SECRET } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { connected: true, tools: [{ name: 'query-meals', description: '菜单', inputSchema: { type: 'object' } }] });
  assert.equal(response.text.includes(SECRET), false);
  assert.equal((await request('/api/status')).json().connected, true);
  assert.deepEqual((await request('/api/disconnect', { method: 'POST', body: {} })).json(), { connected: false });
  assert.equal(clients[0].closed, true);
  assert.equal((await request('/api/status')).json().connected, false);
});

test('重连失败清除旧连接，错误响应不回显凭证', async (t) => {
  const { request, clients } = await fixture(t);
  await request('/api/connect', { method: 'POST', body: { token: SECRET } });
  const response = await request('/api/connect', { method: 'POST', body: { token: 'bad' } });
  assert.equal(response.status, 502);
  assert.equal(response.text.includes('bad'), false);
  assert.equal(response.text.includes(SECRET), false);
  assert.equal(clients[0].closed, true);
  assert.equal(clients[1].closed, true);
  assert.equal((await request('/api/status')).json().connected, false);
});

test('握手未完成不显示连接，断开后迟到的握手不能恢复连接', async (t) => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const { request, clients } = await fixture(t, { deferred });
  const pending = request('/api/connect', { method: 'POST', body: { token: SECRET } });
  while (clients.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request('/api/status')).json().connected, false);
  await request('/api/disconnect', { method: 'POST', body: {} });
  assert.equal(clients[0].closed, true);
  release();
  assert.equal((await pending).status, 409);
  assert.equal((await request('/api/status')).json().connected, false);
  assert.equal(clients[0].closed, true);
});

test('所有 POST 验证本机 Host、Origin、端口与 JSON 类型', async (t) => {
  const { request, port } = await fixture(t);
  const variants = [
    [{ Host: `evil.example:${port}` }, 403],
    [{ Host: `127.0.0.1:${port + 1}` }, 403],
    [{ Origin: 'https://evil.example' }, 403],
    [{ Origin: `http://127.0.0.1:${port + 1}` }, 403],
    [{ Origin: '' }, 403],
    [{ Origin: 'null' }, 403],
    [{ 'Content-Type': 'text/plain' }, 415],
  ];
  for (const [headers, expected] of variants) {
    for (const path of ['/api/connect', '/api/disconnect', '/api/nutrition', '/api/tool']) {
      const response = await request(path, { method: 'POST', body: { token: SECRET }, headers });
      assert.equal(response.status, expected, path);
      assert.equal(response.text.includes(SECRET), false);
    }
  }
  const local = await request('/api/disconnect', { method: 'POST', body: {}, headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(local.status, 200);
});

test('32KB 限制按字节执行，拒绝非法 JSON', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/connect', { method: 'POST', raw: JSON.stringify({ token: '你'.repeat(12000) }) })).status, 413);
  assert.equal((await request('/api/connect', { method: 'POST', raw: '{}' + ' '.repeat(32768) })).status, 413);
  for (const raw of ['{', '[]', 'null']) assert.equal((await request('/api/connect', { method: 'POST', raw })).status, 400);
});

test('营养返回官方来源、读取时间；只转发四种只读/核价工具', async (t) => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('/api/nutrition', { method: 'POST', body: {} })).status, 409);
  await request('/api/connect', { method: 'POST', body: { token: SECRET } });
  const nutrition = (await request('/api/nutrition', { method: 'POST', body: {} })).json();
  assert.deepEqual(nutrition.foods, [{ id: 'official-1', kcal: 100 }]);
  assert.equal(nutrition.source, 'official-mcp');
  assert.equal(Number.isFinite(Date.parse(nutrition.fetchedAt)), true);
  assert.deepEqual(calls[0], { name: 'list-nutrition-foods', args: {} });
  for (const name of ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price']) {
    const response = await request('/api/tool', { method: 'POST', body: { name, arguments: { storeCode: 'demo' } } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { content: [{ type: 'text', text: '{"foods":[]}' }] });
    assert.deepEqual(calls.at(-1), { name, args: { storeCode: 'demo' } });
  }
  for (const name of ['create-order', 'cancel-order', 'https://evil.example', 'list-nutrition-foods']) {
    assert.equal((await request('/api/tool', { method: 'POST', body: { name, arguments: {} } })).status, 403);
  }
  assert.equal((await request('/api/tool', { method: 'POST', body: { name: 'query-meals', arguments: [] } })).status, 400);
  const failure = await request('/api/tool', { method: 'POST', body: { name: 'query-meals', arguments: { fail: true } } });
  assert.equal(failure.status, 502);
  assert.equal(failure.text.includes(SECRET), false);
  assert.equal((await request('/api/status')).json().connected, true);
});

test('上游 HTTP 与标准业务认证错误断开当前连接，安全返回 401', async (t) => {
  let upstreamError;
  const { request, clients } = await fixture(t, { callImpl: () => { throw upstreamError; } });
  const failures = [
    { status: 401, code: 'HTTP_401' },
    { status: 403, code: 'HTTP_403' },
    { code: '401' },
    { code: 403 },
    { code: 'UNAUTHORIZED' },
    { code: 'FORBIDDEN' },
    { code: 'TOKEN_EXPIRED' },
  ];
  for (const path of ['/api/tool', '/api/nutrition']) {
    for (const fields of failures) {
      await request('/api/connect', { method: 'POST', body: { token: SECRET } });
      const client = clients.at(-1);
      upstreamError = Object.assign(new Error(`upstream echoed ${SECRET}`), fields);
      const response = await request(path, { method: 'POST', body: path === '/api/tool' ? { name: 'query-meals' } : {} });
      assert.equal(response.status, 401, JSON.stringify({ path, ...fields }));
      assert.deepEqual(response.json(), { error: 'MCP 授权已失效或无权访问，请重新连接' });
      assert.equal(response.text.includes(SECRET), false);
      assert.equal(client.closed, true);
      assert.equal((await request('/api/status')).json().connected, false);
      assert.equal((await request('/api/tool', { method: 'POST', body: { name: 'query-meals' } })).status, 409);
    }
  }
});

test('限流、服务故障和普通查询错误保留连接，不通过消息文本猜测认证', async (t) => {
  let upstreamError;
  const { request, clients } = await fixture(t, { callImpl: () => { throw upstreamError; } });
  await request('/api/connect', { method: 'POST', body: { token: SECRET } });
  for (const fields of [{ status: 429, code: 'HTTP_429' }, { status: 500 }, { code: 'BUSINESS_ERROR' }, {}]) {
    upstreamError = Object.assign(new Error(`UNAUTHORIZED HTTP 401 ${SECRET}`), fields);
    for (const path of ['/api/tool', '/api/nutrition']) {
      const response = await request(path, { method: 'POST', body: path === '/api/tool' ? { name: 'query-meals' } : {} });
      assert.equal(response.status, 502);
      assert.equal(response.text.includes(SECRET), false);
      assert.equal(clients[0].closed, false);
      assert.equal((await request('/api/status')).json().connected, true);
    }
  }
});

test('旧连接迟到的认证失败不能清除或关闭新连接', async (t) => {
  let rejectOld;
  const oldResult = new Promise((resolve, reject) => { rejectOld = reject; });
  const { request, clients, calls } = await fixture(t, {
    callImpl: function () {
      return this.token === SECRET ? oldResult : { structuredContent: { success: true, data: [] } };
    },
  });
  await request('/api/connect', { method: 'POST', body: { token: SECRET } });
  const pending = request('/api/tool', { method: 'POST', body: { name: 'query-meals' } });
  while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request('/api/connect', { method: 'POST', body: { token: 'replacement-test-token' } })).status, 200);
  assert.equal(clients[0].closed, true);
  rejectOld(Object.assign(new Error(SECRET), { status: 401, code: 'HTTP_401' }));
  const failure = await pending;
  assert.equal(failure.status, 401);
  assert.equal(failure.text.includes(SECRET), false);
  assert.equal((await request('/api/status')).json().connected, true);
  assert.equal(clients[1].closed, false);
  assert.equal((await request('/api/tool', { method: 'POST', body: { name: 'query-meals' } })).status, 200);
});

test('握手认证错误也返回 401 并清理候选客户端', async (t) => {
  const { request, clients } = await fixture(t, { initializeError: Object.assign(new Error(SECRET), { status: 403 }) });
  const response = await request('/api/connect', { method: 'POST', body: { token: SECRET } });
  assert.equal(response.status, 401);
  assert.equal(response.text.includes(SECRET), false);
  assert.equal(clients[0].closed, true);
  assert.equal((await request('/api/status')).json().connected, false);
});

test('静态首页仍可访问，API 不可通过 GET 执行', async (t) => {
  const { request } = await fixture(t);
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.equal((await request('/api/connect')).status, 405);
  assert.equal((await request('/api/unknown', { method: 'POST', body: {} })).status, 404);
  assert.equal((await request('/%2e%2e%2fserver.mjs')).status, 403);
});
