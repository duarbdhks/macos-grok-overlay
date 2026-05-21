// Cmd+F Find-in-Page for macos-grok-overlay
// Injected as a separate user script (find_shim.js).
// Provides a compact, pretty floating find bar with good animations.
// Designed to work alongside the existing vimium_shim.js.

(function () {
  'use strict';
  if (window.__grok_find_installed__) return;
  window.__grok_find_installed__ = true;

  // ==================== Configuration ====================
  const HIGHLIGHT_CLASS = 'grok-find-highlight';
  const CURRENT_CLASS = 'grok-find-current';
  const BAR_ID = 'grok-find-bar';

  // ==================== State ====================
  let bar = null;
  let input = null;
  let counter = null;
  let prevBtn = null;
  let nextBtn = null;
  let closeBtn = null;

  let matches = [];           // Array of { range, wrapper }
  let currentIndex = -1;
  let currentQuery = '';
  let isActive = false;

  let conversationContainer = null;
  let vimiumDisabled = false;

  // Remember last query briefly for re-open convenience
  let lastQuery = '';

  // Explicit coordination flag for vimium_shim (required for clean "keys disabled while active")
  window.__grokFindActive = false;

  // ==================== Utility: Theme-aware colors ====================
  function getThemeColors() {
    // Robust theme detection (handles rgb, rgba, hsl, oklch, etc. used by modern React UIs)
    const bg = getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
    let r = 255, g = 255, b = 255;

    const rgbMatch = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) {
      r = parseInt(rgbMatch[1], 10);
      g = parseInt(rgbMatch[2], 10);
      b = parseInt(rgbMatch[3], 10);
    } else {
      // Fallback: rough luminance for other formats
      const lum = (parseFloat(bg) || 255) / 255;
      r = g = b = Math.round(lum * 255);
    }

    const isDark = (r * 0.299 + g * 0.587 + b * 0.114) < 140;

    return {
      barBg: isDark ? 'rgba(32, 33, 36, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      barBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
      text: isDark ? '#e8eaed' : '#202124',
      accent: isDark ? '#8ab4f8' : '#1a73e8',
      // High-contrast highlight (matches native browser Find on dark bg).
      // Solid yellow/orange + forced dark text → readable on any theme.
      highlightBg: isDark ? '#f7e36b' : '#fff066',
      currentBg:   isDark ? '#ff9a3c' : '#ffb347',
      highlightFg: '#1a1a1a',
      currentOutline: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.55)',
    };
  }

  // ==================== Find Conversation Container (heuristic) ====================
  function findConversationContainer() {
    // Multi-stage heuristic tuned for grok.com (handles dynamic re-renders well)
    const strongSelectors = [
      '[role="log"]',
      '[data-testid*="conversation"]',
      '[data-testid*="chat-history"]',
      'div[aria-label*="Messages"]',
    ];

    for (const sel of strongSelectors) {
      const el = document.querySelector(sel);
      if (el && el.isConnected && el.scrollHeight > 380) return el;
    }

    // Structural search for the main message scroll area
    const candidates = Array.from(document.querySelectorAll('main div, div[style*="overflow"]'));
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      const h = el.scrollHeight;
      if (h < 400 || !el.isConnected) continue;

      const style = getComputedStyle(el);
      const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll' || h > el.clientHeight + 140;
      if (!scrollable) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 280 || rect.height < 280) continue;

      const childCount = el.children.length;
      // Chat-density signal: strongly prefer the actual message list
      const chatDensity = el.querySelectorAll('article,[role="article"],[data-message],[class*="message" i],[class*="Message" i]').length;
      const score = (h * 0.44) + (childCount * 19) + (chatDensity * 9) + (rect.height * 0.26);

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best && best.isConnected && best.scrollHeight > 420) return best;

    // Final fallback
    const main = document.querySelector('main');
    return (main && main.isConnected && main.scrollHeight > 300) ? main : document.body;
  }

  function validateConversationContainer() {
    if (conversationContainer &&
        conversationContainer.isConnected &&
        conversationContainer.scrollHeight > 380) {
      return true;
    }
    conversationContainer = findConversationContainer();
    return !!(conversationContainer && conversationContainer.isConnected);
  }

  // ==================== Highlight Management ====================
  function clearHighlights() {
    const root = (conversationContainer && conversationContainer.isConnected)
      ? conversationContainer
      : document.body;

    const existing = root.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    const parents = new Set();

    existing.forEach(el => {
      const parent = el.parentNode;
      if (!parent) return;
      try {
        parent.replaceChild(document.createTextNode(el.textContent || ''), el);
        parents.add(parent);
      } catch (_) {
        // per-element safety; continue
      }
    });

    // Merge adjacent text nodes — prevents fragment accumulation across re-searches
    parents.forEach(p => { try { p.normalize(); } catch (_) {} });

    matches = [];
    currentIndex = -1;
  }

  function createHighlight(range, isCurrent) {
    const colors = getThemeColors();
    const wrapper = document.createElement('span');
    wrapper.className = HIGHLIGHT_CLASS + (isCurrent ? ' ' + CURRENT_CLASS : '');
    // Layout-neutral highlight: background only. No padding/border/margin → zero reflow.
    wrapper.style.backgroundColor = isCurrent ? colors.currentBg : colors.highlightBg;
    // Solid bg → force dark text so it's readable regardless of original color.
    wrapper.style.color = colors.highlightFg;
    wrapper.style.borderRadius = '2px';
    wrapper.style.padding = '0';
    wrapper.style.margin = '0';
    wrapper.style.boxShadow = 'none';
    wrapper.style.transition = 'background-color 0.12s cubic-bezier(0.2, 0, 0, 1), outline-color 0.12s ease';
    // outline lives outside the box → never shifts inline neighbors.
    if (isCurrent) {
      wrapper.style.outline = '1px solid ' + colors.currentOutline;
      wrapper.style.outlineOffset = '0';
    } else {
      wrapper.style.outline = 'none';
    }

    try {
      range.surroundContents(wrapper);
    } catch (e) {
      // Range may be invalid (e.g. across block boundaries)
      return null;
    }
    return wrapper;
  }

  function performSearch(query) {
    clearHighlights();
    if (!query || query.length < 1) {
      updateCounter();
      return;
    }

    const container = conversationContainer || document.body;
    const lowerQuery = query.toLowerCase();
    const qLen = query.length;

    // Phase 1 — collect (node, startIndex) hits without mutating the DOM.
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const val = node.nodeValue;
          if (!val || val.trim().length === 0) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (parent.closest(`.${HIGHLIGHT_CLASS}`)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // Preserve document order via parallel arrays.
    const orderedNodes = [];
    const startsByNode = new Map(); // node -> [startIdx, ...] in ascending order

    let node;
    while ((node = walker.nextNode())) {
      const lowerText = node.nodeValue.toLowerCase();
      let idx = 0;
      let arr = null;
      while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
        if (!arr) {
          arr = [];
          startsByNode.set(node, arr);
          orderedNodes.push(node);
        }
        arr.push(idx);
        idx += qLen;
      }
    }

    // Phase 2 — wrap. Per node, surround in REVERSE so earlier offsets stay valid.
    // Then re-order wrappers into document order for the global matches array.
    const newMatches = [];
    for (const n of orderedNodes) {
      const starts = startsByNode.get(n);
      const perNode = [];
      for (let i = starts.length - 1; i >= 0; i--) {
        try {
          const range = document.createRange();
          range.setStart(n, starts[i]);
          range.setEnd(n, starts[i] + qLen);
          const wrapper = createHighlight(range, false);
          if (wrapper) perNode.push(wrapper);
        } catch (e) {
          // skip cross-boundary or invalid ranges
        }
      }
      // perNode is reverse-document-order; flip back.
      for (let i = perNode.length - 1; i >= 0; i--) {
        newMatches.push({ wrapper: perNode[i] });
      }
    }

    matches = newMatches;

    // Safety cap for very long conversations
    if (matches.length > 500) {
      matches = matches.slice(0, 500);
    }

    currentIndex = matches.length > 0 ? 0 : -1;

    if (currentIndex >= 0) {
      setCurrentMatch(currentIndex, true);
    }
    updateCounter();
  }

  function setCurrentMatch(index, scroll = true) {
    if (index < 0 || index >= matches.length) return;

    const current = matches[index];
    if (!current || !current.wrapper || !current.wrapper.isConnected) {
      // Wrapper destroyed by React re-render or lives in unmounted virtual row.
      // Nudge the container to wake the virtualizer, then re-scan.
      const c = conversationContainer;
      if (c && c.isConnected) {
        const dir = (index > currentIndex) ? 650 : -650;
        try { c.scrollBy({ top: dir, behavior: 'smooth' }); } catch (_) {}
      }
      setTimeout(() => {
        if (currentQuery) performSearch(currentQuery);
      }, 160);
      currentIndex = index;
      updateCounter();
      return;
    }

    const colors = getThemeColors();

    // Clear previous current state
    matches.forEach((m) => {
      if (m.wrapper) {
        m.wrapper.classList.remove(CURRENT_CLASS);
        m.wrapper.style.backgroundColor = colors.highlightBg;
        m.wrapper.style.outline = 'none';
      }
    });

    current.wrapper.classList.add(CURRENT_CLASS);
    current.wrapper.style.backgroundColor = colors.currentBg;
    current.wrapper.style.color = colors.highlightFg;
    // Use outline (out-of-flow) instead of padding/box-shadow → no inline reflow.
    current.wrapper.style.transition = 'background-color 0.1s ease, outline-color 0.1s ease';
    current.wrapper.style.outline = '2px solid ' + colors.currentOutline;
    current.wrapper.style.outlineOffset = '0';

    setTimeout(() => {
      if (current.wrapper) {
        current.wrapper.style.outline = '1px solid ' + colors.currentOutline;
      }
    }, 280);

    if (scroll) {
      current.wrapper.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }

    currentIndex = index;
    updateCounter();
  }

  function updateCounter() {
    if (!counter) return;
    if (!currentQuery) {
      counter.textContent = '';
      counter.style.opacity = '0.5';
    } else if (matches.length === 0) {
      counter.textContent = '0/0';
      counter.style.opacity = '0.6';
      counter.style.color = '#ff6b6b';
    } else {
      counter.textContent = `${currentIndex + 1}/${matches.length}`;
      counter.style.opacity = '0.75';
      counter.style.color = '';
    }
  }

  // ==================== Floating Bar UI ====================
  function createBar() {
    if (bar) return;

    const colors = getThemeColors();

    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = `
      position: fixed;
      top: 10px;
      right: 14px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px 6px 5px 10px;
      background: ${colors.barBg};
      border: 1px solid ${colors.barBorder};
      border-radius: 10px;
      box-shadow: 0 6px 16px rgba(0,0,0,0.18), 0 2px 4px rgba(0,0,0,0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: ${colors.text};
      backdrop-filter: blur(16px);
      opacity: 0;
      transform: translateY(-10px) scale(0.96);
      transition: opacity 0.16s cubic-bezier(0.2, 0, 0, 1),
                  transform 0.16s cubic-bezier(0.2, 0, 0, 1);
      user-select: none;
    `;

    // Input
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Find in conversation';
    input.style.cssText = `
      width: 210px;
      background: transparent;
      border: none;
      outline: none;
      color: ${colors.text};
      font-size: 13.5px;
      padding: 3px 4px;
      font-weight: 400;
    `;

    // Counter
    counter = document.createElement('div');
    counter.style.cssText = `
      min-width: 42px;
      text-align: center;
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    `;

    // Buttons
    const makeBtn = (label, title) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.style.cssText = `
        background: transparent;
        border: none;
        color: ${colors.text};
        opacity: 0.7;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 13px;
        line-height: 1;
      `;
      btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
      btn.addEventListener('mouseleave', () => btn.style.opacity = '0.7');
      return btn;
    };

    prevBtn = makeBtn('↑', 'Previous match (Shift+Enter)');
    nextBtn = makeBtn('↓', 'Next match (Enter)');
    closeBtn = makeBtn('✕', 'Close (Esc)');

    bar.appendChild(input);
    bar.appendChild(counter);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(closeBtn);

    document.body.appendChild(bar);

    // Event listeners
    let searchDebounce = null;
    input.addEventListener('input', () => {
      currentQuery = input.value;

      if (searchDebounce) clearTimeout(searchDebounce);

      // Light debounce for very rapid typing (keeps things smooth)
      if (currentQuery.length > 2) {
        searchDebounce = setTimeout(() => performSearch(currentQuery), 28);
      } else {
        performSearch(currentQuery);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          goToPrev();
        } else {
          goToNext();
        }
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        if (input.value) {
          // First Esc clears the query (common good UX)
          input.value = '';
          currentQuery = '';
          performSearch('');
        } else {
          close();
        }
      }
    });

    prevBtn.addEventListener('click', goToPrev);
    nextBtn.addEventListener('click', goToNext);
    closeBtn.addEventListener('click', close);

    // Show with animation
    requestAnimationFrame(() => {
      bar.style.opacity = '1';
      bar.style.transform = 'translateY(0)';
    });
  }

  function destroyBar() {
    if (bar && bar.parentNode) {
      bar.parentNode.removeChild(bar);
    }
    bar = input = counter = prevBtn = nextBtn = closeBtn = null;
  }

  // ==================== Navigation ====================
  function goToNext() {
    if (matches.length === 0) return;
    let next = currentIndex + 1;
    if (next >= matches.length) next = 0;
    setCurrentMatch(next);
  }

  function goToPrev() {
    if (matches.length === 0) return;
    let prev = currentIndex - 1;
    if (prev < 0) prev = matches.length - 1;
    setCurrentMatch(prev);
  }

  // ==================== Public API ====================
  function open() {
    if (isActive) {
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }

    isActive = true;

    // Re-detect / validate container (critical for React churn)
    validateConversationContainer();

    createBar();

    // Restore previous query if user re-opens quickly (nice UX)
    if (lastQuery && input) {
      input.value = lastQuery;
      currentQuery = lastQuery;
      performSearch(lastQuery);
    }

    // Explicit coordination with vimium_shim (required)
    window.__grokFindActive = true;

    // Focus input
    requestAnimationFrame(() => {
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  function close() {
    if (!isActive) return;

    isActive = false;
    const queryToRemember = currentQuery;   // capture BEFORE clearing
    currentQuery = '';

    // Nice exit animation
    if (bar) {
      bar.style.transition = 'opacity 0.12s ease, transform 0.12s ease';
      bar.style.opacity = '0';
      bar.style.transform = 'translateY(-6px) scale(0.98)';
    }

    setTimeout(() => {
      if (queryToRemember) lastQuery = queryToRemember;

      clearHighlights();
      destroyBar();
    }, 110);

    window.__grokFindActive = false;

    // Restore focus to chat input
    setTimeout(() => {
      const ta = document.querySelector('textarea');
      if (ta) ta.focus();
    }, 120);
  }

  // ==================== Global Exposure ====================
  window.__grokFind = {
    open,
    close,
    next: goToNext,
    prev: goToPrev,
  };

  // Optional: allow native to force close via evaluateJavaScript if needed
})();