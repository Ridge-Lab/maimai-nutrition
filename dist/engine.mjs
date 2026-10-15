export const NUTRIENT_KEYS = Object.freeze(["kcal", "protein", "fat", "carbohydrate", "sodium", "calcium"]);
const METRICS = [...NUTRIENT_KEYS, "price"];
const GOALS = new Set(["lower-kcal", "higher-protein", "lower-sodium", "neutral"]);

const known = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const zero = (value) => Object.is(value, -0) ? 0 : value;

function validateItems(items) {
  if (!Array.isArray(items)) throw new TypeError("items 必须是数组");
  for (const item of items) {
    if (!item || typeof item !== "object" || !item.food || typeof item.food !== "object") {
      throw new TypeError("每一行必须包含 food 对象");
    }
    if (typeof item.qty !== "number" || !Number.isFinite(item.qty) || item.qty <= 0) {
      throw new RangeError("qty 必须是有限正数");
    }
  }
}

/** Unknown values poison only their own total; they are never treated as zero. */
export function summarize(items) {
  validateItems(items);
  const result = { ...Object.fromEntries(METRICS.map((metric) => [metric, 0])), unknownKcalCount: 0, complete: true };
  for (const { food, qty } of items) {
    if (!known(food.kcal) || !Number.isFinite(food.kcal * qty)) result.unknownKcalCount += qty;
    for (const metric of METRICS) {
      if (result[metric] === null) continue;
      const amount = food[metric];
      const total = known(amount) ? result[metric] + amount * qty : NaN;
      result[metric] = known(amount) && Number.isFinite(total) ? zero(total) : null;
    }
  }
  result.complete = METRICS.every((metric) => result[metric] !== null);
  return result;
}

/** Deltas are after minus before. Tone describes the direction, not medical advice. */
export function compare(before, after, { goal } = {}) {
  if (goal !== undefined && !GOALS.has(goal)) throw new RangeError("比较目标无效");
  return Object.fromEntries(METRICS.map((metric) => {
    const previous = before?.[metric];
    const current = after?.[metric];
    if (!known(previous) || !known(current)) {
      return [metric, { delta: null, direction: "unknown", tone: "unknown" }];
    }
    const delta = zero(current - previous);
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "same";
    let tone = "neutral";
    if (delta !== 0) {
      if (metric === "price") tone = delta < 0 ? "positive" : "negative";
      else if (goal === undefined && ["kcal", "protein", "sodium"].includes(metric)) {
        tone = (metric === "protein" ? delta > 0 : delta < 0) ? "positive" : "negative";
      } else if (goal === "lower-kcal") {
        if (metric === "kcal") tone = delta < 0 ? "positive" : "negative";
        else if (metric === "protein" && delta < 0) tone = "negative";
      } else if (goal === "higher-protein" && metric === "protein") tone = delta > 0 ? "positive" : "negative";
      else if (goal === "lower-sodium" && metric === "sodium") tone = delta < 0 ? "positive" : "negative";
    }
    return [metric, { delta, direction, tone }];
  }));
}

function validId(id) {
  return (typeof id === "string" && id.trim() !== "") || (typeof id === "number" && Number.isFinite(id));
}

function mergeItems(items) {
  validateItems(items);
  const rows = new Map();
  for (const { food, qty } of items) {
    if (!validId(food.id)) throw new TypeError("推荐餐品必须包含有效 id");
    const existing = rows.get(food.id);
    if (existing) {
      const combined = existing.qty + qty;
      if (!Number.isFinite(combined)) throw new RangeError("合计份数过大");
      existing.qty = combined;
    } else {
      rows.set(food.id, { food, qty });
    }
  }
  return [...rows.values()];
}

function category(food) {
  return typeof food.category === "string" ? food.category.trim().toLowerCase() : "";
}

function validateLimit(value, label) {
  if (!(value === Infinity || known(value))) throw new RangeError(`${label} 必须是非负数或 Infinity`);
}

