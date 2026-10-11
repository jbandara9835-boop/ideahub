// ─────────────────────────────────────────────────────────────────────────────
// patents.js — patent applications through IdeaHub
//
// A creator describes the invention and sends it to ONE patent attorney.
//   requested → attorney sends a fixed quote → quoted
//   quoted    → creator pays (fee + 8% IdeaHub fee) into escrow → in_progress
//   in_progress → attorney files and enters the application number → filed
//   filed     → creator confirms (or 7 days pass) → completed, attorney paid
// Side exits: declined (attorney), cancelled (creator, before paying),
//             disputed → admin releases (completed) or refunds (refunded).
//
// Invention details and files are confidential: only the creator, the chosen
// attorney and admins can read them. Files sit in a PRIVATE storage bucket and
// are opened through short-lived signed links.
//
// server.js:  const patents = require('./patents');
//             patents.mount(app, { supabase, authMiddleware, escrow });
// bots.js:    require('./patents').core(supabase, escrow).runBot()
// ─────────────────────────────────────────────────────────────────────────────
const BUCKET = 'patent-files';
const FEE_RATE = 0.08;
const AUTO_RELEASE_DAYS = 7;
const DAY = 86400000;

const STATUS_LABEL = {
  requested: 'Waiting for quote', quoted: 'Quote received', in_progress: 'In progress',
  filed: 'Filed', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled',
  disputed: 'Disputed', refunded: 'Refunded'
};
const OPEN = ['requested', 'quoted', 'in_progress', 'filed', 'disputed'];
const JURISDICTIONS = ['Sri Lanka (NIPO)', 'United States (USPTO)', 'Europe (EPO)', 'United Kingdom (UKIPO)', 'India (IPO)', 'Australia (IP Australia)', 'Singapore (IPOS)', 'International (PCT)', 'Other / not sure'];
const FILING_TYPES = ['Provisional application', 'Complete / non-provisional application', 'International (PCT) application', 'Design registration', 'Not sure, please advise'];

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const round2 = n => Math.round(Number(n) * 100) / 100;
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';

