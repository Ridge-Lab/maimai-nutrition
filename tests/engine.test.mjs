import test from "node:test";
import assert from "node:assert/strict";
import { summarize, compare, recommendSwaps } from "../dist/engine.mjs";

const food = (id, category, kcal, protein = 10, sodium = 100, price = 10) => ({ id, category, kcal, protein, fat: 5, carbohydrate: 20, sodium, calcium: 30, price });
const row = (food, qty = 1) => ({ food, qty });

test("汇总乘以份数，支持半份和空清单", () => {
  assert.deepEqual(summarize([]), { kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, calcium: 0, price: 0, unknownKcalCount: 0, complete: true });
  assert.deepEqual(summarize([row(food("a", "main", 300, 20, 500, 25), 2), row(food("b", "side", 100, 4, 40, 8), 0.5)]), {
    kcal: 650, protein: 42, fat: 12.5, carbohydrate: 50, sodium: 1020, calcium: 75, price: 54, unknownKcalCount: 0, complete: true,
  });
});

test("未知热量不当成零；未知份数累计，其他指标各自汇总", () => {
  const result = summarize([row(food("a", "side", null, 3, 20, 5), 2), row(food("b", "main", 200), 1)]);
  assert.equal(result.kcal, null);
  assert.equal(result.unknownKcalCount, 2);
  assert.equal(result.protein, 16);
  assert.equal(result.complete, false);
  for (const invalid of [undefined, NaN, Infinity, -1, "200"]) {
    assert.equal(summarize([row(food("a", "main", invalid))]).kcal, null);
  }
});

test("营养和价格缺失只使对应指标未知，真实零值有效", () => {
  const result = summarize([row({ ...food("a", "drink", 0, null, 0, null), sodium: undefined })]);
  assert.deepEqual(result, { kcal: 0, protein: null, fat: 5, carbohydrate: 20, sodium: null, calcium: 30, price: null, unknownKcalCount: 0, complete: false });
});

test("拒绝缺失、非正和非有限份数", () => {
  for (const qty of [0, -1, undefined, null, NaN, Infinity, "2"]) {
    assert.throws(() => summarize([{ food: food("a", "main", 200), qty }]), RangeError);
  }
  assert.throws(() => summarize(null), TypeError);
  assert.throws(() => summarize([{ qty: 1 }]), TypeError);
});

test("比较的 delta 为后减前，蛋白方向与其他指标相反", () => {
  const before = { kcal: 600, protein: 20, sodium: 800, price: 30 };
  const after = { kcal: 500, protein: 25, sodium: 900, price: 30 };
  assert.deepEqual(compare(before, after), {
    kcal: { delta: -100, direction: "down", tone: "positive" },
    protein: { delta: 5, direction: "up", tone: "positive" },
    fat: { delta: null, direction: "unknown", tone: "unknown" },
    carbohydrate: { delta: null, direction: "unknown", tone: "unknown" },
    sodium: { delta: 100, direction: "up", tone: "negative" },
    calcium: { delta: null, direction: "unknown", tone: "unknown" },
    price: { delta: 0, direction: "same", tone: "neutral" },
  });
  assert.equal(compare(after, before).protein.tone, "negative");
  assert.equal(compare(after, before).kcal.tone, "negative");
});

test("比较任一侧对应指标未知则不生成虚假 delta", () => {
  const result = compare({ kcal: null, protein: 10, sodium: 100 }, { kcal: 200, protein: undefined, sodium: 50, price: 5 });
  for (const metric of ["kcal", "protein", "price"]) {
    assert.deepEqual(result[metric], { delta: null, direction: "unknown", tone: "unknown" });
  }
  assert.equal(result.sodium.delta, -50);
});

test("推荐穷尽全部候选，以热量降幅优先、价格次序，最多三项", () => {
  const original = food("fries", "side", 400, 4, 300, 15);
  const foods = [food("a", "side", 200, 3, 50, 9), food("b", "side", 100, 3, 50, 12), food("c", "side", 100, 3, 50, 8), food("d", "side", 150, 3, 50, 6), food("e", "main", 0, 3, 50, 1)];
  const swaps = recommendSwaps([row(original)], foods);
  assert.deepEqual(swaps.map((swap) => swap.toId), ["c", "b", "d"]);
  assert.equal(swaps[0].comparison.kcal.delta, -300);
});

test("整行数量替换，并合并已有目标餐品；不会留下相同 id 的重复行", () => {
  const fries = food("fries", "side", 300, 4, 300, 12);
  const corn = food("corn", "side", 100, 3, 50, 8);
  const [swap] = recommendSwaps([row(fries), row(fries), row(corn)], [corn]);
  assert.equal(swap.before.kcal, 700);
  assert.deepEqual(swap.items, [row(corn, 3)]);
  assert.equal(swap.after.kcal, 300);
  assert.equal(swap.comparison.kcal.delta, -400);
});

