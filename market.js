// ─────────────────────────────────────────────────────────────────────────────
// market.js — marketplace extras
//   • Delivery files for idea purchases: the seller uploads the idea materials to the deal
//     (private storage, transaction_files); the buyer and admins can open them. They are the
//     record IdeaHub uses if there is a dispute.
//   • Wallet history: every money movement for the signed-in user from the payments ledger
//     (idea sales/purchases, hires, idea requests, adviser jobs, patents, refunds, payouts).
// server.js: require('./market').mount(app, { supabase, authMiddleware, escrow })
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const BUCKET = 'patent-files';
const MAX_FILES = 20;

function mount(app, { supabase, authMiddleware }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const nf = res => res.status(404).json({ error: 'Not found.' });
  async function loadTx(req) {
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', req.params.id).single();
    if (!tx) return {};
    const { data: u } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    const as = tx.seller_id === req.user.id ? 'seller' : tx.buyer_id === req.user.id ? 'buyer' : u?.role === 'admin' ? 'admin' : null;
    return { tx, as };
  }
  async function list(txId) {
    const { data } = await supabase.from('transaction_files').select('id, file_name, size, created_at').eq('transaction_id', String(txId)).order('created_at', { ascending: true });
    return data || [];
  }

  app.get('/api/transactions/:id/files', authMiddleware, async (req, res) => {
    const { tx, as } = await loadTx(req); if (!tx || !as) return nf(res);
    res.json({ files: await list(tx.id), can_upload: as === 'seller' && tx.status === 'escrow' && !tx.delivered_at, agreement: as ? { version: tx.agreement_version || null, accepted_at: tx.agreement_accepted_at || null, text: tx.agreement_text || null } : null });
  });
  app.post('/api/transactions/:id/files', authMiddleware, upload.single('file'), async (req, res) => {
    const { tx, as } = await loadTx(req); if (!tx || !as) return nf(res);
    if (as !== 'seller') return res.status(403).json({ error: 'Only the seller uploads the idea materials.' });
    if (tx.status !== 'escrow' || tx.delivered_at) return res.status(400).json({ error: 'Files can be added while the deal is in escrow, before you mark it delivered.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a file.' });
    if ((await list(tx.id)).length >= MAX_FILES) return res.status(400).json({ error: `Up to ${MAX_FILES} files per deal.` });
    const safe = String(req.file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `tx-${tx.id}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype || 'application/octet-stream', upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const { data, error } = await supabase.from('transaction_files').insert([{ transaction_id: String(tx.id), uploader_id: req.user.id, file_path: path, file_name: safe, size: req.file.size }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ id: data.id, file_name: data.file_name, size: data.size, created_at: data.created_at });
  });
  app.get('/api/transactions/:id/files/:fid', authMiddleware, async (req, res) => {
    const { tx, as } = await loadTx(req); if (!tx || !as) return nf(res);
    const { data: f } = await supabase.from('transaction_files').select('file_path, file_name').eq('id', parseInt(req.params.fid, 10)).eq('transaction_id', String(tx.id)).single();
    if (!f) return nf(res);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.file_path, 300, { download: f.file_name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
  });
  app.delete('/api/transactions/:id/files/:fid', authMiddleware, async (req, res) => {
    const { tx, as } = await loadTx(req); if (!tx || !as) return nf(res);
    if (as !== 'seller' || tx.status !== 'escrow' || tx.delivered_at) return res.status(400).json({ error: 'Files can only be removed before delivery.' });
    await supabase.from('transaction_files').delete().eq('id', parseInt(req.params.fid, 10)).eq('transaction_id', String(tx.id));
    res.json({ ok: true });
  });

  // Every money movement for me, newest first
  app.get('/api/wallet/activity', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('payments').select('id, kind, amount, status, transaction_id, withdrawal_id, meta, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(300);
    if (error) return res.status(500).json({ error: error.message });
    const label = p => {
      const m = p.meta || {};
      const what = m.hire_id ? { text: 'Hire', link: `/hire?id=${m.hire_id}` }
        : m.idea_request_id ? { text: 'Idea request', link: `/request/${m.idea_request_id}` }
        : m.deal_room_job_id ? { text: 'Adviser job', link: '/deal-room' }
        : m.patent_application_id || m.application_id ? { text: 'Patent application', link: `/patent-application?id=${m.patent_application_id || m.application_id}` }
        : m.licence_deal_id || m.licence_id ? { text: 'Licence fee', link: `/licence?id=${m.licence_deal_id || m.licence_id}` }
        : p.transaction_id ? { text: 'Idea sale', link: '/transactions' }
        : p.withdrawal_id ? { text: 'Withdrawal', link: '/transactions' } : { text: 'Payment', link: null };
      const dir = { release: 'in', refund: 'in', purchase: 'out', payout: 'out', fee: 'out' }[p.kind] || 'out';
      const verb = { release: 'Earned', refund: 'Refunded to you', purchase: 'Paid', payout: 'Withdrawn', fee: 'Fee' }[p.kind] || p.kind;
      if (p.kind === 'purchase' && p.transaction_id) what.text = 'Idea purchase';
      return { ...what, verb, dir };
    };
    res.json((data || []).map(p => ({ id: p.id, kind: p.kind, amount: Number(p.amount), created_at: p.created_at, test: !!(p.meta && p.meta.test), ...label(p) })));
  });
}

module.exports = { mount };