function core(supabase, escrow) {
  const payments = require('./payments')(supabase);

  async function addEarnings(userId, amount) {
    const { data: u } = await supabase.from('users').select('earnings').eq('id', userId).single();
    await supabase.from('users').update({ earnings: round2(Number(u?.earnings || 0) + Number(amount || 0)) }).eq('id', userId);
  }

  async function log(appId, fromId, text) {
    await supabase.from('patent_messages').insert([{ application_id: appId, from_id: fromId || null, text, system: !fromId }]);
  }

  // releaseType: 'creator' | 'auto' | 'admin'. Guarded by status, so it can never pay twice.
  async function release(id, releaseType, note) {
    const now = new Date().toISOString();
    const update = { status: 'completed', completed_at: now, release_type: releaseType, updated_at: now };
    if (releaseType === 'admin') { update.resolved_at = now; update.resolution_note = note || null; }
    const { data: rows, error } = await supabase.from('patent_applications')
      .update(update).eq('id', id).in('status', releaseType === 'admin' ? ['filed', 'disputed', 'in_progress'] : ['filed']).select();
    if (error) throw error;
    const a = rows && rows[0];
    if (!a) return null;
    await addEarnings(a.attorney_id, a.amount);
    await payments.record({ kind: 'release', userId: a.attorney_id, amount: a.amount, meta: { patent_application_id: a.id, release_type: releaseType } });
    await payments.record({ kind: 'fee', userId: null, amount: a.fee, meta: { patent_application_id: a.id } });
    const why = releaseType === 'auto' ? `The creator did not respond within ${AUTO_RELEASE_DAYS} days of filing, so the fee was released automatically.`
      : releaseType === 'admin' ? 'IdeaHub reviewed the application and released the fee.' : 'The creator confirmed the filing.';
    await log(a.id, null, `Completed. ${why}${note ? ' Note: ' + note : ''}`);
    await escrow.notify(a.attorney_id, { type: 'payment_released', title: '💰 Patent fee released', message: `${escrow.money(a.amount)} for "${a.title}" was added to your wallet. ${why}`, link: '/transactions' });
    await escrow.emailUser(a.attorney_id, `Fee released: ${escrow.money(a.amount)}`, 'Your patent fee was released',
      `${escrow.esc(why)} <strong style="color:#f5c842;">${escrow.money(a.amount)}</strong> has been added to your IdeaHub wallet.`, 'View wallet', '/transactions');
    await escrow.notify(a.creator_id, { type: 'patent_completed', title: '✅ Patent application complete', message: `"${a.title}" is complete. Keep your filing receipt and application number safe.`, link: `/patent-application?id=${a.id}` });
    return a;
  }

  async function refund(id, note) {
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('patent_applications')
      .update({ status: 'refunded', resolved_at: now, resolution_note: note || null, updated_at: now })
      .eq('id', id).in('status', ['disputed', 'in_progress', 'filed']).select();
    if (error) throw error;
    const a = rows && rows[0];
    if (!a) return null;
    await payments.record({ kind: 'refund', userId: a.creator_id, amount: a.total, meta: { patent_application_id: a.id, note: note || null } });
    await log(a.id, null, `Refunded to the creator by IdeaHub.${note ? ' Note: ' + note : ''}`);
    await escrow.notify(a.creator_id, { type: 'patent_refunded', title: '↩️ Patent fee refunded', message: `Your payment for "${a.title}" was refunded.${note ? ' Note: ' + note : ''}`, link: `/patent-application?id=${a.id}` });
    await escrow.notify(a.attorney_id, { type: 'patent_refunded', title: '↩️ Patent application refunded', message: `The fee for "${a.title}" was refunded to the creator.${note ? ' Note: ' + note : ''}`, link: `/patent-application?id=${a.id}` });
    await escrow.emailUser(a.creator_id, 'Your patent fee was refunded', 'Refund issued',
      `IdeaHub reviewed your patent application and refunded <strong>${escrow.money(a.total)}</strong>.${note ? '<br><br>' + escrow.esc(note) : ''}`, 'View application', `/patent-application?id=${a.id}`);
    return a;
  }

  // Daily (escrow bot): auto-release filed applications, remind creators and slow attorneys
  async function runBot() {
    const now = Date.now();
    let released = 0, reminders = 0;
    const { data: filed, error } = await supabase.from('patent_applications').select('*').eq('status', 'filed');
    if (error) throw error;
    for (const a of filed || []) {
      const age = (now - new Date(a.filed_at).getTime()) / DAY;
      const sent = a.creator_reminders || 0;
      if (age >= AUTO_RELEASE_DAYS) { if (await release(a.id, 'auto')) released++; }
      else if ((age >= 5 && sent < 2) || (age >= 2 && sent < 1)) {
        const left = Math.max(1, Math.ceil(AUTO_RELEASE_DAYS - age));
        await escrow.notify(a.creator_id, { type: 'confirm_reminder', title: '⏳ Please confirm your patent filing', message: `Your attorney filed "${a.title}". Confirm or open a dispute within ${left} day${left > 1 ? 's' : ''}, otherwise the fee is released automatically.`, link: `/patent-application?id=${a.id}` });
        await escrow.emailUser(a.creator_id, 'Please confirm your patent filing', 'Your patent application was filed',
          `Your attorney marked your patent application as filed (application number <strong>${escrow.esc(a.application_number || '')}</strong>). Check the filing receipt, then confirm.<br><br>If something is wrong, open a dispute. In <strong>${left} day${left > 1 ? 's' : ''}</strong> the fee will be released to the attorney automatically.`,
          'Review filing', `/patent-application?id=${a.id}`);
        await supabase.from('patent_applications').update({ creator_reminders: age >= 5 ? 2 : 1 }).eq('id', a.id);
        reminders++;
      }
    }
    const { data: waiting } = await supabase.from('patent_applications').select('id, attorney_id, created_at, attorney_reminders').eq('status', 'requested');
    for (const a of waiting || []) {
      const age = (now - new Date(a.created_at).getTime()) / DAY;
      if (age >= 3 && !(a.attorney_reminders > 0)) {
        await escrow.notify(a.attorney_id, { type: 'patent_quote_reminder', title: '⏳ A creator is waiting for your quote', message: 'A patent application request has been waiting 3 days. Send a quote or decline it.', link: `/patent-application?id=${a.id}` });
        await supabase.from('patent_applications').update({ attorney_reminders: 1 }).eq('id', a.id);
        reminders++;
      }
    }
    return `Patents: auto-released ${released}, ${reminders} reminder${reminders === 1 ? '' : 's'}`;
  }

  return { release, refund, runBot, log, payments };
}

