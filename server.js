  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
  }
  const express = require('express');
  const path = require('path');
  const cors = require('cors');
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const { createClient } = require('@supabase/supabase-js');
  const multer = require('multer');
  const { Resend } = require('resend');
  const passport = require('passport');
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  const session = require('express-session');

  // ── EMAIL HELPER ─────────────────────────────────────────────────────────────
  // Plain-text twin of every HTML email: Gmail trusts mail that has both, and it reads better on watches/older apps
  function htmlToText(html) {
    return String(html || '')
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => `\n${label.replace(/<[^>]+>/g, '').trim()}: ${href}\n`)
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').split('\n').map(l => l.trim()).join('\n').trim();
  }
  async function sendEmail(to, subject, html) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { data, error } = await resend.emails.send({
        from: process.env.RESEND_FROM,
        to,
        subject,
        html,
        text: htmlToText(html),
        ...(process.env.RESEND_REPLY_TO ? { reply_to: process.env.RESEND_REPLY_TO } : {})
      });
      if (error) { console.error('Resend rejected email to', to, '-', error.message || JSON.stringify(error)); return; } console.log('Email sent to:', to, 'id:', data?.id);
    } catch(err) {
      console.error('Email error:', err.message);
    }
  }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(session({
    secret: process.env.JWT_SECRET,
    resave: false,
    saveUninitialized: false
  }));
  app.use(passport.initialize());
  app.use(passport.session());
  // The dynamic sitemap (built further down) must answer before the static public/sitemap.xml
  let sitemapHandler = null;
  app.get('/sitemap.xml', (req, res, next) => sitemapHandler ? sitemapHandler(req, res, next) : next());
  app.use(express.static('public', { etag: false, maxAge: 0 }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://ideahub.it.com/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails[0].value;
      const firstName = profile.name.givenName;
      const lastName = profile.name.familyName || '';
      const avatar = profile.photos[0]?.value || null;

      // Check if user exists
      let { data: user } = await supabase.from('users').select('*').eq('email', email).single();

      if (!user) {
        // Don't create yet — send to role selection
        return done(null, { email, first_name: firstName, last_name: lastName, avatar_url: avatar, google_id: profile.id, existed: false });
      }

      // Existing user
      return done(null, { ...user, existed: true });
    } catch(err) {
      console.error('Google OAuth error:', err.message || JSON.stringify(err));
      return done(err, null);
    }
  }));

  // Google OAuth routes
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login?error=google' }), async (req, res) => {
    const user = req.user;
    const { password: _, ...safeUser } = user;

    // Existing user — log straight in
    if (user.existed) {
      const token = require('jsonwebtoken').sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.redirect(`/auth/google/success?token=${token}&user=${encodeURIComponent(JSON.stringify(safeUser))}`);
    }

    // New user — go to role selection
    res.redirect(`/google-role-select?profile=${encodeURIComponent(JSON.stringify({ email: user.email, first_name: user.first_name, last_name: user.last_name, avatar_url: user.avatar_url, google_id: user.google_id }))}`);
  });

  app.get('/auth/google/success', (req, res) => {
    res.sendFile(__dirname + '/public/google-auth-success.html');
  });

