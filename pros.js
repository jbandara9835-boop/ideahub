// ─────────────────────────────────────────────────────────────────────────────
// pros.js — professional verification + Virtual Manager delegated access
//
// VERIFIED BADGE: each support role must have a credential checked by an admin.
//   patent_attorney      → a verified patent-office registration (patents.js)
//   chartered_accountant → a verified accounting-body membership (CA Sri Lanka, ACCA…)
//   corporate_services   → a verified company-secretary registration OR a registered
//                          secretarial firm (company registration number)
//   virtual_manager      → a verified government ID
// support_profiles.is_verified is recalculated whenever a credential changes.
// Unverified professionals don't appear in Find Support and can't be hired
// (PRO_VERIFIED_ONLY=off shows everyone, for testing).
//
// DELEGATION: a creator can let a verified Virtual Manager they hired create and edit
// listings for them. Every action is logged and the creator is notified. Revocable.
//
// server.js:  const pros = require('./pros');  pros.mount(app, { supabase, authMiddleware, escrow });
//             pros.canManage(supabase, userId, ownerId) → true if userId may manage ownerId's listings
//             pros.refreshVerified(supabase, userId)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const BUCKET = 'patent-files';

const KINDS = {
  ca_membership: { label: 'Accounting body membership', numberLabel: 'Membership number', bodies: ['CA Sri Lanka', 'ACCA', 'CIMA', 'ICAEW', 'ICAI (India)', 'CPA Australia', 'AICPA (US CPA)', 'Other'] },
  secretary: { label: 'Registered company secretary', numberLabel: 'Secretary registration number', bodies: ['Registrar of Companies, Sri Lanka', 'Other'] },
  secretarial_firm: { label: 'Registered secretarial / corporate services firm', numberLabel: 'Company registration number', bodies: ['Registrar of Companies, Sri Lanka', 'Other'] },
  identity: { label: 'Government ID', numberLabel: 'Last 4 characters of the ID number', bodies: ['National Identity Card', 'Passport', 'Driving licence'] }
};
// Which credential kinds verify each role (any one of them is enough)
const REQUIRED = {
  patent_attorney: ['patent_registration'],
  chartered_accountant: ['ca_membership'],
  corporate_services: ['secretary', 'secretarial_firm'],
  virtual_manager: ['identity']
};
const PRO_ROLES = Object.keys(REQUIRED);
const ROLE_KINDS = { chartered_accountant: ['ca_membership', 'identity'], corporate_services: ['secretary', 'secretarial_firm', 'identity'], virtual_manager: ['identity'], patent_attorney: ['identity'] };

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';
const verifiedOnly = () => (process.env.PRO_VERIFIED_ONLY || 'on').toLowerCase() !== 'off';

async function isVerified(supabase, userId, role) {
  const need = REQUIRED[role];
  if (!need) return false;
  if (need.includes('patent_registration')) {
    const { data } = await supabase.from('patent_registrations').select('id').eq('user_id', userId).eq('status', 'verified').limit(1);
    return !!(data && data.length);
  }
  const { data } = await supabase.from('pro_credentials').select('id').eq('user_id', userId).eq('status', 'verified').in('kind', need).limit(1);
  return !!(data && data.length);
}
async function refreshVerified(supabase, userId) {
  const { data: u } = await supabase.from('users').select('role').eq('id', userId).single();
  const ok = u ? await isVerified(supabase, userId, u.role) : false;
  await supabase.from('support_profiles').update({ is_verified: ok }).eq('user_id', userId);
  return ok;
}
async function canManage(supabase, userId, ownerId) {
  if (!userId || !ownerId || userId === ownerId) return userId === ownerId;
  const { data } = await supabase.from('delegations').select('id').eq('owner_id', ownerId).eq('delegate_id', userId).eq('status', 'active').limit(1);
  return !!(data && data.length);
}
async function logDelegation(supabase, escrow, delegateId, ownerId, action, idea) {
  const { data: d } = await supabase.from('delegations').select('id').eq('owner_id', ownerId).eq('delegate_id', delegateId).eq('status', 'active').single();
  if (!d) return;
  await supabase.from('delegation_log').insert([{ delegation_id: d.id, action, idea_id: idea?.id || null, detail: idea?.title || null }]);
  const { data: vm } = await supabase.from('users').select('first_name, last_name').eq('id', delegateId).single();
  await escrow.notify(ownerId, { type: 'delegation_action', title: action === 'create' ? '📝 Your virtual manager added a listing' : '✏️ Your virtual manager edited a listing', message: `${fullName(vm)} ${action === 'create' ? 'created' : 'edited'} "${idea?.title || 'a listing'}" for you.`, link: idea?.id ? `/idea?id=${idea.id}` : '/dashboard' });
}

