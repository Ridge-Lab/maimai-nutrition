import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult, parseStores, normalizeMenu } from '../dist/live-menu.mjs';

const envelope = (data) => ({ isError: false, structuredContent: { success: true, code: 200, data } });
const nutrition = (productName, energyKcal, extra = {}) => ({ productName, energyKcal, energyKj: 1000, protein: 10, sodium: 100, fat: 5, carbohydrate: 20, calcium: 10, ...extra });
function menu(entries, category = '鸡肉汉堡\n/卷') {
  return envelope({ categories: [{ name: category, meals: Object.keys(entries).map((code) => ({ code })) }], meals: entries });
}

test('优先读取真实 structuredContent；可提取带说明的 JSON，业务失败不当空数据', () => {
  const value = { categories: [], meals: {} };
  assert.deepEqual(unwrapResult({ ...envelope(value), content: [{ type: 'text', text: '不是 JSON' }] }), value);
  assert.deepEqual(unwrapResult({ content: [{ type: 'text', text: '说明 data.{code}\n{"success":true,"code":200,"data":[{"storeCode":"1450713","storeName":"公开示例门店"}]}\n结束' }] }), [{ storeCode: '1450713', storeName: '公开示例门店' }]);
  assert.throws(() => unwrapResult({ isError: true, structuredContent: { data: [] } }));
  assert.throws(() => unwrapResult({ success: false, code: 500, data: [] }));
  assert.throws(() => unwrapResult({ content: [{ type: 'text', text: '没有返回结构化数据' }] }));
});

test('门店只输出公开必要字段、稳定去重，不把示例距离当用户距离', () => {
  const result = parseStores(envelope([{ storeCode: '1450713', storeName: '公开示例门店', address: '公开地址', distance: 144 }, { storeCode: '1450713', storeName: '重复项' }]));
  assert.deepEqual(result, [{ code: '1450713', name: '公开示例门店', address: '公开地址' }]);
  assert.throws(() => parseStores(envelope({})), /缺少列表/);
});

test('实测菜单 map 按分类关联，保留 productCode、展示图和元字符串参考价', () => {
  const result = normalizeMenu(menu({ '1440': { name: '麦辣鸡腿汉堡', currentPrice: '22.5', originalPrice: '22.5', image: 'https://menu-img.mcd.cn/example.png', canWithOrder: false } }), [nutrition('麦辣鸡腿汉堡', 485)]);
  const food = result.foods[0];
  assert.equal(food.productCode, '1440');
  assert.equal(food.kcal, 485);
  assert.equal(food.price, 22.5);
  assert.equal(food.priceMode, 'menu-reference');
  assert.equal(food.referenceSource, 'official-mcp-menu');
  assert.equal(food.nutritionMatch, 'exact');
  assert.equal(food.image, 'https://menu-img.mcd.cn/example.png');
  assert.deepEqual(result.stats, { total: 1, displayed: 1, matched: 1, unknown: 0, ambiguous: 0, meals: 0, conditionalPrices: 0, filteredNonFood: 0 });
});

test('真实附购会员价不当无需购卡的价格；普通促销可以保留参考价', () => {
  const result = normalizeMenu(menu({
    member: { name: '巨无霸四件套', currentPrice: '32', originalPrice: '58.5', canWithOrder: true, discountType: '随单购麦金卡优惠', withOrder: { membershipCode: '106', specId: '880' } },
    promotion: { name: '麦咖啡™美式', currentPrice: '11.9', discountType: '促销优惠' },
    card: { name: '测试汉堡', currentPrice: '9.9', discountType: '麦金卡优惠' },
  }), []);
  assert.equal(result.foods[0].price, null);
  assert.equal(result.foods[0].conditionalPrice, 32);
  assert.equal(result.foods[1].price, 11.9);
  assert.equal(result.foods[2].price, null);
});

test('未注明份型的薯条、玉米、麦乐鸡和咖啡不凭名称或编号猜规格', () => {
  const result = normalizeMenu(menu({ '4810': { name: '薯条', currentPrice: '13.5' }, '4437': { name: '玉米杯', currentPrice: '13' }, '1401': { name: '麦乐鸡', currentPrice: '14' }, coffee: { name: '卡布奇诺', currentPrice: '21' } }, '小食甜品\n/其他'), [nutrition('中薯条', 289), nutrition('小薯条', 210), nutrition('小杯玉米杯', 53), nutrition('麦乐鸡5块', 213), nutrition('卡布奇诺中杯', 167)]);
  assert.equal(result.foods.length, 4);
  assert.equal(result.foods.every((food) => food.kcal === null), true);
  assert.equal(result.stats.unknown, 4);
});

