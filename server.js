require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', { etag: false, maxAge: 0 }));

// ── SUPABASE CLIENT ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
// ── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});
app.get('/signup', (req, res) => {
  res.sendFile(__dirname + '/public/signup.html');
});
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});
app.get('/submit', (req, res) => {
  res.sendFile(__dirname + '/public/submit.html');
});
app.get('/profile', (req, res) => {
  res.sendFile(__dirname + '/public/profile.html');
});
app.get('/messages', (req, res) => {
  res.sendFile(__dirname + '/public/messages.html');
});
app.get('/transactions', (req, res) => {
  res.sendFile(__dirname + '/public/transactions.html');
});
app.get('/browse', (req, res) => {
  res.sendFile(__dirname + '/public/browse.html');
});
app.get('/idea/:id', (req, res) => {
  res.sendFile(__dirname + '/public/idea.html');
});
app.get('/buyer-dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/buyer-dashboard.html');
});
app.get('/support-profile', (req, res) => {
  res.sendFile(__dirname + '/public/support-profile.html');
});
app.get('/find-support', (req, res) => {
  res.sendFile(__dirname + '/public/find-support.html');
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
// ── SUPPORT PROFILES ─────────────────────────────────────────

// GET support profile for current user
app.get('/api/support/profile', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('support_profiles')
    .select('*')
    .eq('user_id', req.user.id)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// CREATE or UPDATE support profile
app.post('/api/support/profile', authMiddleware, async (req, res) => {
  const { tagline, hourly_rate, availability, experience_years, languages, home_country, service_type, allowed_countries, restricted_countries } = req.body;

  const { data: user } = await supabase.from('users').select('role').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data: existing } = await supabase.from('support_profiles').select('id').eq('user_id', req.user.id).single();

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('support_profiles')
      .update({ tagline, hourly_rate, availability, experience_years, languages, home_country, service_type, allowed_countries, restricted_countries, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    result = data;
  } else {
    const { data, error } = await supabase
      .from('support_profiles')
      .insert([{ user_id: req.user.id, role: user.role, tagline, hourly_rate, availability, experience_years, languages, home_country, service_type, allowed_countries, restricted_countries }])
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    result = data;
  }
  res.json(result);
});

// GET all support roles (browse page) — public
app.get('/api/support/browse', async (req, res) => {
  let query = supabase
    .from('support_profiles')
    .select('*, users(id, first_name, last_name, email, role, verified)')
    .eq('availability', 'available');

  if (req.query.role) query = query.eq('role', req.query.role);
  if (req.query.country) query = query.eq('home_country', req.query.country);
  if (req.query.verified === 'true') query = query.eq('is_verified', true);

  const { data, error } = await query.order('avg_rating', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET single support profile by user_id — public
app.get('/api/support/profile/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('support_profiles')
    .select('*, users(id, first_name, last_name, email, role, country, bio)')
    .eq('user_id', req.params.userId)
    .single();
  if (!data || error) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

// CHECK country restriction before hiring
app.post('/api/support/check-restriction', authMiddleware, async (req, res) => {
  const { support_user_id, client_country } = req.body;

  const { data: profile } = await supabase
    .from('support_profiles')
    .select('service_type, allowed_countries, restricted_countries, home_country')
    .eq('user_id', support_user_id)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  let warning = null;
  let blocked = false;

  if (profile.service_type === 'specific_countries') {
    if (profile.allowed_countries && !profile.allowed_countries.includes(client_country)) {
      warning = `This professional only serves: ${profile.allowed_countries.join(', ')}. Your country (${client_country}) is not in their service area.`;
      blocked = true;
    }
  } else if (profile.service_type === 'restricted_countries') {
    if (profile.restricted_countries && profile.restricted_countries.includes(client_country)) {
      warning = `This professional does not serve ${client_country} due to restrictions.`;
      blocked = true;
    }
  }

  res.json({ warning, blocked, service_type: profile.service_type });
});

// ── CERTIFICATES ──────────────────────────────────────────────

// GET my certificates
app.get('/api/certificates', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('certificates')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ADD certificate (file upload handled by frontend via Supabase Storage)
app.post('/api/certificates', authMiddleware, async (req, res) => {
  const { title, issuer, issued_year, file_url, file_name } = req.body;
  if (!title || !file_url) return res.status(400).json({ error: 'Title and file are required' });

  const { data, error } = await supabase
    .from('certificates')
    .insert([{ user_id: req.user.id, title, issuer, issued_year, file_url, file_name, status: 'pending' }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE certificate
app.delete('/api/certificates/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('certificates')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Certificate deleted' });
});

// ADMIN: approve or reject certificate
app.put('/api/admin/certificates/:id', authMiddleware, async (req, res) => {
  const { status, reject_reason } = req.body;
  const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
  if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const updateData = { status };
  if (status === 'approved') updateData.verified_at = new Date().toISOString();
  if (status === 'rejected') updateData.reject_reason = reject_reason;

  const { data, error } = await supabase
    .from('certificates')
    .update(updateData)
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET Supabase storage upload URL for certificates
app.post('/api/certificates/upload-url', authMiddleware, async (req, res) => {
  const { fileName, fileType } = req.body;
  const filePath = `${req.user.id}/${Date.now()}_${fileName}`;

  const { data, error } = await supabase.storage
    .from('certificates')
    .createSignedUploadUrl(filePath);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ uploadUrl: data.signedUrl, filePath, token: data.token });
});

// ── HIRE REQUESTS ─────────────────────────────────────────────

// CREATE hire request
app.post('/api/hire', authMiddleware, async (req, res) => {
  const { support_id, idea_id, title, description, budget, deadline, country } = req.body;
  if (!support_id || !title) return res.status(400).json({ error: 'Support ID and title are required' });

  // Check country restriction
  const { data: profile } = await supabase
    .from('support_profiles')
    .select('service_type, allowed_countries, restricted_countries')
    .eq('user_id', support_id)
    .single();

  let country_warning = false;
  let warning_message = null;

  if (profile && country) {
    if (profile.service_type === 'specific_countries' && profile.allowed_countries && !profile.allowed_countries.includes(country)) {
      country_warning = true;
      warning_message = `Note: This professional primarily serves ${profile.allowed_countries.join(', ')}`;
    } else if (profile.service_type === 'restricted_countries' && profile.restricted_countries && profile.restricted_countries.includes(country)) {
      country_warning = true;
      warning_message = `Note: This professional has restrictions for ${country}`;
    }
  }

  const { data: supportUser } = await supabase.from('users').select('role').eq('id', support_id).single();

  const { data, error } = await supabase
    .from('hire_requests')
    .insert([{ client_id: req.user.id, support_id, idea_id: idea_id || null, role: supportUser?.role || 'support', title, description, budget, deadline, country, country_warning, warning_message, status: 'pending' }])
    .select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Update total_jobs count
  await supabase.from('support_profiles').update({ total_jobs: supabase.rpc('increment', { x: 1 }) }).eq('user_id', support_id);

  res.status(201).json(data);
});

// GET my hire requests (as client)
app.get('/api/hire/my-requests', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('hire_requests')
    .select('*, support:support_id(id, first_name, last_name, role)')
    .eq('client_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET incoming hire requests (as support role)
app.get('/api/hire/incoming', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('hire_requests')
    .select('*, client:client_id(id, first_name, last_name, role)')
    .eq('support_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// UPDATE hire request status (accept/reject/complete)
app.put('/api/hire/:id/status', authMiddleware, async (req, res) => {
  const { status, cancel_reason } = req.body;
  const { data: hire } = await supabase.from('hire_requests').select('*').eq('id', req.params.id).single();
  if (!hire) return res.status(404).json({ error: 'Hire request not found' });

  const isClient = hire.client_id === req.user.id;
  const isSupport = hire.support_id === req.user.id;
  if (!isClient && !isSupport) return res.status(403).json({ error: 'Not authorized' });

  const updateData = { status, updated_at: new Date().toISOString() };
  if (status === 'completed') {
    updateData.completed_at = new Date().toISOString();
    await supabase.from('support_profiles')
      .update({ completed_jobs: supabase.rpc('increment', { x: 1 }) })
      .eq('user_id', hire.support_id);
  }
  if (status === 'cancelled') {
    updateData.cancelled_at = new Date().toISOString();
    updateData.cancel_reason = cancel_reason || '';
  }

  const { data, error } = await supabase
    .from('hire_requests')
    .update(updateData)
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── HIRE MESSAGES ─────────────────────────────────────────────

// GET messages for a hire request
app.get('/api/hire/:id/messages', authMiddleware, async (req, res) => {
  const { data: hire } = await supabase.from('hire_requests').select('client_id, support_id').eq('id', req.params.id).single();
  if (!hire) return res.status(404).json({ error: 'Not found' });
  if (hire.client_id !== req.user.id && hire.support_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  const { data, error } = await supabase
    .from('hire_messages')
    .select('*')
    .eq('hire_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST message in a hire request
app.post('/api/hire/:id/messages', authMiddleware, async (req, res) => {
  const { text, file_url, file_name } = req.body;
  if (!text) return res.status(400).json({ error: 'Message text required' });

  const { data: hire } = await supabase.from('hire_requests').select('client_id, support_id').eq('id', req.params.id).single();
  if (!hire) return res.status(404).json({ error: 'Not found' });
  if (hire.client_id !== req.user.id && hire.support_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  const { data, error } = await supabase
    .from('hire_messages')
    .insert([{ hire_id: parseInt(req.params.id), from_id: req.user.id, text, file_url: file_url || null, file_name: file_name || null }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── RATINGS ───────────────────────────────────────────────────

// SUBMIT a rating
app.post('/api/ratings', authMiddleware, async (req, res) => {
  const { hire_id, rated_user_id, stars, review } = req.body;
  if (!hire_id || !rated_user_id || !stars) return res.status(400).json({ error: 'hire_id, rated_user_id and stars are required' });
  if (stars < 1 || stars > 5) return res.status(400).json({ error: 'Stars must be between 1 and 5' });

  const { data: hire } = await supabase.from('hire_requests').select('*').eq('id', hire_id).single();
  if (!hire) return res.status(404).json({ error: 'Hire request not found' });
  if (hire.status !== 'completed') return res.status(400).json({ error: 'Can only rate completed jobs' });
  if (hire.client_id !== req.user.id) return res.status(403).json({ error: 'Only the client can rate' });

  const { data, error } = await supabase
    .from('ratings')
    .insert([{ hire_id, rated_user_id, rater_user_id: req.user.id, stars, review }])
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'You have already rated this job' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// GET ratings for a support role
app.get('/api/ratings/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('ratings')
    .select('*, rater:rater_user_id(first_name, last_name)')
    .eq('rated_user_id', req.params.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});