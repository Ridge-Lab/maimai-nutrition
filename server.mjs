import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const BODY_LIMIT = 32 * 1024;
const ALLOWED_TOOLS = new Set(['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price']);
const AUTH_ERROR_CODES = new Set(['401', '403', 'HTTP_401', 'HTTP_403', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_TOKEN', 'TOKEN_EXPIRED']);
const AUTH_ERROR_MESSAGE = 'MCP 授权已失效或无权访问，请重新连接';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// McdClient exposes HTTP status and business/RPC code separately. Never infer
// authentication from free-form upstream messages, which may contain secrets.
function authenticationFailure(error) {
  return error?.status === 401 || error?.status === 403
    || AUTH_ERROR_CODES.has(typeof error?.code === 'string' ? error.code.trim().toUpperCase() : String(error?.code));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function singleHeader(req, name) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count === 1 ? req.headers[name] : undefined;
}

function verifyRequest(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(singleHeader(req, 'host'))) throw new HttpError(403, '仅接受本机访问');
  if (req.method === 'POST') {
    if (!hosts.map((host) => `http://${host}`).includes(singleHeader(req, 'origin'))) throw new HttpError(403, '拒绝跨站请求');
    const contentType = singleHeader(req, 'content-type');
    if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, '请求必须使用 application/json');
    }
  }
}

function readJson(req) {
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume();
    return Promise.reject(new HttpError(413, '请求内容过大'));
  }
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error) => { cleanup(); req.resume(); rejectBody(error); };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) return fail(new HttpError(413, '请求内容过大'));
      chunks.push(chunk);
    };
    const onError = () => fail(new HttpError(400, '请求读取失败'));
    const onAborted = () => fail(new HttpError(400, '请求已中止'));
    const onEnd = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolveBody(body);
      } catch { rejectBody(new HttpError(400, 'JSON 请求无效')); }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

async function dispose(client) {
  try {
    if (typeof client?.close === 'function') await client.close();
    else if (typeof client?.disconnect === 'function') await client.disconnect();
  } catch { /* Cleanup errors must never expose credentials. */ }
}

/** No account state is persisted. Dependency injection keeps security tests offline. */
export function createAppServer({ port = 4318, Client, parseNutrition: nutritionParser } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('端口无效');
  let connectedClient = null;
  const connectingClients = new Set();
  let generation = 0;
  const loadModule = () => import('./mcp-client.mjs');
  const clearConnections = async () => {
    const clients = [...connectingClients, connectedClient].filter(Boolean);
    connectedClient = null;
    connectingClients.clear();
    await Promise.all(clients.map(dispose));
  };
  const failQuery = async (client, error, message) => {
    if (!authenticationFailure(error)) throw new HttpError(502, message);
    // An in-flight call from an old connection may fail after reconnection.
    // It must never clear or close the replacement client.
    if (connectedClient === client) connectedClient = null;
    await dispose(client);
    throw new HttpError(401, AUTH_ERROR_MESSAGE);
  };

  const server = createServer(async (req, res) => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    try {
      verifyRequest(req, actualPort);
      const pathname = new URL(req.url, `http://127.0.0.1:${actualPort}`).pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/status' && req.method === 'GET') {
          json(res, 200, { local: true, connected: connectedClient !== null });
          return;
        }
        if (req.method !== 'POST') { json(res, 405, { error: '请求方法不支持' }); return; }
        const body = await readJson(req);
        if (pathname === '/api/connect') {
          const currentGeneration = ++generation;
          await clearConnections();
          let candidate = null;
          try {
            if (currentGeneration !== generation) throw new HttpError(409, '连接已被后续操作替换');
            if (typeof body.token !== 'string' || !body.token.trim() || /[\x00-\x1f\x7f]/.test(body.token)) throw new HttpError(400, 'Token 格式无效');
            const ClientClass = Client ?? (await loadModule()).McdClient;
            if (currentGeneration !== generation) throw new HttpError(409, '连接已被后续操作替换');
            candidate = new ClientClass(body.token.trim());
            connectingClients.add(candidate);
            await candidate.initialize();
            const result = await candidate.tools();
            const tools = Array.isArray(result) ? result : result?.tools;
            if (!Array.isArray(tools)) throw new Error();
            if (currentGeneration !== generation) throw new HttpError(409, '连接已被后续操作替换');
            connectedClient = candidate;
            connectingClients.delete(candidate);
            candidate = null;
            json(res, 200, { connected: true, tools: tools.filter((tool) => tool && typeof tool.name === 'string').map((tool) => ({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.inputSchema ?? {} })) });
          } catch (error) {
            connectingClients.delete(candidate);
            await dispose(candidate);
            if (currentGeneration === generation) connectedClient = null;
            throw error instanceof HttpError ? error : authenticationFailure(error)
              ? new HttpError(401, AUTH_ERROR_MESSAGE)
              : new HttpError(502, 'MCP 连接失败，请检查 Token 后重试');
          }
          return;
        }
        if (pathname === '/api/disconnect') {
          generation++;
          await clearConnections();
          json(res, 200, { connected: false });
          return;
        }
        if (pathname === '/api/nutrition' || pathname === '/api/tool') {
          const client = connectedClient;
          if (!client) throw new HttpError(409, '请先连接麦当劳 MCP');
          if (pathname === '/api/tool') {
            if (!ALLOWED_TOOLS.has(body.name)) throw new HttpError(403, '此工具未获允许');
            if (body.arguments !== undefined && (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments))) throw new HttpError(400, 'arguments 必须是对象');
            let result;
            try { result = await client.call(body.name, body.arguments ?? {}); }
            catch (error) { await failQuery(client, error, 'MCP 查询失败，请稍后重试'); }
            json(res, 200, result);
          } else {
            try {
              const result = await client.call('list-nutrition-foods', {});
              const parse = nutritionParser ?? (await loadModule()).parseNutrition;
              const parsed = parse(result);
              const foods = Array.isArray(parsed) ? parsed : parsed?.foods;
              if (!Array.isArray(foods)) throw new Error();
              json(res, 200, { foods, fetchedAt: new Date().toISOString(), source: 'official-mcp' });
            } catch (error) { await failQuery(client, error, '官方营养数据读取失败，请稍后重试'); }
          }
          return;
        }
        json(res, 404, { error: '接口不存在' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      try {
        const decoded = decodeURIComponent(pathname);
        const path = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
        if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
        if (!(await stat(path)).isFile()) throw new Error();
        const content = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('页面不存在'); }
    } catch (error) {
      req.resume();
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '本机服务暂时无法处理请求' });
      else res.end();
    }
  });
  server.on('close', () => { generation++; void clearConnections(); });
  return server;
}

const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const port = Number(process.env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 到 65535 的整数');
  const server = createAppServer({ port });
  server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
}
