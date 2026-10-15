const quantity = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validId = value => typeof value === 'string' ? value.trim() !== '' : typeof value === 'number' && Number.isFinite(value);
const productCode = food => food?.productCode == null ? '' : String(food.productCode).trim();
const text = value => typeof value === 'string' ? value : '';

/**
 * A base SKU reports its exact row and explicitly resolved recipes for that SKU.
 * A recipe card reports only its own id, never sibling configurations.
 * Component quantities are totals for each returned cart row, not per meal.
 */
export function selectionForFood(food, items = []) {
  const empty = { qty: 0, exactQty: 0, rows: [], configuredVariantCount: 0 };
  if (!food || !validId(food.id) || !Array.isArray(items)) return empty;
  const parentCode = productCode(food);
  const grouped = new Map();
  let exactQty = 0;
  for (const item of items) {
    if (!item?.food || !validId(item.food.id) || !quantity(item.qty)) continue;
    const exact = item.food.id === food.id;
    const related = food.resolvedRecipe !== true && parentCode !== ''
      && item.food.resolvedRecipe === true && productCode(item.food) === parentCode;
    if (!exact && !related) continue;
    if (exact) exactQty += item.qty;
    const previous = grouped.get(item.food.id);
    if (previous) previous.qty += item.qty;
    else grouped.set(item.food.id, { food: item.food, qty: item.qty });
  }
  let qty = 0;
  let configuredVariantCount = 0;
  const rows = [...grouped.values()].map(item => {
    qty += item.qty;
    if (!Number.isFinite(qty) || !Number.isFinite(exactQty)) throw new RangeError('餐单合计份数过大');
    if (item.food.resolvedRecipe === true) configuredVariantCount++;
    const components = (Array.isArray(item.food.components) ? item.food.components : [])
      .filter(component => component && quantity(component.qty))
      .map(component => {
        const total = component.qty * item.qty;
        if (!Number.isFinite(total)) throw new RangeError('套餐组件合计份数过大');
        return { name: text(component.name), qty: total };
      });
    return { id: item.food.id, name: text(item.food.name), spec: text(item.food.spec), qty: item.qty, components };
  });
  return { qty, exactQty, rows, configuredVariantCount };
}
