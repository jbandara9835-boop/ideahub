// ─────────────────────────────────────────────────────────────────────────────
// reqpay.js — paying for Idea Requests through IdeaHub (same escrow model as hires)
//
//   agreed      the investor selected a proposal. The price starts as the proposal's
//               price; the creator can confirm or revise price, days and scope until paid.
//   in_escrow   the investor pays the agreed price + 8% IdeaHub fee into escrow
//   delivered   the creator uploads the files / notes and marks it delivered
//   completed   the investor confirms, or 7 days pass → paid to the creator's wallet
//   disputed    the investor reports a problem → IdeaHub releases or refunds
//   refunded    IdeaHub refunded the investor
// Before paying, the investor can go back and choose a different proposal.
// Amounts come from the server, never from the browser.
//
// server.js:  require('./reqpay').mount(app, { supabase, authMiddleware, escrow })  (before the old request routes)
// bots.js:    escrow.releaseRequest → require('./reqpay').core(supabase, escrow).release(id, 'auto')
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const BUCKET = 'patent-files';
const DAY = 86400000;
const FEE_RATE = 0.08;
const AUTO_RELEASE_DAYS = 7;
const OPEN_STAGES = ['open', 'proposals_received', 'shortlisting', 'pitching'];
const PRIVATE = ['agreed_scope', 'delivery_note', 'dispute_reason', 'resolution_note', 'fee', 'total', 'release_type'];

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const round2 = n => Math.round(Number(n) * 100) / 100;
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';

function core(supabase, escrow) {
  const payments = require('./payments')(supabase);
  async function addEarnings(userId, amount) {
    const { data: u } = await supabase.from('users').select('earnings').eq('id', userId).single();
    await supabase.from('users').update({ earnings: round2(Number(u?.earnings || 0) + Number(amount || 0)) }).eq('id', userId);
  }
  async function upd(id, fields, from) {
    const { data } = await supabase.from('idea_requests').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).in('status', from).select();
    return data && data[0];
  }
  // Pay the creator. Only requests that were really paid (paid_at) put money in a wallet.
  async function release(id, type, note) {
    const now = new Date().toISOString();
    const fields = { status: 'completed', completed_at: now, release_type: type };
    if (type === 'admin') { fields.resolved_at = now; fields.resolution_note = note || null; }
    const r = await upd(id, fields, type === 'admin' ? ['in_escrow', 'delivered', 'disputed'] : ['delivered']);
    if (!r) return null;
    if (r.paid_at && r.escrow_amount) {
      await addEarnings(r.selected_creator_id, r.escrow_amount);
      await payments.record({ kind: 'release', userId: r.selected_creator_id, amount: r.escrow_amount, meta: { idea_request_id: r.id, release_type: type } });
      if (r.fee) await payments.record({ kind: 'fee', userId: null, amount: r.fee, meta: { idea_request_id: r.id } });
      await escrow.notify(r.selected_creator_id, { type: 'payment_released', title: '💰 Payment released', message: `${escrow.money(r.escrow_amount)} for "${r.title}" was added to your wallet.`, link: '/transactions' });
      await escrow.emailUser(r.selected_creator_id, `Payment released: ${escrow.money(r.escrow_amount)}`, 'You were paid', `${escrow.money(r.escrow_amount)} for <strong>"${escrow.esc(r.title)}"</strong> was added to your IdeaHub wallet.${note ? '<br><br>Note from IdeaHub: ' + escrow.esc(note) : ''}`, 'View wallet', '/transactions');
    } else {
      await escrow.notify(r.selected_creator_id, { type: 'completed', title: '✅ Request completed', message: `"${r.title}" was completed.`, link: `/request/${r.id}` });
    }
    await escrow.notify(r.investor_id, { type: 'completed', title: '✅ Request completed', message: type === 'auto' ? `"${r.title}" was completed automatically ${AUTO_RELEASE_DAYS} days after delivery.` : `"${r.title}" is complete.${note ? ' Note: ' + note : ''}`, link: `/request/${r.id}` });
    return r;
  }
  async function refund(id, note) {
    const now = new Date().toISOString();
    const r = await upd(id, { status: 'refunded', resolved_at: now, resolution_note: note || null }, ['in_escrow', 'delivered', 'disputed']);
    if (!r) return null;
    if (r.paid_at && r.total) await payments.record({ kind: 'refund', userId: r.investor_id, amount: r.total, meta: { idea_request_id: r.id, note: note || null } });
    for (const uid of [r.investor_id, r.selected_creator_id]) await escrow.notify(uid, { type: 'refunded', title: '↩️ Request refunded', message: `"${r.title}" was refunded to the investor.${note ? ' Note: ' + note : ''}`, link: `/request/${r.id}` });
    return r;
  }
  return { release, refund, payments, upd };
}

