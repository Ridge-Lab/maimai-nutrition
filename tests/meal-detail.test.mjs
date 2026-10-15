import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMealDetail, buildMeal, normalizeRoundSelection, initialMealSelections, mealSelectionKey } from '../dist/meal-detail.mjs';

const wrap = (data) => ({ structuredContent: { success: true, code: 200, data } });
const nutrients = [
  { productName: '麦辣鸡腿汉堡', energyKcal: 485, protein: 20, fat: 26, carbohydrate: 42, sodium: 900, calcium: 87 },
  { productName: '中薯条', energyKcal: 289, protein: 4, fat: 14, carbohydrate: 37, sodium: 165, calcium: 12 },
  { productName: '小杯玉米杯', energyKcal: 53, protein: 2, fat: 1, carbohydrate: 10, sodium: 1, calcium: 2 },
  { productName: '可乐中杯', energyKcal: 147, protein: 0, fat: 0, carbohydrate: 37, sodium: 0, calcium: 0 },
  { productName: '无糖可口可乐中杯', energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 35, calcium: 0 },
];
const modification = { items: [{ maxValues: 2, minValues: 0, values: [
  { code: '100136', price: 0, name: '麦香鸡酱', selectedQuantity: 1, selectedKey: '0-1', unselectedKey: '0-0' },
  { code: '120512', price: 0, name: '切块生菜', selectedQuantity: 0, selectedKey: '0-1', unselectedKey: '0-0' },
] }] };
function fixture() {
  const choice = (code, name, isDefault, diffPrice, extra = {}) => ({ code, name, isDefault, diffPrice, quantity: isDefault ? 1 : 0, maxQuantity: -1, supportModify: false, ...extra });
  const round = (id, name, choices) => ({ id, name, quantity: 1, minQuantity: 1, maxQuantity: 1, choices });
  return wrap({ code: '9900005456', name: '麦辣鸡腿汉堡三件套', supportModify: false, rounds: [
    round(1, '主食', [choice('1440', '麦辣鸡腿汉堡', 1, '+ ¥0', { supportModify: true, modification })]),
    round(2, '小食', [choice('4810', '中薯条', 1, '+ ¥0'), choice('4437', '小杯玉米杯', 0, '- ¥0.5')]),
    round(3, '饮料', [choice('3050', '可乐中杯', 1, '+ ¥0'), choice('3071', '无糖可口可乐中杯', 0, '+ ¥0')]),
  ] });
}

test('解析真实三轮结构与默认code，明确规格后可匹配营养', () => {
  const detail = parseMealDetail(fixture(), nutrients);
  assert.deepEqual(detail.defaultSelections, { 1: '1440', 2: '4810', 3: '3050' });
  assert.equal(detail.rounds[1].id, 2);
  assert.equal(detail.rounds[1].options[0].kcal, 289);
  assert.equal(detail.rounds[1].options[1].diffPriceValue, -0.5);
  assert.equal(detail.kcal, null);
});

test('build默认组成完整相加，quoteItem保留真实round/comboItemList字段', () => {
  const meal = buildMeal(parseMealDetail(fixture(), nutrients));
  assert.equal(meal.kcal, 921);
  assert.equal(meal.protein, 24);
  assert.equal(meal.fat, 40);
  assert.equal(meal.carbohydrate, 116);
  assert.equal(meal.sodium, 1065);
  assert.equal(meal.calcium, 99);
  assert.equal(meal.complete, true);
  assert.equal(meal.priceDifference, 0);
  assert.deepEqual(meal.quoteItem, { productCode: '9900005456', quantity: 1, roundList: [
    { round: 1, comboItemList: [{ code: '1440', quantity: 1, modification: { values: [
      { code: '100136', quantity: 1, key: '0-1' }, { code: '120512', quantity: 0, key: '0-0' },
    ] } }] },
    { round: 2, comboItemList: [{ code: '4810', quantity: 1 }] },
    { round: 3, comboItemList: [{ code: '3050', quantity: 1 }] },
  ] });
});

test('玉米+无糖换配即刻改变营养及差价，只替换选中轮次', () => {
  const detail = parseMealDetail(fixture(), nutrients);
  const meal = buildMeal(detail, { 2: '4437', 3: '3071' });
  assert.equal(meal.kcal, 538);
  assert.equal(meal.fat, 27);
  assert.equal(meal.carbohydrate, 52);
  assert.equal(meal.sodium, 936);
  assert.equal(meal.calcium, 89);
  assert.equal(meal.priceDifference, -0.5);
  assert.deepEqual(meal.selections, { 1: '1440', 2: '4437', 3: '3071' });
  assert.deepEqual(meal.components.map((item) => [item.code, item.qty]), [['1440', 1], ['4437', 1], ['3071', 1]]);
});

