/* ─────────────────────────────────────────────────────────────────────────────
   site-nav.js — the one top nav for every public page.
   Usage (right after <body>):
     <header id="siteNav"></header><script src="/site-nav.js"></script>
   Options on the <header>:
     data-overlay   → no spacer under the nav (page hero already leaves room)
     data-extra="list-business" | "post-request"  → page-specific button
   Shows Sign In / Join Free for guests, and a notification drop-down + Dashboard + avatar menu
   when signed in. Keeps the old element ids (guestNav, userNav, navAvatar,
   dashboardLink, listBizBtn, postRequestNavBtn, backToDashBtn) so existing
   page scripts keep working.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  var host = document.getElementById('siteNav');
  if (!host) return;

  var LINKS = [
    ['/browse', 'Marketplace'],
    ['/businesses', 'Business Expansion'],
    ['/idea-requests', 'Request an Idea'],
    ['/find-support', 'Support Services'],
    ['/how-it-works', 'How It Works'],
    ['/wall', 'IdeaWall'],
    ['/life-hacks', 'Life Hacks'],
    ['/about', 'About']
  ];
  var DASH = {
    idea_creator: '/dashboard', patent_seller: '/dashboard',
    investor: '/buyer-dashboard', corporate_services: '/buyer-dashboard',
    virtual_manager: '/support-dashboard', chartered_accountant:'/support-dashboard', patent_attorney: '/attorney-dashboard',
    business_owner: '/business-dashboard', admin: '/admin'
  };
  var ROLE = {
    idea_creator: 'Idea Creator', patent_seller: 'Patent Seller', investor: 'Investor',
    corporate_services: 'Corporate', virtual_manager: 'Virtual Manager',
    patent_attorney: 'Patent Attorney', chartered_accountant:'Chartered Accountant', business_owner: 'Business Owner', admin: 'Administrator'
  };
  var LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26C17.81 13.47 19 11.38 19 9c0-3.87-3.13-7-7-7zm0 2c2.76 0 5 2.24 5 5 0 1.9-1.06 3.54-2.6 4.4L14 14h-4l-.4-.6C8.06 12.54 7 10.9 7 9c0-2.76 2.24-5 5-5zm-1 13h2v1h-2v-1zm-1 2h4v1h-4v-1z"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  function isActive(href) {
    if (href === path) return true;
    if (href === '/idea-requests' && path.indexOf('/request/') === 0) return true;
    if (href === '/businesses' && path.indexOf('/business/') === 0) return true;
    return false;
  }

  var token = null, user = null;
  try {
    token = localStorage.getItem('ih_token') || localStorage.getItem('token');
    user = JSON.parse(localStorage.getItem('ih_user') || localStorage.getItem('user') || 'null');
  } catch (e) { user = null; }
  var signedIn = !!(token && user);
  var dashUrl = signedIn ? (DASH[user.role] || '/dashboard') : '/dashboard';
  var extra = host.getAttribute('data-extra') || '';

  var links = LINKS.map(function (l) {
    return '<a href="' + l[0] + '"' + (isActive(l[0]) ? ' class="active" aria-current="page"' : '') + '>' + l[1] + '</a>';
  }).join('');

  var initial = signedIn ? esc((user.first_name || user.name || user.email || 'U').charAt(0).toUpperCase()) : '';
  var avatarUrl = signedIn ? (user.avatar_url || user.avatarUrl) : null;
  var avatarInner = avatarUrl ? '<img src="' + esc(avatarUrl) + '" alt="">' : initial;
  var fullName = signedIn ? esc(((user.first_name || '') + ' ' + (user.last_name || '')).trim() || user.email || 'My account') : '';

  host.className = 'sn' + (signedIn ? ' sn-in' : '');
  host.setAttribute('role', 'navigation');
  host.innerHTML =
    '<a class="sn-logo" href="/"><span class="sn-logo-icon">' + LOGO + '</span><span class="sn-logo-text">IdeaHub</span></a>' +
    '<div class="sn-links">' + links + '</div>' +
    '<div class="sn-right">' +
      '<div id="guestNav"><a class="sn-btn-ghost" href="/login">Sign In</a><a class="sn-btn-primary" href="/signup">Join Free →</a></div>' +
      '<div id="userNav"' + (signedIn ? ' class="visible"' : '') + '>' +
        (extra === 'post-request' ? '<a class="sn-btn-ghost" id="postRequestNavBtn" href="/post-request" style="display:none">+ Post Request</a>' : '') +
        (extra === 'list-business' ? '<a class="sn-btn-ghost" id="listBizBtn" href="/list-business">+ List Business</a>' : '') +
        '<a id="backToDashBtn" href="' + dashUrl + '" aria-hidden="true" tabindex="-1"></a>' +
        '<div class="sn-bell-wrap">' +
          '<button type="button" class="sn-bell" id="snBell" title="Notifications" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">🔔<span class="sn-bell-badge" id="snBellBadge"></span></button>' +
          '<div class="sn-notif" id="snNotif" role="dialog" aria-label="Notifications">' +
            '<div class="sn-notif-head"><span class="sn-notif-title">Notifications</span><button type="button" class="sn-notif-all" id="snNotifAll">Mark all as read</button></div>' +
            '<div class="sn-notif-tabs"><button type="button" class="on" data-f="all">All</button><button type="button" data-f="unread">Unread</button></div>' +
            '<div class="sn-notif-list" id="snNotifList"><div class="sn-notif-empty">Loading…</div></div>' +
          '</div>' +
        '</div>' +
        '<a class="sn-btn-primary sn-dash-btn" id="dashboardLink" href="' + dashUrl + '">Dashboard</a>' +
        '<div class="sn-avatar-wrap">' +
          '<button type="button" id="navAvatar" aria-label="Account menu" aria-haspopup="true">' + avatarInner + '</button>' +
          '<div class="sn-menu" id="snMenu" role="menu">' +
            '<div class="sn-menu-head"><div class="sn-menu-name">' + fullName + '</div><div class="sn-menu-role">' + esc(signedIn ? (ROLE[user.role] || '') : '') + '</div></div>' +
            '<a href="' + dashUrl + '" role="menuitem">Dashboard</a>' +
            '<a href="/profile" role="menuitem">My Profile</a>' +
            '<a href="/messages" role="menuitem">Messages</a>' +
            '<a href="/transactions" role="menuitem">Wallet</a>' +
            '<a href="/settings" role="menuitem">Settings</a>' +
            '<button type="button" class="sn-signout" id="snSignOut" role="menuitem">Sign Out</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="sn-burger" id="snBurger" aria-label="Menu" aria-expanded="false">☰</button>' +
    '</div>';

  var drawer = document.createElement('div');
  drawer.className = 'sn-drawer';
  drawer.id = 'snDrawer';
  drawer.innerHTML = links + (signedIn ? '<a href="' + dashUrl + '">Dashboard</a>' : '<a href="/login">Sign In</a><a href="/signup">Join Free →</a>');
  host.parentNode.insertBefore(drawer, host.nextSibling);

  if (!host.hasAttribute('data-overlay')) {
    var spacer = document.createElement('div');
    spacer.className = 'sn-spacer';
    drawer.parentNode.insertBefore(spacer, drawer.nextSibling);
  }

  var burger = document.getElementById('snBurger');
  burger.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = drawer.classList.toggle('open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.textContent = open ? '✕' : '☰';
  });

  var menu = document.getElementById('snMenu');
  document.getElementById('navAvatar').addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var np = document.getElementById('snNotif'); if (np) np.classList.remove('open');
    menu.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (!menu.contains(e.target)) menu.classList.remove('open');
    if (!drawer.contains(e.target) && e.target !== burger) {
      drawer.classList.remove('open'); burger.textContent = '☰'; burger.setAttribute('aria-expanded', 'false');
    }
  });
  document.getElementById('snSignOut').addEventListener('click', function () {
    ['ih_token', 'ih_user', 'token', 'user'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    location.href = '/';
  });

  if (signedIn && window.fetch) {
    var AUTH = { Authorization: 'Bearer ' + token };
    var badge = document.getElementById('snBellBadge');
    var bell = document.getElementById('snBell');
    var panel = document.getElementById('snNotif');
    var list = document.getElementById('snNotifList');
    var filter = 'all', notifs = [];

    var loadCount = function () {
      fetch('/api/notifications/unread-count', { headers: AUTH })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var n = d && Number(d.count || 0);
          if (n > 0) { badge.textContent = n > 99 ? '99+' : n; badge.style.display = 'flex'; }
          else badge.style.display = 'none';
        }).catch(function () {});
    };
    var ago = function (iso) {
      var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return 'Just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 604800) return Math.floor(s / 86400) + 'd ago';
      return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    };
    var render = function () {
      var rows = filter === 'unread' ? notifs.filter(function (n) { return !n.read; }) : notifs;
      if (!rows.length) {
        list.innerHTML = '<div class="sn-notif-empty">' + (filter === 'unread' ? 'You\'re all caught up 🎉' : '📭 No notifications yet') + '</div>';
        return;
      }
      list.innerHTML = rows.slice(0, 30).map(function (n) {
        var title = String(n.title || '');
        var icon = (title.match(/^\S+/) || ['🔔'])[0];
        var hasIcon = /[^\w\s]/.test(icon) && icon.length <= 4;
        return '<button type="button" class="sn-notif-item' + (n.read ? '' : ' unread') + '" data-id="' + esc(n.id) + '" data-link="' + esc(n.link || '') + '">' +
          '<span class="sn-notif-icon">' + (hasIcon ? esc(icon) : '🔔') + '</span>' +
          '<span class="sn-notif-body">' +
            '<span class="sn-notif-item-title">' + esc(hasIcon ? title.replace(/^\S+\s*/, '') : title) + '</span>' +
            '<span class="sn-notif-msg">' + esc(n.message || '') + '</span>' +
            '<span class="sn-notif-time">' + esc(ago(n.created_at)) + '</span>' +
          '</span>' +
          (n.read ? '' : '<span class="sn-notif-dot" aria-label="Unread"></span>') +
        '</button>';
      }).join('');
    };
    var loadList = function () {
      fetch('/api/notifications', { headers: AUTH })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (d) { notifs = Array.isArray(d) ? d : (d.notifications || []); render(); })
        .catch(function () { list.innerHTML = '<div class="sn-notif-empty">Couldn\'t load notifications.</div>'; });
    };

    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.remove('open');
      var open = panel.classList.toggle('open');
      bell.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) loadList();
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { panel.classList.remove('open'); bell.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { panel.classList.remove('open'); menu.classList.remove('open'); } });

    panel.querySelector('.sn-notif-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      filter = b.getAttribute('data-f');
      [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
      render();
    });
    document.getElementById('snNotifAll').addEventListener('click', function () {
      notifs.forEach(function (n) { n.read = true; }); render();
      badge.style.display = 'none';
      fetch('/api/notifications/read-all', { method: 'PUT', headers: AUTH }).then(loadCount).catch(function () {});
    });
    list.addEventListener('click', function (e) {
      var item = e.target.closest('.sn-notif-item'); if (!item) return;
      var id = item.getAttribute('data-id'), link = item.getAttribute('data-link');
      var go = function () { if (link) location.href = link; else { loadList(); loadCount(); } };
      fetch('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'PUT', headers: AUTH }).then(go, go);
    });

    loadCount();
    setInterval(loadCount, 60000);
  }
})();
