// ─────────────────────────────────────────────────────────────────────────────
// bots.js — IdeaHub scheduled bots
// Usage in server.js (right after the chatbot line):
//   require('./bots')(app, supabase, sendEmail);
// Needs: npm install node-cron
// Optional Railway variable: ADMIN_EMAIL (who receives the daily digest)
// ─────────────────────────────────────────────────────────────────────────────
const cron = require('node-cron');
const jwt = require('jsonwebtoken');

const TZ = 'Asia/Colombo';
const SITE = 'https://ideahub.it.com';
const ADMIN_EMAIL = () => process.env.ADMIN_EMAIL || 'jbandara9835@gmail.com';

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d || isNaN(new Date(d))) return 'recently';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
}
function hoursAgoISO(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

// Runs a query and never throws — a broken table must not kill the whole digest
async function safe(label, fn, fallback) {
  try {
    const { data, error } = await fn();
    if (error) throw error;
    return data ?? fallback;
  } catch (err) {
    console.error(`Bot query "${label}" failed:`, err.message || err);
    return fallback;
  }
}
async function countOf(supabase, label, build) {
  try {
    const { count, error } = await build(supabase);
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.error(`Bot count "${label}" failed:`, err.message || err);
    return null;   // shown as "–" in the email
  }
}

async function logRun(supabase, name, status, details) {
  try {
    await supabase.from('bot_runs').insert([{ bot: name, status, details: details || null }]);
  } catch (err) {
    console.error('bot_runs insert failed:', err.message || err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT 1 — Trending Score Recalculator (daily at midnight)
// score = (views + 10×inquiries + 20 if patented) / (age in days + 2)^1.5
// Newer ideas with real engagement rise; old ones slowly sink.
// ─────────────────────────────────────────────────────────────────────────────
async function runTrending(supabase) {
  const { data: ideas, error } = await supabase
    .from('ideas')
    .select('id, views, inquiries, has_patent, created_at')
    .eq('status', 'live');
  if (error) throw error;

  const now = Date.now();
  let updated = 0;
  for (const i of ideas || []) {
    const ageDays = Math.max(0, (now - new Date(i.created_at).getTime()) / 86400000);
    const engagement = (i.views || 0) + 10 * (i.inquiries || 0) + (i.has_patent ? 20 : 0);
    const score = Math.round((engagement / Math.pow(ageDays + 2, 1.5)) * 100) / 100;
    const { error: upErr } = await supabase.from('ideas').update({ trending_score: score }).eq('id', i.id);
    if (upErr) throw upErr;
    updated++;
  }
  return `Updated ${updated} live ideas`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT 3 — Verification (daily at 6:30, before the digest)
// Auto-approves pending users who pass ALL checks; the rest stay pending and
// are listed in the digest with what they're missing.
// Profile completeness is computed here from real fields — the browser-sent
// profile_complete value is NOT trusted.
// ─────────────────────────────────────────────────────────────────────────────
const PROFILE_FIELDS = ['first_name', 'last_name', 'avatar_url', 'tagline', 'bio', 'country', 'city', 'phone'];
const MIN_PROFILE_PCT = 80;
const MIN_ACCOUNT_DAYS = 3;
const VERIF_COLS = 'id, email, role, created_at, phone_verified, ' + PROFILE_FIELDS.slice().filter((f, i, a) => a.indexOf(f) === i).join(', ');

function profilePct(u) {
  const filled = PROFILE_FIELDS.filter(f => String(u[f] ?? '').trim() !== '').length;
  return Math.round((filled / PROFILE_FIELDS.length) * 100);
}
function verificationMissing(u) {
  const missing = [];
  if (!u.phone_verified) missing.push('phone not verified');
  const pct = profilePct(u);
  if (pct < MIN_PROFILE_PCT) missing.push(`profile ${pct}% complete (needs ${MIN_PROFILE_PCT}%)`);
  const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
  if (ageDays < MIN_ACCOUNT_DAYS) missing.push(`account ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} old (needs ${MIN_ACCOUNT_DAYS})`);
  return missing;
}

async function runVerification(supabase, sendEmail) {
  const { data: pending, error } = await supabase.from('users')
    .select(VERIF_COLS).eq('verification_status', 'pending');
  if (error) throw error;

  let approved = 0, waiting = 0;
  for (const u of pending || []) {
    if (verificationMissing(u).length) { waiting++; continue; }

    const { error: upErr } = await supabase.from('users')
      .update({ verification_status: 'verified' })
      .eq('id', u.id).eq('verification_status', 'pending');
    if (upErr) throw upErr;
    approved++;

    await supabase.from('notifications').insert([{
      user_id: u.id, type: 'verification_approved',
      title: 'Your profile is verified',
      message: 'Your IdeaHub profile now shows the verified badge.',
      link: '/profile'
    }]);
    if (u.email) {
      await sendEmail(u.email, 'Your IdeaHub profile is now verified', `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
          <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
          <h2 style="margin:0 0 12px;">You're verified, ${esc(u.first_name || 'there')}</h2>
          <p style="color:#9a9080;line-height:1.7;margin-bottom:20px;">Your profile now shows the verified badge, so buyers and partners can see you're a confirmed member.</p>
          <a href="${SITE}/profile" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">View your profile</a>
          <p style="color:#6e6b65;font-size:12px;margin-top:24px;">IdeaHub by Picela (Pvt) Ltd</p>
        </div>`);
    }
  }
  return `Approved ${approved}, still pending ${waiting}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT 4 — Day-3 nudge (daily at 10:00)
// One email to users who signed up 3–7 days ago and haven't done the main
// thing for their role yet. Sent once per user (users.nudge_sent_at).
// ─────────────────────────────────────────────────────────────────────────────
const NEXT_STEPS = {
  idea_creator:       { title: 'List your first idea', text: 'Ideas with a clear summary and a fair price get the most attention from buyers. Listing one takes about five minutes, and you stay in control of what buyers see before they pay.', cta: 'List an idea', path: '/submit' },
  patent_seller:      { title: 'List your first patent', text: 'Buyers are looking for protected ideas. Add your patent number when you list and it goes through our verification, so buyers can trust it.', cta: 'List a patent', path: '/submit' },
  investor:           { title: 'Find your first opportunity', text: 'Browse ideas by industry and budget, or post an Idea Request describing exactly what you want and let creators pitch to you.', cta: 'Browse ideas', path: '/browse' },
  business_owner:     { title: 'List your business', text: 'Investors and partners on IdeaHub are looking for franchise, licensing and partnership opportunities. A listing takes about ten minutes.', cta: 'List your business', path: '/list-business' },
  virtual_manager:    { title: 'Set up your service profile', text: 'Creators and investors search for professionals by role, country and rate. A complete profile is how they find you.', cta: 'Set up profile', path: '/support-profile' },
  patent_attorney:    { title: 'Set up your service profile', text: 'Idea creators need patent help. A complete profile with your jurisdictions and rate is how they find you.', cta: 'Set up profile', path: '/support-profile' },
  corporate_services: { title: 'Set up your service profile', text: 'New businesses on IdeaHub need corporate services. A complete profile is how they find you.', cta: 'Set up profile', path: '/support-profile' },
};

async function hasRows(supabase, table, col, id) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq(col, id);
  if (error) { console.error(`Nudge check ${table}.${col} failed:`, error.message); return true; } // on error, don't nudge
  return (count || 0) > 0;
}
async function isActive(supabase, u) {
  if (await hasRows(supabase, 'messages', 'from_id', u.id)) return true;
  switch (u.role) {
    case 'idea_creator':
    case 'patent_seller':      return hasRows(supabase, 'ideas', 'creator_id', u.id);
    case 'investor':           return (await hasRows(supabase, 'idea_requests', 'investor_id', u.id)) || hasRows(supabase, 'transactions', 'buyer_id', u.id);
    case 'business_owner':     return hasRows(supabase, 'business_listings', 'owner_id', u.id);
    case 'virtual_manager':
    case 'patent_attorney':
    case 'corporate_services': return hasRows(supabase, 'support_profiles', 'user_id', u.id);
    default:                   return true; // admins and unknown roles: never nudge
  }
}

async function runNudge(supabase, sendEmail) {
  const { data: users, error } = await supabase.from('users')
    .select('id, email, first_name, role, created_at, ' + PROFILE_FIELDS.filter(f => f !== 'first_name').join(', '))
    .is('nudge_sent_at', null)
    .lte('created_at', hoursAgoISO(72))
    .gte('created_at', hoursAgoISO(168))
    .limit(50);
  if (error) throw error;

  let sent = 0, active = 0;
  for (const u of users || []) {
    const step = NEXT_STEPS[u.role];
    if (!step || !u.email || await isActive(supabase, u)) { active++; continue; }

    const pct = profilePct(u);
    const profileTip = pct < MIN_PROFILE_PCT
      ? `<p style="color:#9a9080;line-height:1.7;margin:20px 0 0;font-size:14px;">Tip: your profile is ${pct}% complete. Adding a photo, a short bio and your country helps people trust you. <a href="${SITE}/profile" style="color:#f5c842;">Finish your profile</a></p>`
      : '';

    await sendEmail(u.email, `${step.title}, ${u.first_name || 'there'}`, `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
        <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
        <h2 style="margin:0 0 12px;">${esc(step.title)}</h2>
        <p style="color:#9a9080;line-height:1.7;margin-bottom:20px;">Hi ${esc(u.first_name || 'there')}, thanks for joining IdeaHub a few days ago. ${esc(step.text)}</p>
        <a href="${SITE}${step.path}" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">${esc(step.cta)}</a>
        ${profileTip}
        <p style="color:#6e6b65;font-size:12px;margin-top:28px;">Questions? Just use the contact form at ${SITE}/about. This is a one-time reminder.<br>IdeaHub by Picela (Pvt) Ltd</p>
      </div>`);
    await supabase.from('users').update({ nudge_sent_at: new Date().toISOString() }).eq('id', u.id);
    sent++;
  }
  return `Nudged ${sent}, already active ${active}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT 2 — Admin Daily Digest (daily at 7:00 Sri Lanka time)
// ─────────────────────────────────────────────────────────────────────────────
async function buildDigest(supabase) {
  const since = hoursAgoISO(24);

  const [newUsers, newIdeas, newRequests, newBusinesses, txs, chats,
         pendingVerifUsers, pendingRoles, pendingPatents, totalUsers, liveIdeas, botRuns] = await Promise.all([
    safe('new users', () => supabase.from('users')
      .select('first_name, last_name, role, signup_country, created_at')
      .gte('created_at', since).order('created_at', { ascending: false }), []),
    safe('new ideas', () => supabase.from('ideas')
      .select('id, title, price, industry, status, creator_name, created_at')
      .gte('created_at', since).order('created_at', { ascending: false }), []),
    safe('new requests', () => supabase.from('idea_requests')
      .select('id, title, industry, budget_max, created_at').gte('created_at', since), []),
    safe('new businesses', () => supabase.from('business_listings')
      .select('id, business_name, industry, country, created_at').gte('created_at', since), []),
    safe('transactions', () => supabase.from('transactions')
      .select('id, idea_title, amount, fee, status, created_at, completed_at')
      .or(`created_at.gte."${since}",completed_at.gte."${since}"`), []),
    safe('chat logs', () => supabase.from('chat_logs')
      .select('question, result_count, created_at').gte('created_at', since)
      .order('created_at', { ascending: false }), []),
    safe('pending verifications', () => supabase.from('users')
      .select(VERIF_COLS).eq('verification_status', 'pending'), []),
    countOf(supabase, 'pending role requests', s => s.from('role_switch_requests')
      .select('*', { count: 'exact', head: true }).eq('status', 'pending')),
    countOf(supabase, 'patents under review', s => s.from('ideas')
      .select('*', { count: 'exact', head: true }).eq('status', 'under_review')),
    countOf(supabase, 'total users', s => s.from('users').select('*', { count: 'exact', head: true })),
    countOf(supabase, 'live ideas', s => s.from('ideas')
      .select('*', { count: 'exact', head: true }).eq('status', 'live')),
    safe('bot runs', () => supabase.from('bot_runs')
      .select('bot, status, details, created_at').gte('created_at', hoursAgoISO(25))
      .order('created_at', { ascending: false }), []),
  ]);

  const newEscrows = txs.filter(t => t.created_at >= since);
  const completed = txs.filter(t => t.status === 'completed' && t.completed_at && t.completed_at >= since);
  const feesEarned = completed.reduce((s, t) => s + Number(t.fee || 0), 0);
  const zeroResult = chats.filter(c => c.result_count === 0).slice(0, 8);
  const pendingVerif = pendingVerifUsers.length;
  const verifDetails = pendingVerifUsers.map(u => ({ name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email, missing: verificationMissing(u) }));
  const pendingTotal = pendingVerif + (pendingRoles || 0) + (pendingPatents || 0);
  // latest run per bot
  const lastRuns = {};
  for (const r of botRuns) if (!lastRuns[r.bot]) lastRuns[r.bot] = r;

  return {
    newUsers, newIdeas, newRequests, newBusinesses, newEscrows, completed, feesEarned,
    chats, zeroResult, pendingVerif, pendingRoles, pendingPatents, pendingTotal,
    totalUsers, liveIdeas, verifDetails, lastRuns
  };
}

function digestHtml(d) {
  const n = v => (v === null || v === undefined ? '–' : v);
  const stat = (label, value, highlight) => `
    <td style="padding:12px;background:#16161a;border-radius:8px;text-align:center;width:25%;">
      <div style="font-size:22px;font-weight:800;color:${highlight ? '#f5c842' : '#f0ede8'};">${esc(n(value))}</div>
      <div style="font-size:11px;color:#8a8680;margin-top:2px;">${esc(label)}</div>
    </td>`;
  const section = (title, body) => `
    <h3 style="font-size:15px;color:#f5c842;margin:24px 0 8px;">${esc(title)}</h3>${body}`;
  const list = (items, render, empty) => items.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">${items.map(render).join('')}</table>`
    : `<p style="color:#8a8680;font-size:13px;margin:0;">${esc(empty)}</p>`;
  const row = (left, right) => `
    <tr><td style="padding:6px 0;border-bottom:1px solid #222;color:#f0ede8;">${left}</td>
        <td style="padding:6px 0;border-bottom:1px solid #222;color:#8a8680;text-align:right;white-space:nowrap;">${right}</td></tr>`;

  const actions = [];
  if (d.pendingVerif) actions.push(`${d.pendingVerif} user verification${d.pendingVerif > 1 ? 's' : ''} pending (not yet passing the automatic checks)`);
  if (d.pendingRoles) actions.push(`${d.pendingRoles} role switch request${d.pendingRoles > 1 ? 's' : ''} waiting`);
  if (d.pendingPatents) actions.push(`${d.pendingPatents} patent idea${d.pendingPatents > 1 ? 's' : ''} under review`);

  const botNames = { verification: 'Verification', trending: 'Trending scores', nudge: 'Day-3 nudges', digest: 'Digest' };
  const botLines = Object.keys(botNames).filter(b => b !== 'digest').map(b => {
    const r = d.lastRuns[b];
    const state = !r ? 'no run in the last 24h' : r.status === 'ok' ? esc(r.details || 'ok') : `<span style="color:#ff6b6b;">FAILED: ${esc(r.details || '')}</span>`;
    return `${botNames[b]}: ${state}`;
  }).join('<br>');

  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:28px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
    <div style="font-size:22px;font-weight:800;color:#f5c842;">IdeaHub</div>
    <div style="font-size:13px;color:#8a8680;margin-bottom:20px;">Daily digest · last 24 hours · ${esc(fmtDate(new Date()))}</div>

    <table style="width:100%;border-collapse:separate;border-spacing:6px;"><tr>
      ${stat('New users', d.newUsers.length, d.newUsers.length > 0)}
      ${stat('New ideas', d.newIdeas.length, d.newIdeas.length > 0)}
      ${stat('Chatbot questions', d.chats.length)}
      ${stat('Fees earned', money(d.feesEarned), d.feesEarned > 0)}
    </tr></table>

    ${section('Needs your attention', actions.length
      ? `<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;">${actions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
         ${d.verifDetails.length ? list(d.verifDetails.slice(0, 10), v => row(esc(v.name), esc(v.missing.join(', ') || 'ready')), '') : ''}
         <p style="margin:8px 0 0;"><a href="${SITE}/admin" style="color:#f5c842;">Open admin panel</a></p>`
      : `<p style="color:#8a8680;font-size:13px;margin:0;">Nothing waiting for review.</p>`)}

    ${section(`New users (${d.newUsers.length})`, list(d.newUsers.slice(0, 15),
      u => row(`${esc(u.first_name)} ${esc(u.last_name || '')} <span style="color:#8a8680;">· ${esc((u.role || '').replace(/_/g, ' '))}</span>`,
               esc(u.signup_country || '')), 'No new signups.'))}

    ${section(`New ideas (${d.newIdeas.length})`, list(d.newIdeas.slice(0, 10),
      i => row(`<a href="${SITE}/idea?id=${i.id}" style="color:#f0ede8;">${esc(i.title)}</a> <span style="color:#8a8680;">· ${esc(i.creator_name || '')}${i.status !== 'live' ? ' · ' + esc(i.status) : ''}</span>`,
               money(i.price)), 'No new ideas.'))}

    ${(d.newRequests.length || d.newBusinesses.length) ? section('Other new listings', list([
      ...d.newRequests.map(r => ({ l: `Idea request: ${esc(r.title)}`, r: r.budget_max ? 'up to ' + money(r.budget_max) : '' })),
      ...d.newBusinesses.map(b => ({ l: `Business: ${esc(b.business_name)}`, r: esc(b.country || '') }))
    ], x => row(x.l, x.r), '')) : ''}

    ${section('Deals', d.newEscrows.length || d.completed.length
      ? list([
          ...d.newEscrows.map(t => ({ l: `Escrow locked: ${esc(t.idea_title)}`, r: money(t.amount) })),
          ...d.completed.map(t => ({ l: `Completed: ${esc(t.idea_title)}`, r: 'fee ' + money(t.fee) }))
        ], x => row(x.l, x.r), '')
      : `<p style="color:#8a8680;font-size:13px;margin:0;">No deal activity.</p>`)}

    ${section(`Chatbot searches with no results (${d.zeroResult.length})`, list(d.zeroResult,
      c => row(`"${esc((c.question || '').slice(0, 90))}"`, ''), 'None — every search found something.'))}
    ${d.zeroResult.length ? `<p style="color:#8a8680;font-size:12px;margin:6px 0 0;">These show what people want that isn't listed yet.</p>` : ''}

    ${section('Totals', `<p style="font-size:13px;margin:0;line-height:1.8;">
      ${esc(n(d.totalUsers))} users · ${esc(n(d.liveIdeas))} live ideas</p>`)}

    ${section('Bots (last 24 hours)', `<p style="font-size:13px;margin:0;line-height:1.8;color:#8a8680;">${botLines}</p>`)}

    <p style="color:#6e6b65;font-size:11px;margin-top:28px;">Sent automatically by IdeaHub at 7:00 AM Sri Lanka time.</p>
  </div>`;
}

async function runDigest(supabase, sendEmail) {
  const d = await buildDigest(supabase);
  const subject = `IdeaHub daily digest: ${d.newUsers.length} new user${d.newUsers.length === 1 ? '' : 's'}, ${d.newIdeas.length} new idea${d.newIdeas.length === 1 ? '' : 's'}${d.pendingTotal ? `, ${d.pendingTotal} to review` : ''}`;
  await sendEmail(ADMIN_EMAIL(), subject, digestHtml(d));
  return `Sent to ${ADMIN_EMAIL()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler + admin test endpoint
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function registerBots(app, supabase, sendEmail) {
  const BOTS = {
    trending: () => runTrending(supabase),
    verification: () => runVerification(supabase, sendEmail),
    digest: () => runDigest(supabase, sendEmail),
    nudge: () => runNudge(supabase, sendEmail),
  };

  async function run(name) {
    console.log(`Bot "${name}" starting`);
    try {
      const details = await BOTS[name]();
      console.log(`Bot "${name}" finished: ${details}`);
      await logRun(supabase, name, 'ok', details);
      return { ok: true, details };
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`Bot "${name}" failed:`, msg);
      await logRun(supabase, name, 'failed', msg);
      return { ok: false, error: msg };
    }
  }

  cron.schedule('0 0 * * *', () => run('trending'), { timezone: TZ });   // midnight
  cron.schedule('30 6 * * *', () => run('verification'), { timezone: TZ }); // 6:30 AM
  cron.schedule('0 7 * * *', () => run('digest'), { timezone: TZ });     // 7:00 AM
  cron.schedule('0 10 * * *', () => run('nudge'), { timezone: TZ });     // 10:00 AM

  // Admin-only manual trigger, for testing: POST /api/admin/bots/digest/run
  app.post('/api/admin/bots/:name/run', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    try {
      const { id } = jwt.verify(token || '', process.env.JWT_SECRET);
      const { data: user } = await supabase.from('users').select('role').eq('id', id).single();
      if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (!BOTS[req.params.name]) return res.status(404).json({ error: 'Unknown bot. Use: ' + Object.keys(BOTS).join(', ') });
    res.json(await run(req.params.name));
  });

  console.log('  🤖  Bots scheduled: trending 00:00, verification 06:30, digest 07:00, nudge 10:00 (Asia/Colombo)');
};
