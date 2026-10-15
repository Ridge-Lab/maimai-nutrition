import test from 'node:test';
import assert from 'node:assert/strict';
import { matchNutrition, normalizeMenu } from '../dist/live-menu.mjs';

const nutrition = (productName, energyKcal, extra = {}) => ({ productName, energyKcal, energyKj: 1000, protein: 10, fat: 5, carbohydrate: 20, sodium: 100, calcium: 10, ...extra });

test('麦咖啡品牌前缀不影响明确温度/品种/杯型匹配，不能补猜缺失规格', () => {
  const rows = [nutrition('冰美式中杯', 13), nutrition('热美式中杯', 13), nutrition('冰奶铁中杯', 148)];
  assert.equal(matchNutrition('麦咖啡™冰美式中杯', rows).kcal, 13);
  assert.equal(matchNutrition('麦咖啡™热美式中杯', rows).nutritionMatch, 'alias');
  assert.equal(matchNutrition('麦咖啡™冰奶铁中杯', rows).nutritionName, '冰奶铁中杯');
  assert.equal(matchNutrition('麦咖啡™冰美式', rows).kcal, null);
  assert.equal(matchNutrition('麦咖啡™冰奶铁大杯', rows).kcal, null);
  assert.equal(matchNutrition('麦咖啡™厚乳冰奶铁中杯', rows).kcal, null);
});

test('麦乐鸡块数前后顺序和连字符等价；分别使用官方4块/5块记录', () => {
  const rows = [nutrition('麦乐鸡5块', 213), nutrition('麦乐鸡4块', 170)];
  for (const name of ['麦乐鸡-5块', '麦乐鸡（5块）', '5块麦乐鸡']) assert.equal(matchNutrition(name, rows).kcal, 213);
  for (const name of ['麦乐鸡-4块', '麦乐鸡（4块）', '4块麦乐鸡']) assert.equal(matchNutrition(name, rows).kcal, 170);
  assert.equal(matchNutrition('麦乐鸡', rows).kcal, null);
  assert.equal(matchNutrition('麦乐鸡8块', rows).kcal, null);
  assert.equal(matchNutrition('5块麦乐鸡+蘸酱', rows).kcal, null);
});

test('显式4块同款麦辣鸡翅由官方2块整份加总，并保留计算依据', () => {
  const rows = [nutrition('麦辣鸡翅-2块', 224, { energyKj: 937, protein: 13, fat: 15, carbohydrate: 9, sodium: 537, calcium: 13 })];
  const original = JSON.stringify(rows);
  assert.equal(matchNutrition('麦辣鸡翅2块', rows).kcal, 224);
  const four = matchNutrition('麦辣鸡翅4块', rows);
  assert.deepEqual(['kcal', 'energyKj', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium'].map(key => four[key]), [448, 1874, 26, 30, 18, 1074, 26]);
  assert.equal(four.nutritionMatch, 'portion-scaled');
  assert.equal(four.nutritionName, '麦辣鸡翅-2块');
  assert.match(four.nutritionNote, /× 2/);
  assert.equal(JSON.stringify(rows), original);
  for (const name of ['麦辣鸡翅', '薄皮焦香V翅4块', '蜜汁麦辣鸡翅4块', '麦辣鸡翅4块+酱']) assert.equal(matchNutrition(name, rows).kcal, null);
});

test('别名与份量换算仍拒绝官方同名冲突，不覆盖直接提供的4块记录', () => {
  const conflicting = [nutrition('麦辣鸡翅-2块', 224), nutrition('麦辣鸡翅-2块', 300)];
  assert.equal(matchNutrition('麦辣鸡翅4块', conflicting).nutritionMatch, 'ambiguous');
  assert.equal(matchNutrition('麦辣鸡翅4块', conflicting).kcal, null);
  const direct = matchNutrition('麦辣鸡翅4块', [...conflicting, nutrition('麦辣鸡翅4块', 447)]);
  assert.equal(direct.kcal, 447);
  assert.equal(direct.nutritionMatch, 'exact');
});

test('套餐展开子项允许完整同名营养，菜单套餐仍须展开', () => {
  const rows = [nutrition('固定双拼', 400)];
  assert.equal(matchNutrition('固定双拼', rows).kcal, 400);
  const menu = normalizeMenu({ categories: [], meals: { combo: { name: '固定双拼' } } }, rows);
  assert.equal(menu.foods[0].isMeal, true);
  assert.equal(menu.foods[0].kcal, null);
  assert.equal(menu.foods[0].nutritionMatch, 'unexpanded-meal');
});

test('未验证的普通牛奶、鱼排堡、规格和风味变更不因相似名称匹配', () => {
  const rows = [nutrition('纯牛奶（盒装）', 129), nutrition('儿童鱼排堡', 269), nutrition('苹果片', 32), nutrition('双层深海鳕鱼堡', 485), nutrition('那么大鸡排', 385)];
  for (const name of ['纯牛奶', '鱼排堡', '苹果片一袋(60g)', '原味双层深海鳕鱼堡', '风味双层深海鳕鱼堡', '那么大鸡排（香辣风味）']) assert.equal(matchNutrition(name, rows).kcal, null);
});
