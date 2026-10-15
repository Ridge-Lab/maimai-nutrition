// calculate-price response parser. The official response schema uses integer
// fen for price/subtotals/fees, unlike query-meals.currentPrice (string yuan).
// Verified once against the user's selected local connection on 2026-10-15.
// This module performs no requests and never creates or pays for an order.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid(message) { throw new Error(`无法读取官方报价：${message}`); }

function failure(value) {
  if (!object(value)) return;
  if (value.isError === true) invalid('工具执行失败，请查看官方返回信息。');
  if (own(value, 'error')) invalid(typeof value.error?.message === 'string' ? value.error.message : '官方接口返回错误。');
  if (value.success === false || (own(value, 'success') && own(value, 'code') && ![200, '200', 0, '0'].includes(value.code))) {
    invalid(typeof value.message === 'string' ? value.message : '官方业务请求失败。');
  }
  if (!own(value, 'success') && own(value, 'data') && own(value, 'message') &&
      Number.isFinite(Number(value.code)) && Number(value.code) >= 400) {
    invalid(typeof value.message === 'string' ? value.message : '官方业务请求失败。');
  }
}

function jsonText(text) {
  try { return JSON.parse(text); } catch {}
  // The live server supplies both structuredContent and this documented text
  // wrapper. Read the exact Original Response section, never schema examples.
  const marker = '## Original Response';
  const index = text.lastIndexOf(marker);
  if (index >= 0) {
    let original = text.slice(index + marker.length).trim();
    if (/^```(?:json)?\s*\n/.test(original) && /\n```$/.test(original)) {
      original = original.replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '').trim();
    }
    try { return JSON.parse(original); } catch {}
  }
  invalid('响应不是受支持的结构化数据。');
}

function unwrap(input, depth = 0) {
  if (depth > 8) invalid('响应嵌套过深。');
  if (typeof input === 'string') return unwrap(jsonText(input), depth + 1);
  if (!object(input)) invalid('响应为空或格式未知。');
  failure(input);
  if (own(input, 'httpStatus') && (input.httpStatus < 200 || input.httpStatus >= 300)) invalid('请求未成功。');
  if (own(input, 'structuredContent')) return unwrap(input.structuredContent, depth + 1);
  if (own(input, 'result')) return unwrap(input.result, depth + 1);
  if (Array.isArray(input.content)) {
    const blocks = input.content.filter(block => block?.type === 'text' && typeof block.text === 'string');
    if (blocks.length !== 1) invalid('无法唯一确定报价响应。');
    return unwrap(blocks[0].text, depth + 1);
  }
  if (own(input, 'data')) {
    if (!object(input.data)) invalid('报价 data 不是对象。');
    failure(input.data);
    return { data: input.data, envelope: input };
  }
  if (own(input, 'price')) return { data: input, envelope: {} };
  invalid('没有 calculate-price 报价数据。');
}

function fen(value, field, required = false) {
  if (value === null || value === undefined) {
    if (required) invalid(`缺少 ${field}，不能确定实付金额。`);
    return null;
  }
  // Do not coerce strings: menu values use a different unit and must not enter
  // this path by mistake. Missing/unknown amounts are never assumed to be zero.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${field} 必须是官方整数分金额。`);
  }
  return value;
}

function yuan(value, field) {
  const minor = fen(value, field);
  return minor === null ? null : minor / 100;
}

function text(value) { return typeof value === 'string' && value.trim() ? value : null; }

function promotion(value, field) {
  if (value === null || value === undefined) return null;
  if (!object(value)) invalid(`${field} 优惠信息格式未知。`);
  const amountType = text(value.amountType);
  let realDiscount = value.realDiscount ?? null;
  if (realDiscount !== null && (typeof realDiscount !== 'number' || !Number.isFinite(realDiscount) || realDiscount < 0)) {
    invalid(`${field}.realDiscount 格式未知。`);
  }
  // For types 1/3 this value is yuan; for type 2 it is a discount in tenths
  // (7.5 means 七五折), NOT an amount to subtract or divide by 100.
  const valueUnit = amountType === '2' ? 'discount-tenths' :
    amountType === '1' || amountType === '3' ? 'CNY' : null;
  const balanceMinor = fen(value.balance, `${field}.balance`);
  return { amountType, realDiscount, valueUnit,
    balanceMinor, balanceAmount: balanceMinor === null ? null : balanceMinor / 100 };
}

function products(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) invalid('productList 不是数组。');
  return value.map((item, index) => {
    if (!object(item)) invalid(`productList[${index}] 格式未知。`);
    const quantity = item.quantity ?? null;
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity <= 0)) invalid('商品数量格式未知。');
    return {
      productCode: text(item.productCode), productName: text(item.productName), quantity,
      amount: yuan(item.subtotal, 'subtotal'), originalAmount: yuan(item.originalSubtotal, 'originalSubtotal'),
    };
  });
}

export function parseQuote(result) {
  const { data, envelope } = unwrap(result);
  const amountMinor = fen(data.price, 'price', true);
  return {
    amount: amountMinor / 100,
    currency: 'CNY',
    amountMinor,
    originalAmount: yuan(data.originalPrice, 'originalPrice'),
    discountAmount: yuan(data.discount, 'discount'),
    productAmount: yuan(data.productPrice, 'productPrice'),
    productOriginalAmount: yuan(data.productOriginalPrice, 'productOriginalPrice'),
    deliveryAmount: yuan(data.deliveryPrice, 'deliveryPrice'),
    deliveryOriginalAmount: yuan(data.deliveryOriginalPrice, 'deliveryOriginalPrice'),
    packingAmount: yuan(data.packingPrice, 'packingPrice'),
    packingOriginalAmount: yuan(data.packingOriginalPrice, 'packingOriginalPrice'),
    tablewareAmount: yuan(data.tablewarePrice, 'tablewarePrice'),
    products: products(data.productList),
    enjoyed: promotion(data.enjoyed, 'enjoyed'),
    enjoyable: promotion(data.enjoyable, 'enjoyable'),
    quotedAt: text(envelope.datetime),
    // The verified schema supplies datetime, not a validity deadline. Never
    // invent a five-minute price guarantee or use local time as server time.
    validUntil: null,
    traceId: text(envelope.traceId),
  };
}
