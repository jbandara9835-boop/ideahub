// ─────────────────────────────────────────────────────────────────────────────
// hire.js — hiring a professional (attorney, accountant, virtual manager, corporate services)
//
//   pending      the client sends a request            → the pro is notified + emailed
//   quoted       the pro sends a fixed price and timeline (can revise until paid)
//   in_progress  the client pays the quote + 8% IdeaHub fee into escrow
//   delivered    the pro marks the work delivered
//   completed    the client confirms, or 7 days pass → paid to the pro's wallet
//   rejected (pro declines) · cancelled (client, before paying) · disputed → admin
//   release or refund. After completion the client can leave a review.
// Status changes only happen through these steps (no free-form status updates).
// Legacy status 'accepted' is treated like 'pending'.
//
// server.js mounts this BEFORE the old /api/hire routes, so these take precedence.
// bots.js:  require('./hire').core(supabase, escrow).runBot()
// ─────────────────────────────────────────────────────────────────────────────
const pros = require('./pros');
const DAY = 86400000;
const FEE_RATE = 0.08;
const AUTO_RELEASE_DAYS = 7;
const OPEN = ['pending', 'accepted', 'quoted', 'in_progress', 'delivered', 'disputed'];
const STATUS_LABEL = { pending: 'Requested', accepted: 'Requested', quoted: 'Quote received', in_progress: 'In progress', delivered: 'Delivered', completed: 'Completed', rejected: 'Declined', cancelled: 'Cancelled', disputed: 'Under review', refunded: 'Refunded' };
const ROLE_LABEL = { patent_attorney: 'Patent attorney / agent', chartered_accountant: 'Chartered accountant', virtual_manager: 'Virtual manager', corporate_services: 'Corporate services' };

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const round2 = n => Math.round(Number(n) * 100) / 100;
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';

