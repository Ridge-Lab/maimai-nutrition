import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuote } from '../dist/quote.mjs';

// Sanitized shape of the one read-only live calculate-price result: store
// 1450713, orderType=1, beType=1, ordinary product 1440 x1, no card/withOrder.
const liveShape = () => ({
  success: true, code: 200, message: '请求成功', datetime: '2026-10-15 18:01:18', traceId: 'test-trace',
  data: {
    productOriginalPrice: 2250, productPrice: 2250, originalPrice: 2250, discount: 0, price: 2250,
    productList: [{ productCode: '1440', productName: '麦辣鸡腿汉堡', quantity: 1, originalSubtotal: 2250, subtotal: 2250 }],
    takeWayList: [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }, { code: 'locker-out', title: '外带', subtitle: '店外取餐柜' }],
  },
});

test('verified integer fen converts to yuan; absent fee breakdown remains unknown', () => {
  const result = parseQuote({ isError: false, structuredContent: liveShape() });
  assert.equal(result.amount, 22.5);
  assert.equal(result.amountMinor, 2250);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.originalAmount, 22.5);
  assert.equal(result.discountAmount, 0);
  assert.equal(result.productAmount, 22.5);
  assert.equal(result.deliveryAmount, null);
  assert.equal(result.packingAmount, null);
  assert.equal(result.tablewareAmount, null);
  assert.equal(result.enjoyed, null);
  assert.equal(result.quotedAt, '2026-10-15 18:01:18');
  assert.equal(result.validUntil, null);
  assert.deepEqual(result.products, [{ productCode: '1440', productName: '麦辣鸡腿汉堡', quantity: 1, amount: 22.5, originalAmount: 22.5 }]);
});

test('supports structured result, JSON envelope, RPC result, and official text wrapper', () => {
  const source = liveShape();
  const wrappers = [source, JSON.stringify(source), { jsonrpc: '2.0', id: 1, result: { structuredContent: source } },
    { httpStatus: 200, result: { content: [{ type: 'text', text: JSON.stringify(source) }] } },
    { content: [{ type: 'text', text: '# API Response Information\n\n## Response Structure\n\nSchema text.\n\n## Original Response\n\n' + JSON.stringify(source) }] },
    { content: [{ type: 'text', text: '## Original Response\n\n```json\n' + JSON.stringify(source) + '\n```' }] }];
  for (const wrapper of wrappers) assert.equal(parseQuote(wrapper).amount, 22.5);
});

test('known fee fields use fen independently and valid explicit zero remains zero', () => {
  const source = liveShape();
  Object.assign(source.data, { price: 0, deliveryPrice: 600, deliveryOriginalPrice: 700,
    packingPrice: 150, packingOriginalPrice: 200, tablewarePrice: 10, discount: 2100 });
  const result = parseQuote(source);
  assert.equal(result.amount, 0);
  assert.equal(result.deliveryAmount, 6);
  assert.equal(result.deliveryOriginalAmount, 7);
  assert.equal(result.packingAmount, 1.5);
  assert.equal(result.packingOriginalAmount, 2);
  assert.equal(result.tablewareAmount, 0.1);
  assert.equal(result.discountAmount, 21);
});

test('promotion realDiscount is yuan or tenths by amountType, while balance stays fen', () => {
  for (const [amountType, realDiscount, valueUnit] of [['1', 18, 'CNY'], ['2', 7.5, 'discount-tenths'], ['3', 5, 'CNY']]) {
    const source = liveShape();
    source.data.enjoyed = { amountType, realDiscount };
    source.data.enjoyable = { amountType, realDiscount, balance: 350 };
    const result = parseQuote(source);
    assert.deepEqual(result.enjoyed, { amountType, realDiscount, valueUnit, balanceMinor: null, balanceAmount: null });
    assert.deepEqual(result.enjoyable, { amountType, realDiscount, valueUnit, balanceMinor: 350, balanceAmount: 3.5 });
    assert.equal(result.amount, 22.5, 'do not recalculate server total from promotion hints');
  }
  const source = liveShape();
  source.data.enjoyed = { amountType: 'future-type', realDiscount: 7.5 };
  assert.equal(parseQuote(source).enjoyed.valueUnit, null, 'unknown promotion types are never guessed');
});

test('missing, invalid, or menu yuan prices never silently become a zero quote', () => {
  for (const price of [undefined, null, '22.5', '2250', false, -1, 22.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const source = liveShape(); source.data.price = price;
    assert.throws(() => parseQuote(source), /price/);
  }
  assert.throws(() => parseQuote({ data: { currentPrice: '22.5', originalPrice: '22.5' } }), /price/);
});

test('business/tool/HTTP/RPC failure rejects even if a price happens to be present', () => {
  const cases = [
    { success: false, code: 400, message: '门店已关闭', data: { price: 0 } },
    { success: true, code: 4001, message: '餐品已售罄', data: { price: 2250 } },
    { isError: true, structuredContent: liveShape() },
    { jsonrpc: '2.0', id: 1, error: { code: -32602, message: '参数错误' } },
    { httpStatus: 429, result: liveShape() },
    { content: [{ type: 'text', text: JSON.stringify({ success: false, message: '优惠失效', data: { price: 0 } }) }] },
  ];
  for (const result of cases) assert.throws(() => parseQuote(result), Error);
});

test('invalid shape, malformed optional monetary fields, and ambiguous text responses reject', () => {
  const cases = [null, {}, [], 'unknown', { data: null },
    { content: [{ type: 'text', text: JSON.stringify(liveShape()) }, { type: 'text', text: JSON.stringify(liveShape()) }] }];
  for (const result of cases) assert.throws(() => parseQuote(result), Error);
  for (const field of ['discount', 'deliveryPrice', 'packingPrice', 'tablewarePrice']) {
    const source = liveShape(); source.data[field] = '0';
    assert.throws(() => parseQuote(source), Error);
  }
  const source = liveShape(); source.data.productList[0].quantity = 1.5;
  assert.throws(() => parseQuote(source), /数量/);
});

test('does not invent quote time/deadline, missing item subtotal, or missing discount', () => {
  const source = { data: { price: 2250, productList: [{ productCode: '1440' }] } };
  const result = parseQuote(source);
  assert.equal(result.quotedAt, null);
  assert.equal(result.validUntil, null);
  assert.equal(result.discountAmount, null);
  assert.equal(result.products[0].amount, null);
  assert.equal(result.products[0].quantity, null);
});
