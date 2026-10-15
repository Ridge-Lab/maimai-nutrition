import { unwrapResult, normalizeMenu, matchNutrition } from './live-menu.mjs';
import { NUTRIENT_KEYS } from './engine.mjs';

const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const codeText = (code) => code == null ? '' : String(code);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const selectionCode = (value) => {
  const code = codeText(value);
  if (!code || ['__proto__', 'prototype', 'constructor'].includes(code)) throw new Error('选配编码无效');
  return code;
};
const MAX_PORTIONS = 10000;

/** quantity is the official current/default count, not a replacement for min/max. */
export function roundLimits(round) {
  if (!round || !Number.isSafeInteger(round.quantity) || round.quantity < 0 || round.quantity > MAX_PORTIONS ||
      !Number.isSafeInteger(round.minQuantity) || round.minQuantity < 0 || round.minQuantity > MAX_PORTIONS ||
      !Number.isSafeInteger(round.maxQuantity) || round.maxQuantity < -1 || round.maxQuantity > MAX_PORTIONS) {
    throw new Error('选配轮次份数规则无法识别');
  }
  const min = round.minQuantity, max = round.maxQuantity === -1 ? MAX_PORTIONS : round.maxQuantity;
  if (max < min || round.quantity > max) throw new Error('选配轮次份数规则不一致');
  return { min, max, single: min === 1 && max === 1 };
}

/** Validate all selected codes and quantities. Only a pending round may be below min. */
export function normalizeRoundSelection(round, value, { allowIncomplete = false } = {}) {
  const { min, max, single } = roundLimits(round);
  let entries;
  if (value === undefined || value === null) entries = [];
  else if (typeof value === 'string' || typeof value === 'number') entries = [[selectionCode(value), 1]];
  else if (object(value)) entries = Object.entries(value);
  else throw new Error(`${round.name}的选配格式无效`);
  if (entries.length > MAX_PORTIONS) throw new Error('选配项目过多');
  const counts = {};
  let total = 0;
  for (const [rawCode, qty] of entries) {
    const code = selectionCode(rawCode), option = round.options.find((item) => item.code === code);
    if (!option) throw new Error(`选项不属于${round.name}`);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_PORTIONS) throw new Error(`${round.name}的选项份数必须为正整数`);
    if (!Number.isSafeInteger(option.maxQuantity) || option.maxQuantity < -1) throw new Error('选项最大份数未知');
    if (option.maxQuantity === 0) throw new Error('此选项当前不可选');
    if (option.maxQuantity !== -1 && qty > option.maxQuantity) throw new Error(`${option.name}超过最多可选份数`);
    total += qty;
    if (total > max) throw new Error(`${round.name}最多选择 ${max} 份`);
    counts[code] = qty;
  }
  if (!allowIncomplete && total < min) throw new Error(`请选择${round.name}，还需 ${min - total} 份`);
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return { selection: single && total === 1 ? Object.keys(sorted)[0] : sorted,
    counts: sorted, total, min, max, single, complete: total >= min && total <= max };
}

/** Preserve an explicit incomplete recipe; never silently fill it with defaults. */
export function initialMealSelections(detail, requested = detail.defaultSelections ?? {}) {
  const result = {};
  for (const round of detail.rounds) {
    const key = String(round.id), value = requested?.[key];
    const entries = typeof value === 'string' || typeof value === 'number' ? [[String(value), 1]] : object(value) ? Object.entries(value) : [];
    const retained = {};
    for (const [code, qty] of entries) {
      try { normalizeRoundSelection(round, { ...retained, [code]: qty }, { allowIncomplete: true }); retained[code] = qty; }
      catch { /* A disappeared/default-unavailable choice remains pending for the user. */ }
    }
    const normalized = normalizeRoundSelection(round, retained, { allowIncomplete: true });
    if (normalized.total || normalized.min === 0) result[key] = normalized.selection;
  }
  return result;
}

/** Stable, collision-free key for single choices and counted multi-choice recipes. */
export function mealSelectionKey(selections) {
  return Object.entries(selections).sort(([a], [b]) => a.localeCompare(b)).map(([round, selected]) => {
    const entries = object(selected) ? Object.entries(selected) : [[String(selected), 1]];
    return encodeURIComponent(round) + '=' + entries.sort(([a], [b]) => a.localeCompare(b))
      .map(([code, qty]) => encodeURIComponent(code) + ':' + qty).join(',');
  }).join(';') || 'standard';
}

// Required toy choices remain in the recipe and quote, but only foods enter
// nutrition totals. Food/meal names containing a toy promotion stay unknown.
function nonFoodComponent(name) {
  return /水手帽|徽章|玩具|公仔|钥匙扣|购物袋|保温杯|马克杯|周边|盲盒|积木|贴纸|手办/.test(name)
    && !/套餐|件套|分享餐|开心乐园餐|汉堡|麦满分|松饼|薯条|玉米|鸡块|麦乐鸡|鸡翅|鸡腿|鱼排|饮料|咖啡|牛奶|奶昔|可乐|冰淇淋|甜筒|圆筒|苹果|蘸酱/.test(name);
}