// /sitemap.xml is built further down (static pages + every public idea and life hack)

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(__dirname + '/public/robots.txt');
});

  // GET public user profile
  app.get('/api/users/:id/public', async (req, res) => {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, role, tagline, avatar_url, city, state, country, bio, qualification, expert_area, created_at, verification_status')
      .eq('id', req.params.id)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { data: specializations } = await supabase
      .from('user_specializations')
      .select('*')
      .eq('user_id', req.params.id);

    const { data: ideas } = await supabase
      .from('ideas')
      .select('id, title, price, views, status')
      .eq('creator_id', req.params.id)
      .eq('status', 'live')
      .or('visibility.is.null,visibility.eq.1');

    res.json({
      ...user,
      is_verified: user.verification_status === 'verified',
      specializations: specializations || [],
      ideas: ideas || []
    });
  });

  // ── SUPABASE CLIENT ──────────────────────────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
       require('./chatbot')(app, supabase); require('./bots')(app, supabase, sendEmail);
  const escrow = require('./escrow')(supabase, sendEmail);
  const payments = require('./payments')(supabase);
  const originality = require('./originality')(supabase, escrow);
  const matching = require('./matching')(supabase, escrow);
  const quality = require('./public/listing-quality');
  const engagementLevels = require('./public/engagements');
  // Cleans the creator's engagement levels; returns { value, error }
  function readEngagements(body) {
    const value = engagementLevels.sanitize(body.engagements);
    for (const k of Object.keys(value)) {
      const c = quality.hasContact(value[k].note);
      if (c) return { error: `Please remove ${c} from your "${engagementLevels.BY_KEY[k].short}" note. Buyers contact you through IdeaHub messages.` };
    }
    return { value };
  }

  // Typical prices per industry (middle half of live listings), cached for 10 minutes
  const priceGuideCache = new Map();
  async function priceGuide(industry) {
    if (!industry) return null;
    const hit = priceGuideCache.get(industry);
    if (hit && Date.now() - hit.at < 600000) return hit.guide;
    const { data } = await supabase.from('ideas').select('price').eq('status', 'live').eq('industry', industry).limit(1000);
    const prices = (data || []).map(r => Number(r.price)).filter(n => n > 0).sort((a, b) => a - b);
    const q = f => prices[Math.min(prices.length - 1, Math.floor(f * (prices.length - 1)))];
    const guide = prices.length ? { count: prices.length, p25: q(0.25), median: q(0.5), p75: q(0.75) } : { count: 0 };
    priceGuideCache.set(industry, { at: Date.now(), guide });
    return guide;
  }
  // Runs the shared listing rules; returns { report, error } — error is set when something blocks saving
  async function checkQuality(body) {
    const report = quality.checkListing({
      title: body.title, summary: body.summary, desc: body.desc, industry: body.industry, price: body.price,
      images: body.images, hasPatent: body.hasPatent, patentNumber: body.patentNumber,
      engagements: engagementLevels.sanitize(body.engagements)
    }, { priceGuide: await priceGuide(body.industry) });
    return { report, error: report.blocking.length ? report.blocking.map(i => i.message).join(' ') : null };
  }
  const qualityFields = r => ({ quality_score: r.score, quality_issues: r.items.filter(i => i.level !== 'ok').map(({ id, level, message }) => ({ id, level, message })) });
  // ── SERVE FRONTEND ───────────────────────────────────────────────────────────
  app.get('/discover', (req, res) => {
    res.sendFile(__dirname + '/public/discover.html');
  });
  app.get('/about', (req, res) => {
    res.sendFile(__dirname + '/public/about.html');
  });

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
  app.get('/public-profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'public-profile.html'));
  });

  app.get('/idea', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'idea.html'));
  });

  app.get('/browse', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'browse.html'));
  });

  app.get('/public-profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'public-profile.html'));
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
  app.get('/idea-requests', (req, res) => {
    res.sendFile(__dirname + '/public/idea-requests.html');
  });
  app.get('/post-request', (req, res) => {
    res.sendFile(__dirname + '/public/post-request.html');
  });
  app.get('/request/:id', (req, res) => {
    res.sendFile(__dirname + '/public/request-detail.html');
  });
  app.get('/request-detail', (req, res) => {
    res.sendFile(__dirname + '/public/request-detail.html');
  });
  app.get('/businesses', (req, res) => res.sendFile(__dirname + '/public/businesses.html'));
  app.get('/list-business', (req, res) => res.sendFile(__dirname + '/public/list-business.html'));
  app.get('/business/:id', (req, res) => res.sendFile(__dirname + '/public/business-detail.html'));
  app.get('/business-dashboard', (req, res) => res.sendFile(__dirname + '/public/business-dashboard.html'));
  app.get('/find-support', (req, res) => {
    res.sendFile(__dirname + '/public/find-support.html');
  });
  app.get('/support-dashboard', (req, res) => {
    res.sendFile(__dirname + '/public/support-dashboard.html');
  });
  app.get('/attorney-dashboard', (req, res) => {
    res.sendFile(__dirname + '/public/attorney-dashboard.html');
  });
  app.get('/wall', (req, res) => res.sendFile(__dirname + '/public/wall.html'));
  app.get('/life-hacks', (req, res) => res.sendFile(__dirname + '/public/life-hacks.html'));

  // Sitemap: the static pages in public/sitemap.xml + each public idea and life hack (cached 1 hour)
  let sitemapCache = { at: 0, xml: '' };
  sitemapHandler = async (req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    if (Date.now() - sitemapCache.at < 3600000 && sitemapCache.xml) return res.send(sitemapCache.xml);
    try {
      const base = require('fs').readFileSync(__dirname + '/public/sitemap.xml', 'utf8');
      const [{ data: ideas }, { data: hacks }] = await Promise.all([
        supabase.from('ideas').select('id, created_at').eq('status', 'live').or('visibility.is.null,visibility.eq.1').order('created_at', { ascending: false }).limit(5000),
        supabase.from('wall_posts').select('id, created_at').eq('category', 'Life Hack').order('created_at', { ascending: false }).limit(5000)
      ]);
      const day = d => (d ? new Date(d) : new Date()).toISOString().slice(0, 10);
      const urls = [
        `  <url>\n    <loc>https://ideahub.it.com/life-hacks</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`,
        ...(ideas || []).map(i => `  <url>\n    <loc>https://ideahub.it.com/idea?id=${Number(i.id)}</loc>\n    <lastmod>${day(i.created_at)}</lastmod>\n    <priority>0.6</priority>\n  </url>`),
        ...(hacks || []).map(h => `  <url>\n    <loc>https://ideahub.it.com/life-hacks?id=${Number(h.id)}</loc>\n    <lastmod>${day(h.created_at)}</lastmod>\n    <priority>0.5</priority>\n  </url>`)
      ];
      const xml = base.includes('/life-hacks</loc>') ? base.replace('</urlset>', urls.slice(1).join('\n') + '\n</urlset>') : base.replace('</urlset>', urls.join('\n') + '\n</urlset>');
      sitemapCache = { at: Date.now(), xml };
      res.send(xml);
    } catch (err) {
      console.error('Sitemap build failed:', err.message);
      res.sendFile(__dirname + '/public/sitemap.xml');
    }
  };
  app.get('/settings', (req, res) => res.sendFile(__dirname + '/public/settings.html'));
  app.get('/attorney-dashboard', (req, res) => res.sendFile(__dirname + '/public/attorney-dashboard.html'));
  app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
  });
  app.get('/how-it-works', (req, res) => {
    res.sendFile(__dirname + '/public/how-it-works.html');
  });
  app.get('/terms', (req, res) => res.sendFile(__dirname + '/public/terms.html'));
  app.get('/privacy', (req, res) => res.sendFile(__dirname + '/public/privacy.html'));
  app.get('/cookies', (req, res) => res.sendFile(__dirname + '/public/cookies.html'));
  app.get('/refunds', (req, res) => res.sendFile(__dirname + '/public/refunds.html'));
  app.get('/contact', (req, res) => {
    res.redirect('/about#contact');
  });
  app.get('/contact', (req, res) => {
    res.redirect('/about#contact');
  });
  app.get('/api/stats/public', async (req, res) => {
    const [ideasRes, usersRes, txRes] = await Promise.all([
      supabase.from('ideas').select('*', { count: 'exact', head: true }).eq('status', 'live'),
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    ]);
    res.json({ ideas: ideasRes.count || 0, users: usersRes.count || 0, deals: txRes.count || 0 });
  });

  // Typical price range for an industry (used by the submit page's quality checklist)
  app.get('/api/ideas/price-guide', async (req, res) => {
    const industry = String(req.query.industry || '').slice(0, 60);
    res.json((await priceGuide(industry)) || { count: 0 });
  });

  app.get('/api/ideas/public', async (req, res) => {
    const limit = parseInt(req.query.limit) || 6;
    const { data, error } = await supabase
      .from('ideas')
      .select('id, title, summary, industry, price, views, creator_id, creator_name, originality, originality_score')
      .eq('status', 'live')
      .or('visibility.is.null,visibility.eq.1')
      .order('views', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    const enriched = await Promise.all((data || []).map(async idea => {
      const { data: creator } = await supabase
        .from('users').select('first_name, last_name, avatar_url, profile_stars')
        .eq('id', idea.creator_id).single();
      const { originality: _o, originality_score: _s, ...rest } = idea;
      return { ...rest, originality_rating: originality.rating(idea), creator_first_name: creator?.first_name || '', creator_last_name: creator?.last_name || '', creator_avatar: creator?.avatar_url || null, creator_stars: creator?.profile_stars || 0 };
    }));
    res.json(enriched);
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
  async function verifyTurnstile(token, ip) { if (!process.env.TURNSTILE_SECRET_KEY) return true; if (!token) return false; try { const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip || '' }) }); const d = await r.json(); return d.success === true; } catch (e) { console.error('Turnstile error:', e.message); return false; } }
  app.post('/api/auth/signup', async (req, res) => { if (!(await verifyTurnstile(req.body.turnstileToken, req.headers['cf-connecting-ip']))) return res.status(400).json({ error: 'Security check failed. Please refresh the page and try again.' });
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
        role: role || 'idea_creator', signup_country: req.headers['cf-ipcountry'] || null,
        earnings: 0,
        verified: false,
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = user;

    // Welcome email
    sendEmail(email, 'Welcome to IdeaHub! 🎉', `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
        <div style="font-size:28px;font-weight:800;color:#f5c842;margin-bottom:8px;">IdeaHub</div>
        <h2 style="font-size:22px;margin-bottom:12px;">Welcome, ${firstName}! 👋</h2>
        <p style="color:#9a9080;line-height:1.7;margin-bottom:20px;">Your account has been created successfully. You're now part of the global marketplace where ideas become empires.</p>
        <a href="https://ideahub.it.com/dashboard" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;margin-bottom:24px;">Go to Dashboard →</a>
        <p style="color:#6e6b65;font-size:12px;">IdeaHub by Picela (Pvt) Ltd</p>
      </div>
    `);

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

    const { data: specs } = await supabase
      .from('user_specializations')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });

    const { password: _, ...safeUser } = user;
    res.json({ ...safeUser, firstName: user.first_name, lastName: user.last_name, specializations: specs || [] });
  });

  // UPDATE profile
  app.put('/api/auth/me', authMiddleware, async (req, res) => {
    const { first_name, last_name, middle_name, tagline, bio, country, city, state, postal_code, address_line1, address_line2, phone, expert_area, qualification, specializations, profile_complete, profile_stars, verification_status, verification_submitted_at } = req.body;

    const updateData = {};
    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (middle_name !== undefined) updateData.middle_name = middle_name;
    if (tagline !== undefined) updateData.tagline = tagline?.slice(0,30);
    if (bio !== undefined) updateData.bio = bio?.slice(0,500);
    if (country !== undefined) updateData.country = country;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (postal_code !== undefined) updateData.postal_code = postal_code;
    if (address_line1 !== undefined) updateData.address_line1 = address_line1;
    if (address_line2 !== undefined) updateData.address_line2 = address_line2;
    if (phone !== undefined) updateData.phone = phone;
    if (expert_area !== undefined) updateData.expert_area = expert_area;
    if (qualification !== undefined) updateData.qualification = qualification;
    if (verification_status === 'pending') updateData.verification_status = 'pending';
    if (verification_submitted_at !== undefined) updateData.verification_submitted_at = verification_submitted_at;

    const { data: user, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    if (specializations && Array.isArray(specializations)) {
      await supabase.from('user_specializations').delete().eq('user_id', req.user.id);
      if (specializations.length > 0) {
        await supabase.from('user_specializations').insert(
          specializations.map(s => ({ user_id: req.user.id, subject: s.subject, how_specialized: s.how_specialized }))
        );
      }
    }

    // Profile completeness and stars are calculated here — never taken from the browser
    const { count: specCount } = await supabase.from('user_specializations')
      .select('*', { count: 'exact', head: true }).eq('user_id', req.user.id);
    const checks = ['first_name', 'last_name', 'country', 'phone', 'bio', 'tagline', 'expert_area', 'qualification', 'city', 'address_line1', 'avatar_url']
      .map(f => String(user[f] ?? '').trim() !== '');
    checks.push((specCount || 0) > 0);
    const pct = Math.round((checks.filter(Boolean).length / checks.length) * 100);
    const extra = { profile_complete: pct >= 80 };
    if (pct >= 80 && (user.profile_stars || 0) < 1) extra.profile_stars = 1;
    const { data: finalUser } = await supabase.from('users').update(extra).eq('id', req.user.id).select().single();
    const out = finalUser || user;

    const { password: _, ...safeUser } = out;
    res.json({ ...safeUser, firstName: out.first_name, lastName: out.last_name });
  });

  // ── IDEAS ─────────────────────────────────────────────────────────────────────

  // Verify patent number
  app.post('/api/patents/verify', authMiddleware, async (req, res) => {
    const { patentNumber, jurisdiction } = req.body;
    if (!patentNumber) return res.status(400).json({ error: 'Patent number required' });

    try {
      // SLIPO — manual only, return link
      if (jurisdiction === 'SLIPO') {
        return res.json({
          found: true,
          title: 'Sri Lanka Patent (Manual Verification Required)',
          owner: 'Verify manually via SLIPO',
          status: 'Pending Manual Check',
          manualUrl: `https://www.nipo.gov.lk/index.php/en/ip-services/patents`
        });
      }

      // Search Google Patents
      const searchUrl = `https://patents.google.com/patent/${patentNumber.replace(/[,\s]/g, '')}`;
      const response = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      
      if (response.ok) {
        const html = await response.text();
        
        // Extract title
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        const title = titleMatch ? titleMatch[1].replace(' - Google Patents', '').trim() : 'Patent found';
        
        // Check if it's a valid patent page
        const isValid = !html.includes('No results') && html.includes('patent') && title !== 'Google Patents';

        if (isValid && !title.includes('Google Patents')) {
          return res.json({ found: true, title, owner: 'See patent document', status: 'Active', url: searchUrl, googleUrl: `https://patents.google.com/?q=${patentNumber.replace(/[,\s]/g, '')}` });
        }
      }
      
      res.json({ found: false });
    } catch(err) {
      console.error('Patent verify error:', err);
      res.json({ found: false, error: err.message });
    }
  });

  // Upload idea image
  app.post('/api/ideas/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
    console.log('Image upload called, file:', req.file?.originalname, req.file?.mimetype, req.file?.size);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = req.file.mimetype.split('/')[1];
    const fileName = `idea-${req.user.id}-${Date.now()}.${ext}`;
    console.log('Uploading to bucket idea-images:', fileName);
    try {
      const { data, error } = await supabase.storage.from('idea-images').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      console.log('Upload result:', data, error);
      if (error) return res.status(500).json({ error: error.message });
      const { data: urlData } = supabase.storage.from('idea-images').getPublicUrl(fileName);
      console.log('Public URL:', urlData.publicUrl);
      res.json({ url: urlData.publicUrl });
    } catch (err) { 
      console.error('Image upload error:', err);
      res.status(500).json({ error: err.message }); 
    }
  });

  // ── IDEA PRIVACY ─────────────────────────────────────────────────────────────
  // Full description + patent/ID documents are never sent to the public.
  // Owner and admin see everything; buyers (escrow/completed) also see the description.
  const PRIVATE_IDEA_FIELDS = ['description', 'patent_cert_url', 'patent_id_url', 'originality', 'originality_score', 'originality_checked_at', 'moderation', 'quality_score', 'quality_issues'];
  async function viewerContext(req) {
    const t = req.headers.authorization?.split(' ')[1];
    if (!t) return { id: null, role: null, verified: false };
    try {
      const decoded = jwt.verify(t, process.env.JWT_SECRET);
      const { data } = await supabase.from('users').select('id, role, verification_status').eq('id', decoded.id).single();
      return { id: data?.id || null, role: data?.role || null, verified: data?.verification_status === 'verified' };
    } catch { return { id: null, role: null, verified: false }; }
  }
  // The creator's own view: originality report without other people's private listings
  function ownerIdea(idea) {
    if (!idea) return idea;
    return { ...idea, originality: originality.forCreator(idea.originality), originality_rating: originality.rating(idea) };
  }
  function publicIdea(idea) {
    const copy = { ...idea, originality_rating: originality.rating(idea) };
    PRIVATE_IDEA_FIELDS.forEach(f => delete copy[f]);
    copy.description_locked = !!idea.description;
    return copy;
  }

  // GET all ideas
  app.get('/api/ideas', async (req, res) => {
    let query = supabase.from('ideas').select('*, creator:creator_id(tagline, avatar_url, profile_stars)').eq('status', 'live');

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
    // visibility: 1 = everyone, 2 = verified members only, 3 = private (direct link only)
    const viewer = await viewerContext(req);
    const visible = (data || []).filter(i => {
      const v = Number(i.visibility) || 1;
      if (v === 1) return true;
      if (viewer.role === 'admin' || (viewer.id && i.creator_id === viewer.id)) return true;
      return v === 2 && viewer.verified;
    });
    res.json(visible.map(publicIdea));
  });

  // GET single idea
  app.get('/api/ideas/:id', async (req, res) => {
    const { data: idea, error } = await supabase
      .from('ideas')
      .select('*, creator:creator_id(first_name, last_name, avatar_url, tagline, profile_stars, role)')
      .eq('id', req.params.id)
      .single();

    if (!idea || error) return res.status(404).json({ error: 'Idea not found' });

    const viewer = await viewerContext(req);
    const isOwner = !!viewer.id && viewer.id === idea.creator_id;
    const isAdmin = viewer.role === 'admin';
    let isBuyer = false;
    if (viewer.id && !isOwner) {
      const { data: tx } = await supabase.from('transactions').select('id')
        .eq('idea_id', idea.id).eq('buyer_id', viewer.id).in('status', ['escrow', 'completed', 'disputed']).limit(1);
      isBuyer = !!(tx && tx.length);
    }
    const privileged = isOwner || isAdmin || isBuyer;

    // Under review / rejected / hidden ideas are not public
    if (!privileged && !['live', 'escrow', 'sold'].includes(idea.status)) {
      return res.status(404).json({ error: 'Idea not found' });
    }
    // Verified-members-only listings (visibility 3 = private: the direct link is the invite)
    if (!privileged && Number(idea.visibility) === 2 && !viewer.verified) {
      return res.status(403).json({ error: 'This idea is only visible to verified members.', code: 'verified_only' });
    }

    if (!isOwner) await supabase.from('ideas').update({ views: (idea.views || 0) + 1 }).eq('id', idea.id);
    if (isAdmin) return res.json({ ...idea, originality_rating: originality.rating(idea) });
    if (isOwner) return res.json(ownerIdea(idea));
    const out = publicIdea(idea);
    if (isBuyer) { out.description = idea.description; out.description_locked = false; }
    res.json(out);
  });

  // POST new idea
  app.post('/api/ideas', authMiddleware, async (req, res) => {
    const { title, summary, desc, industry, ideaType, price, level, visibility, engLevel, hasPatent, patentNumber } = req.body;
    if (!title || !industry || !price) return res.status(400).json({ error: 'Title, industry and price are required' });
    const qc = await checkQuality(req.body);
    if (qc.error) return res.status(400).json({ error: qc.error, quality: qc.report });
    const eng = readEngagements(req.body);
    if (eng.error) return res.status(400).json({ error: eng.error });

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
        eng_level: Object.keys(eng.value).length,
        engagements: eng.value,
        has_patent: hasPatent || false,
        patent_number: patentNumber || '',
        icon: '💡',
        images: req.body.images || [],
      countries: req.body.countries || [],
        creator_id: req.user.id,
        creator_name: user ? `${user.first_name} ${user.last_name}` : 'Unknown',
        status: (hasPatent && req.body.patentCertUrl) ? 'under_review' : 'live',
        patent_jurisdiction: req.body.patentJurisdiction || '',
        patent_verified: false,
        patent_cert_url: req.body.patentCertUrl || '',
        patent_id_url: req.body.patentIdUrl || '',
        views: 0,
        inquiries: 0,
        ...qualityFields(qc.report),
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    originality.checkInBackground(idea, req.user.id);
    // A few minutes later (after the originality bot), tell investors whose open request this idea fits
    setTimeout(async () => {
      try {
        const { data: fresh } = await supabase.from('ideas').select('id, title, summary, industry, status, visibility, creator_id').eq('id', idea.id).single();
        if (fresh) await matching.alertForNewIdea(fresh);
      } catch (e) { console.error('Request alert failed:', e.message); }
    }, 3 * 60 * 1000);

    // Share to IdeaWall if requested
    if (req.body.shareToWall && idea) {
      await supabase.from('wall_posts').insert([{
        user_id: req.user.id,
        title: idea.title,
        description: idea.summary || '',
        category: 'Innovation',
        media_url: (req.body.images && req.body.images[0]) || null,
        media_type: 'image',
        source_idea_id: idea.id,
        is_from_idea: true,
        likes_count: 0,
        comments_count: 0
      }]);
    }

    res.status(201).json(idea);
  });

  // PUT update idea
  app.put('/api/ideas/:id', authMiddleware, async (req, res) => {
    const { title, summary, desc, industry, ideaType, price, level, visibility, hasPatent, patentNumber } = req.body;
    if (!title || !industry || !price) return res.status(400).json({ error: 'Title, industry and price are required' });
    // A taken-down idea goes back to the admin for review once the creator edits it
    const { data: current } = await supabase.from('ideas').select('status').eq('id', req.params.id).eq('creator_id', req.user.id).single();
    const resubmit = current?.status === 'rejected';
    const qc = await checkQuality(req.body);
    if (qc.error) return res.status(400).json({ error: qc.error, quality: qc.report });
    const eng = readEngagements(req.body);
    if (eng.error) return res.status(400).json({ error: eng.error });

    const { data: idea, error } = await supabase
      .from('ideas')
      .update({
        title, summary,
        description: desc,
        industry,
        idea_type: ideaType || 'New Business Idea',
        price: parseFloat(price),
        level: parseInt(level) || 1,
        visibility: parseInt(visibility) || 1,
        has_patent: hasPatent || false,
        patent_number: patentNumber || '',
        ...(resubmit ? { status: 'under_review' } : {}),
        engagements: eng.value, eng_level: Object.keys(eng.value).length,
        ...qualityFields(qc.report),
      })
      .eq('id', req.params.id)
      .eq('creator_id', req.user.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    originality.checkInBackground(idea, req.user.id);
    res.json(ownerIdea(idea));
  });

  // GET public user profile
  app.get('/api/users/:id/public', async (req, res) => {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, role, tagline, avatar_url, city, country, created_at, is_verified')
      .eq('id', req.params.id)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { data: specializations } = await supabase
      .from('user_specializations')
      .select('*')
      .eq('user_id', req.params.id);

    const { data: ideas } = await supabase
      .from('ideas')
      .select('id, title, price, views, status')
      .eq('creator_id', req.params.id)
      .eq('status', 'live')
      .or('visibility.is.null,visibility.eq.1');

    res.json({ ...user, specializations: specializations || [], ideas: ideas || [] });
  });

  // ADMIN approve patent
  app.put('/api/admin/ideas/:id/approve-patent', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { data, error } = await supabase
      .from('ideas')
      .update({ status: 'live', patent_verified: true })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify creator
    await supabase.from('notifications').insert([{
      user_id: data.creator_id,
      type: 'patent_approved',
      title: '✅ Patent Verified & Idea Live!',
      message: `Your idea "${data.title}" has been verified and is now live on the marketplace.`,
      link: `/idea?id=${data.id}`
    }]);

    res.json(data);
  });

  // ADMIN reject patent
  app.put('/api/admin/ideas/:id/reject-patent', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { reason } = req.body;
    const { data, error } = await supabase
      .from('ideas')
      .update({ status: 'rejected' })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify creator
    await supabase.from('notifications').insert([{
      user_id: data.creator_id,
      type: 'patent_rejected',
      title: '❌ Patent Verification Failed',
      message: `Your idea "${data.title}" was not approved. Reason: ${reason}`,
      link: `/submit?edit=${data.id}`
    }]);

    res.json(data);
  });

  // GET my ideas
  app.get('/api/my-ideas', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('ideas')
      .select('*')
      .eq('creator_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(ownerIdea));
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
    if (idea.creator_id === req.user.id) return res.status(400).json({ error: 'You cannot buy your own idea.' });
    if (idea.status !== 'live') return res.status(400).json({ error: 'This idea is not available for purchase.' });
    if (!payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon. Message the creator to discuss this idea in the meantime.', code: 'payments_closed' });
    // Engagement levels the buyer added (fixed-price ones); free ones are always included
    const extras = engagementLevels.addOns(idea.engagements, Array.isArray(req.body.engagements) ? req.body.engagements.slice(0, 10) : []);
    if (extras.errors.length) return res.status(400).json({ error: extras.errors.join(' ') });

    // Reserve the idea first so two buyers can't purchase it at the same moment
    const { data: claimed } = await supabase.from('ideas').update({ status: 'escrow' }).eq('id', idea.id).eq('status', 'live').select('id');
    if (!claimed || !claimed.length) return res.status(400).json({ error: 'This idea was just purchased by someone else.' });

    const amount = Math.round((Number(idea.price) + extras.total) * 100) / 100;
    const fee = Math.round(amount * 0.08);
    const { data: tx, error } = await supabase
      .from('transactions')
      .insert([{
        idea_id: idea.id, idea_title: idea.title,
        buyer_id: req.user.id, seller_id: idea.creator_id,
        amount, fee, total: amount + fee, engagements: extras.items,
        payment_method: paymentMethod || 'card', status: 'escrow',
      }])
      .select().single();

    if (error) {
      await supabase.from('ideas').update({ status: 'live' }).eq('id', idea.id);
      return res.status(500).json({ error: error.message });
    }
    const charge = await payments.chargePurchase(tx);
    if (!charge.ok) {
      await supabase.from('transactions').update({ status: 'failed' }).eq('id', tx.id);
      await supabase.from('ideas').update({ status: 'live' }).eq('id', idea.id);
      return res.status(402).json({ error: charge.error || 'Payment failed.' });
    }

    // Email seller — escrow locked
    const { data: seller } = await supabase.from('users').select('email, first_name').eq('id', idea.creator_id).single();
    const { data: buyer } = await supabase.from('users').select('first_name').eq('id', req.user.id).single();
    if (seller?.email) {
      sendEmail(seller.email, `🔒 Escrow Locked for "${idea.title}" — IdeaHub`, `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
          <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
          <h2 style="margin-bottom:8px;">Your idea has a buyer! 🎉</h2>
          <p style="color:#9a9080;line-height:1.7;margin-bottom:16px;">${buyer?.first_name || 'A buyer'} has locked <strong style="color:#f5c842;">$${amount.toLocaleString()}</strong> in escrow for your idea <strong>"${escrow.esc(idea.title)}"</strong>.</p>
          ${extras.items.length ? `<p style="color:#9a9080;line-height:1.7;margin-bottom:16px;">Included with the purchase: <strong style="color:#f0ede8;">${extras.items.map(i => escrow.esc(i.label) + (i.price ? ' ($' + i.price.toLocaleString() + ')' : ' (included)')).join(', ')}</strong>. Agree the details with the buyer in IdeaHub messages.</p>` : ''}
          <p style="color:#9a9080;line-height:1.7;margin-bottom:20px;">Deliver the idea materials to the buyer. Once they confirm delivery, funds will be released to your wallet.</p>
          <a href="https://ideahub.it.com/transactions" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">View Transaction →</a>
          <p style="color:#6e6b65;font-size:12px;margin-top:24px;">IdeaHub by Picela (Pvt) Ltd</p>
        </div>
      `);
    }

    res.status(201).json(tx);
  });

  // ── PAYMENTS & WALLET ───────────────────────────────────────────────────────
  app.get('/api/payments/config', (req, res) => {
    res.json({ provider: payments.provider(), purchasesOpen: payments.purchasesOpen() });
  });

  app.get('/api/wallet', authMiddleware, async (req, res) => {
    try { res.json(await payments.wallet(req.user.id)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/withdrawals', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('withdrawals')
      .select('id, amount, method, status, reference, admin_note, requested_at, processed_at, details')
      .eq('user_id', req.user.id).order('requested_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  const MIN_WITHDRAWAL = 10;
  app.post('/api/withdrawals', authMiddleware, async (req, res) => {
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const method = req.body?.method === 'paypal' ? 'paypal' : 'bank';
    const d = req.body?.details || {};
    const clean = v => String(v || '').trim().slice(0, 120);
    const details = method === 'paypal'
      ? { paypal_email: clean(d.paypal_email) }
      : { account_name: clean(d.account_name), bank_name: clean(d.bank_name), account_number: clean(d.account_number), branch: clean(d.branch), swift: clean(d.swift), country: clean(d.country) };
    if (!(amount >= MIN_WITHDRAWAL)) return res.status(400).json({ error: `The minimum withdrawal is $${MIN_WITHDRAWAL}.` });
    if (method === 'paypal' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(details.paypal_email)) return res.status(400).json({ error: 'Please enter a valid PayPal email.' });
    if (method === 'bank' && (!details.account_name || !details.bank_name || !details.account_number)) return res.status(400).json({ error: 'Please enter the account name, bank name and account number.' });

    const { data: open } = await supabase.from('withdrawals').select('id').eq('user_id', req.user.id).eq('status', 'requested').limit(1);
    if (open && open.length) return res.status(400).json({ error: 'You already have a withdrawal being processed.' });
    const w = await payments.wallet(req.user.id);
    if (amount > w.available) return res.status(400).json({ error: `You can withdraw up to $${w.available.toLocaleString()}.` });

    const { data, error } = await supabase.from('withdrawals')
      .insert([{ user_id: req.user.id, amount, method, details, status: 'requested' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });

    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const a of admins || []) await escrow.notify(a.id, { type: 'withdrawal_request', title: '💸 Withdrawal Request', message: `A seller requested $${amount.toLocaleString()} via ${method === 'paypal' ? 'PayPal' : 'bank transfer'}.`, link: '/admin' });
    res.status(201).json(data);
  });

  app.get('/api/admin/withdrawals', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('withdrawals')
      .select('*, user:user_id(first_name, last_name, email, earnings)').order('requested_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // Admin marks a withdrawal as paid (after sending the money) or rejects it
  app.put('/api/admin/withdrawals/:id', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const status = req.body?.status;
    if (!['paid', 'rejected'].includes(status)) return res.status(400).json({ error: "status must be 'paid' or 'rejected'" });
    const reference = String(req.body?.reference || '').trim().slice(0, 120);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (status === 'paid' && !reference) return res.status(400).json({ error: 'Enter the transfer reference so the payout can be traced.' });

    const { data: rows, error } = await supabase.from('withdrawals')
      .update({ status, reference: reference || null, admin_note: note || null, processed_at: new Date().toISOString(), processed_by: req.user.id })
      .eq('id', req.params.id).eq('status', 'requested').select();
    if (error) return res.status(500).json({ error: error.message });
    const w = rows && rows[0];
    if (!w) return res.status(400).json({ error: 'This withdrawal was already processed.' });

    if (status === 'paid') {
      await payments.record({ kind: 'payout', userId: w.user_id, amount: w.amount, withdrawalId: w.id, ref: reference, meta: { method: w.method } });
      await escrow.notify(w.user_id, { type: 'withdrawal_paid', title: '✅ Withdrawal Sent', message: `$${Number(w.amount).toLocaleString()} was sent to your ${w.method === 'paypal' ? 'PayPal' : 'bank account'}. Reference: ${reference}`, link: '/transactions' });
      await escrow.emailUser(w.user_id, `Your withdrawal of $${Number(w.amount).toLocaleString()} was sent`, 'Withdrawal sent',
        `We sent <strong style="color:#f5c842;">$${Number(w.amount).toLocaleString()}</strong> to your ${w.method === 'paypal' ? 'PayPal account' : 'bank account'}.<br>Reference: <strong>${escrow.esc(reference)}</strong>${note ? '<br><br>' + escrow.esc(note) : ''}<br><br>Bank transfers can take a few business days to appear.`,
        'View wallet', '/transactions');
    } else {
      await escrow.notify(w.user_id, { type: 'withdrawal_rejected', title: '❌ Withdrawal Not Processed', message: `Your withdrawal of $${Number(w.amount).toLocaleString()} was not processed.${note ? ' Reason: ' + note : ''} The amount is back in your available balance.`, link: '/transactions' });
    }
    res.json(w);
  });

  // Buyer confirms delivery → release payment
  app.put('/api/transactions/:id/confirm', authMiddleware, async (req, res) => {
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', req.params.id).single();
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm' });
    if (!['escrow', 'disputed'].includes(tx.status)) return res.status(400).json({ error: 'This deal is already settled.' });
    try {
      const updated = await escrow.releaseTransaction(tx.id, 'buyer');
      if (!updated) return res.status(400).json({ error: 'This deal is already settled.' });
      res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Seller marks the idea as delivered → starts the 7-day confirmation window
  app.put('/api/transactions/:id/deliver', authMiddleware, async (req, res) => {
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', req.params.id).single();
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can mark this delivered' });
    if (tx.status !== 'escrow') return res.status(400).json({ error: 'Only deals in escrow can be marked delivered.' });
    if (tx.delivered_at) return res.status(400).json({ error: 'Already marked as delivered.' });

    const now = new Date();
    const { data: updated, error } = await supabase.from('transactions')
      .update({ delivered_at: now.toISOString(), buyer_reminders: 0 }).eq('id', tx.id).eq('status', 'escrow').select().single();
    if (error) return res.status(500).json({ error: error.message });

    const note = String(req.body?.note || '').trim().slice(0, 2000);
    if (note) await supabase.from('messages').insert([{ from_id: tx.seller_id, to_id: tx.buyer_id, text: note, idea_id: tx.idea_id }]);

    const deadline = new Date(now.getTime() + 7 * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    await escrow.notify(tx.buyer_id, { type: 'delivered', title: '📦 Idea Delivered', message: `The creator delivered "${tx.idea_title}". Please confirm or open a dispute by ${deadline}, otherwise the payment is released automatically.`, link: '/transactions' });
    await escrow.emailUser(tx.buyer_id, `"${tx.idea_title}" has been delivered`, 'Your idea has been delivered',
      `The creator marked <strong>"${escrow.esc(tx.idea_title)}"</strong> as delivered. Please review what you received and confirm, or open a dispute if something is wrong.<br><br>If you do nothing, the payment is released to the creator automatically on <strong>${deadline}</strong>.`,
      'Review and confirm', '/transactions');
    res.json(updated);
  });

  // Buyer opens a dispute → payment is frozen until IdeaHub decides
  app.post('/api/transactions/:id/dispute', authMiddleware, async (req, res) => {
    const reason = String(req.body?.reason || '').trim().slice(0, 2000);
    if (reason.length < 10) return res.status(400).json({ error: 'Please describe the problem (at least 10 characters).' });
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', req.params.id).single();
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can open a dispute' });
    if (tx.status !== 'escrow') return res.status(400).json({ error: 'Only deals in escrow can be disputed.' });

    const { data: updated, error } = await supabase.from('transactions')
      .update({ status: 'disputed', disputed_at: new Date().toISOString(), dispute_reason: reason })
      .eq('id', tx.id).eq('status', 'escrow').select().single();
    if (error) return res.status(500).json({ error: error.message });

    await escrow.notify(tx.seller_id, { type: 'disputed', title: '⚠️ Dispute Opened', message: `The buyer opened a dispute on "${tx.idea_title}". The payment is on hold while IdeaHub reviews it.`, link: '/transactions' });
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const a of admins || []) await escrow.notify(a.id, { type: 'disputed', title: '⚠️ New Dispute', message: `Dispute on "${tx.idea_title}" (${escrow.money(tx.amount)}): ${reason.slice(0, 120)}`, link: '/admin' });
    await sendEmail(process.env.ADMIN_EMAIL || 'jbandara9835@gmail.com', `Dispute opened: "${tx.idea_title}"`,
      escrow.emailShell('A buyer opened a dispute', `Deal #${escrow.esc(tx.id)}: <strong>"${escrow.esc(tx.idea_title)}"</strong> for ${escrow.money(tx.amount)}.<br><br><em>${escrow.esc(reason)}</em>`, 'Open admin panel', '/admin'));
    res.json(updated);
  });

  // Buyer rates the creator after a completed purchase (once per deal)
  app.post('/api/transactions/:id/rate', authMiddleware, async (req, res) => {
    const stars = parseInt(req.body?.stars, 10);
    const review = String(req.body?.review || '').trim().slice(0, 1000);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Stars must be between 1 and 5' });
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', req.params.id).single();
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can rate this deal' });
    if (tx.status !== 'completed') return res.status(400).json({ error: 'You can rate once the deal is completed.' });

    const { data, error } = await supabase.from('deal_ratings').insert([{
      transaction_id: String(tx.id), idea_id: tx.idea_id, seller_id: tx.seller_id, buyer_id: tx.buyer_id, stars, review: review || null
    }]).select().single();
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'You have already rated this deal.' });
      return res.status(500).json({ error: error.message });
    }
    await escrow.notify(tx.seller_id, { type: 'new_rating', title: '⭐ New Rating', message: `A buyer rated you ${stars}/5 for "${tx.idea_title}".`, link: `/public-profile?id=${tx.seller_id}` });
    res.status(201).json(data);
  });

  // Public reviews + rating summary for a profile
  app.get('/api/users/:id/reviews', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid user' });
    const [dealRes, hireRes, userRes] = await Promise.all([
      supabase.from('deal_ratings').select('stars, review, created_at, idea:idea_id(title), buyer:buyer_id(first_name)')
        .eq('seller_id', id).order('created_at', { ascending: false }).limit(50),
      supabase.from('ratings').select('stars, review, created_at, rater:rater_user_id(first_name)')
        .eq('rated_user_id', id).order('created_at', { ascending: false }).limit(50),
      supabase.from('users').select('profile_stars, rating_avg, rating_count, deals_completed').eq('id', id).single()
    ]);
    const reviews = [
      ...(dealRes.data || []).map(r => ({ stars: r.stars, review: r.review, created_at: r.created_at, reviewer: r.buyer?.first_name || 'Buyer', context: r.idea?.title ? `Bought "${r.idea.title}"` : 'Idea purchase' })),
      ...(hireRes.data || []).map(r => ({ stars: r.stars, review: r.review, created_at: r.created_at, reviewer: r.rater?.first_name || 'Client', context: 'Hired for a service' }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const u = userRes.data || {};
    res.json({
      profile_stars: u.profile_stars || 0, rating_avg: u.rating_avg, rating_count: u.rating_count || reviews.length,
      deals_completed: u.deals_completed || 0, reviews
    });
  });

  // Admin: list open disputes
  app.get('/api/admin/disputes', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('transactions')
      .select('*, buyer:buyer_id(first_name, last_name, email), seller:seller_id(first_name, last_name, email)')
      .eq('status', 'disputed').order('disputed_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── ORIGINALITY CHECK ────────────────────────────────────────────────────────
  // Creator presses "Check originality" on the submit page (counts toward a daily limit)
  app.post('/api/originality/check', authMiddleware, async (req, res) => {
    const b = req.body || {};
    const ideaId = b.ideaId ? parseInt(b.ideaId, 10) || null : null;
    const out = await originality.check(
      { title: b.title, summary: b.summary, desc: b.desc, industry: b.industry, ideaType: b.ideaType },
      { userId: req.user.id, ideaId, manual: true });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(originality.forCreator(out.result));
  });

  // Admin: re-run the check on any idea (ignores the cache)
  app.post('/api/admin/ideas/:id/originality', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data: idea } = await supabase.from('ideas').select('*').eq('id', req.params.id).single();
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    const out = await originality.check(
      { title: idea.title, summary: idea.summary, desc: idea.description, industry: idea.industry, ideaType: idea.idea_type },
      { userId: idea.creator_id, ideaId: idea.id, force: true });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out.result);
  });

  // Admin: approve (make live) or reject (take down) any idea, with a reason sent to the creator
  app.put('/api/admin/ideas/:id/moderate', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const action = req.body?.action;
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    if (action === 'reject' && !reason) return res.status(400).json({ error: 'Please give a reason. The creator will see it.' });

    // Never touch an idea with a deal in progress or completed
    const from = action === 'approve' ? ['under_review', 'rejected'] : ['live', 'under_review'];
    const { data: before } = await supabase.from('ideas').select('originality').eq('id', req.params.id).single();
    const { data: rows, error } = await supabase.from('ideas')
      .update({ status: action === 'approve' ? 'live' : 'rejected',
        moderation: { by: 'admin', action, note: reason || null, hash: before?.originality?.hash || null, at: new Date().toISOString() } })
      .eq('id', req.params.id).in('status', from).select();
    if (error) return res.status(500).json({ error: error.message });
    const idea = rows && rows[0];
    if (!idea) return res.status(400).json({ error: action === 'approve'
      ? 'Only ideas that are under review or rejected can be approved.'
      : 'Only live or under-review ideas can be rejected. Ideas with a deal in progress or sold can\'t be taken down.' });

    await supabase.from('idea_appeals').update({ status: action === 'approve' ? 'overturned' : 'upheld', admin_note: reason || null, resolved_at: new Date().toISOString() })
      .eq('idea_id', idea.id).eq('status', 'open');
    if (action === 'approve') {
      await escrow.notify(idea.creator_id, { type: 'idea_approved', title: '✅ Your idea is live', message: `"${idea.title}" was approved and is now live on the marketplace.`, link: `/idea?id=${idea.id}` });
    } else {
      await escrow.notify(idea.creator_id, { type: 'idea_rejected', title: '❌ Your idea was taken down', message: `"${idea.title}" was removed from the marketplace. Reason: ${reason} You can edit it and resubmit for review.`, link: `/submit?edit=${idea.id}` });
      await escrow.emailUser(idea.creator_id, `Your idea "${idea.title}" needs changes`, 'Your idea was taken down',
        `<strong>"${escrow.esc(idea.title)}"</strong> was removed from the IdeaHub marketplace.<br><br><strong>Reason:</strong> ${escrow.esc(reason)}<br><br>You can edit the idea and resubmit it. We'll review it again.`,
        'Edit your idea', `/submit?edit=${idea.id}`);
    }
    res.json(idea);
  });

  // Admin: open appeals (filed by creators through Ask IdeaHub)
  app.get('/api/admin/appeals', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('idea_appeals')
      .select('id, idea_id, message, status, created_at, idea:idea_id(id, title, status, originality_score, moderation), user:user_id(first_name, last_name, email)')
      .eq('status', 'open').order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // Admin: decide an appeal — 'overturn' (idea goes live) or 'uphold' (decision stands)
  app.put('/api/admin/appeals/:id', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const decision = req.body?.decision;
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!['overturn', 'uphold'].includes(decision)) return res.status(400).json({ error: "decision must be 'overturn' or 'uphold'" });
    if (decision === 'uphold' && !note) return res.status(400).json({ error: 'Please explain why the decision stands. The creator will see it.' });
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('idea_appeals')
      .update({ status: decision === 'overturn' ? 'overturned' : 'upheld', admin_note: note || null, resolved_at: now })
      .eq('id', req.params.id).eq('status', 'open').select('id, idea_id, user_id');
    if (error) return res.status(500).json({ error: error.message });
    const appeal = rows && rows[0];
    if (!appeal) return res.status(400).json({ error: 'This appeal is already closed.' });
    const { data: idea } = await supabase.from('ideas').select('id, title, status, originality').eq('id', appeal.idea_id).single();
    if (decision === 'overturn' && idea && ['under_review', 'rejected'].includes(idea.status)) {
      await supabase.from('ideas').update({ status: 'live',
        moderation: { by: 'admin', action: 'approve', note: note || 'Appeal accepted', hash: idea.originality?.hash || null, at: now } })
        .eq('id', idea.id).in('status', ['under_review', 'rejected']);
    }
    const title = idea?.title || 'your idea';
    await escrow.notify(appeal.user_id, decision === 'overturn'
      ? { type: 'appeal_overturned', title: '✅ Appeal accepted', message: `Your appeal for "${title}" was accepted and the idea is now live.${note ? ' ' + note : ''}`, link: `/idea?id=${appeal.idea_id}` }
      : { type: 'appeal_upheld', title: 'Appeal reviewed', message: `Your appeal for "${title}" was reviewed and the decision stands. ${note} You can still edit the idea to make it more distinctive.`, link: `/submit?edit=${appeal.idea_id}` });
    res.json({ success: true });
  });

  // Admin: every idea with full details (patent review, moderation)
  app.get('/api/admin/ideas', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('ideas').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // Admin: approve or reject a user's verification request
  app.put('/api/admin/users/:id/verification', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const status = req.body?.status;
    if (!['verified', 'unverified'].includes(status)) return res.status(400).json({ error: "status must be 'verified' or 'unverified'" });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const { data: u, error } = await supabase.from('users').update({ verification_status: status }).eq('id', req.params.id).select('id').single();
    if (error || !u) return res.status(400).json({ error: error?.message || 'User not found' });
    await escrow.notify(u.id, status === 'verified'
      ? { type: 'verification_approved', title: '✅ Your profile is verified', message: 'Your IdeaHub profile now shows the verified badge.', link: '/profile' }
      : { type: 'verification_rejected', title: '❌ Verification not approved', message: `Your verification request was not approved.${reason ? ' Reason: ' + reason : ''} You can update your profile and submit again.`, link: '/profile' });
    res.json({ success: true });
  });

  // Admin: settle a dispute — outcome 'release' (pay seller) or 'refund' (back to buyer)
  app.put('/api/admin/transactions/:id/resolve', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { outcome } = req.body || {};
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    try {
      const result = outcome === 'release' ? await escrow.releaseTransaction(req.params.id, 'admin', note)
        : outcome === 'refund' ? await escrow.refundTransaction(req.params.id, note)
        : undefined;
      if (result === undefined) return res.status(400).json({ error: "outcome must be 'release' or 'refund'" });
      if (!result) return res.status(400).json({ error: 'This deal is already settled.' });
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/transactions', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('transactions').select('*')
      .or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const ids = (data || []).map(t => String(t.id));
    let rated = new Set();
    if (ids.length) {
      const { data: rs } = await supabase.from('deal_ratings').select('transaction_id').in('transaction_id', ids);
      rated = new Set((rs || []).map(r => String(r.transaction_id)));
    }
    res.json((data || []).map(t => ({ ...t, rated: rated.has(String(t.id)) })));
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

    // Notify recipient
    const { data: sender } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
    const senderName = sender ? `${sender.first_name} ${sender.last_name||''}`.trim() : 'Someone';
    await supabase.from('notifications').insert([{
      user_id: parseInt(toId),
      type: 'new_message',
      title: '💬 New Message',
      message: `${senderName} sent you a message: "${text.slice(0,60)}${text.length>60?'...':''}"`,
      link: `/messages?user=${req.user.id}`,
      data: { from_id: req.user.id }
    }]);

    // Email notification
    const { data: recipient } = await supabase.from('users').select('email, first_name').eq('id', parseInt(toId)).single();
    if (recipient?.email) {
      sendEmail(recipient.email, `💬 New message from ${senderName} — IdeaHub`, `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
          <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
          <h2 style="margin-bottom:8px;">New message from ${senderName}</h2>
          <div style="background:#1e1e24;border-left:3px solid #f5c842;padding:14px;border-radius:8px;margin-bottom:20px;color:#9a9080;">"${text.slice(0,200)}${text.length>200?'...':''}"</div>
          <a href="https://ideahub.it.com/messages?user=${req.user.id}" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">Reply →</a>
          <p style="color:#6e6b65;font-size:12px;margin-top:24px;">IdeaHub by Picela (Pvt) Ltd</p>
        </div>
      `);
    }

    res.status(201).json(data);
  });

  // REQUEST a call (creates a special message of type 'call_request')
  app.post('/api/messages/call-request', authMiddleware, async (req, res) => {
    const { toId, callDate, note, meetLink } = req.body;
    if (!toId || !callDate) return res.status(400).json({ error: 'toId and callDate required' });
    const { data, error } = await supabase
      .from('messages')
      .insert([{
        from_id: req.user.id, to_id: parseInt(toId),
        text: note || '',
        type: 'call_request',
        call_date: callDate,
        call_status: meetLink ? 'accepted' : 'pending',
        meet_link: meetLink || null
      }])
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Notify recipient
    const { data: sender } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
    const senderName = sender ? `${sender.first_name} ${sender.last_name||''}`.trim() : 'Someone';
    await supabase.from('notifications').insert([{
      user_id: parseInt(toId),
      type: meetLink ? 'call_now' : 'call_request',
      title: meetLink ? '📞 Incoming Call!' : '📅 Call Request',
      message: meetLink ? `${senderName} is calling you now!` : `${senderName} requested a call.`,
      link: `/messages?user=${req.user.id}`,
      data: { from_id: req.user.id }
    }]);

    res.status(201).json(data);
  });

  // RESPOND to a call request (accept with meet link, or decline)
  app.put('/api/messages/:id/call-response', authMiddleware, async (req, res) => {
    const { status, meetLink } = req.body; // status: 'accepted' or 'declined'
    if (!['accepted','declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { data: msg } = await supabase.from('messages').select('*').eq('id', req.params.id).single();
    if (!msg) return res.status(404).json({ error: 'Call request not found' });
    if (msg.to_id !== req.user.id) return res.status(403).json({ error: 'Only the recipient can respond' });
    if (msg.type !== 'call_request') return res.status(400).json({ error: 'Not a call request' });

    const updateData = { call_status: status };
    if (status === 'accepted' && meetLink) updateData.meet_link = meetLink;

    const { data, error } = await supabase
      .from('messages')
      .update(updateData)
      .eq('id', req.params.id)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Notify original requester
    const { data: responder } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
    const responderName = responder ? `${responder.first_name} ${responder.last_name||''}`.trim() : 'Someone';
    await supabase.from('notifications').insert([{
      user_id: msg.from_id,
      type: 'call_response',
      title: status === 'accepted' ? '✅ Call Accepted!' : '❌ Call Declined',
      message: status === 'accepted' ? `${responderName} accepted your call request.` : `${responderName} declined your call request.`,
      link: `/messages?user=${req.user.id}`,
      data: { from_id: req.user.id }
    }]);

    res.json(data);
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

    const ideas = (ideasRes.data || []).map(ownerIdea);
    res.json({
      ideasPosted: ideas.length,
      totalViews: ideas.reduce((s, i) => s + (i.views || 0), 0),
      inquiries: ideas.reduce((s, i) => s + (i.inquiries || 0), 0),
      earnings: userRes.data?.earnings || 0,
      ideas,
      recentTransactions: txRes.data || [],
    });
  });
  // ── IDEA REQUESTS ─────────────────────────────────────────────────────────────

  // GET all open requests (public browse)
  app.get('/api/requests', async (req, res) => {
    let query = supabase
      .from('idea_requests')
      .select('*')
      .in('status', ['open', 'proposals_received', 'shortlisting', 'pitching']);

    if (req.query.industry && req.query.industry !== 'all') {
      query = query.eq('industry', req.query.industry);
    }
    if (req.query.search) {
      query = query.ilike('title', `%${req.query.search}%`);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json(data || []);
  });

  // GET single request
  app.get('/api/requests/:id', async (req, res) => {
    const { data, error } = await supabase
      .from('idea_requests')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!data || error) return res.status(404).json({ error: 'Request not found' });
    supabase.from('idea_requests').update({ view_count: (data.view_count || 0) + 1 }).eq('id', data.id).then(() => {});
    res.json(data);
  });

  // Matching for one request: fitting ideas (everyone), suggested creators (the investor/admin), "you're a match" (matched creator)
  const matchCache = new Map();
  app.get('/api/requests/:id/matches', async (req, res) => {
    const { data: r } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const viewer = await viewerContext(req);
    let m = matchCache.get(r.id);
    if (!m || Date.now() - m.at > 10 * 60 * 1000) {
      try { m = { at: Date.now(), ...(await matching.suggest(r)) }; matchCache.set(r.id, m); }
      catch (e) { return res.status(500).json({ error: 'Matching is unavailable right now.' }); }
    }
    const out = { ideas: m.ideas };
    const isOwner = viewer.id && viewer.id === r.investor_id;
    if (isOwner || viewer.role === 'admin') {
      const { data: rows } = await supabase.from('request_matches').select('creator_id, invited_at, notified_at').eq('request_id', r.id);
      const st = Object.fromEntries((rows || []).map(x => [x.creator_id, x]));
      out.creators = m.creators.map(c => ({ ...c, invited: !!st[c.id]?.invited_at, alerted: !!st[c.id]?.notified_at }));
    }
    if (viewer.id && !isOwner) {
      const mine = m.creators.find(c => c.id === viewer.id);
      if (mine) out.me = { reasons: mine.reasons };
      else {
        const { data: row } = await supabase.from('request_matches').select('reasons, invited_at').eq('request_id', r.id).eq('creator_id', viewer.id).maybeSingle();
        if (row) out.me = { reasons: row.reasons || [], invited: !!row.invited_at };
      }
    }
    res.json(out);
  });

  // Investor invites a suggested creator to send a proposal
  app.post('/api/requests/:id/invite', authMiddleware, async (req, res) => {
    const creatorId = parseInt(req.body?.creatorId, 10);
    const { data: r } = await supabase.from('idea_requests').select('id, title, investor_id, investor_name, status').eq('id', req.params.id).single();
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor who posted this request can invite creators.' });
    if (!matching.OPEN.includes(r.status)) return res.status(400).json({ error: 'This request is no longer open.' });
    const { data: c } = await supabase.from('users').select('id, role').eq('id', creatorId).single();
    if (!c || !['idea_creator', 'patent_seller'].includes(c.role)) return res.status(400).json({ error: 'That user is not an idea creator.' });
    const { count } = await supabase.from('request_matches').select('id', { count: 'exact', head: true }).eq('request_id', r.id).not('invited_at', 'is', null);
    if ((count || 0) >= 25) return res.status(429).json({ error: 'You can invite up to 25 creators per request.' });
    const { data: existing } = await supabase.from('request_matches').select('id, invited_at').eq('request_id', r.id).eq('creator_id', creatorId).maybeSingle();
    if (existing?.invited_at) return res.json({ success: true, already: true });
    const now = new Date().toISOString();
    if (existing) await supabase.from('request_matches').update({ invited_at: now }).eq('id', existing.id);
    else await supabase.from('request_matches').insert([{ request_id: r.id, creator_id: creatorId, invited_at: now, reasons: ['Invited by the investor'] }]);
    await escrow.notify(creatorId, { type: 'request_invite', title: '✉️ You were invited to pitch',
      message: `${r.investor_name || 'An investor'} invited you to send a proposal for "${r.title}".`, link: `/request/${r.id}` });
    res.json({ success: true });
  });

  // Requests the signed-in creator was matched or invited to (for the "Matched to you" filter)
  app.get('/api/my-request-matches', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('request_matches').select('request_id, invited_at').eq('creator_id', req.user.id)
      .order('created_at', { ascending: false }).limit(300);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // POST new idea request (investor only)
  app.post('/api/requests', authMiddleware, async (req, res) => {
    const { title, problem, industry, budget_min, budget_max, deadline, requirements } = req.body;
    if (!title || !problem) return res.status(400).json({ error: 'Title and problem description are required' });

    const { data: investor } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();

    const { data: request, error } = await supabase
      .from('idea_requests')
      .insert([{
        investor_id: req.user.id,
        investor_name: investor ? `${investor.first_name} ${investor.last_name}` : 'Anonymous',
        title, problem, industry,
        budget_min: budget_min || null,
        budget_max: budget_max || null,
        deadline: deadline || null,
        requirements: requirements || '',
        status: 'open',
        proposal_count: 0,
        view_count: 0
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Alert only the creators who fit this request (see matching.js), not every creator on the site
    setImmediate(() => matching.notifyNewRequest(request)
      .then(n => console.log(`Request ${request.id}: alerted ${n} matched creators`))
      .catch(e => console.error('Request matching failed:', e.message)));

    res.status(201).json(request);
  });

  // UPDATE request status
  app.put('/api/requests/:id/status', authMiddleware, async (req, res) => {
    const { status } = req.body;
    const { data: request } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor can update this' });

    const { data, error } = await supabase
      .from('idea_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // GET my requests (as investor)
  app.get('/api/my-requests', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('idea_requests')
      .select('*')
      .eq('investor_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // LOCK ESCROW for selected proposal
  app.post('/api/requests/:id/escrow', authMiddleware, async (req, res) => {
    const { amount, proposal_id, creator_id } = req.body;
    const { data: request } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor can lock escrow' });

    const { data, error } = await supabase
      .from('idea_requests')
      .update({
        status: 'in_escrow',
        escrow_amount: amount,
        escrow_locked_at: new Date().toISOString(),
        selected_creator_id: creator_id,
        selected_proposal_id: proposal_id,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify selected creator
    await supabase.from('notifications').insert([{
      user_id: creator_id,
      type: 'escrow_locked',
      title: '🔒 Escrow Locked!',
      message: `The investor has locked $${amount} in escrow for your proposal. Please deliver your idea.`,
      link: `/request/${req.params.id}`,
      data: { request_id: req.params.id, amount }
    }]);

    res.json(data);
  });

  // MARK as delivered (creator)
  app.post('/api/requests/:id/deliver', authMiddleware, async (req, res) => {
    const { data: request } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.selected_creator_id !== req.user.id) return res.status(403).json({ error: 'Only the selected creator can mark as delivered' });

    const { data, error } = await supabase
      .from('idea_requests')
      .update({ status: 'delivered', delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify investor
    await supabase.from('notifications').insert([{
      user_id: request.investor_id,
      type: 'delivered',
      title: '📦 Idea Delivered!',
      message: `The creator has delivered the idea for "${request.title}". Please review and confirm.`,
      link: `/request/${req.params.id}`,
      data: { request_id: req.params.id }
    }]);

    res.json(data);
  });

  // CONFIRM delivery & release escrow (investor)
  app.post('/api/requests/:id/confirm', authMiddleware, async (req, res) => {
    const { data: request } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor can confirm' });

    const { data, error } = await supabase
      .from('idea_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Update creator earnings
    if (request.selected_creator_id && request.escrow_amount) {
      const { data: creator } = await supabase.from('users').select('earnings').eq('id', request.selected_creator_id).single();
      await supabase.from('users').update({ earnings: (creator?.earnings || 0) + request.escrow_amount }).eq('id', request.selected_creator_id);
    }

    // Notify creator
    await supabase.from('notifications').insert([{
      user_id: request.selected_creator_id,
      type: 'completed',
      title: '💰 Payment Released!',
      message: `The investor confirmed delivery. $${request.escrow_amount} has been added to your earnings!`,
      link: `/request/${req.params.id}`,
      data: { request_id: req.params.id, amount: request.escrow_amount }
    }]);

    res.json(data);
  });

  // DISPUTE a request
  app.post('/api/requests/:id/dispute', authMiddleware, async (req, res) => {
    const { reason } = req.body;
    const { data: request } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor can dispute' });

    const { data, error } = await supabase
      .from('idea_requests')
      .update({ status: 'disputed', disputed_at: new Date().toISOString(), dispute_reason: reason, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // ── PROPOSALS ─────────────────────────────────────────────────────────────────

  // GET all proposals for a request
  app.get('/api/requests/:id/proposals', authMiddleware, async (req, res) => {
    const { data: request } = await supabase.from('idea_requests').select('investor_id').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor can view all proposals' });

    const { data, error } = await supabase
      .from('idea_proposals')
      .select('*, creator:creator_id(id, first_name, last_name, role, bio, earnings)')
      .eq('request_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // GET my proposal for a request (creator)
  app.get('/api/requests/:id/my-proposal', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('idea_proposals')
      .select('*')
      .eq('request_id', req.params.id)
      .eq('creator_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data || null);
  });

  // SUBMIT a proposal (creator)
  app.post('/api/requests/:id/proposals', authMiddleware, async (req, res) => {
    const { title, summary, approach, proposed_price, delivery_days } = req.body;
    if (!title || !summary) return res.status(400).json({ error: 'Title and summary are required' });

    const { data: request } = await supabase.from('idea_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (!['open', 'proposals_received'].includes(request.status)) return res.status(400).json({ error: 'This request is no longer accepting proposals' });

    const { data: creator } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();

    const { data, error } = await supabase
      .from('idea_proposals')
      .insert([{
        request_id: parseInt(req.params.id),
        creator_id: req.user.id,
        creator_name: creator ? `${creator.first_name} ${creator.last_name}` : 'Anonymous',
        title, summary, approach,
        proposed_price: proposed_price || null,
        delivery_days: delivery_days || null,
        status: 'pending'
      }])
      .select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'You have already submitted a proposal for this request' });
      return res.status(500).json({ error: error.message });
    }

    // Update request status
    await supabase.from('idea_requests').update({ status: 'proposals_received', updated_at: new Date().toISOString() }).eq('id', req.params.id);

    // Notify investor
    await supabase.from('notifications').insert([{
      user_id: request.investor_id,
      type: 'proposal_received',
      title: '📝 New Proposal Received!',
      message: `${creator?.first_name || 'A creator'} submitted a proposal for "${request.title}"`,
      link: `/request/${req.params.id}`,
      data: { request_id: req.params.id, proposal_id: data.id }
    }]);

    // Email investor — new proposal
    const { data: investor } = await supabase.from('users').select('email, first_name').eq('id', request.investor_id).single();
    if (investor?.email) {
      sendEmail(investor.email, `📝 New proposal for "${request.title}" — IdeaHub`, `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
          <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
          <h2 style="margin-bottom:8px;">New proposal received! 📝</h2>
          <p style="color:#9a9080;line-height:1.7;margin-bottom:16px;"><strong>${creator?.first_name || 'A creator'} ${creator?.last_name || ''}</strong> submitted a proposal for your request <strong>"${request.title}"</strong>.</p>
          <a href="https://ideahub.it.com/request-detail?id=${req.params.id}" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">Review Proposal →</a>
          <p style="color:#6e6b65;font-size:12px;margin-top:24px;">IdeaHub by Picela (Pvt) Ltd</p>
        </div>
      `);
    }

    res.status(201).json(data);
  });

  // UPDATE proposal status (investor shortlists / invites / rejects)
  app.put('/api/proposals/:id/status', authMiddleware, async (req, res) => {
    const { status } = req.body;
    const { data: proposal } = await supabase.from('idea_proposals').select('*, request:request_id(investor_id, title)').eq('id', req.params.id).single();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.request.investor_id !== req.user.id) return res.status(403).json({ error: 'Only the investor can update proposal status' });

    const updateData = { status, updated_at: new Date().toISOString() };
    if (status === 'invited_to_pitch') updateData.pitch_requested_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('idea_proposals')
      .update(updateData)
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify creator
    const notifMap = {
      shortlisted: { title: '⭐ You\'ve been shortlisted!', msg: `Your proposal for "${proposal.request.title}" has been shortlisted by the investor.` },
      invited_to_pitch: { title: '🎤 Pitch Invitation!', msg: `You\'ve been invited to pitch your idea for "${proposal.request.title}". Check your messages!` },
      rejected: { title: '❌ Proposal Not Selected', msg: `Your proposal for "${proposal.request.title}" was not selected this time.` },
      selected: { title: '🏆 Your Proposal Was Selected!', msg: `Congratulations! The investor selected your proposal for "${proposal.request.title}". Escrow will be locked soon.` }
    };

    if (notifMap[status]) {
      await supabase.from('notifications').insert([{
        user_id: proposal.creator_id,
        type: status,
        title: notifMap[status].title,
        message: notifMap[status].msg,
        link: `/request/${proposal.request_id}`,
        data: { request_id: proposal.request_id, proposal_id: proposal.id }
      }]);
    }

    // If selected, update request
    if (status === 'selected') {
      await supabase.from('idea_requests').update({
        status: 'agreed',
        selected_creator_id: proposal.creator_id,
        selected_proposal_id: proposal.id,
        updated_at: new Date().toISOString()
      }).eq('id', proposal.request_id);
    }

    res.json(data);
  });

  // ── REQUEST MESSAGES ──────────────────────────────────────────────────────────

  // GET messages for a request between investor and specific creator
  app.get('/api/requests/:id/messages/:creatorId', authMiddleware, async (req, res) => {
    const myId = req.user.id;
    const otherId = parseInt(req.params.creatorId);

    const { data, error } = await supabase
      .from('request_messages')
      .select('*')
      .eq('request_id', req.params.id)
      .or(`and(from_id.eq.${myId},to_id.eq.${otherId}),and(from_id.eq.${otherId},to_id.eq.${myId})`)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Mark as read
    await supabase.from('request_messages').update({ is_read: true }).eq('request_id', req.params.id).eq('to_id', myId);

    res.json(data || []);
  });

  // POST message in a request
  app.post('/api/requests/:id/messages', authMiddleware, async (req, res) => {
    const { to_id, text, proposal_id } = req.body;
    if (!to_id || !text) return res.status(400).json({ error: 'to_id and text required' });

    const { data, error } = await supabase
      .from('request_messages')
      .insert([{
        request_id: parseInt(req.params.id),
        proposal_id: proposal_id || null,
        from_id: req.user.id,
        to_id: parseInt(to_id),
        text
      }])
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify recipient
    const { data: sender } = await supabase.from('users').select('first_name').eq('id', req.user.id).single();
    await supabase.from('notifications').insert([{
      user_id: parseInt(to_id),
      type: 'message',
      title: '💬 New Message',
      message: `${sender?.first_name || 'Someone'} sent you a message about a request`,
      link: `/request/${req.params.id}`,
      data: { request_id: req.params.id }
    }]);

    res.status(201).json(data);
  });

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────────

  // GET my notifications
  app.get('/api/notifications', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // MARK notification as read
  app.put('/api/notifications/:id/read', authMiddleware, async (req, res) => {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // MARK ALL notifications as read
  app.put('/api/notifications/read-all', authMiddleware, async (req, res) => {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // GET unread notification count
  app.get('/api/notifications/unread-count', authMiddleware, async (req, res) => {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: count || 0 });
  });
  // ── BUSINESS LISTINGS ─────────────────────────────────────────────────────────

  // GET all active business listings (public browse)
  app.get('/api/businesses', async (req, res) => {
    let query = supabase
      .from('business_listings')
      .select('*')
      .eq('status', 'active');

    if (req.query.industry && req.query.industry !== 'all') {
      query = query.eq('industry', req.query.industry);
    }
    if (req.query.type) {
      query = query.contains('expansion_types', [req.query.type]);
    }
    if (req.query.search) {
      query = query.ilike('business_name', `%${req.query.search}%`);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // GET single business listing
  app.get('/api/businesses/:id', async (req, res) => {
    const { data, error } = await supabase
      .from('business_listings')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!data || error) return res.status(404).json({ error: 'Business not found' });

    // increment view count
    await supabase.from('business_listings').update({ view_count: (data.view_count || 0) + 1 }).eq('id', data.id);

    res.json(data);
  });

  // POST new business listing (business owner)
  app.post('/api/businesses', authMiddleware, async (req, res) => {
    const { business_name, tagline, description, industry, founded_year, country, city, website, expansion_types, annual_revenue, employees, locations, investment_min, investment_max, territories, requirements } = req.body;

    if (!business_name || !description) return res.status(400).json({ error: 'Business name and description are required' });

    const { data: owner } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();

    const { data, error } = await supabase
      .from('business_listings')
      .insert([{
        owner_id: req.user.id,
        owner_name: owner ? `${owner.first_name} ${owner.last_name}` : 'Anonymous',
        business_name, tagline, description, industry,
        founded_year: founded_year || null,
        country, city, website,
        expansion_types: expansion_types || [],
        annual_revenue, employees,
        locations: locations || 1,
        investment_min: investment_min || null,
        investment_max: investment_max || null,
        territories: territories || [],
        requirements: requirements || '',
        status: 'active'
      }])
      .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  // UPDATE business listing
  app.put('/api/businesses/:id', authMiddleware, async (req, res) => {
    const { data: listing } = await supabase.from('business_listings').select('owner_id').eq('id', req.params.id).single();
    if (!listing) return res.status(404).json({ error: 'Business not found' });
    if (listing.owner_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const { business_name, tagline, description, industry, founded_year, country, city, website, expansion_types, annual_revenue, employees, locations, investment_min, investment_max, territories, requirements, status } = req.body;

    const { data, error } = await supabase
      .from('business_listings')
      .update({ business_name, tagline, description, industry, founded_year, country, city, website, expansion_types, annual_revenue, employees, locations, investment_min, investment_max, territories, requirements, status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // DELETE business listing
  app.delete('/api/businesses/:id', authMiddleware, async (req, res) => {
    const { data: listing } = await supabase.from('business_listings').select('owner_id').eq('id', req.params.id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const { error } = await supabase.from('business_listings').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Listing deleted' });
  });

  // GET my business listings
  app.get('/api/my-businesses', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('business_listings')
      .select('*')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── EXPANSION APPLICATIONS ────────────────────────────────────────────────────

  // GET all applications for a listing (owner only)
  app.get('/api/businesses/:id/applications', authMiddleware, async (req, res) => {
    const { data: listing } = await supabase.from('business_listings').select('owner_id').eq('id', req.params.id).single();
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (listing.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can view applications' });

    const { data, error } = await supabase
      .from('expansion_applications')
      .select('*, investor:investor_id(id, first_name, last_name, role, country, bio)')
      .eq('listing_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // GET my application for a listing
  app.get('/api/businesses/:id/my-application', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('expansion_applications')
      .select('*')
      .eq('listing_id', req.params.id)
      .eq('investor_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data || null);
  });

  // SUBMIT application (investor)
  app.post('/api/businesses/:id/apply', authMiddleware, async (req, res) => {
    const { expansion_type, message, investment_capacity, territory, background } = req.body;
    if (!expansion_type || !message) return res.status(400).json({ error: 'Expansion type and message are required' });

    const { data: listing } = await supabase.from('business_listings').select('*').eq('id', req.params.id).single();
    if (!listing) return res.status(404).json({ error: 'Business not found' });
    if (listing.status !== 'active') return res.status(400).json({ error: 'This listing is no longer active' });
    if (listing.owner_id === req.user.id) return res.status(400).json({ error: 'You cannot apply to your own listing' });

    const { data: investor } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();

    const { data, error } = await supabase
      .from('expansion_applications')
      .insert([{
        listing_id: parseInt(req.params.id),
        investor_id: req.user.id,
        investor_name: investor ? `${investor.first_name} ${investor.last_name}` : 'Anonymous',
        expansion_type, message, investment_capacity, territory, background,
        status: 'pending'
      }])
      .select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'You have already applied to this listing' });
      return res.status(500).json({ error: error.message });
    }

    // Notify business owner
    await supabase.from('notifications').insert([{
      user_id: listing.owner_id,
      type: 'new_application',
      title: '📋 New Expansion Application!',
      message: `${investor?.first_name || 'An investor'} applied for ${expansion_type} of "${listing.business_name}"`,
      link: `/business/${req.params.id}`,
      data: { listing_id: req.params.id, application_id: data.id }
    }]);

    res.status(201).json(data);
  });

  // UPDATE application status (owner)
  app.put('/api/expansion-applications/:id/status', authMiddleware, async (req, res) => {
    const { status, meetup_type, meetup_date, meetup_location, meetup_notes } = req.body;

    const { data: app } = await supabase
      .from('expansion_applications')
      .select('*, listing:listing_id(owner_id, business_name)')
      .eq('id', req.params.id).single();

    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.listing.owner_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const updateData = { status, updated_at: new Date().toISOString() };
    if (meetup_type) updateData.meetup_type = meetup_type;
    if (meetup_date) updateData.meetup_date = meetup_date;
    if (meetup_location) updateData.meetup_location = meetup_location;
    if (meetup_notes) updateData.meetup_notes = meetup_notes;

    const { data, error } = await supabase
      .from('expansion_applications')
      .update(updateData)
      .eq('id', req.params.id)
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify investor
    const notifMap = {
      reviewed: { title: '👀 Application Reviewed', msg: `Your application for "${app.listing.business_name}" has been reviewed.` },
      shortlisted: { title: '⭐ You\'ve Been Shortlisted!', msg: `Your expansion application for "${app.listing.business_name}" was shortlisted!` },
      meetup_scheduled: { title: '📅 Meetup Scheduled!', msg: `A meetup has been scheduled for "${app.listing.business_name}". Check the details in your application.` },
      negotiating: { title: '🤝 Negotiation Started', msg: `The business owner wants to negotiate terms for "${app.listing.business_name}".` },
      agreed: { title: '🎉 Agreement Reached!', msg: `Congratulations! You\'ve reached an agreement with "${app.listing.business_name}".` },
      rejected: { title: '❌ Application Not Selected', msg: `Your application for "${app.listing.business_name}" was not selected this time.` }
    };

    if (notifMap[status]) {
      await supabase.from('notifications').insert([{
        user_id: app.investor_id,
        type: status,
        title: notifMap[status].title,
        message: notifMap[status].msg,
        link: `/business/${app.listing_id}`,
        data: { listing_id: app.listing_id, application_id: app.id }
      }]);
    }

    res.json(data);
  });

  // GET my applications as investor
  app.get('/api/my-expansion-applications', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
      .from('expansion_applications')
      .select('*, listing:listing_id(id, business_name, industry, country, expansion_types)')
      .eq('investor_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── EXPANSION MESSAGES ────────────────────────────────────────────────────────

  // GET messages for an application
  app.get('/api/expansion-applications/:id/messages', authMiddleware, async (req, res) => {
    const { data: app } = await supabase
      .from('expansion_applications')
      .select('investor_id, listing:listing_id(owner_id)')
      .eq('id', req.params.id).single();

    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.investor_id !== req.user.id && app.listing.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { data, error } = await supabase
      .from('expansion_messages')
      .select('*')
      .eq('application_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Mark as read
    await supabase.from('expansion_messages').update({ is_read: true }).eq('application_id', req.params.id).eq('to_id', req.user.id);

    res.json(data || []);
  });

  // POST message in an application
  app.post('/api/expansion-applications/:id/messages', authMiddleware, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Message text required' });

    const { data: app } = await supabase
      .from('expansion_applications')
      .select('investor_id, listing_id, listing:listing_id(owner_id, business_name)')
      .eq('id', req.params.id).single();

    if (!app) return res.status(404).json({ error: 'Not found' });

    const isOwner = app.listing.owner_id === req.user.id;
    const isInvestor = app.investor_id === req.user.id;
    if (!isOwner && !isInvestor) return res.status(403).json({ error: 'Not authorized' });

    const toId = isOwner ? app.investor_id : app.listing.owner_id;

    const { data, error } = await supabase
      .from('expansion_messages')
      .insert([{
        listing_id: app.listing_id,
        application_id: parseInt(req.params.id),
        from_id: req.user.id,
        to_id: toId,
        text
      }])
      .select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify recipient
    const { data: sender } = await supabase.from('users').select('first_name').eq('id', req.user.id).single();
    await supabase.from('notifications').insert([{
      user_id: toId,
      type: 'message',
      title: '💬 New Message',
      message: `${sender?.first_name || 'Someone'} sent you a message about "${app.listing.business_name}"`,
      link: `/business/${app.listing_id}`,
      data: { listing_id: app.listing_id, application_id: app.id }
    }]);

    res.status(201).json(data);
  });

  // ── EXPANSION RATINGS ─────────────────────────────────────────────────────────

  // SUBMIT rating after meetup
  app.post('/api/expansion-ratings', authMiddleware, async (req, res) => {
    const { application_id, rated_user_id, stars, review } = req.body;
    if (!application_id || !rated_user_id || !stars) return res.status(400).json({ error: 'application_id, rated_user_id and stars required' });
    if (stars < 1 || stars > 5) return res.status(400).json({ error: 'Stars must be 1-5' });

    const { data: app } = await supabase.from('expansion_applications').select('*').eq('id', application_id).single();
    if (!app) return res.status(404).json({ error: 'Application not found' });

    const { data, error } = await supabase
      .from('expansion_ratings')
      .insert([{ application_id, rated_user_id, rater_user_id: req.user.id, stars, review }])
      .select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'You have already rated this' });
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json(data);
  });

  // GET ratings for a user
  app.get('/api/expansion-ratings/:userId', async (req, res) => {
    const { data, error } = await supabase
      .from('expansion_ratings')
      .select('*, rater:rater_user_id(first_name, last_name)')
      .eq('rated_user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  app.post('/api/profile/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = req.file.mimetype.split('/')[1];
    const fileName = `avatar-${req.user.id}-${Date.now()}.${ext}`;
    try {
      const { error } = await supabase.storage.from('avatars').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (error) return res.status(500).json({ error: error.message });
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(fileName);
      await supabase.from('users').update({ avatar_url: urlData.publicUrl }).eq('id', req.user.id);
      res.json({ url: urlData.publicUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // ── ATTORNEY ──────────────────────────────────────────────────────────────────

  app.get('/api/attorney/cases', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('legal_cases')
      .select('*, client:client_id(id, first_name, last_name)')
      .eq('attorney_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const cases = (data||[]).map(c => ({ ...c, client_name: c.client ? `${c.client.first_name} ${c.client.last_name}` : null }));
    res.json(cases);
  });

  app.post('/api/attorney/cases', authMiddleware, async (req, res) => {
    const { title, case_type, deadline, description, client_id, fee } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const { data, error } = await supabase.from('legal_cases').insert([{
      attorney_id: req.user.id, title, case_type: case_type||'other',
      deadline: deadline||null, description: description||'',
      client_id: client_id||null, fee: fee||null, status: 'open'
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  app.put('/api/attorney/cases/:id', authMiddleware, async (req, res) => {
    const { status, notes, title, description, deadline, fee } = req.body;
    const updateData = { updated_at: new Date().toISOString() };
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (deadline !== undefined) updateData.deadline = deadline;
    if (fee !== undefined) updateData.fee = fee;
    const { data, error } = await supabase.from('legal_cases').update(updateData).eq('id', req.params.id).eq('attorney_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.get('/api/attorney/documents', authMiddleware, async (req, res) => {
    const { data: cases } = await supabase.from('legal_cases').select('id').eq('attorney_id', req.user.id);
    const caseIds = (cases||[]).map(c => c.id);
    if (!caseIds.length) return res.json([]);
    const { data, error } = await supabase.from('case_documents').select('*').in('case_id', caseIds).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data||[]);
  });

  app.post('/api/attorney/documents', authMiddleware, async (req, res) => {
    const { case_id, file_name, file_url, doc_type } = req.body;
    if (!file_url) return res.status(400).json({ error: 'File URL required' });
    const { data, error } = await supabase.from('case_documents').insert([{
      case_id: case_id||null, uploaded_by: req.user.id,
      file_name: file_name||'document', file_url, doc_type: doc_type||'other'
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  app.get('/api/attorney/verifications', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('identity_verifications').select('*').eq('requested_by', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data||[]);
  });

  app.post('/api/attorney/verify-request', authMiddleware, async (req, res) => {
    const { target_user_id, case_id, reason } = req.body;
    if (!target_user_id || !reason) return res.status(400).json({ error: 'Target user and reason required' });
    const { data, error } = await supabase.from('identity_verifications').insert([{
      requested_by: req.user.id, target_user_id, case_id: case_id||null, reason, status: 'pending'
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    // Notify admin
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    if (admins?.length) {
      await supabase.from('notifications').insert(admins.map(a => ({
        user_id: a.id, type: 'verify_request',
        title: '🔍 Identity Verification Request',
        message: `Attorney requested identity verification for user #${target_user_id}`,
        link: '/admin'
      })));
    }
    res.status(201).json(data);
  });

  app.get('/api/attorney/qualifications', authMiddleware, async (req, res) => {
    const { data, error } = await supabase.from('attorney_qualifications').select('*').eq('attorney_id', req.user.id).single();
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data||null);
  });

  app.post('/api/attorney/qualifications', authMiddleware, async (req, res) => {
    const { licence_number, bar_association, jurisdiction, licence_file_url, degree_file_url } = req.body;
    const { data: existing } = await supabase.from('attorney_qualifications').select('id').eq('attorney_id', req.user.id).single();
    let result;
    if (existing) {
      const { data, error } = await supabase.from('attorney_qualifications').update({ licence_number, bar_association, jurisdiction, licence_file_url, degree_file_url, status: 'pending', updated_at: new Date().toISOString() }).eq('attorney_id', req.user.id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      result = data;
    } else {
      const { data, error } = await supabase.from('attorney_qualifications').insert([{ attorney_id: req.user.id, licence_number, bar_association, jurisdiction, licence_file_url, degree_file_url, status: 'pending' }]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      result = data;
    }
    // Notify admin
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    if (admins?.length) {
      await supabase.from('notifications').insert(admins.map(a => ({
        user_id: a.id, type: 'qual_submitted',
        title: '🎓 Attorney Qualification Submitted',
        message: `An attorney submitted qualifications for verification`,
        link: '/admin'
      })));
    }
    res.json(result);
  });

  app.get('/api/users/search', authMiddleware, async (req, res) => {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json([]);
    const { data, error } = await supabase.from('users').select('id, first_name, last_name, role').or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`).neq('id', req.user.id).limit(8);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data||[]);
  });
  // Complete Google signup with selected role
  app.post('/api/auth/google-complete', async (req, res) => {
    const { email, first_name, last_name, avatar_url, google_id, role } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Email and role required' });

    // Check again if user exists (race condition protection)
    let { data: existing } = await supabase.from('users').select('*').eq('email', email).single();
    if (existing) {
      const token = require('jsonwebtoken').sign({ id: existing.id, email: existing.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const { password: _, ...safeUser } = existing;
      return res.json({ token, user: safeUser });
    }

    const { data: newUser, error } = await supabase.from('users').insert([{
      first_name, last_name, email,
      password: '', role,
      avatar_url: avatar_url || null,
      google_id, earnings: 0, verified: true, signup_country: req.headers['cf-ipcountry'] || null,
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Welcome email
    sendEmail(email, 'Welcome to IdeaHub! 🎉', `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
        <div style="font-size:28px;font-weight:800;color:#f5c842;margin-bottom:8px;">IdeaHub</div>
        <h2 style="font-size:22px;margin-bottom:12px;">Welcome, ${first_name}! 👋</h2>
        <p style="color:#9a9080;line-height:1.7;margin-bottom:20px;">Your account has been created successfully via Google.</p>
        <a href="https://ideahub.it.com/dashboard" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">Go to Dashboard →</a>
        <p style="color:#6e6b65;font-size:12px;">IdeaHub by Picela (Pvt) Ltd</p>
      </div>
    `);

    const token = require('jsonwebtoken').sign({ id: newUser.id, email: newUser.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = newUser;
    res.json({ token, user: safeUser });
  });

  app.get('/google-role-select', (req, res) => res.sendFile(__dirname + '/public/google-role-select.html'));
// ── SMS VERIFICATION ─────────────────────────────────────────────────────────

const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// SEND verification code
app.post('/api/sms/send-code', authMiddleware, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  // Generate 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // Save code to DB
  await supabase.from('sms_verifications').upsert([{
    user_id: req.user.id,
    phone,
    code,
    expires_at: expiresAt,
    verified: false
  }], { onConflict: 'user_id' });

  try {
    await twilioClient.messages.create({
      body: `Your IdeaHub verification code is: ${code}. Valid for 10 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS. Check phone number format (+1234567890).' });
  }
});

// VERIFY code
app.post('/api/sms/verify-code', authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const { data: record } = await supabase
    .from('sms_verifications')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('verified', false)
    .single();

  if (!record) return res.status(400).json({ error: 'No pending verification found' });
  if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  if (record.code !== code) return res.status(400).json({ error: 'Incorrect code. Please try again.' });

  // Mark as verified
  await supabase.from('sms_verifications').update({ verified: true }).eq('user_id', req.user.id);
  await supabase.from('users').update({ phone: record.phone, phone_verified: true }).eq('id', req.user.id);

  res.json({ success: true, message: 'Phone number verified!' });
});
  // ── SETTINGS ──────────────────────────────────────────────────────────────────

  app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const { data: user } = await supabase.from('users').select('password').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase.from('users').update({ password: hashed }).eq('id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  app.post('/api/auth/update-email', authMiddleware, async (req, res) => {
    const { newEmail, password } = req.body;
    if (!newEmail || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data: user } = await supabase.from('users').select('password').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Incorrect password' });
    const { data: existing } = await supabase.from('users').select('id').eq('email', newEmail).single();
    if (existing) return res.status(400).json({ error: 'Email already in use' });
    const { error } = await supabase.from('users').update({ email: newEmail }).eq('id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // ── IDEAWALL ──────────────────────────────────────────────────────────────────
  const LIFE_HACK_TOPICS = ['Home', 'Food & Kitchen', 'Money', 'Health', 'Tech', 'Work & Study', 'Travel', 'Other'];

  app.get('/api/wall', async (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;
    const sort = req.query.sort || 'latest';
    const category = req.query.category || null;

    let query = supabase.from('wall_posts')
      .select('*, users(id, first_name, last_name, role, avatar_url)')
      .range(offset, Math.min(offset + Math.min(limit, 50), offset + 50) - 1);

    if (category) query = query.eq('category', category);
    // Life Hacks page filters: one post, one topic, one author, or a text search
    const onlyId = parseInt(req.query.id, 10);
    if (Number.isFinite(onlyId)) query = query.eq('id', onlyId);
    if (req.query.topic) query = query.eq('hack_topic', String(req.query.topic).slice(0, 40));
    const byUser = parseInt(req.query.user_id, 10);
    if (Number.isFinite(byUser)) query = query.eq('user_id', byUser);
    const search = String(req.query.search || '').replace(/[%,()*\\"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (search) query = query.or(search.split(' ').filter(w => w.length >= 3).slice(0, 4)
      .flatMap(w => [`title.ilike.%${w}%`, `description.ilike.%${w}%`]).join(',') || `title.ilike.%${search}%`);
    if (sort === 'trending') query = query.order('likes_count', { ascending: false });
    else query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const posts = (data || []).map(p => ({
      ...p,
      first_name: p.users?.first_name,
      last_name: p.users?.last_name,
      role: p.users?.role,
      avatar_url: p.users?.avatar_url,
    }));

    // Get liked/saved for logged in user
    const token = req.headers.authorization?.split(' ')[1];
    let liked = [], saved = [];
    if (token) {
      try {
        const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
        const postIds = posts.map(p => p.id);
        if (postIds.length) {
          const [likesRes, savesRes] = await Promise.all([
            supabase.from('wall_likes').select('post_id').eq('user_id', decoded.id).in('post_id', postIds),
            supabase.from('wall_saves').select('post_id').eq('user_id', decoded.id).in('post_id', postIds),
          ]);
          liked = (likesRes.data || []).map(l => l.post_id);
          saved = (savesRes.data || []).map(s => s.post_id);
        }
      } catch {}
    }

    res.json({ posts, liked, saved });
  });

  app.post('/api/wall', authMiddleware, async (req, res) => {
    const { title, description, category, media_url, media_type, source_idea_id, is_from_idea } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    // Life hacks are public, searchable how-tos: hold them to a few basic rules
    let hackTopic = null;
    if (category === 'Life Hack') {
      const tt = String(title).trim(), dd = String(description || '').trim();
      if (tt.length < 10) return res.status(400).json({ error: 'Give your life hack a clear title (at least 10 characters).' });
      if (dd.length < 40) return res.status(400).json({ error: 'Explain the hack in the description (at least 40 characters) so people can try it.' });
      const contact = quality.hasContact(tt) || quality.hasContact(dd);
      if (contact) return res.status(400).json({ error: `Please remove ${contact} from your life hack. Life hacks are shared freely on IdeaHub; people can message you through your profile.` });
      hackTopic = LIFE_HACK_TOPICS.includes(req.body.hack_topic) ? req.body.hack_topic : 'Other';
    }
    const { data, error } = await supabase.from('wall_posts').insert([{
      user_id: req.user.id, title, description: description || null, hack_topic: hackTopic,
      category: category || null, media_url: media_url || null,
      media_type: media_type || 'image', source_idea_id: source_idea_id || null,
      is_from_idea: is_from_idea || false, likes_count: 0, comments_count: 0
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  app.delete('/api/wall/:id', authMiddleware, async (req, res) => {
    const { error } = await supabase.from('wall_posts').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  app.post('/api/wall/:id/like', authMiddleware, async (req, res) => {
    const postId = parseInt(req.params.id);
    const reaction = req.body?.reaction || 'brilliant';
    const { data: existing } = await supabase.from('wall_likes').select('id, reaction').eq('user_id', req.user.id).eq('post_id', postId).single();
    if (existing) {
      await supabase.from('wall_likes').delete().eq('user_id', req.user.id).eq('post_id', postId);
      const { data: post } = await supabase.from('wall_posts').select('likes_count').eq('id', postId).single();
      const newCount = Math.max(0, (post?.likes_count || 1) - 1);
      await supabase.from('wall_posts').update({ likes_count: newCount }).eq('id', postId);
      return res.json({ liked: false, likes_count: newCount });
    }
    await supabase.from('wall_likes').insert([{ user_id: req.user.id, post_id: postId, reaction }]);
    const { data: post } = await supabase.from('wall_posts').select('likes_count').eq('id', postId).single();
    const newCount = (post?.likes_count || 0) + 1;
    await supabase.from('wall_posts').update({ likes_count: newCount }).eq('id', postId);
    res.json({ liked: true, likes_count: newCount, reaction });
  });

  app.post('/api/wall/:id/save', authMiddleware, async (req, res) => {
    const postId = parseInt(req.params.id);
    const { data: existing } = await supabase.from('wall_saves').select('id').eq('user_id', req.user.id).eq('post_id', postId).single();
    if (existing) {
      await supabase.from('wall_saves').delete().eq('user_id', req.user.id).eq('post_id', postId);
      return res.json({ saved: false });
    }
    await supabase.from('wall_saves').insert([{ user_id: req.user.id, post_id: postId }]);
    res.json({ saved: true });
  });

  app.get('/api/wall/:id/comments', async (req, res) => {
    const { data, error } = await supabase.from('wall_comments')
      .select('*, users(first_name, last_name, avatar_url)')
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    const comments = (data || []).map(c => ({
      ...c, first_name: c.users?.first_name, last_name: c.users?.last_name, avatar_url: c.users?.avatar_url
    }));
    res.json(comments);
  });

  app.post('/api/wall/:id/comments', authMiddleware, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const postId = parseInt(req.params.id);
    const { data, error } = await supabase.from('wall_comments').insert([{
      user_id: req.user.id, post_id: postId, text
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const { data: post } = await supabase.from('wall_posts').select('comments_count').eq('id', postId).single();
    await supabase.from('wall_posts').update({ comments_count: (post?.comments_count || 0) + 1 }).eq('id', postId);
    res.status(201).json(data);
  });

  // Handle shareToWall on idea submit — patch into POST /api/ideas
  // (handled inline in the ideas route via shareToWall flag)

  // ── SWITCH ROLE ───────────────────────────────────────────────────────────────
  app.get('/switch-role', (req, res) => res.sendFile(__dirname + '/public/switch-role.html'));
  app.get('/forgot-password', (req, res) => res.sendFile(__dirname + '/public/forgot-password.html'));
  app.get('/reset-password', (req, res) => res.sendFile(__dirname + '/public/reset-password.html'));

  app.post('/api/auth/switch-role', authMiddleware, async (req, res) => {
    const { role } = req.body;
    const INSTANT_ROLES = ['idea_creator', 'investor', 'virtual_manager', 'business_owner', 'corporate_services'];
    if (!INSTANT_ROLES.includes(role)) return res.status(400).json({ error: 'This role requires admin approval.' });
    const { data: user, error } = await supabase.from('users').update({ role }).eq('id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  });

  app.post('/api/auth/role-switch-request', authMiddleware, async (req, res) => {
    const { requested_role, licence_number, bar_association, jurisdiction, experience_years, licence_file_url, gov_id_url, statement, patent_numbers, patent_jurisdiction, patent_year, patent_cert_url, patent_description } = req.body;
    const APPROVAL_ROLES = ['patent_attorney', 'patent_seller'];
    if (!APPROVAL_ROLES.includes(requested_role)) return res.status(400).json({ error: 'This role does not require approval.' });
    const { data: existing } = await supabase.from('role_switch_requests').select('id').eq('user_id', req.user.id).eq('requested_role', requested_role).eq('status', 'pending').single();
    if (existing) return res.status(400).json({ error: 'You already have a pending request for this role.' });
    const { data, error } = await supabase.from('role_switch_requests').insert([{ user_id: req.user.id, requested_role, status: 'pending', licence_number: licence_number||null, bar_association: bar_association||null, jurisdiction: jurisdiction||null, experience_years: experience_years||null, licence_file_url: licence_file_url||null, gov_id_url: gov_id_url||null, statement: statement||null, patent_numbers: patent_numbers||null, patent_jurisdiction: patent_jurisdiction||null, patent_year: patent_year||null, patent_cert_url: patent_cert_url||null, patent_description: patent_description||null }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    if (admins?.length) await supabase.from('notifications').insert(admins.map(a => ({ user_id: a.id, type: 'role_request', title: '🔄 New Role Switch Request', message: `A user wants to become a ${requested_role.replace(/_/g,' ')}. Review in Admin Panel.`, link: '/admin' })));
    res.status(201).json(data);
  });

  // GET all users (admin)
  app.get('/api/admin/users', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('users').select('id, first_name, last_name, email, role, country, created_at, verified, verification_status').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  app.get('/api/admin/role-requests', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabase.from('role_switch_requests').select('*, user:user_id(id, first_name, last_name, email, role, country)').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  app.put('/api/admin/role-requests/:id/approve', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { data: request } = await supabase.from('role_switch_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    await supabase.from('users').update({ role: request.requested_role }).eq('id', request.user_id);
    await supabase.from('role_switch_requests').update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: req.user.id }).eq('id', req.params.id);
    await supabase.from('notifications').insert([{ user_id: request.user_id, type: 'role_approved', title: '✅ Role Request Approved!', message: `Your request to become a ${request.requested_role.replace(/_/g,' ')} has been approved!`, link: '/' }]);
    res.json({ success: true });
  });

  app.put('/api/admin/role-requests/:id/reject', authMiddleware, async (req, res) => {
    const { data: admin } = await supabase.from('users').select('role').eq('id', req.user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { reason } = req.body;
    const { data: request } = await supabase.from('role_switch_requests').select('*').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    await supabase.from('role_switch_requests').update({ status: 'rejected', reject_reason: reason, reviewed_at: new Date().toISOString(), reviewed_by: req.user.id }).eq('id', req.params.id);
    await supabase.from('notifications').insert([{ user_id: request.user_id, type: 'role_rejected', title: '❌ Role Request Not Approved', message: `Your request to become a ${request.requested_role.replace(/_/g,' ')} was not approved. Reason: ${reason}`, link: '/switch-role' }]);
    res.json({ success: true });
  });

  // ── FORGOT PASSWORD ───────────────────────────────────────────────────────────

  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: user } = await supabase.from('users').select('id, first_name').eq('email', email).single();
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    // Generate token
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Store token
    await supabase.from('password_resets').insert([{ email, token, expires_at: expiresAt }]);

    // Send email
    const resetLink = `https://ideahub.it.com/reset-password?token=${token}`;
    await sendEmail(email, 'Reset your IdeaHub password', `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
        <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
        <h2 style="margin-bottom:8px;">Reset your password</h2>
        <p style="color:#9a9080;line-height:1.7;margin-bottom:20px;">Hi ${user.first_name}, we received a request to reset your password. Click the button below to set a new password. This link expires in 1 hour.</p>
        <a href="${resetLink}" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;margin-bottom:20px;">Reset Password →</a>
        <p style="color:#6e6b65;font-size:12px;margin-top:16px;">If you didn't request this, ignore this email. Your password won't change.</p>
        <p style="color:#6e6b65;font-size:12px;">IdeaHub by Picela (Pvt) Ltd</p>
      </div>
    `);

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Find token
    const { data: reset } = await supabase
      .from('password_resets')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link' });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });

    // Update password
    const hashed = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').update({ password: hashed }).eq('email', reset.email);
    if (error) return res.status(500).json({ error: error.message });

    // Mark token as used
    await supabase.from('password_resets').update({ used: true }).eq('token', token);

    res.json({ message: 'Password reset successfully!' });
  });
// ── CONTACT FORM ─────────────────────────────────────────────
app.post('/api/contact', async (req, res) => { if (!(await verifyTurnstile(req.body.turnstileToken, req.headers['cf-connecting-ip']))) return res.status(400).json({ error: 'Security check failed. Please refresh the page and try again.' });
  const { firstName, lastName, email, role, subject, message } = req.body;
  if (!firstName || !email || !message) {
    return res.status(400).json({ error: 'Required fields missing' });
  }

  console.log('Contact form received from:', email);
  console.log('RESEND_API_KEY exists:', !!process.env.RESEND_API_KEY);
  console.log('RESEND_FROM:', process.env.RESEND_FROM);
  await sendEmail(
    'jbandara9835@gmail.com',
    `📩 New Contact Form: ${subject || 'General Inquiry'} — IdeaHub`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
      <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub — Contact Form</div>
      <p><strong>Name:</strong> ${firstName} ${lastName || ''}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Role:</strong> ${role || 'Not specified'}</p>
      <p><strong>Subject:</strong> ${subject || 'Not specified'}</p>
      <p style="margin-top:16px;"><strong>Message:</strong></p>
      <div style="background:#1e1e24;border-left:3px solid #f5c842;padding:14px;border-radius:8px;margin-top:8px;color:#9a9080;">${message}</div>
      <p style="color:#6e6b65;font-size:12px;margin-top:24px;">Sent from ideahub.it.com/about</p>
    </div>
    `
  );

  res.json({ success: true });
});
  // ── HEALTH CHECK & KEEP-ALIVE ─────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Health check only — test email endpoint removed

  // Self-ping every 14 minutes to prevent Railway from sleeping
  setInterval(() => {
    fetch('https://ideahub.it.com/api/health')
      .then(() => console.log('Keep-alive ping sent:', new Date().toISOString()))
      .catch(err => console.log('Keep-alive ping failed:', err.message));
  }, 14 * 60 * 1000);

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

  // ── GROUP CONVERSATIONS (Add 3rd party to chat) ────────────────────────────────

  // CREATE a group conversation - inviter + existing party (auto-approved) + new party (pending)
  app.post('/api/groups', authMiddleware, async (req, res) => {
    const { otherUserId, newUserId, title } = req.body;
    if (!otherUserId || !newUserId) return res.status(400).json({ error: 'otherUserId and newUserId required' });
    if (parseInt(newUserId) === req.user.id || parseInt(newUserId) === parseInt(otherUserId)) {
      return res.status(400).json({ error: 'Invalid user to add' });
    }

    const { data: group, error } = await supabase
      .from('group_conversations')
      .insert([{ title: title || null, created_by: req.user.id, status: 'pending' }])
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    const members = [
      { conversation_id: group.id, user_id: req.user.id, status: 'approved', invited_by: req.user.id },
      { conversation_id: group.id, user_id: parseInt(otherUserId), status: 'pending', invited_by: req.user.id },
      { conversation_id: group.id, user_id: parseInt(newUserId), status: 'pending', invited_by: req.user.id }
    ];
    const { error: memErr } = await supabase.from('group_members').insert(members);
    if (memErr) return res.status(500).json({ error: memErr.message });

    // Notify the existing party for consent
    const { data: inviter } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
    const { data: newUser } = await supabase.from('users').select('first_name, last_name, role').eq('id', newUserId).single();
    await supabase.from('notifications').insert([{
      user_id: parseInt(otherUserId),
      type: 'group_invite',
      title: '👥 Group Chat Request',
      message: `${inviter?.first_name||'Someone'} wants to add ${newUser?.first_name||'a user'} (${newUser?.role?.replace(/_/g,' ')||''}) to a group chat with you.`,
      link: `/messages?group=${group.id}`,
      data: { group_id: group.id }
    }]);

    res.status(201).json(group);
  });

  // GET my group conversations
  app.get('/api/groups', authMiddleware, async (req, res) => {
    const { data: memberships, error } = await supabase
      .from('group_members')
      .select('*, group:conversation_id(*)')
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });

    const groups = await Promise.all((memberships||[]).map(async m => {
      const { data: allMembers } = await supabase
        .from('group_members')
        .select('*, user:user_id(id, first_name, last_name, role)')
        .eq('conversation_id', m.conversation_id);
      return { ...m.group, my_status: m.status, members: allMembers || [] };
    }));

    res.json(groups);
  });

  // RESPOND to a group invite (approve/decline)
  app.put('/api/groups/:id/respond', authMiddleware, async (req, res) => {
    const { status } = req.body; // 'approved' or 'declined'
    if (!['approved','declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { data: member } = await supabase.from('group_members').select('*').eq('conversation_id', req.params.id).eq('user_id', req.user.id).single();
    if (!member) return res.status(404).json({ error: 'Not a member of this group' });

    await supabase.from('group_members').update({ status }).eq('conversation_id', req.params.id).eq('user_id', req.user.id);

    if (status === 'declined') {
      await supabase.from('group_conversations').update({ status: 'declined' }).eq('id', req.params.id);
      // Notify other members
      const { data: members } = await supabase.from('group_members').select('user_id').eq('conversation_id', req.params.id).neq('user_id', req.user.id);
      const { data: decliner } = await supabase.from('users').select('first_name').eq('id', req.user.id).single();
      if (members?.length) {
        await supabase.from('notifications').insert(members.map(m => ({
          user_id: m.user_id, type: 'group_declined', title: '❌ Group Chat Declined',
          message: `${decliner?.first_name||'A user'} declined to join the group chat.`, link: '/messages'
        })));
      }
    } else {
      // Check if all members approved -> activate group
      const { data: allMembers } = await supabase.from('group_members').select('status, user_id').eq('conversation_id', req.params.id);
      const allApproved = allMembers.every(m => m.status === 'approved');
      if (allApproved) {
        await supabase.from('group_conversations').update({ status: 'active' }).eq('id', req.params.id);
        const { data: approver } = await supabase.from('users').select('first_name').eq('id', req.user.id).single();
        const others = allMembers.filter(m => m.user_id !== req.user.id);
        await supabase.from('notifications').insert(others.map(m => ({
          user_id: m.user_id, type: 'group_active', title: '✅ Group Chat Active!',
          message: `${approver?.first_name||'A user'} approved the group chat. You can now chat together.`, link: `/messages?group=${req.params.id}`
        })));
      }
    }

    res.json({ success: true, status });
  });

  // GET messages for a group (only if approved member)
  app.get('/api/groups/:id/messages', authMiddleware, async (req, res) => {
    const { data: member } = await supabase.from('group_members').select('status').eq('conversation_id', req.params.id).eq('user_id', req.user.id).single();
    if (!member || member.status !== 'approved') return res.status(403).json({ error: 'Not authorized' });

    const { data, error } = await supabase
      .from('group_messages')
      .select('*, sender:from_id(id, first_name, last_name)')
      .eq('conversation_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // POST message in a group
  app.post('/api/groups/:id/messages', authMiddleware, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const { data: member } = await supabase.from('group_members').select('status').eq('conversation_id', req.params.id).eq('user_id', req.user.id).single();
    if (!member || member.status !== 'approved') return res.status(403).json({ error: 'Not authorized' });

    const { data, error } = await supabase
      .from('group_messages')
      .insert([{ conversation_id: parseInt(req.params.id), from_id: req.user.id, text, type: 'text' }])
      .select('*, sender:from_id(id, first_name, last_name)').single();
    if (error) return res.status(500).json({ error: error.message });

    // Notify other approved members
    const { data: members } = await supabase.from('group_members').select('user_id').eq('conversation_id', req.params.id).eq('status', 'approved').neq('user_id', req.user.id);
    const { data: sender } = await supabase.from('users').select('first_name').eq('id', req.user.id).single();
    if (members?.length) {
      await supabase.from('notifications').insert(members.map(m => ({
        user_id: m.user_id, type: 'group_message', title: '💬 New Group Message',
        message: `${sender?.first_name||'Someone'} sent a message in your group chat.`, link: `/messages?group=${req.params.id}`
      })));
    }

    res.status(201).json(data);
  });

  // RESPOND to a call request within a group
  app.put('/api/groups/call-response/:msgId', authMiddleware, async (req, res) => {
    const { status, meetLink } = req.body;
    if (!['accepted','declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { data: msg } = await supabase.from('group_messages').select('*').eq('id', req.params.msgId).single();
    if (!msg) return res.status(404).json({ error: 'Call request not found' });

    const { data: member } = await supabase.from('group_members').select('status').eq('conversation_id', msg.conversation_id).eq('user_id', req.user.id).single();
    if (!member || member.status !== 'approved') return res.status(403).json({ error: 'Not authorized' });

    const updateData = { call_status: status };
    if (status === 'accepted' && meetLink) updateData.meet_link = meetLink;

    const { data, error } = await supabase
      .from('group_messages')
      .update(updateData)
      .eq('id', req.params.msgId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // CALL REQUEST within a group
  app.post('/api/groups/:id/call-request', authMiddleware, async (req, res) => {
    const { callDate, note, meetLink } = req.body;
    if (!callDate) return res.status(400).json({ error: 'callDate required' });

    const { data: member } = await supabase.from('group_members').select('status').eq('conversation_id', req.params.id).eq('user_id', req.user.id).single();
    if (!member || member.status !== 'approved') return res.status(403).json({ error: 'Not authorized' });

    const { data, error } = await supabase
      .from('group_messages')
      .insert([{
        conversation_id: parseInt(req.params.id), from_id: req.user.id,
        text: note || '', type: 'call_request', call_date: callDate,
        call_status: meetLink ? 'accepted' : 'pending', meet_link: meetLink || null
      }])
      .select('*, sender:from_id(id, first_name, last_name)').single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
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