function mount(app, { supabase, authMiddleware, escrow }) {
  const c = core(supabase, escrow);
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const fail = res => res.status(404).json({ error: 'Request not found.' });

  async function viewerOf(req) {
    const t = req.headers.authorization?.split(' ')[1];
    if (!t) return null;
    try {
      const jwt = require('jsonwebtoken'); const d = jwt.verify(t, process.env.JWT_SECRET);
      if (!d?.id || d.purpose) return null;
      const { data } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', d.id).single();
      return data || null;
    } catch { return null; }
  }
  // Who is asking: the investor, the selected creator, an admin, or nobody special
  async function load(req) {
    const id = parseInt(req.params.id, 10); if (!id) return {};
    const { data: r } = await supabase.from('idea_requests').select('*').eq('id', id).single();
    if (!r) return {};
    const { data: u } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', req.user.id).single();
    const as = r.investor_id === req.user.id ? 'investor' : (r.selected_creator_id && r.selected_creator_id === req.user.id) ? 'creator' : u?.role === 'admin' ? 'admin' : null;
    return { r, as, u };
  }
  const step = async (req, res, fn) => { try { const x = await load(req); if (!x.r) return fail(res); if (!x.as) return res.status(403).json({ error: 'Only the investor and the selected creator can do this.' }); await fn(x); } catch (e) { res.status(500).json({ error: e.message }); } };
  async function files(id) {
    const { data } = await supabase.from('request_files').select('id, uploader_id, file_name, size, created_at').eq('request_id', id).order('created_at', { ascending: true });
    return data || [];
  }

  // ── One request: public fields for everyone, deal details for the two parties ──
  app.get('/api/requests/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10); if (!id) return fail(res);
    const { data: r } = await supabase.from('idea_requests').select('*').eq('id', id).single();
    if (!r) return fail(res);
    supabase.from('idea_requests').update({ view_count: (r.view_count || 0) + 1 }).eq('id', r.id).then(() => {}, () => {});
    const v = await viewerOf(req);
    const as = v ? (r.investor_id === v.id ? 'investor' : r.selected_creator_id === v.id ? 'creator' : v.role === 'admin' ? 'admin' : null) : null;
    if (!as) { const out = { ...r }; PRIVATE.forEach(k => delete out[k]); return res.json(out); }
    const price = Number(r.agreed_price || 0);
    res.json({ ...r, viewer: as, fee_rate: FEE_RATE, payments_open: c.payments.purchasesOpen(),
      price_quote: price ? { amount: price, fee: round2(price * FEE_RATE), total: round2(price + round2(price * FEE_RATE)) } : null,
      confirm_by: r.status === 'delivered' && r.delivered_at ? new Date(new Date(r.delivered_at).getTime() + AUTO_RELEASE_DAYS * DAY).toISOString() : null,
      files: await files(r.id) });
  });

  // Creator confirms or revises the price, delivery time and scope (only before payment)
  app.post('/api/requests/:id/terms', authMiddleware, (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'creator') return res.status(403).json({ error: 'Only the selected creator sets the final price.' });
    const amount = round2(req.body?.amount), days = parseInt(req.body?.days, 10), scope = txt(req.body?.scope, 2000);
    if (!(amount >= 1 && amount <= 1000000)) return res.status(400).json({ error: 'Enter a price between $1 and $1,000,000.' });
    if (!(days >= 1 && days <= 365)) return res.status(400).json({ error: 'Enter the delivery time in days (1 to 365).' });
    const row = await c.upd(r.id, { agreed_price: amount, agreed_days: days, agreed_scope: scope || null, terms_at: new Date().toISOString() }, ['agreed']);
    if (!row) return res.status(400).json({ error: 'The price can only change before the investor pays.' });
    await escrow.notify(r.investor_id, { type: 'request_terms', title: '📝 Final price confirmed', message: `The creator confirmed ${escrow.money(amount)} within ${days} days for "${r.title}". You can pay into escrow now.`, link: `/request/${r.id}` });
    res.json(row);
  }));

  // Investor pays the agreed price + fee into escrow
  app.post('/api/requests/:id/pay', authMiddleware, (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'investor') return res.status(403).json({ error: 'Only the investor pays.' });
    if (r.status !== 'agreed' || !r.selected_creator_id) return res.status(400).json({ error: 'Select a proposal before paying.' });
    if (!(Number(r.agreed_price) >= 1)) return res.status(400).json({ error: 'The creator hasn\'t confirmed a price yet.' });
    if (Number(req.body?.expected_amount) !== Number(r.agreed_price)) return res.status(409).json({ error: 'The price was just changed. Refresh to see it.' });
    if (!c.payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon. Message the creator in the meantime.', code: 'payments_closed' });
    const amount = round2(r.agreed_price), fee = round2(amount * FEE_RATE), total = round2(amount + fee), now = new Date().toISOString();
    const { data: rows } = await supabase.from('idea_requests').update({ status: 'in_escrow', escrow_amount: amount, fee, total, paid_at: now, escrow_locked_at: now, updated_at: now })
      .eq('id', r.id).eq('status', 'agreed').eq('agreed_price', r.agreed_price).select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'The price changed. Refresh and try again.' });
    const charge = await c.payments.chargeService({ userId: req.user.id, amount: total, meta: { idea_request_id: r.id } });
    if (!charge.ok) { await c.upd(r.id, { status: 'agreed', escrow_amount: null, fee: null, total: null, paid_at: null, escrow_locked_at: null }, ['in_escrow']); return res.status(402).json({ error: charge.error || 'Payment failed.' }); }
    const due = new Date(Date.now() + Number(r.agreed_days || 7) * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    await escrow.notify(r.selected_creator_id, { type: 'escrow_locked', title: '🔒 Investor paid into escrow', message: `${escrow.money(amount)} for "${r.title}" is held in escrow. Deliver by ${due}.`, link: `/request/${r.id}` });
    await escrow.emailUser(r.selected_creator_id, `Paid: "${r.title}"`, 'The investor paid into escrow', `${escrow.money(amount)} for <strong>"${escrow.esc(r.title)}"</strong> is held in escrow. Upload your work on the request page and mark it delivered by <strong>${due}</strong>.`, 'Open request', `/request/${r.id}`);
    res.json(rows[0]);
  }));

  // Investor changes their mind before paying: back to choosing
  app.post('/api/requests/:id/reselect', authMiddleware, (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'investor') return res.status(403).json({ error: 'Only the investor can do this.' });
    const creator = r.selected_creator_id, pid = r.selected_proposal_id;
    const row = await c.upd(r.id, { status: 'shortlisting', selected_creator_id: null, selected_proposal_id: null, agreed_price: null, agreed_days: null, agreed_scope: null, terms_at: null }, ['agreed']);
    if (!row) return res.status(400).json({ error: 'You can only change your choice before paying.' });
    if (pid) await supabase.from('idea_proposals').update({ status: 'shortlisted', updated_at: new Date().toISOString() }).eq('id', pid);
    if (creator) await escrow.notify(creator, { type: 'proposal_unselected', title: 'Selection changed', message: `The investor is reconsidering proposals for "${r.title}".`, link: `/request/${r.id}` });
    res.json(row);
  }));

  // Files: the creator uploads the work; both parties can open them
  app.post('/api/requests/:id/files', authMiddleware, upload.single('file'), (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'creator') return res.status(403).json({ error: 'Only the selected creator uploads the work.' });
    if (!['in_escrow', 'delivered', 'disputed'].includes(r.status)) return res.status(400).json({ error: 'Upload your work once the investor has paid.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file.' });
    const { count } = await supabase.from('request_files').select('id', { count: 'exact', head: true }).eq('request_id', r.id);
    if ((count || 0) >= 20) return res.status(400).json({ error: 'Up to 20 files per request.' });
    const safe = String(req.file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `req-${r.id}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype || 'application/octet-stream', upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const { data, error } = await supabase.from('request_files').insert([{ request_id: r.id, uploader_id: req.user.id, file_path: path, file_name: safe, size: req.file.size }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ id: data.id, file_name: data.file_name, size: data.size, created_at: data.created_at });
  }));
  app.get('/api/requests/:id/files/:fid', authMiddleware, (req, res) => step(req, res, async ({ r }) => {
    const { data: f } = await supabase.from('request_files').select('file_path, file_name').eq('id', parseInt(req.params.fid, 10)).eq('request_id', r.id).single();
    if (!f) return fail(res);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.file_path, 300, { download: f.file_name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
  }));
  app.delete('/api/requests/:id/files/:fid', authMiddleware, (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'creator' || r.status !== 'in_escrow') return res.status(400).json({ error: 'Files can only be removed before delivery.' });
    await supabase.from('request_files').delete().eq('id', parseInt(req.params.fid, 10)).eq('request_id', r.id).eq('uploader_id', req.user.id);
    res.json({ ok: true });
  }));

  app.post('/api/requests/:id/deliver', authMiddleware, (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'creator') return res.status(403).json({ error: 'Only the selected creator can mark this delivered.' });
    const note = txt(req.body?.note, 2000);
    const n = (await files(r.id)).length;
    if (!n && note.length < 20) return res.status(400).json({ error: 'Upload your files, or describe what you delivered (at least 20 characters).' });
    const row = await c.upd(r.id, { status: 'delivered', delivered_at: new Date().toISOString(), delivery_note: note || null, buyer_reminders: 0 }, ['in_escrow']);
    if (!row) return res.status(400).json({ error: 'You can mark this delivered only after the investor has paid.' });
    await escrow.notify(r.investor_id, { type: 'delivered', title: '📦 Idea delivered', message: `The creator delivered "${r.title}". Confirm or report a problem within ${AUTO_RELEASE_DAYS} days.`, link: `/request/${r.id}` });
    await escrow.emailUser(r.investor_id, `"${r.title}" was delivered`, 'Your idea was delivered', `The creator delivered <strong>"${escrow.esc(r.title)}"</strong>${n ? ` (${n} file${n === 1 ? '' : 's'})` : ''}.${note ? '<br><br>' + escrow.esc(note) : ''}<br><br>Confirm to release the payment, or report a problem. If you do nothing, it is released automatically in ${AUTO_RELEASE_DAYS} days.`, 'Review delivery', `/request/${r.id}`);
    res.json(row);
  }));

  app.post('/api/requests/:id/confirm', authMiddleware, (req, res) => step(req, res, async ({ r, as }) => {
    if (as !== 'investor') return res.status(403).json({ error: 'Only the investor confirms.' });
    const done = await c.release(r.id, 'investor');
    if (!done) return res.status(400).json({ error: 'This request isn\'t waiting for confirmation.' });
    res.json(done);
  }));

  app.post('/api/requests/:id/dispute', authMiddleware, (req, res) => step(req, res, async ({ r, as, u }) => {
    if (as !== 'investor') return res.status(403).json({ error: 'Only the investor can report a problem.' });
    const reason = txt(req.body?.reason, 2000);
    if (reason.length < 15) return res.status(400).json({ error: 'Explain the problem (at least 15 characters).' });
    const row = await c.upd(r.id, { status: 'disputed', disputed_at: new Date().toISOString(), dispute_reason: reason }, ['in_escrow', 'delivered']);
    if (!row) return res.status(400).json({ error: 'A problem can only be reported after paying and before completion.' });
    await escrow.notify(r.selected_creator_id, { type: 'disputed', title: '⚠️ The investor reported a problem', message: `"${r.title}" is on hold while IdeaHub reviews it.`, link: `/request/${r.id}` });
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const ad of admins || []) await escrow.notify(ad.id, { type: 'disputed', title: '⚠️ Request dispute', message: `"${r.title}" (${escrow.money(r.escrow_amount)}): ${reason.slice(0, 120)}`, link: '/admin' });
    res.json(row);
  }));

  // ── Admin ──
  async function isAdmin(req) { const { data } = await supabase.from('users').select('role').eq('id', req.user.id).single(); return data?.role === 'admin'; }
  app.get('/api/admin/request-disputes', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabase.from('idea_requests').select('*, investor:investor_id(first_name, last_name, email), creator:selected_creator_id(first_name, last_name, email)').eq('status', 'disputed').order('disputed_at', { ascending: true });
    res.json(data || []);
  });
  app.put('/api/admin/requests/:id/resolve', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { outcome } = req.body || {}, note = txt(req.body?.note, 1000), id = parseInt(req.params.id, 10);
    try {
      const out = outcome === 'release' ? await c.release(id, 'admin', note) : outcome === 'refund' ? await c.refund(id, note) : undefined;
      if (out === undefined) return res.status(400).json({ error: "outcome must be 'release' or 'refund'" });
      if (!out) return res.status(400).json({ error: 'Not open for a decision.' });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { mount, core, FEE_RATE, OPEN_STAGES };
