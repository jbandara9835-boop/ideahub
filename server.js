require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
// ── IN-MEMORY DATABASE (we'll replace with Supabase later) ──────────────────
const DB = {
  users: [
    {
      id: 1,
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@demo.com',
      password: bcrypt.hashSync('demo', 10),
      role: 'idea_creator',
      country: 'Sri Lanka',
      city: 'Colombo',
      bio: 'Passionate innovator with 8+ years in tech.',
      specializations: ['Technology & Engineering', 'Healthcare'],
      earnings: 3400,
      verified: true,
    },
  ],
  ideas: [
    { id: 1, title: 'AI-Powered Crop Disease Scanner', creatorId: 1, creator: 'Priya M.', industry: 'Technology & Engineering', summary: 'A mobile app using computer vision to detect plant diseases in real-time.', desc: 'Using transfer learning on 58,000 plant images, this app identifies 38 disease classes with 96% accuracy — even offline.', price: 4500, level: 2, icon: '🌾', status: 'live', views: 1240, inquiries: 8 },
    { id: 2, title: 'Micro-Lending via Blockchain', creatorId: 1, creator: 'Carlos R.', industry: 'Business & Finance', summary: 'Blockchain-based micro-lending connecting SMEs with global investors.', desc: 'A permissioned blockchain tracks all loan agreements and repayments in real-time via smart contracts.', price: 12000, level: 3, icon: '💳', status: 'live', views: 3400, inquiries: 21 },
    { id: 3, title: 'Solar-Powered Cold Storage', creatorId: 1, creator: 'Amara N.', industry: 'Technology & Engineering', summary: 'Off-grid cold storage using solar energy for rural farmers.', desc: '500L insulated container keeps produce at 4°C for 36 hours without grid electricity.', price: 8200, level: 3, icon: '❄️', status: 'live', views: 2100, inquiries: 14 },
    { id: 4, title: 'Hyper-Local Freelance App', creatorId: 1, creator: 'Jake T.', industry: 'Social media, Internet and Digital Services', summary: 'Neighborhood-based platform for local service providers.', desc: 'Uses geofencing to limit listings to 5km radius, enabling same-day services.', price: 2800, level: 1, icon: '📱', status: 'live', views: 870, inquiries: 5 },
    { id: 5, title: 'AI Nutritionist for Budget Meals', creatorId: 1, creator: 'Nina L.', industry: 'Healthcare & wellness', summary: 'App generating nutritious meal plans within a budget.', desc: 'Integrates with local grocery APIs to provide real-time pricing and culturally relevant meals.', price: 3300, level: 2, icon: '🥗', status: 'live', views: 1560, inquiries: 9 },
    { id: 6, title: 'Restaurant Food-Waste Exchange', creatorId: 1, creator: 'Tom H.', industry: 'Food & Culinary', summary: 'B2B platform for restaurants to sell surplus ingredients.', desc: 'A 2-hour-window marketplace where restaurants list surplus at 70% discount.', price: 5100, level: 2, icon: '🍽️', status: 'live', views: 1980, inquiries: 12 },
  ],
  transactions: [],
  messages: [],
  patents: [],
};

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

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Health check


// ── AUTH ─────────────────────────────────────────────────────────────────────

