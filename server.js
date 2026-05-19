require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── SUPABASE CLIENT ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});
app.get('/api/test', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('count');
    res.json({ supabase: 'connected', data, error });
  } catch(e) {
    res.json({ supabase: 'failed', error: e.message });
  }
});
// ── HELPER: verify JWT token ─────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

// SIGNUP
app.post('/api/auth/signup', async (req, res) => {
  const { firstName, lastName, email, password, role } = req.body;
  if (!firstName || !email || !password) {
    return res.status(400).json({ error: 'First name, email and password are required' });
  }

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);

  const { data: user, error } = await supabase
    .from('users')
    .insert([{
      first_name: firstName,
      last_name: lastName || '',
      email,
      password: hashed,
      role: role || 'idea_creator',
      earnings: 0,
      verified: false,
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const { password: _, ...safeUser } = user;
  res.json({ token, user: { ...safeUser, firstName: user.first_name, lastName: user.last_name } });
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user || error) return res.status(400).json({ error: 'No account found with this email' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: 'Incorrect password' });

  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const { password: _, ...safeUser } = user;
  res.json({ token, user: { ...safeUser, firstName: user.first_name, lastName: user.last_name } });
});

// GET current user profile
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', req.user.id)
    .single();

  if (!user || error) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safeUser } = user;
  res.json({ ...safeUser, firstName: user.first_name, lastName: user.last_name });
});

// UPDATE profile
app.put('/api/auth/me', authMiddleware, async (req, res) => {
  const { firstName, lastName, country, city, bio, specializations, qual, phone } = req.body;

  const { data: user, error } = await supabase
    .from('users')
    .update({ first_name: firstName, last_name: lastName, country, city, bio, specializations, qual, phone })
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  const { password: _, ...safeUser } = user;
  res.json({ ...safeUser, firstName: user.first_name, lastName: user.last_name });
});

// ── IDEAS ─────────────────────────────────────────────────────────────────────

// GET all ideas
app.get('/api/ideas', async (req, res) => {
  let query = supabase.from('ideas').select('*').eq('status', 'live');

  if (req.query.industry && req.query.industry !== 'all') {
    query = query.eq('industry', req.query.industry);
  }
  if (req.query.search) {
    query = query.ilike('title', `%${req.query.search}%`);
  }
  if (req.query.level) {
    query = query.eq('level', parseInt(req.query.level));
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET single idea
app.get('/api/ideas/:id', async (req, res) => {
  const { data: idea, error } = await supabase
    .from('ideas')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!idea || error) return res.status(404).json({ error: 'Idea not found' });
  await supabase.from('ideas').update({ views: (idea.views || 0) + 1 }).eq('id', idea.id);
  res.json(idea);
});

// POST new idea
app.post('/api/ideas', authMiddleware, async (req, res) => {
    console.log('POST /api/ideas called by user:', req.user.id);
  console.log('Body:', req.body);
  const { title, summary, desc, industry, ideaType, price, level, visibility, engLevel, hasPatent, patentNumber } = req.body;
  if (!title || !industry || !price) return res.status(400).json({ error: 'Title, industry and price are required' });

  const { data: user } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();

  const { data: idea, error } = await supabase
    .from('ideas')
    .insert([{
      title, summary,
      description: desc,
      industry,
      idea_type: ideaType || 'New Business Idea',
      price: parseFloat(price),
      level: parseInt(level) || 1,
      visibility: parseInt(visibility) || 1,
      eng_level: engLevel || 0,
      has_patent: hasPatent || false,
      patent_number: patentNumber || '',
      icon: '💡',
      creator_id: req.user.id,
      creator_name: user ? `${user.first_name} ${user.last_name}` : 'Unknown',
      status: 'live',
      views: 0,
      inquiries: 0,
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(idea);
});

// GET my ideas
app.get('/api/my-ideas', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('ideas')
    .select('*')
    .eq('creator_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// DELETE idea
app.delete('/api/ideas/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('ideas')
    .delete()
    .eq('id', req.params.id)
    .eq('creator_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Idea deleted' });
});

// ── TRANSACTIONS ─────────────────────────────────────────────────────────────

app.post('/api/transactions', authMiddleware, async (req, res) => {
  const { ideaId, paymentMethod } = req.body;
  const { data: idea } = await supabase.from('ideas').select('*').eq('id', ideaId).single();
  if (!idea) return res.status(404).json({ error: 'Idea not found' });

  const fee = Math.round(idea.price * 0.08);
  const { data: tx, error } = await supabase
    .from('transactions')
    .insert([{
      idea_id: idea.id, idea_title: idea.title,
      buyer_id: req.user.id, seller_id: idea.creator_id,
      amount: idea.price, fee, total: idea.price + fee,
      payment_method: paymentMethod || 'card', status: 'escrow',
    }])
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('ideas').update({ status: 'escrow' }).eq('id', idea.id);
  res.status(201).json(tx);
});

app.put('/api/transactions/:id/confirm', authMiddleware, async (req, res) => {
  const { data: tx } = await supabase.from('transactions').select('*').eq('id', req.params.id).single();
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm' });

  const { data: updated, error } = await supabase
    .from('transactions')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', tx.id).select().single();

  if (error) return res.status(500).json({ error: error.message });

  const { data: seller } = await supabase.from('users').select('earnings').eq('id', tx.seller_id).single();
  await supabase.from('users').update({ earnings: (seller?.earnings || 0) + tx.amount }).eq('id', tx.seller_id);
  await supabase.from('ideas').update({ status: 'sold' }).eq('id', tx.idea_id);
  res.json(updated);
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions').select('*')
    .or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── MESSAGES ─────────────────────────────────────────────────────────────────

app.get('/api/messages', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*')
    .or(`from_id.eq.${req.user.id},to_id.eq.${req.user.id}`)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  const { toId, text, ideaId } = req.body;
  if (!toId || !text) return res.status(400).json({ error: 'toId and text required' });
  const { data, error } = await supabase
    .from('messages')
    .insert([{ from_id: req.user.id, to_id: parseInt(toId), text, idea_id: ideaId || null }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── PATENTS ──────────────────────────────────────────────────────────────────

app.post('/api/patents', authMiddleware, async (req, res) => {
  const { title, type, jurisdiction, statement } = req.body;
  const { data, error } = await supabase
    .from('patents')
    .insert([{
      id: 'IH-' + Date.now(),
      user_id: req.user.id, title,
      type: type || 'Provisional',
      jurisdiction: jurisdiction || 'USPTO',
      statement, status: 'Application Received', number: 'Pending',
    }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.get('/api/patents', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('patents').select('*').eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const [ideasRes, txRes, userRes] = await Promise.all([
    supabase.from('ideas').select('*').eq('creator_id', req.user.id),
    supabase.from('transactions').select('*').eq('seller_id', req.user.id).eq('status', 'completed'),
    supabase.from('users').select('earnings').eq('id', req.user.id).single(),
  ]);

  const ideas = ideasRes.data || [];
  res.json({
    ideasPosted: ideas.length,
    totalViews: ideas.reduce((s, i) => s + (i.views || 0), 0),
    inquiries: ideas.reduce((s, i) => s + (i.inquiries || 0), 0),
    earnings: userRes.data?.earnings || 0,
    ideas,
    recentTransactions: txRes.data || [],
  });
});

// ── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  IdeaHub backend running with Supabase!');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  🗄️   Database: ${process.env.SUPABASE_URL}`);
  console.log('');
});
