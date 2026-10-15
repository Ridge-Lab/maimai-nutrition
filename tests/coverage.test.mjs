import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageSummary, nutrientCoverage, mergeResolvedMenu } from '../dist/coverage.mjs';
import { foods as demoFoods } from '../dist/catalog.mjs';
import { normalizeMenu } from '../dist/live-menu.mjs';

const complete = { kcal: 0, protein: 0, fat: 0, carbohydrate: 1, sodium: 35, calcium: 0 };
const base = { id: 'menu-combo', productCode: 'combo', storeCode: 'one', name: '测试套餐', spec: '套餐搭配待展开', isMeal: true, nutritionMatch: 'unexpanded-meal', ...Object.fromEntries(Object.keys(complete).map((key) => [key, null])) };
const recipe = (choice = 'corn') => ({ ...base, id: `configured-${choice}`, spec: `主食 / ${choice}`, ...complete, selections: { 1: choice }, nutritionSource: 'official-mcp-nutrition', nutritionMatch: 'components', quoteItem: { productCode: 'combo', quantity: 1, roundList: [{ round: 1, comboItemList: [{ code: choice, quantity: 1 }] }] } });

test('六项覆盖独立计算，零值有效，精确匹配仍可有缺项', () => {
  const result = coverageSummary([{ ...complete, nutritionMatch: 'exact', fat: null }, { nutritionMatch: 'ambiguous' }, base, { nutritionMatch: 'unmatched' }]);
  assert.equal(result.total, 4);
  assert.equal(result.matched, 1);
  assert.equal(result.needsSelection, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.unmatched, 1);
  assert.equal(result.complete, 0);
  assert.deepEqual(result.nutrients.kcal, { known: 1, total: 4, rate: 0.25 });
  assert.deepEqual(result.nutrients.fat, { known: 0, total: 4, rate: 0 });
  assert.deepEqual(nutrientCoverage(complete), { known: 6, total: 6, complete: true, missing: [] });
});

test('详情回流新增明确搭配，原始SKU不被一组数据冒充通用值', () => {
  const input = [base];
  const snapshot = JSON.stringify(input);
  const result = mergeResolvedMenu(input, recipe());
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(result.foods[0].kcal, null);
  assert.equal(result.foods[0].resolvedVariants, 1);
  assert.equal(result.foods[1].resolvedRecipe, true);
  assert.equal(result.foods[1].parentCode, 'combo');
  assert.equal(result.foods[1].spec, '主食 / corn');
  assert.equal(result.foods[1].calcium, 0);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.needsSelection, 1);
  assert.equal(result.summary.resolvedVariants, 1);
  assert.equal(result.summary.resolvedComplete, 1);
});

test('同搭配按内容指纹替换，份数或对象键顺序不会生成重复变体', () => {
  const once = mergeResolvedMenu([base], recipe());
  const changed = recipe();
  changed.id = 'another-id';
  changed.quoteItem = { quantity: 2, roundList: changed.quoteItem.roundList, productCode: 'combo' };
  changed.fat = 2;
  const twice = mergeResolvedMenu(once.foods, changed);
  assert.equal(twice.foods.length, 2);
  assert.equal(twice.foods[1].fat, 2);
  const third = mergeResolvedMenu(twice.foods, recipe('fries'));
  assert.equal(third.foods.length, 3);
  assert.equal(third.summary.resolvedVariants, 2);
  assert.equal(third.summary.resolvedProducts, 1);
});

test('不把其他门店或不存在的套餐混入当前门店', () => {
  assert.throws(() => mergeResolvedMenu([], recipe()), /不存在/);
  assert.throws(() => mergeResolvedMenu([base], { ...recipe(), storeCode: 'other' }), /门店不一致/);
  assert.throws(() => mergeResolvedMenu([base], { ...recipe(), spec: '' }), /明确规格/);
});

test('规格不足但有已知规格目录标为待选，完全缺资料标为未匹配', () => {
  const result = normalizeMenu({ categories: [], meals: { a: { name: '薯条' }, b: { name: '陌生新品' }, c: { name: '中薯条' } } }, [{ productName: '中薯条', energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165, calcium: 18 }]);
  assert.deepEqual(result.foods.map((food) => food.nutritionStatus), ['needs-selection', 'unmatched', 'matched']);
  assert.equal(result.foods[0].kcal, null);
  assert.equal(result.foods[2].fat, 12);
  assert.equal(result.foods[2].carbohydrate, 38);
  assert.equal(result.foods[2].calcium, 18);
});

test('12项演示标准份补齐六营养且保留真实的无糖中杯1g碳水', () => {
  const singles=demoFoods.filter(food=>!food.demoMeal);
  assert.equal(singles.length, 12);
  assert.equal(coverageSummary(singles).complete, 12);
  const expected = [
    ['板烧鸡腿堡', 17, 35, 93], ['吉士汉堡包', 12, 30, 144],
    ['小薯条', 9, 28, 13], ['中薯条', 12, 38, 18], ['大薯条', 16, 50, 23],
    ['小杯玉米杯', 1, 7, 6], ['大杯玉米杯', 1, 12, 10],
    ['可乐中杯', 0, 36, 10], ['可乐大杯', 0, 55, 15], ['无糖可口可乐中杯', 0, 1, 0],
    ['麦乐鸡5块', 12, 13, 9], ['圆筒冰淇淋', 3, 14, 77],
  ];
  assert.deepEqual(singles.map(({ nutritionName, fat, carbohydrate, calcium }) => [nutritionName, fat, carbohydrate, calcium]), expected);
});
