const TARGETS = Object.freeze({
  add: 'button[data-add]', qty: 'button[data-qty]', lock: 'button[data-lock]',
  swap: 'button[data-swap]', category: 'button[data-category]',
  swapOther: 'button[data-swap-other]', replaceFrom: 'button[data-replace-from]',
});
const boundedText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const dialogFor = (doc) => doc?.getElementById?.('app-dialog') ?? null;
const insideDialog = (element, dialog) => Boolean(dialog && (element === dialog || dialog.contains?.(element) || element?.closest?.('#app-dialog') === dialog));
const isOpen = (dialog) => dialog?.open === true || dialog?.hasAttribute?.('open') === true;

function usable(element, dialog) {
  return Boolean(element && typeof element.focus === 'function' && element.isConnected !== false
    && !element.disabled && !element.hidden && element.getAttribute?.('aria-disabled') !== 'true'
    && !element.closest?.('[hidden], [inert]') && !insideDialog(element, dialog));
}
function selectedData(element) {
  for (const key of Object.keys(TARGETS)) {
    const value = element?.dataset?.[key];
    if (!boundedText(value)) continue;
    if (key === 'qty') {
      const step = element.dataset.step;
      if (step !== '1' && step !== '-1') continue;
      return { key, value, step };
    }
    if (key === 'replaceFrom') {
      const to = element.dataset.replaceTo;
      if (!boundedText(to)) continue;
      return { key, value, to };
    }
    return { key, value };
  }
  return null;
}

/** Keep stable identifiers only; never retain a node that render() can detach. */
export function captureFocus(doc = globalThis.document) {
  try {
    const element = doc?.activeElement;
    if (!element) return null;
    const id = boundedText(element.id) ? element.id : null;
    const data = selectedData(element);
    const inDialog = insideDialog(element, dialogFor(doc));
    return id || data || inDialog ? { id, data, inDialog } : null;
  } catch { return null; }
}

function validSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.inDialog !== 'boolean') return false;
  if (snapshot.id !== null && !boundedText(snapshot.id)) return false;
  if (snapshot.data !== null) {
    const data = snapshot.data;
    if (!data || typeof data !== 'object' || !Object.hasOwn(TARGETS, data.key) || !boundedText(data.value)) return false;
    if (data.key === 'qty' && !['1', '-1'].includes(data.step)) return false;
    if (data.key === 'replaceFrom' && !boundedText(data.to)) return false;
  }
  return Boolean(snapshot.id || snapshot.data || snapshot.inDialog);
}
function matching(doc, key, value, extra = {}) {
  return Array.from(doc?.querySelectorAll?.(TARGETS[key]) ?? []).filter((element) => element.dataset?.[key] === value
    && (key !== 'qty' || !extra.step || element.dataset.step === extra.step)
    && (key !== 'replaceFrom' || element.dataset.replaceTo === extra.to));
}

/** Restore quietly after render or a closed configuration dialog. Never steal modal focus. */
export function restoreFocus(snapshot, { document: doc = globalThis.document, foodId = null, fallbackId = 'my-meal' } = {}) {
  try {
    if (!doc) return false;
    const valid = validSnapshot(snapshot);
    const newFood = boundedText(foodId) ? foodId : null;
    if (!valid && !newFood) return false;
    const dialog = dialogFor(doc);
    if (isOpen(dialog)) return false;
    // Anonymous controls inside a now-closed dialog are not background openers.
    if (valid && snapshot.inDialog && !snapshot.id && !newFood) return false;
    const candidates = [];
    if (newFood) {
      candidates.push(...matching(doc, 'swap', newFood));
      candidates.push(...matching(doc, 'qty', newFood, { step: snapshot?.data?.key === 'qty' ? snapshot.data.step : '1' }));
      candidates.push(...matching(doc, 'qty', newFood));
      candidates.push(...matching(doc, 'lock', newFood));
    }
    if (valid) {
      if (snapshot.id) candidates.push(doc.getElementById?.(snapshot.id));
      if (snapshot.data) candidates.push(...matching(doc, snapshot.data.key, snapshot.data.value, snapshot.data));
    }
    for (const element of candidates) {
      if (!usable(element, dialog)) continue;
      element.focus({ preventScroll: true });
      return true;
    }
    const fallback = boundedText(fallbackId) ? doc.getElementById?.(fallbackId) : null;
    if (!usable(fallback, dialog)) return false;
    fallback.setAttribute?.('tabindex', '-1');
    fallback.focus({ preventScroll: true });
    return true;
  } catch { return false; }
}