function matchFood(code, name, records) {
  const normalized = normalizeMenu({ categories: [], meals: { [code]: { name } } }, records).foods[0];
  return { ...normalized, name, ...matchNutrition(name, records,{code}) };
}

function difference(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([+-])?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)$/);
  if (!match) return null;
  const amount = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return Number.isFinite(amount) ? amount : null;
}

function defaultModification(source) {
  if (source.supportModify !== true || source.modification == null) return undefined;
  const groups = source.modification.items;
  if (!Array.isArray(groups)) throw new Error('特制默认选项结构未知，暂不能生成核价参数');
  const values = [];
  for (const group of groups) {
    if (!Array.isArray(group.values)) throw new Error('特制默认选项结构未知');
    for (const item of group.values) {
      if (!Number.isSafeInteger(item.selectedQuantity) || item.selectedQuantity < 0) throw new Error('特制默认份数未知');
      const selected = item.selectedQuantity > 0;
      // Checkbox-like groups require an explicit unselected key; radio groups
      // only send the chosen option. These keys come from the official detail.
      if (!selected && !item.unselectedKey) continue;
      const key = selected ? item.selectedKey : item.unselectedKey;
      const code = codeText(item.code);
      if (!code || typeof key !== 'string' || !key) throw new Error('特制默认编码缺失');
      values.push({ code, quantity: item.selectedQuantity, key });
    }
  }
  return values.length ? { values } : undefined;
}

function parseOption(choice, records) {
  if (!choice || !codeText(choice.code) || typeof choice.name !== 'string') throw new Error('选配餐品编码或名称缺失');
  const code = selectionCode(choice.code);
  if (choice.quantity !== undefined && (!Number.isSafeInteger(choice.quantity) || choice.quantity < 0 || choice.quantity > MAX_PORTIONS)) throw new Error('默认选配份数无法识别');
  if (!Number.isSafeInteger(choice.maxQuantity) || choice.maxQuantity < -1) throw new Error('选项最大份数未知');
  const food = matchFood(code, choice.name, records);
  return {
    code, name: choice.name, nonFood: nonFoodComponent(choice.name), image: typeof choice.image === 'string' ? choice.image : null, icon: food.icon,
    ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, known(food[key]) ? food[key] : null])),
    nutritionMatch: food.nutritionMatch, nutritionName: food.nutritionName, nutritionNote: food.nutritionNote ?? null,
    nutritionSource: food.nutritionSource ?? null, sourceUrl: food.sourceUrl ?? 'https://open.mcd.cn/mcp/doc',
    quantity: choice.quantity, maxQuantity: choice.maxQuantity,
    isDefault: choice.isDefault === 1 || choice.isDefault === true,
    diffPrice: choice.diffPrice ?? null, diffPriceValue: difference(choice.diffPrice),
    supportModify: choice.supportModify === true,
    modification: choice.modification == null ? null : structuredClone(choice.modification),
  };
}

/** Nutrition is matched only after the official detail supplies the full name. */
export function parseMealDetail(result, nutritionRecords) {
  const source = unwrapResult(result);
  if (!source || !codeText(source.code) || typeof source.name !== 'string' || !Array.isArray(source.rounds)) throw new Error('餐品详情结构无法识别');
  const code = codeText(source.code);
  const food = matchFood(code, source.name, nutritionRecords);
  const defaultSelections = {};
  const ids = new Set();
  const rounds = source.rounds.map((round) => {
    if (!round || round.id == null || !Array.isArray(round.choices) || !round.choices.length) throw new Error('选配轮次结构无法识别');
    const key = selectionCode(round.id);
    if (ids.has(key)) throw new Error('选配轮次编码重复');
    ids.add(key);
    const options = round.choices.map((choice) => parseOption(choice, nutritionRecords));
    if (new Set(options.map((option) => option.code)).size !== options.length) throw new Error('选配餐品编码重复');
    const parsed = { id: round.id, name: typeof round.name === 'string' ? round.name : '',
      quantity: round.quantity, minQuantity: round.minQuantity, maxQuantity: round.maxQuantity,
      options };
    const { single } = roundLimits(parsed);
    // In multi-choice rounds isDefault may mark only the pricing reference.
    // Every positive choice.quantity is part of the official current recipe.
    const counts = Object.fromEntries(options.flatMap((option) => {
      const qty = option.quantity ?? (single && option.isDefault ? 1 : 0);
      return qty > 0 ? [[option.code, qty]] : [];
    }));
    const total = Object.values(counts).reduce((sum, qty) => sum + qty, 0);
    const defaultCode = single && total === 1 ? Object.keys(counts)[0] : null;
    if (total || parsed.minQuantity === 0) defaultSelections[key] = defaultCode ?? counts;
    return { ...parsed, defaultCode };
  });
  return { code, name: source.name, image: source.image ?? null,
    rounds, defaultSelections, configurable: rounds.length > 0, isMeal: food.isMeal === true,
    ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, !rounds.length && known(food[key]) ? food[key] : null])),
    nutritionMatch: food.nutritionMatch, nutritionName: food.nutritionName, nutritionNote: food.nutritionNote ?? null,
    nutritionSource: food.nutritionSource ?? null, sourceUrl: food.sourceUrl ?? 'https://open.mcd.cn/mcp/doc',
    supportModify: source.supportModify === true, modification: source.modification == null ? null : structuredClone(source.modification) };
}