test('任何组成热量缺失，整份未知；未知差价不冒充零', () => {
  const source = fixture();
  source.structuredContent.data.rounds[1].choices[1].name = '新口味玉米';
  source.structuredContent.data.rounds[1].choices[1].diffPrice = '待核价';
  const meal = buildMeal(parseMealDetail(source, nutrients), { 2: '4437' });
  assert.equal(meal.kcal, null);
  assert.equal(meal.protein, null);
  assert.equal(meal.unknownKcalCount, 1);
  assert.equal(meal.complete, false);
  assert.equal(meal.priceDifference, null);
});

test('无rounds的实测薯条详情补全中份；可乐规格轮仍保留父商品code', () => {
  const fries = buildMeal(parseMealDetail(wrap({ code: '4810', name: '中薯条', supportModify: false, rounds: [] }), nutrients));
  assert.equal(fries.kcal, 289);
  assert.deepEqual(fries.quoteItem, { productCode: '4810', quantity: 1 });
  const source = fixture().structuredContent.data.rounds[2];
  const cola = buildMeal(parseMealDetail(wrap({ code: '9900008751', name: '可乐', rounds: [source] }), nutrients), { 3: '3071' });
  assert.equal(cola.kcal, 0);
  assert.equal(cola.quoteItem.productCode, '9900008751');
  assert.equal(cola.quoteItem.roundList[0].comboItemList[0].code, '3071');
});

test('默认单选特制仅传选中项；未猜任何key', () => {
  const source = fixture();
  source.structuredContent.data.rounds[2].choices[0].supportModify = true;
  source.structuredContent.data.rounds[2].choices[0].modification = { items: [{ values: [
    { code: '200002', selectedQuantity: 1, selectedKey: '0-1' },
    { code: '200002', selectedQuantity: 0, selectedKey: '0-0' },
  ] }] };
  const meal = buildMeal(parseMealDetail(source, nutrients));
  assert.deepEqual(meal.quoteItem.roundList[2].comboItemList[0].modification, { values: [{ code: '200002', quantity: 1, key: '0-1' }] });
});

test('单品特制默认值保留；可选多份轮保留实际选择份数', () => {
  const single = buildMeal(parseMealDetail(wrap({ code: '1440', name: '麦辣鸡腿汉堡', rounds: [], supportModify: true, modification }), nutrients));
  assert.equal(single.quoteItem.modification.values.length, 2);
  const source = fixture();
  source.structuredContent.data.rounds[1].maxQuantity = 2;
  const meal = buildMeal(parseMealDetail(source, nutrients));
  assert.deepEqual(meal.selections['2'], { 4810: 1 });
  assert.equal(meal.quoteItem.roundList[1].comboItemList[0].quantity, 1);
});

test('不属于该轮的code、未知轮和不明特制都不能进入核价', () => {
  const detail = parseMealDetail(fixture(), nutrients);
  assert.throws(() => buildMeal(detail, { 2: '3071' }), /不属于/);
  assert.throws(() => buildMeal(detail, { 9: '1440' }), /未知轮次/);
  detail.rounds[0].options[0].modification.items[0].values[0].selectedKey = null;
  assert.throws(() => buildMeal(detail), /默认编码缺失/);
});

test('重复同名不同营养不强行匹配，构造不改变原始详情或选择', () => {
  const source = fixture();
  const records = [...nutrients, { productName: '中薯条', energyKcal: 999, protein: 0, sodium: 0 }];
  const selections = { 3: '3071' };
  const snapshot = JSON.stringify({ source, records, selections });
  const detail = parseMealDetail(source, records);
  assert.equal(detail.rounds[1].options[0].kcal, null);
  assert.equal(buildMeal(detail, selections).kcal, null);
  assert.equal(JSON.stringify({ source, records, selections }), snapshot);
});

test('每项营养缺失独立传播，组件保留精确名称和来源，零值有效', () => {
  const records = nutrients.map((record) => record.productName === '中薯条' ? { ...record, calcium: null } : record);
  const meal = buildMeal(parseMealDetail(fixture(), records));
  assert.equal(meal.kcal, 921);
  assert.equal(meal.fat, 40);
  assert.equal(meal.carbohydrate, 116);
  assert.equal(meal.calcium, null);
  assert.equal(meal.complete, false);
  assert.equal(meal.unknownKcalCount, 0);
  assert.equal(meal.components[1].nutritionName, '中薯条');
  assert.equal(meal.components[1].nutritionMatch, 'exact');
  const zero = buildMeal(parseMealDetail({ code: '3071', name: '无糖可口可乐中杯', rounds: [] }, records));
  for (const field of ['kcal', 'protein', 'fat', 'carbohydrate', 'calcium']) assert.equal(zero[field], 0);
  assert.equal(zero.sodium, 35);
  assert.equal(zero.complete, true);
});

