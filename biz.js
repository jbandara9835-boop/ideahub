// ─────────────────────────────────────────────────────────────────────────────
// biz.js — Business Expansion: verified business listings and expansion applications
//
// LISTINGS  pending_review → active (admin checked the company registration) ⇄ paused → closed
//           rejected (admin, with a note; the owner fixes it and it goes back to review)
//   Each listing carries its company registration number and a certificate (private file).
//   Changing the business name or registration number of a live listing sends it back to review.
//   Listings created before this release stay live but show as "not yet verified".
//
// APPLICATIONS  pending → reviewed → shortlisted → meetup_scheduled → negotiating → agreed
//               rejected (owner) · withdrawn (investor). Owner moves it forward one step at a time.
//   One page per application (/expansion?id=) for both sides: details, status, messages, video call.
//
// ROUTES (public/expansion-routes.js): 5 groups × deal forms, offered ('offer') or sought ('seek').
//   Listings of fitting forms and opposite directions are matched; owners are told about new matches.
// CONFIDENTIAL listings (required when offering a business, stake or merger): the public sees an
//   anonymous summary. Interested parties sign a confidentiality agreement; once the owner approves,
//   they see the full listing and can apply. Either side can then open a deal room with advisers.
//
// IdeaHub connects the parties; no payment is taken here (connect-only for now).
// server.js:  require('./biz').mount(app, { supabase, authMiddleware, escrow })  (before the old routes)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const R = require('./public/expansion-routes');
const BUCKET = 'patent-files';
const TYPES = R.TYPES.map(t => t.key);
const TYPE_LABEL = Object.fromEntries(R.TYPES.map(t => [t.key, t.label]));
const MASKED_OUT = ['business_name', 'owner_name', 'city', 'website', 'description', 'requirements', 'founded_year', 'employees', 'locations', 'tagline', 'annual_revenue'];
const LISTING_LABEL = { pending_review: 'Under review', active: 'Live', paused: 'Paused', rejected: 'Needs changes', closed: 'Closed' };
const APP_LABEL = { pending: 'New', reviewed: 'Reviewed', shortlisted: 'Shortlisted', meetup_scheduled: 'Meetup scheduled', negotiating: 'Negotiating', agreed: 'Agreed', rejected: 'Not selected', withdrawn: 'Withdrawn' };
// What the owner may move an application to, from each status
const NEXT = {
  pending: ['reviewed', 'shortlisted', 'meetup_scheduled', 'rejected'],
  reviewed: ['shortlisted', 'meetup_scheduled', 'rejected'],
  shortlisted: ['meetup_scheduled', 'negotiating', 'rejected'],
  meetup_scheduled: ['meetup_scheduled', 'negotiating', 'rejected'],
  negotiating: ['meetup_scheduled', 'agreed', 'rejected'],
  accepted: ['meetup_scheduled', 'negotiating', 'rejected']
};
const CLOSED_APP = ['agreed', 'rejected', 'withdrawn'];
const PRIVATE_LISTING = ['reg_doc_path', 'reg_doc_name', 'review_note', 'reviewed_by', 'reg_number'];

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';

