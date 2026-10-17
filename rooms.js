// ─────────────────────────────────────────────────────────────────────────────
// rooms.js — deal rooms: both sides of a deal bring their own advisers
//
// A room belongs to a deal:
//   licence  → a licence deal (licensor = side A, licensee = side B)
//   listing  → one buyer talking to the owner of a listing (owner = A, buyer = B);
//              used for patent-sale enquiries and idea deals
// Members: the two parties, plus advisers each side invites (attorney, accountant,
// virtual manager, other) — Picela professionals, or anyone by email.
// Channels:
//   shared → everyone in the room
//   a / b  → one side and its own advisers only (the other side never sees it)
// Files follow the same visibility. Video calls are for the whole room.
// Advisers can talk, share files and join calls; only the parties act on the deal.
//
// Paid adviser work (jobs): an adviser quotes their own client a fixed fee,
// the client pays (+8% Picela fee) into escrow, the adviser marks it delivered,
// the client confirms (or 7 days pass) → released to the adviser. Disputes go to admin.
//
// server.js:  require('./rooms').mount(app, { supabase, authMiddleware, escrow, sendEmail });
// bots.js:    require('./rooms').core(supabase, escrow).runBot()
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const BUCKET = 'patent-files';
const DAY = 86400000;
const FEE_RATE = 0.08;
const AUTO_RELEASE_DAYS = 7;
const MAX_MEMBERS = 12;
const ROLES = { attorney: 'Attorney', accountant: 'Accountant', virtual_manager: 'Virtual manager', other: 'Adviser' };
const ROLE_FROM_USER = { patent_attorney: 'attorney', chartered_accountant: 'accountant', virtual_manager: 'virtual_manager', corporate_services: 'other' };
const SITE = 'https://picela.co';

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const round2 = n => Math.round(Number(n) * 100) / 100;
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Picela member' : 'Picela member';

function core(supabase, escrow) {
  const payments = require('./payments')(supabase);
  async function log(roomId, channel, text) {
    await supabase.from('deal_room_messages').insert([{ room_id: roomId, channel, from_id: null, text, system: true }]);
  }
  async function addEarnings(userId, amount) {
    const { data: u } = await supabase.from('users').select('earnings').eq('id', userId).single();
    await supabase.from('users').update({ earnings: round2(Number(u?.earnings || 0) + Number(amount || 0)) }).eq('id', userId);
  }
  async function releaseJob(id, type, note) {
    const now = new Date().toISOString();
    const update = { status: 'completed', completed_at: now, release_type: type, updated_at: now };
    if (type === 'admin') { update.resolved_at = now; update.resolution_note = note || null; }
    const { data: rows, error } = await supabase.from('deal_room_jobs').update(update).eq('id', id).in('status', type === 'admin' ? ['delivered', 'disputed', 'in_progress'] : ['delivered']).select();
    if (error) throw error;
    const j = rows && rows[0]; if (!j) return null;
    await addEarnings(j.adviser_id, j.amount);
    await payments.record({ kind: 'release', userId: j.adviser_id, amount: j.amount, meta: { deal_room_job_id: j.id, release_type: type } });
    await payments.record({ kind: 'fee', userId: null, amount: j.fee, meta: { deal_room_job_id: j.id } });
    await log(j.room_id, j.side, `Adviser fee for "${j.title}" released (${escrow.money(j.amount)}).${note ? ' Note: ' + note : ''}`);
    await escrow.notify(j.adviser_id, { type: 'payment_released', title: '💰 Adviser fee released', message: `${escrow.money(j.amount)} for "${j.title}" was added to your wallet.`, link: '/transactions' });
    return j;
  }
  async function refundJob(id, note) {
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('deal_room_jobs').update({ status: 'refunded', resolved_at: now, resolution_note: note || null, updated_at: now }).eq('id', id).in('status', ['disputed', 'in_progress', 'delivered']).select();
    if (error) throw error;
    const j = rows && rows[0]; if (!j) return null;
    await payments.record({ kind: 'refund', userId: j.client_id, amount: j.total, meta: { deal_room_job_id: j.id, note: note || null } });
    await log(j.room_id, j.side, `Adviser fee for "${j.title}" was refunded by Picela.${note ? ' Note: ' + note : ''}`);
    for (const uid of [j.client_id, j.adviser_id]) await escrow.notify(uid, { type: 'job_refunded', title: '↩️ Adviser job refunded', message: `"${j.title}" was refunded to the client.${note ? ' Note: ' + note : ''}`, link: `/deal-room?id=${j.room_id}` });
    return j;
  }
  // Daily: auto-release delivered jobs after 7 days, remind clients before that
  async function runBot() {
    let released = 0, reminders = 0;
    const { data: jobs } = await supabase.from('deal_room_jobs').select('*').eq('status', 'delivered');
    for (const j of jobs || []) {
      const age = (Date.now() - new Date(j.delivered_at).getTime()) / DAY;
      if (age >= AUTO_RELEASE_DAYS) { if (await releaseJob(j.id, 'auto')) released++; }
      else if (age >= 4 && !j.reminded) {
        await escrow.notify(j.client_id, { type: 'confirm_reminder', title: '⏳ Please confirm your adviser\'s work', message: `"${j.title}" was delivered. Confirm or report a problem, otherwise the fee is released automatically in ${Math.ceil(AUTO_RELEASE_DAYS - age)} days.`, link: `/deal-room?id=${j.room_id}` });
        await supabase.from('deal_room_jobs').update({ reminded: true }).eq('id', j.id);
        reminders++;
      }
    }
    return `Deal rooms: ${released} adviser job${released === 1 ? '' : 's'} auto-released, ${reminders} reminder${reminders === 1 ? '' : 's'}`;
  }
  return { log, releaseJob, refundJob, runBot, payments };
}