function withToy() {
  const source=fixture();
  source.structuredContent.data.rounds.push({id:4,name:'选择系列玩具',quantity:1,minQuantity:1,maxQuantity:1,
    choices:[{code:'toy-1',name:'海绵宝宝×航海王系列玩具',isDefault:1,quantity:1,maxQuantity:-1,diffPrice:'+ ¥0'}]});
  return source;
}

test('套餐玩具明确为非食品，从营养合计排除且保留原始选择与官方核价轮次',()=>{
  const source=withToy(),detail=parseMealDetail(source,nutrients),meal=buildMeal(detail);
  const baseline=buildMeal(parseMealDetail(fixture(),nutrients));
  for(const key of ['kcal','protein','fat','carbohydrate','sodium','calcium'])assert.equal(meal[key],baseline[key]);
  assert.equal(meal.complete,true);
  assert.equal(meal.unknownKcalCount,0);
  const toy=meal.components.at(-1);
  assert.equal(toy.nonFood,true);
  assert.equal(toy.kcal,null); // No invented nutritional zero is stored on the toy.
  assert.equal(meal.selections['4'],'toy-1');
  assert.deepEqual(meal.quoteItem.roundList.at(-1),{round:4,comboItemList:[{code:'toy-1',quantity:1}]});
  assert.equal(meal.priceDifference,0);
});

test('排除玩具不掩盖食品营养缺失，每个未知字段继续独立传播',()=>{
  const source=withToy();
  const partial=nutrients.map(row=>row.productName==='中薯条'?{...row,calcium:null}:row);
  const meal=buildMeal(parseMealDetail(source,partial));
  assert.equal(meal.kcal,921);
  assert.equal(meal.calcium,null);
  assert.equal(meal.complete,false);
  assert.equal(meal.unknownKcalCount,0);
  source.structuredContent.data.rounds[1].choices[0].name='未匹配的新品小食';
  const unknown=buildMeal(parseMealDetail(source,nutrients));
  assert.equal(unknown.kcal,null);
  assert.equal(unknown.unknownKcalCount,1);
});

test('含玩具宣传词的餐品或套餐名不能按非食品豁免未知营养',()=>{
  const source=fixture();
  source.structuredContent.data.rounds[0].choices[0].name='玩具主题汉堡套餐';
  const meal=buildMeal(parseMealDetail(source,nutrients));
  assert.equal(meal.components[0].nonFood,false);
  assert.equal(meal.kcal,null);
  assert.equal(meal.unknownKcalCount,1);
});

function multiFixture() {
  const source = fixture();
  source.structuredContent.data.rounds[0].quantity = 2;
  source.structuredContent.data.rounds[0].minQuantity = 2;
  source.structuredContent.data.rounds[0].maxQuantity = 2;
  source.structuredContent.data.rounds[0].choices[0].quantity = 2;
  source.structuredContent.data.rounds[1].quantity = 3;
  source.structuredContent.data.rounds[1].minQuantity = 3;
  source.structuredContent.data.rounds[1].maxQuantity = 3;
  source.structuredContent.data.rounds[1].choices[0].quantity = 2;
  source.structuredContent.data.rounds[1].choices[1].quantity = 1;
  source.structuredContent.data.rounds[1].choices[1].isDefault = 0;
  return source;
}

test('多份默认按所有正quantity保留，营养、差价、特制及报价数量一致', () => {
  const detail = parseMealDetail(multiFixture(), nutrients), meal = buildMeal(detail);
  assert.deepEqual(detail.defaultSelections, { 1: { 1440: 2 }, 2: { 4437: 1, 4810: 2 }, 3: '3050' });
  assert.equal(meal.kcal, 485 * 2 + 289 * 2 + 53 + 147);
  assert.equal(meal.priceDifference, -0.5);
  assert.deepEqual(meal.components.map(({ code, qty }) => [code, qty]), [['1440', 2], ['4437', 1], ['4810', 2], ['3050', 1]]);
  assert.equal(meal.quoteItem.roundList[0].comboItemList[0].quantity, 2);
  assert.equal(meal.quoteItem.roundList[0].comboItemList[0].modification.values[0].quantity, 1);
  assert.deepEqual(meal.quoteItem.roundList[1].comboItemList, [{ code: '4437', quantity: 1 }, { code: '4810', quantity: 2 }]);
  assert.equal(meal.spec.includes('×2'), true);
});