// Short public labels of checked credentials for a set of users: { userId: ['CA Sri Lanka member', …] }
async function badgeMap(supabase, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))], out = {};
  if (!ids.length) return out;
  const add = (id, l) => { (out[id] = out[id] || []).includes(l) || out[id].push(l); };
  const { data: regs } = await supabase.from('patent_registrations').select('user_id, office').in('user_id', ids).eq('status', 'verified');
  (regs || []).forEach(r => add(r.user_id, `${r.office} registered`));
  const { data: creds } = await supabase.from('pro_credentials').select('user_id, kind, body').in('user_id', ids).eq('status', 'verified');
  (creds || []).forEach(c => add(c.user_id, c.kind === 'identity' ? 'ID checked' : c.kind === 'ca_membership' ? `${c.body} member` : c.kind === 'secretary' ? 'Registered company secretary' : 'Registered secretarial firm'));
  return out;
}

function mount(app, { supabase, authMiddleware, escrow }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  async function me(req) { const { data } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', req.user.id).single(); return data; }
  async function isAdmin(req) { const u = await me(req); return u?.role === 'admin'; }

  // ── Credentials ──
  app.get('/api/pros/credentials', authMiddleware, async (req, res) => {
    const u = await me(req);
    const { data } = await supabase.from('pro_credentials').select('id, kind, body, number, name_on_record, status, review_note, file_name, created_at, updated_at').eq('user_id', req.user.id).order('created_at', { ascending: true });
    const verified = PRO_ROLES.includes(u?.role) ? await isVerified(supabase, req.user.id, u.role) : false;
    res.json({
      role: u?.role, is_pro: PRO_ROLES.includes(u?.role), verified, verified_only: verifiedOnly(),
      required: (REQUIRED[u?.role] || []).map(k => k === 'patent_registration' ? { kind: k, label: 'Patent-office registration', manage: '/patents' } : { kind: k, label: KINDS[k].label }),
      kinds: (ROLE_KINDS[u?.role] || []).map(k => ({ kind: k, ...KINDS[k] })),
      credentials: (data || []).map(c => ({ ...c, kind_label: (KINDS[c.kind] || {}).label || c.kind }))
    });
  });
  app.post('/api/pros/credentials', authMiddleware, upload.single('file'), async (req, res) => {
    const u = await me(req);
    if (!PRO_ROLES.includes(u?.role)) return res.status(403).json({ error: 'Only professionals add credentials.' });
    const kind = String(req.body?.kind || '');
    if (!(ROLE_KINDS[u.role] || []).includes(kind)) return res.status(400).json({ error: 'Choose a credential for your role.' });
    const body = txt(req.body?.body, 80), number = txt(req.body?.number, 60), name = txt(req.body?.name_on_record, 120);
    if (!body) return res.status(400).json({ error: 'Choose the issuing body.' });
    if (number.length < (kind === 'identity' ? 4 : 2)) return res.status(400).json({ error: `Enter the ${KINDS[kind].numberLabel.toLowerCase()}.` });
    if (kind === 'identity' && number.length > 4) return res.status(400).json({ error: 'For your ID, enter only the last 4 characters. We check the full number on the document.' });
    if (!req.file) return res.status(400).json({ error: 'Upload a clear copy of the certificate or document (PDF or image).' });
    if (!/^(application\/pdf|image\/(png|jpe?g|webp))$/.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload a PDF or an image.' });
    const safe = String(req.file.originalname || 'document').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `cred-${req.user.id}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const now = new Date().toISOString();
    const row = { body, number, name_on_record: name || fullName(u), file_path: path, file_name: safe, status: 'pending', review_note: null, updated_at: now };
    const { data: ex } = await supabase.from('pro_credentials').select('id').eq('user_id', req.user.id).eq('kind', kind).single();
    const { data, error } = ex ? await supabase.from('pro_credentials').update(row).eq('id', ex.id).select().single()
      : await supabase.from('pro_credentials').insert([{ ...row, user_id: req.user.id, kind }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await refreshVerified(supabase, req.user.id);
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const ad of admins || []) await escrow.notify(ad.id, { type: 'pro_credential', title: '🪪 Credential to check', message: `${fullName(u)}: ${KINDS[kind].label} (${body})`, link: '/admin' });
    res.status(201).json({ id: data.id, status: data.status });
  });
  app.delete('/api/pros/credentials/:cid', authMiddleware, async (req, res) => {
    await supabase.from('pro_credentials').delete().eq('id', parseInt(req.params.cid, 10)).eq('user_id', req.user.id);
    await refreshVerified(supabase, req.user.id);
    res.json({ ok: true });
  });
  app.get('/api/pros/credentials/:cid/file', authMiddleware, async (req, res) => {
    const { data: c } = await supabase.from('pro_credentials').select('user_id, file_path, file_name').eq('id', parseInt(req.params.cid, 10)).single();
    if (!c || (c.user_id !== req.user.id && !(await isAdmin(req)))) return res.status(404).json({ error: 'Not found.' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(c.file_path, 300, { download: c.file_name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
  });

  // Public: verification status of a professional (for profile pages)
  app.get('/api/pros/:userId/verification', async (req, res) => {
    const id = parseInt(req.params.userId, 10);
    const { data: u } = await supabase.from('users').select('role').eq('id', id).single();
    if (!u || !PRO_ROLES.includes(u.role)) return res.json({ verified: false });
    const verified = await isVerified(supabase, id, u.role);
    let items = [];
    if (u.role === 'patent_attorney') {
      const { data } = await supabase.from('patent_registrations').select('office, reg_number').eq('user_id', id).eq('status', 'verified');
      items = (data || []).map(r => ({ label: `Patent registration · ${r.office}`, number: r.reg_number }));
    } else {
      const { data } = await supabase.from('pro_credentials').select('kind, body, number').eq('user_id', id).eq('status', 'verified').in('kind', REQUIRED[u.role]);
      items = (data || []).map(c => ({ label: `${KINDS[c.kind].label} · ${c.body}`, number: c.kind === 'identity' ? null : c.number }));
    }
    res.json({ verified, items });
  });

  // Admin
  app.get('/api/admin/pro-credentials', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('pro_credentials').select('*, user:user_id(id, first_name, last_name, email, role, country)').order('updated_at', { ascending: false }).limit(300);
    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(c => ({ ...c, file_path: undefined, kind_label: (KINDS[c.kind] || {}).label || c.kind, number_label: (KINDS[c.kind] || {}).numberLabel || 'Number' })));
  });
  app.put('/api/admin/pro-credentials/:cid', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req))) return res.status(403).json({ error: 'Admin only' });
    const status = req.body?.status;
    if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ error: "status must be 'verified' or 'rejected'" });
    const note = txt(req.body?.note, 500);
    const { data: c, error } = await supabase.from('pro_credentials').update({ status, review_note: note || null, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() }).eq('id', parseInt(req.params.cid, 10)).select().single();
    if (error || !c) return res.status(400).json({ error: error?.message || 'Not found' });
    const ok = await refreshVerified(supabase, c.user_id);
    await escrow.notify(c.user_id, status === 'verified'
      ? { type: 'credential_verified', title: '✅ Credential verified', message: `Your ${KINDS[c.kind].label.toLowerCase()} was verified.${ok ? ' You now have the Verified badge and appear in Find Support.' : ''}`, link: '/support-profile' }
      : { type: 'credential_rejected', title: '❌ Credential not verified', message: `We couldn't verify your ${KINDS[c.kind].label.toLowerCase()}.${note ? ' ' + note : ''} You can correct it and resubmit.`, link: '/support-profile' });
    res.json({ ...c, file_path: undefined, verified: ok });
  });

  // ── Delegation (Virtual Managers) ──
  app.get('/api/delegations', authMiddleware, async (req, res) => {
    const [{ data: granted }, { data: managing }] = await Promise.all([
      supabase.from('delegations').select('*').eq('owner_id', req.user.id).eq('status', 'active'),
      supabase.from('delegations').select('*').eq('delegate_id', req.user.id).eq('status', 'active')
    ]);
    const ids = [...new Set([...(granted || []).map(d => d.delegate_id), ...(managing || []).map(d => d.owner_id)])];
    const { data: users } = ids.length ? await supabase.from('users').select('id, first_name, last_name, avatar_url').in('id', ids) : { data: [] };
    const U = Object.fromEntries((users || []).map(u => [u.id, u]));
    res.json({
      granted: (granted || []).map(d => ({ id: d.id, user_id: d.delegate_id, name: fullName(U[d.delegate_id]), since: d.created_at })),
      managing: (managing || []).map(d => ({ id: d.id, user_id: d.owner_id, name: fullName(U[d.owner_id]), since: d.created_at }))
    });
  });
  app.post('/api/delegations', authMiddleware, async (req, res) => {
    const delegateId = parseInt(req.body?.delegate_id, 10);
    if (!delegateId || delegateId === req.user.id) return res.status(400).json({ error: 'Choose your virtual manager.' });
    const { data: vm } = await supabase.from('users').select('id, role, first_name, last_name').eq('id', delegateId).single();
    if (!vm || vm.role !== 'virtual_manager') return res.status(400).json({ error: 'Only virtual managers can be given access.' });
    if (verifiedOnly() && !(await isVerified(supabase, delegateId, 'virtual_manager'))) return res.status(400).json({ error: 'This virtual manager is not verified yet.' });
    const { data: hires } = await supabase.from('hire_requests').select('id, status').eq('client_id', req.user.id).eq('support_id', delegateId);
    if (!(hires || []).some(h => !['rejected', 'cancelled', 'refunded'].includes(h.status))) return res.status(400).json({ error: 'Hire this virtual manager first.' });
    const { data: ex } = await supabase.from('delegations').select('id').eq('owner_id', req.user.id).eq('delegate_id', delegateId).eq('status', 'active');
    if (ex && ex.length) return res.json(ex[0]);
    const { data, error } = await supabase.from('delegations').insert([{ owner_id: req.user.id, delegate_id: delegateId, scope: 'listings', status: 'active' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const u = await me(req);
    await escrow.notify(delegateId, { type: 'delegation', title: '🔑 You can now manage listings', message: `${fullName(u)} gave you access to create and edit their IdeaHub listings.`, link: `/manage?owner=${req.user.id}` });
    res.status(201).json(data);
  });
  app.delete('/api/delegations/:did', authMiddleware, async (req, res) => {
    const { data: d } = await supabase.from('delegations').select('*').eq('id', parseInt(req.params.did, 10)).single();
    if (!d || ![d.owner_id, d.delegate_id].includes(req.user.id)) return res.status(404).json({ error: 'Not found.' });
    await supabase.from('delegations').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', d.id);
    const other = req.user.id === d.owner_id ? d.delegate_id : d.owner_id;
    const u = await me(req);
    await escrow.notify(other, { type: 'delegation', title: 'Listing access ended', message: `${fullName(u)} ended the listing-management access.`, link: '/dashboard' });
    res.json({ ok: true });
  });
  // The owner's activity log
  app.get('/api/delegations/:did/log', authMiddleware, async (req, res) => {
    const { data: d } = await supabase.from('delegations').select('*').eq('id', parseInt(req.params.did, 10)).single();
    if (!d || ![d.owner_id, d.delegate_id].includes(req.user.id)) return res.status(404).json({ error: 'Not found.' });
    const { data } = await supabase.from('delegation_log').select('*').eq('delegation_id', d.id).order('created_at', { ascending: false }).limit(100);
    res.json(data || []);
  });
  // Listings of a client the VM manages
  app.get('/api/delegations/owner/:ownerId/ideas', authMiddleware, async (req, res) => {
    const ownerId = parseInt(req.params.ownerId, 10);
    if (!(await canManage(supabase, req.user.id, ownerId)) || ownerId === req.user.id) return res.status(403).json({ error: 'No access.' });
    const [{ data: owner }, { data: ideas }] = await Promise.all([
      supabase.from('users').select('id, first_name, last_name').eq('id', ownerId).single(),
      supabase.from('ideas').select('id, title, status, price, views, created_at').eq('creator_id', ownerId).order('created_at', { ascending: false })
    ]);
    res.json({ owner: { id: ownerId, name: fullName(owner) }, ideas: ideas || [] });
  });
}

module.exports = { mount, badgeMap, refreshVerified, isVerified, canManage, logDelegation, PRO_ROLES, REQUIRED, KINDS, verifiedOnly };
