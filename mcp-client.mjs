// Node >=22, no dependencies. Tokens stay in this instance's memory only.
// A method call is a user-initiated operation; there are no timers for polling,
// retries, order tools, background connections, or configurable remote URLs.
export const MCP_ENDPOINT = 'https://mcp.mcd.cn';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const ALLOWED_TOOLS = Object.freeze([
  'list-nutrition-foods', 'query-nearby-stores', 'query-meals',
  'query-meal-detail', 'calculate-price',
]);
const allowed = new Set(ALLOWED_TOOLS);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class McdError extends Error {
  constructor(message, { code = 'MCP_ERROR', status, retryAfter } = {}) {
    super(message);
    this.name = 'McdError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined && retryAfter !== null) this.retryAfter = retryAfter;
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Recognize documented business envelopes, not arbitrary product `code` values.
function businessFailure(value) {
  if (!isObject(value)) return null;
  if (value.success === false) return value;
  if (own(value, 'success') && own(value, 'code') &&
      ![200, 0, '200', '0'].includes(value.code)) return value;
  if (!own(value, 'success') && own(value, 'data') && own(value, 'message') &&
      Number.isFinite(Number(value.code)) && Number(value.code) >= 400) return value;
  return null;
}

function resultPayloads(result) {
  if (!isObject(result)) return [result];
  const payloads = [];
  if (own(result, 'structuredContent')) payloads.push(result.structuredContent);
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        payloads.push(parseJson(block.text) ?? block.text);
      }
    }
  }
  return payloads.length ? payloads : [result];
}

function failureMessage(value, fallback) {
  if (typeof value?.message === 'string' && value.message.trim()) return value.message;
  if (typeof value?.error?.message === 'string') return value.error.message;
  if (Array.isArray(value?.content)) {
    const texts = value.content.filter(v => v?.type === 'text' && typeof v.text === 'string');
    if (texts.length) return texts.map(v => v.text).join('\n');
  }
  return fallback;
}

export class McdClient {
  #token;
  #fetch;
  #timeoutMs;
  #session;
  #initialized;
  #initializing;
  #tools;
  #id = 0;
  #closed = false;
  #controllers = new Set();

