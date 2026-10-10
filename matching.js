// ─────────────────────────────────────────────────────────────────────────────
// matching.js — connects Idea Requests (what investors want) with ideas and creators
// Usage in server.js:  const matching = require('./matching')(supabase, escrow);
//
//   suggest(request)          → { ideas: [...], creators: [...] }   (best fits, with reasons)
//   notifyNewRequest(request) → alerts only the best-matched creators (not everyone)
//   alertForNewIdea(idea)     → tells investors when a newly listed idea fits their open request
//   cleanup()                 → daily: closes past-deadline / stale requests, nudges quiet ones
//
// Matching is word-based (no AI cost): request title + problem + requirements are compared
// with each live idea's title + summary, then creators are ranked by their best ideas,
// industry, stated specializations, rating and verification.
// Railway variable (optional): MATCH_NOTIFY_LIMIT — creators alerted per new request (default 20)
// ─────────────────────────────────────────────────────────────────────────────
const OPEN = ['open', 'proposals_received', 'shortlisting', 'pitching'];
const CREATOR_ROLES = ['idea_creator', 'patent_seller'];
const NOTIFY_LIMIT = () => Math.max(1, Math.min(100, parseInt(process.env.MATCH_NOTIFY_LIMIT || '20', 10) || 20));

const STOP = new Set(('a an the and or but of for to in on at by with from into over under as is are was were be been being it its this that these those ' +
  'which who what when where why how we you they i he she our your their my me us them can could will would should may might must ' +
  'do does did not no so than then there here all any some more most less few many much very just also only such need needs want wants looking ' +
  'idea ideas new app platform system solution service services based using use make help people business product products way ways one get via ' +
  'about through someone something anyone looking find build create require required requirement requirements').split(' '));
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)
    .filter(w => w.length > 2 && !STOP.has(w)).map(stem);
}
const tf = list => list.reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {});
const norm = s => String(s || '').trim().toLowerCase();

// Builds a scorer over a set of documents (tf-idf, cosine)
function makeScorer(docTexts) {
  const docs = docTexts.map(t => tf(tokens(t)));
  const df = {};
  docs.forEach(d => Object.keys(d).forEach(w => { df[w] = (df[w] || 0) + 1; }));
  const N = docs.length + 1;
  const idf = w => Math.log((N + 1) / ((df[w] || 0) + 1)) + 1;
  const vec = d => { const v = {}; let n = 0; for (const w in d) { v[w] = d[w] * idf(w); n += v[w] * v[w]; } return { v, n: Math.sqrt(n) || 1 }; };
  const vecs = docs.map(vec);
  return queryText => {
    const q = vec(tf(tokens(queryText)));
    return vecs.map(dv => { let dot = 0; for (const w in dv.v) if (q.v[w]) dot += dv.v[w] * q.v[w]; return dot / (dv.n * q.n); });
  };
}
const requestText = r => `${r.title} ${r.title} ${r.problem || ''} ${r.requirements || ''}`;
const ideaText = i => `${i.title} ${i.title} ${i.summary || ''}`;