function mount(app, { supabase, authMiddleware, escrow }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const nf = res => res.status(404).json({ error: 'Not found.' });
  async function me(id) { const { data } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', id).single(); return data; }
  async function viewerId(req) {
    const t = req.headers.authorization?.split(' ')[1]; if (!t) return null;
    const d = await require('./security').viewer(req); return d ? d.id : null;
  }
  async function admins() { const { data } = await supabase.from('users').select('id').eq('role', 'admin'); return (data || []).map(a => a.id); }
  // What a visitor sees. Confidential listings are masked unless the viewer has access (owner, admin, approved NDA).
  function publicListing(b, access) {
    const o = { ...b, status_label: LISTING_LABEL[b.status] || b.status, has_document: !!b.reg_doc_path, direction: b.direction || 'offer', route: b.route || R.groupOf(b.expansion_types) };
    PRIVATE_LISTING.forEach(k => delete o[k]);
    if (b.confidential && !access) {
      MASKED_OUT.forEach(k => { o[k] = null; });
      o.details = R.teaserDetails(o.route, o.direction, b.details || {});
      o.masked = true;
    }
    o.title = o.masked ? b.teaser_title : b.business_name;
    return o;
  }
  async function ndaOf(listingId, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('business_ndas').select('id, status, signed_at, decided_at').eq('listing_id', listingId).eq('user_id', userId).limit(1);
    return data && data[0] ? data[0] : null;
  }
  async function approvedListingIds(userId) {
    if (!userId) return new Set();
    const { data } = await supabase.from('business_ndas').select('listing_id').eq('user_id', userId).eq('status', 'approved');
    return new Set((data || []).map(x => x.listing_id));
  }
  // Fitting live listings for a listing, best first
  async function matchesFor(b, viewerId) {
    const { data } = await supabase.from('business_listings').select('*').eq('status', 'active');
    const ok = await approvedListingIds(viewerId);
    return (data || []).map(x => ({ x, s: R.matchScore({ ...b, direction: b.direction || 'offer' }, { ...x, direction: x.direction || 'offer' }) }))
      .filter(m => m.s > 0).sort((p, q) => q.s - p.s).slice(0, 20)
      .map(m => ({ ...publicListing(m.x, m.x.owner_id === viewerId || ok.has(m.x.id)), match: m.s }));
  }
  async function recount(listingId) {
    const { data } = await supabase.from('expansion_applications').select('id, status').eq('listing_id', listingId);
    await supabase.from('business_listings').update({ application_count: (data || []).filter(a => a.status !== 'withdrawn').length }).eq('id', listingId);
  }

  // Validate the listing form. Returns { error } or { fields }
  function readListing(b, partial) {
    const f = {};
    const name = txt(b.business_name, 120), desc = txt(b.description, 5000);
    if (!partial || b.business_name !== undefined) { if (name.length < 2) return { error: 'Enter the business name.' }; f.business_name = name; }
    if (!partial || b.description !== undefined) { if (desc.length < 50) return { error: 'Describe the business in at least 50 characters.' }; f.description = desc; }
    if (!partial || b.industry !== undefined) { if (!txt(b.industry, 60)) return { error: 'Choose an industry.' }; f.industry = txt(b.industry, 60); }
    if (!partial || b.country !== undefined) { if (!txt(b.country, 60)) return { error: 'Choose the country.' }; f.country = txt(b.country, 60); }
    if (!partial || b.direction !== undefined) f.direction = b.direction === 'seek' ? 'seek' : 'offer';
    if (!partial || b.expansion_types !== undefined || b.route !== undefined) {
      const route = R.GROUP[b.route] ? b.route : R.groupOf(b.expansion_types);
      if (!route) return { error: 'Choose how you want to expand.' };
      const t = (Array.isArray(b.expansion_types) ? b.expansion_types : []).filter(x => R.BY_KEY[x] && R.BY_KEY[x].group === route);
      if (!t.length) return { error: 'Choose at least one deal type.' };
      f.route = route; f.expansion_types = [...new Set(t)];
    }
    if (!partial || b.reg_number !== undefined) { const r = txt(b.reg_number, 60); if (r.length < 3) return { error: 'Enter the company registration number.' }; f.reg_number = r; }
    if (!partial || b.reg_country !== undefined) f.reg_country = txt(b.reg_country || b.country, 60) || null;
    if (b.website !== undefined) { const w = txt(b.website, 200); if (w && !/^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(w)) return { error: 'The website must start with http:// or https://' }; f.website = w || null; }
    for (const k of ['tagline', 'city', 'annual_revenue', 'employees', 'requirements']) if (b[k] !== undefined) f[k] = txt(b[k], k === 'requirements' ? 3000 : 120) || null;
    if (b.founded_year !== undefined) { const y = parseInt(b.founded_year, 10); if (b.founded_year && !(y >= 1800 && y <= new Date().getFullYear())) return { error: 'Check the year founded.' }; f.founded_year = y || null; }
    if (b.locations !== undefined) f.locations = Math.max(1, Math.min(100000, parseInt(b.locations, 10) || 1));
    if (b.investment_min !== undefined) f.investment_min = num(b.investment_min);
    if (b.investment_max !== undefined) f.investment_max = num(b.investment_max);
    if (f.investment_min && f.investment_max && f.investment_min > f.investment_max) return { error: 'The minimum investment is higher than the maximum.' };
    if (b.details !== undefined || b.route !== undefined) {
      const d = R.cleanDetails(f.route || b.route, f.direction || b.direction, b.details || {});
      if (d.error) return { error: d.error }; f.details = d.value;
    }
    if (b.confidential !== undefined || b.teaser_title !== undefined || b.teaser !== undefined || f.expansion_types) {
      const must = R.mustBeConfidential(f.direction || b.direction, f.expansion_types || b.expansion_types);
      f.confidential = must || b.confidential === true || b.confidential === 'true';
      if (f.confidential) {
        const tt = txt(b.teaser_title, 120), tz = txt(b.teaser, 1500);
        if (tt.length < 8) return { error: must ? 'Selling a business or a stake is always confidential: add an anonymous headline (no business name).' : 'Add an anonymous headline for the public summary.' };
        if (tz.length < 50) return { error: 'Add an anonymous summary of at least 50 characters. Don\'t include the business name.' };
        f.teaser_title = tt; f.teaser = tz;
      } else { f.teaser_title = null; f.teaser = null; }
    }
    if (b.territories !== undefined) f.territories = (Array.isArray(b.territories) ? b.territories : String(b.territories || '').split(',')).map(x => txt(x, 60)).filter(Boolean).slice(0, 30);
    return { fields: f };
  }

  // ── Directory ──
  app.get('/api/businesses', async (req, res) => {
    let q = supabase.from('business_listings').select('*').eq('status', 'active');
    if (req.query.industry && req.query.industry !== 'all') q = q.eq('industry', String(req.query.industry));
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const uid = await viewerId(req), ok = await approvedListingIds(uid);
    let rows = (data || []).map(b => publicListing(b, b.owner_id === uid || ok.has(b.id)));
    if (R.GROUP[req.query.route]) rows = rows.filter(b => b.route === req.query.route);
    if (['offer', 'seek'].includes(req.query.direction)) rows = rows.filter(b => b.direction === req.query.direction);
    if (R.BY_KEY[req.query.type]) rows = rows.filter(b => (b.expansion_types || []).includes(req.query.type));
    res.json(rows.sort((a, b) => (b.is_verified ? 1 : 0) - (a.is_verified ? 1 : 0)));
  });

  app.get('/api/businesses/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10); if (!id) return nf(res);
    const { data: b } = await supabase.from('business_listings').select('*').eq('id', id).single();
    if (!b) return nf(res);
    const uid = await viewerId(req), u = uid ? await me(uid) : null;
    const viewer = uid && b.owner_id === uid ? 'owner' : u?.role === 'admin' ? 'admin' : null;
    if (b.status !== 'active' && !viewer) return nf(res);
    if (!viewer) supabase.from('business_listings').update({ view_count: (b.view_count || 0) + 1 }).eq('id', b.id).then(() => {}, () => {});
    let my_application = null, my_nda = null;
    if (uid && !viewer) {
      const { data: a } = await supabase.from('expansion_applications').select('id, status').eq('listing_id', b.id).eq('investor_id', uid).limit(1);
      if (a && a[0]) my_application = { ...a[0], status_label: APP_LABEL[a[0].status] || a[0].status };
      my_nda = await ndaOf(b.id, uid);
    }
    const access = !!viewer || my_nda?.status === 'approved';
    const out = viewer ? { ...b, ...publicListing(b, true), reg_number: b.reg_number, review_note: b.review_note, reg_doc_path: undefined } : publicListing(b, access);
    res.json({ ...out, viewer, my_application, my_nda, has_access: access, nda_text: b.confidential ? R.NDA_TEXT : undefined });
  });

  // ── Owner: create, edit, status, certificate ──
  app.post('/api/businesses', authMiddleware, async (req, res) => {
    const r = readListing(req.body || {}, false); if (r.error) return res.status(400).json({ error: r.error });
    const u = await me(req.user.id);
    const { data, error } = await supabase.from('business_listings').insert([{ details: {}, ...r.fields, owner_id: req.user.id, owner_name: fullName(u), status: 'pending_review', is_verified: false, application_count: 0, view_count: 0, submitted_at: new Date().toISOString() }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  async function ownListing(req, res) {
    const id = parseInt(req.params.id, 10);
    const { data: b } = id ? await supabase.from('business_listings').select('*').eq('id', id).single() : { data: null };
    if (!b) { nf(res); return null; }
    if (b.owner_id !== req.user.id) { res.status(403).json({ error: 'Only the owner can change this listing.' }); return null; }
    return b;
  }

  app.put('/api/businesses/:id', authMiddleware, async (req, res) => {
    const b = await ownListing(req, res); if (!b) return;
    if (b.status === 'closed') return res.status(400).json({ error: 'This listing is closed.' });
    // Fields not sent keep their current values (route, direction, deal types, details, confidentiality)
    const base = { route: b.route || R.groupOf(b.expansion_types), direction: b.direction || 'offer', expansion_types: b.expansion_types, details: b.details || {}, confidential: !!b.confidential, teaser_title: b.teaser_title, teaser: b.teaser };
    const r = readListing({ ...base, ...(req.body || {}) }, true); if (r.error) return res.status(400).json({ error: r.error });
    const f = r.fields;
    const identityChanged = (f.business_name && f.business_name !== b.business_name) || (f.reg_number && f.reg_number !== b.reg_number);
    if (b.status === 'rejected' || (identityChanged && ['active', 'paused'].includes(b.status))) Object.assign(f, { status: 'pending_review', is_verified: false, submitted_at: new Date().toISOString() });
    const { data, error } = await supabase.from('business_listings').update({ ...f, updated_at: new Date().toISOString() }).eq('id', b.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (f.status === 'pending_review' && b.reg_doc_path) for (const a of await admins()) await escrow.notify(a, { type: 'business_review', title: '🏢 Business listing to check', message: `"${data.business_name}" was ${b.status === 'rejected' ? 'resubmitted' : 'changed'} and needs review.`, link: '/admin' });
    res.json({ ...data, reg_doc_path: undefined, back_to_review: f.status === 'pending_review' });
  });

  app.post('/api/businesses/:id/status', authMiddleware, async (req, res) => {
    const b = await ownListing(req, res); if (!b) return;
    const to = req.body?.status;
    const ok = (to === 'paused' && b.status === 'active') || (to === 'active' && b.status === 'paused' && b.is_verified) || (to === 'closed' && b.status !== 'closed');
    if (!ok) return res.status(400).json({ error: to === 'active' && !b.is_verified ? 'The listing goes live once IdeaHub has checked it.' : 'That change isn\'t possible right now.' });
    const { data } = await supabase.from('business_listings').update({ status: to, updated_at: new Date().toISOString() }).eq('id', b.id).select().single();
    res.json({ ...data, reg_doc_path: undefined });
  });

  app.delete('/api/businesses/:id', authMiddleware, async (req, res) => {
    const b = await ownListing(req, res); if (!b) return;
    const { data: apps } = await supabase.from('expansion_applications').select('id').eq('listing_id', b.id).limit(1);
    if (apps && apps.length) { await supabase.from('business_listings').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', b.id); return res.json({ closed: true, message: 'Listing closed. It is kept because investors applied to it.' }); }
    await supabase.from('business_listings').delete().eq('id', b.id);
    res.json({ deleted: true });
  });

  app.post('/api/businesses/:id/document', authMiddleware, upload.single('file'), async (req, res) => {
    const b = await ownListing(req, res); if (!b) return;
    if (!req.file) return res.status(400).json({ error: 'Choose the certificate file.' });
    if (!/^(application\/pdf|image\/(png|jpe?g|webp))$/.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload a PDF or an image.' });
    const safe = String(req.file.originalname || 'certificate').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `biz-${b.id}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const f = { reg_doc_path: path, reg_doc_name: safe, updated_at: new Date().toISOString() };
    if (b.status === 'rejected' || b.is_verified) Object.assign(f, { status: 'pending_review', is_verified: false, submitted_at: new Date().toISOString() });
    await supabase.from('business_listings').update(f).eq('id', b.id);
    for (const a of await admins()) await escrow.notify(a, { type: 'business_review', title: '🏢 Business listing to check', message: `"${b.business_name}" (${b.country || ''}) uploaded its registration certificate.`, link: '/admin' });
    res.status(201).json({ ok: true, file_name: safe });
  });
  app.get('/api/businesses/:id/document', authMiddleware, async (req, res) => {
    const { data: b } = await supabase.from('business_listings').select('owner_id, reg_doc_path, reg_doc_name').eq('id', parseInt(req.params.id, 10)).single();
    const u = await me(req.user.id);
    if (!b || !b.reg_doc_path || (b.owner_id !== req.user.id && u?.role !== 'admin')) return nf(res);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(b.reg_doc_path, 300, { download: b.reg_doc_name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
  });

  app.get('/api/my-businesses', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('business_listings').select('*').eq('owner_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const ids = (data || []).map(b => b.id);
    const { data: nd } = ids.length ? await supabase.from('business_ndas').select('listing_id').in('listing_id', ids).eq('status', 'requested') : { data: [] };
    const pending = {}; (nd || []).forEach(n => { pending[n.listing_id] = (pending[n.listing_id] || 0) + 1; });
    res.json((data || []).map(b => ({ ...b, reg_doc_path: undefined, has_document: !!b.reg_doc_path, status_label: LISTING_LABEL[b.status] || b.status, nda_pending: pending[b.id] || 0, title: b.business_name })));
  });

  // ── Admin review ──
  app.get('/api/admin/businesses', authMiddleware, async (req, res) => {
    if ((await me(req.user.id))?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabase.from('business_listings').select('*, owner:owner_id(first_name, last_name, email, country)').order('updated_at', { ascending: false }).limit(300);
    res.json((data || []).map(b => ({ ...b, reg_doc_path: undefined, has_document: !!b.reg_doc_path, status_label: LISTING_LABEL[b.status] || b.status })));
  });
  app.put('/api/admin/businesses/:id/review', authMiddleware, async (req, res) => {
    if ((await me(req.user.id))?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const action = req.body?.action, note = txt(req.body?.note, 500), id = parseInt(req.params.id, 10);
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    if (action === 'reject' && !note) return res.status(400).json({ error: 'Give a reason. The owner will see it.' });
    const { data: b } = await supabase.from('business_listings').select('*').eq('id', id).single();
    if (!b) return nf(res);
    if (action === 'approve' && !b.reg_doc_path) return res.status(400).json({ error: 'The owner hasn\'t uploaded the registration certificate yet.' });
    const now = new Date().toISOString();
    const f = action === 'approve'
      ? { status: b.status === 'paused' ? 'paused' : 'active', is_verified: true, verified_at: now, review_note: null, reviewed_by: req.user.id, reviewed_at: now }
      : { status: 'rejected', is_verified: false, review_note: note, reviewed_by: req.user.id, reviewed_at: now };
    const firstApproval = action === 'approve' && !b.verified_at;
    const { data } = await supabase.from('business_listings').update(f).eq('id', id).select().single();
    if (firstApproval) {
      try {
        const ms = await matchesFor(data, b.owner_id);
        const strong = ms.filter(m => m.match >= 67).slice(0, 15);
        const { data: others } = strong.length ? await supabase.from('business_listings').select('id, owner_id').in('id', strong.map(m => m.id)) : { data: [] };
        const newTitle = data.confidential ? data.teaser_title : data.business_name;
        for (const o of others || []) await escrow.notify(o.owner_id, { type: 'business_match', title: '🎯 A business that fits yours', message: `"${newTitle}" (${R.typeLabel(data.expansion_types[0], data.direction)}) fits your listing.`, link: `/business/${data.id}` });
        if (ms.length) await escrow.notify(b.owner_id, { type: 'business_match', title: `🎯 ${ms.length} business${ms.length === 1 ? '' : 'es'} fit your listing`, message: 'See them on your listing page.', link: `/business/${data.id}#matches` });
      } catch (e) { console.error('Business matching failed:', e.message); }
    }
    await escrow.notify(b.owner_id, action === 'approve'
      ? { type: 'business_approved', title: '✅ Your business is live', message: `"${b.business_name}" was verified and is now listed in Business Expansion.`, link: `/business/${b.id}` }
      : { type: 'business_rejected', title: '🏢 Your listing needs changes', message: `"${b.business_name}": ${note}`, link: `/list-business?edit=${b.id}` });
    await escrow.emailUser(b.owner_id, action === 'approve' ? `"${b.business_name}" is live on IdeaHub` : `"${b.business_name}" needs changes`,
      action === 'approve' ? 'Your business is verified' : 'Your listing needs changes',
      action === 'approve' ? `We checked the registration of <strong>"${escrow.esc(b.business_name)}"</strong>. It now shows the ✅ Verified badge and investors can apply.`
        : `We couldn't approve <strong>"${escrow.esc(b.business_name)}"</strong> yet.<br><br><strong>Reason:</strong> ${escrow.esc(note)}<br><br>Update the listing or upload a clearer certificate and it will be checked again.`,
      action === 'approve' ? 'View listing' : 'Update listing', action === 'approve' ? `/business/${b.id}` : `/list-business?edit=${b.id}`);
    res.json({ ...data, reg_doc_path: undefined });
  });

  // ── Confidentiality agreements (confidential listings) ──
  app.post('/api/businesses/:id/nda', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { data: b } = id ? await supabase.from('business_listings').select('*').eq('id', id).single() : { data: null };
    if (!b || b.status !== 'active') return nf(res);
    if (!b.confidential) return res.status(400).json({ error: 'This listing is not confidential.' });
    if (b.owner_id === req.user.id) return res.status(400).json({ error: 'This is your own listing.' });
    const name = txt(req.body?.signed_name, 120);
    if (req.body?.agree !== true) return res.status(400).json({ error: 'Tick the box to accept the confidentiality agreement.' });
    if (name.length < 3) return res.status(400).json({ error: 'Type your full name to sign.' });
    const ex = await ndaOf(b.id, req.user.id);
    if (ex && ex.status === 'approved') return res.json(ex);
    if (ex && ex.status === 'requested') return res.status(400).json({ error: 'Your request is waiting for the owner.' });
    if (ex && ex.status === 'declined') return res.status(400).json({ error: 'The owner declined access to this listing.' });
    const u = await me(req.user.id);
    const intro = txt(req.body?.intro, 1000);
    const { data, error } = await supabase.from('business_ndas').insert([{ listing_id: b.id, user_id: req.user.id, status: 'requested', signed_name: name, intro: intro || null,
      nda_version: R.NDA_VERSION, nda_text: R.NDA_TEXT, signed_at: new Date().toISOString(), signed_ip: String(req.headers['cf-connecting-ip'] || req.ip || '').slice(0, 60) }]).select().single();
    if (error) return res.status(500).json({ error: error.code === '23505' ? 'You have already asked for access.' : error.message });
    await escrow.notify(b.owner_id, { type: 'business_nda', title: '🔒 Someone signed your confidentiality agreement', message: `${fullName(u)} wants to see the full details of "${b.business_name}". Approve or decline on your listing.`, link: `/business/${b.id}#access` });
    await escrow.emailUser(b.owner_id, `Access request for "${b.business_name}"`, 'Someone wants the full details', `<strong>${escrow.esc(fullName(u))}</strong> signed the confidentiality agreement for your confidential listing <strong>"${escrow.esc(b.business_name)}"</strong>.${intro ? '<br><br>' + escrow.esc(intro) : ''}<br><br>They see your business name and full details only if you approve.`, 'Review request', `/business/${b.id}#access`);
    res.status(201).json({ id: data.id, status: data.status });
  });
  app.get('/api/businesses/:id/ndas', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { data: b } = id ? await supabase.from('business_listings').select('owner_id').eq('id', id).single() : { data: null };
    const u = await me(req.user.id);
    if (!b || (b.owner_id !== req.user.id && u?.role !== 'admin')) return nf(res);
    const { data } = await supabase.from('business_ndas').select('id, user_id, status, signed_name, intro, signed_at, decided_at').eq('listing_id', id).order('signed_at', { ascending: false });
    const ids = [...new Set((data || []).map(x => x.user_id))];
    const { data: people } = ids.length ? await supabase.from('users').select('id, first_name, last_name, role, country, avatar_url, verification_status').in('id', ids) : { data: [] };
    const P = Object.fromEntries((people || []).map(p => [p.id, p]));
    res.json((data || []).map(x => ({ ...x, name: fullName(P[x.user_id]), role: P[x.user_id]?.role || null, country: P[x.user_id]?.country || null, verified: P[x.user_id]?.verification_status === 'verified' })));
  });
  app.post('/api/business-ndas/:nid/decide', authMiddleware, async (req, res) => {
    const nid = parseInt(req.params.nid, 10), decision = req.body?.decision;
    if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: "decision must be 'approve' or 'decline'" });
    const { data: n } = nid ? await supabase.from('business_ndas').select('*').eq('id', nid).single() : { data: null };
    if (!n) return nf(res);
    const { data: b } = await supabase.from('business_listings').select('id, owner_id, business_name, teaser_title').eq('id', n.listing_id).single();
    if (!b || b.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner decides.' });
    const { data: rows } = await supabase.from('business_ndas').update({ status: decision === 'approve' ? 'approved' : 'declined', decided_at: new Date().toISOString() }).eq('id', n.id).eq('status', 'requested').select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'Already decided.' });
    await escrow.notify(n.user_id, decision === 'approve'
      ? { type: 'business_nda_ok', title: '🔓 Access approved', message: `You can now see the full details of "${b.teaser_title || b.business_name}" and respond.`, link: `/business/${b.id}` }
      : { type: 'business_nda_no', title: 'Access not approved', message: `The owner of "${b.teaser_title || 'a confidential listing'}" didn't approve access.`, link: '/businesses' });
    if (decision === 'approve') await escrow.emailUser(n.user_id, 'Access approved on IdeaHub', 'You can see the full details', `The owner approved your request. You can now see the full details of <strong>"${escrow.esc(b.teaser_title || b.business_name)}"</strong> and respond. Remember: what you see is covered by the confidentiality agreement you signed.`, 'Open listing', `/business/${b.id}`);
    res.json(rows[0]);
  });

  // Listings that fit this one (owner or admin)
  app.get('/api/businesses/:id/matches', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { data: b } = id ? await supabase.from('business_listings').select('*').eq('id', id).single() : { data: null };
    const u = await me(req.user.id);
    if (!b || (b.owner_id !== req.user.id && u?.role !== 'admin')) return nf(res);
    res.json(await matchesFor(b, req.user.id));
  });

  // ── Applications ──
  app.post('/api/businesses/:id/apply', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { data: b } = id ? await supabase.from('business_listings').select('*').eq('id', id).single() : { data: null };
    if (!b) return nf(res);
    if (b.status !== 'active') return res.status(400).json({ error: 'This business isn\'t taking applications right now.' });
    if (b.owner_id === req.user.id) return res.status(400).json({ error: 'You can\'t apply to your own listing.' });
    if (b.confidential && (await ndaOf(b.id, req.user.id))?.status !== 'approved') return res.status(403).json({ error: 'Sign the confidentiality agreement and wait for the owner to approve it first.', code: 'nda_required' });
    const type = req.body?.expansion_type, message = txt(req.body?.message, 3000);
    if (!(b.expansion_types || []).includes(type)) return res.status(400).json({ error: 'Choose one of the deal types on this listing.' });
    if (message.length < 30) return res.status(400).json({ error: 'Introduce yourself and your plan (at least 30 characters).' });
    const { data: ex } = await supabase.from('expansion_applications').select('id, status').eq('listing_id', b.id).eq('investor_id', req.user.id).limit(1);
    if (ex && ex[0] && ex[0].status !== 'withdrawn') return res.status(400).json({ error: 'You have already applied to this business.', id: ex[0].id });
    const u = await me(req.user.id);
    const row = { listing_id: b.id, investor_id: req.user.id, investor_name: fullName(u), expansion_type: type, message,
      investment_capacity: txt(req.body?.investment_capacity, 120) || null, territory: txt(req.body?.territory, 120) || null, background: txt(req.body?.background, 2000) || null,
      status: 'pending', updated_at: new Date().toISOString() };
    const { data, error } = ex && ex[0]
      ? await supabase.from('expansion_applications').update({ ...row, withdrawn_at: null }).eq('id', ex[0].id).select().single()
      : await supabase.from('expansion_applications').insert([row]).select().single();
    if (error) return res.status(500).json({ error: error.code === '23505' ? 'You have already applied to this business.' : error.message });
    await recount(b.id);
    await escrow.notify(b.owner_id, { type: 'new_application', title: '📋 New response to your listing', message: `${fullName(u)} responded to "${b.business_name}" (${TYPE_LABEL[type]}).`, link: `/expansion?id=${data.id}` });
    await escrow.emailUser(b.owner_id, `New response to "${b.business_name}"`, 'Someone is interested', `<strong>${escrow.esc(fullName(u))}</strong> responded to <strong>"${escrow.esc(b.business_name)}"</strong> about a <strong>${escrow.esc(TYPE_LABEL[type].toLowerCase())}</strong>.<br><br>${escrow.esc(message.slice(0, 400))}`, 'Review', `/expansion?id=${data.id}`);
    res.status(201).json(data);
  });

  async function loadApp(req) {
    const id = parseInt(req.params.id, 10); if (!id) return {};
    const { data: a } = await supabase.from('expansion_applications').select('*').eq('id', id).single();
    if (!a) return {};
    const { data: b } = await supabase.from('business_listings').select('*').eq('id', a.listing_id).single();
    const u = await me(req.user.id);
    const as = a.investor_id === req.user.id ? 'investor' : b && b.owner_id === req.user.id ? 'owner' : u?.role === 'admin' ? 'admin' : null;
    return { a, b, as, u };
  }

  app.get('/api/expansion-applications/:id', authMiddleware, async (req, res) => {
    const { a, b, as } = await loadApp(req); if (!a || !as) return nf(res);
    const ids = [a.investor_id, b?.owner_id].filter(Boolean);
    const [{ data: people }, { data: msgs }] = await Promise.all([
      supabase.from('users').select('id, first_name, last_name, avatar_url, country').in('id', ids),
      supabase.from('expansion_messages').select('id, from_id, text, created_at').eq('application_id', a.id).order('created_at', { ascending: true }).limit(500)
    ]);
    const P = Object.fromEntries((people || []).map(p => [p.id, { id: p.id, name: fullName(p), avatar_url: p.avatar_url || null, country: p.country || null }]));
    if (as !== 'admin') supabase.from('expansion_messages').update({ is_read: true }).eq('application_id', a.id).eq('to_id', req.user.id).then(() => {}, () => {});
    res.json({ ...a, viewer: as, status_label: APP_LABEL[a.status] || a.status, type_label: TYPE_LABEL[a.expansion_type] || a.expansion_type,
      next: as === 'owner' ? (NEXT[a.status] || []) : [], investor: P[a.investor_id] || null, owner: P[b?.owner_id] || null,
      listing: b ? { id: b.id, business_name: b.business_name, country: b.country, industry: b.industry, status: b.status, is_verified: !!b.is_verified, direction: b.direction || 'offer', route: b.route || R.groupOf(b.expansion_types), confidential: !!b.confidential } : null,
      sides: (() => { const t = R.BY_KEY[a.expansion_type]; if (!t) return { owner: 'Business owner', other: 'Interested party' }; const ownerIsA = (b?.direction || 'offer') === 'offer' || t.sym; return { owner: ownerIsA ? t.a : t.b, other: ownerIsA ? t.b : t.a }; })(),
      room_id: await (async () => { const { data: rm } = await supabase.from('deal_rooms').select('id').eq('kind', 'business').eq('ref_id', a.id).limit(1); return rm && rm[0] ? rm[0].id : null; })(),
      messages: msgs || [] });
  });

  app.get('/api/expansion/mine', authMiddleware, async (req, res) => {
    const [{ data: sent }, { data: mine }] = await Promise.all([
      supabase.from('expansion_applications').select('*, listing:listing_id(id, business_name, country)').eq('investor_id', req.user.id).order('updated_at', { ascending: false }),
      supabase.from('business_listings').select('id, business_name').eq('owner_id', req.user.id)
    ]);
    const lids = (mine || []).map(l => l.id);
    const { data: recv } = lids.length ? await supabase.from('expansion_applications').select('*').in('listing_id', lids).order('updated_at', { ascending: false }) : { data: [] };
    const L = Object.fromEntries((mine || []).map(l => [l.id, l]));
    const lab = a => ({ ...a, status_label: APP_LABEL[a.status] || a.status, type_label: TYPE_LABEL[a.expansion_type] || a.expansion_type });
    res.json({ sent: (sent || []).map(lab), received: (recv || []).map(a => ({ ...lab(a), listing: L[a.listing_id] })) });
  });

  // Owner moves an application forward (one allowed step at a time)
  async function changeStatus(req, res) {
    const { a, b, as } = await loadApp(req); if (!a || !as) return nf(res);
    if (as !== 'owner') return res.status(403).json({ error: 'Only the business owner can do this.' });
    const to = req.body?.status;
    if (!(NEXT[a.status] || []).includes(to)) return res.status(400).json({ error: CLOSED_APP.includes(a.status) ? 'This application is closed.' : 'That step isn\'t available yet.' });
    const f = { status: to, updated_at: new Date().toISOString() };
    if (to === 'meetup_scheduled') {
      const when = new Date(req.body?.meetup_date || '');
      if (isNaN(when) || when.getTime() < Date.now() - 3600000) return res.status(400).json({ error: 'Choose a meetup date and time in the future.' });
      f.meetup_type = req.body?.meetup_type === 'in_person' ? 'in_person' : 'virtual';
      f.meetup_date = when.toISOString();
      f.meetup_location = f.meetup_type === 'virtual' ? null : (txt(req.body?.meetup_location, 200) || null);
      f.meetup_notes = txt(req.body?.meetup_notes, 500) || null;
      if (f.meetup_type === 'in_person' && !f.meetup_location) return res.status(400).json({ error: 'Add where you will meet.' });
    }
    if (to === 'rejected') f.reject_reason = txt(req.body?.reason, 500) || null;
    const { data: rows } = await supabase.from('expansion_applications').update(f).eq('id', a.id).eq('status', a.status).select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'This application just changed. Refresh and try again.' });
    const row = rows[0], name = b.business_name;
    const when = row.meetup_date ? new Date(row.meetup_date).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo' }) + ' (Sri Lanka time)' : '';
    const M = {
      reviewed: ['👀 Application reviewed', `The owner of "${name}" has reviewed your application.`],
      shortlisted: ['⭐ You were shortlisted', `You were shortlisted for "${name}".`],
      meetup_scheduled: ['📅 Meetup scheduled', `Meetup for "${name}" on ${when}${row.meetup_type === 'virtual' ? ' by IdeaHub video call' : ' at ' + (row.meetup_location || '')}.`],
      negotiating: ['🤝 Negotiation started', `The owner of "${name}" wants to agree terms with you.`],
      agreed: ['🎉 Agreement reached', `You reached an agreement with "${name}". Have an attorney prepare the agreement before you sign or pay.`],
      rejected: ['Application not selected', `Your application for "${name}" was not selected this time.${f.reject_reason ? ' ' + f.reject_reason : ''}`]
    }[to];
    await escrow.notify(a.investor_id, { type: 'expansion_' + to, title: M[0], message: M[1], link: `/expansion?id=${a.id}` });
    await escrow.emailUser(a.investor_id, M[0].replace(/^[^\w]+/, ''), M[0].replace(/^[^\w]+\s*/, ''), escrow.esc(M[1]), 'Open application', `/expansion?id=${a.id}`);
    res.json({ ...row, status_label: APP_LABEL[row.status] });
  }
  app.post('/api/expansion-applications/:id/status', authMiddleware, changeStatus);
  app.put('/api/expansion-applications/:id/status', authMiddleware, changeStatus);

  app.post('/api/expansion-applications/:id/withdraw', authMiddleware, async (req, res) => {
    const { a, b, as } = await loadApp(req); if (!a || !as) return nf(res);
    if (as !== 'investor') return res.status(403).json({ error: 'Only the applicant can withdraw.' });
    if (CLOSED_APP.includes(a.status)) return res.status(400).json({ error: 'This application is already closed.' });
    const { data: rows } = await supabase.from('expansion_applications').update({ status: 'withdrawn', withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', a.id).eq('status', a.status).select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'Refresh and try again.' });
    await recount(a.listing_id);
    await escrow.notify(b.owner_id, { type: 'expansion_withdrawn', title: 'Application withdrawn', message: `${a.investor_name || 'An investor'} withdrew their application for "${b.business_name}".`, link: `/expansion?id=${a.id}` });
    res.json(rows[0]);
  });

  // Messages between the investor and the owner
  app.get('/api/expansion-applications/:id/messages', authMiddleware, async (req, res) => {
    const { a, as } = await loadApp(req); if (!a || !as) return nf(res);
    const { data } = await supabase.from('expansion_messages').select('*').eq('application_id', a.id).order('created_at', { ascending: true });
    res.json(data || []);
  });
  app.post('/api/expansion-applications/:id/messages', authMiddleware, async (req, res) => {
    const { a, b, as, u } = await loadApp(req); if (!a || !as) return nf(res);
    if (as === 'admin') return res.status(403).json({ error: 'Admins can read but not post here.' });
    if (a.status === 'withdrawn') return res.status(400).json({ error: 'This application was withdrawn.' });
    const text = txt(req.body?.text, 4000); if (!text) return res.status(400).json({ error: 'Write a message.' });
    const to = as === 'owner' ? a.investor_id : b.owner_id;
    const { data, error } = await supabase.from('expansion_messages').insert([{ listing_id: a.listing_id, application_id: a.id, from_id: req.user.id, to_id: to, text }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await escrow.notify(to, { type: 'expansion_message', title: '💬 New message', message: `${fullName(u)} about "${b.business_name}": ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`, link: `/expansion?id=${a.id}` });
    res.status(201).json(data);
  });
}

module.exports = { mount, TYPES, NEXT, APP_LABEL, LISTING_LABEL };
