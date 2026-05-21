// Vimium-like keybindings injected into grok.com via WKUserScript.
// Provides scroll/navigation keys and `f` link hints.
// Auto-disables when an editable element holds focus.
(function () {
  'use strict';
  if (window.__grok_vim_installed__) return;
  window.__grok_vim_installed__ = true;

  const SCROLL_STEP = 60;
  const halfPage = () => Math.max(100, window.innerHeight / 2);
  const HINT_CHARS = 'asdfghjkl';

  // Korean Dubeolsik (2-set) jamo → Latin base key, for IME/layout independence.
  // Covers HINT_CHARS + navigation keys (g/j/k/h/l/d/u) + G/H/L via shiftKey.
  const KOREAN_TO_LATIN = {
    'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g',
    'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
    'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅔ': 'p',
    'ㅂ': 'q', 'ㅈ': 'w', 'ㄷ': 'e', 'ㄱ': 'r', 'ㅅ': 't', 'ㅛ': 'y',
    'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b', 'ㅜ': 'n', 'ㅡ': 'm'
  };

  function getBaseKey(e) {
    // Prefer e.code (physical, e.g. "KeyF") — fully IME/layout-proof.
    if (e.code && e.code.startsWith('Key')) {
      const letter = e.code.slice(3).toLowerCase();
      if (/^[a-z]$/.test(letter)) {
        return e.shiftKey ? letter.toUpperCase() : letter;
      }
      return letter;
    }
    // Fallback: map produced char (Korean jamo) then respect shiftKey for G/H/L etc.
    let k = (e.key || '').toLowerCase();
    const mapped = KOREAN_TO_LATIN[k] || k;
    if (e.shiftKey && /^[a-z]$/.test(mapped)) {
      return mapped.toUpperCase();
    }
    return mapped;
  }

  let lastG = 0;
  let hintMode = false;
  let hintMap = null;
  let hintBuffer = '';

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // --- Scroll/navigation ---
  const handlers = {
    j: () => window.scrollBy({ top: SCROLL_STEP, behavior: 'auto' }),
    k: () => window.scrollBy({ top: -SCROLL_STEP, behavior: 'auto' }),
    h: () => window.scrollBy({ left: -SCROLL_STEP, behavior: 'auto' }),
    l: () => window.scrollBy({ left: SCROLL_STEP, behavior: 'auto' }),
    d: () => window.scrollBy({ top: halfPage(), behavior: 'auto' }),
    u: () => window.scrollBy({ top: -halfPage(), behavior: 'auto' }),
    G: () => window.scrollTo(0, document.documentElement.scrollHeight),
    H: () => history.back(),
    L: () => history.forward(),
  };

  // --- Link hints ---
  function genLabels(n) {
    const chars = HINT_CHARS;
    const labels = [];
    // Single char first
    if (n <= chars.length) {
      for (let i = 0; i < n; i++) labels.push(chars[i]);
      return labels;
    }
    // Reserve some single-char prefixes for two-char labels
    const need = n;
    const single = Math.max(0, chars.length - Math.ceil((need - chars.length) / chars.length));
    for (let i = 0; i < single; i++) labels.push(chars[i]);
    outer: for (let i = single; i < chars.length; i++) {
      for (let j = 0; j < chars.length; j++) {
        labels.push(chars[i] + chars[j]);
        if (labels.length >= need) break outer;
      }
    }
    return labels;
  }

  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    if (r.right < 0 || r.left > window.innerWidth) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  function clickableSelector() {
    return [
      'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
      'summary', 'label[for]',
      '[onclick]', '[tabindex]:not([tabindex="-1"])',
      '[role="button"]', '[role="link"]',
      '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      '[role="combobox"]', '[role="listbox"]', '[role="option"]',
      '[role="tab"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="treeitem"]',
      '[contenteditable="true"]'
    ].join(',');
  }

  function visibleClickables() {
    const all = document.querySelectorAll(clickableSelector());
    const out = [];
    for (const el of all) {
      if (el.disabled) continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    return out;
  }

  function showHints() {
    clearHints();
    const els = visibleClickables();
    if (els.length === 0) return;
    const labels = genLabels(els.length);
    hintMap = new Map();
    const layer = document.createElement('div');
    layer.id = '__grok_vim_hints__';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      const tag = document.createElement('div');
      tag.textContent = labels[i].toUpperCase();
      tag.style.cssText =
        'position:fixed;background:#ffeb3b;color:#000;border:1px solid #b8860b;' +
        'padding:1px 3px;font:bold 11px/1 monospace;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.4);';
      tag.style.left = Math.max(0, r.left - 2) + 'px';
      tag.style.top = Math.max(0, r.top - 2) + 'px';
      layer.appendChild(tag);
      hintMap.set(labels[i], { el, tag });
    }
    document.body.appendChild(layer);
    hintMode = true;
    hintBuffer = '';
  }

  function clearHints() {
    const layer = document.getElementById('__grok_vim_hints__');
    if (layer) layer.remove();
    hintMode = false;
    hintMap = null;
    hintBuffer = '';
  }

  function activateHint(item) {
    const el = item.el;
    clearHints();
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch (e) {}
    // Use synthesized click for broader compatibility
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    const pOpts = Object.assign({}, opts, {
      pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1
    });
    const fireMouse = (type) => el.dispatchEvent(new MouseEvent(type, opts));
    const firePointer = (type) => {
      try { el.dispatchEvent(new PointerEvent(type, pOpts)); }
      catch (e) { /* PointerEvent unsupported — skip */ }
    };
    firePointer('pointerover');
    firePointer('pointerenter');
    fireMouse('mouseover');
    fireMouse('mouseenter');
    firePointer('pointerdown');
    fireMouse('mousedown');
    firePointer('pointerup');
    fireMouse('mouseup');
    fireMouse('click');
  }

  function handleHintKey(e) {
    if (e.key === 'Escape') { clearHints(); return; }
    if (e.key === 'Backspace') {
      hintBuffer = hintBuffer.slice(0, -1);
      updateHintFilter();
      return;
    }
    const base = getBaseKey(e);
    const ch = base.length === 1 ? base.toLowerCase() : '';
    if (!ch || !HINT_CHARS.includes(ch)) return;
    hintBuffer += ch;
    if (hintMap.has(hintBuffer)) {
      activateHint(hintMap.get(hintBuffer));
      return;
    }
    updateHintFilter();
  }

  function updateHintFilter() {
    if (!hintMap) return;
    let matches = 0;
    for (const [label, item] of hintMap) {
      const ok = label.startsWith(hintBuffer);
      item.tag.style.opacity = ok ? '1' : '0.25';
      if (ok) matches++;
    }
    if (matches === 0) clearHints();
  }

  document.addEventListener('keydown', function (e) {
    // Explicit coordination with find_shim: when Cmd+F find bar is active,
    // let the find bar own all non-modifier keys (Esc, arrows, letters for search).
    if (window.__grokFindActive) {
      return;
    }

    // Never interfere with modifier combos (let app shortcuts pass)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (hintMode) clearHints();
      // Cmd+W / Cmd+ㅈ → native hideWindow (e.code is IME/layout-proof)
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.code === 'KeyW') {
        try {
          window.webkit?.messageHandlers?.hideHandler?.postMessage('hide');
        } catch (err) {}
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (hintMode) {
      e.preventDefault();
      e.stopPropagation();
      handleHintKey(e);
      return;
    }

    if (isEditable(document.activeElement)) {
      if (e.key === 'Escape' && document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      return;
    }

    const key = e.key;
    const base = getBaseKey(e);

    if (base === 'g') {
      const now = Date.now();
      if (now - lastG < 500) {
        window.scrollTo(0, 0);
        lastG = 0;
      } else {
        lastG = now;
      }
      e.preventDefault();
      return;
    }

    if (base === 'f') {
      e.preventDefault();
      showHints();
      return;
    }

    if (key === 'Escape') {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return;
    }

    const fn = handlers[base];
    if (fn) {
      fn();
      e.preventDefault();
    }
  }, true);

  // Clear hints if user clicks or scrolls manually
  window.addEventListener('mousedown', () => { if (hintMode) clearHints(); }, true);
  window.addEventListener('scroll', () => { if (hintMode) clearHints(); }, true);
})();
