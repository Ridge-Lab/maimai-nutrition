import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionForFood } from '../dist/selection.mjs';

const parent = { id: 'menu-combo', productCode: '5456', name: '三件套', spec: '待确认搭配' };
const recipe = (id, spec, side, drink) => ({
  id, productCode: '5456', name: '三件套', spec, resolvedRecipe: true,
  components: [{ name: '汉堡', qty: 1 }, { name: side, qty: 1 }, { name: drink, qty: 1 }],
});
const original = recipe('configured-fries-cola', '汉堡 / 中薯条 / 中可乐', '中薯条', '中可乐');
const lighter = recipe('configured-corn-zero', '汉堡 / 小玉米 / 中零度', '小玉米', '中零度');
const row = (food, qty = 1) => ({ food, qty });

test('未选卡片没有选中状态；演示餐品严格按 id 显示当前份数', () => {
  const demo = { id: 'demo-fries', name: '中薯条', spec: '中份' };
  assert.deepEqual(selectionForFood(demo, []), { qty: 0, exactQty: 0, rows: [], configuredVariantCount: 0 });
  assert.deepEqual(selectionForFood(demo, [row(demo, 3)]), {
    qty: 3, exactQty: 3, rows: [{ id: demo.id, name: demo.name, spec: demo.spec, qty: 3, components: [] }], configuredVariantCount: 0,
  });
});

test('父 SKU 汇总自己的行与不同已选配置，具体搭配和数量分列', () => {
  const other = { ...lighter, id: 'other-product', productCode: 'other' };
  const result = selectionForFood(parent, [row(original, 2), row(lighter, 3), row(parent), row(other, 8)]);
  assert.equal(result.qty, 6);
  assert.equal(result.exactQty, 1);
  assert.equal(result.configuredVariantCount, 2);
  assert.deepEqual(result.rows.map(({ id, spec, qty }) => ({ id, spec, qty })), [
    { id: original.id, spec: original.spec, qty: 2 },
    { id: lighter.id, spec: lighter.spec, qty: 3 },
    { id: parent.id, spec: parent.spec, qty: 1 },
  ]);
  assert.deepEqual(result.rows[0].components, [{ name: '汉堡', qty: 2 }, { name: '中薯条', qty: 2 }, { name: '中可乐', qty: 2 }]);
  assert.deepEqual(result.rows[1].components, [{ name: '汉堡', qty: 3 }, { name: '小玉米', qty: 3 }, { name: '中零度', qty: 3 }]);
});

test('配置卡只显示自身数量；同父 SKU 的其他配方不被误标已选', () => {
  const items = [row(original, 2), row(parent, 4)];
  assert.deepEqual(selectionForFood(lighter, items), { qty: 0, exactQty: 0, rows: [], configuredVariantCount: 0 });
  const selected = selectionForFood(original, [...items, row(lighter, 3)]);
  assert.equal(selected.qty, 2);
  assert.equal(selected.exactQty, 2);
  assert.equal(selected.configuredVariantCount, 1);
  assert.deepEqual(selected.rows.map(item => item.id), [original.id]);
});

test('相同配置的重复行合并，组件数量乘以合计份数', () => {
  const result = selectionForFood(parent, [row(original, 2), row(lighter), row(original, 3)]);
  assert.equal(result.qty, 6);
  assert.equal(result.exactQty, 0);
  assert.equal(result.configuredVariantCount, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].qty, 5);
  assert.deepEqual(result.rows[0].components.map(component => component.qty), [5, 5, 5]);
});

test('名称相同或父编码相似都不关联；未验证的另一个 id 不冒充配置', () => {
  const sameName = { ...lighter, id: 'different-product', productCode: '54560' };
  const unverified = { ...lighter, id: 'unverified', resolvedRecipe: false };
  const missingCode = { ...lighter, id: 'missing-code', productCode: undefined };
  const items = [row(sameName), row(unverified), row(missingCode)];
  assert.equal(selectionForFood(parent, items).qty, 0);
  const demo = { id: 'demo', name: '三件套' };
  assert.equal(selectionForFood(demo, [row({ ...missingCode, productCode: undefined })]).qty, 0);
});

test('无效与已删行不计入份数，合法零热量和缺失营养不影响选择显示', () => {
  const unknown = { ...lighter, kcal: null, fat: null };
  const rows = [row(unknown, 2), ...[0, -1, Infinity, NaN, '3', null].map(qty => row(original, qty)), { qty: 4 }];
  const result = selectionForFood(parent, rows);
  assert.equal(result.qty, 2);
  assert.equal(result.rows[0].id, lighter.id);
  assert.equal(selectionForFood({ ...original, kcal: 0 }, [row(original)]).qty, 1);
  assert.deepEqual(selectionForFood(null, rows), { qty: 0, exactQty: 0, rows: [], configuredVariantCount: 0 });
});

test('组件每套餐多份乘行数量；输出不修改餐品或原餐单', () => {
  const meal = { ...lighter, components: [{ name: '麦乐鸡', qty: 2 }, { name: '饮料', qty: 1 }] };
  const items = [row(meal, 3)];
  const before = structuredClone(items);
  const result = selectionForFood(parent, items);
  assert.deepEqual(result.rows[0].components, [{ name: '麦乐鸡', qty: 6 }, { name: '饮料', qty: 3 }]);
  result.rows[0].components[0].name = 'changed-output';
  assert.deepEqual(items, before);
});