  constructor(token, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    if (typeof token !== 'string' || !token.trim() || /\s/u.test(token)) {
      throw new McdError('请提供有效的个人 MCP Token（不要包含 Bearer 前缀或空白）。', { code: 'TOKEN_REQUIRED' });
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new TypeError('timeoutMs must be between 1 and 120000');
    }
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  #safe(text) {
    let message = String(text ?? 'MCP 请求失败');
    if (this.#token) message = message.split(this.#token).join('[REDACTED]');
    return message.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').slice(0, 1500);
  }

  #assertOpen() {
    if (this.#closed) throw new McdError('MCP 客户端已关闭，请重新连接。', { code: 'CLIENT_CLOSED' });
  }

  async initialize() {
    this.#assertOpen();
    if (this.#initialized) return this.#initialized;
    if (this.#initializing) return this.#initializing;
    this.#initializing = (async () => {
      const result = await this.#request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'maimai-nutrition-local', version: '0.1.0' },
      });
      if (result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
        throw new McdError('服务端未协商到受支持的 MCP 协议版本。', { code: 'PROTOCOL_VERSION' });
      }
      await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.#assertOpen();
      this.#initialized = result;
      return result;
    })();
    try { return await this.#initializing; }
    catch (error) { this.#session = undefined; throw error; }
    finally { this.#initializing = undefined; }
  }

  async tools() {
    await this.initialize();
    const tools = [];
    let cursor;
    const seen = new Set();
    // Pagination is protocol metadata discovery only, never a business tool call.
    do {
      const page = await this.#request('tools/list', cursor ? { cursor } : {});
      if (!isObject(page) || !Array.isArray(page.tools)) {
        throw new McdError('tools/list 未返回有效工具列表。', { code: 'INVALID_TOOLS' });
      }
      for (const tool of page.tools) {
        if (isObject(tool) && allowed.has(tool.name)) tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        if (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 30) {
          throw new McdError('tools/list 分页游标异常，请重新连接。', { code: 'INVALID_TOOLS' });
        }
        seen.add(cursor);
      } else cursor = undefined;
    } while (cursor);
    this.#tools = new Map(tools.map(tool => [tool.name, tool]));
    return { tools };
  }

  async call(name, args = {}) {
    this.#assertOpen();
    // Enforced before initialization/network access, including create-order.
    if (!allowed.has(name)) throw new McdError('此工具不在只读白名单中。', { code: 'TOOL_NOT_ALLOWED' });
    if (!isObject(args)) throw new McdError('工具参数必须是 JSON 对象。', { code: 'INVALID_ARGUMENTS' });
    if (!this.#tools) await this.tools();
    if (!this.#tools.has(name)) {
      throw new McdError('当前官方会话未提供该工具，请以 tools/list 为准。', { code: 'TOOL_UNAVAILABLE' });
    }
    // Arguments are passed unchanged. The returned inputSchema is authoritative;
    // we do not invent required fields, product codes, or menu/nutrition mappings.
    const result = await this.#request('tools/call', { name, arguments: args });
    if (result?.isError === true) {
      throw new McdError(this.#safe(failureMessage(result, '官方工具执行失败。')), { code: 'TOOL_ERROR' });
    }
    for (const payload of resultPayloads(result)) {
      const failure = businessFailure(payload);
      if (failure) {
        throw new McdError(this.#safe(failureMessage(failure, '官方业务请求失败。')), {
          code: this.#safe(failure.code ?? 'BUSINESS_ERROR'),
        });
      }
    }
    return result;
  }

  // Local cleanup only. No background DELETE or subsequent requests are sent.
  close() {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#session = undefined;
    this.#initialized = undefined;
    this.#tools = undefined;
    this.#token = '';
  }

  async #request(method, params) {
    return this.#post({ jsonrpc: '2.0', id: ++this.#id, method, params });
  }

  async #post(message) {
    this.#assertOpen();
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new McdError('官方 MCP 请求超时，请稍后手动重试。', { code: 'TIMEOUT' }));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([this.#exchange(message, controller.signal), timeout]);
    } catch (error) {
      if (timedOut) throw new McdError('官方 MCP 请求超时，请稍后手动重试。', { code: 'TIMEOUT' });
      if (this.#closed) throw new McdError('MCP 客户端已关闭。', { code: 'CLIENT_CLOSED' });
      if (error instanceof McdError) throw error;
      throw new McdError(this.#safe(error?.message || '无法连接官方 MCP 服务。'), { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async #exchange(message, signal) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.#token}`,
    };
    if (message.method !== 'initialize') headers['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION;
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    const response = await this.#fetch(MCP_ENDPOINT, {
      method: 'POST', headers, body: JSON.stringify(message), signal, redirect: 'error',
    });
    this.#assertOpen();
    if (!response.ok) {
      const body = await this.#readText(response);
      const parsed = parseJson(body);
      const detail = failureMessage(parsed?.error ?? parsed, body || response.statusText);
      const prefix = response.status === 401 ? 'Token 无效、过期或未授权。' :
        response.status === 429 ? '官方服务限流，请稍后手动重试。' : `官方 MCP HTTP ${response.status}。`;
      if (response.status === 404 && this.#session) {
        // Stop this operation; a later explicit call initializes a new session.
        this.#session = undefined;
        this.#initialized = undefined;
        this.#tools = undefined;
      }
      throw new McdError(this.#safe(`${prefix}${detail ? ` ${detail}` : ''}`), {
        status: response.status, code: `HTTP_${response.status}`,
        retryAfter: this.#safe(response.headers.get('retry-after') ?? '') || undefined,
      });
    }
    if (!own(message, 'id')) {
      if (response.status !== 202 && response.status !== 204) {
        await response.body?.cancel();
        throw new McdError('官方 MCP 未按协议确认 initialized 通知。', { code: 'INVALID_NOTIFICATION_RESPONSE' });
      }
      await response.body?.cancel();
      return undefined;
    }
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    let rpc;
    if (type === 'application/json') rpc = parseJson(await this.#readText(response));
    else if (type === 'text/event-stream') rpc = await this.#readSse(response, message.id);
    else {
      await response.body?.cancel();
      throw new McdError('官方 MCP 返回了不支持的响应格式。', { code: 'INVALID_CONTENT_TYPE' });
    }
    if (!isObject(rpc) || rpc.jsonrpc !== '2.0' || rpc.id !== message.id ||
        (!own(rpc, 'result') && !own(rpc, 'error'))) {
      throw new McdError('官方 MCP 返回无效或不匹配的 JSON-RPC 响应。', { code: 'INVALID_RPC' });
    }
    if (own(rpc, 'error')) {
      throw new McdError(this.#safe(failureMessage(rpc.error, '官方 MCP 协议错误。')), {
        code: this.#safe(rpc.error?.code ?? 'RPC_ERROR'),
      });
    }
    if (!isObject(rpc.result)) throw new McdError('MCP result 必须是结构化对象。', { code: 'INVALID_RESULT' });
    if (message.method === 'initialize') {
      const session = response.headers.get('mcp-session-id');
      if (session !== null) {
        if (!/^[\x21-\x7e]+$/.test(session)) throw new McdError('官方返回了无效会话标识。', { code: 'INVALID_SESSION' });
        this.#session = session;
      }
    }
    return rpc.result;
  }

  async #readText(response) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new McdError('官方响应超过本地大小限制。', { code: 'RESPONSE_TOO_LARGE' });
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async #readSse(response, requestId) {
    if (!response.body) throw new McdError('MCP SSE 响应为空。', { code: 'INVALID_SSE' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let data = [];
    let bytes = 0;
    const event = () => {
      if (!data.length) return undefined;
      const text = data.join('\n');
      data = [];
      const rpc = parseJson(text);
      if (!isObject(rpc)) throw new McdError('MCP SSE 含无效 JSON。', { code: 'INVALID_SSE' });
      return rpc.id === requestId && (own(rpc, 'result') || own(rpc, 'error')) ? rpc : undefined;
    };
    const line = value => {
      if (value === '') return event();
      if (value.startsWith(':')) return undefined;
      const colon = value.indexOf(':');
      const field = colon < 0 ? value : value.slice(0, colon);
      let content = colon < 0 ? '' : value.slice(colon + 1);
      if (content.startsWith(' ')) content = content.slice(1);
      if (field === 'data') data.push(content);
      return undefined;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new McdError('官方响应超过本地大小限制。', { code: 'RESPONSE_TOO_LARGE' });
          pending += decoder.decode(value, { stream: true });
        }
        if (done) pending += decoder.decode();
        while (true) {
          const match = /\r\n|\n|\r/.exec(pending);
          if (!match) break;
          // A trailing CR can be half of a CRLF split across network chunks.
          if (!done && match[0] === '\r' && match.index === pending.length - 1) break;
          const value = pending.slice(0, match.index).replace(/^\uFEFF/, '');
          pending = pending.slice(match.index + match[0].length);
          const rpc = line(value);
          if (rpc) return rpc;
        }
        if (done) break;
      }
      throw new McdError('MCP SSE 结束前未收到本次请求的完整响应。', { code: 'INVALID_SSE' });
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export const NUTRITION_FIELDS = Object.freeze([
  'productName', 'nutritionDescription', 'energyKj', 'energyKcal',
  'protein', 'fat', 'carbohydrate', 'sodium', 'calcium',
]);
// Official units: energyKj=kJ, energyKcal=kcal, protein/fat/carbohydrate=g,
// sodium/calcium=mg. No per-100g conversion, ingredient estimate or code mapping.
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function foodRow(row) {
  if (!isObject(row)) throw new McdError('营养条目必须是对象。', { code: 'INVALID_NUTRITION' });
  const food = {};
  for (const key of NUTRITION_FIELDS) {
    food[key] = key === 'productName' || key === 'nutritionDescription' ?
      (typeof row[key] === 'string' ? row[key] : null) : numeric(row[key]);
  }
  return food;
}

function toonCells(line, delimiter = ',') {
  const cells = [];
  let cell = '';
  let quoted = false;
  let escaped = false;
  for (const char of line) {
    if (quoted) {
      cell += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; cell += char; }
    else if (char === delimiter) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  if (quoted) throw new McdError('TOON 字符串未闭合。', { code: 'INVALID_NUTRITION' });
  cells.push(cell.trim());
  return cells.map(value => {
    if (value === 'null') return null;
    if (value.startsWith('"')) {
      const parsed = parseJson(value);
      if (typeof parsed !== 'string') throw new McdError('TOON 字符串格式无效。', { code: 'INVALID_NUTRITION' });
      return parsed;
    }
    return value;
  });
}

function parseToon(text) {
  const lines = text.trim().split(/\r\n|\n|\r/).filter(line => line.trim());
  if (!lines.length) throw new McdError('官方营养数据为空。', { code: 'INVALID_NUTRITION' });
  // Only the documented tabular TOON form; do not infer unknown field positions.
  const header = /^\s*(?:[A-Za-z_][\w-]*)?\[(\d+)(?:([,\t|]))?\]\{([^}]*)\}:\s*$/.exec(lines[0]);
  if (!header) throw new McdError('官方营养 TOON 表头不受支持。', { code: 'INVALID_NUTRITION' });
  const count = Number(header[1]);
  const delimiter = header[2] || ',';
  const fields = header[3].split(delimiter).map(value => value.trim());
  if (!fields.includes('productName') || new Set(fields).size !== fields.length || fields.some(field => !field)) {
    throw new McdError('官方营养 TOON 字段无法识别。', { code: 'INVALID_NUTRITION' });
  }
  if (lines.length - 1 !== count) throw new McdError('官方营养 TOON 行数不完整。', { code: 'INVALID_NUTRITION' });
  return lines.slice(1).map(line => {
    const cells = toonCells(line.trim(), delimiter);
    if (cells.length !== fields.length) throw new McdError('官方营养 TOON 列数不匹配。', { code: 'INVALID_NUTRITION' });
    return foodRow(Object.fromEntries(fields.map((field, index) => [field, cells[index]])));
  });
}

function unwrapNutrition(value, depth = 0) {
  if (depth > 8) throw new McdError('营养响应嵌套过深。', { code: 'INVALID_NUTRITION' });
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    return parsed === undefined ? parseToon(value) : unwrapNutrition(parsed, depth + 1);
  }
  if (Array.isArray(value)) return value.map(foodRow);
  if (!isObject(value)) throw new McdError('无法识别官方营养响应。', { code: 'INVALID_NUTRITION' });
  const failure = businessFailure(value);
  if (failure) throw new McdError(failureMessage(failure, '营养工具请求失败。'), { code: 'NUTRITION_ERROR' });
  if (value.isError === true) throw new McdError('营养工具执行失败。', { code: 'NUTRITION_ERROR' });
  if (own(value, 'structuredContent')) return unwrapNutrition(value.structuredContent, depth + 1);
  if (own(value, 'data')) return unwrapNutrition(value.data, depth + 1);
  if (Array.isArray(value.content)) {
    const texts = value.content.filter(block => block?.type === 'text' && typeof block.text === 'string');
    if (!texts.length) throw new McdError('营养响应没有文本或结构化数据。', { code: 'INVALID_NUTRITION' });
    const rows = texts.map(block => unwrapNutrition(block.text, depth + 1));
    return rows.flat();
  }
  // Explicit JSON alternatives use the same official row keys.
  if (Array.isArray(value.foods)) return value.foods.map(foodRow);
  if (Array.isArray(value.items)) return value.items.map(foodRow);
  if (own(value, 'productName')) return [foodRow(value)];
  throw new McdError('无法识别官方营养响应结构，请检查最新 tools/list 与官方文档。', { code: 'INVALID_NUTRITION' });
}

export function parseNutrition(result) {
  return unwrapNutrition(result);
}
