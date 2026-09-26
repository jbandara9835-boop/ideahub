// ─────────────────────────────────────────────────────────────────────────────
// chat-widget.js — IdeaHub assistant widget
// Put this file in /public, then add before </body> on any page:
//   <script src="/chat-widget.js" defer></script>
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  if (window.__ideahubChat) return;
  window.__ideahubChat = true;

  const MAX_HISTORY = 10;
  const history = [];   // { role: 'user' | 'assistant', content }
  let busy = false;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const css = `
  .ihc-btn{position:fixed;right:24px;bottom:24px;z-index:9998;background:#f5c842;color:#080809;border:none;border-radius:999px;padding:12px 20px;font:600 14px 'DM Sans',system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);transition:transform .15s}
  .ihc-btn:hover{transform:translateY(-2px)}
  .ihc-panel{position:fixed;right:24px;bottom:84px;z-index:9999;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#0d0d0f;border:1px solid rgba(245,200,66,.18);border-radius:16px;display:none;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6);font-family:'DM Sans',system-ui,sans-serif;color:#f0ede8}
  .ihc-panel.open{display:flex}
  .ihc-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07)}
  .ihc-title{font:700 15px 'Cabinet Grotesk','DM Sans',sans-serif;color:#f5c842}
  .ihc-sub{font-size:12px;color:#8a8680;margin-top:2px}
  .ihc-close{background:none;border:none;color:#8a8680;font-size:22px;line-height:1;cursor:pointer;padding:4px 6px}
  .ihc-close:hover{color:#f0ede8}
  .ihc-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .ihc-msg{max-width:88%;padding:10px 13px;border-radius:12px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}
  .ihc-user{align-self:flex-end;background:#f5c842;color:#080809;border-bottom-right-radius:4px}
  .ihc-bot{align-self:flex-start;background:#1a1a1f;border-bottom-left-radius:4px}
  .ihc-err{align-self:flex-start;background:rgba(220,80,80,.12);color:#f0b0b0;font-size:13px}
  .ihc-cards{display:flex;flex-direction:column;gap:6px;align-self:stretch}
  .ihc-card{display:block;text-decoration:none;background:#141418;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;color:#f0ede8;transition:border-color .15s}
  .ihc-card:hover{border-color:rgba(245,200,66,.5)}
  .ihc-card-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
  .ihc-card-title{font-weight:600;font-size:14px}
  .ihc-card-price{color:#f5c842;font-weight:600;font-size:13px;white-space:nowrap}
  .ihc-card-sub{color:#8a8680;font-size:12px;margin-top:3px}
  .ihc-chips{display:flex;flex-wrap:wrap;gap:6px}
  .ihc-chip{background:transparent;border:1px solid rgba(245,200,66,.35);color:#f0ede8;border-radius:999px;padding:6px 11px;font:13px 'DM Sans',sans-serif;cursor:pointer}
  .ihc-chip:hover{background:rgba(245,200,66,.1)}
  .ihc-typing{align-self:flex-start;color:#8a8680;font-size:13px;padding:4px 2px}
  .ihc-form{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.07)}
  .ihc-input{flex:1;background:#141418;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;color:#f0ede8;font:14px 'DM Sans',sans-serif;outline:none;resize:none;max-height:100px}
  .ihc-input:focus{border-color:rgba(245,200,66,.5)}
  .ihc-send{background:#f5c842;color:#080809;border:none;border-radius:10px;padding:0 16px;font:600 14px 'DM Sans',sans-serif;cursor:pointer}
  .ihc-send:disabled{opacity:.5;cursor:default}
  .ihc-foot{font-size:11px;color:#5e5b56;text-align:center;padding:0 12px 10px}
  @media (max-width:768px){
    .ihc-btn{right:16px;bottom:84px}
    .ihc-panel{right:8px;left:8px;width:auto;max-width:none;bottom:76px;height:calc(100vh - 150px)}
  }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Markup ──────────────────────────────────────────────────────────────────
  const btn = el('button', 'ihc-btn', 'Ask IdeaHub');
  btn.setAttribute('aria-label', 'Open IdeaHub assistant');

  const panel = el('div', 'ihc-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'IdeaHub assistant');
  panel.innerHTML = `
    <div class="ihc-head">
      <div><div class="ihc-title">IdeaHub Assistant</div><div class="ihc-sub">Find ideas, businesses and experts</div></div>
      <button class="ihc-close" aria-label="Close">&times;</button>
    </div>
    <div class="ihc-body"></div>
    <form class="ihc-form">
      <textarea class="ihc-input" rows="1" maxlength="1000" placeholder="Ask about ideas, franchises, experts..."></textarea>
      <button class="ihc-send" type="submit">Send</button>
    </form>
    <div class="ihc-foot">AI answers can be wrong. Check listing details before you buy.</div>`;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const body = panel.querySelector('.ihc-body');
  const form = panel.querySelector('.ihc-form');
  const input = panel.querySelector('.ihc-input');
  const send = panel.querySelector('.ihc-send');

  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      if (!body.children.length) welcome();
      input.focus();
    }
  });
  panel.querySelector('.ihc-close').addEventListener('click', () => panel.classList.remove('open'));

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) ask(text);
  });

  // ── Behaviour ───────────────────────────────────────────────────────────────
  function welcome() {
    addMsg('bot', 'Hi! I can help you find ideas to buy, businesses to franchise, investor requests, or professionals to hire. What are you looking for?');
    const chips = el('div', 'ihc-chips');
    ['Tech ideas under $5,000', 'Franchises in Sri Lanka', 'What are investors looking for?', 'How does escrow work?']
      .forEach(q => {
        const c = el('button', 'ihc-chip', q);
        c.type = 'button';
        c.addEventListener('click', () => { chips.remove(); ask(q); });
        chips.appendChild(c);
      });
    body.appendChild(chips);
  }

  async function ask(text) {
    if (busy) return;
    busy = true; send.disabled = true;
    input.value = '';
    body.querySelector('.ihc-chips')?.remove();
    addMsg('user', text);
    history.push({ role: 'user', content: text });

    const typing = el('div', 'ihc-typing', 'Searching...');
    body.appendChild(typing); scroll();

    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = getToken();
      if (token) headers.Authorization = 'Bearer ' + token;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: history.slice(-MAX_HISTORY), page: location.pathname })
      });
      const data = await res.json().catch(() => ({}));
      typing.remove();

      if (!res.ok) {
        history.pop();   // let the user retry the same question
        addMsg('err', data.error || 'Something went wrong. Please try again.');
      } else {
        addMsg('bot', data.reply);
        history.push({ role: 'assistant', content: data.reply });
        if (Array.isArray(data.cards) && data.cards.length) addCards(data.cards);
      }
    } catch {
      typing.remove();
      history.pop();
      addMsg('err', 'Connection problem. Check your internet and try again.');
    } finally {
      busy = false; send.disabled = false; input.focus();
    }
  }

  function addMsg(kind, text) {
    const cls = kind === 'user' ? 'ihc-user' : kind === 'err' ? 'ihc-err' : 'ihc-bot';
    body.appendChild(el('div', 'ihc-msg ' + cls, text));
    scroll();
  }

  function addCards(cards) {
    const wrap = el('div', 'ihc-cards');
    cards.forEach(c => {
      const a = document.createElement('a');
      a.className = 'ihc-card';
      a.href = safeUrl(c.url);
      const top = el('div', 'ihc-card-top');
      top.appendChild(el('div', 'ihc-card-title', c.title || 'Untitled'));
      if (c.price != null && c.price !== '') {
        const amount = '$' + Number(c.price).toLocaleString('en-US');
        const label = c.priceLabel === '/hr' ? amount + '/hr'
          : c.priceLabel ? c.priceLabel + ' ' + amount : amount;
        top.appendChild(el('div', 'ihc-card-price', label));
      }
      a.appendChild(top);
      if (c.subtitle) a.appendChild(el('div', 'ihc-card-sub', c.subtitle));
      wrap.appendChild(a);
    });
    body.appendChild(wrap);
    scroll();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent = no HTML injection
    return n;
  }
  function scroll() { body.scrollTop = body.scrollHeight; }
  function safeUrl(u) { return typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '#'; }
  function getToken() {
    try { return localStorage.getItem('token') || localStorage.getItem('ideahub_token') || null; }
    catch { return null; }
  }
})();
