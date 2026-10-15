import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreFavorite } from '../dist/restore.mjs';

const recipe = () => ({ schemaVersion: 2, id: 'saved-1', name: '午餐', mode: 'store',
  store: { code: '1450713', name: '原餐厅' }, items: [
    { productCode: '9900005456', name: '汉堡三件套', qty: 3, selections: { 1: '1440', 2: '4437', 3: '3071' }, locked: true },
    { productCode: '4810', name: '中薯条', qty: 2, selections: {}, locked: false },
  ] });
const makeContext = () => ({ store: { code: '1450713', name: '当前餐厅信息' }, nutritionRecords: [{ productName: '中薯条', energyKcal: 289 }],
  foods: [{ id: 'menu-combo', productCode: '9900005456', name: '当前三件套' }, { id: 'menu-fries', productCode: '4810', name: '中薯条' }] });

test('real restoration reloads store menu and nutrition then resolves exact saved choices with strict fresh details', async () => {
  const saved = recipe(); const context = makeContext(); const calls = [];
  const loadStore = async (store, options) => { calls.push(['store', store, options]); return context; };
  const resolveFood = async (base, selections, options) => {
    calls.push(['food', base, selections, options]);
    return { ...base, id: `restored-${base.productCode}`, selections: { ...selections }, kcal: base.productCode === '4810' ? 289 : 538 };
  };
  const result = await restoreFavorite(saved, { loadStore, resolveFood, referenceFoods: [] });
  assert.equal(calls[0][0], 'store');
  assert.strictEqual(calls[0][1], saved.store);
  assert.deepEqual(calls[0][2], { fresh: true });
  assert.equal(calls.length, 3);
  for (let index = 0; index < saved.items.length; index++) {
    const call = calls[index + 1];
    assert.strictEqual(call[1], context.foods[index]);
    assert.strictEqual(call[2], saved.items[index].selections);
    assert.deepEqual(call[3], { store: context.store, nutrition: context.nutritionRecords, fresh: true, strict: true });
  }
  assert.strictEqual(result.context, context);
  assert.deepEqual(result.items.map(({ food, qty }) => ({ id: food.id, qty })), [
    { id: 'restored-9900005456', qty: 3 }, { id: 'restored-4810', qty: 2 },
  ]);
  assert.deepEqual(result.lockedIds, ['restored-9900005456']);
  assert.deepEqual(result.resolved, result.items.map(({ food }) => food));
});

test('restoration selects the original SKU by code, never a resolved variant or a name collision', async () => {
  const saved = recipe(); saved.items = [saved.items[0]];
  const context = makeContext();
  context.foods.unshift(
    { id: 'saved-variant', productCode: '9900005456', resolvedRecipe: true, name: '别的选配' },
    { id: 'wrong-code', productCode: '99000054560', name: '汉堡三件套' },
  );
  const selected = [];
  const result = await restoreFavorite(saved, { loadStore: async () => context, resolveFood: async (base) => { selected.push(base.id); return base; }, referenceFoods: [] });
  assert.deepEqual(selected, ['menu-combo']);
  assert.equal(result.items[0].food.id, 'menu-combo');
});

test('missing product rejects the entire restoration even after a previous item resolved', async () => {
  const saved = recipe(); const untouched = structuredClone(saved); const context = makeContext(); context.foods.pop();
  const calls = []; let publishedResult = null;
  await assert.rejects(async () => {
    publishedResult = await restoreFavorite(saved, { loadStore: async () => context, resolveFood: async (base) => { calls.push(base.productCode); return base; }, referenceFoods: [] });
  }, /中薯条.*已不在当前目录.*未恢复任何餐品/);
  assert.deepEqual(calls, ['9900005456']);
  assert.equal(publishedResult, null);
  assert.deepEqual(saved, untouched);
});

test('invalid or removed choices reject the whole recipe without using defaults or skipping the item', async () => {
  const saved = recipe(); const context = makeContext(); const calls = []; let publishedResult = null;
  const resolveFood = async (base, selections, options) => {
    calls.push({ code: base.productCode, selections, options });
    if (base.productCode === '4810') throw new Error('保存的选项已下架');
    return { ...base, id: 'first-resolved' };
  };
  await assert.rejects(async () => {
    publishedResult = await restoreFavorite(saved, { loadStore: async () => context, resolveFood, referenceFoods: [] });
  }, /中薯条.*保存的选项已下架.*当前餐单未改变/);
  assert.equal(publishedResult, null);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.strict === true && call.options.fresh === true));
});

test('store lookup failure propagates before any detail resolution', async () => {
  let detailCalled = false;
  await assert.rejects(restoreFavorite(recipe(), { loadStore: async () => { throw new Error('连接已失效'); },
    resolveFood: async () => { detailCalled = true; }, referenceFoods: [] }), /连接已失效/);
  assert.equal(detailCalled, false);
});

test('demo restoration uses current reference entries without fetching live data, preserving quantities and locks', async () => {
  const food = { id: 'grilled-chicken', name: '板烧鸡腿堡', kcal: 383 };
  const saved = { mode: 'demo', items: [{ demoId: food.id, name: food.name, qty: 4, selections: {}, locked: true }] };
  const forbidden = () => { throw new Error('demo must not fetch'); };
  const result = await restoreFavorite(saved, { loadStore: forbidden, resolveFood: forbidden, referenceFoods: [food] });
  assert.equal(result.context, null);
  assert.strictEqual(result.items[0].food, food);
  assert.equal(result.items[0].qty, 4);
  assert.deepEqual(result.lockedIds, [food.id]);
  assert.deepEqual(result.resolved, []);
});

test('missing demo food and empty recipes reject rather than returning a partial empty meal', async () => {
  const forbidden = () => { throw new Error('must not fetch'); };
  const deps = { loadStore: forbidden, resolveFood: forbidden, referenceFoods: [] };
  await assert.rejects(restoreFavorite({ mode: 'demo', items: [{ demoId: 'gone', name: '旧餐品', qty: 1, locked: false }] }, deps), /旧餐品.*未恢复任何餐品/);
  await assert.rejects(restoreFavorite({ items: [] }, deps), /组合为空或无效/);
});

test('sample meal restoration resolves saved choices strictly rather than restoring an unexpanded base',async()=>{
  const base={id:'sample-meal-7',demoMeal:true,name:'分享套餐'};
  const choices={'1':{burger:2,corn:1},'2':'zero'};
  const saved={mode:'demo',items:[{demoId:base.id,name:base.name,qty:2,locked:true,selections:choices}]};
  const forbidden=()=>{throw Error('sample must not query live stores');};let options;
  const result=await restoreFavorite(saved,{referenceFoods:[base],loadStore:forbidden,resolveFood:forbidden,resolveReferenceFood:async(food,selections,opts)=>{assert.strictEqual(food,base);assert.deepEqual(selections,choices);options=opts;return {...base,id:'resolved-7',selections,kcal:100};}});
  assert.equal(options.strict,true);assert.equal(result.items[0].food.id,'resolved-7');assert.equal(result.items[0].qty,2);assert.deepEqual(result.lockedIds,['resolved-7']);assert.equal(result.resolved.length,1);
  await assert.rejects(restoreFavorite(saved,{referenceFoods:[base]}),/需要重新确认搭配/);
});
