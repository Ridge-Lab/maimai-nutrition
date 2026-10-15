import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFocus, restoreFocus } from '../dist/focus.mjs';

function fakeDocument() {
  const doc = { activeElement: null, nodes: [], selectors: [] };
  doc.getElementById = (id) => doc.nodes.find((element) => element.id === id) ?? null;
  doc.querySelectorAll = (selector) => {
    doc.selectors.push(selector);
    const keys = { 'button[data-add]': 'add', 'button[data-qty]': 'qty', 'button[data-lock]': 'lock', 'button[data-swap]': 'swap',
      'button[data-category]': 'category', 'button[data-swap-other]': 'swapOther', 'button[data-replace-from]': 'replaceFrom' };
    assert.ok(Object.hasOwn(keys, selector), `only constant selectors allowed: ${selector}`);
    return doc.nodes.filter((element) => element.tagName === 'BUTTON' && Object.hasOwn(element.dataset, keys[selector]));
  };
  doc.node = ({ id = '', data = {}, disabled = false, inDialog = false, tagName = 'BUTTON' } = {}) => {
    const attributes = {};
    const element = { id, dataset: data, disabled, inDialog, tagName, isConnected: true, focusCalls: [],
      focus(options) { this.focusCalls.push(options); doc.activeElement = this; },
      closest(selector) { return selector === '#app-dialog' && inDialog ? doc.getElementById('app-dialog') : null; },
      getAttribute(name) { return attributes[name] ?? null; }, setAttribute(name, value) { attributes[name] = value; },
    };
    doc.nodes.push(element); return element;
  };
  doc.dialog = doc.node({ id: 'app-dialog', tagName: 'DIALOG' });
  doc.dialog.open = false; doc.dialog.contains = (element) => Boolean(element?.inDialog);
  doc.fallback = doc.node({ id: 'my-meal', tagName: 'ASIDE' });
  return doc;
}

test('quantity focus survives repeated cart renders and keeps the plus/minus operation', () => {
  const doc = fakeDocument();
  let plus = doc.node({ data: { qty: 'burger', step: '1' } }); doc.activeElement = plus;
  for (let count = 0; count < 3; count++) {
    const snapshot = captureFocus(doc);
    doc.nodes = doc.nodes.filter((element) => !element.dataset.qty);
    const minus = doc.node({ data: { qty: 'burger', step: '-1' } });
    plus = doc.node({ data: { qty: 'burger', step: '1' } });
    assert.equal(restoreFocus(snapshot, { document: doc }), true);
    assert.strictEqual(doc.activeElement, plus);
    assert.equal(minus.focusCalls.length, 0);
    assert.deepEqual(plus.focusCalls, [{ preventScroll: true }]);
  }
});

test('lock action stays focused instead of moving to another control on the same item', () => {
  const doc = fakeDocument(); const original = doc.node({ data: { lock: 'burger' } }); doc.activeElement = original;
  const snapshot = captureFocus(doc); doc.nodes = doc.nodes.filter((element) => element !== original);
  doc.node({ data: { swap: 'burger' } }); doc.node({ data: { qty: 'burger', step: '1' } });
  const replacement = doc.node({ data: { lock: 'burger' } });
  assert.equal(restoreFocus(snapshot, { document: doc }), true);
  assert.strictEqual(doc.activeElement, replacement);
});

test('after configuring a variant, new cart controls take priority over the old menu opener', () => {
  const doc = fakeDocument(); const opener = doc.node({ data: { add: 'old-parent' } }); doc.activeElement = opener;
  const snapshot = captureFocus(doc);
  const newSwap = doc.node({ data: { swap: 'configured-new' } });
  doc.node({ data: { qty: 'configured-new', step: '1' } });
  assert.equal(restoreFocus(snapshot, { document: doc, foodId: 'configured-new' }), true);
  assert.strictEqual(doc.activeElement, newSwap);
  assert.equal(opener.focusCalls.length, 0);
});

