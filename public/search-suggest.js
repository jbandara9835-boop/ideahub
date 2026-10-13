/* search-suggest.js — live suggestions under a search box (home page).
   SearchSuggest.attach(inputEl, { anchor: elementToAlignUnder, category: () => 'Agriculture' | '' })
   Suggestions come from GET /api/search/suggest?q= (public live ideas, open Idea Requests, industries). */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = `
  .ss-box{position:absolute;z-index:1200;background:#121216;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.6);overflow:hidden;display:none;text-align:left;font-family:'DM Sans',system-ui,sans-serif}
  .ss-box.show{display:block}
  .ss-head{font-size:10.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#7b776f;padding:10px 14px 4px}
  .ss-item{display:flex;align-items:center;gap:10px;padding:9px 14px;color:#f0ede8;text-decoration:none;font-size:14px;cursor:pointer}
  .ss-item .ic{width:22px;text-align:center;flex-shrink:0;font-size:15px}
  .ss-item .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ss-item .tx mark{background:none;color:#f5c842;font-weight:700}
  .ss-item .meta{font-size:12px;color:#7b776f;white-space:nowrap}
  .ss-item.on,.ss-item:hover{background:rgba(245,200,66,.08)}
  .ss-empty{padding:12px 14px;color:#7b776f;font-size:13px}
  .ss-sep{border-top:1px solid rgba(255,255,255,.07);margin-top:4px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function highlight(text, q) {
    const t = String(text || ''), i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0 || !q) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }
  const browse = (q, cat) => { const p = new URLSearchParams(); if (q) p.set('search', q); if (cat) p.set('category', cat); const s = p.toString(); return '/browse' + (s ? '?' + s : ''); };

  let n = 0;
  function attach(input, opts) {
    opts = opts || {};
    const anchor = opts.anchor || input;
    const fixed = !!opts.fixed;
    const box = document.createElement('div');
    box.className = 'ss-box'; box.id = 'ss-' + (++n); box.setAttribute('role', 'listbox');
    if (fixed) box.style.position = 'fixed';
    document.body.appendChild(box);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', box.id); input.setAttribute('aria-expanded', 'false'); input.setAttribute('autocomplete', 'off');

    let timer = null, seq = 0, active = -1, items = [];
    const cache = new Map();
    function place() {
      const r = anchor.getBoundingClientRect();
      box.style.left = (r.left + (fixed ? 0 : scrollX)) + 'px';
      box.style.top = (r.bottom + 6 + (fixed ? 0 : scrollY)) + 'px';
      box.style.width = r.width + 'px';
    }
    function hide() { box.classList.remove('show'); input.setAttribute('aria-expanded', 'false'); active = -1; }
    function setActive(i) {
      items.forEach((el, k) => el.classList.toggle('on', k === i));
      active = i;
      if (items[i]) input.setAttribute('aria-activedescendant', items[i].id); else input.removeAttribute('aria-activedescendant');
    }
    function render(q, d) {
      const cat = opts.category ? opts.category() : '';
      let html = `<a class="ss-item" href="${browse(q, cat)}" role="option"><span class="ic">🔍</span><span class="tx">Search ideas for “<b>${esc(q)}</b>”${cat ? ` in ${esc(cat)}` : ''}</span></a>`;
      if (d.industries.length) html += `<div class="ss-sep"></div><div class="ss-head">Industries</div>` + d.industries.map(x => `<a class="ss-item" href="${browse('', x)}" role="option"><span class="ic">🏷️</span><span class="tx">${highlight(x, q)}</span><span class="meta">Industry</span></a>`).join('');
      if (d.ideas.length) html += `<div class="ss-sep"></div><div class="ss-head">Ideas</div>` + d.ideas.map(x => `<a class="ss-item" href="/idea?id=${encodeURIComponent(x.id)}" role="option"><span class="ic">💡</span><span class="tx">${highlight(x.title, q)}</span><span class="meta">${x.price ? '$' + Number(x.price).toLocaleString() : esc(x.industry || '')}</span></a>`).join('');
      if (d.requests.length) html += `<div class="ss-sep"></div><div class="ss-head">Idea Requests</div>` + d.requests.map(x => `<a class="ss-item" href="/request/${encodeURIComponent(x.id)}" role="option"><span class="ic">📣</span><span class="tx">${highlight(x.title, q)}</span><span class="meta">Request</span></a>`).join('');
      if (!d.ideas.length && !d.requests.length && !d.industries.length) html += `<div class="ss-empty">No matching ideas yet. Press Enter to search the whole Marketplace.</div>`;
      box.innerHTML = html;
      items = [...box.querySelectorAll('.ss-item')];
      items.forEach((el, k) => { el.id = box.id + '-o' + k; el.addEventListener('mousedown', e => e.preventDefault()); });
      active = -1;
      place(); box.classList.add('show'); input.setAttribute('aria-expanded', 'true');
    }
    async function lookup() {
      const q = input.value.trim();
      if (q.length < 2) return hide();
      const my = ++seq;
      let d = cache.get(q.toLowerCase());
      if (!d) {
        try { const r = await fetch('/api/search/suggest?q=' + encodeURIComponent(q)); d = r.ok ? await r.json() : null; } catch (e) { d = null; }
        if (!d) d = { ideas: [], requests: [], industries: [] };
        cache.set(q.toLowerCase(), d);
      }
      if (my === seq && document.activeElement === input) render(q, d);
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 160); });
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) lookup(); });
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', e => {
      if (!box.classList.contains('show')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, active + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(-1, active - 1)); }
      else if (e.key === 'Escape') { hide(); }
      else if (e.key === 'Enter' && active >= 0 && items[active]) { e.preventDefault(); location.href = items[active].href; }
    });
    addEventListener('resize', () => { if (box.classList.contains('show')) place(); });
    addEventListener('scroll', () => { if (box.classList.contains('show')) place(); }, { passive: true });
    return { hide };
  }
  window.SearchSuggest = { attach };
})();