function mount(app, { supabase, authMiddleware, escrow }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const c = core(supabase, escrow);
  const verifiedOnly = () => (process.env.PATENT_VERIFIED_ONLY || 'on').toLowerCase() !== 'off';

  async function me(req) {
    const { data } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', req.user.id).single();
    return data;
  }
  // Loads an application and the caller's relation to it: 'creator' | 'attorney' | 'admin' | null
  async function load(req) {
    const id = parseInt(req.params.id, 10);
    if (!id) return { status: 404 };
    const { data: a } = await supabase.from('patent_applications').select('*').eq('id', id).single();
    if (!a) return { status: 404 };
    const u = await me(req);
    const as = a.creator_id === req.user.id ? 'creator' : a.attorney_id === req.user.id ? 'attorney' : u?.role === 'admin' ? 'admin' : null;
    if (!as) return { status: 404 }; // don't reveal that it exists
    return { a, as, u };
  }
  const fail = (res, r) => res.status(r.status).json({ error: r.status === 404 ? 'Application not found.' : 'Not allowed.' });

  async function attorneys(excludeId) {
    const { data: profs } = await supabase.from('support_profiles').select('*').eq('role', 'patent_attorney');
    const ids = (profs || []).map(p => p.user_id).filter(id => id !== excludeId);
    if (!ids.length) return [];
    const { data: users } = await supabase.from('users').select('id, first_name, last_name, avatar_url, role, verification_status, country').in('id', ids);
    const byId = Object.fromEntries((users || []).map(u => [u.id, u]));
    return (profs || []).filter(p => byId[p.user_id] && byId[p.user_id].role === 'patent_attorney').map(p => {
      const u = byId[p.user_id];
      return {
        id: u.id, name: fullName(u), avatar_url: u.avatar_url || null, tagline: p.tagline || '',
        hourly_rate: p.hourly_rate || null, experience_years: p.experience_years || null,
        home_country: p.home_country || u.country || null, languages: p.languages || null,
        availability: p.availability || null, avg_rating: p.avg_rating || null, completed_jobs: p.completed_jobs || 0,
        verified: u.verification_status === 'verified' || p.is_verified === true
      };
    }).filter(a => !verifiedOnly() || a.verified)
      .sort((x, y) => (y.verified - x.verified) || ((y.avg_rating || 0) - (x.avg_rating || 0)));
  }

  app.get('/api/patents/attorneys', authMiddleware, async (req, res) => {
    try { res.json({ attorneys: await attorneys(req.user.id), verified_only: verifiedOnly(), jurisdictions: JURISDICTIONS, filing_types: FILING_TYPES }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create — sends the request to one attorney
  app.post('/api/patent-applications', authMiddleware, async (req, res) => {
    const b = req.body || {};
    const f = {
      title: txt(b.title, 150), field: txt(b.field, 80), problem: txt(b.problem, 3000), solution: txt(b.solution, 8000),
      novelty: txt(b.novelty, 3000), prior_art: txt(b.prior_art, 3000), inventors: txt(b.inventors, 500),
      jurisdiction: txt(b.jurisdiction, 80), filing_type: txt(b.filing_type, 80)
    };
    if (f.title.length < 5) return res.status(400).json({ error: 'Give the invention a title (at least 5 characters).' });
    if (f.problem.length < 20) return res.status(400).json({ error: 'Describe the problem it solves (at least 20 characters).' });
    if (f.solution.length < 80) return res.status(400).json({ error: 'Explain how the invention works in more detail (at least 80 characters). The attorney needs this to quote.' });
    if (f.novelty.length < 20) return res.status(400).json({ error: 'Say what is new about it compared with what exists (at least 20 characters).' });
    if (!JURISDICTIONS.includes(f.jurisdiction)) return res.status(400).json({ error: 'Choose where you want to file.' });
    if (!FILING_TYPES.includes(f.filing_type)) return res.status(400).json({ error: 'Choose the type of application.' });
    if (!b.confidential_ack) return res.status(400).json({ error: 'Please confirm you understand who can see your invention.' });

    const attorneyId = parseInt(b.attorney_id, 10);
    if (!attorneyId || attorneyId === req.user.id) return res.status(400).json({ error: 'Choose a patent attorney.' });
    const list = await attorneys(req.user.id);
    if (!list.some(a => a.id === attorneyId)) return res.status(400).json({ error: 'That attorney is not available for patent applications.' });

    let ideaId = null;
    if (b.idea_id) {
      const { data: idea } = await supabase.from('ideas').select('id, creator_id').eq('id', parseInt(b.idea_id, 10)).single();
      if (!idea || idea.creator_id !== req.user.id) return res.status(400).json({ error: 'You can only link your own ideas.' });
      ideaId = idea.id;
    }
    const { count } = await supabase.from('patent_applications').select('id', { count: 'exact', head: true }).eq('creator_id', req.user.id).eq('status', 'requested');
    if ((count || 0) >= 10) return res.status(429).json({ error: 'You have 10 requests waiting for a quote. Wait for replies or cancel some first.' });

    const { data: a, error } = await supabase.from('patent_applications').insert([{
      ...f, creator_id: req.user.id, attorney_id: attorneyId, idea_id: ideaId, status: 'requested', attachments: []
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });

    const u = await me(req);
    await c.log(a.id, null, `${fullName(u)} sent this patent application request.`);
    await escrow.notify(attorneyId, { type: 'patent_request', title: '⚖️ New patent application request', message: `${fullName(u)} wants help filing "${a.title}" (${a.jurisdiction}). Review it and send a quote.`, link: `/patent-application?id=${a.id}` });
    // Email leaves out the invention details on purpose
    await escrow.emailUser(attorneyId, 'New patent application request on IdeaHub', 'A creator wants you to file a patent',
      `<strong style="color:#f0ede8;">${escrow.esc(fullName(u))}</strong> sent you a patent application request for <strong>${escrow.esc(a.jurisdiction)}</strong> (${escrow.esc(a.filing_type)}).<br><br>The invention details are confidential and can only be read on IdeaHub. Review them and send a fixed quote, or decline.`,
      'Review request', `/patent-application?id=${a.id}`);
    res.status(201).json(a);
  });

  // My applications — as creator, and as attorney
  app.get('/api/patent-applications', authMiddleware, async (req, res) => {
    const cols = 'id, title, status, jurisdiction, filing_type, quote_amount, amount, total, application_number, created_at, updated_at, creator_id, attorney_id';
    const [{ data: mine, error: e1 }, { data: clients, error: e2 }] = await Promise.all([
      supabase.from('patent_applications').select(cols).eq('creator_id', req.user.id).order('created_at', { ascending: false }),
      supabase.from('patent_applications').select(cols).eq('attorney_id', req.user.id).order('created_at', { ascending: false })
    ]);
    if (e1 || e2) return res.status(500).json({ error: (e1 || e2).message });
    const ids = [...new Set([...(mine || []).map(a => a.attorney_id), ...(clients || []).map(a => a.creator_id)].filter(Boolean))];
    const { data: users } = ids.length ? await supabase.from('users').select('id, first_name, last_name, avatar_url').in('id', ids) : { data: [] };
    const byId = Object.fromEntries((users || []).map(u => [u.id, u]));
    const shape = (a, otherId) => ({ ...a, status_label: STATUS_LABEL[a.status] || a.status, other: { id: otherId, name: fullName(byId[otherId]), avatar_url: byId[otherId]?.avatar_url || null } });
    res.json({ mine: (mine || []).map(a => shape(a, a.attorney_id)), clients: (clients || []).map(a => shape(a, a.creator_id)) });
  });

  // One application, with messages and files (confidential)
  app.get('/api/patent-applications/:id', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    const { a, as } = r;
    const [{ data: people }, { data: msgs }] = await Promise.all([
      supabase.from('users').select('id, first_name, last_name, avatar_url, email').in('id', [a.creator_id, a.attorney_id].filter(Boolean)),
      supabase.from('patent_messages').select('*').eq('application_id', a.id).order('created_at', { ascending: true }).limit(500)
    ]);
    const p = Object.fromEntries((people || []).map(u => [u.id, u]));
    const person = id => p[id] ? { id, name: fullName(p[id]), avatar_url: p[id].avatar_url || null, ...(as === 'admin' ? { email: p[id].email } : {}) } : null;
    let idea = null;
    if (a.idea_id) { const { data } = await supabase.from('ideas').select('id, title').eq('id', a.idea_id).single(); idea = data || null; }
    const attachments = (a.attachments || []).map((f, i) => ({ index: i, name: f.name, size: f.size, uploaded_by: f.uploaded_by, at: f.at, kind: f.kind || null }));
    res.json({
      ...a, attachments, idea, viewer: as, status_label: STATUS_LABEL[a.status] || a.status,
      creator: person(a.creator_id), attorney: person(a.attorney_id),
      confirm_by: a.status === 'filed' && a.filed_at ? new Date(new Date(a.filed_at).getTime() + AUTO_RELEASE_DAYS * DAY).toISOString() : null,
      fee_rate: FEE_RATE, payments_open: c.payments.purchasesOpen(),
      messages: (msgs || []).map(m => ({ id: m.id, from_id: m.from_id, text: m.text, system: !!m.system, created_at: m.created_at }))
    });
  });

  app.post('/api/patent-applications/:id/messages', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Admins can read but not post here.' });
    const text = txt(req.body?.text, 4000);
    if (!text) return res.status(400).json({ error: 'Write a message.' });
    const { data, error } = await supabase.from('patent_messages').insert([{ application_id: r.a.id, from_id: req.user.id, text }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('patent_applications').update({ updated_at: new Date().toISOString() }).eq('id', r.a.id);
    const to = r.as === 'creator' ? r.a.attorney_id : r.a.creator_id;
    await escrow.notify(to, { type: 'patent_message', title: '💬 New message on a patent application', message: `${fullName(r.u)}: ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`, link: `/patent-application?id=${r.a.id}` });
    res.status(201).json(data);
  });

  // Upload a confidential file (drawings, drafts, filing receipt) — private bucket
  app.post('/api/patent-applications/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as === 'admin') return res.status(403).json({ error: 'Admins cannot upload here.' });
    if (!OPEN.includes(r.a.status) && r.a.status !== 'completed') return res.status(400).json({ error: 'This application is closed.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file (up to 10 MB).' });
    const okType = /^(application\/pdf|image\/(png|jpe?g|webp|gif)|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)|text\/plain)$/.test(req.file.mimetype);
    if (!okType) return res.status(400).json({ error: 'Upload a PDF, Word document, image or text file.' });
    const files = Array.isArray(r.a.attachments) ? r.a.attachments : [];
    if (files.length >= 30) return res.status(400).json({ error: 'This application already has 30 files.' });
    const safe = String(req.file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `app-${r.a.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const kind = req.body?.kind === 'receipt' && r.as === 'attorney' ? 'receipt' : null;
    const entry = { path, name: safe, size: req.file.size, type: req.file.mimetype, uploaded_by: req.user.id, at: new Date().toISOString(), kind };
    const { error } = await supabase.from('patent_applications').update({ attachments: [...files, entry], updated_at: entry.at }).eq('id', r.a.id);
    if (error) return res.status(500).json({ error: error.message });
    await c.log(r.a.id, null, `${fullName(r.u)} added a file: ${safe}${kind ? ' (filing receipt)' : ''}`);
    res.status(201).json({ index: files.length, name: safe, size: entry.size, uploaded_by: entry.uploaded_by, at: entry.at, kind });
  });

  // Open a file: returns a signed link valid for 5 minutes
  app.get('/api/patent-applications/:id/files/:index', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    const f = (r.a.attachments || [])[parseInt(req.params.index, 10)];
    if (!f) return res.status(404).json({ error: 'File not found.' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.path, 300, { download: f.name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl, name: f.name });
  });

  // Attorney: send or revise a fixed quote
  app.post('/api/patent-applications/:id/quote', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'attorney') return res.status(403).json({ error: 'Only the attorney can send a quote.' });
    if (!['requested', 'quoted'].includes(r.a.status)) return res.status(400).json({ error: 'A quote can only be sent before payment.' });
    const amount = round2(req.body?.amount);
    const scope = txt(req.body?.scope, 2000);
    const days = parseInt(req.body?.days, 10);
    if (!(amount >= 1 && amount <= 100000)) return res.status(400).json({ error: 'Enter your fee in USD (1 to 100,000).' });
    if (scope.length < 20) return res.status(400).json({ error: 'Say what the fee includes (at least 20 characters): searches, drafting, drawings, official filing fees, etc.' });
    if (!(days >= 1 && days <= 365)) return res.status(400).json({ error: 'Enter how many days until filing (1 to 365).' });
    const revised = r.a.status === 'quoted';
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('patent_applications')
      .update({ status: 'quoted', quote_amount: amount, quote_scope: scope, quote_days: days, quoted_at: now, updated_at: now })
      .eq('id', r.a.id).in('status', ['requested', 'quoted']).select();
    if (error) return res.status(500).json({ error: error.message });
    if (!rows || !rows.length) return res.status(409).json({ error: 'The application changed. Refresh the page.' });
    await c.log(r.a.id, null, `${revised ? 'Quote revised' : 'Quote sent'}: ${escrow.money(amount)}, filing within ${days} days.`);
    await escrow.notify(r.a.creator_id, { type: 'patent_quote', title: revised ? '📝 Patent quote revised' : '📝 You received a patent quote', message: `${fullName(r.u)} quoted ${escrow.money(amount)} to file "${r.a.title}" within ${days} days.`, link: `/patent-application?id=${r.a.id}` });
    await escrow.emailUser(r.a.creator_id, revised ? 'Your patent quote was revised' : 'You received a patent quote', 'Your attorney sent a quote',
      `<strong style="color:#f0ede8;">${escrow.esc(fullName(r.u))}</strong> quoted <strong style="color:#f5c842;">${escrow.money(amount)}</strong> to file your patent application within <strong>${days} days</strong>.<br><br>When you accept, the fee is held safely in escrow and only released to the attorney after the application is filed.`,
      'Review quote', `/patent-application?id=${r.a.id}`);
    res.json(rows[0]);
  });

  // Attorney: decline (before payment)
  app.post('/api/patent-applications/:id/decline', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'attorney') return res.status(403).json({ error: 'Only the attorney can decline.' });
    const reason = txt(req.body?.reason, 1000);
    if (reason.length < 5) return res.status(400).json({ error: 'Tell the creator briefly why.' });
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('patent_applications').update({ status: 'declined', decline_reason: reason, updated_at: now }).eq('id', r.a.id).in('status', ['requested', 'quoted']).select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'This application can no longer be declined.' });
    await c.log(r.a.id, null, `${fullName(r.u)} declined: ${reason}`);
    await escrow.notify(r.a.creator_id, { type: 'patent_declined', title: '❌ Attorney declined your patent request', message: `"${r.a.title}": ${reason} You can send it to another attorney.`, link: `/patent-apply?from=${r.a.id}` });
    res.json(rows[0]);
  });

  // Creator: cancel (before payment)
  app.post('/api/patent-applications/:id/cancel', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'creator') return res.status(403).json({ error: 'Only the creator can cancel.' });
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('patent_applications').update({ status: 'cancelled', cancelled_at: now, updated_at: now }).eq('id', r.a.id).in('status', ['requested', 'quoted']).select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'After payment, use "Open a dispute" instead.' });
    await c.log(r.a.id, null, `${fullName(r.u)} cancelled the request.`);
    await escrow.notify(r.a.attorney_id, { type: 'patent_cancelled', title: 'Patent request cancelled', message: `The creator cancelled "${r.a.title}".`, link: `/patent-application?id=${r.a.id}` });
    res.json(rows[0]);
  });

  // Creator: accept the quote and pay into escrow
  app.post('/api/patent-applications/:id/pay', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'creator') return res.status(403).json({ error: 'Only the creator can pay.' });
    if (r.a.status !== 'quoted') return res.status(400).json({ error: 'There is no quote to accept.' });
    if (Number(req.body?.expected_amount) !== Number(r.a.quote_amount)) return res.status(409).json({ error: 'The quote was just changed. Refresh to see the new amount.' });
    if (!c.payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon. Message the attorney in the meantime.', code: 'payments_closed' });
    const amount = round2(r.a.quote_amount);
    const fee = round2(amount * FEE_RATE);
    const total = round2(amount + fee);
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('patent_applications')
      .update({ status: 'in_progress', amount, fee, total, paid_at: now, updated_at: now })
      .eq('id', r.a.id).eq('status', 'quoted').eq('quote_amount', r.a.quote_amount).select();
    if (error) return res.status(500).json({ error: error.message });
    if (!rows || !rows.length) return res.status(409).json({ error: 'The quote changed. Refresh and try again.' });
    const charge = await c.payments.chargeService({ userId: req.user.id, amount: total, meta: { patent_application_id: r.a.id } });
    if (!charge.ok) {
      await supabase.from('patent_applications').update({ status: 'quoted', amount: null, fee: null, total: null, paid_at: null }).eq('id', r.a.id).eq('status', 'in_progress');
      return res.status(402).json({ error: charge.error || 'Payment failed.' });
    }
    const due = new Date(Date.now() + (r.a.quote_days || 30) * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    await c.log(r.a.id, null, `Quote accepted. ${escrow.money(total)} is held in escrow. Filing expected by ${due}.`);
    await escrow.notify(r.a.attorney_id, { type: 'patent_paid', title: '💰 Patent fee paid into escrow', message: `The creator paid for "${r.a.title}". Start work; file by ${due}.`, link: `/patent-application?id=${r.a.id}` });
    await escrow.emailUser(r.a.attorney_id, 'Patent fee paid: start work', 'The creator accepted your quote',
      `Your fee of <strong style="color:#f5c842;">${escrow.money(amount)}</strong> is held in escrow. Please prepare and file the application by <strong>${escrow.esc(due)}</strong>.<br><br>When it is filed, enter the application number on IdeaHub and upload the filing receipt. The fee is released when the creator confirms, or automatically ${AUTO_RELEASE_DAYS} days later.`,
      'Open application', `/patent-application?id=${r.a.id}`);
    res.json(rows[0]);
  });

  // Attorney: mark as filed
  app.post('/api/patent-applications/:id/filed', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'attorney') return res.status(403).json({ error: 'Only the attorney can mark it filed.' });
    if (r.a.status !== 'in_progress') return res.status(400).json({ error: 'Only a paid application in progress can be marked filed.' });
    const number = txt(req.body?.application_number, 60);
    const date = txt(req.body?.filing_date, 10);
    const office = txt(req.body?.office, 80) || r.a.jurisdiction;
    if (number.length < 3) return res.status(400).json({ error: 'Enter the application number from the patent office.' });
    const d = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(d) || d.getTime() > Date.now() + DAY) return res.status(400).json({ error: 'Enter the filing date (not in the future).' });
    if (!(r.a.attachments || []).some(f => f.kind === 'receipt')) return res.status(400).json({ error: 'Upload the official filing receipt first.' });
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('patent_applications')
      .update({ status: 'filed', application_number: number, filing_date: date, filing_office: office, filed_at: now, updated_at: now, creator_reminders: 0 })
      .eq('id', r.a.id).eq('status', 'in_progress').select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'The application changed. Refresh the page.' });
    const by = new Date(Date.now() + AUTO_RELEASE_DAYS * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const nice = new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    await c.log(r.a.id, null, `Filed with ${office} on ${nice}. Application number ${number}.`);
    await escrow.notify(r.a.creator_id, { type: 'patent_filed', title: '📄 Your patent application was filed', message: `"${r.a.title}" was filed (${number}). Check the receipt and confirm by ${by}.`, link: `/patent-application?id=${r.a.id}` });
    await escrow.emailUser(r.a.creator_id, 'Your patent application was filed', 'Filed with the patent office',
      `Your attorney filed your patent application with <strong>${escrow.esc(office)}</strong>.<br>Application number: <strong style="color:#f5c842;">${escrow.esc(number)}</strong><br>Filing date: <strong>${escrow.esc(nice)}</strong><br><br>Check the filing receipt on IdeaHub and confirm. If something is wrong, open a dispute. If you do nothing, the fee is released to the attorney on <strong>${escrow.esc(by)}</strong>.`,
      'Review filing', `/patent-application?id=${r.a.id}`);
    res.json(rows[0]);
  });

  // Creator: confirm → release
  app.post('/api/patent-applications/:id/confirm', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'creator') return res.status(403).json({ error: 'Only the creator can confirm.' });
    try {
      const done = await c.release(r.a.id, 'creator');
      if (!done) return res.status(400).json({ error: 'This application is not waiting for confirmation.' });
      res.json(done);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Creator: dispute (after paying)
  app.post('/api/patent-applications/:id/dispute', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.a) return fail(res, r);
    if (r.as !== 'creator') return res.status(403).json({ error: 'Only the creator can open a dispute.' });
    const reason = txt(req.body?.reason, 2000);
    if (reason.length < 15) return res.status(400).json({ error: 'Explain the problem (at least 15 characters).' });
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('patent_applications').update({ status: 'disputed', dispute_reason: reason, disputed_at: now, updated_at: now }).eq('id', r.a.id).in('status', ['in_progress', 'filed']).select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'A dispute can only be opened after paying and before completion.' });
    await c.log(r.a.id, null, `${fullName(r.u)} opened a dispute: ${reason}`);
    await escrow.notify(r.a.attorney_id, { type: 'disputed', title: '⚠️ Dispute on a patent application', message: `The creator opened a dispute on "${r.a.title}". The fee is on hold while IdeaHub reviews it.`, link: `/patent-application?id=${r.a.id}` });
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const ad of admins || []) await escrow.notify(ad.id, { type: 'disputed', title: '⚠️ Patent dispute', message: `"${r.a.title}" (${escrow.money(r.a.amount)}): ${reason.slice(0, 120)}`, link: '/admin' });
    res.json(rows[0]);
  });

  // Admin
  async function isAdmin(req) { const u = await me(req); return u?.role === 'admin'; }
  app.get('/api/admin/patent-disputes', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('patent_applications')
      .select('id, title, status, amount, fee, total, jurisdiction, application_number, filed_at, disputed_at, dispute_reason, creator:creator_id(first_name, last_name, email), attorney:attorney_id(first_name, last_name, email)')
      .eq('status', 'disputed').order('disputed_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  app.put('/api/admin/patent-applications/:id/resolve', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { outcome, note } = req.body || {};
    try {
      const out = outcome === 'release' ? await c.release(parseInt(req.params.id, 10), 'admin', txt(note, 1000))
        : outcome === 'refund' ? await c.refund(parseInt(req.params.id, 10), txt(note, 1000)) : undefined;
      if (out === undefined) return res.status(400).json({ error: "outcome must be 'release' or 'refund'" });
      if (!out) return res.status(400).json({ error: 'This application is not open for a decision.' });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return c;
}

module.exports = { mount, core, STATUS_LABEL, JURISDICTIONS, FILING_TYPES, FEE_RATE, AUTO_RELEASE_DAYS };