function core(supabase, escrow) {
  const payments = require('./payments')(supabase);
  async function log(hireId, text) { await supabase.from('hire_messages').insert([{ hire_id: hireId, from_id: null, text, system: true }]); }
  async function addEarnings(userId, amount) {
    const { data: u } = await supabase.from('users').select('earnings').eq('id', userId).single();
    await supabase.from('users').update({ earnings: round2(Number(u?.earnings || 0) + Number(amount || 0)) }).eq('id', userId);
  }
  // Job counts and rating on the pro's service profile
  async function refreshStats(proId) {
    const [{ data: jobs }, { data: rates }] = await Promise.all([
      supabase.from('hire_requests').select('status').eq('support_id', proId),
      supabase.from('ratings').select('stars').eq('rated_user_id', proId)
    ]);
    const done = (jobs || []).filter(j => j.status === 'completed').length;
    const total = (jobs || []).filter(j => !['rejected', 'cancelled'].includes(j.status)).length;
    const n = (rates || []).length;
    const avg = n ? Math.round((rates.reduce((s, r) => s + Number(r.stars || 0), 0) / n) * 10) / 10 : null;
    await supabase.from('support_profiles').update({ completed_jobs: done, total_jobs: total, avg_rating: avg, rating_count: n }).eq('user_id', proId);
  }
  async function release(id, type, note) {
    const now = new Date().toISOString();
    const update = { status: 'completed', completed_at: now, release_type: type, updated_at: now };
    if (type === 'admin') { update.resolved_at = now; update.resolution_note = note || null; }
    const { data: rows, error } = await supabase.from('hire_requests').update(update).eq('id', id).in('status', type === 'admin' ? ['delivered', 'disputed', 'in_progress'] : ['delivered']).select();
    if (error) throw error;
    const h = rows && rows[0]; if (!h) return null;
    await addEarnings(h.support_id, h.amount);
    await payments.record({ kind: 'release', userId: h.support_id, amount: h.amount, meta: { hire_id: h.id, release_type: type } });
    await payments.record({ kind: 'fee', userId: null, amount: h.fee, meta: { hire_id: h.id } });
    await log(h.id, `Completed. ${escrow.money(h.amount)} was released to the professional.${note ? ' Note: ' + note : ''}`);
    await escrow.notify(h.support_id, { type: 'payment_released', title: '💰 Payment released', message: `${escrow.money(h.amount)} for "${h.title}" was added to your wallet.`, link: '/transactions' });
    await escrow.emailUser(h.support_id, `Payment released: ${escrow.money(h.amount)}`, 'You were paid', `${escrow.money(h.amount)} for <strong>"${escrow.esc(h.title)}"</strong> was added to your IdeaHub wallet.`, 'View wallet', '/transactions');
    await escrow.notify(h.client_id, { type: 'hire_completed', title: '⭐ How did it go?', message: `"${h.title}" is complete. Leave a review to help others choose.`, link: `/hire?id=${h.id}` });
    await refreshStats(h.support_id);
    return h;
  }
  async function refund(id, note) {
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('hire_requests').update({ status: 'refunded', resolved_at: now, resolution_note: note || null, updated_at: now }).eq('id', id).in('status', ['disputed', 'in_progress', 'delivered']).select();
    if (error) throw error;
    const h = rows && rows[0]; if (!h) return null;
    await payments.record({ kind: 'refund', userId: h.client_id, amount: h.total, meta: { hire_id: h.id, note: note || null } });
    await log(h.id, `Refunded to the client by IdeaHub.${note ? ' Note: ' + note : ''}`);
    for (const uid of [h.client_id, h.support_id]) await escrow.notify(uid, { type: 'hire_refunded', title: '↩️ Hire refunded', message: `"${h.title}" was refunded to the client.${note ? ' Note: ' + note : ''}`, link: `/hire?id=${h.id}` });
    await refreshStats(h.support_id);
    return h;
  }
  async function runBot() {
    let released = 0, reminders = 0;
    const { data: del } = await supabase.from('hire_requests').select('*').eq('status', 'delivered');
    for (const h of del || []) {
      const age = (Date.now() - new Date(h.delivered_at).getTime()) / DAY;
      if (age >= AUTO_RELEASE_DAYS) { if (await release(h.id, 'auto')) released++; }
      else if (age >= 4 && !h.client_reminded) {
        await escrow.notify(h.client_id, { type: 'confirm_reminder', title: '⏳ Please confirm the work', message: `"${h.title}" was delivered. Confirm or report a problem, otherwise payment is released in ${Math.ceil(AUTO_RELEASE_DAYS - age)} days.`, link: `/hire?id=${h.id}` });
        await supabase.from('hire_requests').update({ client_reminded: true }).eq('id', h.id);
        reminders++;
      }
    }
    const { data: pend } = await supabase.from('hire_requests').select('id, support_id, title, created_at, pro_reminded').in('status', ['pending', 'accepted']);
    for (const h of pend || []) {
      if (!h.pro_reminded && Date.now() - new Date(h.created_at).getTime() > 2 * DAY) {
        await escrow.notify(h.support_id, { type: 'hire_request', title: '⏳ A client is waiting for your reply', message: `"${h.title}": send a quote or decline.`, link: `/hire?id=${h.id}` });
        await supabase.from('hire_requests').update({ pro_reminded: true }).eq('id', h.id);
        reminders++;
      }
    }
    return `Hires: ${released} auto-released, ${reminders} reminder${reminders === 1 ? '' : 's'}`;
  }
  return { release, refund, runBot, refreshStats, log, payments };
}

