/* mgr-common.js — helpers shared by /managers, /mandate and /workspace (window.MG) */
(function () {
  'use strict';
  const token = (() => { try { return localStorage.getItem('ih_token'); } catch (e) { return null; } })();
  const me = (() => { try { return JSON.parse(localStorage.getItem('ih_user') || 'null'); } catch (e) { return null; } })();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => { const v = Number(n || 0); return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(path, { method: opts.method || 'GET', headers: Object.assign(opts.body ? { 'Content-Type': 'application/json' } : {}, token ? { Authorization: 'Bearer ' + token } : {}), body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'Something went wrong. Please try again.'); e.code = d.code; e.status = r.status; throw e; }
    return d;
  }
  function toast(msg) {
    let t = document.getElementById('mgToast');
    if (!t) { t = document.createElement('div'); t.id = 'mgToast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
  }
  const initials = n => String(n || '?').split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  const avatar = (url, name, cls) => `<span class="av ${cls || ''}" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="">` : esc(initials(name))}</span>`;
  const date = d => { const t = new Date(d); return isNaN(t) ? '' : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const ago = d => { const s = (Date.now() - new Date(d)) / 1000; if (!(s >= 0)) return ''; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; if (s < 604800) return Math.floor(s / 86400) + 'd ago'; return date(d); };
  const LEVEL = { new: ['New', ''], associate: ['Associate', 'blue'], verified: ['Verified', 'green'], senior: ['Senior', 'gold'] };
  const levelPill = l => `<span class="pill ${(LEVEL[l] || LEVEL.new)[1]}" title="Manager level">${l === 'senior' ? '★ ' : l === 'verified' ? '✓ ' : ''}${(LEVEL[l] || LEVEL.new)[0]}</span>`;
  const STATUS = { proposed: ['Waiting for an answer', 'gold'], active: ['Active', 'green'], ended: ['Ended', ''], declined: ['Declined', 'red'], cancelled: ['Withdrawn', 'red'] };
  const statusPill = s => `<span class="pill ${(STATUS[s] || ['', ''])[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
  const BILL = { due: ['To pay', 'gold'], paid: ['Paid · held', 'blue'], released: ['Paid to manager', 'green'], disputed: ['Problem reported', 'red'], refunded: ['Refunded', ''], cancelled: ['Withdrawn', ''] };
  const billPill = s => `<span class="pill ${(BILL[s] || ['', ''])[1]}">${esc((BILL[s] || [s])[0])}</span>`;
  const INDUSTRIES = ['Technology', 'Food & Beverage', 'Agriculture', 'Health & Wellness', 'Education', 'Finance', 'E-commerce', 'Retail', 'Manufacturing', 'Tourism & Hospitality', 'Real Estate', 'Entertainment', 'Environment', 'Transport & Logistics', 'Fashion', 'Other'];
  let metaP = null;
  const meta = () => (metaP = metaP || api('/api/managers/meta'));
  const feeText = (r, h, s) => [Number(r) > 0 ? `${money(r)}/month` : '', Number(h) > 0 ? `${money(h)}/hour` : '', Number(s) > 0 ? `${Number(s)}% success fee` : ''].filter(Boolean).join(' · ') || 'No fees';
  const sideOfRole = r => r === 'investor' ? 'investor' : r === 'business_owner' ? 'business' : 'creator';
  const isClientRole = r => ['idea_creator', 'patent_seller', 'investor', 'business_owner'].includes(r);
  function login() { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); }

  // One reusable dialog
  function dialog(title, body, foot, opts) {
    let bg = document.getElementById('mgDialog');
    if (!bg) {
      bg = document.createElement('div'); bg.id = 'mgDialog'; bg.className = 'modal-bg'; bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true');
      bg.innerHTML = '<div class="modal"><div class="modal-head"><h2 id="mgDialogTitle"></h2><button class="x" type="button" aria-label="Close" data-close>✕</button></div><div class="modal-body" id="mgDialogBody"></div><div class="modal-foot" id="mgDialogFoot"></div></div>';
      document.body.appendChild(bg);
      bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
      bg.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && bg.classList.contains('open')) close(); });
    }
    bg.querySelector('.modal').style.maxWidth = (opts && opts.width) || '';
    document.getElementById('mgDialogTitle').textContent = title;
    document.getElementById('mgDialogBody').innerHTML = `<div class="notice red err" id="mgErr" role="alert"></div>` + body;
    document.getElementById('mgDialogFoot').innerHTML = foot || '';
    bg.classList.add('open'); document.body.style.overflow = 'hidden';
    setTimeout(() => { const f = bg.querySelector('.modal-body input, .modal-body textarea, .modal-body select'); if (f) f.focus(); }, 40);
    return bg;
  }
  function close() { const bg = document.getElementById('mgDialog'); if (bg) bg.classList.remove('open'); document.body.style.overflow = ''; }
  function err(msg) { const e = document.getElementById('mgErr'); if (e) { e.textContent = msg; e.style.display = 'block'; e.scrollIntoView({ block: 'nearest' }); } }
  async function busy(btn, fn) {
    if (btn.disabled) return; const t = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Please wait…';
    try { await fn(); } catch (e) { err(e.message); toast(e.message); } finally { btn.disabled = false; btn.innerHTML = t; }
  }

  // Mandate terms form (used to appoint a manager, or to propose to a client)
  async function mandateForm(o) {
    const m = await meta();
    const side = o.side || 'investor';
    const scopes = Object.entries(m.scopes).filter(([, v]) => v.sides.includes(side));
    const d = o.defaults || {};
    return `
      ${o.intro ? `<div class="notice vm" style="margin-bottom:14px">${o.intro}</div>` : ''}
      ${o.chooseSide ? `<div class="field"><label for="mfSide">I am working for</label><select class="in" id="mfSide">${Object.entries(m.sides).map(([k, v]) => `<option value="${k}" ${k === side ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="mfTitle">What is this mandate for?</label><input class="in" id="mfTitle" maxlength="120" value="${esc(d.title || '')}" placeholder="e.g. Find and buy a food-tech idea, then set up the company"></div>
      <div class="field"><label for="mfInd">Industry</label><input class="in" id="mfInd" list="mfIndList" maxlength="60" value="${esc(d.focus_industry || '')}" placeholder="Choose or type"><datalist id="mfIndList">${INDUSTRIES.map(i => `<option value="${esc(i)}">`).join('')}</datalist><div class="hint">A manager works for only one client per industry at a time, so they never manage two competing businesses.</div></div>
      <div class="field"><label for="mfGoals">Goals and details</label><textarea class="in" id="mfGoals" maxlength="2000" placeholder="What does success look like? Budget, timing, anything the manager should know.">${esc(d.goals || '')}</textarea></div>
      <div class="field"><span class="lbl">What may the manager do?</span><div class="checks" id="mfScopes">${scopes.map(([k, v]) => `<label class="check"><input type="checkbox" value="${k}" ${(d.scopes || []).includes(k) ? 'checked' : ''}> <span>${esc(v.label)}</span></label>`).join('')}</div></div>
      <div class="field"><span class="lbl">Fees (leave any at 0)</span>
        <div class="fee-row">
          <div><div class="tiny muted" style="margin-bottom:4px">Monthly retainer</div><div class="inline-prefix"><span>$</span><input class="in" id="mfRet" type="number" min="0" step="1" value="${Number(d.fee_retainer || 0)}"></div></div>
          <div><div class="tiny muted" style="margin-bottom:4px">Per hour</div><div class="inline-prefix"><span>$</span><input class="in" id="mfHr" type="number" min="0" step="1" value="${Number(d.fee_hourly || 0)}"></div></div>
          <div><div class="tiny muted" style="margin-bottom:4px">Success fee %</div><input class="in" id="mfPct" type="number" min="0" max="50" step="0.5" value="${Number(d.fee_success_pct || 0)}"></div>
        </div>
        <div class="hint">IdeaHub adds 8% to each payment. Retainers are held until the end of each month and then paid to the manager.</div></div>
      <div class="grid g2">
        <div class="field"><label for="mfBudget">Spending limit per step (optional)</label><div class="inline-prefix"><span>$</span><input class="in" id="mfBudget" type="number" min="0" step="1" value="${d.budget_limit || ''}" placeholder="No limit"></div></div>
        <div class="field"><label for="mfEnd">End date (optional)</label><input class="in" id="mfEnd" type="date" value="${esc(d.end_date || '')}"></div>
      </div>
      <div class="notice gold small">The manager prepares; you approve and pay through IdeaHub. A manager only ever works for one side of a deal. The other side accepts these terms before anything starts.</div>`;
  }
  function readMandateForm() {
    const v = id => (document.getElementById(id) || {}).value;
    return {
      client_side: v('mfSide') || undefined, title: v('mfTitle'), focus_industry: v('mfInd'), goals: v('mfGoals'),
      scopes: [...document.querySelectorAll('#mfScopes input:checked')].map(i => i.value),
      fee_retainer: Number(v('mfRet') || 0), fee_hourly: Number(v('mfHr') || 0), fee_success_pct: Number(v('mfPct') || 0),
      budget_limit: v('mfBudget') ? Number(v('mfBudget')) : null, end_date: v('mfEnd') || null
    };
  }

  window.MG = { token, me, esc, money, api, toast, avatar, date, ago, levelPill, statusPill, billPill, INDUSTRIES, meta, feeText, sideOfRole, isClientRole, login, dialog, close, err, busy, mandateForm, readMandateForm };
})();
