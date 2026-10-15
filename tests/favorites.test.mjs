import test from 'node:test';
import assert from 'node:assert/strict';
import { createFavorite, validateFavorite, loadFavorites, saveFavorites, FAVORITES_STORAGE_KEY, LEGACY_FAVORITES_STORAGE_KEY } from '../dist/favorites.mjs';

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value), values };
};
const cart = () => [{ food: { id: 'configured-combo-1', productCode: '9900005456', name: '麦辣鸡腿汉堡三件套',
  selections: { 1: '1440', 2: '4437', 3: '3071' }, kcal: 538, price: 33, token: 'never-persist',
  quoteItem: { productCode: '9900005456', quantity: 1, roundList: [] } }, qty: 3 }];
const recipe = () => createFavorite({ name: '工作日午餐', store: { code: '1450713', name: '示例餐厅' }, items: cart(), lockedIds: new Set(['configured-combo-1']) });

test('real recipe roundtrip preserves store, quantity, choices and lock, without token, price or nutrition', () => {
  const favorite = recipe();
  const storage = memoryStorage();
  saveFavorites(storage, [favorite]);
  assert.deepEqual(loadFavorites(storage), [favorite]);
  assert.deepEqual(favorite.items[0], { productCode: '9900005456', qty: 3, selections: { 1: '1440', 2: '4437', 3: '3071' }, name: '麦辣鸡腿汉堡三件套', locked: true });
  const stored = storage.getItem(FAVORITES_STORAGE_KEY);
  for (const forbidden of ['never-persist', 'token', 'kcal', 'price', 'quoteItem', 'roundList']) assert.equal(stored.includes(forbidden), false);
});

test('validation strips sensitive and stale fields at every nesting level', () => {
  const raw = recipe();
  raw.token = 'secret'; raw.quote = { amount: 3300 };
  raw.store.accountId = 'account';
  raw.items[0].price = 33; raw.items[0].nutrition = { sodium: 1000 };
  const clean = validateFavorite(raw);
  assert.deepEqual(Object.keys(clean), ['schemaVersion', 'id', 'name', 'mode', 'store', 'items']);
  assert.deepEqual(Object.keys(clean.store), ['code', 'name']);
  assert.deepEqual(Object.keys(clean.items[0]), ['productCode', 'qty', 'selections', 'name', 'locked']);
});

test('quantities must be finite positive integers within the upper bound; no silent clamping', () => {
  for (const qty of [0, -1, 1.5, NaN, Infinity, '1', 10001]) {
    const raw = recipe(); raw.items[0].qty = qty;
    assert.equal(validateFavorite(raw), null, String(qty));
    const items = cart(); items[0].qty = qty;
    assert.throws(() => createFavorite({ name: '无效', store: { code: '1', name: '店' }, items }), TypeError);
  }
  const raw = recipe(); raw.items[0].qty = 10000;
  assert.equal(validateFavorite(raw).items[0].qty, 10000);
});

test('invalid selected rounds and nested selection objects are rejected', () => {
  for (const selections of [null, [], { 1: { code: '1440' } }, { 1: '' }, JSON.parse('{"__proto__":"choice"}'), { 1: 'constructor' }]) {
    const raw = recipe(); raw.items[0].selections = selections;
    assert.equal(validateFavorite(raw), null);
  }
  const raw = recipe(); raw.items[0].selections = { 1: 1440 };
  assert.deepEqual(validateFavorite(raw).items[0].selections, { 1: '1440' });
});

test('legacy favorites migrate as demo-only, never into live store recipes', () => {
  const legacy = [{ name: '旧搭配', rows: [{ id: 'grilled-chicken', qty: 2 }] }, { name: '坏数据', rows: [{ id: 'x', qty: Infinity }] }];
  const storage = memoryStorage({ [LEGACY_FAVORITES_STORAGE_KEY]: JSON.stringify(legacy) });
  const migrated = loadFavorites(storage);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].mode, 'demo');
  assert.equal(migrated[0].store, null);
  assert.equal(migrated[0].items[0].demoId, 'grilled-chicken');
  assert.equal(migrated[0].items[0].productCode, null);
  assert.deepEqual(loadFavorites(storage), migrated);
});

