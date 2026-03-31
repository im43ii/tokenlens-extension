(function () {
  'use strict';

  function detectSite() {
    const host = window.location.hostname;
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) {
      return { provider: 'openai', editor: 'chatgpt', model: detectChatGPTModel() };
    }
    if (host.includes('v0.dev') || host.includes('v0.app')) {
      return { provider: 'openai', editor: 'v0', model: 'gpt-4o' };
    }
    if (host.includes('gemini.google.com')) {
      return { provider: 'gemini', editor: 'other', model: 'gemini-2.0-flash' };
    }
    if (host.includes('claude.ai')) {
      return { provider: 'anthropic', editor: 'claude_desktop', model: detectClaudeModel() };
    }
    return { provider: 'openai', editor: 'other', model: 'gpt-4o' };
  }

  function detectChatGPTModel() {
    const btn = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    if (btn) {
      const t = btn.textContent.trim().toLowerCase();
      if (t.includes('o3'))   return 'o3';
      if (t.includes('o1'))   return 'o1';
      if (t.includes('4o'))   return 'gpt-4o';
      if (t.includes('4'))    return 'gpt-4';
      if (t.includes('3.5'))  return 'gpt-3.5-turbo';
    }
    return 'gpt-4o';
  }

  function detectClaudeModel() {
    const txt = document.title + ' ' +
      (document.querySelector('[data-testid="model-selector-dropdown"]')?.textContent ?? '');
    const low = txt.toLowerCase();
    if (low.includes('opus'))   return 'claude-opus-4-6';
    if (low.includes('haiku'))  return 'claude-haiku-4-5-20251001';
    return 'claude-sonnet-4-5';
  }

  function getText(el) {
    return el?.textContent?.trim() ?? '';
  }

  function logV0(label, els) {
    console.log(
      `[TokenLens v0] ${label} → ${els.length} element(s)`,
      els.slice(0, 3).map(el => ({
        tag: el.tagName,
        cls: (el.className || '').slice(0, 80),
        txt: (el.textContent || '').slice(0, 60).trim(),
      }))
    );
  }

  // Find the leftmost scrollable panel — the chat side of v0's split view.
  function findLeftScrollPanel() {
    const midX = window.innerWidth / 2;
    const panels = Array.from(document.querySelectorAll('*')).filter(el => {
      const s = window.getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') return false;
      const r = el.getBoundingClientRect();
      return r.left < midX && r.width > 80 && r.height > 150;
    });
    console.log(`[TokenLens v0] S3: ${panels.length} scroll panel(s) in left half`);
    panels.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      console.log(`  panel[${i}] <${el.tagName}> cls="${(el.className||'').slice(0,60)}" x=${Math.round(r.left)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
    });
    // Pick the tallest one (most likely the chat thread)
    return panels.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] ?? null;
  }

  // Walk a container's descendants, deduplicate by text, classify role.
  function messagesFromContainer(root) {
    const seen = new Set();
    const msgs = [];
    // querySelectorAll in DOM order — direct children first
    const els = Array.from(root.querySelectorAll('p, div, span, li, article'))
      .filter(el => {
        const t = (el.textContent || '').trim();
        return t.length > 10 && t.length < 8000 && el.children.length < 6;
      });
    for (const el of els) {
      const content = (el.textContent || '').trim();
      if (seen.has(content)) continue;
      seen.add(content);
      const cls = (el.className || '').toLowerCase();
      const bg  = window.getComputedStyle(el).backgroundColor;
      // Blue-ish computed bg = user bubble (rgb values for indigo/blue family)
      const isBlue = /rgb\(\s*(5[0-9]|6[0-9]|7[0-9]|8[0-9]|9[0-9])\s*,\s*(6[0-9]|7[0-9]|8[0-9]|9[0-9]|10[0-9])\s*,\s*(2[0-9][0-9])\s*\)/.test(bg);
      const isUser = isBlue || cls.includes('user') || cls.includes('human') ||
                     (el.closest('[class*="flex-row-reverse"]') !== null);
      msgs.push({ role: isUser ? 'user' : 'assistant', content });
    }
    return msgs;
  }

  // Full DOM text dump grouped by parent — shown when nothing matches.
  function dumpDomForDebugging() {
    console.warn('[TokenLens v0] ══ DOM DUMP (nothing matched) ══');
    // Gather leaf-ish text nodes
    const leaves = Array.from(document.querySelectorAll('p, span, div, li'))
      .filter(el => {
        const t = (el.textContent || '').trim();
        return t.length > 10 && t.length < 600 && el.children.length < 3;
      });
    // Group by immediate parent
    const groups = new Map();
    for (const el of leaves) {
      const p = el.parentElement;
      if (!p) continue;
      const key = `${p.tagName}|${(p.className || '').slice(0, 60)}|${p.id || ''}`;
      if (!groups.has(key)) groups.set(key, { el: p, kids: [] });
      groups.get(key).kids.push(el);
    }
    // Print largest groups first
    [...groups.values()]
      .sort((a, b) => b.kids.length - a.kids.length)
      .slice(0, 8)
      .forEach((g, gi) => {
        const r = g.el.getBoundingClientRect();
        console.log(`\nGroup[${gi}] <${g.el.tagName}> cls="${(g.el.className||'').slice(0,80)}" id="${g.el.id||'-'}" x=${Math.round(r.left)} (${g.kids.length} items)`);
        g.kids.slice(0, 4).forEach((k, ki) => {
          console.log(`  [${ki}] <${k.tagName}> cls="${(k.className||'').slice(0,60)}" → "${(k.textContent||'').slice(0,60).trim()}"`);
        });
      });
    console.warn('[TokenLens v0] ══ END DUMP ══ Report the group whose items are your chat messages.');
  }

  function extractV0Messages() {
    // ── S0: [data-testid*="message"] ─────────────────────────────────────────
    const s0 = Array.from(document.querySelectorAll('[data-testid*="message"]'));
    logV0('S0:[data-testid*=message]', s0);
    if (s0.length >= 1) {
      const msgs = s0.map(el => {
        const tid  = (el.getAttribute('data-testid') || '').toLowerCase();
        const role = tid.includes('user') ? 'user' : 'assistant';
        return { role, content: getText(el) };
      }).filter(m => m.content.length > 5);
      if (msgs.length) { console.log(`[TokenLens v0] S0 matched ${msgs.length}`); return msgs; }
    }

    // ── S1: .chat-message / .message-bubble (and partial class matches) ───────
    const s1 = Array.from(document.querySelectorAll(
      '.chat-message, .message-bubble, [class*="chat-message"], [class*="message-bubble"]'
    ));
    logV0('S1:.chat-message/.message-bubble', s1);
    if (s1.length >= 1) {
      const msgs = s1.map(el => {
        const cls  = (el.className || '').toLowerCase();
        const role = cls.includes('user') || cls.includes('human') ? 'user' : 'assistant';
        return { role, content: getText(el) };
      }).filter(m => m.content.length > 0);
      if (msgs.length) { console.log(`[TokenLens v0] S1 matched ${msgs.length}`); return msgs; }
    }

    // ── S2: data-role / data-message-role / data-author-role attributes ───────
    const s2 = Array.from(document.querySelectorAll(
      '[data-role],[data-message-role],[data-author-role]'
    ));
    logV0('S2:data-role attrs', s2);
    if (s2.length >= 2) {
      const msgs = s2.map(el => ({
        role:    el.getAttribute('data-role') ||
                 el.getAttribute('data-message-role') ||
                 el.getAttribute('data-author-role') || 'assistant',
        content: getText(el),
      })).filter(m => m.content.length > 0);
      if (msgs.length) { console.log(`[TokenLens v0] S2 matched ${msgs.length}`); return msgs; }
    }

    // ── S3: left scroll panel → walk all text descendants ────────────────────
    // v0 is a split view; chat is the leftmost scrollable panel.
    const leftPanel = findLeftScrollPanel();
    if (leftPanel) {
      const msgs = messagesFromContainer(leftPanel);
      logV0('S3:left-panel items', msgs.map(m => ({ textContent: m.content, className: m.role })));
      if (msgs.length >= 2) { console.log(`[TokenLens v0] S3 matched ${msgs.length}`); return msgs; }
    }

    // ── S4: flex-row-reverse = user bubble, adjacent sibling = assistant ──────
    const userWrappers = Array.from(document.querySelectorAll('div')).filter(
      el => (el.className || '').includes('flex-row-reverse')
    );
    logV0('S4:flex-row-reverse (user wrappers)', userWrappers);
    if (userWrappers.length > 0) {
      const msgs = [];
      for (const uw of userWrappers) {
        const uTxt = getText(uw);
        if (uTxt) msgs.push({ role: 'user', content: uTxt });
        let sib = uw.nextElementSibling;
        while (sib) {
          if ((sib.className || '').includes('flex-row-reverse')) break;
          const aTxt = getText(sib);
          if (aTxt.length > 10) { msgs.push({ role: 'assistant', content: aTxt }); break; }
          sib = sib.nextElementSibling;
        }
      }
      if (msgs.length >= 2) { console.log(`[TokenLens v0] S4 matched ${msgs.length}`); return msgs; }
    }

    // ── S5: .prose = assistant markdown; walk back for user sibling ───────────
    const proseEls = Array.from(document.querySelectorAll(
      '.prose, [class*="prose"]'
    )).filter(el => getText(el).length > 20);
    logV0('S5:.prose (assistant)', proseEls);
    if (proseEls.length > 0) {
      const msgs = [];
      for (const prose of proseEls) {
        const parent = prose.closest('[class*="message"],[class*="turn"],[class*="chat"],li,article')
                     ?? prose.parentElement;
        let prev = parent?.previousElementSibling;
        for (let i = 0; i < 3 && prev; i++) {
          const t = getText(prev);
          if (t.length > 3 && !prev.querySelector('.prose,[class*="prose"]')) {
            if (!msgs.length || msgs[msgs.length - 1].role !== 'user')
              msgs.push({ role: 'user', content: t });
            break;
          }
          prev = prev.previousElementSibling;
        }
        msgs.push({ role: 'assistant', content: getText(prose) });
      }
      if (msgs.length) { console.log(`[TokenLens v0] S5 matched ${msgs.length}`); return msgs; }
    }

    // ── S6: class-name keyword pairs ──────────────────────────────────────────
    for (const [u, b] of [
      ['[class*="UserMessage"]',  '[class*="AssistantMessage"]'],
      ['[class*="user-message"]', '[class*="assistant-message"]'],
      ['[class*="HumanMessage"]', '[class*="AIMessage"]'],
      ['[class*="user_message"]', '[class*="bot_message"]'],
    ]) {
      const users = Array.from(document.querySelectorAll(u));
      const bots  = Array.from(document.querySelectorAll(b));
      if (!users.length && !bots.length) continue;
      logV0(`S6:${u}`, users);
      const msgs = [];
      for (let i = 0; i < Math.max(users.length, bots.length); i++) {
        if (users[i]) msgs.push({ role: 'user',      content: getText(users[i]) });
        if (bots[i])  msgs.push({ role: 'assistant', content: getText(bots[i])  });
      }
      const f = msgs.filter(m => m.content.length > 0);
      if (f.length) { console.log(`[TokenLens v0] S6 (${u}) matched ${f.length}`); return f; }
    }

    // ── Nothing matched — dump grouped DOM for debugging ──────────────────────
    dumpDomForDebugging();
    return [];
  }

  function extractMessages() {
    const host = window.location.hostname;

    // ── ChatGPT ──────────────────────────────────────────────────────────────
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) {
      return Array.from(document.querySelectorAll('[data-message-author-role]'))
        .map(el => ({
          role: el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant',
          content: getText(el),
        }))
        .filter(m => m.content.length > 0);
    }

    // ── Claude.ai ────────────────────────────────────────────────────────────
    if (host.includes('claude.ai')) {
      return Array.from(
        document.querySelectorAll('[data-testid="user-message"], .font-claude-message')
      )
        .map(el => ({
          role: el.matches('[data-testid="user-message"]') ? 'user' : 'assistant',
          content: getText(el),
        }))
        .filter(m => m.content.length > 0);
    }

    // ── Gemini ───────────────────────────────────────────────────────────────
    if (host.includes('gemini.google.com')) {
      const users = Array.from(document.querySelectorAll('.user-query-text'));
      const bots  = Array.from(document.querySelectorAll('.model-response-text'));
      const msgs  = [];
      const max   = Math.max(users.length, bots.length);
      for (let i = 0; i < max; i++) {
        if (users[i]) msgs.push({ role: 'user',      content: getText(users[i]) });
        if (bots[i])  msgs.push({ role: 'assistant', content: getText(bots[i])  });
      }
      return msgs.filter(m => m.content.length > 0);
    }

    // ── v0.dev / v0.app ──────────────────────────────────────────────────────
    if (host.includes('v0.dev') || host.includes('v0.app')) {
      return extractV0Messages();
    }

    return [];
  }

  // ── Chat input selectors per site ────────────────────────────────────────────
  function getChatInput() {
    const host = window.location.hostname;
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) {
      return document.querySelector('#prompt-textarea');
    }
    if (host.includes('claude.ai')) {
      return document.querySelector('[contenteditable="true"]');
    }
    if (host.includes('gemini.google.com')) {
      return document.querySelector('.ql-editor') || document.querySelector('[contenteditable="true"]');
    }
    if (host.includes('v0.dev') || host.includes('v0.app')) {
      return document.querySelector('textarea');
    }
    // Generic fallback
    return document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
  }

  function setInputText(el, text) {
    if (!el) return false;
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    } else {
      el.focus();
      // Use native value setter so React's synthetic event fires correctly
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // ── Extract conversation messages ─────────────────────────────────────────
    if (message.type === 'EXTRACT_MESSAGES') {
      const site     = detectSite();
      const messages = extractMessages();
      sendResponse({ messages, ...site, messageCount: messages.length });
      return true;
    }

    // ── Read current chat input text (for auto-suggest) ───────────────────────
    if (message.type === 'GET_INPUT_TEXT') {
      const el = getChatInput();
      const text = el
        ? (el.isContentEditable ? el.textContent : el.value) ?? ''
        : '';
      sendResponse({ text: text.trim() });
      return true;
    }

    // ── Inject improved prompt into chat input ────────────────────────────────
    if (message.type === 'INJECT_PROMPT') {
      const el = getChatInput();
      if (!el) {
        sendResponse({ ok: false, error: 'Chat input not found on this page.' });
        return true;
      }
      const ok = setInputText(el, message.text);
      sendResponse({ ok });
      return true;
    }
  });
})();