function mount(app, { supabase, authMiddleware, escrow }) {
  const c = core(supabase, escrow);
  async function me(req) { const { data } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', req.user.id).single(); return data; }
  async function load(req) {
    const id = parseInt(req.params.id, 10);
    if (!id) return {};
    const { data: h } = await supabase.from('hire_requests').select('*').eq('id', id).single();
    if (!h) return {};
    const u = await me(req);
    const as = h.client_id === req.user.id ? 'client' : h.support_id === req.user.id ? 'pro' : u?.role === 'admin' ? 'admin' : null;
    if (!as) return {};
    return { h, as, u };
  }
  const fail = res => res.status(404).json({ error: 'Not found.' });

  // Create a request
  app.post('/api/hire', authMiddleware, async (req, res) => {
    const b = req.body || {};
    const proId = parseInt(b.support_id, 10);
    const title = txt(b.title, 150), description = txt(b.description, 3000);
    if (!proId || proId === req.user.id) return res.status(400).json({ error: 'Choose a professional.' });
    if (title.length < 5) return res.status(400).json({ error: 'Give the job a short title.' });
    if (description.length < 20) return res.status(400).json({ error: 'Describe what you need (at least 20 characters), so they can quote.' });
    const { data: pro } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', proId).single();
    if (!pro || !pros.PRO_ROLES.includes(pro.role)) return res.status(400).json({ error: 'This person does not offer services.' });
    if (pros.verifiedOnly() && !(await pros.isVerified(supabase, proId, pro.role))) return res.status(400).json({ error: 'This professional is not verified yet.' });
    const { data: profile } = await supabase.from('support_profiles').select('service_type, allowed_countries, restricted_countries').eq('user_id', proId).single();
    let warning = null; const country = txt(b.country, 60);
    if (profile && country) {
      if (profile.service_type === 'specific_countries' && profile.allowed_countries && !profile.allowed_countries.includes(country)) warning = `This professional mainly serves ${profile.allowed_countries.join(', ')}.`;
      else if (profile.service_type === 'restricted_countries' && profile.restricted_countries && profile.restricted_countries.includes(country)) warning = `This professional has restrictions for ${country}.`;
    }
    let ideaId = null;
    if (b.idea_id) { const { data: idea } = await supabase.from('ideas').select('id, creator_id').eq('id', parseInt(b.idea_id, 10)).single(); if (idea && idea.creator_id === req.user.id) ideaId = idea.id; }
    const { count } = await supabase.from('hire_requests').select('id', { count: 'exact', head: true }).eq('client_id', req.user.id).in('status', ['pending', 'accepted']);
    if ((count || 0) >= 15) return res.status(429).json({ error: 'You have 15 requests waiting for replies. Wait for answers or cancel some first.' });
    const budget = Number(b.budget) > 0 ? round2(b.budget) : null;
    const { data: h, error } = await supabase.from('hire_requests').insert([{ client_id: req.user.id, support_id: proId, idea_id: ideaId, role: pro.role, title, description, budget, deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : null, country: country || null, country_warning: !!warning, warning_message: warning, status: 'pending' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const u = await me(req);
    await c.log(h.id, `${fullName(u)} sent this request.`);
    await escrow.notify(proId, { type: 'hire_request', title: '📥 New hire request', message: `${fullName(u)}: "${title}"${budget ? ` (budget ${escrow.money(budget)})` : ''}. Send a quote or decline.`, link: `/hire?id=${h.id}` });
    await escrow.emailUser(proId, `New hire request: "${title}"`, 'A client wants to hire you',
      `<strong style="color:#f0ede8;">${escrow.esc(fullName(u))}</strong> sent you a request:<br><br><strong>"${escrow.esc(title)}"</strong>${budget ? `<br>Budget: ${escrow.money(budget)}` : ''}<br><br>Reply with a fixed quote or decline. The client pays into IdeaHub escrow when they accept.`, 'Open request', `/hire?id=${h.id}`);
    await c.refreshStats(proId);
    res.status(201).json(h);
  });

  // Lists
  async function shape(rows, otherKey) {
    const ids = [...new Set((rows || []).map(r => r[otherKey]))];
    const { data: users } = ids.length ? await supabase.from('users').select('id, first_name, last_name, avatar_url, role').in('id', ids) : { data: [] };
    const U = Object.fromEntries((users || []).map(u => [u.id, u]));
    return (rows || []).map(r => ({ ...r, status_label: STATUS_LABEL[r.status] || r.status, other: { id: r[otherKey], name: fullName(U[r[otherKey]]), avatar_url: U[r[otherKey]]?.avatar_url || null, role: U[r[otherKey]]?.role } }));
  }
  app.get('/api/hire/my-requests', authMiddleware, async (req, res) => {
    const { data } = await supabase.from('hire_requests').select('*').eq('client_id', req.user.id).order('created_at', { ascending: false });
    const out = await shape(data, 'support_id');
    res.json(out.map(r => ({ ...r, support: { id: r.other.id, first_name: r.other.name.split(' ')[0], last_name: r.other.name.split(' ').slice(1).join(' '), role: r.other.role } })));
  });
  app.get('/api/hire/incoming', authMiddleware, async (req, res) => {
    const { data } = await supabase.from('hire_requests').select('*').eq('support_id', req.user.id).order('created_at', { ascending: false });
    const out = await shape(data, 'client_id');
    res.json(out.map(r => ({ ...r, client: { id: r.other.id, first_name: r.other.name.split(' ')[0], last_name: r.other.name.split(' ').slice(1).join(' '), role: r.other.role } })));
  });

  // One hire (both sides)
  app.get('/api/hire/:id(\\d+)', authMiddleware, async (req, res) => {
    const { h, as } = await load(req); if (!h) return fail(res);
    const [{ data: people }, { data: msgs }, { data: rating }, { data: idea }] = await Promise.all([
      supabase.from('users').select('id, first_name, last_name, avatar_url, role, email').in('id', [h.client_id, h.support_id]),
      supabase.from('hire_messages').select('*').eq('hire_id', h.id).order('created_at', { ascending: true }).limit(500),
      supabase.from('ratings').select('stars, review, created_at').eq('hire_id', h.id).limit(1),
      h.idea_id ? supabase.from('ideas').select('id, title').eq('id', h.idea_id).single() : { data: null }
    ]);
    const P = Object.fromEntries((people || []).map(u => [u.id, u]));
    const person = id => P[id] ? { id, name: fullName(P[id]), avatar_url: P[id].avatar_url || null, role: P[id].role, role_label: ROLE_LABEL[P[id].role] || null, ...(as === 'admin' ? { email: P[id].email } : {}) } : null;
    let delegation = null;
    if (P[h.support_id]?.role === 'virtual_manager') {
      const { data: d } = await supabase.from('delegations').select('id, created_at').eq('owner_id', h.client_id).eq('delegate_id', h.support_id).eq('status', 'active');
      delegation = { active: !!(d && d.length), id: d && d[0] ? d[0].id : null };
    }
    res.json({
      ...h, viewer: as, status_label: STATUS_LABEL[h.status] || h.status, client: person(h.client_id), pro: person(h.support_id), idea: idea || null,
      fee_rate: FEE_RATE, payments_open: c.payments.purchasesOpen(), rating: rating && rating[0] ? rating[0] : null, delegation,
      confirm_by: h.status === 'delivered' && h.delivered_at ? new Date(new Date(h.delivered_at).getTime() + AUTO_RELEASE_DAYS * DAY).toISOString() : null,
      messages: (msgs || []).map(m => ({ id: m.id, from_id: m.from_id, text: m.text, system: !!m.system || !m.from_id, file_url: m.file_url || null, file_name: m.file_name || null, created_at: m.created_at }))
    });
  });

  app.get('/api/hire/:id/messages', authMiddleware, async (req, res) => {
    const { h } = await load(req); if (!h) return fail(res);
    const { data } = await supabase.from('hire_messages').select('*').eq('hire_id', h.id).order('created_at', { ascending: true });
    res.json(data || []);
  });
  app.post('/api/hire/:id/messages', authMiddleware, async (req, res) => {
    const { h, as, u } = await load(req); if (!h) return fail(res);
    if (as === 'admin') return res.status(403).json({ error: 'Admins can read but not post here.' });
    const text = txt(req.body?.text, 4000);
    if (!text) return res.status(400).json({ error: 'Write a message.' });
    const { data, error } = await supabase.from('hire_messages').insert([{ hire_id: h.id, from_id: req.user.id, text }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('hire_requests').update({ updated_at: new Date().toISOString() }).eq('id', h.id);
    await escrow.notify(as === 'client' ? h.support_id : h.client_id, { type: 'hire_message', title: '💬 New message on a hire', message: `${fullName(u)}: ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`, link: `/hire?id=${h.id}` });
    res.status(201).json(data);
  });

  const step = async (req, res, fn) => { try { const r = await load(req); if (!r.h) return fail(res); await fn(r); } catch (e) { res.status(500).json({ error: e.message }); } };
  const upd = async (id, patch, from) => { const { data } = await supabase.from('hire_requests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).in('status', from).select(); return data && data[0]; };

  app.post('/api/hire/:id/quote', authMiddleware, (req, res) => step(req, res, async ({ h, as, u }) => {
    if (as !== 'pro') return res.status(403).json({ error: 'Only the professional sends a quote.' });
    const amount = round2(req.body?.amount), days = parseInt(req.body?.days, 10), scope = txt(req.body?.scope, 2000);
    if (!(amount >= 1 && amount <= 100000)) return res.status(400).json({ error: 'Enter your fee in USD (1 to 100,000).' });
    if (!(days >= 1 && days <= 365)) return res.status(400).json({ error: 'Enter how many days you need (1 to 365).' });
    if (scope.length < 15) return res.status(400).json({ error: 'Describe what the fee includes.' });
    const revised = h.status === 'quoted';
    const row = await upd(h.id, { status: 'quoted', quote_amount: amount, quote_days: days, quote_scope: scope, quoted_at: new Date().toISOString() }, ['pending', 'accepted', 'quoted']);
    if (!row) return res.status(400).json({ error: 'A quote can only be sent before payment.' });
    await c.log(h.id, `${revised ? 'Quote revised' : 'Quote sent'}: ${escrow.money(amount)}, within ${days} days.`);
    await escrow.notify(h.client_id, { type: 'hire_quote', title: revised ? '📝 Quote revised' : '📝 You received a quote', message: `${fullName(u)} quoted ${escrow.money(amount)} for "${h.title}".`, link: `/hire?id=${h.id}` });
    await escrow.emailUser(h.client_id, `Quote for "${h.title}"`, 'You received a quote', `<strong style="color:#f0ede8;">${escrow.esc(fullName(u))}</strong> quoted <strong style="color:#f5c842;">${escrow.money(amount)}</strong> to complete <strong>"${escrow.esc(h.title)}"</strong> within ${days} days.<br><br>Accept to pay into IdeaHub escrow. The professional is paid only after you confirm the work.`, 'Review quote', `/hire?id=${h.id}`);
    res.json(row);
  }));
  const doDecline = async ({ h, as, u }, req, res) => {
    if (as !== 'pro') return res.status(403).json({ error: 'Not allowed.' });
    const reason = txt(req.body?.reason, 600);
    const row = await upd(h.id, { status: 'rejected', cancel_reason: reason || null }, ['pending', 'accepted', 'quoted']);
    if (!row) return res.status(400).json({ error: 'This request can no longer be declined.' });
    await c.log(h.id, `${fullName(u)} declined.${reason ? ' ' + reason : ''}`);
    await escrow.notify(h.client_id, { type: 'hire_declined', title: 'Request declined', message: `"${h.title}" was declined.${reason ? ' ' + reason : ''} Try another professional on Find Support.`, link: '/find-support' });
    res.json(row);
  };
  app.post('/api/hire/:id/decline', authMiddleware, (req, res) => step(req, res, r => doDecline(r, req, res)));
  const doCancel = async ({ h, as, u }, req, res) => {
    if (as !== 'client') return res.status(403).json({ error: 'Not allowed.' });
    const row = await upd(h.id, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: txt(req.body?.reason, 600) || null }, ['pending', 'accepted', 'quoted']);
    if (!row) return res.status(400).json({ error: 'After paying, use "Report a problem" instead.' });
    await c.log(h.id, `${fullName(u)} cancelled the request.`);
    await escrow.notify(h.support_id, { type: 'hire_cancelled', title: 'Request cancelled', message: `The client cancelled "${h.title}".`, link: `/hire?id=${h.id}` });
    await c.refreshStats(h.support_id);
    res.json(row);
  };
  app.post('/api/hire/:id/cancel', authMiddleware, (req, res) => step(req, res, r => doCancel(r, req, res)));
  // Old status endpoint: only the safe transitions remain
  app.put('/api/hire/:id/status', authMiddleware, (req, res) => step(req, res, async r => {
    const st = req.body?.status;
    if (r.as === 'pro' && st === 'rejected') return doDecline(r, req, res);
    if (r.as === 'client' && st === 'cancelled') return doCancel(r, req, res);
    if (r.as === 'pro' && st === 'accepted') return res.json(r.h); // sending a quote is the real acceptance
    res.status(400).json({ error: 'Use the hire page to quote, pay, deliver or confirm.' });
  }));
  app.post('/api/hire/:id/pay', authMiddleware, (req, res) => step(req, res, async ({ h, as }) => {
    if (as !== 'client') return res.status(403).json({ error: 'Only the client pays.' });
    if (h.status !== 'quoted') return res.status(400).json({ error: 'There is no quote to accept.' });
    if (Number(req.body?.expected_amount) !== Number(h.quote_amount)) return res.status(409).json({ error: 'The quote was just changed. Refresh to see it.' });
    if (!c.payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon. Message the professional in the meantime.', code: 'payments_closed' });
    const amount = round2(h.quote_amount), fee = round2(amount * FEE_RATE), total = round2(amount + fee), now = new Date().toISOString();
    const { data: rows } = await supabase.from('hire_requests').update({ status: 'in_progress', amount, fee, total, paid_at: now, updated_at: now }).eq('id', h.id).eq('status', 'quoted').eq('quote_amount', h.quote_amount).select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'The quote changed. Refresh and try again.' });
    const charge = await c.payments.chargeService({ userId: req.user.id, amount: total, meta: { hire_id: h.id } });
    if (!charge.ok) { await upd(h.id, { status: 'quoted', amount: null, fee: null, total: null, paid_at: null }, ['in_progress']); return res.status(402).json({ error: charge.error || 'Payment failed.' }); }
    await c.log(h.id, `Quote accepted. ${escrow.money(total)} is held in escrow.`);
    await escrow.notify(h.support_id, { type: 'hire_paid', title: '💰 Client paid into escrow', message: `"${h.title}" is paid (${escrow.money(amount)}). Start work and mark it delivered when done.`, link: `/hire?id=${h.id}` });
    await escrow.emailUser(h.support_id, `Paid: "${h.title}"`, 'Your client paid into escrow', `${escrow.money(amount)} for <strong>"${escrow.esc(h.title)}"</strong> is held in escrow. Complete the work within ${Number(h.quote_days)} days and mark it delivered.`, 'Open job', `/hire?id=${h.id}`);
    res.json(rows[0]);
  }));
  app.post('/api/hire/:id/deliver', authMiddleware, (req, res) => step(req, res, async ({ h, as, u }) => {
    if (as !== 'pro') return res.status(403).json({ error: 'Only the professional marks work delivered.' });
    const note = txt(req.body?.note, 1500);
    const row = await upd(h.id, { status: 'delivered', delivered_at: new Date().toISOString(), delivery_note: note || null, client_reminded: false }, ['in_progress']);
    if (!row) return res.status(400).json({ error: 'Only paid work in progress can be delivered.' });
    await c.log(h.id, `${fullName(u)} marked the work delivered.${note ? ' ' + note : ''}`);
    await escrow.notify(h.client_id, { type: 'hire_delivered', title: '📦 Work delivered', message: `"${h.title}" was delivered. Confirm or report a problem within ${AUTO_RELEASE_DAYS} days.`, link: `/hire?id=${h.id}` });
    await escrow.emailUser(h.client_id, `"${h.title}" was delivered`, 'Your professional delivered', `Check the work for <strong>"${escrow.esc(h.title)}"</strong>.${note ? '<br><br>' + escrow.esc(note) : ''}<br><br>Confirm to release the payment, or report a problem. If you do nothing, it is released automatically in ${AUTO_RELEASE_DAYS} days.`, 'Review', `/hire?id=${h.id}`);
    res.json(row);
  }));
  app.post('/api/hire/:id/confirm', authMiddleware, (req, res) => step(req, res, async ({ h, as }) => {
    if (as !== 'client') return res.status(403).json({ error: 'Only the client confirms.' });
    const done = await c.release(h.id, 'client');
    if (!done) return res.status(400).json({ error: 'This work is not waiting for confirmation.' });
    res.json(done);
  }));
  app.post('/api/hire/:id/dispute', authMiddleware, (req, res) => step(req, res, async ({ h, as, u }) => {
    if (as !== 'client') return res.status(403).json({ error: 'Only the client can report a problem.' });
    const reason = txt(req.body?.reason, 1500);
    if (reason.length < 15) return res.status(400).json({ error: 'Explain the problem (at least 15 characters).' });
    const row = await upd(h.id, { status: 'disputed', dispute_reason: reason, disputed_at: new Date().toISOString() }, ['in_progress', 'delivered']);
    if (!row) return res.status(400).json({ error: 'A problem can only be reported after paying and before completion.' });
    await c.log(h.id, `${fullName(u)} reported a problem: ${reason}`);
    await escrow.notify(h.support_id, { type: 'disputed', title: '⚠️ Client reported a problem', message: `"${h.title}" is on hold while IdeaHub reviews it.`, link: `/hire?id=${h.id}` });
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const ad of admins || []) await escrow.notify(ad.id, { type: 'disputed', title: '⚠️ Hire dispute', message: `"${h.title}" (${escrow.money(h.amount)}): ${reason.slice(0, 120)}`, link: '/admin' });
    res.json(row);
  }));

  // Review (client, once, after completion)
  const doRate = async ({ h, as }, req, res) => {
    if (as !== 'client') return res.status(403).json({ error: 'Only the client can leave a review.' });
    if (h.status !== 'completed') return res.status(400).json({ error: 'You can review once the work is completed.' });
    const stars = parseInt(req.body?.stars, 10), review = txt(req.body?.review, 1000);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
    const { data: ex } = await supabase.from('ratings').select('id').eq('hire_id', h.id).limit(1);
    if (ex && ex.length) return res.status(400).json({ error: 'You already reviewed this job.' });
    const { error } = await supabase.from('ratings').insert([{ hire_id: h.id, rated_user_id: h.support_id, rater_user_id: req.user.id, stars, review: review || null }]);
    if (error) return res.status(500).json({ error: error.message });
    await c.refreshStats(h.support_id);
    await escrow.notify(h.support_id, { type: 'new_rating', title: '⭐ New review', message: `A client rated you ${stars}/5 for "${h.title}".`, link: `/hire?id=${h.id}` });
    res.json({ ok: true });
  };
  app.post('/api/hire/:id/rate', authMiddleware, (req, res) => step(req, res, r => doRate(r, req, res)));
  // The old generic ratings endpoint now only accepts client reviews of completed hires
  app.post('/api/ratings', authMiddleware, (req, res) => { req.params.id = String(req.body?.hire_id || ''); return step(req, res, r => doRate(r, req, res)); });

  // Admin
  async function isAdmin(req) { const u = await me(req); return u?.role === 'admin'; }
  app.get('/api/admin/hires', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabase.from('hire_requests').select('id, title, status, budget, quote_amount, amount, total, created_at, client:client_id(first_name, last_name), support:support_id(first_name, last_name, role)').order('created_at', { ascending: false }).limit(300);
    res.json(data || []);
  });
  app.get('/api/admin/hire-disputes', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabase.from('hire_requests').select('*, client:client_id(first_name, last_name, email), support:support_id(first_name, last_name, email, role)').eq('status', 'disputed').order('disputed_at', { ascending: true });
    res.json(data || []);
  });
  app.put('/api/admin/hire/:id/resolve', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { outcome, note } = req.body || {};
    try {
      const out = outcome === 'release' ? await c.release(parseInt(req.params.id, 10), 'admin', txt(note, 1000)) : outcome === 'refund' ? await c.refund(parseInt(req.params.id, 10), txt(note, 1000)) : undefined;
      if (out === undefined) return res.status(400).json({ error: "outcome must be 'release' or 'refund'" });
      if (!out) return res.status(400).json({ error: 'Not open for a decision.' });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return c;
}

module.exports = { mount, core, STATUS_LABEL, ROLE_LABEL };
