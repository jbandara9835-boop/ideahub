/* app-nav.js — the one sidebar for every signed-in app page (dashboards, profile, settings, submit, messages, wallet…).
   Include it right after the page's <aside class="sidebar">…</aside>. It replaces that sidebar's contents with a
   standard, role-aware menu (text only), adds a compact top bar + slide-out menu on tablets/phones, and keeps the
   element ids older page scripts write into (sidebarName, sidebarAvatar, …) so nothing breaks. */
(function () {
  'use strict';
  const aside = document.currentScript && document.currentScript.previousElementSibling && document.currentScript.previousElementSibling.matches('aside.sidebar')
    ? document.currentScript.previousElementSibling : document.querySelector('aside.sidebar');
  if (!aside) return;

  let user = null;
  try { user = JSON.parse(localStorage.getItem('ih_user') || localStorage.getItem('user') || 'null'); } catch (e) {}
  const role = (user && user.role) || '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PROS = ['virtual_manager', 'patent_attorney', 'chartered_accountant', 'corporate_services'];
  const DASH = { idea_creator: '/dashboard', patent_seller: '/dashboard', investor: '/buyer-dashboard', business_owner: '/business-dashboard', admin: '/admin' };
  const dash = DASH[role] || (PROS.includes(role) ? '/support-dashboard' : '/dashboard');
  const ROLE_NAME = { idea_creator: 'Idea Creator', patent_seller: 'Patent Seller', investor: 'Investor', business_owner: 'Business Owner', virtual_manager: 'Virtual Manager', patent_attorney: 'Patent Attorney', chartered_accountant: 'Chartered Accountant', corporate_services: 'Corporate Services', admin: 'Administrator' };

  // ── Menu, by role ──
  const work = {
    idea_creator: [['/submit', 'List an idea'], ['/patents', 'Patent applications'], ['/deal-room', 'Deal rooms'], ['/hire', 'My hires'], ['/managers?tab=mine', 'My managers']],
    patent_seller: [['/submit', 'List an idea or patent'], ['/patents', 'Patent applications'], ['/deal-room', 'Deal rooms'], ['/hire', 'My hires'], ['/managers?tab=mine', 'My managers']],
    investor: [['/post-request', 'Post an Idea Request'], ['/expansion', 'Expansion deals'], ['/deal-room', 'Deal rooms'], ['/hire', 'My hires'], ['/managers?tab=mine', 'My managers']],
    business_owner: [['/list-business', 'List a business'], ['/expansion', 'Expansion deals'], ['/deal-room', 'Deal rooms'], ['/hire', 'My hires'], ['/managers?tab=mine', 'My managers']],
    virtual_manager: [['/workspace', 'Manager workspace'], ['/managers?tab=requests', 'Requests board'], ['/manage', 'Client listings'], ['/hire', 'Hires'], ['/deal-room', 'Deal rooms'], ['/support-profile', 'Service profile']],
    patent_attorney: [['/patents', 'Patent applications'], ['/hire', 'Hires'], ['/deal-room', 'Deal rooms'], ['/support-profile', 'Service profile']],
    chartered_accountant: [['/hire', 'Hires'], ['/deal-room', 'Deal rooms'], ['/expansion', 'Expansion deals'], ['/support-profile', 'Service profile']],
    corporate_services: [['/hire', 'Hires'], ['/deal-room', 'Deal rooms'], ['/support-profile', 'Service profile']],
    admin: [['/wa-sim', 'WhatsApp simulator']]
  }[role] || [['/submit', 'List an idea']];
  const help = role === 'virtual_manager' ? [['/find-support', 'Professionals']] : [['/find-support', 'Professionals'], ['/managers', 'Find a Manager']];
  const SECTIONS = [
    ['Overview', [[dash, role === 'admin' ? 'Admin panel' : 'Dashboard'], ['/messages', 'Messages'], ['/transactions', 'Wallet']]],
    ['Marketplace', [['/browse', 'Marketplace'], ['/idea-requests', 'Idea Requests'], ['/businesses', 'Business Expansion'], ['/wall', 'IdeaWall']]],
    ['My work', work],
    ['Get help', help],
    ['Account', [['/profile', 'My profile'], ['/settings', 'Settings'], ['/switch-role', 'Switch role']]]
  ];
  const here = location.pathname.replace(/\/$/, '') || '/';
  const herePlus = here + location.search;
  const isActive = href => { const [p, q] = href.split('?'); return q ? herePlus === href : here === p || (p === dash && /dashboard$/.test(here)); };

  // ── Styles (scoped; win over each page's old sidebar CSS) ──
  const css = `
  aside.sidebar.ih-side{position:fixed!important;top:0!important;left:0!important;bottom:0!important;width:228px!important;height:100vh!important;padding:18px 12px 12px!important;display:flex!important;flex-direction:column!important;gap:0!important;background:#111114!important;border-right:1px solid rgba(255,255,255,.07)!important;z-index:1000!important;overflow:hidden!important;font-family:'DM Sans',system-ui,sans-serif!important;transition:transform .22s ease!important;transform:none}
  .ih-side *{box-sizing:border-box}
  .ih-logo{display:flex;align-items:center;gap:10px;padding:0 8px 16px;text-decoration:none;color:#f0ede8}
  .ih-logo i{width:32px;height:32px;border-radius:8px;background:#1d1d22;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .ih-logo svg{width:28px;height:28px;fill:#0d0d0f}
  .ih-logo b{font-family:'Cabinet Grotesk','DM Sans',sans-serif;font-size:18px;font-weight:800}
  .ih-nav{flex:1;overflow-y:auto;scrollbar-width:none;margin:0 -4px;padding:0 4px}
  .ih-nav::-webkit-scrollbar{display:none}
  .ih-sec{font-size:10.5px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#7b776f;padding:14px 10px 5px}
  .ih-sec:first-child{padding-top:2px}
  .ih-item{display:block;padding:7px 10px;border-radius:8px;font-size:13.5px;font-weight:500;color:#a9a59d;text-decoration:none;line-height:1.3;transition:background .15s,color .15s}
  .ih-item:hover{color:#f0ede8;background:rgba(255,255,255,.05)}
  .ih-item.on{color:#f5c842;background:rgba(245,200,66,.1)}
  .ih-item:focus-visible,.ih-card:focus-visible,.ih-burger:focus-visible{outline:2px solid #f5c842;outline-offset:1px}
  .ih-card{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:12px;margin-top:10px;cursor:pointer;background:none;color:inherit;width:100%;text-align:left;font:inherit;position:relative}
  .ih-card:hover{border-color:rgba(255,255,255,.16)}
  .ih-av{width:34px;height:34px;border-radius:50%;background:rgba(245,200,66,.1);border:1px solid #f5c842;color:#f5c842;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;overflow:hidden;flex-shrink:0}
  .ih-av img{width:100%;height:100%;object-fit:cover}
  .ih-who{flex:1;min-width:0}
  .ih-name{display:block;font-size:13px;font-weight:600;color:#f0ede8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ih-role{display:block;font-size:11.5px;color:#7b776f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ih-menu{position:absolute;left:12px;right:12px;bottom:70px;background:#1a1a1f;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px;display:none;box-shadow:0 14px 40px rgba(0,0,0,.5);z-index:2}
  .ih-menu.open{display:block}
  .ih-menu a,.ih-menu button{display:block;width:100%;text-align:left;padding:8px 10px;border-radius:8px;font:500 13.5px 'DM Sans',system-ui,sans-serif;color:#d9d5cd;text-decoration:none;background:none;border:none;cursor:pointer}
  .ih-menu a:hover,.ih-menu button:hover{background:rgba(255,255,255,.06)}
  .ih-menu .out{color:#ff8a8a}
  .ih-ghost{display:none!important}
  /* the logo is already in the sidebar: drop the duplicate in page top bars */
  .topbar-logo,.menu-toggle,.sidebar-overlay{display:none!important}
  @media (min-width:901px){ body .main{margin-left:228px!important} }
  .ih-bar{display:none}
  @media (max-width:900px){
    body .main{margin-left:0!important}
    body{padding-top:56px!important}
    aside.sidebar.ih-side{transform:translateX(-102%);width:270px!important;box-shadow:none}
    body.ih-open aside.sidebar.ih-side{transform:none;box-shadow:0 0 60px rgba(0,0,0,.7)}
    .ih-bar{display:flex;position:fixed;top:0;left:0;right:0;height:56px;z-index:990;align-items:center;gap:10px;padding:0 12px;background:rgba(8,8,9,.94);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.07)}
    .ih-burger{width:40px;height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:none;color:#f0ede8;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .ih-bar .ih-logo{padding:0}
    .ih-bar .ih-logo i{width:28px;height:28px}
    .ih-bar .ih-logo b{font-size:17px}
    .ih-scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999;display:none}
    body.ih-open .ih-scrim{display:block}
    body.ih-open{overflow:hidden}
  }`;
  const st = document.createElement('style'); st.id = 'ih-app-nav'; st.textContent = css; document.head.appendChild(st);

  const LOGO = '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M31.4 38A24 24 0 0 1 76.6 38Z" fill="#f5c842"/><path d="M76.6 38A24 24 0 0 1 31.4 38Z" fill="#e8862a"/><path d="M31 38H77" stroke="#1d1d22" stroke-width="3" fill="none"/><rect x="24" y="14" width="16" height="76" rx="8" fill="#f0ede8"/></svg>';
  const name = user ? (`${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email || 'My account') : 'Guest';
  const initials = name.split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  const avatarUrl = user && (user.avatar_url || user.avatarUrl);

  aside.classList.add('ih-side');
  aside.setAttribute('aria-label', 'Main menu');
  aside.id = aside.id || 'ihSide';
  aside.innerHTML = `
    <a class="ih-logo" href="/"><i>${LOGO}</i><b style="display:inline-flex;flex-direction:column;line-height:1">Picela<small style="display:block;font:600 9.5px/1 'DM Sans',system-ui,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:#f5c842;margin-top:4px">the idea hub</small></b></a>
    <nav class="ih-nav" aria-label="App">${SECTIONS.map(([label, items]) => `<div class="ih-sec">${esc(label)}</div>` + items.map(([href, text]) => `<a class="ih-item${isActive(href) ? ' on' : ''}" href="${esc(href)}"${isActive(href) ? ' aria-current="page"' : ''}>${esc(text)}</a>`).join('')).join('')}</nav>
    <button class="ih-card" id="userCard" type="button" aria-haspopup="menu" aria-expanded="false">
      <span class="ih-av" id="sidebarAvatar">${avatarUrl ? `<img src="${esc(avatarUrl)}" alt="">` : `<span id="sidebarAvatarText">${esc(initials)}</span>`}</span>
      <span class="ih-who"><span class="ih-name" id="sidebarName">${esc(name)}</span><span class="ih-role" id="sidebarRole">${esc(ROLE_NAME[role] || '')}</span></span>
      <span aria-hidden="true" style="color:#7b776f">⋯</span>
    </button>
    <div class="ih-menu" id="userMenu" role="menu">
      <a href="/profile" role="menuitem">My profile</a>
      <a href="/settings" role="menuitem">Settings</a>
      <a href="/switch-role" role="menuitem">Switch role</a>
      <button type="button" class="out" role="menuitem" data-ih-logout>Sign out</button>
    </div>
    <div class="ih-ghost" aria-hidden="true"><div id="sidebarNav"></div><span id="sidebarStars"></span><a id="newIdeaBtn"></a><a id="dashLink"></a></div>`;

  const card = aside.querySelector('#userCard'), menu = aside.querySelector('#userMenu');
  card.addEventListener('click', e => { e.stopPropagation(); const o = menu.classList.toggle('open'); card.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) { menu.classList.remove('open'); card.setAttribute('aria-expanded', 'false'); } });
  aside.querySelector('[data-ih-logout]').addEventListener('click', () => {
    ['ih_token', 'ih_user', 'token', 'user'].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    location.href = '/login';
  });

  // Some older page scripts write a blank name or a lower-case role here: keep ours
  const keep = (id, val) => { const el = aside.querySelector('#' + id); if (!el || !val) return; new MutationObserver(() => { if (el.textContent !== val) el.textContent = val; }).observe(el, { childList: true, characterData: true, subtree: true }); };
  keep('sidebarName', name); keep('sidebarRole', ROLE_NAME[role] || '');

  // Tablets / phones: a compact top bar with a menu button
  const bar = document.createElement('div');
  bar.className = 'ih-bar';
  bar.innerHTML = `<button class="ih-burger" type="button" aria-label="Open menu" aria-controls="${aside.id}" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><a class="ih-logo" href="/"><i>${LOGO}</i><b style="display:inline-flex;flex-direction:column;line-height:1">Picela<small style="display:block;font:600 9.5px/1 'DM Sans',system-ui,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:#f5c842;margin-top:4px">the idea hub</small></b></a>`;
  const scrim = document.createElement('div'); scrim.className = 'ih-scrim';
  document.body.insertBefore(bar, document.body.firstChild);
  document.body.appendChild(scrim);
  const burger = bar.querySelector('.ih-burger');
  const setOpen = v => { document.body.classList.toggle('ih-open', v); burger.setAttribute('aria-expanded', v ? 'true' : 'false'); if (v) { const a = aside.querySelector('.ih-item'); if (a) a.focus(); } };
  burger.addEventListener('click', () => setOpen(!document.body.classList.contains('ih-open')));
  scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('ih-open')) { setOpen(false); burger.focus(); } });
  // Old page scripts sometimes call these
  window.toggleSidebar = () => setOpen(!document.body.classList.contains('ih-open'));
  window.closeSidebar = () => setOpen(false);

  // Phones: the same bottom tab bar as public pages (styles in site.css)
  const ICON = { home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>', market: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>', wall: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' };
  const svgI = k => `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const POST = { idea_creator: ['/submit', 'List an idea'], patent_seller: ['/submit', 'List an idea or patent'], investor: ['/post-request', 'Post an Idea Request'], business_owner: ['/list-business', 'List your business'] };
  const addTabbar = () => {
    if (document.querySelector('.ih-tabbar')) return;
    const [ph, pl] = POST[role] || ['/wall', 'Post on IdeaWall'];
    const tab = (href, label, k) => `<a href="${href}"${here === href ? ' class="on" aria-current="page"' : ''}>${svgI(k)}<span>${label}</span></a>`;
    const tb = document.createElement('nav');
    tb.className = 'ih-tabbar'; tb.setAttribute('aria-label', 'Quick links');
    tb.innerHTML = tab(dash, 'Home', 'home') + tab('/browse', 'Marketplace', 'market') + `<a class="ih-tab-post" href="${ph}" aria-label="${esc(pl)}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></a>` + tab('/messages', 'Messages', 'chat') + tab('/wall', 'IdeaWall', 'wall');
    document.body.appendChild(tb); document.body.classList.add('ih-has-tabbar');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTabbar); else addTabbar();
})();