function mount(app, { supabase, authMiddleware, escrow, sendEmail }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const c = core(supabase, escrow);

  async function me(req) { const { data } = await supabase.from('users').select('id, role, first_name, last_name, email').eq('id', req.user.id).single(); return data; }
  async function members(roomId) {
    const { data } = await supabase.from('deal_room_members').select('*').eq('room_id', roomId);
    return data || [];
  }
  // Loads a room and the caller's membership. Admins can read everything.
  async function load(req, idParam) {
    const id = parseInt(idParam ?? req.params.id, 10);
    if (!id) return { status: 404 };
    const { data: room } = await supabase.from('deal_rooms').select('*').eq('id', id).single();
    if (!room) return { status: 404 };
    const ms = await members(id);
    const mine = ms.find(m => m.user_id === req.user.id && m.status === 'active');
    const u = await me(req);
    if (!mine && u?.role !== 'admin') return { status: 404 };
    return { room, ms, mine: mine || null, u, admin: !mine && u?.role === 'admin' };
  }
  const fail = res => res.status(404).json({ error: 'Not found.' });
  const channelsFor = r => r.admin ? ['shared', 'a', 'b'] : ['shared', r.mine.side];
  const isParty = r => r.mine && r.mine.role === 'party';

  async function notifyRoom(r, channel, msg, exceptId) {
    const targets = r.ms.filter(m => m.status === 'active' && m.user_id && m.user_id !== exceptId && (channel === 'shared' || m.side === channel));
    for (const m of targets) await escrow.notify(m.user_id, { ...msg, link: `/deal-room?id=${r.room.id}` });
  }

  // Get or create the room for a deal
  app.post('/api/rooms', authMiddleware, async (req, res) => {
    const kind = req.body?.kind;
    let a, b, title, ref;
    if (kind === 'licence') {
      const { data: d } = await supabase.from('licence_deals').select('id, idea_title, licensor_id, licensee_id, status').eq('id', parseInt(req.body.licence_id, 10)).single();
      if (!d || ![d.licensor_id, d.licensee_id].includes(req.user.id)) return fail(res);
      if (['declined', 'cancelled'].includes(d.status)) return res.status(400).json({ error: 'This deal is closed.' });
      a = d.licensor_id; b = d.licensee_id; title = `Licence: ${d.idea_title}`; ref = d.id;
    } else if (kind === 'listing') {
      const { data: idea } = await supabase.from('ideas').select('id, title, creator_id, status').eq('id', parseInt(req.body.idea_id, 10)).single();
      if (!idea || !['live', 'escrow', 'sold'].includes(idea.status)) return res.status(404).json({ error: 'Listing not found.' });
      if (idea.creator_id === req.user.id) return res.status(400).json({ error: 'Buyers open a deal room with you from your listing.' });
      a = idea.creator_id; b = req.user.id; title = idea.title; ref = idea.id;
    } else if (kind === 'business') {
      // A Business Expansion application: the listing owner (a) and the other party (b)
      const { data: x } = await supabase.from('expansion_applications').select('id, listing_id, investor_id, status').eq('id', parseInt(req.body.application_id, 10)).single();
      const { data: bl } = x ? await supabase.from('business_listings').select('id, owner_id, business_name').eq('id', x.listing_id).single() : { data: null };
      if (!x || !bl || ![x.investor_id, bl.owner_id].includes(req.user.id)) return fail(res);
      if (['withdrawn', 'rejected'].includes(x.status)) return res.status(400).json({ error: 'This application is closed.' });
      a = bl.owner_id; b = x.investor_id; title = bl.business_name; ref = x.id;
    } else return res.status(400).json({ error: 'Unknown deal type.' });

    let q = supabase.from('deal_rooms').select('*').eq('kind', kind).eq('ref_id', ref);
    if (kind === 'listing') q = q.eq('side_b_user', b);
    const { data: existing } = await q;
    if (existing && existing[0]) return res.json(existing[0]);
    const { data: room, error } = await supabase.from('deal_rooms').insert([{ kind, ref_id: ref, title, side_a_user: a, side_b_user: b, created_by: req.user.id, status: 'open' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('deal_room_members').insert([
      { room_id: room.id, user_id: a, side: 'a', role: 'party', status: 'active', joined_at: new Date().toISOString() },
      { room_id: room.id, user_id: b, side: 'b', role: 'party', status: 'active', joined_at: new Date().toISOString() }
    ]);
    const u = await me(req);
    await c.log(room.id, 'shared', `${fullName(u)} opened this deal room. Each side can invite its own attorney, accountant or other advisers. Use your side's private channel for advice the other side shouldn't see.`);
    const other = req.user.id === a ? b : a;
    await escrow.notify(other, { type: 'deal_room', title: '🤝 Deal room opened', message: `${fullName(u)} opened a deal room for "${title}". You can bring in your own advisers.`, link: `/deal-room?id=${room.id}` });
    res.status(201).json(room);
  });

  // My rooms
  app.get('/api/rooms', authMiddleware, async (req, res) => {
    const { data: mem } = await supabase.from('deal_room_members').select('room_id, side, role, status').eq('user_id', req.user.id).in('status', ['active', 'invited']);
    const ids = (mem || []).map(m => m.room_id);
    if (!ids.length) return res.json([]);
    const { data: rooms } = await supabase.from('deal_rooms').select('*').in('id', ids).order('updated_at', { ascending: false });
    const byRoom = Object.fromEntries((mem || []).map(m => [m.room_id, m]));
    res.json((rooms || []).map(r => ({ ...r, my_side: byRoom[r.id]?.side, my_role: byRoom[r.id]?.role, my_status: byRoom[r.id]?.status })));
  });

  // One room (only the channels I may see)
  app.get('/api/rooms/:id', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.room) {
      // An invited adviser who hasn't accepted yet can see the invitation
      const id = parseInt(req.params.id, 10);
      const { data: inv } = await supabase.from('deal_room_members').select('*').eq('room_id', id).eq('user_id', req.user.id).eq('status', 'invited').single();
      if (inv) { const { data: room } = await supabase.from('deal_rooms').select('id, title, kind').eq('id', id).single(); return res.json({ invitation: { ...inv, role_label: ROLES[inv.role] || 'Adviser' }, room }); }
      return fail(res);
    }
    const chans = channelsFor(r);
    const ids = [...new Set(r.ms.map(m => m.user_id).filter(Boolean).concat(r.ms.map(m => m.invited_by).filter(Boolean)))];
    const [{ data: users }, { data: msgs }, { data: jobs }] = await Promise.all([
      ids.length ? supabase.from('users').select('id, first_name, last_name, avatar_url, role').in('id', ids) : { data: [] },
      supabase.from('deal_room_messages').select('*').eq('room_id', r.room.id).in('channel', chans).order('created_at', { ascending: true }).limit(800),
      supabase.from('deal_room_jobs').select('*').eq('room_id', r.room.id).in('side', chans.filter(x => x !== 'shared'))
    ]);
    const U = Object.fromEntries((users || []).map(u => [u.id, u]));
    const people = r.ms.filter(m => m.status !== 'removed').map(m => ({
      id: m.id, user_id: m.user_id, side: m.side, role: m.role, role_label: m.role === 'party' ? 'Party' : (m.label || ROLES[m.role] || 'Adviser'), status: m.status,
      name: m.user_id ? fullName(U[m.user_id]) : (m.invite_email ? m.invite_email.replace(/(.{2}).*(@.*)/, '$1…$2') : 'Invited'), avatar_url: m.user_id ? U[m.user_id]?.avatar_url || null : null,
      invited_by: m.invited_by ? fullName(U[m.invited_by]) : null
    }));
    const files = (r.room.files || []).map((f, i) => ({ index: i, name: f.name, size: f.size, at: f.at, channel: f.channel, uploaded_by: f.uploaded_by ? fullName(U[f.uploaded_by]) : '' })).filter(f => chans.includes(f.channel));
    let deal = null;
    if (r.room.kind === 'licence') deal = { link: `/licence?id=${r.room.ref_id}`, label: 'Open the licence deal' };
    else if (r.room.kind === 'business') deal = { link: `/expansion?id=${r.room.ref_id}`, label: 'Open the expansion deal' };
    else deal = { link: `/idea?id=${r.room.ref_id}`, label: 'Open the listing' };
    res.json({
      room: { id: r.room.id, title: r.room.title, kind: r.room.kind, status: r.room.status, created_at: r.room.created_at },
      me: r.mine ? { side: r.mine.side, role: r.mine.role, member_id: r.mine.id } : { admin: true },
      side_names: { a: r.room.kind === 'licence' ? 'Owner (licensor)' : r.room.kind === 'business' ? 'Business owner' : 'Owner / seller', b: r.room.kind === 'licence' ? 'Licensee' : r.room.kind === 'business' ? 'Other party' : 'Buyer' },
      people, files, deal, fee_rate: FEE_RATE, payments_open: c.payments.purchasesOpen(), roles: ROLES,
      jobs: (jobs || []).map(j => ({ ...j, adviser_name: fullName(U[j.adviser_id]), client_name: fullName(U[j.client_id]) })),
      messages: (msgs || []).map(m => ({ id: m.id, channel: m.channel, from_id: m.from_id, from: m.from_id ? fullName(U[m.from_id]) : null, text: m.text, system: !!m.system, created_at: m.created_at }))
    });
  });

  app.post('/api/rooms/:id/messages', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.room || r.admin) return fail(res);
    const channel = req.body?.channel === 'side' ? r.mine.side : 'shared';
    const text = txt(req.body?.text, 4000);
    if (!text) return res.status(400).json({ error: 'Write a message.' });
    const { data, error } = await supabase.from('deal_room_messages').insert([{ room_id: r.room.id, channel, from_id: req.user.id, text }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('deal_rooms').update({ updated_at: new Date().toISOString() }).eq('id', r.room.id);
    await notifyRoom(r, channel, { type: 'deal_room_message', title: channel === 'shared' ? '💬 New message in a deal room' : '🔒 New private message from your side', message: `${fullName(r.u)}: ${text.slice(0, 90)}${text.length > 90 ? '…' : ''}` }, req.user.id);
    res.status(201).json(data);
  });

  // Files (shared or own side only)
  app.post('/api/rooms/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
    const r = await load(req); if (!r.room || r.admin) return fail(res);
    if (!req.file) return res.status(400).json({ error: 'Choose a file (up to 10 MB).' });
    if (!/^(application\/pdf|image\/(png|jpe?g|webp)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))|application\/vnd\.ms-excel|text\/(plain|csv))$/.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload a PDF, Word, Excel, image, CSV or text file.' });
    const files = Array.isArray(r.room.files) ? r.room.files : [];
    if (files.length >= 60) return res.status(400).json({ error: 'This room already has 60 files.' });
    const channel = req.body?.channel === 'side' ? r.mine.side : 'shared';
    const safe = String(req.file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `room-${r.room.id}/${channel}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const entry = { path, name: safe, size: req.file.size, channel, uploaded_by: req.user.id, at: new Date().toISOString() };
    await supabase.from('deal_rooms').update({ files: [...files, entry], updated_at: entry.at }).eq('id', r.room.id);
    await c.log(r.room.id, channel, `${fullName(r.u)} added a file: ${safe}`);
    res.status(201).json({ index: files.length, name: safe, channel });
  });
  app.get('/api/rooms/:id/files/:index', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.room) return fail(res);
    const f = (r.room.files || [])[parseInt(req.params.index, 10)];
    if (!f || !channelsFor(r).includes(f.channel)) return res.status(404).json({ error: 'File not found.' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.path, 300, { download: f.name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
  });

  // Find Picela professionals to invite
  app.get('/api/rooms/advisers/search', authMiddleware, async (req, res) => {
    const q = txt(req.query.q, 60).toLowerCase();
    const { data: profs } = await supabase.from('support_profiles').select('user_id, role, tagline, home_country');
    const ids = (profs || []).map(p => p.user_id);
    if (!ids.length) return res.json([]);
    const { data: users } = await supabase.from('users').select('id, first_name, last_name, avatar_url, role').in('id', ids);
    const P = Object.fromEntries((profs || []).map(p => [p.user_id, p]));
    res.json((users || []).filter(u => u.id !== req.user.id && Object.keys(ROLE_FROM_USER).includes(u.role) && (!q || fullName(u).toLowerCase().includes(q) || (P[u.id]?.tagline || '').toLowerCase().includes(q)))
      .slice(0, 12).map(u => ({ id: u.id, name: fullName(u), avatar_url: u.avatar_url || null, role: ROLE_FROM_USER[u.role], role_label: ROLES[ROLE_FROM_USER[u.role]], tagline: P[u.id]?.tagline || '', country: P[u.id]?.home_country || '' })));
  });

  // A party invites an adviser to their own side (Picela user, or by email)
  app.post('/api/rooms/:id/invite', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.room || r.admin) return fail(res);
    if (!isParty(r)) return res.status(403).json({ error: 'Only the parties can invite advisers.' });
    const active = r.ms.filter(m => m.status !== 'removed');
    if (active.length >= MAX_MEMBERS) return res.status(400).json({ error: `A deal room can have up to ${MAX_MEMBERS} people.` });
    const role = ROLES[req.body?.role] ? req.body.role : 'other';
    const label = txt(req.body?.label, 60) || null;
    const userId = parseInt(req.body?.user_id, 10) || null;
    const email = txt(req.body?.email, 160).toLowerCase();
    const sideName = r.mine.side === 'a' ? 'the owner' : (r.room.kind === 'licence' ? 'the licensee' : r.room.kind === 'business' ? 'the other party' : 'the buyer');
    let row;
    if (userId) {
      if (active.some(m => m.user_id === userId)) return res.status(400).json({ error: 'That person is already in this room.' });
      const { data: u } = await supabase.from('users').select('id, first_name, last_name, email').eq('id', userId).single();
      if (!u) return res.status(404).json({ error: 'User not found.' });
      row = { room_id: r.room.id, user_id: userId, side: r.mine.side, role, label, status: 'invited', invited_by: req.user.id };
      const { error } = await supabase.from('deal_room_members').insert([row]);
      if (error) return res.status(500).json({ error: error.message });
      await escrow.notify(userId, { type: 'deal_room_invite', title: '🤝 You were invited to a deal room', message: `${fullName(r.u)} invited you as their ${(label || ROLES[role]).toLowerCase()} on "${r.room.title}".`, link: `/deal-room?id=${r.room.id}` });
      await escrow.emailUser(userId, `Invitation: be ${fullName(r.u)}'s ${(label || ROLES[role]).toLowerCase()}`, 'You were invited to a deal room',
        `<strong style="color:#f0ede8;">${escrow.esc(fullName(r.u))}</strong> wants you to advise them, as ${escrow.esc(sideName)}, on <strong>"${escrow.esc(r.room.title)}"</strong>.<br><br>Accept to see the deal room, talk privately with your client, and quote for your work through Picela escrow.`, 'Open invitation', `/deal-room?id=${r.room.id}`);
    } else if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      if (active.some(m => m.invite_email === email)) return res.status(400).json({ error: 'That email was already invited.' });
      const token = crypto.randomBytes(24).toString('hex');
      row = { room_id: r.room.id, user_id: null, invite_email: email, invite_token: token, invite_expires: new Date(Date.now() + 14 * DAY).toISOString(), side: r.mine.side, role, label, status: 'invited', invited_by: req.user.id };
      const { error } = await supabase.from('deal_room_members').insert([row]);
      if (error) return res.status(500).json({ error: error.message });
      if (sendEmail) await sendEmail(email, `${fullName(r.u)} invited you to advise on a deal`, escrow.emailShell('You were invited to a deal room',
        `<strong style="color:#f0ede8;">${escrow.esc(fullName(r.u))}</strong> wants you as their ${escrow.esc((label || ROLES[role]).toLowerCase())} on <strong>"${escrow.esc(r.room.title)}"</strong> on Picela.<br><br>Sign in or create a free account with this link to join. The invitation expires in 14 days.`,
        'Accept invitation', `/deal-room?id=${r.room.id}&invite=${token}`));
    } else return res.status(400).json({ error: 'Choose a Picela professional or enter a valid email.' });
    const what = (label || ROLES[role]).toLowerCase();
    await c.log(r.room.id, 'shared', `${fullName(r.u)} invited ${userId ? (/^[aeiou]/.test(what) ? 'an' : 'a') : 'an outside'} ${what} to advise their side.`);
    await notifyRoom(r, 'shared', { type: 'deal_room', title: 'Adviser invited', message: `${fullName(r.u)} invited their ${(label || ROLES[role]).toLowerCase()} to "${r.room.title}".` }, req.user.id);
    res.status(201).json({ ok: true });
  });

  // Accept an invitation (Picela user invite, or an email link with token)
  app.post('/api/rooms/:id/accept', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const token = txt(req.body?.token, 80);
    let { data: inv } = token
      ? await supabase.from('deal_room_members').select('*').eq('room_id', id).eq('invite_token', token).eq('status', 'invited').single()
      : await supabase.from('deal_room_members').select('*').eq('room_id', id).eq('user_id', req.user.id).eq('status', 'invited').single();
    if (!inv) return res.status(404).json({ error: 'This invitation is no longer valid.' });
    if (token && inv.invite_expires && new Date(inv.invite_expires) < new Date()) return res.status(400).json({ error: 'This invitation has expired. Ask for a new one.' });
    const { data: dupe } = await supabase.from('deal_room_members').select('id').eq('room_id', id).eq('user_id', req.user.id).eq('status', 'active');
    if (dupe && dupe.length) return res.status(400).json({ error: 'You are already in this room.' });
    const { data: rows } = await supabase.from('deal_room_members').update({ user_id: req.user.id, status: 'active', invite_token: null, joined_at: new Date().toISOString() }).eq('id', inv.id).eq('status', 'invited').select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'This invitation was already used.' });
    const { data: u } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
    const { data: room } = await supabase.from('deal_rooms').select('title, kind').eq('id', id).single();
    const whose = inv.side === 'a' ? "the owner's" : room?.kind === 'licence' ? "the licensee's" : room?.kind === 'business' ? "the other party's" : "the buyer's";
    await c.log(id, 'shared', `${fullName(u)} joined as ${whose} ${(inv.label || ROLES[inv.role] || 'adviser').toLowerCase()}.`);
    if (inv.invited_by) await escrow.notify(inv.invited_by, { type: 'deal_room', title: '✅ Your adviser joined', message: `${fullName(u)} joined the deal room for "${room?.title || ''}".`, link: `/deal-room?id=${id}` });
    res.json({ ok: true });
  });
  app.post('/api/rooms/:id/decline-invite', authMiddleware, async (req, res) => {
    const { data: rows } = await supabase.from('deal_room_members').update({ status: 'removed' }).eq('room_id', parseInt(req.params.id, 10)).eq('user_id', req.user.id).eq('status', 'invited').select();
    if (!rows || !rows.length) return res.status(404).json({ error: 'No invitation found.' });
    if (rows[0].invited_by) await escrow.notify(rows[0].invited_by, { type: 'deal_room', title: 'Invitation declined', message: 'An adviser you invited declined.', link: `/deal-room?id=${rows[0].room_id}` });
    res.json({ ok: true });
  });

  // Remove an adviser (a party removes their own side's adviser; an adviser can leave)
  app.post('/api/rooms/:id/members/:mid/remove', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.room || r.admin) return fail(res);
    const m = r.ms.find(x => x.id === parseInt(req.params.mid, 10));
    if (!m || m.role === 'party' || m.status === 'removed') return res.status(400).json({ error: 'Cannot remove this person.' });
    const self = m.user_id === req.user.id;
    if (!self && !(isParty(r) && m.side === r.mine.side)) return res.status(403).json({ error: 'You can only remove advisers on your own side.' });
    const { data: open } = await supabase.from('deal_room_jobs').select('id').eq('room_id', r.room.id).eq('adviser_id', m.user_id || 0).in('status', ['in_progress', 'delivered', 'disputed']);
    if (open && open.length) return res.status(400).json({ error: 'This adviser has paid work in progress. Finish or settle it first.' });
    await supabase.from('deal_room_members').update({ status: 'removed', invite_token: null }).eq('id', m.id);
    await c.log(r.room.id, 'shared', self ? `${fullName(r.u)} left the room.` : `${fullName(r.u)} removed an adviser from their side.`);
    res.json({ ok: true });
  });

  // ── Paid adviser work (escrow) ──
  app.post('/api/rooms/:id/jobs', authMiddleware, async (req, res) => {
    const r = await load(req); if (!r.room || r.admin) return fail(res);
    if (isParty(r)) return res.status(403).json({ error: 'Only advisers send quotes.' });
    const client = r.ms.find(m => m.side === r.mine.side && m.role === 'party' && m.status === 'active');
    const title = txt(req.body?.title, 120), scope = txt(req.body?.scope, 2000), days = parseInt(req.body?.days, 10), amount = round2(req.body?.amount);
    if (title.length < 3) return res.status(400).json({ error: 'Name the work, e.g. "Draft and negotiate the licence agreement".' });
    if (scope.length < 15) return res.status(400).json({ error: 'Describe what the fee covers.' });
    if (!(amount >= 1 && amount <= 100000)) return res.status(400).json({ error: 'Enter your fee in USD (1 to 100,000).' });
    if (!(days >= 1 && days <= 365)) return res.status(400).json({ error: 'Enter the days you need (1 to 365).' });
    const { data: j, error } = await supabase.from('deal_room_jobs').insert([{ room_id: r.room.id, side: r.mine.side, client_id: client.user_id, adviser_id: req.user.id, title, scope, amount, days, status: 'quoted' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await c.log(r.room.id, r.mine.side, `${fullName(r.u)} sent a quote: "${title}", ${escrow.money(amount)} within ${days} days.`);
    await escrow.notify(client.user_id, { type: 'job_quote', title: '📝 Your adviser sent a quote', message: `${fullName(r.u)}: "${title}" for ${escrow.money(amount)}.`, link: `/deal-room?id=${r.room.id}` });
    res.status(201).json(j);
  });
  async function loadJob(req) {
    const r = await load(req); if (!r.room || r.admin) return {};
    const { data: j } = await supabase.from('deal_room_jobs').select('*').eq('id', parseInt(req.params.jid, 10)).eq('room_id', r.room.id).single();
    if (!j) return {};
    return { r, j, as: j.client_id === req.user.id ? 'client' : j.adviser_id === req.user.id ? 'adviser' : null };
  }
  app.post('/api/rooms/:id/jobs/:jid/:action', authMiddleware, async (req, res) => {
    const { r, j, as } = await loadJob(req);
    if (!j || !as) return fail(res);
    const action = req.params.action, now = new Date().toISOString();
    const upd = async (patch, from) => { const { data } = await supabase.from('deal_room_jobs').update({ ...patch, updated_at: now }).eq('id', j.id).in('status', from).select(); return data && data[0]; };
    try {
      if (action === 'pay') {
        if (as !== 'client') return res.status(403).json({ error: 'Only the client pays.' });
        if (j.status !== 'quoted') return res.status(400).json({ error: 'This quote cannot be paid.' });
        if (!c.payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon.', code: 'payments_closed' });
        const fee = round2(j.amount * FEE_RATE), total = round2(Number(j.amount) + fee);
        const row = await upd({ status: 'in_progress', fee, total, paid_at: now }, ['quoted']);
        if (!row) return res.status(409).json({ error: 'This changed. Refresh.' });
        const charge = await c.payments.chargeService({ userId: req.user.id, amount: total, meta: { deal_room_job_id: j.id } });
        if (!charge.ok) { await upd({ status: 'quoted', fee: null, total: null, paid_at: null }, ['in_progress']); return res.status(402).json({ error: charge.error || 'Payment failed.' }); }
        await c.log(j.room_id, j.side, `Quote "${j.title}" accepted. ${escrow.money(total)} held in escrow.`);
        await escrow.notify(j.adviser_id, { type: 'job_paid', title: '💰 Client paid into escrow', message: `"${j.title}" is paid. Start work.`, link: `/deal-room?id=${j.room_id}` });
        return res.json(row);
      }
      if (action === 'decline') {
        if (as !== 'client') return res.status(403).json({ error: 'Not allowed.' });
        const row = await upd({ status: 'cancelled' }, ['quoted']); if (!row) return res.status(400).json({ error: 'This quote cannot be declined.' });
        await c.log(j.room_id, j.side, `Quote "${j.title}" was declined.`); return res.json(row);
      }
      if (action === 'withdraw') {
        if (as !== 'adviser') return res.status(403).json({ error: 'Not allowed.' });
        const row = await upd({ status: 'cancelled' }, ['quoted']); if (!row) return res.status(400).json({ error: 'Only an unpaid quote can be withdrawn.' });
        await c.log(j.room_id, j.side, `Quote "${j.title}" was withdrawn.`); return res.json(row);
      }
      if (action === 'deliver') {
        if (as !== 'adviser') return res.status(403).json({ error: 'Only the adviser marks work delivered.' });
        const note = txt(req.body?.note, 1000);
        const row = await upd({ status: 'delivered', delivered_at: now, delivery_note: note || null }, ['in_progress']); if (!row) return res.status(400).json({ error: 'Only paid work in progress can be delivered.' });
        await c.log(j.room_id, j.side, `${fullName(r.u)} marked "${j.title}" as delivered.${note ? ' ' + note : ''}`);
        await escrow.notify(j.client_id, { type: 'job_delivered', title: '📦 Your adviser delivered', message: `"${j.title}" is done. Confirm or report a problem within ${AUTO_RELEASE_DAYS} days.`, link: `/deal-room?id=${j.room_id}` });
        return res.json(row);
      }
      if (action === 'confirm') {
        if (as !== 'client') return res.status(403).json({ error: 'Only the client confirms.' });
        const done = await c.releaseJob(j.id, 'client'); if (!done) return res.status(400).json({ error: 'This work is not waiting for confirmation.' });
        return res.json(done);
      }
      if (action === 'dispute') {
        if (as !== 'client') return res.status(403).json({ error: 'Only the client can report a problem.' });
        const reason = txt(req.body?.reason, 1500); if (reason.length < 15) return res.status(400).json({ error: 'Explain the problem (at least 15 characters).' });
        const row = await upd({ status: 'disputed', dispute_reason: reason, disputed_at: now }, ['in_progress', 'delivered']); if (!row) return res.status(400).json({ error: 'This work cannot be disputed now.' });
        await c.log(j.room_id, j.side, `A problem was reported on "${j.title}". Picela will review it.`);
        await escrow.notify(j.adviser_id, { type: 'disputed', title: '⚠️ Client reported a problem', message: `"${j.title}" is on hold while Picela reviews it.`, link: `/deal-room?id=${j.room_id}` });
        const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
        for (const ad of admins || []) await escrow.notify(ad.id, { type: 'disputed', title: '⚠️ Adviser job dispute', message: `"${j.title}" (${escrow.money(j.amount)}): ${reason.slice(0, 120)}`, link: '/admin' });
        return res.json(row);
      }
      res.status(400).json({ error: 'Unknown action.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Admin
  async function isAdmin(req) { const u = await me(req); return u?.role === 'admin'; }
  app.get('/api/admin/room-job-disputes', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabase.from('deal_room_jobs').select('*, client:client_id(first_name, last_name, email), adviser:adviser_id(first_name, last_name, email)').eq('status', 'disputed').order('disputed_at', { ascending: true });
    res.json(data || []);
  });
  app.put('/api/admin/room-jobs/:jid/resolve', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { outcome, note } = req.body || {};
    try {
      const out = outcome === 'release' ? await c.releaseJob(parseInt(req.params.jid, 10), 'admin', txt(note, 1000)) : outcome === 'refund' ? await c.refundJob(parseInt(req.params.jid, 10), txt(note, 1000)) : undefined;
      if (out === undefined) return res.status(400).json({ error: "outcome must be 'release' or 'refund'" });
      if (!out) return res.status(400).json({ error: 'Not open for a decision.' });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Used by calls.js: active members of a room
  return { members, c };
}

module.exports = { mount, core, ROLES };
