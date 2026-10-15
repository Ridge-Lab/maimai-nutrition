export const COVERAGE_NUTRIENTS = Object.freeze(['kcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium']);
const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Matching and completeness are separate: a precise name may still lack one field. */
export function nutritionStatus(food) {
  if (food?.nutritionMatch === 'ambiguous' || food?.nutritionStatus === 'ambiguous') return 'ambiguous';
  if (['matched', 'unmatched'].includes(food?.nutritionStatus)) return food.nutritionStatus;
  if (!food?.resolvedRecipe && (food?.nutritionStatus === 'needs-selection' || food?.nutritionMatch === 'unexpanded-meal')) return 'needs-selection';
  if (food?.nutritionSource || ['exact', 'alias', 'components', 'partial-components'].includes(food?.nutritionMatch)) return 'matched';
  return 'unmatched';
}

export function nutrientCoverage(food) {
  const missing = COVERAGE_NUTRIENTS.filter((key) => !known(food?.[key]));
  return { known: COVERAGE_NUTRIENTS.length - missing.length, total: COVERAGE_NUTRIENTS.length, complete: missing.length === 0, missing };
}

/** Counts base SKUs and explicitly resolved configurations separately. */
export function coverageSummary(foods = []) {
  const base = foods.filter((food) => !food.resolvedRecipe);
  const variants = foods.filter((food) => food.resolvedRecipe);
  const statuses = { matched: 0, 'needs-selection': 0, unmatched: 0, ambiguous: 0 };
  for (const food of base) statuses[nutritionStatus(food)]++;
  const metricCounts = (rows) => Object.fromEntries(COVERAGE_NUTRIENTS.map((key) => {
    const count = rows.filter((food) => known(food[key])).length;
    return [key, { known: count, total: rows.length, rate: rows.length ? count / rows.length : 0 }];
  }));
  return {
    total: base.length, ...statuses, needsSelection: statuses['needs-selection'],
    complete: base.filter((food) => nutrientCoverage(food).complete).length,
    resolvedVariants: variants.length, resolvedComplete: variants.filter((food) => nutrientCoverage(food).complete).length,
    resolvedProducts: new Set(variants.map((food) => food.parentCode)).size,
    nutrients: metricCounts(base), variantNutrients: metricCounts(variants),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

/** Keep a verified combination as its own recipe, never as a generic SKU value. */
export function mergeResolvedMenu(foods, configuredFood) {
  if (!Array.isArray(foods) || !configuredFood || typeof configuredFood !== 'object') throw new TypeError('菜单和已确认搭配无效');
  const productCode = String(configuredFood.productCode ?? configuredFood.quoteItem?.productCode ?? configuredFood.parentCode ?? '');
  if (!productCode || !configuredFood.quoteItem || String(configuredFood.quoteItem.productCode) !== productCode) throw new TypeError('已确认搭配缺少一致的官方核价编码');
  if (!configuredFood.id || !configuredFood.spec) throw new TypeError('已确认搭配必须有独立标识和明确规格');
  const parent = foods.find((food) => !food.resolvedRecipe && String(food.productCode) === productCode);
  if (!parent) throw new Error('当前门店菜单中不存在此餐品');
  if (configuredFood.storeCode && parent.storeCode && String(configuredFood.storeCode) !== String(parent.storeCode)) throw new Error('已确认搭配与门店不一致');
  const { quantity: ignoredQuantity, ...recipeQuote } = configuredFood.quoteItem;
  const configurationKey = `${productCode}:${JSON.stringify(stable(recipeQuote))}`;
  const variant = {
    ...structuredClone(configuredFood), productCode, parentCode: productCode, resolvedRecipe: true, configurationKey,
    storeCode: parent.storeCode ?? configuredFood.storeCode,
    nutritionStatus: undefined,
  };
  // An inherited generic menu status must not make a selected recipe look unselected.
  variant.nutritionStatus = variant.components?.some((item) => item.nutritionMatch === 'ambiguous') ? 'ambiguous'
    : COVERAGE_NUTRIENTS.some((key) => known(variant[key])) ? 'matched' : 'unmatched';
  variant.nutrientCoverage = nutrientCoverage(variant);
  const next = foods.filter((food) => food.configurationKey !== configurationKey && !(food.resolvedRecipe && food.id === variant.id)).map((food) => ({ ...food }));
  next.push(variant);
  for (const food of next.filter((entry) => !entry.resolvedRecipe)) {
    const related = next.filter((entry) => entry.resolvedRecipe && entry.parentCode === String(food.productCode));
    food.resolvedVariantIds = related.map((entry) => entry.id);
    food.resolvedVariants = related.length;
    if (related.length) food.coverageNote = `已确认 ${related.length} 种具体搭配；营养值仅适用于各自标明的规格`;
  }
  return { foods: next, summary: coverageSummary(next) };
}