test("锁定的餐品和已有锁定目标行都保持不变", () => {
  const fries = food("fries", "side", 300);
  const corn = food("corn", "side", 100);
  assert.deepEqual(recommendSwaps([row(fries)], [corn], { lockedIds: ["fries"] }), []);
  assert.deepEqual(recommendSwaps([row(fries), row(corn)], [corn], { lockedIds: ["corn"] }), []);
});

test("热量和价格上限允许等于边界，不通过减少份数偷偷满足", () => {
  const original = food("a", "drink", 200, 0, 20, 10);
  const target = food("b", "drink", 100, 0, 10, 8);
  assert.equal(recommendSwaps([row(original, 2)], [target], { maxKcal: 200, maxPrice: 16 }).length, 1);
  assert.equal(recommendSwaps([row(original, 2)], [target], { maxKcal: 199, maxPrice: 16 }).length, 0);
  assert.equal(recommendSwaps([row(original, 2)], [target], { maxKcal: 200, maxPrice: 15 }).length, 0);
});

test("未知热量或有限预算下未知价格无法推荐，相同热量不算改善", () => {
  const original = food("a", "main", 300);
  assert.deepEqual(recommendSwaps([row(original)], [food("b", "main", null), food("c", "main", 100, 10, 100, null), food("d", "main", 300)], { maxPrice: 40 }), []);
  assert.deepEqual(recommendSwaps([row(food("a", "main", null))], [food("b", "main", 100)]), []);
});

test("未知其他营养可以给热量推荐，但对应比较仍然未知", () => {
  const [swap] = recommendSwaps([row(food("a", "main", 300))], [food("b", "main", 200, null)]);
  assert.equal(swap.after.complete, false);
  assert.equal(swap.comparison.protein.direction, "unknown");
});

test("重复候选只出现一次，计算确定且不修改输入", () => {
  const original = Object.freeze(food("a", "main", 300));
  const target = Object.freeze(food("b", "main", 100));
  const items = Object.freeze([Object.freeze(row(original, 2))]);
  const foods = Object.freeze([target, target]);
  const snapshot = JSON.stringify({ items, foods });
  const first = recommendSwaps(items, foods);
  assert.equal(first.length, 1);
  assert.deepEqual(recommendSwaps(items, foods), first);
  assert.equal(JSON.stringify({ items, foods }), snapshot);
});

test("推荐拒绝非法限制和标识", () => {
  const items = [row(food("a", "main", 300))];
  assert.throws(() => recommendSwaps(items, [], { maxPrice: -1 }), RangeError);
  assert.throws(() => recommendSwaps(items, [], { maxKcal: NaN }), RangeError);
  assert.throws(() => recommendSwaps([row(food(null, "main", 300))], []), TypeError);
});

test("脂肪、碳水与钙按份数相加，缺失分别传播，零值不会丢失", () => {
  const a = { ...food('a', 'main', 300), fat: 12, carbohydrate: 30, calcium: 80 };
  const b = { ...food('b', 'drink', 0), fat: 0, carbohydrate: 0, calcium: null };
  const total = summarize([row(a, 2), row(b, 0.5)]);
  assert.equal(total.fat, 24);
  assert.equal(total.carbohydrate, 60);
  assert.equal(total.calcium, null);
  assert.equal(total.kcal, 600);
  assert.equal(total.unknownKcalCount, 0);
  const missingFat = summarize([row({ ...a, fat: undefined })]);
  assert.equal(missingFat.fat, null);
  assert.equal(missingFat.carbohydrate, 30);
  assert.equal(missingFat.calcium, 80);
});

test("比较覆盖全部六项营养，新指标方向保留但不预设健康优劣", () => {
  const before = { ...food('a', 'side', 300), fat: 20, carbohydrate: 40, calcium: 50 };
  const after = { ...before, fat: 10, carbohydrate: 45, calcium: 60 };
  const deltas = compare(before, after, { goal: 'lower-kcal' });
  assert.deepEqual(deltas.fat, { delta: -10, direction: 'down', tone: 'neutral' });
  assert.deepEqual(deltas.carbohydrate, { delta: 5, direction: 'up', tone: 'neutral' });
  assert.deepEqual(deltas.calcium, { delta: 10, direction: 'up', tone: 'neutral' });
  assert.equal(compare(before, { ...after, calcium: null }).calcium.delta, null);
});