test('多轮重复相同SKU营养组件合并，但官方报价仍保留各轮', () => {
  const source = fixture();
  source.structuredContent.data.rounds[1].choices = [structuredClone(source.structuredContent.data.rounds[0].choices[0])];
  const meal = buildMeal(parseMealDetail(source, nutrients));
  assert.equal(meal.components.find(c => c.code === '1440').qty, 2);
  assert.equal(meal.kcal, 485 * 2 + 147);
  assert.deepEqual(meal.quoteItem.roundList.slice(0, 2).map(r => r.comboItemList[0].quantity), [1, 1]);
});

test('多选严格校验数量、上下限、不可用选项；未选齐仅供编辑而不可构建核价', () => {
  const detail = parseMealDetail(multiFixture(), nutrients), round = detail.rounds[1];
  const pending = normalizeRoundSelection(round, { 4810: 1 }, { allowIncomplete: true });
  assert.equal(pending.total, 1);
  assert.equal(pending.complete, false);
  assert.throws(() => buildMeal(detail, { 2: { 4810: 1 } }), /还需 2 份/);
  assert.throws(() => normalizeRoundSelection(round, { 4810: 4 }), /最多选择 3 份/);
  for (const qty of [0, -1, 1.5, '1', NaN, Infinity, 10001]) assert.throws(() => normalizeRoundSelection(round, { 4810: qty }), /正整数/);
  round.options[0].maxQuantity = 1;
  assert.throws(() => normalizeRoundSelection(round, { 4810: 2, 4437: 1 }), /超过最多/);
  round.options[0].maxQuantity = 0;
  assert.throws(() => normalizeRoundSelection(round, { 4810: 1 }), /不可选/);
  assert.throws(() => normalizeRoundSelection(round, { missing: 3 }), /不属于/);
});

test('初始选配不补齐明确空配方，失效默认保留待选，key与对象顺序无关', () => {
  const detail = parseMealDetail(multiFixture(), nutrients);
  assert.deepEqual(initialMealSelections(detail, {}), {});
  assert.deepEqual(initialMealSelections(detail), detail.defaultSelections);
  detail.rounds[1].options[0].maxQuantity = 0;
  assert.deepEqual(initialMealSelections(detail)['2'], { 4437: 1 });
  assert.equal(mealSelectionKey({ 2: { b: 2, a: 1 }, 1: 'x' }), mealSelectionKey({ 1: 'x', 2: { a: 1, b: 2 } }));
  assert.notEqual(mealSelectionKey({ 2: { b: 2, a: 1 } }), mealSelectionKey({ 2: { b: 1, a: 2 } }));
});

test('缺失营养保留完整总数未知，并逐项给出已知小计和缺失食物份数', () => {
  const source = multiFixture();
  source.structuredContent.data.rounds[1].choices[0].name = '未知新小食';
  const meal = buildMeal(parseMealDetail(source, nutrients));
  assert.equal(meal.kcal, null);
  assert.equal(meal.knownTotals.kcal, 485 * 2 + 53 + 147);
  assert.deepEqual(meal.missingComponents.kcal, [{ code: '4810', name: '未知新小食', qty: 2 }]);
  assert.equal(meal.unknownKcalCount, 2);
  const unknown = buildMeal(parseMealDetail({ code: 'unknown', name: '未发布营养的食物', rounds: [] }, nutrients));
  assert.equal(unknown.knownTotals.kcal, null);
});

test('7种原不支持的官方公开套餐默认份数完整进入组件和报价，BFF不限于isDefault', () => {
  // Public query-meal-detail data sampled from example store 1450713, 2026-10-15.
  // Fixture contains product data only, with no account fields or MCP credentials.
  const samples = JSON.parse(readFileSync(new URL('./fixtures/official-multi-meals.json', import.meta.url), 'utf8'));
  assert.equal(samples.length, 7);
  for (const sample of samples) {
    const detail = parseMealDetail(sample, nutrients), meal = buildMeal(detail);
    const expected = sample.rounds.reduce((sum, r) => sum + r.choices.reduce((s, c) => s + c.quantity, 0), 0);
    assert.equal(meal.components.reduce((sum, c) => sum + c.qty, 0), expected, sample.code);
    assert.equal(meal.quoteItem.roundList.reduce((sum, r) => sum + r.comboItemList.reduce((s, c) => s + c.quantity, 0), 0), expected, sample.code);
    for (const round of meal.quoteItem.roundList) {
      const raw = sample.rounds.find(r => r.id === round.round);
      assert.deepEqual(round.comboItemList.map(({ code, quantity }) => ({ code, quantity })), raw.choices.filter(c => c.quantity > 0).map(({ code, quantity }) => ({ code, quantity })).sort((a,b) => a.code.localeCompare(b.code)));
    }
  }
});