/** Replace a whole row, preserving its quantity; coalesce an existing destination row. */
export function recommendSwaps(items, foods, {
  lockedIds = [], maxKcal = Infinity, maxPrice = Infinity, goal = "lower-kcal",
  minProtein = 0, maxFat = Infinity, maxCarbohydrate = Infinity, maxSodium = Infinity,
} = {}) {
  if (!Array.isArray(foods)) throw new TypeError("foods 必须是数组");
  if (!Array.isArray(lockedIds)) throw new TypeError("lockedIds 必须是数组");
  validateLimit(maxKcal, "maxKcal");
  validateLimit(maxPrice, "maxPrice");
  validateLimit(maxFat, "maxFat");
  validateLimit(maxCarbohydrate, "maxCarbohydrate");
  validateLimit(maxSodium, "maxSodium");
  if (!known(minProtein)) throw new RangeError("minProtein 必须是有限非负数");
  if (!GOALS.has(goal)) throw new RangeError("推荐目标无效");
  const baseline = mergeItems(items);
  const before = summarize(baseline);
  const objective = { "lower-kcal": "kcal", "higher-protein": "protein", "lower-sodium": "sodium" }[goal];
  if (objective && before[objective] === null) return [];
  const limits = { kcal: maxKcal, price: maxPrice, fat: maxFat, carbohydrate: maxCarbohydrate, sodium: maxSodium };
  const locked = new Set(lockedIds);
  const candidates = new Map();
  for (const food of foods) {
    if (food && typeof food === "object" && validId(food.id) && !candidates.has(food.id)) {
      candidates.set(food.id, food);
    }
  }
  const results = [];
  for (let index = 0; index < baseline.length; index++) {
    const from = baseline[index];
    if (locked.has(from.food.id) || !category(from.food)) continue;
    for (const to of candidates.values()) {
      if (to.id === from.food.id || category(to) !== category(from.food)
        || Boolean(to.isMeal) !== Boolean(from.food.isMeal)) continue;
      // Existing rows are authoritative for their own nutritional data.
      const existing = baseline.find((row) => row.food.id === to.id);
      if (existing && locked.has(to.id)) continue;
      const target = existing?.food ?? to;
      if (category(target) !== category(from.food)
        || Boolean(target.isMeal) !== Boolean(from.food.isMeal)) continue;
      const next = baseline.map((row, rowIndex) => ({ food: rowIndex === index ? target : row.food, qty: row.qty }));
      const nextItems = mergeItems(next);
      const after = summarize(nextItems);
      if (Object.entries(limits).some(([metric, limit]) => limit !== Infinity && (after[metric] === null || after[metric] > limit))) continue;
      if (minProtein > 0 && (after.protein === null || after.protein < minProtein)) continue;
      if (objective) {
        if (after[objective] === null) continue;
        const delta = after[objective] - before[objective];
        if (goal === "higher-protein" ? delta <= 0 : delta >= 0) continue;
      }
      const comparison = compare(before, after, { goal });
      if (goal === "neutral" && !NUTRIENT_KEYS.some((metric) => comparison[metric].delta !== null && comparison[metric].delta !== 0)) continue;
      results.push({ fromId: from.food.id, toId: to.id, items: nextItems, before: { ...before }, after, comparison,
        goal, comparisonOnly: goal === "neutral" || after.price === null });
    }
  }
  results.sort((a, b) => {
    const objectiveOrder = objective ? (a.after[objective] - b.after[objective]) * (goal === "higher-protein" ? -1 : 1) : 0;
    if (objectiveOrder) return objectiveOrder;
    if (a.after.price === null && b.after.price !== null) return 1;
    if (b.after.price === null && a.after.price !== null) return -1;
    return a.after.price === null ? 0 : a.after.price - b.after.price;
  });
  return results.slice(0, 3);
}
