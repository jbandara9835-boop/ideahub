// ─────────────────────────────────────────────────────────────────────────────
// licences.js — patent licence deals through IdeaHub, and patent listing details
//
// Outright patent SALES are not handled by IdeaHub: patent listings have no Buy
// button or escrow. Buyers enquire, and are pointed to registered practitioners and
// accountants for due diligence and the transfer, which happens between the parties.
//
// LICENCES run on IdeaHub:
//   requested    → the licensee asks (type, territory, field of use, term, message)
//   negotiating  → the owner accepts to talk; both message, call, upload drafts. A
//                  practitioner (hired by either side) drafts the agreement. IdeaHub
//                  never drafts or decides the terms or the licence fee.
//   signed       → one side uploads the final signed agreement; BOTH confirm that file
//   active       → IdeaHub's fixed licence fee is paid; the licence is recorded here
//                  with its dates, reminders before it ends; an exclusive licence
//                  blocks new requests for the same patent
//   ended | declined | cancelled
// Money between the parties (upfront fees, royalties) follows their agreement and is
// paid outside IdeaHub.
//
// Railway variables:
//   LICENCE_FEE_USD    IdeaHub's fixed fee per licence (default 49)
//   LICENCE_FEE_PAYER  licensee | licensor | split (default licensee)
//
// server.js:  const licences = require('./licences');
//             licences.mount(app, { supabase, authMiddleware, escrow });
//             licences.cleanPatentListing(req.body) when saving an idea with a patent
// bots.js:    require('./licences').core(supabase, escrow).runBot()
// ─────────────────────────────────────────────────────────────────────────────
const BUCKET = 'patent-files';
const DAY = 86400000;
const TYPES = { exclusive: 'Exclusive licence', sole: 'Sole licence', non_exclusive: 'Non-exclusive licence' };
const TYPE_HELP = {
  exclusive: 'Only the licensee may use the patent in the agreed territory and field, not even the owner.',
  sole: 'The licensee and the owner may use it, but the owner will not license anyone else.',
  non_exclusive: 'The owner may license the same rights to others too.'
};
const STATUS_LABEL = { requested: 'Requested', negotiating: 'Negotiating', signed: 'Signed, fee due', active: 'Active', ended: 'Ended', declined: 'Declined', cancelled: 'Cancelled' };
const OPEN = ['requested', 'negotiating', 'signed'];

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const niceDate = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

function feeConfig() {
  const amount = Math.max(0, Math.round(Number(process.env.LICENCE_FEE_USD || 49) * 100) / 100);
  const payer = ['licensee', 'licensor', 'split'].includes(process.env.LICENCE_FEE_PAYER) ? process.env.LICENCE_FEE_PAYER : 'licensee';
  return { amount, payer };
}

// Patent facts shown on a patent listing (buyers' first due-diligence checks). Public.
function cleanPatentListing(b) {
  const d = b.patentDetails || {}, o = b.patentOffer || {};
  const date = v => isDate(String(v || '')) ? String(v) : null;
  const types = (Array.isArray(o.licence_types) ? o.licence_types : []).filter(t => TYPES[t]);
  const offer = { sale: o.sale === true, licence: o.licence === true && types.length > 0, licence_types: types, licence_notes: txt(o.licence_notes, 600) };
  if (!offer.sale && !offer.licence) offer.sale = true; // a patent listing is at least open to enquiries
  return {
    patent_details: {
      status: d.status === 'granted' ? 'granted' : 'pending',
      filing_date: date(d.filing_date), grant_date: date(d.grant_date), expiry_date: date(d.expiry_date),
      fees_paid_until: date(d.fees_paid_until),
      co_owners: txt(d.co_owners, 300), existing_licences: txt(d.existing_licences, 600),
      family: txt(d.family, 300) // same invention filed elsewhere, e.g. "US 11,234,567; PCT/LK2024/000123"
    },
    patent_offer: offer
  };
}