test('disabled new variant controls are skipped before returning to the original opener', () => {
  const doc = fakeDocument(); const opener = doc.node({ data: { add: 'old-parent' } }); doc.activeElement = opener;
  const snapshot = captureFocus(doc);
  const swap = doc.node({ data: { swap: 'configured-new' }, disabled: true });
  const plus = doc.node({ data: { qty: 'configured-new', step: '1' }, disabled: true });
  const minus = doc.node({ data: { qty: 'configured-new', step: '-1' } });
  assert.equal(restoreFocus(snapshot, { document: doc, foodId: 'configured-new' }), true);
  assert.strictEqual(doc.activeElement, minus);
  assert.equal(swap.focusCalls.length + plus.focusCalls.length, 0);
});

test('an open dialog never loses focus to a render restoration or a pending configuration target', () => {
  const doc = fakeDocument(); const opener = doc.node({ id: 'save-meal' }); doc.activeElement = opener;
  const snapshot = captureFocus(doc); const dialogInput = doc.node({ id: 'favorite-name', inDialog: true, tagName: 'INPUT' });
  doc.dialog.open = true; doc.activeElement = dialogInput; doc.node({ data: { swap: 'new' } });
  assert.equal(restoreFocus(snapshot, { document: doc }), false);
  assert.equal(restoreFocus(snapshot, { document: doc, foodId: 'new' }), false);
  assert.strictEqual(doc.activeElement, dialogInput);
  assert.equal(doc.fallback.focusCalls.length, 0);
});

test('anonymous dialog controls do not cause focus to jump into the background after closing', () => {
  const doc = fakeDocument(); doc.activeElement = doc.node({ inDialog: true, tagName: 'SELECT' });
  const snapshot = captureFocus(doc);
  assert.deepEqual(snapshot, { id: null, data: null, inDialog: true });
  assert.equal(restoreFocus(snapshot, { document: doc }), false);
  assert.equal(doc.fallback.focusCalls.length, 0);
});

test('missing or disabled opener falls back to a programmatically focusable meal panel without scrolling', () => {
  const doc = fakeDocument(); const old = doc.node({ id: 'gone' }); doc.activeElement = old;
  const snapshot = captureFocus(doc); doc.nodes = doc.nodes.filter((element) => element !== old);
  assert.equal(restoreFocus(snapshot, { document: doc }), true);
  assert.strictEqual(doc.activeElement, doc.fallback);
  assert.equal(doc.fallback.getAttribute('tabindex'), '-1');
  assert.deepEqual(doc.fallback.focusCalls, [{ preventScroll: true }]);
});

test('dataset values containing selector syntax are compared as plain text, never interpolated', () => {
  const doc = fakeDocument(); const value = 'x"]:not(button), [data-lock="other';
  const old = doc.node({ data: { add: value } }); doc.activeElement = old;
  const snapshot = captureFocus(doc); doc.nodes = doc.nodes.filter((element) => element !== old);
  const replacement = doc.node({ data: { add: value } });
  assert.equal(restoreFocus(snapshot, { document: doc }), true);
  assert.strictEqual(doc.activeElement, replacement);
  assert.deepEqual(doc.selectors, ['button[data-add]']);
});

test('stable IDs and category controls are restorable while missing DOM and invalid snapshots are harmless', () => {
  assert.equal(captureFocus({}), null);
  assert.equal(captureFocus(null), null);
  const doc = fakeDocument();
  for (const invalid of [null, undefined, 1, [], {}, { id: null, data: { key: '__proto__', value: 'x' }, inDialog: false }]) {
    assert.doesNotThrow(() => restoreFocus(invalid, { document: doc }));
    assert.equal(restoreFocus(invalid, { document: doc }), false);
  }
  const category = doc.node({ data: { category: 'side' } }); doc.activeElement = category;
  assert.equal(restoreFocus(captureFocus(doc), { document: doc }), true);
  const input = doc.node({ id: 'kcal-budget', tagName: 'INPUT' }); doc.activeElement = input;
  const snapshot = captureFocus(doc); doc.nodes = doc.nodes.filter((element) => element !== input);
  const newInput = doc.node({ id: 'kcal-budget', tagName: 'INPUT' });
  assert.equal(restoreFocus(snapshot, { document: doc }), true);
  assert.strictEqual(doc.activeElement, newInput);
  assert.equal(restoreFocus(snapshot, { document: null }), false);
});
