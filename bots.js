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
// BOT 2 — Admin Daily Digest (daily at 7:00 Sri Lanka time)
// ─────────────────────────────────────────────────────────────────────────────
async function buildDigest(supabase) {
  const since = hoursAgoISO(24);

  const [newUsers, newIdeas, newRequests, newBusinesses, txs, chats,
         pendingVerif, pendingRoles, pendingPatents, totalUsers, liveIdeas, lastTrending] = await Promise.all([
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
    countOf(supabase, 'pending verifications', s => s.from('users')
      .select('*', { count: 'exact', head: true }).eq('verification_status', 'pending')),
    countOf(supabase, 'pending role requests', s => s.from('role_switch_requests')
      .select('*', { count: 'exact', head: true }).eq('status', 'pending')),
    countOf(supabase, 'patents under review', s => s.from('ideas')
      .select('*', { count: 'exact', head: true }).eq('status', 'under_review')),
    countOf(supabase, 'total users', s => s.from('users').select('*', { count: 'exact', head: true })),
    countOf(supabase, 'live ideas', s => s.from('ideas')
      .select('*', { count: 'exact', head: true }).eq('status', 'live')),
    safe('last trending run', () => supabase.from('bot_runs')
      .select('status, details, created_at').eq('bot', 'trending')
      .order('created_at', { ascending: false }).limit(1), []),
  ]);

  const newEscrows = txs.filter(t => t.created_at >= since);
  const completed = txs.filter(t => t.status === 'completed' && t.completed_at && t.completed_at >= since);
  const feesEarned = completed.reduce((s, t) => s + Number(t.fee || 0), 0);
  const zeroResult = chats.filter(c => c.result_count === 0).slice(0, 8);
  const pendingTotal = (pendingVerif || 0) + (pendingRoles || 0) + (pendingPatents || 0);

  return {
    newUsers, newIdeas, newRequests, newBusinesses, newEscrows, completed, feesEarned,
    chats, zeroResult, pendingVerif, pendingRoles, pendingPatents, pendingTotal,
    totalUsers, liveIdeas, lastTrending: lastTrending[0] || null
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
  if (d.pendingVerif) actions.push(`${d.pendingVerif} user verification${d.pendingVerif > 1 ? 's' : ''} waiting`);
  if (d.pendingRoles) actions.push(`${d.pendingRoles} role switch request${d.pendingRoles > 1 ? 's' : ''} waiting`);
  if (d.pendingPatents) actions.push(`${d.pendingPatents} patent idea${d.pendingPatents > 1 ? 's' : ''} under review`);

  const trend = d.lastTrending
    ? `Trending scores last updated ${fmtDate(d.lastTrending.created_at)} (${esc(d.lastTrending.status)}${d.lastTrending.details ? ': ' + esc(d.lastTrending.details) : ''})`
    : 'Trending bot has not run yet';

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
      ${esc(n(d.totalUsers))} users · ${esc(n(d.liveIdeas))} live ideas<br>
      <span style="color:#8a8680;">${trend}</span></p>`)}

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
    digest: () => runDigest(supabase, sendEmail),
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
  cron.schedule('0 7 * * *', () => run('digest'), { timezone: TZ });     // 7:00 AM

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

  console.log('  🤖  Bots scheduled: trending (00:00), digest (07:00) Asia/Colombo');
};