// SIGNUP
app.post('/api/auth/signup', async (req, res) => {
  const { firstName, lastName, email, password, role } = req.body;
  if (!firstName || !email || !password) {
    return res.status(400).json({ error: 'First name, email and password are required' });
  }
  if (DB.users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now(),
    firstName,
    lastName: lastName || '',
    email,
    password: hashed,
    role: role || 'idea_creator',
    country: '',
    city: '',
    bio: '',
    specializations: [],
    earnings: 0,
    verified: false,
  };
  DB.users.push(user);
  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const { password: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = DB.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'No account found with this email' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: 'Incorrect password' });
  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const { password: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// GET current user profile
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = DB.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// UPDATE profile
app.put('/api/auth/me', authMiddleware, (req, res) => {
  const idx = DB.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const allowed = ['firstName', 'lastName', 'country', 'city', 'bio', 'specializations', 'qual', 'phone'];
  allowed.forEach(k => { if (req.body[k] !== undefined) DB.users[idx][k] = req.body[k]; });
  const { password: _, ...safeUser } = DB.users[idx];
  res.json(safeUser);
});

// ── IDEAS ─────────────────────────────────────────────────────────────────────

// GET all ideas (with optional search & filter)
app.get('/api/ideas', (req, res) => {
  let ideas = [...DB.ideas];
  const { search, industry, level } = req.query;
  if (search) ideas = ideas.filter(i => i.title.toLowerCase().includes(search.toLowerCase()) || i.summary.toLowerCase().includes(search.toLowerCase()));
  if (industry && industry !== 'all') ideas = ideas.filter(i => i.industry === industry);
  if (level) ideas = ideas.filter(i => i.level === parseInt(level));
  res.json(ideas);
});

// GET single idea
app.get('/api/ideas/:id', (req, res) => {
  const idea = DB.ideas.find(i => i.id === parseInt(req.params.id));
  if (!idea) return res.status(404).json({ error: 'Idea not found' });
  // increment views
  idea.views = (idea.views || 0) + 1;
  res.json(idea);
});

// POST new idea (requires auth)
app.post('/api/ideas', authMiddleware, (req, res) => {
  const { title, summary, desc, industry, ideaType, price, level, visibility, engLevel, hasPatent, patentNumber } = req.body;
  if (!title || !industry || !price) return res.status(400).json({ error: 'Title, industry and price are required' });
  const user = DB.users.find(u => u.id === req.user.id);
  const idea = {
    id: Date.now(),
    title, summary, desc, industry,
    ideaType: ideaType || 'New Business Idea',
    price: parseFloat(price),
    level: parseInt(level) || 1,
    visibility: parseInt(visibility) || 1,
    engLevel: engLevel || 0,
    hasPatent: hasPatent || false,
    patentNumber: patentNumber || '',
    icon: '💡',
    creatorId: req.user.id,
    creator: user ? `${user.firstName} ${user.lastName}` : 'Unknown',
    status: 'pending',
    views: 0,
    inquiries: 0,
    createdAt: new Date().toISOString(),
  };
  DB.ideas.push(idea);
  res.status(201).json(idea);
});

// UPDATE idea
app.put('/api/ideas/:id', authMiddleware, (req, res) => {
  const idx = DB.ideas.findIndex(i => i.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Idea not found' });
  if (DB.ideas[idx].creatorId !== req.user.id) return res.status(403).json({ error: 'Not your idea' });
  DB.ideas[idx] = { ...DB.ideas[idx], ...req.body };
  res.json(DB.ideas[idx]);
});

// DELETE idea
app.delete('/api/ideas/:id', authMiddleware, (req, res) => {
  const idx = DB.ideas.findIndex(i => i.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Idea not found' });
  if (DB.ideas[idx].creatorId !== req.user.id) return res.status(403).json({ error: 'Not your idea' });
  DB.ideas.splice(idx, 1);
  res.json({ message: 'Idea deleted' });
});

// GET my ideas
app.get('/api/my-ideas', authMiddleware, (req, res) => {
  res.json(DB.ideas.filter(i => i.creatorId === req.user.id));
});

// ── TRANSACTIONS / ESCROW ────────────────────────────────────────────────────

// Create escrow transaction
app.post('/api/transactions', authMiddleware, (req, res) => {
  const { ideaId, paymentMethod } = req.body;
  const idea = DB.ideas.find(i => i.id === parseInt(ideaId));
  if (!idea) return res.status(404).json({ error: 'Idea not found' });
  const fee = Math.round(idea.price * 0.08);
  const tx = {
    id: Date.now(),
    ideaId: idea.id,
    ideaTitle: idea.title,
    buyerId: req.user.id,
    sellerId: idea.creatorId,
    amount: idea.price,
    fee,
    total: idea.price + fee,
    paymentMethod: paymentMethod || 'card',
    status: 'escrow',
    createdAt: new Date().toISOString(),
  };
  DB.transactions.push(tx);
  idea.status = 'escrow';
  res.status(201).json(tx);
});

// Confirm delivery (releases escrow)
app.put('/api/transactions/:id/confirm', authMiddleware, (req, res) => {
  const tx = DB.transactions.find(t => t.id === parseInt(req.params.id));
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.buyerId !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm delivery' });
  tx.status = 'completed';
  tx.completedAt = new Date().toISOString();
  const seller = DB.users.find(u => u.id === tx.sellerId);
  if (seller) seller.earnings = (seller.earnings || 0) + tx.amount;
  const idea = DB.ideas.find(i => i.id === tx.ideaId);
  if (idea) idea.status = 'sold';
  res.json(tx);
});

// GET my transactions
app.get('/api/transactions', authMiddleware, (req, res) => {
  const txs = DB.transactions.filter(t => t.buyerId === req.user.id || t.sellerId === req.user.id);
  res.json(txs);
});

// ── MESSAGES ─────────────────────────────────────────────────────────────────

// GET my conversations
app.get('/api/messages', authMiddleware, (req, res) => {
  const convs = DB.messages.filter(m => m.fromId === req.user.id || m.toId === req.user.id);
  res.json(convs);
});

// SEND a message
app.post('/api/messages', authMiddleware, (req, res) => {
  const { toId, text, ideaId } = req.body;
  if (!toId || !text) return res.status(400).json({ error: 'toId and text required' });
  const msg = {
    id: Date.now(),
    fromId: req.user.id,
    toId: parseInt(toId),
    text,
    ideaId: ideaId || null,
    createdAt: new Date().toISOString(),
    read: false,
  };
  DB.messages.push(msg);
  res.status(201).json(msg);
});

// ── PATENTS ──────────────────────────────────────────────────────────────────

// Apply for patent
app.post('/api/patents', authMiddleware, (req, res) => {
  const { title, type, jurisdiction, statement } = req.body;
  const patent = {
    id: 'IH-' + Date.now(),
    userId: req.user.id,
    title,
    type: type || 'Provisional',
    jurisdiction: jurisdiction || 'USPTO',
    statement,
    status: 'Application Received',
    filed: new Date().toISOString().slice(0, 10),
    number: 'Pending',
  };
  DB.patents.push(patent);
  res.status(201).json(patent);
});

// GET my patents
app.get('/api/patents', authMiddleware, (req, res) => {
  res.json(DB.patents.filter(p => p.userId === req.user.id));
});

// ── DASHBOARD STATS ──────────────────────────────────────────────────────────
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const myIdeas = DB.ideas.filter(i => i.creatorId === req.user.id);
  const myTx = DB.transactions.filter(t => t.sellerId === req.user.id && t.status === 'completed');
  const user = DB.users.find(u => u.id === req.user.id);
  res.json({
    ideasPosted: myIdeas.length,
    totalViews: myIdeas.reduce((s, i) => s + (i.views || 0), 0),
    inquiries: myIdeas.reduce((s, i) => s + (i.inquiries || 0), 0),
    earnings: user?.earnings || 0,
    ideas: myIdeas,
    recentTransactions: myTx.slice(-5),
  });
});

// ── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  IdeaHub backend running!');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('');
  console.log('  Available routes:');
  console.log('  POST   /api/auth/signup');
  console.log('  POST   /api/auth/login');
  console.log('  GET    /api/ideas');
  console.log('  POST   /api/ideas');
  console.log('  POST   /api/transactions');
  console.log('  POST   /api/messages');
  console.log('  GET    /api/dashboard');
  console.log('');
});