test("比较色义随明确目标变化，中性目标不把营养升降当好坏", () => {
  const before = { ...food('a', 'main', 300), protein: 15, sodium: 500 };
  const after = { ...before, kcal: 400, protein: 20, sodium: 300, price: 8 };
  const energy = compare(before, after, { goal: 'lower-kcal' });
  assert.equal(energy.kcal.tone, 'negative');
  assert.equal(energy.protein.tone, 'neutral');
  assert.equal(energy.sodium.tone, 'neutral');
  assert.equal(compare(after, before, { goal: 'lower-kcal' }).protein.tone, 'negative');
  const protein = compare(before, after, { goal: 'higher-protein' });
  assert.equal(protein.protein.tone, 'positive');
  assert.equal(protein.kcal.tone, 'neutral');
  assert.equal(compare(before, after, { goal: 'lower-sodium' }).sodium.tone, 'positive');
  const neutral = compare(before, after, { goal: 'neutral' });
  for (const key of ['kcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium']) assert.equal(neutral[key].tone, 'neutral');
  assert.equal(neutral.price.tone, 'positive');
  assert.throws(() => compare(before, after, { goal: 'healthiest' }), RangeError);
});

test("无限预算容许只作营养对比的未知价，有限预算必须已知", () => {
  const original = food('a', 'main', 300);
  const target = food('b', 'main', 200, 10, 100, null);
  const [swap] = recommendSwaps([row(original)], [target]);
  assert.equal(swap.after.price, null);
  assert.equal(swap.comparisonOnly, true);
  assert.equal(swap.comparison.price.direction, 'unknown');
  assert.equal(recommendSwaps([row(original)], [target], { maxPrice: 100 }).length, 0);
});

test("蛋白质与钠目标按整餐排序，允许能量增加但仍受限制", () => {
  const original = food('a', 'main', 300, 10, 500);
  const proteinTarget = food('b', 'main', 400, 30, 600);
  const sodiumTarget = food('c', 'main', 350, 15, 200);
  const [protein] = recommendSwaps([row(original, 2)], [proteinTarget, sodiumTarget], { goal: 'higher-protein' });
  assert.equal(protein.toId, 'b');
  assert.equal(protein.after.protein, 60);
  assert.equal(protein.comparison.kcal.tone, 'neutral');
  const [sodium] = recommendSwaps([row(original, 2)], [proteinTarget, sodiumTarget], { goal: 'lower-sodium' });
  assert.equal(sodium.toId, 'c');
  assert.equal(sodium.after.sodium, 400);
  assert.equal(recommendSwaps([row(original, 2)], [proteinTarget], { goal: 'higher-protein', maxKcal: 799 }).length, 0);
});

test("自设蛋白下限和脂肪碳水钠上限应用于整餐，未知约束值不能过关", () => {
  const original = food('a', 'main', 300, 10, 100);
  const target = { ...food('b', 'main', 200, 20, 50), fat: 5, carbohydrate: 10 };
  const limits = { minProtein: 40, maxFat: 10, maxCarbohydrate: 20, maxSodium: 100 };
  assert.equal(recommendSwaps([row(original, 2)], [target], limits).length, 1);
  for (const options of [{ minProtein: 41 }, { maxFat: 9 }, { maxCarbohydrate: 19 }, { maxSodium: 99 }]) {
    assert.equal(recommendSwaps([row(original, 2)], [target], { ...limits, ...options }).length, 0);
  }
  for (const field of ['protein', 'fat', 'carbohydrate', 'sodium']) {
    assert.equal(recommendSwaps([row(original, 2)], [{ ...target, [field]: null }], limits).length, 0);
  }
  for (const options of [{ minProtein: Infinity }, { maxFat: -1 }, { maxCarbohydrate: NaN }, { maxSodium: '100' }, { goal: 'mystery' }]) {
    assert.throws(() => recommendSwaps([row(original)], [target], options), RangeError);
  }
});

test("套餐不能被同分类的单个汉堡替换，单品也不被扩成整套餐", () => {
  const meal = { ...food('meal-a', 'main', 800), isMeal: true };
  const otherMeal = { ...food('meal-b', 'main', 600), isMeal: true };
  const burger = food('burger', 'main', 400);
  assert.deepEqual(recommendSwaps([row(meal)], [burger]), []);
  assert.deepEqual(recommendSwaps([row(burger)], [{ ...otherMeal, kcal: 200 }]), []);
  assert.equal(recommendSwaps([row(meal)], [otherMeal])[0].toId, 'meal-b');
});

test("中性比较容许不同营养取舍，不生成完全相同的替换", () => {
  const original = food('a', 'side', 300);
  const same = food('b', 'side', 300);
  const alternative = { ...food('c', 'side', 300), calcium: 50 };
  const swaps = recommendSwaps([row(original)], [same, alternative], { goal: 'neutral' });
  assert.deepEqual(swaps.map((swap) => swap.toId), ['c']);
  assert.equal(swaps[0].comparison.calcium.tone, 'neutral');
  assert.equal(swaps[0].comparisonOnly, true);
});
