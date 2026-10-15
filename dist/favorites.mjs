/** Local recipes only. Restoring a recipe must revalidate its menu and selections. */
export const FAVORITES_STORAGE_KEY = 'maimai-nutrition-favorites-v2';
export const LEGACY_FAVORITES_STORAGE_KEY = 'maimai-nutrition-favorites-v1';
export const FAVORITES_LIMITS = Object.freeze({ recipes: 20, items: 100, selections: 100, name: 80, code: 128, quantity: 10000 });

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validQuantity = (value) => Number.isInteger(value) && value >= 1 && value <= FAVORITES_LIMITS.quantity;
function text(value, limit, { numeric = false } = {}) {
  if (numeric && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= limit && !/[\u0000-\u001f\u007f]/.test(cleaned) ? cleaned : null;
}
function code(value) {
  const cleaned = text(value, FAVORITES_LIMITS.code, { numeric: true });
  return cleaned && !['__proto__', 'constructor', 'prototype'].includes(cleaned) ? cleaned : null;
}
function cleanSelections(value) {
  if (!object(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > FAVORITES_LIMITS.selections) return null;
  const selected = {};
  for (const [round, choice] of entries) {
    const roundCode = code(round);
    if (!roundCode) return null;
    if (object(choice)) {
      const choices = Object.entries(choice);
      if (choices.length > FAVORITES_LIMITS.selections) return null;
      const counted = {};
      for (const [option, qty] of choices) {
        const optionCode = code(option);
        if (!optionCode || !validQuantity(qty)) return null;
        counted[optionCode] = qty;
      }
      selected[roundCode] = counted;
    } else {
      const choiceCode = code(choice);
      if (!choiceCode) return null;
      selected[roundCode] = choiceCode;
    }
  }
  return selected;
}
function cleanItem(item, mode) {
  if (!object(item) || !validQuantity(item.qty)) return null;
  const name = text(item.name, FAVORITES_LIMITS.name);
  const selections = cleanSelections(item.selections);
  if (!name || selections === null || typeof item.locked !== 'boolean') return null;
  if (mode === 'store') {
    const productCode = code(item.productCode);
    return productCode ? { productCode, qty: item.qty, selections, name, locked: item.locked } : null;
  }
  const demoId = code(item.demoId);
  return demoId && (Object.keys(selections).length === 0 || demoId.startsWith('sample-meal-'))
    ? { productCode: null, qty: item.qty, selections, name, demoId, locked: item.locked } : null;
}

/** Return an allowlisted recipe, or null. Unknown fields never enter browser storage. */
export function validateFavorite(raw) {
  try {
    if (!object(raw) || raw.schemaVersion !== 2 || !['store', 'demo'].includes(raw.mode)) return null;
    const id = code(raw.id);
    const name = text(raw.name, FAVORITES_LIMITS.name);
    if (!id || !name || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > FAVORITES_LIMITS.items) return null;
    let store = null;
    if (raw.mode === 'store') {
      if (!object(raw.store)) return null;
      const storeCode = code(raw.store.code);
      const storeName = text(raw.store.name, FAVORITES_LIMITS.name);
      if (!storeCode || !storeName) return null;
      store = { code: storeCode, name: storeName };
    }
    const items = raw.items.map((item) => cleanItem(item, raw.mode));
    if (items.some((item) => item === null)) return null;
    return { schemaVersion: 2, id, name, mode: raw.mode, store, items };
  } catch {
    return null;
  }
}

function newId() {
  return `favorite-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

/** Accept cart rows ({food, qty}) or already minimal recipe items. */
export function createFavorite({ name, store = null, items, lockedIds = new Set() } = {}) {
  const mode = store === null ? 'demo' : 'store';
  if (!Array.isArray(items)) throw new TypeError('餐单项目无效');
  const locks = lockedIds instanceof Set ? lockedIds : new Set(Array.isArray(lockedIds) ? lockedIds : []);
  const minimal = items.map((row) => {
    if (!object(row)) return row;
    const food = object(row.food) ? row.food : row;
    return {
      productCode: mode === 'store' ? food.productCode ?? food.quoteItem?.productCode ?? food.parentCode : null,
      qty: row.qty,
      selections: food.selections ?? {},
      name: food.name,
      ...(mode === 'demo' ? { demoId: food.demoId ?? food.id } : {}),
      locked: typeof row.locked === 'boolean' ? row.locked : locks.has(food.id),
    };
  });
  const favorite = validateFavorite({ schemaVersion: 2, id: newId(), name, mode, store, items: minimal });
  if (!favorite) throw new TypeError('餐单包含无效的门店、餐品、份数或选配，未保存');
  return favorite;
}

function safeParse(raw) {
  if (typeof raw !== 'string' || raw.length > 1024 * 1024) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function validList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of raw.slice(0, FAVORITES_LIMITS.recipes)) {
    const favorite = validateFavorite(entry);
    if (favorite && !seen.has(favorite.id)) { seen.add(favorite.id); result.push(favorite); }
  }
  return result;
}
function migrateLegacy(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, FAVORITES_LIMITS.recipes).flatMap((entry, index) => {
    if (!object(entry) || !Array.isArray(entry.rows)) return [];
    const favorite = validateFavorite({
      schemaVersion: 2, id: `legacy-favorite-${index}`, name: entry.name, mode: 'demo', store: null,
      items: entry.rows.map((row) => ({ productCode: null, qty: row?.qty, selections: {}, name: row?.id,
        demoId: row?.id, locked: false })),
    });
    return favorite ? [favorite] : [];
  });
}

/** Corrupt or unavailable storage is treated as empty. Legacy recipes are demo-only. */
export function loadFavorites(storage) {
  try {
    const current = storage.getItem(FAVORITES_STORAGE_KEY);
    if (current !== null) return validList(safeParse(current));
    const migrated = migrateLegacy(safeParse(storage.getItem(LEGACY_FAVORITES_STORAGE_KEY)));
    if (migrated.length) {
      try { saveFavorites(storage, migrated); } catch { /* Reading remains usable when storage is read-only. */ }
    }
    return migrated;
  } catch {
    return [];
  }
}

/** Throw on write failure so the UI never reports an unsaved recipe as saved. */
export function saveFavorites(storage, list) {
  const favorites = validList(list);
  storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  return favorites;
}