module.exports = function makeMatching(supabase, escrow) {
  const notify = (userId, n) => escrow ? escrow.notify(userId, n) : supabase.from('notifications').insert([{ user_id: userId, ...n }]);

  async function liveIdeas() {
    const { data, error } = await supabase.from('ideas')
      .select('id, title, summary, industry, price, creator_id, creator_name, originality_score, created_at')
      .eq('status', 'live').or('visibility.is.null,visibility.eq.1')
      .order('created_at', { ascending: false }).limit(3000);
    if (error) throw new Error(error.message);
    return data || [];
  }

  // Best-fitting ideas and creators for one request
  async function suggest(request, { ideaLimit = 6, creatorLimit = 15 } = {}) {
    const ideas = (await liveIdeas()).filter(i => i.creator_id !== request.investor_id);
    const score = makeScorer(ideas.map(ideaText));
    const raw = ideas.length ? score(requestText(request)) : [];
    const ind = norm(request.industry);
    const scored = ideas.map((i, k) => ({ idea: i, s: raw[k] + (ind && norm(i.industry) === ind ? 0.05 : 0) }))
      .filter(x => x.s > 0.08).sort((a, b) => b.s - a.s);

    // Creators: best idea counts most; more fitting ideas, industry, specializations, rating and verification add a little
    const byCreator = new Map();
    for (const x of scored.slice(0, 200)) {
      const c = byCreator.get(x.idea.creator_id) || { id: x.idea.creator_id, ideas: [], s: 0 };
      c.ideas.push(x);
      byCreator.set(x.idea.creator_id, c);
    }
    // People who list this industry or the request's key words as a specialization
    const words = [...new Set(tokens(`${request.title} ${request.industry || ''}`))].filter(w => w.length >= 4).slice(0, 6);
    let specRows = [];
    if (ind || words.length) {
      const ors = [ind ? `subject.ilike.%${request.industry.replace(/[%,()*\\"'`]/g, ' ').trim()}%` : null, ...words.map(w => `subject.ilike.%${w}%`)].filter(Boolean).join(',');
      const { data } = await supabase.from('user_specializations').select('user_id, subject').or(ors).limit(300);
      specRows = data || [];
    }
    for (const sr of specRows) if (!byCreator.has(sr.user_id)) byCreator.set(sr.user_id, { id: sr.user_id, ideas: [], s: 0 });

    const ids = [...byCreator.keys()].filter(id => id !== request.investor_id).slice(0, 300);
    if (!ids.length) return { ideas: scored.slice(0, ideaLimit).map(x => pubIdea(x)), creators: [] };
    const { data: users } = await supabase.from('users')
      .select('id, first_name, last_name, role, tagline, avatar_url, profile_stars, rating_avg, rating_count, verification_status')
      .in('id', ids);
    const userById = Object.fromEntries((users || []).map(u => [u.id, u]));

    const creators = [];
    for (const c of byCreator.values()) {
      const u = userById[c.id];
      if (!u || !CREATOR_ROLES.includes(u.role)) continue;
      const top = c.ideas.map(x => x.s).sort((a, b) => b - a);
      const specs = specRows.filter(r => r.user_id === c.id).map(r => r.subject);
      let s = (top[0] || 0) + 0.3 * ((top[1] || 0) + (top[2] || 0));
      if (specs.length) s += 0.1;
      s += (Number(u.profile_stars) || 0) / 5 * 0.05;
      if (u.verification_status === 'verified') s += 0.03;
      const reasons = [];
      if (c.ideas[0]) reasons.push(`Has a similar idea: "${c.ideas[0].idea.title}"`);
      if (c.ideas.length > 1) reasons.push(`${c.ideas.length} related ideas listed`);
      if (specs.length) reasons.push(`Specializes in ${[...new Set(specs)].slice(0, 2).join(', ')}`);
      if (u.rating_count) reasons.push(`Rated ${Number(u.rating_avg || u.profile_stars || 0).toFixed(1)} by ${u.rating_count} buyer${u.rating_count > 1 ? 's' : ''}`);
      if (u.verification_status === 'verified') reasons.push('Verified');
      creators.push({
        id: u.id, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Creator',
        tagline: u.tagline || null, avatar_url: u.avatar_url || null, stars: Number(u.profile_stars) || 0,
        score: Math.round(s * 100) / 100, reasons, idea_ids: c.ideas.slice(0, 3).map(x => x.idea.id)
      });
    }
    creators.sort((a, b) => b.score - a.score);
    return { ideas: scored.slice(0, ideaLimit).map(x => pubIdea(x)), creators: creators.slice(0, creatorLimit) };
  }
  function pubIdea(x) {
    const i = x.idea;
    return { id: i.id, title: i.title, summary: i.summary, industry: i.industry, price: i.price, creator_id: i.creator_id,
      creator_name: i.creator_name, originality_score: i.originality_score ?? null, match: Math.min(99, Math.round(x.s * 100)) };
  }

  async function saveMatches(requestId, creators, notified) {
    if (!creators.length) return;
    const rows = creators.map(c => ({ request_id: requestId, creator_id: c.id, score: c.score, reasons: c.reasons,
      idea_ids: c.idea_ids, notified_at: notified.has(c.id) ? new Date().toISOString() : null }));
    const { error } = await supabase.from('request_matches').upsert(rows, { onConflict: 'request_id,creator_id', ignoreDuplicates: false });
    if (error) console.error('request_matches save failed:', error.message);
  }

  // New request: alert the best-matched creators only
  async function notifyNewRequest(request) {
    const { creators } = await suggest(request, { creatorLimit: 50 });
    let toNotify = creators.slice(0, NOTIFY_LIMIT());
    // Nobody matched (new industry, few listings): fall back to recently active creators
    if (!toNotify.length) {
      const { data: recent } = await supabase.from('ideas').select('creator_id').neq('creator_id', request.investor_id)
        .order('created_at', { ascending: false }).limit(200);
      const seen = new Set();
      toNotify = (recent || []).filter(r => !seen.has(r.creator_id) && seen.add(r.creator_id)).slice(0, NOTIFY_LIMIT())
        .map(r => ({ id: r.creator_id, score: 0, reasons: ['Active creator'], idea_ids: [] }));
    }
    for (const c of toNotify) {
      await notify(c.id, {
        type: 'new_request', title: '🎯 A request that fits you',
        message: `An investor is looking for: "${request.title}". ${c.reasons[0] && c.reasons[0] !== 'Active creator' ? c.reasons[0] + '.' : ''} Send a proposal before others do.`.trim(),
        link: `/request/${request.id}`
      });
    }
    await saveMatches(request.id, creators.length ? creators : toNotify, new Set(toNotify.map(c => c.id)));
    return toNotify.length;
  }

  // New idea listed: tell investors whose open request it fits (max 3 requests, once per pair)
  async function alertForNewIdea(idea) {
    if (!idea || idea.status !== 'live' || (Number(idea.visibility) || 1) !== 1) return 0;
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const { data: reqs } = await supabase.from('idea_requests').select('id, title, problem, requirements, industry, investor_id, status')
      .in('status', OPEN).gte('created_at', since).limit(500);
    const open = (reqs || []).filter(r => r.investor_id !== idea.creator_id);
    if (!open.length) return 0;
    const score = makeScorer(open.map(requestText));
    const s = score(ideaText(idea));
    const hits = open.map((r, k) => ({ r, s: s[k] + (norm(r.industry) && norm(r.industry) === norm(idea.industry) ? 0.05 : 0) }))
      .filter(x => x.s > 0.12).sort((a, b) => b.s - a.s).slice(0, 3);
    let sent = 0;
    for (const h of hits) {
      const { error } = await supabase.from('request_idea_alerts').insert([{ request_id: h.r.id, idea_id: idea.id }]);
      if (error) continue; // already alerted (unique) or table missing
      await notify(h.r.investor_id, {
        type: 'request_match', title: '💡 A new idea fits your request',
        message: `"${idea.title}" was just listed and matches your request "${h.r.title}".`, link: `/idea?id=${idea.id}`
      });
      sent++;
    }
    return sent;
  }

  // Daily clean-up of Idea Requests
  async function cleanup() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const { data: reqs, error } = await supabase.from('idea_requests')
      .select('id, title, investor_id, status, deadline, proposal_count, created_at, reminder_sent_at, problem, requirements, industry')
      .in('status', OPEN).limit(2000);
    if (error) throw new Error(error.message);
    let closed = 0, stale = 0, nudged = 0;
    for (const r of reqs || []) {
      const ageDays = (now - new Date(r.created_at)) / 86400000;
      // Only requests still collecting proposals are closed; ones in shortlisting/pitching are left to the investor
      const collecting = ['open', 'proposals_received'].includes(r.status);
      const pastDeadline = collecting && r.deadline && String(r.deadline).slice(0, 10) < today;
      const noActivity = collecting && !r.deadline && ageDays > 60 && !(r.proposal_count > 0);
      if (pastDeadline || noActivity) {
        const { data: rows } = await supabase.from('idea_requests')
          .update({ status: 'closed', closed_reason: pastDeadline ? 'deadline' : 'inactive', updated_at: now.toISOString() })
          .eq('id', r.id).in('status', OPEN).select('id');
        if (rows && rows.length) {
          pastDeadline ? closed++ : stale++;
          await notify(r.investor_id, {
            type: 'request_closed', title: '📁 Request closed',
            message: pastDeadline
              ? `"${r.title}" reached its deadline and was closed with ${r.proposal_count || 0} proposal${r.proposal_count === 1 ? '' : 's'}. You can still review them, or post it again with a new deadline.`
              : `"${r.title}" had no proposals in 60 days, so it was closed. Try posting it again with more detail or a higher budget.`,
            link: `/request/${r.id}`
          });
        }
        continue;
      }
      // Quiet request: no proposals after 5 days (or 3 days before the deadline) → nudge once and widen the search
      const daysLeft = r.deadline ? (new Date(r.deadline) - now) / 86400000 : null;
      const quiet = collecting && !(r.proposal_count > 0) && !r.reminder_sent_at && (ageDays >= 5 || (daysLeft !== null && daysLeft <= 3));
      if (quiet) {
        await supabase.from('idea_requests').update({ reminder_sent_at: now.toISOString() }).eq('id', r.id);
        await notify(r.investor_id, {
          type: 'request_nudge', title: '💡 Get more proposals',
          message: `"${r.title}" has no proposals yet. Adding detail, a clearer budget or a later deadline helps. We've also alerted more creators who could fit.`,
          link: `/request/${r.id}`
        });
        // Alert the next best creators who weren't alerted the first time
        const { data: prev } = await supabase.from('request_matches').select('creator_id').eq('request_id', r.id).not('notified_at', 'is', null);
        const done = new Set((prev || []).map(p => p.creator_id));
        const { creators } = await suggest(r, { creatorLimit: 60 });
        const next = creators.filter(c => !done.has(c.id)).slice(0, 10);
        for (const c of next) await notify(c.id, { type: 'new_request', title: '🎯 Still looking for ideas', message: `An investor is still looking for: "${r.title}". ${c.reasons[0] ? c.reasons[0] + '.' : ''}`.trim(), link: `/request/${r.id}` });
        await saveMatches(r.id, next, new Set(next.map(c => c.id)));
        nudged++;
      }
    }
    return `closed ${closed} past deadline · ${stale} inactive · nudged ${nudged}`;
  }

  return { suggest, notifyNewRequest, alertForNewIdea, cleanup, OPEN };
};