test('只允许完整同名或明确份型别名，字形括号差异可规范化', () => {
  const result = normalizeMenu(menu({ cola: { name: '中杯无糖可口可乐', currentPrice: '9.5' }, milk: { name: '纯牛奶(盒装)', currentPrice: '10.5' }, corn: { name: '玉米杯（小杯）', currentPrice: '13' }, flavor: { name: '那么大鸡排（椒盐风味）', currentPrice: '14' } }, '饮品'), [nutrition('无糖可口可乐中杯', 0), nutrition('纯牛奶（盒装）', 129), nutrition('小杯玉米杯', 53), nutrition('那么大鸡排', 385)]);
  assert.deepEqual(result.foods.map((food) => food.kcal), [0, 129, 53, 385]);
  assert.deepEqual(result.foods.map((food) => food.nutritionMatch), ['alias', 'exact', 'alias', 'official-page']);
});

test('同名同营养重复可去重，同名不同营养一律不匹配', () => {
  const result = normalizeMenu(menu({ a: { name: '小杯玉米杯', currentPrice: '13' }, b: { name: '汉堡', currentPrice: '12' } }), [nutrition('小杯玉米杯', 53), nutrition('小杯玉米杯', 53), nutrition('汉堡', 200), nutrition('汉堡', 300)]);
  assert.equal(result.foods[0].kcal, 53);
  assert.equal(result.foods[1].kcal, null);
  assert.equal(result.foods[1].nutritionMatch, 'ambiguous');
  assert.equal(result.stats.ambiguous, 1);
});

test('套餐未展开即使同名也不套营养；缺kcal不由kJ推算', () => {
  const result = normalizeMenu(menu({ combo: { name: '麦辣鸡腿汉堡三件套', currentPrice: '33.5' }, item: { name: '新餐品', currentPrice: '5' } }), [nutrition('麦辣鸡腿汉堡三件套', 900), nutrition('新餐品', null, { energyKj: 1000 })]);
  assert.equal(result.foods[0].isMeal, true);
  assert.equal(result.foods[0].kcal, null);
  assert.equal(result.foods[0].protein, null);
  assert.equal(result.foods[1].kcal, null);
});

test('不从originalPrice或格式不明的数值补价格，合法0保留', () => {
  const result = normalizeMenu(menu({ a: { name: 'A', originalPrice: '20' }, b: { name: 'B', currentPrice: '¥10' }, c: { name: 'C', currentPrice: '0' }, d: { name: 'D', currentPrice: '-1' } }), []);
  assert.deepEqual(result.foods.map((food) => food.price), [null, null, 0, null]);
});

test('过滤周边/会员卡但保留新餐品未知营养；官方类名优先决定展示类目', () => {
  const result = normalizeMenu(menu({ a: { name: '旋旋水手帽', currentPrice: '48.8' }, b: { name: '麦当劳联名徽章', currentPrice: '34.9' }, c: { name: '早餐卡', currentPrice: '19.9' }, d: { name: '全新饮品', currentPrice: '9.5' } }, '饮品'), []);
  assert.equal(result.stats.filteredNonFood, 3);
  assert.equal(result.foods.length, 1);
  assert.equal(result.foods[0].category, 'drink');
  assert.equal(result.foods[0].kcal, null);
});

test('跨分类重复SKU只保留一行，输入不会被修改', () => {
  const input = envelope({ categories: [{ name: '人气热卖', meals: [{ code: 'a' }] }, { name: '饮品', meals: [{ code: 'a' }] }], meals: { a: { name: '纯悦', currentPrice: '7.5' } } });
  const records = [nutrition('纯悦', 0)];
  const snapshot = JSON.stringify({ input, records });
  const first = normalizeMenu(input, records);
  assert.equal(first.foods.length, 1);
  assert.equal(first.foods[0].category, 'drink');
  assert.deepEqual(normalizeMenu(input, records), first);
  assert.equal(JSON.stringify({ input, records }), snapshot);
});