function component(source, qty = 1) {
  return { code: source.code, name: source.name, qty, nonFood: source.nonFood === true, image: source.image ?? null, icon: source.icon,
    ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, known(source[key]) ? source[key] : null])),
    nutritionMatch: source.nutritionMatch ?? 'unmatched', nutritionName: source.nutritionName ?? null, nutritionNote: source.nutritionNote ?? null,
    nutritionSource: source.nutritionSource ?? null, sourceUrl: source.sourceUrl ?? 'https://open.mcd.cn/mcp/doc' };
}

/** Each selected portion is retained in both the nutrition sum and official quote. */
export function buildMeal(detail, selections = {}) {
  if (!detail || !codeText(detail.code) || !Array.isArray(detail.rounds)) throw new TypeError('餐品详情无效');
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) throw new TypeError('选配必须是按轮次编码保存的对象');
  const roundKeys = new Set(detail.rounds.map((round) => String(round.id)));
  if (Object.keys(selections).some((key) => !roundKeys.has(key))) throw new Error('选配包含未知轮次');
  const components = [];
  const quoteItem = { productCode: codeText(detail.code), quantity: 1 };
  const selected = {};
  let priceDifference = 0;
  if (!detail.rounds.length) {
    components.push(component(detail));
    const modification = defaultModification(detail);
    if (modification) quoteItem.modification = modification;
  } else {
    quoteItem.roundList = detail.rounds.map((round) => {
      const key = String(round.id);
      const value = Object.prototype.hasOwnProperty.call(selections, key) ? selections[key] : detail.defaultSelections?.[key] ?? round.defaultCode;
      const normalized = normalizeRoundSelection(round, value);
      selected[key] = normalized.selection;
      const comboItemList = Object.entries(normalized.counts).map(([code, qty]) => {
        const option = round.options.find((item) => item.code === code);
        const existing = components.find((item) => item.code === code);
        if (existing) {
          existing.qty += qty;
          for (const metric of NUTRIENT_KEYS) if (existing[metric] !== option[metric]) existing[metric] = null;
        } else components.push(component(option, qty));
        if (priceDifference !== null) priceDifference = option.diffPriceValue === null ? null : priceDifference + option.diffPriceValue * qty;
        const item = { code: option.code, quantity: qty };
        const modification = defaultModification(option);
        if (modification) item.modification = modification;
        return item;
      });
      return { round: round.id, comboItemList };
    });
  }
  const totals = {}, knownTotals = {}, missingComponents = {};
  const foodComponents = components.filter((item) => !item.nonFood);
  for (const metric of NUTRIENT_KEYS) {
    const knownComponents = foodComponents.filter((item) => known(item[metric]));
    knownTotals[metric] = knownComponents.length || foodComponents.length === 0 ? knownComponents.reduce((sum, item) => sum + item[metric] * item.qty, 0) : null;
    missingComponents[metric] = foodComponents.filter((item) => !known(item[metric])).map(({ code, name, qty }) => ({ code, name, qty }));
    totals[metric] = missingComponents[metric].length === 0 ? knownTotals[metric] : null;
    if (!Number.isFinite(totals[metric])) totals[metric] = null;
  }
  const complete = Object.values(totals).every((value) => value !== null);
  return { ...totals, code: codeText(detail.code), parentCode: codeText(detail.code), name: detail.name,
    spec: components.map((item) => item.name + (item.qty > 1 ? ' ×' + item.qty : '')).join(' / '), components, quoteItem, selections: selected,
    knownTotals, missingComponents, selectionComplete: true,
    nutritionMatch: detail.rounds.length ? (complete ? 'components' : 'partial-components') : detail.nutritionMatch,
    nutritionName: detail.rounds.length ? null : detail.nutritionName,
    nutritionSource: components.some((item) => item.nutritionSource) ? (detail.rounds.length?'official-component-sum':detail.nutritionSource) : null,
    sourceUrl: detail.sourceUrl ?? 'https://open.mcd.cn/mcp/doc',
    priceDifference: priceDifference === null ? null : Math.round(priceDifference * 100) / 100,
    unknownKcalCount: foodComponents.filter((item) => !known(item.kcal)).reduce((sum, item) => sum + item.qty, 0),
    complete };
}
