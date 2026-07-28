(function initMenuOrder(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MenuOrder = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMenuOrder() {
  'use strict';

  function normalizeMenuOrder(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function getMenuItemStableKey(item) {
    if (!item || typeof item !== 'object') return '';

    const key = item._filename
      || item.filename
      || item.slug
      || item.nome
      || item.name
      || item.id
      || '';

    return String(key);
  }

  /**
   * Ordinamento canonico condiviso da build, CMS e frontend.
   *
   * Il confronto lessicografico con < e > e' intenzionale: non dipende dalla
   * locale del runtime, al contrario di localeCompare. I filename del menu sono
   * slug ASCII, quindi il risultato coincide in Node, Workers e browser.
   */
  function compareMenuItems(a, b) {
    const orderA = normalizeMenuOrder(a && a.order);
    const orderB = normalizeMenuOrder(b && b.order);

    if (orderA < orderB) return -1;
    if (orderA > orderB) return 1;

    const keyA = getMenuItemStableKey(a);
    const keyB = getMenuItemStableKey(b);

    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  }

  return {
    compareMenuItems,
    getMenuItemStableKey,
    normalizeMenuOrder
  };
}));