test('v2 presence prevents resurrection of deleted legacy favorites', () => {
  const storage = memoryStorage({ [FAVORITES_STORAGE_KEY]: '[]', [LEGACY_FAVORITES_STORAGE_KEY]: JSON.stringify([{ name: 'old', rows: [{ id: 'x', qty: 1 }] }]) });
  assert.deepEqual(loadFavorites(storage), []);
});

test('corrupt storage and malformed recipes fail closed', () => {
  for (const value of ['{oops', 'null', '{}', '[null,1,"x"]', 'x'.repeat(1024 * 1024 + 1)]) {
    assert.deepEqual(loadFavorites(memoryStorage({ [FAVORITES_STORAGE_KEY]: value })), []);
  }
  assert.deepEqual(loadFavorites({ getItem() { throw new Error('denied'); } }), []);
  const valid = recipe();
  assert.equal(validateFavorite({ ...valid, items: [] }), null);
  assert.equal(validateFavorite({ ...valid, name: 'x'.repeat(81) }), null);
  assert.equal(validateFavorite({ ...valid, items: Array(101).fill(valid.items[0]) }), null);
  assert.equal(validateFavorite({ ...valid, store: null }), null);
});

test('storage write failure is observable to callers', () => {
  assert.throws(() => saveFavorites({ setItem() { throw new Error('quota'); } }, [recipe()]), /quota/);
});

test('list is capped and duplicate ids are ignored without dropping valid neighboring recipes', () => {
  const first = recipe(); const second = { ...recipe(), id: 'second' };
  const saved = saveFavorites(memoryStorage(), [first, null, first, second, ...Array.from({ length: 22 }, (_, i) => ({ ...first, id: `extra-${i}` }))]);
  assert.equal(saved[0].id, first.id);
  assert.equal(saved[1].id, 'second');
  assert.ok(saved.length <= 20);
  assert.equal(new Set(saved.map((item) => item.id)).size, saved.length);
});

test('demo recipes retain demo id and never carry real selections', () => {
  const favorite = createFavorite({ name: '演示', items: [{ food: { id: 'grilled-chicken', name: '板烧鸡腿堡', price: 20, kcal: 400 }, qty: 2 }] });
  assert.equal(favorite.mode, 'demo');
  assert.deepEqual(favorite.items[0], { productCode: null, qty: 2, selections: {}, name: '板烧鸡腿堡', demoId: 'grilled-chicken', locked: false });
  favorite.items[0].selections = { 1: '1440' };
  assert.equal(validateFavorite(favorite), null);
});

test('counted multi-choice recipes roundtrip without flattening units or breaking old single strings', () => {
  const raw = recipe();
  raw.items[0].selections = { 1: { 1440: 2 }, 2: { 4810: 1, 4437: 2 }, 3: '3071' };
  const clean = validateFavorite(raw), storage = memoryStorage();
  assert.deepEqual(clean.items[0].selections, raw.items[0].selections);
  saveFavorites(storage, [clean]);
  assert.deepEqual(loadFavorites(storage), [clean]);
  for (const selections of [{ 1: { 1440: 0 } }, { 1: { 1440: 1.5 } }, { 1: { 1440: '2' } }, { 1: { 1440: 10001 } }, JSON.parse('{"1":{"__proto__":2}}')]) {
    raw.items[0].selections = selections;
    assert.equal(validateFavorite(raw), null);
  }
});

test('public sample meal demo recipe keeps counted choices; generic demo products reject them', () => {
  const items = [{ food: { id: 'configured-public', demoId: 'sample-meal-9900004066', name: '公开样例七件套', selections: { 1: { 1440: 2 }, 2: { 1700: 3 }, 3: { 3050: 2 } } }, qty: 2 }];
  const favorite = createFavorite({ name: '我的样例搭配', items });
  const storage = memoryStorage();
  saveFavorites(storage, [favorite]);
  assert.deepEqual(loadFavorites(storage)[0].items[0].selections, items[0].food.selections);
  assert.equal(favorite.items[0].demoId, 'sample-meal-9900004066');
  items[0].food.demoId = 'grilled-chicken';
  assert.throws(() => createFavorite({ name: '无效', items }), /无效/);
});