function core(supabase, escrow) {
  const payments = require('./payments')(supabase);
  async function log(dealId, fromId, text) {
    await supabase.from('licence_messages').insert([{ deal_id: dealId, from_id: fromId || null, text, system: !fromId }]);
  }
  // Daily: end licences that passed their end date, remind before the end, nudge unanswered requests
  async function runBot() {
    const today = new Date().toISOString().slice(0, 10);
    let ended = 0, reminders = 0;
    const { data: act } = await supabase.from('licence_deals').select('*').eq('status', 'active');
    for (const d of act || []) {
      if (!d.end_date) continue;
      const left = Math.round((new Date(d.end_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / DAY);
      if (left < 0) {
        const { data: rows } = await supabase.from('licence_deals').update({ status: 'ended', updated_at: new Date().toISOString() }).eq('id', d.id).eq('status', 'active').select('id');
        if (rows && rows.length) {
          ended++;
          await log(d.id, null, `The licence ended on ${niceDate(d.end_date)}.`);
          for (const uid of [d.licensor_id, d.licensee_id]) await escrow.notify(uid, { type: 'licence_ended', title: 'Licence ended', message: `The licence for "${d.idea_title}" ended on ${niceDate(d.end_date)}.`, link: `/licence?id=${d.id}` });
        }
        continue;
      }
      const sent = Array.isArray(d.reminders) ? d.reminders : [];
      const due = [90, 30, 7].filter(t => left <= t && !sent.includes(t));
      if (!due.length) continue;
      for (const uid of [d.licensor_id, d.licensee_id]) {
        await escrow.notify(uid, { type: 'licence_ending', title: '📅 Licence ending soon', message: `The licence for "${d.idea_title}" ends in ${left} day${left === 1 ? '' : 's'} (${niceDate(d.end_date)}). Talk about renewing it in good time.`, link: `/licence?id=${d.id}` });
        if (Math.min(...due) <= 30) await escrow.emailUser(uid, `Licence ending ${niceDate(d.end_date)}`, 'A licence is ending soon',
          `The licence for <strong>"${escrow.esc(d.idea_title)}"</strong> ends on <strong>${escrow.esc(niceDate(d.end_date))}</strong>. If you want to renew, agree new terms with the other side and register the new agreement on IdeaHub.`, 'Open licence', `/licence?id=${d.id}`);
      }
      await supabase.from('licence_deals').update({ reminders: [...new Set([...sent, ...due])] }).eq('id', d.id);
      reminders++;
    }
    const { data: req } = await supabase.from('licence_deals').select('id, licensor_id, idea_title, created_at, nudged').eq('status', 'requested');
    for (const d of req || []) {
      if (!d.nudged && Date.now() - new Date(d.created_at).getTime() > 3 * DAY) {
        await escrow.notify(d.licensor_id, { type: 'licence_request', title: '⏳ A licence request is waiting', message: `Someone asked to license "${d.idea_title}" 3 days ago. Accept to discuss terms, or decline.`, link: `/licence?id=${d.id}` });
        await supabase.from('licence_deals').update({ nudged: true }).eq('id', d.id);
        reminders++;
      }
    }
    return `Licences: ${ended} ended, ${reminders} reminder${reminders === 1 ? '' : 's'}`;
  }
  return { log, runBot, payments };
}

function mount(app, { supabase, authMiddleware, escrow }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const c = core(supabase, escrow);

  async function me(req) { const { data } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', req.user.id).single(); return data; }
  async function load(req) {
    const id = parseInt(req.params.id, 10);
    if (!id) return { status: 404 };
    const { data: d } = await supabase.from('licence_deals').select('*').eq('id', id).single();
    if (!d) return { status: 404 };
    const u = await me(req);
    const as = d.licensor_id === req.user.id ? 'licensor' : d.licensee_id === req.user.id ? 'licensee' : u?.role === 'admin' ? 'admin' : null;
    if (!as) return { status: 404 };
    return { d, as, u };
  }
  const fail = (res, r) => res.status(r.status || 404).json({ error: 'Not found.' });
  const other = (r) => r.as === 'licensor' ? r.d.licensee_id : r.d.licensor_id;
  async function activeExclusive(ideaId, excludeId) {
    const { data } = await supabase.from('licence_deals').select('id, licence_type, territory, field_of_use').eq('idea_id', ideaId).eq('status', 'active').eq('licence_type', 'exclusive');
    return (data || []).filter(x => x.id !== excludeId);
  }

  app.get('/api/licences/config', (req, res) => res.json({ ...feeConfig(), types: TYPES, type_help: TYPE_HELP }));

  // Public: active licences on a patent listing (no parties or terms, just the fact)
  app.get('/api/ideas/:id/licences', async (req, res) => {
    const { data } = await supabase.from('licence_deals').select('licence_type, territory, field_of_use, start_date, end_date').eq('idea_id', parseInt(req.params.id, 10)).eq('status', 'active');
    res.json((data || []).map(x => ({ ...x, type_label: TYPES[x.licence_type] || x.licence_type })));
  });

  // Licensee: request a licence on a patent listing
  app.post('/api/licences', authMiddleware, async (req, res) => {
    const b = req.body || {};
    const ideaId = parseInt(b.idea_id, 10);
    const { data: idea } = await supabase.from('ideas').select('id, title, creator_id, status, has_patent, patent_offer').eq('id', ideaId).single();
    if (!idea || idea.status !== 'live' || !idea.has_patent) return res.status(404).json({ error: 'This patent is not available.' });
    if (idea.creator_id === req.user.id) return res.status(400).json({ error: 'You cannot license your own patent.' });
    const offer = idea.patent_offer || {};
    if (!offer.licence) return res.status(400).json({ error: 'The owner is not offering licences for this patent. Send them a message instead.' });
    const type = String(b.licence_type || '');
    if (!TYPES[type] || !(offer.licence_types || []).includes(type)) return res.status(400).json({ error: 'Choose one of the licence types the owner offers.' });
    const territory = txt(b.territory, 200), field = txt(b.field_of_use, 200), term = txt(b.term, 120), message = txt(b.message, 2000);
    if (territory.length < 2) return res.status(400).json({ error: 'Say where you want to use it (territory).' });
    if (message.length < 20) return res.status(400).json({ error: 'Tell the owner who you are and how you plan to use it (at least 20 characters).' });
    if (type === 'exclusive' && (await activeExclusive(idea.id)).length) return res.status(400).json({ error: 'This patent already has an active exclusive licence. Ask the owner what is still possible.' });
    const { data: dup } = await supabase.from('licence_deals').select('id').eq('idea_id', idea.id).eq('licensee_id', req.user.id).in('status', OPEN);
    if (dup && dup.length) return res.status(400).json({ error: 'You already have an open licence request for this patent.', id: dup[0].id });
    const fee = feeConfig();
    const { data: d, error } = await supabase.from('licence_deals').insert([{
      idea_id: idea.id, idea_title: idea.title, licensor_id: idea.creator_id, licensee_id: req.user.id, status: 'requested',
      licence_type: type, territory, field_of_use: field || null, term: term || null, request_message: message,
      fee_amount: fee.amount, fee_payer: fee.payer, files: []
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const u = await me(req);
    await c.log(d.id, null, `${fullName(u)} requested a ${TYPES[type].toLowerCase()} (${territory}${field ? ', ' + field : ''}${term ? ', ' + term : ''}).`);
    await supabase.from('licence_messages').insert([{ deal_id: d.id, from_id: req.user.id, text: message }]);
    await escrow.notify(idea.creator_id, { type: 'licence_request', title: '📜 New licence request', message: `${fullName(u)} wants a ${TYPES[type].toLowerCase()} for "${idea.title}" (${territory}).`, link: `/licence?id=${d.id}` });
    await escrow.emailUser(idea.creator_id, `Licence request for "${idea.title}"`, 'Someone wants to license your patent',
      `<strong style="color:#f0ede8;">${escrow.esc(fullName(u))}</strong> asked for a <strong>${escrow.esc(TYPES[type].toLowerCase())}</strong> for <strong>"${escrow.esc(idea.title)}"</strong> in ${escrow.esc(territory)}.<br><br>Accept to start discussing terms, or decline.`, 'Review request', `/licence?id=${d.id}`);
    res.status(201).json(d);
  });

  // My deals
  app.get('/api/licences', authMiddleware, async (req, res) => {
    const cols = 'id, idea_id, idea_title, status, licence_type, territory, start_date, end_date, licensor_id, licensee_id, created_at, updated_at';
    const [{ data: a }, { data: b }] = await Promise.all([
      supabase.from('licence_deals').select(cols).eq('licensor_id', req.user.id).order('created_at', { ascending: false }),
      supabase.from('licence_deals').select(cols).eq('licensee_id', req.user.id).order('created_at', { ascending: false })
    ]);
    const ids = [...new Set([...(a || []).map(x => x.licensee_id), ...(b || []).map(x => x.licensor_id)])];
    const { data: users } = ids.length ? await supabase.from('users').select('id, first_name, last_name').in('id', ids) : { data: [] };
    const nm = Object.fromEntries((users || []).map(u => [u.id, fullName(u)]));
    const shape = (x, o) => ({ ...x, type_label: TYPES[x.licence_type], status_label: STATUS_LABEL[x.status], other_name: nm[o] || '' });
    res.json({ granted: (a || []).map(x => shape(x, x.licensee_id)), taken: (b || []).map(x => shape(x, x.licensor_id)) });
  });

  app.get('/api/licences/:id', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    const { d, as } = r;
    const [{ data: people }, { data: msgs }, { data: idea }] = await Promise.all([
      supabase.from('users').select('id, first_name, last_name, avatar_url, email').in('id', [d.licensor_id, d.licensee_id]),
      supabase.from('licence_messages').select('*').eq('deal_id', d.id).order('created_at', { ascending: true }).limit(500),
      supabase.from('ideas').select('id, title, patent_number, patent_jurisdiction, patent_details, patent_offer').eq('id', d.idea_id).single()
    ]);
    const p = Object.fromEntries((people || []).map(u => [u.id, u]));
    const person = id => p[id] ? { id, name: fullName(p[id]), avatar_url: p[id].avatar_url || null, ...(as === 'admin' ? { email: p[id].email } : {}) } : null;
    const fee = feeConfig();
    const payer = d.fee_payer || fee.payer;
    const myShare = d.fee_amount == null ? 0 : payer === 'split' ? Math.round(d.fee_amount / 2 * 100) / 100 : (payer === as ? Number(d.fee_amount) : 0);
    res.json({
      ...d, viewer: as, status_label: STATUS_LABEL[d.status], type_label: TYPES[d.licence_type], type_help: TYPE_HELP[d.licence_type],
      licensor: person(d.licensor_id), licensee: person(d.licensee_id), idea: idea || null,
      files: (d.files || []).map((f, i) => ({ index: i, name: f.name, size: f.size, at: f.at, uploaded_by: f.uploaded_by })),
      my_fee_share: myShare, fee_paid_by_me: as === 'licensor' ? !!d.fee_paid_licensor_at : as === 'licensee' ? !!d.fee_paid_licensee_at : false,
      payments_open: c.payments.purchasesOpen(),
      messages: (msgs || []).map(m => ({ id: m.id, from_id: m.from_id, text: m.text, system: !!m.system, created_at: m.created_at }))
    });
  });

  app.post('/api/licences/:id/messages', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Admins can read but not post here.' });
    const text = txt(req.body?.text, 4000);
    if (!text) return res.status(400).json({ error: 'Write a message.' });
    const { data, error } = await supabase.from('licence_messages').insert([{ deal_id: r.d.id, from_id: req.user.id, text }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('licence_deals').update({ updated_at: new Date().toISOString() }).eq('id', r.d.id);
    await escrow.notify(other(r), { type: 'licence_message', title: '💬 New message on a licence', message: `${fullName(r.u)}: ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`, link: `/licence?id=${r.d.id}` });
    res.status(201).json(data);
  });

  // Licensor: accept to negotiate, or decline
  app.post('/api/licences/:id/respond', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    if (r.as !== 'licensor') return res.status(403).json({ error: 'Only the patent owner can respond.' });
    const accept = req.body?.accept === true, reason = txt(req.body?.reason, 600);
    if (!accept && reason.length < 5) return res.status(400).json({ error: 'Tell them briefly why.' });
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('licence_deals').update(accept ? { status: 'negotiating', accepted_at: now, updated_at: now } : { status: 'declined', decline_reason: reason, updated_at: now }).eq('id', r.d.id).eq('status', 'requested').select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'This request was already answered.' });
    await c.log(r.d.id, null, accept ? `${fullName(r.u)} accepted to discuss terms.` : `${fullName(r.u)} declined: ${reason}`);
    await escrow.notify(r.d.licensee_id, accept
      ? { type: 'licence_accepted', title: '🤝 Licence request accepted', message: `The owner of "${r.d.idea_title}" wants to discuss terms. Agree them with a practitioner, then upload the signed agreement.`, link: `/licence?id=${r.d.id}` }
      : { type: 'licence_declined', title: 'Licence request declined', message: `"${r.d.idea_title}": ${reason}`, link: `/licence?id=${r.d.id}` });
    res.json(rows[0]);
  });

  // Either side: cancel before the licence is active
  app.post('/api/licences/:id/cancel', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Not allowed.' });
    const reason = txt(req.body?.reason, 600);
    const { data: rows } = await supabase.from('licence_deals').update({ status: 'cancelled', cancel_reason: reason || null, updated_at: new Date().toISOString() }).eq('id', r.d.id).in('status', OPEN).select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'This licence can no longer be cancelled here.' });
    await c.log(r.d.id, null, `${fullName(r.u)} withdrew from the deal.${reason ? ' ' + reason : ''}`);
    await escrow.notify(other(r), { type: 'licence_cancelled', title: 'Licence deal withdrawn', message: `${fullName(r.u)} withdrew from the licence deal for "${r.d.idea_title}".`, link: `/licence?id=${r.d.id}` });
    res.json(rows[0]);
  });

  // Upload drafts and the signed agreement (private)
  app.post('/api/licences/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Not allowed.' });
    if (!['negotiating', 'signed', 'active'].includes(r.d.status)) return res.status(400).json({ error: r.d.status === 'requested' ? 'Files can be shared once the owner accepts the request.' : 'This deal is closed.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file (up to 10 MB).' });
    if (!/^(application\/pdf|image\/(png|jpe?g|webp)|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)|text\/plain)$/.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload a PDF, Word document, image or text file.' });
    const files = Array.isArray(r.d.files) ? r.d.files : [];
    if (files.length >= 30) return res.status(400).json({ error: 'This deal already has 30 files.' });
    const safe = String(req.file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `licence-${r.d.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const entry = { path, name: safe, size: req.file.size, uploaded_by: req.user.id, at: new Date().toISOString() };
    await supabase.from('licence_deals').update({ files: [...files, entry], updated_at: entry.at }).eq('id', r.d.id);
    await c.log(r.d.id, null, `${fullName(r.u)} added a file: ${safe}`);
    res.status(201).json({ index: files.length, ...entry, path: undefined });
  });
  app.get('/api/licences/:id/files/:index', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    const f = (r.d.files || [])[parseInt(req.params.index, 10)];
    if (!f) return res.status(404).json({ error: 'File not found.' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.path, 300, { download: f.name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
  });

  // Each side confirms which uploaded file is the final signed agreement, plus the key dates.
  // When both point at the same file, the deal is signed and IdeaHub's fee becomes due.
  app.post('/api/licences/:id/confirm-signed', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Not allowed.' });
    if (r.d.status !== 'negotiating') return res.status(400).json({ error: 'This deal is not waiting for a signed agreement.' });
    const idx = parseInt(req.body?.file_index, 10);
    if (!(r.d.files || [])[idx]) return res.status(400).json({ error: 'Choose the uploaded signed agreement.' });
    const start = txt(req.body?.start_date, 10), end = txt(req.body?.end_date, 10);
    if (!isDate(start)) return res.status(400).json({ error: 'Enter the date the licence starts.' });
    if (end && (!isDate(end) || end <= start)) return res.status(400).json({ error: 'The end date must be after the start date.' });
    if (r.d.licence_type === 'exclusive' && (await activeExclusive(r.d.idea_id, r.d.id)).length) return res.status(400).json({ error: 'This patent already has an active exclusive licence.' });
    const now = new Date().toISOString();
    const mine = r.as === 'licensor' ? { licensor_confirmed_at: now, licensor_file: idx } : { licensee_confirmed_at: now, licensee_file: idx };
    const agreed = { start_date: start, end_date: end || null };
    // If the other side confirmed different dates or file, their confirmation is reset
    const otherFile = r.as === 'licensor' ? r.d.licensee_file : r.d.licensor_file;
    const otherAt = r.as === 'licensor' ? r.d.licensee_confirmed_at : r.d.licensor_confirmed_at;
    const sameTerms = otherAt && otherFile === idx && r.d.start_date === start && (r.d.end_date || null) === (end || null);
    const reset = !sameTerms && otherAt ? (r.as === 'licensor' ? { licensee_confirmed_at: null, licensee_file: null } : { licensor_confirmed_at: null, licensor_file: null }) : {};
    const both = !!sameTerms;
    const fee = Number(r.d.fee_amount || 0);
    const update = { ...mine, ...agreed, ...reset, updated_at: now, ...(both ? { status: fee > 0 ? 'signed' : 'active', signed_at: now, ...(fee > 0 ? {} : { activated_at: now }) } : {}) };
    const { data: rows } = await supabase.from('licence_deals').update(update).eq('id', r.d.id).eq('status', 'negotiating').select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'This deal changed. Refresh the page.' });
    const fname = r.d.files[idx].name;
    if (both) {
      await c.log(r.d.id, null, `Both sides confirmed "${fname}" as the signed agreement (from ${niceDate(start)}${end ? ' to ' + niceDate(end) : ''}).${fee > 0 ? ` IdeaHub's licence fee of ${escrow.money(fee)} is now due.` : ' The licence is active.'}`);
      for (const uid of [r.d.licensor_id, r.d.licensee_id]) await escrow.notify(uid, { type: 'licence_signed', title: '✍️ Licence agreement confirmed', message: `"${r.d.idea_title}": both sides confirmed the signed agreement.${fee > 0 ? ' Pay the IdeaHub licence fee to register it.' : ''}`, link: `/licence?id=${r.d.id}` });
    } else {
      await c.log(r.d.id, null, `${fullName(r.u)} confirmed "${fname}" as the signed agreement${otherAt ? ' (with different details, so the other side needs to confirm again)' : ''}. Waiting for the other side.`);
      await escrow.notify(other(r), { type: 'licence_confirm', title: '✍️ Please confirm the signed agreement', message: `${fullName(r.u)} marked "${fname}" as the signed licence agreement for "${r.d.idea_title}". Check it and confirm.`, link: `/licence?id=${r.d.id}` });
    }
    res.json(rows[0]);
  });

  // Pay IdeaHub's fixed licence fee (the payer's share). Activates the licence when fully paid.
  app.post('/api/licences/:id/pay-fee', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.d) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Not allowed.' });
    if (r.d.status !== 'signed') return res.status(400).json({ error: 'No fee is due on this licence.' });
    const payer = r.d.fee_payer || 'licensee';
    if (payer !== 'split' && payer !== r.as) return res.status(400).json({ error: `The ${payer} pays IdeaHub's fee for this licence.` });
    const col = r.as === 'licensor' ? 'fee_paid_licensor_at' : 'fee_paid_licensee_at';
    if (r.d[col]) return res.status(400).json({ error: 'You have already paid.' });
    if (!c.payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon.', code: 'payments_closed' });
    if (c.payments.provider() === 'paypal') return res.status(402).json({ error: 'PayPal checkout is not connected yet.' });
    const share = payer === 'split' ? Math.round(Number(r.d.fee_amount) / 2 * 100) / 100 : Number(r.d.fee_amount);
    const now = new Date().toISOString();
    const { data: paid } = await supabase.from('licence_deals').update({ [col]: now, updated_at: now }).eq('id', r.d.id).eq('status', 'signed').is(col, null).select();
    if (!paid || !paid.length) return res.status(409).json({ error: 'This changed. Refresh the page.' });
    await c.payments.record({ kind: 'fee', userId: req.user.id, amount: share, meta: { licence_deal_id: r.d.id, test: true } });
    const d = paid[0];
    const done = payer !== 'split' || (d.fee_paid_licensor_at && d.fee_paid_licensee_at);
    let out = d;
    if (done) {
      const { data: act } = await supabase.from('licence_deals').update({ status: 'active', activated_at: now }).eq('id', d.id).eq('status', 'signed').select();
      out = (act && act[0]) || d;
      await c.log(d.id, null, `IdeaHub's licence fee was paid. The licence is registered and active${d.end_date ? ' until ' + niceDate(d.end_date) : ''}.`);
      for (const uid of [d.licensor_id, d.licensee_id]) {
        await escrow.notify(uid, { type: 'licence_active', title: '✅ Licence registered', message: `The ${TYPES[d.licence_type].toLowerCase()} for "${d.idea_title}" is active from ${niceDate(d.start_date)}.`, link: `/licence?id=${d.id}` });
        await escrow.emailUser(uid, `Licence registered: "${d.idea_title}"`, 'Your licence is registered on IdeaHub',
          `The <strong>${escrow.esc(TYPES[d.licence_type].toLowerCase())}</strong> for <strong>"${escrow.esc(d.idea_title)}"</strong> (${escrow.esc(d.territory)}) is active from <strong>${escrow.esc(niceDate(d.start_date))}</strong>${d.end_date ? ` to <strong>${escrow.esc(niceDate(d.end_date))}</strong>` : ''}.<br><br>Payments between you follow your signed agreement. Ask your practitioner whether the licence should also be recorded with the patent office.`, 'Open licence', `/licence?id=${d.id}`);
      }
    } else {
      await c.log(d.id, null, `${fullName(r.u)} paid their half of IdeaHub's licence fee.`);
      await escrow.notify(other(r), { type: 'licence_fee', title: 'Your half of the licence fee is due', message: `The other side paid their half of IdeaHub's fee for "${d.idea_title}". Pay yours to register the licence.`, link: `/licence?id=${d.id}` });
    }
    res.json(out);
  });

  // Admin overview
  app.get('/api/admin/licences', authMiddleware, async (req, res) => {
    const u = await me(req); if (u?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabase.from('licence_deals').select('id, idea_title, status, licence_type, territory, fee_amount, start_date, end_date, created_at').order('created_at', { ascending: false }).limit(200);
    res.json(data || []);
  });

  return c;
}

module.exports = { mount, core, cleanPatentListing, feeConfig, TYPES, STATUS_LABEL };
