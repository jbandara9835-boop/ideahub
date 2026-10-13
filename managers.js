// ─────────────────────────────────────────────────────────────────────────────
// managers.js — IdeaHub Managers (the Virtual Manager role)
//
// A manager works for ONE side: an idea creator, an investor or a business, under a mandate.
//
//   Mandate      proposed by either side, accepted by the other (agreement v1 stored on it).
//                Scopes say what the manager may do. Fees: monthly retainer, hourly and/or a
//                success fee (all optional). Budget limit for anything the manager prepares.
//   Rules        • never both sides: a manager can't act toward someone who is also their client,
//                  and can't take a client who has an open deal with another of their clients
//                • never two similar businesses at once: one active client per industry focus
//                • binding steps need the client's approval and the client's own payment;
//                  the manager never holds client money
//   Approvals    the manager prepares: an idea purchase, an Idea Request, choosing a proposal,
//                a proposal to an Idea Request, a Business Expansion application, hiring a
//                professional. The client approves and IdeaHub runs it AS the client, through
//                the normal routes (every normal check applies).
//   Pipeline     the manager's items per client (ideas, requests, businesses, contacts) with
//                stages; "shared" items become recommendations the client sees and rates.
//   Money        bills: retainer (paid in advance, released at period end), hours (approved
//                timesheets), success fee (% of completed deals), one-off fee, venture milestone
//                fee. IdeaHub adds its 8% on top. Disputes go to admin.
//                Referral reward: when a manager brings the buyer to an idea and the sale
//                completes, IdeaHub gives the manager VM_REFERRAL_SHARE of its own fee.
//   Ventures     a business built for an investor: plan + milestones; each milestone fee is
//                paid into escrow and released when the investor approves the evidence.
//   Requests     clients post "I need a manager"; managers pitch; accepting a pitch drafts a mandate.
//   Hiring       optional, per side. Either side can ask for screening before agreeing: the
//                manager's CV, work history and references, written questions, and one or more
//                video interviews (built-in calls). The manager first pledges to keep what they
//                learn confidential. The mandate can't be accepted until each side that asked
//                for screening says "satisfied" (or "not a fit", which declines it).
//                Without screening, a mandate can be accepted straight away (quick hire).
//   Levels       New → Associate (ID checked + induction quiz) → Verified (+ proof of address)
//                → Senior (5 completed mandates or deals, rating 4.5+). Associates can take
//                mandates; ventures need Verified.
//
// server.js: const managers = require('./managers'); managers.mount(app, { supabase, authMiddleware, escrow })
// bots.js:   require('./managers').core(supabase, escrow).runBot()  (daily) / .runWeekly() (Mondays)
// Railway:   VM_REFERRAL_SHARE (default 0.25 = a quarter of IdeaHub's 8% fee)
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

const FEE_RATE = 0.08;
const AUTO_RELEASE_DAYS = 7;
const RETAINER_DAYS = 30;
const SUCCESS_WINDOW_DAYS = 90;   // deals introduced during the mandate still count this long after it ends
const referralShare = () => { const n = Number(process.env.VM_REFERRAL_SHARE); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25; };

const SIDES = { creator: 'Idea creator', investor: 'Investor', business: 'Business' };
const SCOPES = {
  listings: { label: 'Create and edit my idea listings', sides: ['creator'] },
  proposals: { label: 'Prepare proposals to Idea Requests (I approve each one)', sides: ['creator'] },
  messages: { label: 'Message people on IdeaHub on my behalf', sides: ['creator', 'investor', 'business'] },
  scout: { label: 'Find and recommend ideas and businesses for me', sides: ['investor', 'business'] },
  purchases: { label: 'Prepare idea purchases (I approve and pay)', sides: ['investor', 'business'] },
  requests: { label: 'Post Idea Requests and choose proposals (I approve)', sides: ['investor', 'business'] },
  expansion: { label: 'Apply to Business Expansion listings (I approve)', sides: ['investor', 'business'] },
  setup: { label: 'Hire accountants, lawyers and company services (I approve and pay)', sides: ['creator', 'investor', 'business'] },
  venture: { label: 'Build a business for me as a managed venture with milestones', sides: ['investor', 'business'] }
};
const ACTIONS = {
  purchase: { scope: 'purchases', label: 'Buy an idea' },
  post_request: { scope: 'requests', label: 'Post an Idea Request' },
  select_proposal: { scope: 'requests', label: 'Choose a proposal' },
  proposal: { scope: 'proposals', label: 'Send a proposal' },
  expansion_apply: { scope: 'expansion', label: 'Apply to a business' },
  hire: { scope: 'setup', label: 'Hire a professional' }
};
const LEVELS = { new: 'New', associate: 'Associate', verified: 'Verified', senior: 'Senior' };
const TERMS_VERSION = 'v1';
const TERMS_POINTS = [
  'Appointment. The client appoints the manager for the tasks ticked in this mandate, from the start date until it ends. Either side can end it at any time from the mandate page.',
  'One side only. The manager acts only for the client. The manager will not act for the other side of any deal the client is in, and will not manage a competing business in the same industry while this mandate is active.',
  'Approvals and money. Anything binding (a purchase, a proposal, an application, hiring someone) needs the client\'s approval, and the client pays through IdeaHub. The manager never receives the client\'s money outside the fees in this mandate.',
  'Confidentiality. The manager keeps everything learned about the client and their deals confidential, during and after the mandate.',
  'Fees. A retainer is paid at the start of each 30-day period and released to the manager at the end of it unless the client reports a problem. Hours are paid when the client approves the timesheet. A success fee is a percentage of deals completed through IdeaHub that the manager prepared or recommended (for idea creators, sales of the client\'s ideas) during the mandate, or within 90 days after it ends for deals introduced during it. IdeaHub adds its 8% service fee to each payment.',
  'No side deals. Deals with people met through IdeaHub are completed on IdeaHub.',
  'Problems. If something goes wrong, either side can report it; IdeaHub reviews the activity log, messages and files and decides on held payments.',
  'Law. This mandate is governed by the laws of Sri Lanka.'
];
const TERMS_TEXT = `MANAGER MANDATE (${TERMS_VERSION})\n\nThis mandate is between the client and the manager named on this page, made through IdeaHub (Picela (Pvt) Ltd), which hosts the payments but is not a party to it.\n\n` + TERMS_POINTS.map((p, i) => `${i + 1}. ${p}`).join('\n\n');

// Induction quiz: pass with 8 of 10
const QUIZ = [
  { q: 'An investor client asks you to buy an idea. Who pays the seller?', a: ['You pay, and the client pays you back', 'The client pays through IdeaHub after approving the purchase', 'The seller is paid in cash'], c: 1 },
  { q: 'The creator of an idea your investor wants to buy asks you to manage their listings too. What do you do?', a: ['Accept: more clients is better', 'Accept but keep it secret', 'Decline: a manager never acts for both sides of a deal'], c: 2 },
  { q: 'You manage a bakery chain\'s expansion. Another bakery asks you to be their manager. What do you do?', a: ['Decline while the first mandate is active: no two competing businesses at once', 'Accept and share ideas between them', 'Accept if they are in different cities'], c: 0 },
  { q: 'A seller offers you a private commission if your client buys their idea. What do you do?', a: ['Accept it quietly', 'Refuse it and tell your client', 'Accept and give your client a discount'], c: 1 },
  { q: 'A buyer you met on IdeaHub suggests closing the deal by bank transfer outside IdeaHub to save the fee. What do you do?', a: ['Agree: it saves money', 'Keep the deal on IdeaHub, where the escrow protects your client', 'Let the client decide privately'], c: 1 },
  { q: 'What can you share about your client\'s plans with other members?', a: ['Anything that helps close a deal', 'Nothing confidential, during or after the mandate', 'Only the price they will pay'], c: 1 },
  { q: 'When is a retainer released to you?', a: ['At the end of the 30-day period, unless the client reports a problem', 'As soon as the client pays', 'When a deal closes'], c: 0 },
  { q: 'Your client is unhappy with your work and reports a problem. What happens?', a: ['You keep the money anyway', 'IdeaHub reviews the activity log, messages and files and decides', 'The client keeps everything automatically'], c: 1 },
  { q: 'Can you sign a company registration on behalf of an investor?', a: ['Yes, managers sign everything', 'No: you prepare and coordinate, the investor (the owner) signs', 'Only for small companies'], c: 1 },
  { q: 'Messages you send on behalf of a client appear as…', a: ['Messages from the client', 'Messages from you, labelled as the client\'s manager', 'Anonymous messages'], c: 1 }
];

const round2 = n => Math.round(Number(n || 0) * 100) / 100;
const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const intId = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= (max || 1e9) ? round2(n) : null; };
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';
const norm = s => String(s || '').trim().toLowerCase();
const sideOfRole = r => r === 'investor' ? 'investor' : r === 'business_owner' ? 'business' : 'creator';
const CLIENT_ROLES = ['idea_creator', 'patent_seller', 'investor', 'business_owner'];
const OPEN_MANDATE = ['proposed', 'active'];
// Sides that asked for a hiring process and haven't said "satisfied" yet
const screeningPending = m => [m.screen_client && !m.client_cleared_at ? 'client' : null, m.screen_manager && !m.manager_cleared_at ? 'manager' : null].filter(Boolean);

// ── CORE (shared by routes and bots) ─────────────────────────────────────────
function core(supabase, escrow) {
  const payments = require('./payments')(supabase);
  const money = escrow.money;
  async function users(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return {};
    const { data } = await supabase.from('users').select('id, first_name, last_name, role, avatar_url, email, earnings').in('id', list);
    return Object.fromEntries((data || []).map(u => [u.id, u]));
  }
  async function addEarnings(userId, amount) {
    const { data: u } = await supabase.from('users').select('earnings').eq('id', userId).single();
    await supabase.from('users').update({ earnings: round2(Number(u?.earnings || 0) + Number(amount || 0)) }).eq('id', userId);
  }
  async function log(mandateId, actorId, action, detail) {
    try { await supabase.from('mandate_log').insert([{ mandate_id: mandateId, actor_id: actorId || null, action, detail: detail ? String(detail).slice(0, 500) : null }]); } catch (e) { /* never blocks */ }
  }
  async function admins() { const { data } = await supabase.from('users').select('id').eq('role', 'admin'); return (data || []).map(a => a.id); }

  // ── Levels ──
  async function levelOf(userId) {
    const [{ data: creds }, { data: prof }, { data: done }] = await Promise.all([
      supabase.from('pro_credentials').select('kind').eq('user_id', userId).eq('status', 'verified'),
      supabase.from('manager_profiles').select('induction_passed_at').eq('user_id', userId).maybeSingle(),
      supabase.from('mandates').select('id').eq('manager_id', userId).eq('status', 'ended').eq('completed_ok', true)
    ]);
    const kinds = new Set((creds || []).map(c => c.kind));
    if (!kinds.has('identity') || !prof || !prof.induction_passed_at) return 'new';
    if (!kinds.has('address')) return 'associate';
    const st = await statsOf(userId);
    if ((((done || []).length) + st.deals_closed) >= 5 && st.rating != null && st.rating >= 4.5) return 'senior';
    return 'verified';
  }
  async function statsOf(userId) {
    const [{ data: ms }, { data: deals }, { data: rates }] = await Promise.all([
      supabase.from('mandates').select('id, client_id, status').eq('manager_id', userId),
      supabase.from('mandate_deals').select('id, status, manager_id').eq('manager_id', userId),
      supabase.from('mandate_ratings').select('stars').eq('manager_id', userId)
    ]);
    const real = (ms || []).filter(m => ['active', 'ended'].includes(m.status));
    const n = (rates || []).length;
    return {
      clients_served: new Set(real.map(m => m.client_id)).size,
      active_clients: real.filter(m => m.status === 'active').length,
      deals_closed: (deals || []).filter(d => d.status === 'completed').length,
      rating: n ? Math.round(rates.reduce((s, r) => s + Number(r.stars || 0), 0) / n * 10) / 10 : null,
      rating_count: n
    };
  }

  // ── Conflict rules ──
  async function activeMandates(managerId) {
    const { data } = await supabase.from('mandates').select('*').eq('manager_id', managerId).in('status', OPEN_MANDATE);
    return data || [];
  }
  async function isClientOf(managerId, userId, exceptMandateId) {
    if (!userId) return false;
    const { data } = await supabase.from('mandates').select('id').eq('manager_id', managerId).eq('client_id', userId).eq('status', 'active');
    return (data || []).some(m => m.id !== exceptMandateId);
  }
  // Does user A have an open deal with user B?
  async function openDealBetween(a, b) {
    const [{ data: tx }, { data: rq }] = await Promise.all([
      supabase.from('transactions').select('buyer_id, seller_id').in('status', ['escrow', 'disputed']).or(`and(buyer_id.eq.${a},seller_id.eq.${b}),and(buyer_id.eq.${b},seller_id.eq.${a})`),
      supabase.from('idea_requests').select('investor_id, selected_creator_id, status').in('status', ['agreed', 'in_escrow', 'delivered', 'disputed']).or(`and(investor_id.eq.${a},selected_creator_id.eq.${b}),and(investor_id.eq.${b},selected_creator_id.eq.${a})`)
    ]);
    const pair = (x, y) => (x === a && y === b) || (x === b && y === a);
    if ((tx || []).some(t => pair(t.buyer_id, t.seller_id))) return true;
    if ((rq || []).some(r => pair(r.investor_id, r.selected_creator_id))) return true;
    const { data: apps } = await supabase.from('expansion_applications').select('investor_id, status, listing_id').eq('investor_id', a).in('status', ['pending', 'reviewed', 'shortlisted', 'meetup_scheduled', 'negotiating', 'accepted']);
    const { data: apps2 } = await supabase.from('expansion_applications').select('investor_id, status, listing_id').eq('investor_id', b).in('status', ['pending', 'reviewed', 'shortlisted', 'meetup_scheduled', 'negotiating', 'accepted']);
    const ids = [...(apps || []), ...(apps2 || [])].map(x => x.listing_id);
    if (ids.length) {
      const { data: ls } = await supabase.from('business_listings').select('id, owner_id').in('id', ids);
      const owner = Object.fromEntries((ls || []).map(l => [l.id, l.owner_id]));
      if ((apps || []).some(x => owner[x.listing_id] === b) || (apps2 || []).some(x => owner[x.listing_id] === a)) return true;
    }
    return false;
  }
  // Can this manager take this client (rules: one side only, no two similar businesses)?
  async function mandateConflict(managerId, clientId, focus, exceptMandateId) {
    const others = (await activeMandates(managerId)).filter(m => m.id !== exceptMandateId && m.client_id !== clientId);
    const f = norm(focus);
    const same = f && others.find(m => norm(m.focus_industry) === f);
    if (same) return `This manager already works for another client in ${focus}. To keep trust, a manager can't manage two similar businesses at the same time.`;
    for (const m of others.filter(m => m.status === 'active')) {
      if (await openDealBetween(clientId, m.client_id)) return 'This manager works for the other side of a deal you are in. A manager can only ever act for one side.';
    }
    return null;
  }

  // ── Bills ──
  async function createBill(m, { kind, description, amount, period_start, period_end, deal_ref }) {
    amount = round2(amount);
    if (!(amount > 0)) return null;
    const fee = round2(amount * FEE_RATE);
    const { data } = await supabase.from('mandate_bills').insert([{
      mandate_id: m.id, client_id: m.client_id, manager_id: m.manager_id, kind, description: String(description).slice(0, 300),
      amount, fee, total: round2(amount + fee), status: 'due', period_start: period_start || null, period_end: period_end || null, deal_ref: deal_ref || null
    }]).select().single();
    if (data) {
      await notifyBill(data, m);
      await log(m.id, null, 'bill', `${kindLabel(kind)}: ${money(amount)} (${description})`);
    }
    return data;
  }
  const kindLabel = k => ({ retainer: 'Retainer', hours: 'Hours', success: 'Success fee', oneoff: 'One-off fee', milestone: 'Milestone fee' }[k] || k);
  async function notifyBill(b, m) {
    await escrow.notify(b.client_id, { type: 'mandate_bill', title: '🧾 Manager fee to pay', message: `${kindLabel(b.kind)} of ${money(b.amount)} for "${m.title}" (plus IdeaHub's 8%).`, link: `/mandate?id=${m.id}` });
  }
  async function releaseBill(id, how, note) {
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('mandate_bills').update({ status: 'released', released_at: now, release_type: how, resolution_note: note || null }).eq('id', id).in('status', how === 'admin' ? ['paid', 'disputed'] : ['paid']).select();
    const b = rows && rows[0]; if (!b) return null;
    await addEarnings(b.manager_id, b.amount);
    await payments.record({ kind: 'release', userId: b.manager_id, amount: b.amount, meta: { mandate_bill_id: b.id, mandate_id: b.mandate_id, release_type: how } });
    await payments.record({ kind: 'fee', userId: null, amount: b.fee, meta: { mandate_bill_id: b.id } });
    await escrow.notify(b.manager_id, { type: 'payment_released', title: '💰 Manager fee released', message: `${money(b.amount)} (${kindLabel(b.kind).toLowerCase()}) was added to your wallet.`, link: '/transactions' });
    await log(b.mandate_id, null, 'released', `${kindLabel(b.kind)} ${money(b.amount)} released to the manager${how === 'auto' ? ' automatically' : how === 'admin' ? ' by IdeaHub' : ''}.`);
    if (b.kind === 'milestone') await supabase.from('venture_milestones').update({ status: 'approved', approved_at: now }).eq('bill_id', b.id).in('status', ['funded', 'submitted', 'changes']);
    return b;
  }
  async function refundBill(id, note) {
    const now = new Date().toISOString();
    const { data: rows } = await supabase.from('mandate_bills').update({ status: 'refunded', resolved_at: now, resolution_note: note || null }).eq('id', id).in('status', ['paid', 'disputed']).select();
    const b = rows && rows[0]; if (!b) return null;
    await payments.record({ kind: 'refund', userId: b.client_id, amount: b.total, meta: { mandate_bill_id: b.id, note: note || null } });
    for (const uid of [b.client_id, b.manager_id]) await escrow.notify(uid, { type: 'mandate_refund', title: '↩️ Manager fee refunded', message: `${kindLabel(b.kind)} of ${money(b.amount)} was refunded to the client.${note ? ' ' + note : ''}`, link: `/mandate?id=${b.mandate_id}` });
    await log(b.mandate_id, null, 'refunded', `${kindLabel(b.kind)} ${money(b.amount)} refunded to the client by IdeaHub.`);
    return b;
  }

  // ── Bots ──
  async function runBot() {
    const now = new Date(), iso = now.toISOString();
    let renewed = 0, released = 0, success = 0, referrals = 0, ended = 0, reminders = 0;
    // 1. Retainers: release paid periods that ended; open the next period's bill
    const { data: paidRet } = await supabase.from('mandate_bills').select('id, period_end, kind, release_at').eq('status', 'paid').in('kind', ['retainer', 'milestone']);
    for (const b of paidRet || []) {
      const at = b.kind === 'retainer' ? b.period_end : b.release_at;
      if (at && new Date(at) <= now && await releaseBill(b.id, 'auto')) released++;
    }
    const { data: act } = await supabase.from('mandates').select('*').eq('status', 'active');
    for (const m of act || []) {
      if (m.end_date && new Date(m.end_date + 'T23:59:59Z') < now) {
        await supabase.from('mandates').update({ status: 'ended', ended_at: iso, end_reason: 'End date reached', completed_ok: true }).eq('id', m.id).eq('status', 'active');
        await log(m.id, null, 'ended', 'The mandate reached its end date.');
        for (const uid of [m.client_id, m.manager_id]) await escrow.notify(uid, { type: 'mandate_ended', title: 'Mandate ended', message: `"${m.title}" reached its end date.`, link: `/mandate?id=${m.id}` });
        ended++; continue;
      }
      if (Number(m.fee_retainer) > 0 && m.next_retainer_at && new Date(m.next_retainer_at) <= now) {
        const start = new Date(m.next_retainer_at), end = new Date(start.getTime() + RETAINER_DAYS * 86400000);
        await supabase.from('mandates').update({ next_retainer_at: end.toISOString() }).eq('id', m.id);
        if (await createBill(m, { kind: 'retainer', description: `Retainer ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`, amount: m.fee_retainer, period_start: start.toISOString(), period_end: end.toISOString() })) renewed++;
      }
    }
    // 2. Deals: record completed deals → success fees + referral rewards
    const r = await trackDeals();
    success += r.success; referrals += r.referrals;
    // 3. Reminders for bills not paid after 7 days; admins after 14
    const { data: due } = await supabase.from('mandate_bills').select('*').eq('status', 'due');
    for (const b of due || []) {
      const age = (now - new Date(b.created_at)) / 86400000;
      if (age >= 7 && !b.reminded_at) {
        await escrow.notify(b.client_id, { type: 'mandate_bill', title: '⏰ Manager fee still to pay', message: `${kindLabel(b.kind)} of ${money(b.amount)} has been waiting for ${Math.floor(age)} days.`, link: `/mandate?id=${b.mandate_id}` });
        await supabase.from('mandate_bills').update({ reminded_at: iso }).eq('id', b.id); reminders++;
      } else if (age >= 14 && !b.escalated_at) {
        for (const a of await admins()) await escrow.notify(a, { type: 'mandate_overdue', title: '🧾 Overdue manager fee', message: `${kindLabel(b.kind)} ${money(b.amount)} unpaid for ${Math.floor(age)} days (mandate #${b.mandate_id}).`, link: '/admin' });
        await supabase.from('mandate_bills').update({ escalated_at: iso }).eq('id', b.id);
      }
    }
    return `Managers: ${renewed} retainers billed, ${released} payments released, ${success} success fees, ${referrals} referral rewards, ${ended} mandates ended, ${reminders} reminders`;
  }

  // Deals linked to managers: mark completed, bill success fees, pay referral rewards
  async function trackDeals() {
    let success = 0, referrals = 0;
    const now = new Date();
    // a) Creator-side mandates with a success fee: sales of the client's ideas during the mandate
    const { data: ms } = await supabase.from('mandates').select('*').in('status', ['active', 'ended']).eq('client_side', 'creator').gt('fee_success_pct', 0);
    for (const m of ms || []) {
      if (!m.started_at) continue;
      const until = m.ended_at ? new Date(new Date(m.ended_at).getTime() + SUCCESS_WINDOW_DAYS * 86400000) : now;
      if (until < now && m.status === 'ended') continue;
      const { data: txs } = await supabase.from('transactions').select('id, amount, completed_at, created_at, idea_title').eq('seller_id', m.client_id).eq('status', 'completed').gte('created_at', m.started_at);
      for (const t of txs || []) {
        if (m.ended_at && new Date(t.created_at) > new Date(m.ended_at)) continue;
        const { data: ex } = await supabase.from('mandate_deals').select('id').eq('mandate_id', m.id).eq('kind', 'sale').eq('ref_id', t.id).limit(1);
        if (ex && ex.length) continue;
        await supabase.from('mandate_deals').insert([{ mandate_id: m.id, manager_id: m.manager_id, client_id: m.client_id, kind: 'sale', ref_id: t.id, value: t.amount, status: 'completed', completed_at: t.completed_at || now.toISOString(), success_billed: true }]);
        if (await createBill(m, { kind: 'success', description: `${Number(m.fee_success_pct)}% of the sale of "${t.idea_title || 'an idea'}" (${money(t.amount)})`, amount: Number(t.amount) * Number(m.fee_success_pct) / 100, deal_ref: { kind: 'sale', id: t.id } })) success++;
      }
    }
    // b) Deals the manager prepared (approved actions) or recommended (shared ideas)
    const { data: open } = await supabase.from('mandate_deals').select('*').eq('status', 'open');
    for (const d of open || []) {
      let done = null, value = Number(d.value || 0), dead = false;
      if (d.kind === 'purchase') {
        const { data: t } = await supabase.from('transactions').select('id, status, amount, fee, idea_title').eq('id', d.ref_id).single();
        if (t && t.status === 'completed') { done = t; value = Number(t.amount); }
        if (!t || t.status === 'refunded') dead = true;
      } else if (d.kind === 'request') {
        const { data: rq } = await supabase.from('idea_requests').select('id, status, escrow_amount, title').eq('id', d.ref_id).single();
        if (rq && rq.status === 'completed') { done = rq; value = Number(rq.escrow_amount || 0); }
        if (!rq || ['refunded', 'closed', 'cancelled'].includes(rq.status)) dead = true;
      }
      if (dead) { await supabase.from('mandate_deals').update({ status: 'cancelled' }).eq('id', d.id); continue; }
      if (!done) continue;
      await supabase.from('mandate_deals').update({ status: 'completed', value, completed_at: now.toISOString() }).eq('id', d.id).eq('status', 'open');
      const { data: m } = await supabase.from('mandates').select('*').eq('id', d.mandate_id).single();
      if (!m) continue;
      if (Number(m.fee_success_pct) > 0 && !d.success_billed && value > 0) {
        await supabase.from('mandate_deals').update({ success_billed: true }).eq('id', d.id);
        if (await createBill(m, { kind: 'success', description: `${Number(m.fee_success_pct)}% of "${done.idea_title || done.title || 'a deal'}" (${money(value)})`, amount: value * Number(m.fee_success_pct) / 100, deal_ref: { kind: d.kind, id: d.ref_id } })) success++;
      }
      // Referral reward from IdeaHub's own fee, for bringing the buyer to an idea
      if (d.kind === 'purchase' && !d.referral_paid && Number(done.fee) > 0 && referralShare() > 0) {
        // Never pay a manager who is also the seller's manager (one side only)
        const { data: tx } = await supabase.from('transactions').select('seller_id').eq('id', d.ref_id).single();
        if (tx && !(await isClientOf(m.manager_id, tx.seller_id))) {
          const reward = round2(Number(done.fee) * referralShare());
          if (reward > 0) {
            await supabase.from('mandate_deals').update({ referral_paid: true, referral_amount: reward }).eq('id', d.id);
            await addEarnings(m.manager_id, reward);
            await payments.record({ kind: 'release', userId: m.manager_id, amount: reward, meta: { referral_tx: d.ref_id, mandate_id: m.id } });
            await escrow.notify(m.manager_id, { type: 'referral_reward', title: '🎁 Referral reward', message: `You brought the buyer for "${done.idea_title || 'an idea'}". IdeaHub added ${money(reward)} to your wallet.`, link: '/transactions' });
            await log(m.id, null, 'referral', `IdeaHub paid the manager a ${money(reward)} referral reward.`);
            referrals++;
          }
        }
      }
      await log(m.id, null, 'deal', `Deal completed: "${done.idea_title || done.title || 'deal'}" (${money(value)}).`);
    }
    // c) Investor bought an idea the manager recommended → link it as a deal
    const { data: shared } = await supabase.from('mandate_items').select('id, mandate_id, ref_id, created_at').eq('kind', 'idea').eq('shared', true);
    for (const it of shared || []) {
      const { data: m } = await supabase.from('mandates').select('id, client_id, manager_id, status, ended_at, client_side').eq('id', it.mandate_id).single();
      if (!m || !['active', 'ended'].includes(m.status) || m.client_side === 'creator') continue;
      const { data: txs } = await supabase.from('transactions').select('id, created_at').eq('buyer_id', m.client_id).eq('idea_id', it.ref_id).gte('created_at', it.created_at);
      for (const t of txs || []) {
        if (m.ended_at && new Date(t.created_at) > new Date(new Date(m.ended_at).getTime() + SUCCESS_WINDOW_DAYS * 86400000)) continue;
        const { data: ex } = await supabase.from('mandate_deals').select('id').eq('kind', 'purchase').eq('ref_id', t.id).limit(1);
        if (ex && ex.length) continue;
        await supabase.from('mandate_deals').insert([{ mandate_id: m.id, manager_id: m.manager_id, client_id: m.client_id, kind: 'purchase', ref_id: t.id, status: 'open', source: 'recommended' }]);
      }
    }
    return { success, referrals };
  }

  // Weekly summary to each client
  async function runWeekly() {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: act } = await supabase.from('mandates').select('*').eq('status', 'active');
    let sent = 0;
    for (const m of act || []) {
      const [{ data: lg }, { data: pend }, { data: bills }, { data: items }] = await Promise.all([
        supabase.from('mandate_log').select('action, detail').eq('mandate_id', m.id).gte('created_at', since),
        supabase.from('mandate_actions').select('id').eq('mandate_id', m.id).eq('status', 'pending'),
        supabase.from('mandate_bills').select('id').eq('mandate_id', m.id).eq('status', 'due'),
        supabase.from('mandate_items').select('id').eq('mandate_id', m.id).eq('shared', true).gte('created_at', since)
      ]);
      const U = await users([m.manager_id]);
      const lines = (lg || []).slice(0, 12).map(l => `<li>${escrow.esc(l.detail || l.action)}</li>`).join('');
      await escrow.emailUser(m.client_id, `Your manager's week: "${m.title}"`, `This week with ${escrow.esc(fullName(U[m.manager_id]))}`,
        `${(lg || []).length} update${(lg || []).length === 1 ? '' : 's'}, ${(items || []).length} new recommendation${(items || []).length === 1 ? '' : 's'}, ${(pend || []).length} waiting for your approval, ${(bills || []).length} fee${(bills || []).length === 1 ? '' : 's'} to pay.${lines ? `<ul style="margin:12px 0 0;padding-left:18px">${lines}</ul>` : ''}`,
        'Open mandate', `/mandate?id=${m.id}`);
      sent++;
    }
    return `Manager weekly summaries: ${sent}`;
  }

  return { users, log, levelOf, statsOf, isClientOf, mandateConflict, createBill, releaseBill, refundBill, runBot, runWeekly, trackDeals, admins, addEarnings, payments, kindLabel };
}

// ── ROUTES ───────────────────────────────────────────────────────────────────
function mount(app, { supabase, authMiddleware, escrow }) {
  const c = core(supabase, escrow);
  const money = escrow.money;
  const nf = res => res.status(404).json({ error: 'Not found.' });
  const port = () => process.env.PORT || 3000;
  async function me(id) { const { data } = await supabase.from('users').select('id, role, first_name, last_name, email').eq('id', id).single(); return data; }
  async function loadMandate(id) { const { data } = id ? await supabase.from('mandates').select('*').eq('id', id).single() : { data: null }; return data || null; }
  async function access(req, id) {
    const m = await loadMandate(intId(id));
    if (!m) return {};
    const u = await me(req.user.id);
    const as = m.client_id === req.user.id ? 'client' : m.manager_id === req.user.id ? 'manager' : u && u.role === 'admin' ? 'admin' : null;
    return { m, as, u };
  }
  const has = (m, scope) => (m.scopes || []).includes(scope);
  // Run an existing route as another user (used when the client approves an action)
  async function callAs(userId, method, path, body) {
    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '2m' });
    const r = await fetch(`http://127.0.0.1:${port()}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: j } : { ok: false, error: j.error || `Could not complete (${r.status}).` };
  }

  // Meta: sides, scopes, actions, levels, terms, quiz (without answers)
  app.get('/api/managers/meta', (req, res) => res.json({
    sides: SIDES, scopes: SCOPES, actions: ACTIONS, levels: LEVELS, fee_rate: FEE_RATE, referral_share: referralShare(),
    terms: { version: TERMS_VERSION, points: TERMS_POINTS, text: TERMS_TEXT },
    quiz: QUIZ.map((x, i) => ({ id: i, q: x.q, a: x.a }))
  }));

  // ── Find a Manager ──
  app.get('/api/managers', async (req, res) => {
    const { data: us } = await supabase.from('users').select('id, first_name, last_name, avatar_url, country').eq('role', 'virtual_manager').limit(500);
    const ids = (us || []).map(u => u.id);
    if (!ids.length) return res.json([]);
    const [{ data: profs }, { data: sp }] = await Promise.all([
      supabase.from('manager_profiles').select('*').in('user_id', ids),
      supabase.from('support_profiles').select('user_id, tagline, languages, home_country, availability, hourly_rate').in('user_id', ids)
    ]);
    const P = Object.fromEntries((profs || []).map(p => [p.user_id, p])), S = Object.fromEntries((sp || []).map(p => [p.user_id, p]));
    const out = [];
    for (const u of us) {
      const p = P[u.id]; if (!p || !p.induction_passed_at) continue;
      const level = await c.levelOf(u.id);
      if (level === 'new') continue;
      if (S[u.id] && S[u.id].availability === 'unavailable') continue;
      const st = await c.statsOf(u.id);
      out.push({
        id: u.id, name: fullName(u), avatar_url: u.avatar_url, country: (S[u.id] || {}).home_country || u.country || null,
        headline: p.headline || (S[u.id] || {}).tagline || '', about: p.about || '', industries: p.industries || [], countries: p.countries || [],
        languages: (S[u.id] || {}).languages || p.languages || [], sides: p.sides || [], fee_models: p.fee_models || [],
        retainer_from: p.retainer_from, hourly_rate: p.hourly_rate, success_pct: p.success_pct,
        has_cv: !!p.cv_path, has_history: !!p.experience, has_references: !!p.references_text, experience: p.experience || '', linkedin_url: p.linkedin_url || null,
        level, level_label: LEVELS[level], ...st
      });
    }
    const q = norm(req.query.q), ind = norm(req.query.industry), side = req.query.side, fee = req.query.fee, country = norm(req.query.country);
    let rows = out.filter(m => (!q || norm(`${m.name} ${m.headline} ${m.about} ${(m.industries || []).join(' ')}`).includes(q))
      && (!ind || (m.industries || []).some(x => norm(x) === ind))
      && (!side || !(m.sides || []).length || m.sides.includes(side))
      && (!fee || (m.fee_models || []).includes(fee))
      && (!country || norm(m.country) === country || (m.countries || []).some(x => norm(x) === country)));
    const rank = { senior: 3, verified: 2, associate: 1 };
    rows.sort((a, b) => (rank[b.level] - rank[a.level]) || ((b.rating || 0) - (a.rating || 0)) || (b.deals_closed - a.deals_closed));
    res.json(rows);
  });

  // ── My manager profile + induction ──
  app.get('/api/manager/profile', authMiddleware, async (req, res) => {
    const u = await me(req.user.id);
    const { data: p } = await supabase.from('manager_profiles').select('*').eq('user_id', req.user.id).maybeSingle();
    const { data: creds } = await supabase.from('pro_credentials').select('kind, status').eq('user_id', req.user.id);
    res.json({ is_manager: u && u.role === 'virtual_manager', profile: p || null, level: await c.levelOf(req.user.id), levels: LEVELS, stats: await c.statsOf(req.user.id),
      checks: { identity: (creds || []).find(x => x.kind === 'identity')?.status || null, address: (creds || []).find(x => x.kind === 'address')?.status || null, induction: !!(p && p.induction_passed_at) } });
  });
  app.put('/api/manager/profile', authMiddleware, async (req, res) => {
    const u = await me(req.user.id);
    if (!u || u.role !== 'virtual_manager') return res.status(403).json({ error: 'Switch to the Virtual Manager role first.' });
    const b = req.body || {};
    const list = (v, n) => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => txt(x, 60)).filter(Boolean).slice(0, n);
    const row = {
      user_id: req.user.id, headline: txt(b.headline, 120) || null, about: txt(b.about, 1500) || null,
      industries: list(b.industries, 8), countries: list(b.countries, 10),
      sides: list(b.sides, 3).filter(s => SIDES[s]), fee_models: list(b.fee_models, 3).filter(f => ['retainer', 'hourly', 'success'].includes(f)),
      retainer_from: num(b.retainer_from, 1e6), hourly_rate: num(b.hourly_rate, 1e5), success_pct: num(b.success_pct, 50), updated_at: new Date().toISOString(),
      experience: txt(b.experience, 4000) || null, references_text: txt(b.references_text, 1500) || null
    };
    const li = txt(b.linkedin_url, 200);
    if (li && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/[^\s"'<>]+$/i.test(li)) return res.status(400).json({ error: 'Paste your full LinkedIn profile link (https://www.linkedin.com/in/…), or leave it empty.' });
    row.linkedin_url = li || null;
    const { data, error } = await supabase.from('manager_profiles').upsert([row], { onConflict: 'user_id' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });
  app.post('/api/manager/induction', authMiddleware, async (req, res) => {
    const u = await me(req.user.id);
    if (!u || u.role !== 'virtual_manager') return res.status(403).json({ error: 'Switch to the Virtual Manager role first.' });
    const ans = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
    const score = QUIZ.reduce((s, x, i) => s + (Number(ans[i]) === x.c ? 1 : 0), 0);
    const passed = score >= 8;
    const wrong = QUIZ.map((x, i) => Number(ans[i]) === x.c ? null : i).filter(i => i !== null);
    const { data: ex } = await supabase.from('manager_profiles').select('user_id, induction_passed_at').eq('user_id', req.user.id).maybeSingle();
    const patch = { user_id: req.user.id, induction_score: score, induction_taken_at: new Date().toISOString(), ...(passed && !(ex && ex.induction_passed_at) ? { induction_passed_at: new Date().toISOString() } : {}) };
    await supabase.from('manager_profiles').upsert([patch], { onConflict: 'user_id' });
    res.json({ score, passed, wrong, level: await c.levelOf(req.user.id) });
  });

  // ── Mandates ──
  function readTerms(b, side) {
    const scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter(s => SCOPES[s] && SCOPES[s].sides.includes(side));
    if (!scopes.length) return { error: 'Tick at least one task for the manager.' };
    const title = txt(b.title, 120); if (title.length < 4) return { error: 'Give the mandate a short title, e.g. "Find and buy a food-tech idea".' };
    const focus = txt(b.focus_industry, 60); if (!focus) return { error: 'Choose the industry this is about. A manager can only work for one client per industry.' };
    const retainer = num(b.fee_retainer, 1e6) || 0, hourly = num(b.fee_hourly, 1e5) || 0, pct = num(b.fee_success_pct, 50) || 0;
    const end = b.end_date ? String(b.end_date).slice(0, 10) : null;
    if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { error: 'Check the end date.' };
    if (end && new Date(end) < new Date(new Date().toISOString().slice(0, 10))) return { error: 'The end date is in the past.' };
    return { fields: { title, goals: txt(b.goals, 2000) || null, focus_industry: focus, scopes, fee_retainer: retainer, fee_hourly: hourly, fee_success_pct: pct, budget_limit: num(b.budget_limit, 1e9), end_date: end } };
  }
  app.post('/api/mandates', authMiddleware, async (req, res) => {
    const b = req.body || {}, u = await me(req.user.id);
    let clientId, managerId;
    if (u.role === 'virtual_manager') { clientId = intId(b.client_id); managerId = u.id; }
    else { clientId = u.id; managerId = intId(b.manager_id); }
    if (!clientId || !managerId || clientId === managerId) return res.status(400).json({ error: 'Choose who this mandate is with.' });
    const U = await c.users([clientId, managerId]);
    if (!U[managerId] || U[managerId].role !== 'virtual_manager') return res.status(400).json({ error: 'That person is not an IdeaHub manager.' });
    if (!U[clientId] || !CLIENT_ROLES.includes(U[clientId].role)) return res.status(400).json({ error: 'Managers work for idea creators, investors and businesses.' });
    if (await c.levelOf(managerId) === 'new') return res.status(400).json({ error: 'This manager hasn\'t finished the ID check and induction yet.' });
    const side = SIDES[b.client_side] ? b.client_side : sideOfRole(U[clientId].role);
    const t = readTerms(b, side); if (t.error) return res.status(400).json({ error: t.error });
    const { data: dup } = await supabase.from('mandates').select('id').eq('client_id', clientId).eq('manager_id', managerId).in('status', OPEN_MANDATE).limit(1);
    if (dup && dup.length) return res.status(400).json({ error: 'You already have an open mandate with this person.', id: dup[0].id });
    const conflict = await c.mandateConflict(managerId, clientId, t.fields.focus_industry);
    if (conflict) return res.status(400).json({ error: req.user.id === managerId ? conflict.replace('This manager already works', 'You already work').replace('This manager works', 'You work') : conflict, code: 'conflict' });
    const screen = b.screening === true;
    const { data, error } = await supabase.from('mandates').insert([{ ...t.fields, client_id: clientId, manager_id: managerId, client_side: side, status: 'proposed', proposed_by: req.user.id, source_request_id: intId(b.request_id),
      screen_client: screen && req.user.id === clientId, screen_manager: screen && req.user.id === managerId }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const other = req.user.id === clientId ? managerId : clientId;
    await c.log(data.id, req.user.id, 'proposed', `${fullName(u)} proposed the mandate${screen ? ', with a hiring process (CV, questions and an interview) before agreeing' : ''}.`);
    await escrow.notify(other, { type: 'mandate_proposed', title: '🤝 Mandate proposal', message: `${fullName(u)} proposed "${data.title}". Review the terms and accept or decline.`, link: `/mandate?id=${data.id}` });
    await escrow.emailUser(other, `Mandate proposal: "${data.title}"`, `${escrow.esc(fullName(u))} proposed a mandate`, `Review the tasks and fees for <strong>"${escrow.esc(data.title)}"</strong>, then accept or decline.`, 'Review', `/mandate?id=${data.id}`);
    res.status(201).json(data);
  });
  app.get('/api/mandates', authMiddleware, async (req, res) => {
    const { data } = await supabase.from('mandates').select('*').or(`client_id.eq.${req.user.id},manager_id.eq.${req.user.id}`).order('created_at', { ascending: false }).limit(200);
    const rows = data || [];
    const U = await c.users(rows.flatMap(m => [m.client_id, m.manager_id]));
    const ids = rows.map(m => m.id);
    const [{ data: acts }, { data: bills }] = ids.length ? await Promise.all([
      supabase.from('mandate_actions').select('mandate_id').in('mandate_id', ids).eq('status', 'pending'),
      supabase.from('mandate_bills').select('mandate_id').in('mandate_id', ids).eq('status', 'due')
    ]) : [{ data: [] }, { data: [] }];
    res.json(rows.map(m => ({ ...m, as: m.client_id === req.user.id ? 'client' : 'manager', client: { id: m.client_id, name: fullName(U[m.client_id]), avatar_url: U[m.client_id]?.avatar_url || null }, manager: { id: m.manager_id, name: fullName(U[m.manager_id]), avatar_url: U[m.manager_id]?.avatar_url || null },
      pending_approvals: (acts || []).filter(a => a.mandate_id === m.id).length, bills_due: (bills || []).filter(b => b.mandate_id === m.id).length })));
  });
  app.get('/api/mandates/:id', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || !as) return nf(res);
    const [{ data: actions }, { data: items }, { data: tasks }, { data: hours }, { data: bills }, { data: lg }, { data: deals }, { data: rating }, { data: ventures }] = await Promise.all([
      supabase.from('mandate_actions').select('*').eq('mandate_id', m.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('mandate_items').select('*').eq('mandate_id', m.id).order('updated_at', { ascending: false }).limit(300),
      as === 'client' ? Promise.resolve({ data: [] }) : supabase.from('mandate_tasks').select('*').eq('mandate_id', m.id).order('created_at', { ascending: true }),
      supabase.from('mandate_hours').select('*').eq('mandate_id', m.id).order('work_date', { ascending: false }).limit(200),
      supabase.from('mandate_bills').select('*').eq('mandate_id', m.id).order('created_at', { ascending: false }),
      supabase.from('mandate_log').select('*').eq('mandate_id', m.id).order('created_at', { ascending: false }).limit(150),
      supabase.from('mandate_deals').select('*').eq('mandate_id', m.id).order('created_at', { ascending: false }),
      supabase.from('mandate_ratings').select('stars, review, created_at').eq('mandate_id', m.id).limit(1),
      supabase.from('ventures').select('*').eq('mandate_id', m.id).order('created_at', { ascending: true })
    ]);
    let milestones = [];
    if ((ventures || []).length) { const { data: ml } = await supabase.from('venture_milestones').select('*').in('venture_id', ventures.map(v => v.id)).order('sort', { ascending: true }); milestones = ml || []; }
    const U = await c.users([m.client_id, m.manager_id, ...(lg || []).map(l => l.actor_id)]);
    const person = id => U[id] ? { id, name: fullName(U[id]), avatar_url: U[id].avatar_url || null, role: U[id].role } : null;
    const hiring = await hiringData(m, as, req.user.id);
    res.json({
      ...m, viewer: as, client: person(m.client_id), manager: { ...person(m.manager_id), level: await c.levelOf(m.manager_id), ...(await c.statsOf(m.manager_id)) },
      scope_labels: (m.scopes || []).map(s => ({ key: s, label: (SCOPES[s] || {}).label || s })),
      actions: actions || [], items: as === 'client' ? (items || []).filter(i => i.shared) : (items || []), tasks: tasks || [], hours: hours || [], bills: bills || [],
      log: (lg || []).map(l => ({ ...l, actor: l.actor_id ? fullName(U[l.actor_id]) : 'IdeaHub' })), deals: deals || [], rating: rating && rating[0] ? rating[0] : null,
      ventures: (ventures || []).map(v => ({ ...v, milestones: milestones.filter(x => x.venture_id === v.id) })),
      terms: { version: m.agreement_version || TERMS_VERSION, text: m.agreement_text || TERMS_TEXT, points: TERMS_POINTS },
      fee_rate: FEE_RATE, payments_open: c.payments.purchasesOpen(), can_accept: m.status === 'proposed' && m.proposed_by !== req.user.id && as !== 'admin',
      hiring
    });
  });
  app.post('/api/mandates/:id/accept', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !as) return nf(res);
    if (m.status !== 'proposed' || m.proposed_by === req.user.id || as === 'admin') return res.status(400).json({ error: 'Only the other side can accept this proposal.' });
    if (!(req.body && req.body.agree === true)) return res.status(400).json({ error: 'Please read and accept the mandate terms.' });
    const waitingOn = screeningPending(m);
    if (waitingOn.length) return res.status(400).json({ error: waitingOn.includes(as) ? 'Finish your hiring steps first: tell IdeaHub you are satisfied, or decline.' : `The ${waitingOn[0]} asked for a hiring process and hasn't finished it yet.`, code: 'screening' });
    if (await c.levelOf(m.manager_id) === 'new') return res.status(400).json({ error: 'The manager must finish the ID check and induction first.' });
    const conflict = await c.mandateConflict(m.manager_id, m.client_id, m.focus_industry, m.id);
    if (conflict) return res.status(400).json({ error: conflict, code: 'conflict' });
    const now = new Date();
    const { data: rows } = await supabase.from('mandates').update({ status: 'active', started_at: now.toISOString(), accepted_at: now.toISOString(), agreement_version: TERMS_VERSION, agreement_text: TERMS_TEXT, next_retainer_at: Number(m.fee_retainer) > 0 ? new Date(now.getTime() + RETAINER_DAYS * 86400000).toISOString() : null }).eq('id', m.id).eq('status', 'proposed').select();
    const a = rows && rows[0]; if (!a) return res.status(409).json({ error: 'This proposal changed. Refresh.' });
    await c.log(m.id, req.user.id, 'accepted', `${fullName(u)} accepted the mandate. It is now active.`);
    if (Number(a.fee_retainer) > 0) await c.createBill(a, { kind: 'retainer', description: `Retainer ${now.toISOString().slice(0, 10)} to ${new Date(now.getTime() + RETAINER_DAYS * 86400000).toISOString().slice(0, 10)}`, amount: a.fee_retainer, period_start: now.toISOString(), period_end: new Date(now.getTime() + RETAINER_DAYS * 86400000).toISOString() });
    if (a.source_request_id) {
      await supabase.from('manager_requests').update({ status: 'hired' }).eq('id', a.source_request_id);
      // Other candidates still being considered for the same request: withdraw them politely
      const { data: sib } = await supabase.from('mandates').select('id, manager_id, title').eq('source_request_id', a.source_request_id).eq('status', 'proposed');
      for (const x of (sib || []).filter(x => x.id !== a.id)) {
        await supabase.from('mandates').update({ status: 'cancelled', end_reason: 'The client hired another manager for this request.', ended_at: now.toISOString() }).eq('id', x.id).eq('status', 'proposed');
        await supabase.from('mandate_interviews').update({ status: 'cancelled' }).eq('mandate_id', x.id).in('status', ['proposed', 'scheduled']);
        await c.log(x.id, null, 'cancelled', 'The client hired another manager for this request.');
        await escrow.notify(x.manager_id, { type: 'mandate_declined', title: 'Not chosen this time', message: `The client hired another manager for "${x.title}". Thank you for your time.`, link: `/mandate?id=${x.id}` });
      }
    }
    const other = req.user.id === m.client_id ? m.manager_id : m.client_id;
    await escrow.notify(other, { type: 'mandate_active', title: '✅ Mandate accepted', message: `"${m.title}" is now active.`, link: `/mandate?id=${m.id}` });
    res.json(a);
  });
  app.post('/api/mandates/:id/decline', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !as) return nf(res);
    if (m.status !== 'proposed') return res.status(400).json({ error: 'This mandate is not waiting for an answer.' });
    const mine = m.proposed_by === req.user.id;
    const note = txt(req.body && req.body.note, 500);
    await supabase.from('mandates').update({ status: mine ? 'cancelled' : 'declined', end_reason: note || null, ended_at: new Date().toISOString() }).eq('id', m.id).eq('status', 'proposed');
    await supabase.from('mandate_interviews').update({ status: 'cancelled' }).eq('mandate_id', m.id).in('status', ['proposed', 'scheduled']);
    await c.log(m.id, req.user.id, mine ? 'cancelled' : 'declined', `${fullName(u)} ${mine ? 'withdrew' : 'declined'} the proposal.${note ? ' ' + note : ''}`);
    const other = req.user.id === m.client_id ? m.manager_id : m.client_id;
    await escrow.notify(other, { type: 'mandate_declined', title: mine ? 'Proposal withdrawn' : 'Proposal declined', message: `"${m.title}" was ${mine ? 'withdrawn' : 'declined'}.${note ? ' ' + note : ''}`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandates/:id/end', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !as || as === 'admin') return nf(res);
    if (m.status !== 'active') return res.status(400).json({ error: 'Only an active mandate can be ended.' });
    const reason = txt(req.body && req.body.reason, 500);
    await supabase.from('mandates').update({ status: 'ended', ended_at: new Date().toISOString(), ended_by: req.user.id, end_reason: reason || null, completed_ok: true, next_retainer_at: null }).eq('id', m.id).eq('status', 'active');
    await supabase.from('mandate_actions').update({ status: 'cancelled' }).eq('mandate_id', m.id).eq('status', 'pending');
    await c.log(m.id, req.user.id, 'ended', `${fullName(u)} ended the mandate.${reason ? ' Reason: ' + reason : ''}`);
    const other = req.user.id === m.client_id ? m.manager_id : m.client_id;
    await escrow.notify(other, { type: 'mandate_ended', title: 'Mandate ended', message: `${fullName(u)} ended "${m.title}".${reason ? ' ' + reason : ''}`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandates/:id/rate', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'client') return nf(res);
    if (m.status !== 'ended' && !(m.status === 'active' && m.started_at && Date.now() - new Date(m.started_at) > 30 * 86400000)) return res.status(400).json({ error: 'You can review your manager after 30 days or when the mandate ends.' });
    const stars = parseInt(req.body && req.body.stars, 10);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
    const { data: ex } = await supabase.from('mandate_ratings').select('id').eq('mandate_id', m.id).limit(1);
    if (ex && ex.length) return res.status(400).json({ error: 'You already reviewed this manager.' });
    await supabase.from('mandate_ratings').insert([{ mandate_id: m.id, client_id: m.client_id, manager_id: m.manager_id, stars, review: txt(req.body.review, 1000) || null }]);
    if (stars <= 2) await supabase.from('mandates').update({ completed_ok: false }).eq('id', m.id);
    await escrow.notify(m.manager_id, { type: 'mandate_rated', title: '⭐ New review', message: `Your client left a ${stars}-star review for "${m.title}".`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });

  // ── Approvals: the manager prepares, the client approves, IdeaHub runs it as the client ──
  async function prepare(m, kind, p) {
    const out = { payload: {}, summary: '', amount: null, counterparty: null };
    if (kind === 'purchase') {
      const id = intId(p.idea_id); const { data: i } = id ? await supabase.from('ideas').select('id, title, price, creator_id, status, has_patent, engagements').eq('id', id).single() : { data: null };
      if (!i || i.status !== 'live') return { error: 'That idea is not available to buy.' };
      if (i.has_patent) return { error: 'Patents are not sold through IdeaHub checkout.' };
      const extras = Array.isArray(p.engagements) ? p.engagements.slice(0, 10).map(String) : [];
      out.payload = { idea_id: i.id, engagements: extras }; out.amount = Number(i.price); out.counterparty = i.creator_id;
      out.summary = `Buy "${i.title}" for ${money(i.price)}${extras.length ? ' with extras' : ''} (plus IdeaHub's 8%)`;
    } else if (kind === 'post_request') {
      const title = txt(p.title, 150), problem = txt(p.problem, 3000);
      if (title.length < 8 || problem.length < 30) return { error: 'Give the request a title and describe the problem (30+ characters).' };
      out.payload = { title, problem, industry: txt(p.industry, 60) || null, budget_min: num(p.budget_min), budget_max: num(p.budget_max), deadline: p.deadline ? String(p.deadline).slice(0, 10) : null, requirements: txt(p.requirements, 2000) };
      out.amount = out.payload.budget_max; out.summary = `Post the Idea Request "${title}"${out.payload.budget_max ? ` (budget up to ${money(out.payload.budget_max)})` : ''}`;
    } else if (kind === 'select_proposal') {
      const id = intId(p.proposal_id); const { data: pr } = id ? await supabase.from('idea_proposals').select('id, title, proposed_price, creator_id, request_id').eq('id', id).single() : { data: null };
      if (!pr) return { error: 'Proposal not found.' };
      const { data: rq } = await supabase.from('idea_requests').select('id, investor_id, title').eq('id', pr.request_id).single();
      if (!rq || rq.investor_id !== m.client_id) return { error: 'That proposal is not on your client\'s request.' };
      out.payload = { proposal_id: pr.id, request_id: rq.id }; out.amount = Number(pr.proposed_price) || null; out.counterparty = pr.creator_id;
      out.summary = `Choose the proposal "${pr.title}"${pr.proposed_price ? ` (${money(pr.proposed_price)})` : ''} for "${rq.title}"`;
    } else if (kind === 'proposal') {
      const rid = intId(p.request_id); const { data: rq } = rid ? await supabase.from('idea_requests').select('id, investor_id, title, status').eq('id', rid).single() : { data: null };
      if (!rq || !['open', 'proposals_received'].includes(rq.status)) return { error: 'That request is not taking proposals.' };
      const title = txt(p.title, 150), summary = txt(p.summary, 3000);
      if (title.length < 5 || summary.length < 30) return { error: 'Give the proposal a title and a summary (30+ characters).' };
      out.payload = { request_id: rq.id, title, summary, approach: txt(p.approach, 3000), proposed_price: num(p.proposed_price), delivery_days: intId(p.delivery_days) };
      out.amount = null; out.counterparty = rq.investor_id;
      out.summary = `Send the proposal "${title}"${out.payload.proposed_price ? ` (${money(out.payload.proposed_price)})` : ''} to "${rq.title}"`;
    } else if (kind === 'expansion_apply') {
      const lid = intId(p.listing_id); const { data: l } = lid ? await supabase.from('business_listings').select('id, owner_id, business_name, teaser_title, confidential, status, expansion_types').eq('id', lid).single() : { data: null };
      if (!l || l.status !== 'active') return { error: 'That business is not taking responses.' };
      if (!(l.expansion_types || []).includes(p.expansion_type)) return { error: 'Choose one of the deal types on that listing.' };
      const message = txt(p.message, 3000); if (message.length < 30) return { error: 'Write the introduction (30+ characters).' };
      out.payload = { listing_id: l.id, expansion_type: p.expansion_type, message, investment_capacity: txt(p.investment_capacity, 120), territory: txt(p.territory, 120), background: txt(p.background, 2000) };
      out.counterparty = l.owner_id; out.summary = `Respond to "${l.confidential ? l.teaser_title : l.business_name}" (${String(p.expansion_type).replace(/_/g, ' ')})`;
    } else if (kind === 'hire') {
      const sid = intId(p.support_id); const { data: s } = sid ? await supabase.from('users').select('id, role, first_name, last_name').eq('id', sid).single() : { data: null };
      if (!s || !['patent_attorney', 'chartered_accountant', 'corporate_services'].includes(s.role)) return { error: 'Choose an attorney, accountant or corporate services provider.' };
      const title = txt(p.title, 150), description = txt(p.description, 3000);
      if (title.length < 5 || description.length < 20) return { error: 'Give the job a title and describe it (20+ characters).' };
      out.payload = { support_id: s.id, title, description }; out.counterparty = s.id;
      out.summary = `Ask ${fullName(s)} for a quote: "${title}"`;
    } else return { error: 'Unknown step.' };
    return out;
  }
  app.post('/api/mandates/:id/actions', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (m.status !== 'active') return res.status(400).json({ error: 'The mandate is not active.' });
    const kind = req.body && req.body.kind, def = ACTIONS[kind];
    if (!def) return res.status(400).json({ error: 'Choose what to prepare.' });
    if (!has(m, def.scope)) return res.status(403).json({ error: 'This mandate doesn\'t include that task.' });
    const p = await prepare(m, kind, (req.body && req.body.payload) || {});
    if (p.error) return res.status(400).json({ error: p.error });
    if (p.counterparty && p.counterparty === m.manager_id) return res.status(400).json({ error: 'You can\'t prepare a deal with yourself for a client.' });
    if (p.counterparty && await c.isClientOf(m.manager_id, p.counterparty, m.id)) return res.status(400).json({ error: 'You also manage the other side of this deal. A manager can only act for one side.', code: 'conflict' });
    if (m.budget_limit && p.amount && p.amount > Number(m.budget_limit)) return res.status(400).json({ error: `This is above the mandate's budget limit of ${money(m.budget_limit)}.` });
    const { data, error } = await supabase.from('mandate_actions').insert([{ mandate_id: m.id, kind, payload: p.payload, summary: p.summary, amount: p.amount, note: txt(req.body.note, 1000) || null, status: 'pending', created_by: req.user.id }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await c.log(m.id, req.user.id, 'prepared', `Prepared for approval: ${p.summary}`);
    await escrow.notify(m.client_id, { type: 'mandate_approval', title: '✋ Your approval is needed', message: `Your manager prepared: ${p.summary}.`, link: `/mandate?id=${m.id}` });
    await escrow.emailUser(m.client_id, 'Your approval is needed', 'Your manager prepared a step for you', `${escrow.esc(p.summary)}.${data.note ? '<br><br>Note: ' + escrow.esc(data.note) : ''}<br><br>Nothing happens until you approve it.`, 'Review', `/mandate?id=${m.id}`);
    res.status(201).json(data);
  });
  app.post('/api/mandate-actions/:aid/decide', authMiddleware, async (req, res) => {
    const { data: a } = await supabase.from('mandate_actions').select('*').eq('id', intId(req.params.aid)).single();
    if (!a) return nf(res);
    const m = await loadMandate(a.mandate_id);
    if (!m || m.client_id !== req.user.id) return nf(res);
    if (a.status !== 'pending') return res.status(400).json({ error: 'This step was already decided.' });
    if (m.status !== 'active') return res.status(400).json({ error: 'The mandate is not active.' });
    const decision = req.body && req.body.decision;
    if (decision === 'decline') {
      await supabase.from('mandate_actions').update({ status: 'declined', decided_at: new Date().toISOString(), decision_note: txt(req.body.note, 500) || null }).eq('id', a.id).eq('status', 'pending');
      await c.log(m.id, req.user.id, 'declined', `Client declined: ${a.summary}`);
      await escrow.notify(m.manager_id, { type: 'mandate_declined_step', title: 'Step declined', message: `Your client declined: ${a.summary}.${req.body.note ? ' ' + txt(req.body.note, 200) : ''}`, link: `/mandate?id=${m.id}` });
      return res.json({ ok: true });
    }
    if (decision !== 'approve') return res.status(400).json({ error: 'Approve or decline.' });
    // Lock it first so a double click can't run it twice
    const { data: lock } = await supabase.from('mandate_actions').update({ status: 'running' }).eq('id', a.id).eq('status', 'pending').select();
    if (!lock || !lock.length) return res.status(409).json({ error: 'This step is already being processed.' });
    const p = a.payload || {};
    const ideaTerms = require('./public/idea-terms');
    let r, deal = null;
    if (a.kind === 'purchase') {
      if (req.body.agreement !== ideaTerms.VERSION) { await supabase.from('mandate_actions').update({ status: 'pending' }).eq('id', a.id); return res.status(400).json({ error: 'Please read and accept the Idea Transfer Agreement.', code: 'agreement_required' }); }
      r = await callAs(m.client_id, 'POST', '/api/transactions', { ideaId: p.idea_id, paymentMethod: 'card', engagements: p.engagements || [], agreement: ideaTerms.VERSION });
      if (r.ok) deal = { kind: 'purchase', ref_id: r.data.id, value: r.data.amount };
    } else if (a.kind === 'post_request') {
      r = await callAs(m.client_id, 'POST', '/api/requests', p);
    } else if (a.kind === 'select_proposal') {
      r = await callAs(m.client_id, 'PUT', `/api/proposals/${p.proposal_id}/status`, { status: 'selected' });
      if (r.ok) deal = { kind: 'request', ref_id: p.request_id, value: a.amount };
    } else if (a.kind === 'proposal') {
      r = await callAs(m.client_id, 'POST', `/api/requests/${p.request_id}/proposals`, p);
    } else if (a.kind === 'expansion_apply') {
      r = await callAs(m.client_id, 'POST', `/api/businesses/${p.listing_id}/apply`, p);
      if (r.ok) deal = { kind: 'expansion', ref_id: r.data.id, value: null };
    } else if (a.kind === 'hire') {
      r = await callAs(m.client_id, 'POST', '/api/hire', p);
      if (r.ok) deal = { kind: 'hire', ref_id: r.data.id, value: null };
    }
    const now = new Date().toISOString();
    if (!r || !r.ok) {
      await supabase.from('mandate_actions').update({ status: 'failed', decided_at: now, result: { error: r ? r.error : 'Failed' } }).eq('id', a.id);
      await c.log(m.id, req.user.id, 'failed', `Approved but could not complete: ${a.summary}. ${r ? r.error : ''}`);
      await escrow.notify(m.manager_id, { type: 'mandate_failed', title: '⚠️ Approved step failed', message: `${a.summary}: ${r ? r.error : 'failed'}`, link: `/mandate?id=${m.id}` });
      return res.status(400).json({ error: r ? r.error : 'Could not complete.' });
    }
    const ref = r.data && r.data.id ? r.data.id : null;
    await supabase.from('mandate_actions').update({ status: 'approved', decided_at: now, result: { id: ref }, ref_id: ref }).eq('id', a.id);
    if (deal && deal.ref_id) await supabase.from('mandate_deals').insert([{ mandate_id: m.id, manager_id: m.manager_id, client_id: m.client_id, kind: deal.kind, ref_id: deal.ref_id, value: deal.value, status: ['purchase', 'request'].includes(deal.kind) ? 'open' : 'recorded', source: 'approved' }]);
    await c.log(m.id, req.user.id, 'approved', `Client approved: ${a.summary}`);
    await escrow.notify(m.manager_id, { type: 'mandate_approved', title: '👍 Step approved', message: `Your client approved: ${a.summary}.`, link: `/mandate?id=${m.id}` });
    const links = { purchase: '/transactions', post_request: ref ? `/request/${ref}` : '/idea-requests', select_proposal: `/request/${p.request_id}`, proposal: `/request/${p.request_id}`, expansion_apply: ref ? `/expansion?id=${ref}` : '/expansion', hire: ref ? `/hire?id=${ref}` : '/hire' };
    res.json({ ok: true, ref, link: links[a.kind] });
  });
  app.post('/api/mandate-actions/:aid/cancel', authMiddleware, async (req, res) => {
    const { data: a } = await supabase.from('mandate_actions').select('*').eq('id', intId(req.params.aid)).single();
    const m = a && await loadMandate(a.mandate_id);
    if (!a || !m || m.manager_id !== req.user.id) return nf(res);
    const { data: rows } = await supabase.from('mandate_actions').update({ status: 'cancelled', decided_at: new Date().toISOString() }).eq('id', a.id).eq('status', 'pending').select();
    if (!rows || !rows.length) return res.status(400).json({ error: 'Only a waiting step can be withdrawn.' });
    await c.log(m.id, req.user.id, 'withdrawn', `Manager withdrew: ${a.summary}`);
    res.json({ ok: true });
  });

  // The client's open Idea Requests and their proposals (so the manager can pick one to recommend)
  app.get('/api/mandates/:id/client-requests', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (!has(m, 'requests')) return res.status(403).json({ error: 'This mandate doesn\'t include Idea Requests.' });
    const { data: rqs } = await supabase.from('idea_requests').select('id, title, status, budget_max').eq('investor_id', m.client_id).in('status', ['open', 'proposals_received', 'shortlisting', 'pitching']).order('created_at', { ascending: false }).limit(30);
    const ids = (rqs || []).map(r => r.id);
    const { data: ps } = ids.length ? await supabase.from('idea_proposals').select('id, request_id, title, proposed_price, creator_id, status').in('request_id', ids) : { data: [] };
    const U = await c.users((ps || []).map(p => p.creator_id));
    res.json((rqs || []).map(r => ({ ...r, proposals: (ps || []).filter(p => p.request_id === r.id && p.status !== 'rejected').map(p => ({ id: p.id, title: p.title, price: p.proposed_price, creator: fullName(U[p.creator_id]), creator_id: p.creator_id })) })));
  });

  // ── Pipeline items (shared ones are recommendations to the client) ──
  const ITEM_KINDS = ['idea', 'request', 'business', 'contact', 'other'];
  const STAGES = ['sourcing', 'contacted', 'negotiating', 'approval', 'closed', 'dropped'];
  async function itemRef(kind, ref) {
    const id = intId(ref); if (!id) return { id: null };
    if (kind === 'idea') { const { data } = await supabase.from('ideas').select('id, title, creator_id, status').eq('id', id).single(); return data ? { id, title: data.title, party: data.creator_id, ok: data.status === 'live' } : { error: 'Idea not found.' }; }
    if (kind === 'request') { const { data } = await supabase.from('idea_requests').select('id, title, investor_id').eq('id', id).single(); return data ? { id, title: data.title, party: data.investor_id, ok: true } : { error: 'Request not found.' }; }
    if (kind === 'business') { const { data } = await supabase.from('business_listings').select('id, business_name, teaser_title, confidential, owner_id, status').eq('id', id).single(); return data ? { id, title: data.confidential ? data.teaser_title : data.business_name, party: data.owner_id, ok: data.status === 'active' } : { error: 'Listing not found.' }; }
    if (kind === 'contact') { const { data } = await supabase.from('users').select('id, first_name, last_name').eq('id', id).single(); return data ? { id, title: fullName(data), party: data.id, ok: true } : { error: 'Member not found.' }; }
    return { id: null };
  }
  app.post('/api/mandates/:id/items', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (m.status !== 'active') return res.status(400).json({ error: 'The mandate is not active.' });
    const b = req.body || {};
    const kind = ITEM_KINDS.includes(b.kind) ? b.kind : 'other';
    const ref = await itemRef(kind, b.ref_id);
    if (ref.error) return res.status(400).json({ error: ref.error });
    if (ref.party && ref.party === m.client_id) return res.status(400).json({ error: 'That belongs to your client.' });
    if (ref.party && await c.isClientOf(m.manager_id, ref.party, m.id)) return res.status(400).json({ error: 'That belongs to another of your clients. A manager can only act for one side.', code: 'conflict' });
    const title = txt(b.title, 150) || ref.title; if (!title) return res.status(400).json({ error: 'Give it a name.' });
    const { data, error } = await supabase.from('mandate_items').insert([{ mandate_id: m.id, kind, ref_id: ref.id || null, title, note: txt(b.note, 1500) || null, stage: STAGES.includes(b.stage) ? b.stage : 'sourcing', shared: !!b.shared, updated_at: new Date().toISOString() }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (data.shared) await shareNotice(m, data);
    res.status(201).json(data);
  });
  async function shareNotice(m, it) {
    await c.log(m.id, m.manager_id, 'recommended', `Recommended: ${it.title}`);
    await escrow.notify(m.client_id, { type: 'mandate_reco', title: '⭐ New recommendation', message: `Your manager recommends: ${it.title}`, link: `/mandate?id=${m.id}` });
  }
  app.put('/api/mandate-items/:iid', authMiddleware, async (req, res) => {
    const { data: it } = await supabase.from('mandate_items').select('*').eq('id', intId(req.params.iid)).single();
    const m = it && await loadMandate(it.mandate_id);
    if (!it || !m || m.manager_id !== req.user.id) return nf(res);
    const b = req.body || {}, patch = { updated_at: new Date().toISOString() };
    if (STAGES.includes(b.stage)) patch.stage = b.stage;
    if (b.note !== undefined) patch.note = txt(b.note, 1500) || null;
    if (b.title !== undefined && txt(b.title, 150)) patch.title = txt(b.title, 150);
    if (b.shared !== undefined) patch.shared = !!b.shared;
    const { data } = await supabase.from('mandate_items').update(patch).eq('id', it.id).select().single();
    if (patch.shared && !it.shared) await shareNotice(m, data);
    res.json(data);
  });
  app.delete('/api/mandate-items/:iid', authMiddleware, async (req, res) => {
    const { data: it } = await supabase.from('mandate_items').select('*').eq('id', intId(req.params.iid)).single();
    const m = it && await loadMandate(it.mandate_id);
    if (!it || !m || m.manager_id !== req.user.id) return nf(res);
    await supabase.from('mandate_items').delete().eq('id', it.id);
    res.json({ ok: true });
  });
  app.post('/api/mandate-items/:iid/feedback', authMiddleware, async (req, res) => {
    const { data: it } = await supabase.from('mandate_items').select('*').eq('id', intId(req.params.iid)).single();
    const m = it && await loadMandate(it.mandate_id);
    if (!it || !m || m.client_id !== req.user.id || !it.shared) return nf(res);
    const fb = ['interested', 'not_interested'].includes(req.body && req.body.feedback) ? req.body.feedback : null;
    const { data } = await supabase.from('mandate_items').update({ client_feedback: fb, client_note: txt(req.body && req.body.note, 500) || null, updated_at: new Date().toISOString() }).eq('id', it.id).select().single();
    await escrow.notify(m.manager_id, { type: 'mandate_feedback', title: fb === 'interested' ? '👍 Client is interested' : 'Client feedback', message: `${it.title}: ${fb === 'interested' ? 'interested' : 'not interested'}${data.client_note ? ' — ' + data.client_note : ''}`, link: `/mandate?id=${m.id}` });
    await c.log(m.id, req.user.id, 'feedback', `Client ${fb === 'interested' ? 'is interested in' : 'passed on'}: ${it.title}`);
    res.json(data);
  });

  // ── Tasks (manager only) ──
  app.post('/api/mandates/:id/tasks', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    const title = txt(req.body && req.body.title, 200); if (!title) return res.status(400).json({ error: 'Write the task.' });
    const due = req.body.due_date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date) ? req.body.due_date : null;
    const { data } = await supabase.from('mandate_tasks').insert([{ mandate_id: m.id, title, due_date: due, done: false }]).select().single();
    res.status(201).json(data);
  });
  app.put('/api/mandate-tasks/:tid', authMiddleware, async (req, res) => {
    const { data: t } = await supabase.from('mandate_tasks').select('*').eq('id', intId(req.params.tid)).single();
    const m = t && await loadMandate(t.mandate_id); if (!t || !m || m.manager_id !== req.user.id) return nf(res);
    const patch = {}; if (req.body.done !== undefined) patch.done = !!req.body.done; if (req.body.title) patch.title = txt(req.body.title, 200);
    const { data } = await supabase.from('mandate_tasks').update(patch).eq('id', t.id).select().single();
    res.json(data);
  });
  app.delete('/api/mandate-tasks/:tid', authMiddleware, async (req, res) => {
    const { data: t } = await supabase.from('mandate_tasks').select('*').eq('id', intId(req.params.tid)).single();
    const m = t && await loadMandate(t.mandate_id); if (!t || !m || m.manager_id !== req.user.id) return nf(res);
    await supabase.from('mandate_tasks').delete().eq('id', t.id); res.json({ ok: true });
  });

  // ── Hours ──
  app.post('/api/mandates/:id/hours', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (m.status !== 'active') return res.status(400).json({ error: 'The mandate is not active.' });
    if (!(Number(m.fee_hourly) > 0)) return res.status(400).json({ error: 'This mandate has no hourly rate.' });
    const hours = num(req.body && req.body.hours, 24); const d = String(req.body.work_date || '').slice(0, 10);
    const description = txt(req.body.description, 500);
    if (!(hours > 0)) return res.status(400).json({ error: 'Enter the hours (up to 24 per entry).' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d) > new Date()) return res.status(400).json({ error: 'Choose the date you worked (not in the future).' });
    if (description.length < 5) return res.status(400).json({ error: 'Describe what you did.' });
    const { data } = await supabase.from('mandate_hours').insert([{ mandate_id: m.id, work_date: d, hours, description, status: 'submitted' }]).select().single();
    res.status(201).json(data);
  });
  app.delete('/api/mandate-hours/:hid', authMiddleware, async (req, res) => {
    const { data: h } = await supabase.from('mandate_hours').select('*').eq('id', intId(req.params.hid)).single();
    const m = h && await loadMandate(h.mandate_id); if (!h || !m || m.manager_id !== req.user.id || h.status !== 'submitted') return nf(res);
    await supabase.from('mandate_hours').delete().eq('id', h.id); res.json({ ok: true });
  });
  app.post('/api/mandates/:id/hours/send', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    const { data: hs } = await supabase.from('mandate_hours').select('*').eq('mandate_id', m.id).eq('status', 'submitted');
    if (!(hs || []).length) return res.status(400).json({ error: 'No hours to send.' });
    await c.log(m.id, req.user.id, 'timesheet', `Manager sent ${hs.reduce((s, h) => s + Number(h.hours), 0)} hours for approval.`);
    await escrow.notify(m.client_id, { type: 'mandate_hours', title: '⏱️ Timesheet to approve', message: `Your manager logged ${hs.reduce((s, h) => s + Number(h.hours), 0)} hours on "${m.title}".`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandates/:id/hours/approve', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'client') return nf(res);
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(intId).filter(Boolean);
    const { data: hs } = ids.length ? await supabase.from('mandate_hours').select('*').eq('mandate_id', m.id).eq('status', 'submitted').in('id', ids) : { data: [] };
    if (!(hs || []).length) return res.status(400).json({ error: 'Choose the hours to approve.' });
    const total = hs.reduce((s, h) => s + Number(h.hours), 0);
    const bill = await c.createBill(m, { kind: 'hours', description: `${total} hours at ${money(m.fee_hourly)}/hour`, amount: total * Number(m.fee_hourly) });
    await supabase.from('mandate_hours').update({ status: 'approved', bill_id: bill ? bill.id : null }).in('id', hs.map(h => h.id));
    await c.log(m.id, req.user.id, 'hours_ok', `Client approved ${total} hours.`);
    res.json({ ok: true, bill });
  });
  app.post('/api/mandates/:id/hours/reject', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'client') return nf(res);
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(intId).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Choose the hours.' });
    await supabase.from('mandate_hours').update({ status: 'rejected', reject_note: txt(req.body.note, 300) || null }).eq('mandate_id', m.id).eq('status', 'submitted').in('id', ids);
    await escrow.notify(m.manager_id, { type: 'mandate_hours', title: 'Hours not approved', message: `Your client didn't approve some hours on "${m.title}".${req.body.note ? ' ' + txt(req.body.note, 150) : ''}`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });

  // ── Bills: one-off fee request, pay, release early, dispute ──
  app.post('/api/mandates/:id/bills', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (!['active', 'ended'].includes(m.status)) return res.status(400).json({ error: 'The mandate is not active.' });
    const amount = num(req.body && req.body.amount, 1e7), description = txt(req.body && req.body.description, 200);
    if (!(amount >= 1) || description.length < 5) return res.status(400).json({ error: 'Enter the amount and what it is for.' });
    const b = await c.createBill(m, { kind: 'oneoff', description, amount });
    res.status(201).json(b);
  });
  async function billAccess(req) {
    const { data: b } = await supabase.from('mandate_bills').select('*').eq('id', intId(req.params.bid)).single();
    if (!b) return {};
    const m = await loadMandate(b.mandate_id);
    const as = b.client_id === req.user.id ? 'client' : b.manager_id === req.user.id ? 'manager' : null;
    return { b, m, as };
  }
  app.post('/api/mandate-bills/:bid/pay', authMiddleware, async (req, res) => {
    const { b, m, as } = await billAccess(req); if (!b || as !== 'client') return nf(res);
    if (b.status !== 'due') return res.status(400).json({ error: 'This fee is not waiting for payment.' });
    if (Number(req.body && req.body.expected_total) !== Number(b.total)) return res.status(409).json({ error: 'The amount changed. Refresh to see it.' });
    if (!c.payments.purchasesOpen()) return res.status(403).json({ error: 'Online payments are launching soon.', code: 'payments_closed' });
    const now = new Date();
    // Retainers are held to the end of the period; milestone fees until approved; hours, success and one-off fees go to the manager at once
    const holds = ['retainer', 'milestone'].includes(b.kind);
    const { data: rows } = await supabase.from('mandate_bills').update({ status: 'paid', paid_at: now.toISOString(), release_at: b.kind === 'milestone' ? null : null }).eq('id', b.id).eq('status', 'due').select();
    if (!rows || !rows.length) return res.status(409).json({ error: 'Already paid.' });
    const charge = await c.payments.chargeService({ userId: req.user.id, amount: b.total, meta: { mandate_bill_id: b.id, mandate_id: b.mandate_id } });
    if (!charge.ok) { await supabase.from('mandate_bills').update({ status: 'due', paid_at: null }).eq('id', b.id); return res.status(402).json({ error: charge.error || 'Payment failed.' }); }
    await c.log(b.mandate_id, req.user.id, 'paid', `Client paid ${c.kindLabel(b.kind).toLowerCase()} ${money(b.amount)}${holds ? ' into escrow' : ''}.`);
    if (b.kind === 'milestone') await supabase.from('venture_milestones').update({ status: 'funded', funded_at: now.toISOString() }).eq('bill_id', b.id).eq('status', 'planned');
    if (!holds) await c.releaseBill(b.id, 'client');
    else await escrow.notify(b.manager_id, { type: 'mandate_paid', title: '💰 Client paid into escrow', message: `${c.kindLabel(b.kind)} of ${money(b.amount)} for "${m.title}" is held in escrow.`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandate-bills/:bid/release', authMiddleware, async (req, res) => {
    const { b, as } = await billAccess(req); if (!b || as !== 'client') return nf(res);
    if (b.status !== 'paid' || b.kind === 'milestone') return res.status(400).json({ error: 'Nothing to release here.' });
    const r = await c.releaseBill(b.id, 'client'); res.json({ ok: !!r });
  });
  app.post('/api/mandate-bills/:bid/cancel', authMiddleware, async (req, res) => {
    const { b, as } = await billAccess(req); if (!b || !as) return nf(res);
    if (b.status !== 'due' || (as === 'client' && !['oneoff'].includes(b.kind))) return res.status(400).json({ error: as === 'client' ? 'Talk to your manager, or report a problem.' : 'Only an unpaid fee can be withdrawn.' });
    await supabase.from('mandate_bills').update({ status: 'cancelled' }).eq('id', b.id).eq('status', 'due');
    await c.log(b.mandate_id, req.user.id, 'bill_cancelled', `${c.kindLabel(b.kind)} ${money(b.amount)} ${as === 'client' ? 'declined by the client' : 'withdrawn by the manager'}.`);
    await escrow.notify(as === 'client' ? b.manager_id : b.client_id, { type: 'mandate_bill', title: as === 'client' ? 'Fee declined' : 'Fee withdrawn', message: `${c.kindLabel(b.kind)} of ${money(b.amount)} was ${as === 'client' ? 'declined' : 'withdrawn'}.`, link: `/mandate?id=${b.mandate_id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandate-bills/:bid/dispute', authMiddleware, async (req, res) => {
    const { b, m, as } = await billAccess(req); if (!b || as !== 'client') return nf(res);
    if (b.status !== 'paid') return res.status(400).json({ error: 'Only a paid fee that is still held can be disputed.' });
    const reason = txt(req.body && req.body.reason, 1500); if (reason.length < 15) return res.status(400).json({ error: 'Explain the problem (15+ characters).' });
    await supabase.from('mandate_bills').update({ status: 'disputed', dispute_reason: reason, disputed_at: new Date().toISOString() }).eq('id', b.id).eq('status', 'paid');
    await c.log(b.mandate_id, req.user.id, 'disputed', `Client reported a problem with ${c.kindLabel(b.kind).toLowerCase()} ${money(b.amount)}: ${reason}`);
    await escrow.notify(b.manager_id, { type: 'disputed', title: '⚠️ Client reported a problem', message: `${c.kindLabel(b.kind)} for "${m.title}" is on hold while IdeaHub reviews it.`, link: `/mandate?id=${m.id}` });
    for (const a of await c.admins()) await escrow.notify(a, { type: 'disputed', title: '⚠️ Manager fee dispute', message: `${c.kindLabel(b.kind)} ${money(b.amount)} on "${m.title}": ${reason.slice(0, 120)}`, link: '/admin' });
    res.json({ ok: true });
  });
  app.get('/api/admin/manager-bills', authMiddleware, async (req, res) => {
    const u = await me(req.user.id); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    const { data: disputed } = await supabase.from('mandate_bills').select('*').eq('status', 'disputed').order('disputed_at', { ascending: true });
    const { data: due } = await supabase.from('mandate_bills').select('*').eq('status', 'due').lte('created_at', new Date(Date.now() - 14 * 86400000).toISOString());
    const all = [...(disputed || []), ...(due || [])];
    const U = await c.users(all.flatMap(b => [b.client_id, b.manager_id]));
    const ms = all.length ? (await supabase.from('mandates').select('id, title').in('id', [...new Set(all.map(b => b.mandate_id))])).data || [] : [];
    const T = Object.fromEntries(ms.map(m => [m.id, m.title]));
    const shape = b => ({ ...b, mandate_title: T[b.mandate_id] || '', client: fullName(U[b.client_id]), manager: fullName(U[b.manager_id]), kind_label: c.kindLabel(b.kind) });
    res.json({ disputed: (disputed || []).map(shape), overdue: (due || []).map(shape) });
  });
  app.put('/api/admin/mandate-bills/:bid/resolve', authMiddleware, async (req, res) => {
    const u = await me(req.user.id); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    const action = req.body && req.body.action, note = txt(req.body && req.body.note, 500);
    const r = action === 'release' ? await c.releaseBill(intId(req.params.bid), 'admin', note) : action === 'refund' ? await c.refundBill(intId(req.params.bid), note) : null;
    if (!r) return res.status(400).json({ error: 'Choose release or refund (only held or disputed fees).' });
    res.json({ ok: true });
  });

  // ── Managed ventures ──
  function readMilestones(list) {
    if (!Array.isArray(list) || !list.length) return { error: 'Add at least one milestone.' };
    const out = [];
    for (const [i, x] of list.slice(0, 20).entries()) {
      const title = txt(x && x.title, 120); if (title.length < 3) return { error: `Give milestone ${i + 1} a title.` };
      const fee = num(x.fee, 1e7) || 0;
      const due = x.due_date && /^\d{4}-\d{2}-\d{2}$/.test(x.due_date) ? x.due_date : null;
      out.push({ title, description: txt(x.description, 1500) || null, fee, due_date: due, sort: i });
    }
    return { value: out };
  }
  app.post('/api/mandates/:id/ventures', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (m.status !== 'active' || !has(m, 'venture')) return res.status(403).json({ error: 'This mandate doesn\'t include a managed venture.' });
    if (!['verified', 'senior'].includes(await c.levelOf(m.manager_id))) return res.status(403).json({ error: 'Managed ventures need the Verified level (ID + proof of address checked).' });
    const title = txt(req.body && req.body.title, 150), plan = txt(req.body && req.body.plan, 5000);
    if (title.length < 4 || plan.length < 50) return res.status(400).json({ error: 'Give the venture a name and describe the plan (50+ characters).' });
    const ms = readMilestones(req.body.milestones); if (ms.error) return res.status(400).json({ error: ms.error });
    const { data: v, error } = await supabase.from('ventures').insert([{ mandate_id: m.id, title, plan, status: 'planning', budget_note: txt(req.body.budget_note, 1000) || null }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('venture_milestones').insert(ms.value.map(x => ({ ...x, venture_id: v.id, status: 'planned' })));
    await c.log(m.id, req.user.id, 'venture', `Manager proposed the venture plan "${title}" with ${ms.value.length} milestones.`);
    await escrow.notify(m.client_id, { type: 'venture', title: '🚀 Venture plan to review', message: `Your manager proposed "${title}". Review the plan and milestones.`, link: `/mandate?id=${m.id}` });
    res.status(201).json(v);
  });
  async function ventureAccess(req, vid) {
    const { data: v } = await supabase.from('ventures').select('*').eq('id', intId(vid)).single(); if (!v) return {};
    const m = await loadMandate(v.mandate_id); if (!m) return {};
    return { v, m, as: m.client_id === req.user.id ? 'client' : m.manager_id === req.user.id ? 'manager' : null };
  }
  app.put('/api/ventures/:vid', authMiddleware, async (req, res) => {
    const { v, m, as } = await ventureAccess(req, req.params.vid); if (!v || as !== 'manager') return nf(res);
    if (v.status !== 'planning') return res.status(400).json({ error: 'The plan was approved; add milestones instead.' });
    const title = txt(req.body.title, 150) || v.title, plan = txt(req.body.plan, 5000) || v.plan;
    if (req.body.milestones) {
      const ms = readMilestones(req.body.milestones); if (ms.error) return res.status(400).json({ error: ms.error });
      await supabase.from('venture_milestones').delete().eq('venture_id', v.id);
      await supabase.from('venture_milestones').insert(ms.value.map(x => ({ ...x, venture_id: v.id, status: 'planned' })));
    }
    await supabase.from('ventures').update({ title, plan, updated_at: new Date().toISOString() }).eq('id', v.id);
    await c.log(m.id, req.user.id, 'venture', `Manager updated the venture plan "${title}".`);
    res.json({ ok: true });
  });
  app.post('/api/ventures/:vid/approve', authMiddleware, async (req, res) => {
    const { v, m, as } = await ventureAccess(req, req.params.vid); if (!v || as !== 'client') return nf(res);
    if (v.status !== 'planning') return res.status(400).json({ error: 'This plan is not waiting for approval.' });
    await supabase.from('ventures').update({ status: 'active', approved_at: new Date().toISOString() }).eq('id', v.id);
    await c.log(m.id, req.user.id, 'venture', `Client approved the venture plan "${v.title}".`);
    await escrow.notify(m.manager_id, { type: 'venture', title: '🚀 Venture approved', message: `"${v.title}" is approved. The client funds each milestone as you start it.`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/ventures/:vid/milestones', authMiddleware, async (req, res) => {
    const { v, m, as } = await ventureAccess(req, req.params.vid); if (!v || as !== 'manager') return nf(res);
    if (v.status !== 'active') return res.status(400).json({ error: 'The venture is not active.' });
    const ms = readMilestones([req.body]); if (ms.error) return res.status(400).json({ error: ms.error });
    const { data: last } = await supabase.from('venture_milestones').select('sort').eq('venture_id', v.id).order('sort', { ascending: false }).limit(1);
    const { data } = await supabase.from('venture_milestones').insert([{ ...ms.value[0], sort: (last && last[0] ? last[0].sort : 0) + 1, venture_id: v.id, status: 'proposed' }]).select().single();
    await c.log(m.id, req.user.id, 'venture', `Manager proposed a new milestone: ${data.title}${data.fee ? ` (${money(data.fee)})` : ''}.`);
    await escrow.notify(m.client_id, { type: 'venture', title: 'New milestone proposed', message: `${data.title}${data.fee ? ` (${money(data.fee)})` : ''} on "${v.title}".`, link: `/mandate?id=${m.id}` });
    res.status(201).json(data);
  });
  async function msAccess(req) {
    const { data: x } = await supabase.from('venture_milestones').select('*').eq('id', intId(req.params.mid)).single(); if (!x) return {};
    const r = await ventureAccess(req, x.venture_id); return { ...r, x };
  }
  // Client: accept a proposed milestone, or start (fund) a planned one
  app.post('/api/milestones/:mid/fund', authMiddleware, async (req, res) => {
    const { x, v, m, as } = await msAccess(req); if (!x || as !== 'client') return nf(res);
    if (v.status !== 'active') return res.status(400).json({ error: 'Approve the venture plan first.' });
    if (!['planned', 'proposed'].includes(x.status)) return res.status(400).json({ error: 'This milestone is already started.' });
    if (!(Number(x.fee) > 0)) {
      await supabase.from('venture_milestones').update({ status: 'funded', funded_at: new Date().toISOString() }).eq('id', x.id);
      await c.log(m.id, req.user.id, 'milestone', `Client started milestone "${x.title}" (no fee).`);
      await escrow.notify(m.manager_id, { type: 'venture', title: '▶️ Milestone started', message: `"${x.title}" on "${v.title}" can start.`, link: `/mandate?id=${m.id}` });
      return res.json({ ok: true });
    }
    let bill = x.bill_id ? (await supabase.from('mandate_bills').select('*').eq('id', x.bill_id).single()).data : null;
    if (!bill) {
      bill = await c.createBill(m, { kind: 'milestone', description: `Milestone "${x.title}" — ${v.title}`, amount: x.fee });
      await supabase.from('venture_milestones').update({ bill_id: bill.id, status: 'planned' }).eq('id', x.id);
    }
    res.json({ ok: true, bill, pay: true });
  });
  app.post('/api/milestones/:mid/submit', authMiddleware, async (req, res) => {
    const { x, v, m, as } = await msAccess(req); if (!x || as !== 'manager') return nf(res);
    if (!['funded', 'changes'].includes(x.status)) return res.status(400).json({ error: 'The client starts (funds) a milestone before you submit it.' });
    const evidence = txt(req.body && req.body.evidence, 3000); if (evidence.length < 20) return res.status(400).json({ error: 'Describe what was done and where the proof is (20+ characters).' });
    const now = new Date();
    await supabase.from('venture_milestones').update({ status: 'submitted', evidence, submitted_at: now.toISOString() }).eq('id', x.id);
    if (x.bill_id) await supabase.from('mandate_bills').update({ release_at: new Date(now.getTime() + AUTO_RELEASE_DAYS * 86400000).toISOString() }).eq('id', x.bill_id).eq('status', 'paid');
    await c.log(m.id, req.user.id, 'milestone', `Manager submitted milestone "${x.title}".`);
    await escrow.notify(m.client_id, { type: 'venture', title: '📦 Milestone submitted', message: `"${x.title}" is ready for your review. Approve it, or ask for changes within ${AUTO_RELEASE_DAYS} days.`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/milestones/:mid/approve', authMiddleware, async (req, res) => {
    const { x, v, m, as } = await msAccess(req); if (!x || as !== 'client') return nf(res);
    if (x.status !== 'submitted') return res.status(400).json({ error: 'This milestone is not waiting for review.' });
    const now = new Date().toISOString();
    await supabase.from('venture_milestones').update({ status: 'approved', approved_at: now }).eq('id', x.id);
    if (x.bill_id) await c.releaseBill(x.bill_id, 'client');
    await c.log(m.id, req.user.id, 'milestone', `Client approved milestone "${x.title}".`);
    const { data: rest } = await supabase.from('venture_milestones').select('status').eq('venture_id', v.id);
    if ((rest || []).every(r => r.status === 'approved')) { await supabase.from('ventures').update({ status: 'completed', completed_at: now }).eq('id', v.id); await c.log(m.id, null, 'venture', `Venture "${v.title}" completed: every milestone approved.`); }
    await escrow.notify(m.manager_id, { type: 'venture', title: '✅ Milestone approved', message: `"${x.title}" was approved${x.fee ? ` and ${money(x.fee)} released to you` : ''}.`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/milestones/:mid/changes', authMiddleware, async (req, res) => {
    const { x, m, as } = await msAccess(req); if (!x || as !== 'client') return nf(res);
    if (x.status !== 'submitted') return res.status(400).json({ error: 'This milestone is not waiting for review.' });
    const note = txt(req.body && req.body.note, 1000); if (note.length < 10) return res.status(400).json({ error: 'Say what needs to change.' });
    await supabase.from('venture_milestones').update({ status: 'changes', change_note: note }).eq('id', x.id);
    if (x.bill_id) await supabase.from('mandate_bills').update({ release_at: null }).eq('id', x.bill_id);
    await c.log(m.id, req.user.id, 'milestone', `Client asked for changes to "${x.title}": ${note}`);
    await escrow.notify(m.manager_id, { type: 'venture', title: '✏️ Changes requested', message: `"${x.title}": ${note.slice(0, 140)}`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });

  // ── Hiring process (optional, per side): CV, background, questions, video interviews ──
  const CV_BUCKET = 'patent-files';
  const multer = require('multer');
  const cvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  const sideName = as => as === 'client' ? 'client' : 'manager';
  const otherOf = (m, uid) => uid === m.client_id ? m.manager_id : m.client_id;
  async function hiringData(m, as, uid) {
    const [{ data: iv }, { data: qs }, { data: nt }, { data: prof }, { data: creds }, { data: cu }, { data: mu }] = await Promise.all([
      supabase.from('mandate_interviews').select('*').eq('mandate_id', m.id).order('created_at', { ascending: false }).limit(30),
      supabase.from('mandate_questions').select('*').eq('mandate_id', m.id).order('created_at', { ascending: true }).limit(40),
      as === 'admin' ? Promise.resolve({ data: null }) : supabase.from('mandate_notes').select('note, updated_at').eq('mandate_id', m.id).eq('user_id', uid).maybeSingle(),
      supabase.from('manager_profiles').select('*').eq('user_id', m.manager_id).maybeSingle(),
      supabase.from('pro_credentials').select('kind, status').eq('user_id', m.manager_id),
      supabase.from('users').select('id, role, country, created_at').eq('id', m.client_id).maybeSingle(),
      supabase.from('users').select('id, created_at').eq('id', m.manager_id).maybeSingle()
    ]);
    const ok = k => (creds || []).some(x => x.kind === k && x.status === 'verified');
    const p = prof || {};
    const pledgeNeeded = as === 'manager' && m.status === 'proposed' && (m.screen_client || m.screen_manager) && !m.manager_pledge_at;
    let clientFacts = null;
    if (cu) {
      const [{ data: ideas }, { data: buys }] = await Promise.all([
        supabase.from('ideas').select('id').eq('creator_id', m.client_id).limit(200),
        supabase.from('transactions').select('id').eq('buyer_id', m.client_id).limit(200)
      ]);
      clientFacts = { role: cu.role, country: cu.country || null, member_since: cu.created_at || null, ideas_listed: (ideas || []).length, purchases: (buys || []).length };
    }
    return {
      client: { required: !!m.screen_client, cleared_at: m.client_cleared_at || null },
      manager: { required: !!m.screen_manager, cleared_at: m.manager_cleared_at || null },
      pending: screeningPending(m), pledge_at: m.manager_pledge_at || null, pledge_needed: pledgeNeeded,
      background: {
        headline: p.headline || '', about: p.about || '', experience: p.experience || '', references_text: p.references_text || '', linkedin_url: p.linkedin_url || null,
        industries: p.industries || [], countries: p.countries || [], has_cv: !!p.cv_path, cv_uploaded_at: p.cv_uploaded_at || null,
        id_checked: ok('identity'), address_checked: ok('address'), induction_passed: !!p.induction_passed_at, member_since: (mu && mu.created_at) || null
      },
      client_facts: clientFacts,
      interviews: (iv || []).map(x => ({ ...x, mine: x.proposed_by === uid })),
      questions: pledgeNeeded ? [] : (qs || []).map(q => ({ ...q, mine: q.asked_by === uid })),
      questions_hidden: pledgeNeeded ? (qs || []).length : 0,
      my_note: nt ? nt.note : ''
    };
  }
  const needPledge = (m, as) => as === 'manager' && m.status === 'proposed' && (m.screen_client || m.screen_manager) && !m.manager_pledge_at;
  const PLEDGE_ERR = 'First confirm that you will keep everything you learn in this hiring process confidential.';

  app.post('/api/mandates/:id/screening/request', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !['client', 'manager'].includes(as)) return nf(res);
    if (m.status !== 'proposed') return res.status(400).json({ error: 'A hiring process can only be added before the mandate is agreed.' });
    const col = as === 'client' ? 'screen_client' : 'screen_manager';
    if (m[col]) return res.json({ ok: true });
    await supabase.from('mandates').update({ [col]: true, [`${sideName(as)}_cleared_at`]: null }).eq('id', m.id).eq('status', 'proposed');
    await c.log(m.id, req.user.id, 'screening', `${fullName(u)} asked for a hiring process (CV, questions and an interview) before agreeing.`);
    await escrow.notify(otherOf(m, req.user.id), { type: 'mandate_screening', title: '🧾 Hiring process requested', message: `${fullName(u)} would like to interview before agreeing "${m.title}".`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandates/:id/screening/pledge', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || as !== 'manager') return nf(res);
    if (!(req.body && req.body.agree === true)) return res.status(400).json({ error: 'Tick the box to confirm.' });
    if (!m.manager_pledge_at) {
      await supabase.from('mandates').update({ manager_pledge_at: new Date().toISOString() }).eq('id', m.id);
      await c.log(m.id, req.user.id, 'pledge', `${fullName(u)} promised to keep everything learned in the hiring process confidential, even if not hired.`);
    }
    res.json({ ok: true });
  });
  app.post('/api/mandates/:id/screening/decide', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !['client', 'manager'].includes(as)) return nf(res);
    if (m.status !== 'proposed') return res.status(400).json({ error: 'This mandate is not waiting for an answer.' });
    const col = as === 'client' ? 'screen_client' : 'screen_manager';
    if (!m[col]) return res.status(400).json({ error: 'You did not ask for a hiring process.' });
    const decision = req.body && req.body.decision, note = txt(req.body && req.body.note, 500);
    if (decision === 'continue') {
      await supabase.from('mandates').update({ [`${sideName(as)}_cleared_at`]: new Date().toISOString() }).eq('id', m.id).eq('status', 'proposed');
      await c.log(m.id, req.user.id, 'screening', `${fullName(u)} finished the hiring process and is happy to continue.`);
      await escrow.notify(otherOf(m, req.user.id), { type: 'mandate_screening', title: '✅ Hiring step done', message: `${fullName(u)} is happy to continue with "${m.title}".`, link: `/mandate?id=${m.id}` });
      return res.json({ ok: true });
    }
    if (decision !== 'not_fit') return res.status(400).json({ error: 'Choose continue or not a fit.' });
    const mine = m.proposed_by === req.user.id;
    await supabase.from('mandates').update({ status: mine ? 'cancelled' : 'declined', end_reason: note || 'Not a fit after the hiring process.', ended_at: new Date().toISOString() }).eq('id', m.id).eq('status', 'proposed');
    await supabase.from('mandate_interviews').update({ status: 'cancelled' }).eq('mandate_id', m.id).in('status', ['proposed', 'scheduled']);
    await c.log(m.id, req.user.id, 'declined', `${fullName(u)} decided it is not a fit.${note ? ' ' + note : ''}`);
    await escrow.notify(otherOf(m, req.user.id), { type: 'mandate_declined', title: 'Not a fit this time', message: `${fullName(u)} decided not to go ahead with "${m.title}".${note ? ' ' + note : ''}`, link: `/mandate?id=${m.id}` });
    if (as === 'client' && m.source_request_id) await supabase.from('manager_pitches').update({ status: 'declined' }).eq('request_id', m.source_request_id).eq('manager_id', m.manager_id);
    res.json({ ok: true });
  });

  // Interviews / meetings (video calls through /call?type=mandate&id=)
  app.post('/api/mandates/:id/interviews', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !['client', 'manager'].includes(as)) return nf(res);
    if (!['proposed', 'active'].includes(m.status)) return res.status(400).json({ error: 'This mandate is closed.' });
    if (needPledge(m, as)) return res.status(400).json({ error: PLEDGE_ERR, code: 'pledge' });
    const now = Date.now();
    const slots = [...new Set((Array.isArray(req.body && req.body.slots) ? req.body.slots : []).map(x => new Date(x)).filter(d => !isNaN(d)).map(d => d.toISOString()))];
    if (!slots.length || slots.length > 3) return res.status(400).json({ error: 'Offer 1 to 3 times.' });
    if (slots.some(x => new Date(x).getTime() < now + 30 * 60000)) return res.status(400).json({ error: 'Each time must be at least 30 minutes from now.' });
    if (slots.some(x => new Date(x).getTime() > now + 60 * 86400000)) return res.status(400).json({ error: 'Choose times within the next 60 days.' });
    const { data: open } = await supabase.from('mandate_interviews').select('id').eq('mandate_id', m.id).in('status', ['proposed', 'scheduled']);
    if ((open || []).length >= 3) return res.status(400).json({ error: 'There are already 3 open meetings. Cancel one first.' });
    const kind = m.status === 'proposed' ? 'interview' : 'meeting';
    const { data, error } = await supabase.from('mandate_interviews').insert([{ mandate_id: m.id, proposed_by: req.user.id, kind, slots, status: 'proposed', note: txt(req.body.note, 500) || null, minutes: [15, 30, 45, 60].includes(Number(req.body.minutes)) ? Number(req.body.minutes) : 30 }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await c.log(m.id, req.user.id, 'interview', `${fullName(u)} offered ${slots.length} time${slots.length > 1 ? 's' : ''} for a video ${kind}.`);
    await escrow.notify(otherOf(m, req.user.id), { type: 'mandate_interview', title: `📹 Pick a time for a video ${kind}`, message: `${fullName(u)} offered times for "${m.title}".`, link: `/mandate?id=${m.id}` });
    res.status(201).json(data);
  });
  async function loadInterview(req) {
    const { data: x } = await supabase.from('mandate_interviews').select('*').eq('id', intId(req.params.iid)).single();
    if (!x) return {};
    const r = await access(req, x.mandate_id);
    return { x, ...r };
  }
  app.post('/api/mandate-interviews/:iid/choose', authMiddleware, async (req, res) => {
    const { x, m, as, u } = await loadInterview(req); if (!x || !m || !['client', 'manager'].includes(as)) return nf(res);
    if (x.proposed_by === req.user.id) return res.status(400).json({ error: 'The other person picks one of your times.' });
    if (x.status !== 'proposed') return res.status(400).json({ error: 'A time was already agreed or this was cancelled.' });
    if (needPledge(m, as)) return res.status(400).json({ error: PLEDGE_ERR, code: 'pledge' });
    const slot = (x.slots || []).find(s => new Date(s).getTime() === new Date(req.body && req.body.slot).getTime());
    if (!slot) return res.status(400).json({ error: 'Choose one of the offered times.' });
    if (new Date(slot).getTime() < Date.now()) return res.status(400).json({ error: 'That time has passed. Ask for new times.' });
    await supabase.from('mandate_interviews').update({ status: 'scheduled', chosen_at: slot }).eq('id', x.id).eq('status', 'proposed');
    const when = new Date(slot).toUTCString().replace(':00 GMT', ' GMT');
    await c.log(m.id, req.user.id, 'interview', `Video ${x.kind || 'interview'} agreed for ${when}.`);
    for (const id of [m.client_id, m.manager_id]) {
      await escrow.notify(id, { type: 'mandate_interview', title: `📅 Video ${x.kind || 'interview'} booked`, message: `"${m.title}": ${when}. Join from the mandate page.`, link: `/mandate?id=${m.id}` });
      await escrow.emailUser(id, `Video ${x.kind || 'interview'} booked: "${m.title}"`, `Your video ${x.kind || 'interview'} is booked`, `<strong>${escrow.esc(when)}</strong> (shown in GMT; the mandate page shows your local time). The call opens 15 minutes before; join it from the mandate page.`, 'Open the mandate', `/mandate?id=${m.id}`);
    }
    res.json({ ok: true });
  });
  app.post('/api/mandate-interviews/:iid/cancel', authMiddleware, async (req, res) => {
    const { x, m, as, u } = await loadInterview(req); if (!x || !m || !['client', 'manager'].includes(as)) return nf(res);
    if (!['proposed', 'scheduled'].includes(x.status)) return res.status(400).json({ error: 'This meeting is not open.' });
    const note = txt(req.body && req.body.note, 300);
    await supabase.from('mandate_interviews').update({ status: 'cancelled', cancel_note: note || null }).eq('id', x.id);
    await c.log(m.id, req.user.id, 'interview', `${fullName(u)} cancelled a video ${x.kind || 'interview'}.${note ? ' ' + note : ''}`);
    await escrow.notify(otherOf(m, req.user.id), { type: 'mandate_interview', title: 'Video call cancelled', message: `${fullName(u)} cancelled the video ${x.kind || 'interview'} for "${m.title}".${note ? ' ' + note : ''}`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  app.post('/api/mandate-interviews/:iid/done', authMiddleware, async (req, res) => {
    const { x, m, as, u } = await loadInterview(req); if (!x || !m || !['client', 'manager'].includes(as)) return nf(res);
    if (x.status !== 'scheduled') return res.status(400).json({ error: 'Only a booked call can be marked as done.' });
    if (new Date(x.chosen_at).getTime() > Date.now() + 15 * 60000) return res.status(400).json({ error: 'You can mark it done once the call has started.' });
    await supabase.from('mandate_interviews').update({ status: 'done', done_by: req.user.id, done_at: new Date().toISOString() }).eq('id', x.id);
    await c.log(m.id, req.user.id, 'interview', `${fullName(u)} marked the video ${x.kind || 'interview'} as done.`);
    res.json({ ok: true });
  });

  // Written questions (either side can ask; the other answers)
  app.post('/api/mandates/:id/questions', authMiddleware, async (req, res) => {
    const { m, as, u } = await access(req, req.params.id); if (!m || !['client', 'manager'].includes(as)) return nf(res);
    if (m.status !== 'proposed') return res.status(400).json({ error: 'Questions are part of the hiring process, before the mandate is agreed. Use messages now.' });
    if (needPledge(m, as)) return res.status(400).json({ error: PLEDGE_ERR, code: 'pledge' });
    const q = txt(req.body && req.body.question, 1000); if (q.length < 8) return res.status(400).json({ error: 'Write your question.' });
    const quality = require('./public/listing-quality');
    const contact = quality.hasContact(q); if (contact) return res.status(400).json({ error: `Please remove ${contact}. Keep the conversation on IdeaHub.` });
    const { data: all } = await supabase.from('mandate_questions').select('id').eq('mandate_id', m.id);
    if ((all || []).length >= 30) return res.status(400).json({ error: 'That is a lot of questions. Talk it through on the video interview.' });
    const { data, error } = await supabase.from('mandate_questions').insert([{ mandate_id: m.id, asked_by: req.user.id, question: q }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await escrow.notify(otherOf(m, req.user.id), { type: 'mandate_question', title: '❓ New question', message: `${fullName(u)} asked a question about "${m.title}".`, link: `/mandate?id=${m.id}` });
    res.status(201).json(data);
  });
  app.post('/api/mandate-questions/:qid/answer', authMiddleware, async (req, res) => {
    const { data: q } = await supabase.from('mandate_questions').select('*').eq('id', intId(req.params.qid)).single();
    if (!q) return nf(res);
    const { m, as, u } = await access(req, q.mandate_id); if (!m || !['client', 'manager'].includes(as)) return nf(res);
    if (q.asked_by === req.user.id) return res.status(400).json({ error: 'The other person answers your question.' });
    if (m.status !== 'proposed') return res.status(400).json({ error: 'The hiring process has finished.' });
    if (needPledge(m, as)) return res.status(400).json({ error: PLEDGE_ERR, code: 'pledge' });
    const a = txt(req.body && req.body.answer, 3000); if (a.length < 2) return res.status(400).json({ error: 'Write your answer.' });
    const quality = require('./public/listing-quality');
    const contact = quality.hasContact(a); if (contact) return res.status(400).json({ error: `Please remove ${contact}. Keep the conversation on IdeaHub.` });
    await supabase.from('mandate_questions').update({ answer: a, answered_at: new Date().toISOString() }).eq('id', q.id);
    await escrow.notify(q.asked_by, { type: 'mandate_question', title: '💬 Question answered', message: `${fullName(u)} answered your question about "${m.title}".`, link: `/mandate?id=${m.id}` });
    res.json({ ok: true });
  });
  // Private notes (only the writer sees them)
  app.put('/api/mandates/:id/note', authMiddleware, async (req, res) => {
    const { m, as } = await access(req, req.params.id); if (!m || !['client', 'manager'].includes(as)) return nf(res);
    await supabase.from('mandate_notes').upsert([{ mandate_id: m.id, user_id: req.user.id, note: txt(req.body && req.body.note, 4000), updated_at: new Date().toISOString() }], { onConflict: 'mandate_id,user_id' });
    res.json({ ok: true });
  });

  // Manager CV (PDF). Seen by the manager, admins, and clients considering or working with them.
  app.post('/api/manager/cv', authMiddleware, cvUpload.single('file'), async (req, res) => {
    const u = await me(req.user.id);
    if (!u || u.role !== 'virtual_manager') return res.status(403).json({ error: 'Switch to the Virtual Manager role first.' });
    if (!req.file) return res.status(400).json({ error: 'Choose your CV (PDF, up to 5 MB).' });
    if (req.file.mimetype !== 'application/pdf' || req.file.buffer.slice(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'Upload your CV as a PDF.' });
    const safe = String(req.file.originalname || 'cv.pdf').replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `mgrcv-${u.id}/${Date.now()}-${require('crypto').randomBytes(3).toString('hex')}.pdf`;
    const { error: upErr } = await supabase.storage.from(CV_BUCKET).upload(path, req.file.buffer, { contentType: 'application/pdf', upsert: false });
    if (upErr) return res.status(500).json({ error: 'Could not save the file: ' + upErr.message });
    const { data: ex } = await supabase.from('manager_profiles').select('cv_path').eq('user_id', u.id).maybeSingle();
    if (ex && ex.cv_path) await supabase.storage.from(CV_BUCKET).remove([ex.cv_path]).catch(() => {});
    await supabase.from('manager_profiles').upsert([{ user_id: u.id, cv_path: path, cv_name: safe, cv_uploaded_at: new Date().toISOString() }], { onConflict: 'user_id' });
    res.status(201).json({ ok: true, cv_name: safe });
  });
  app.delete('/api/manager/cv', authMiddleware, async (req, res) => {
    const { data: ex } = await supabase.from('manager_profiles').select('cv_path').eq('user_id', req.user.id).maybeSingle();
    if (ex && ex.cv_path) await supabase.storage.from(CV_BUCKET).remove([ex.cv_path]).catch(() => {});
    await supabase.from('manager_profiles').update({ cv_path: null, cv_name: null, cv_uploaded_at: null }).eq('user_id', req.user.id);
    res.json({ ok: true });
  });
  app.get('/api/managers/:id/cv', authMiddleware, async (req, res) => {
    const mid = intId(req.params.id), uid = req.user.id;
    const { data: p } = await supabase.from('manager_profiles').select('cv_path, cv_name').eq('user_id', mid).maybeSingle();
    if (!p || !p.cv_path) return res.status(404).json({ error: 'This manager has not uploaded a CV.' });
    let allowed = uid === mid;
    if (!allowed) { const u = await me(uid); allowed = !!(u && u.role === 'admin'); }
    if (!allowed) { const { data: ms } = await supabase.from('mandates').select('id').eq('manager_id', mid).eq('client_id', uid).limit(1); allowed = !!(ms && ms.length); }
    if (!allowed) {
      const { data: rs } = await supabase.from('manager_requests').select('id').eq('client_id', uid).limit(100);
      const ids = (rs || []).map(r => r.id);
      if (ids.length) { const { data: ps } = await supabase.from('manager_pitches').select('id').eq('manager_id', mid).in('request_id', ids).limit(1); allowed = !!(ps && ps.length); }
    }
    if (!allowed) return res.status(403).json({ error: 'You can see a manager\'s CV once you\'re considering them: start an appointment with screening, or receive their pitch.' });
    const { data, error } = await supabase.storage.from(CV_BUCKET).createSignedUrl(p.cv_path, 300);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl, name: p.cv_name });
  });

  // ── "I need a manager" requests + pitches ──
  app.get('/api/manager-requests', async (req, res) => {
    const { data } = await supabase.from('manager_requests').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(100);
    const U = await c.users((data || []).map(r => r.client_id));
    res.json((data || []).map(r => ({ ...r, client: { id: r.client_id, name: fullName(U[r.client_id]), avatar_url: U[r.client_id]?.avatar_url || null } })));
  });
  app.post('/api/manager-requests', authMiddleware, async (req, res) => {
    const u = await me(req.user.id);
    if (!u || !CLIENT_ROLES.includes(u.role)) return res.status(403).json({ error: 'Idea creators, investors and businesses can post here.' });
    const b = req.body || {}, side = SIDES[b.client_side] ? b.client_side : sideOfRole(u.role);
    const title = txt(b.title, 120), needs = txt(b.needs, 3000);
    if (title.length < 8 || needs.length < 40) return res.status(400).json({ error: 'Give it a title and describe what you need (40+ characters).' });
    const quality = require('./public/listing-quality');
    const contact = quality.hasContact(title) || quality.hasContact(needs);
    if (contact) return res.status(400).json({ error: `Please remove ${contact}. Managers reply through IdeaHub.` });
    const { data, error } = await supabase.from('manager_requests').insert([{ client_id: u.id, client_side: side, title, needs, industry: txt(b.industry, 60) || null,
      scopes: (Array.isArray(b.scopes) ? b.scopes : []).filter(s => SCOPES[s] && SCOPES[s].sides.includes(side)), fee_models: (Array.isArray(b.fee_models) ? b.fee_models : []).filter(f => ['retainer', 'hourly', 'success'].includes(f)),
      budget: txt(b.budget, 120) || null, status: 'open', pitch_count: 0 }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });
  app.get('/api/manager-requests/mine', authMiddleware, async (req, res) => {
    const { data: rs } = await supabase.from('manager_requests').select('*').eq('client_id', req.user.id).order('created_at', { ascending: false });
    const ids = (rs || []).map(r => r.id);
    const { data: ps } = ids.length ? await supabase.from('manager_pitches').select('*').in('request_id', ids).order('created_at', { ascending: true }) : { data: [] };
    const U = await c.users((ps || []).map(p => p.manager_id));
    const L = {}; for (const id of [...new Set((ps || []).map(p => p.manager_id))]) L[id] = await c.levelOf(id);
    res.json((rs || []).map(r => ({ ...r, pitches: (ps || []).filter(p => p.request_id === r.id).map(p => ({ ...p, manager: { id: p.manager_id, name: fullName(U[p.manager_id]), avatar_url: U[p.manager_id]?.avatar_url || null, level: L[p.manager_id], level_label: LEVELS[L[p.manager_id]] } })) })));
  });
  app.post('/api/manager-requests/:id/pitch', authMiddleware, async (req, res) => {
    const u = await me(req.user.id);
    if (!u || u.role !== 'virtual_manager') return res.status(403).json({ error: 'Only managers can pitch.' });
    if (await c.levelOf(u.id) === 'new') return res.status(403).json({ error: 'Finish the ID check and the induction quiz first (Workspace → Profile & level).' });
    const { data: r } = await supabase.from('manager_requests').select('*').eq('id', intId(req.params.id)).single();
    if (!r || r.status !== 'open') return res.status(400).json({ error: 'This request is closed.' });
    const conflict = await c.mandateConflict(u.id, r.client_id, r.industry || '');
    if (conflict) return res.status(400).json({ error: conflict.replace('This manager already works', 'You already work').replace('This manager works', 'You work'), code: 'conflict' });
    const message = txt(req.body && req.body.message, 2000); if (message.length < 40) return res.status(400).json({ error: 'Explain how you would help (40+ characters).' });
    const { data: ex } = await supabase.from('manager_pitches').select('id').eq('request_id', r.id).eq('manager_id', u.id).limit(1);
    if (ex && ex.length) return res.status(400).json({ error: 'You already pitched for this request.' });
    const { data, error } = await supabase.from('manager_pitches').insert([{ request_id: r.id, manager_id: u.id, message, fee_retainer: num(req.body.fee_retainer, 1e6) || 0, fee_hourly: num(req.body.fee_hourly, 1e5) || 0, fee_success_pct: num(req.body.fee_success_pct, 50) || 0, status: 'sent' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const { data: all } = await supabase.from('manager_pitches').select('id').eq('request_id', r.id);
    await supabase.from('manager_requests').update({ pitch_count: (all || []).length }).eq('id', r.id);
    await escrow.notify(r.client_id, { type: 'manager_pitch', title: '🙋 A manager pitched', message: `${fullName(u)} wants to help with "${r.title}".`, link: '/managers?tab=mine' });
    res.status(201).json(data);
  });
  app.post('/api/manager-pitches/:pid/accept', authMiddleware, async (req, res) => {
    const { data: p } = await supabase.from('manager_pitches').select('*').eq('id', intId(req.params.pid)).single();
    const { data: r } = p ? await supabase.from('manager_requests').select('*').eq('id', p.request_id).single() : { data: null };
    if (!p || !r || r.client_id !== req.user.id) return nf(res);
    if (p.status !== 'sent') return res.status(400).json({ error: 'This pitch was already answered.' });
    const scopes = (r.scopes && r.scopes.length ? r.scopes : Object.keys(SCOPES).filter(k => SCOPES[k].sides.includes(r.client_side)).slice(0, 2));
    const out = await callAs(req.user.id, 'POST', '/api/mandates', { manager_id: p.manager_id, client_side: r.client_side, title: r.title, goals: r.needs, focus_industry: r.industry || 'General', scopes, fee_retainer: p.fee_retainer, fee_hourly: p.fee_hourly, fee_success_pct: p.fee_success_pct, request_id: r.id, screening: !!(req.body && req.body.screening) });
    if (!out.ok) return res.status(400).json({ error: out.error });
    await supabase.from('manager_pitches').update({ status: req.body && req.body.screening ? 'shortlisted' : 'accepted' }).eq('id', p.id);
    res.json({ ok: true, mandate_id: out.data.id });
  });
  app.post('/api/manager-pitches/:pid/decline', authMiddleware, async (req, res) => {
    const { data: p } = await supabase.from('manager_pitches').select('*').eq('id', intId(req.params.pid)).single();
    const { data: r } = p ? await supabase.from('manager_requests').select('client_id, title').eq('id', p.request_id).single() : { data: null };
    if (!p || !r || r.client_id !== req.user.id) return nf(res);
    await supabase.from('manager_pitches').update({ status: 'declined' }).eq('id', p.id).eq('status', 'sent');
    await escrow.notify(p.manager_id, { type: 'manager_pitch', title: 'Pitch not chosen', message: `Your pitch for "${r.title}" wasn't chosen this time.`, link: '/workspace?tab=requests' });
    res.json({ ok: true });
  });
  app.post('/api/manager-requests/:id/close', authMiddleware, async (req, res) => {
    const { data: r } = await supabase.from('manager_requests').select('*').eq('id', intId(req.params.id)).single();
    if (!r || r.client_id !== req.user.id) return nf(res);
    await supabase.from('manager_requests').update({ status: 'closed' }).eq('id', r.id); res.json({ ok: true });
  });

  // ── Workspace summary for a manager ──
  app.get('/api/manager/workspace', authMiddleware, async (req, res) => {
    const u = await me(req.user.id);
    if (!u || u.role !== 'virtual_manager') return res.status(403).json({ error: 'The workspace is for managers.' });
    const { data: ms } = await supabase.from('mandates').select('*').eq('manager_id', u.id).order('created_at', { ascending: false });
    const ids = (ms || []).map(m => m.id);
    const q = (t, f) => ids.length ? f(supabase.from(t)) : Promise.resolve({ data: [] });
    const [{ data: items }, { data: tasks }, { data: acts }, { data: bills }, { data: deals }, { data: pitches }] = await Promise.all([
      q('mandate_items', s => s.select('*').in('mandate_id', ids).order('updated_at', { ascending: false }).limit(500)),
      q('mandate_tasks', s => s.select('*').in('mandate_id', ids).eq('done', false).order('due_date', { ascending: true })),
      q('mandate_actions', s => s.select('*').in('mandate_id', ids).order('created_at', { ascending: false }).limit(100)),
      q('mandate_bills', s => s.select('*').in('mandate_id', ids).order('created_at', { ascending: false }).limit(300)),
      q('mandate_deals', s => s.select('*').in('mandate_id', ids)),
      supabase.from('manager_pitches').select('request_id, status').eq('manager_id', u.id)
    ]);
    const U = await c.users((ms || []).map(m => m.client_id));
    const released = (bills || []).filter(b => b.status === 'released').reduce((s, b) => s + Number(b.amount), 0);
    const held = (bills || []).filter(b => ['paid', 'disputed'].includes(b.status)).reduce((s, b) => s + Number(b.amount), 0);
    const dueAmt = (bills || []).filter(b => b.status === 'due').reduce((s, b) => s + Number(b.amount), 0);
    const referral = (deals || []).filter(d => d.referral_paid).reduce((s, d) => s + Number(d.referral_amount || 0), 0);
    res.json({
      mandates: (ms || []).map(m => ({ ...m, client: { id: m.client_id, name: fullName(U[m.client_id]), avatar_url: U[m.client_id]?.avatar_url || null } })),
      items: items || [], tasks: tasks || [], actions: acts || [], bills: bills || [], deals: deals || [],
      pitched: (pitches || []).map(p => p.request_id),
      earnings: { released: round2(released), held: round2(held), due: round2(dueAmt), referral: round2(referral) },
      level: await c.levelOf(u.id), stats: await c.statsOf(u.id)
    });
  });

  // Messages on behalf of a client (used by POST /api/messages in server.js)
  return { core: c };
}

// Can this manager message `counterpartyId` for `clientId`? Returns { ok, error }.
async function canActFor(supabase, managerId, clientId, counterpartyId) {
  const { data: ms } = await supabase.from('mandates').select('id, scopes, status').eq('manager_id', managerId).eq('client_id', clientId).eq('status', 'active');
  const m = (ms || []).find(x => (x.scopes || []).includes('messages'));
  if (!m) return { ok: false, error: 'You don\'t have a mandate to message on this client\'s behalf.' };
  if (counterpartyId === clientId) return { ok: false, error: 'Message your client directly, not on their behalf.' };
  const { data: other } = await supabase.from('mandates').select('id').eq('manager_id', managerId).eq('client_id', counterpartyId).eq('status', 'active');
  if (other && other.length) return { ok: false, error: 'You also manage this person. A manager can only act for one side.', code: 'conflict' };
  return { ok: true, mandate: m };
}

module.exports = { mount, core, canActFor, screeningPending, SCOPES, SIDES, ACTIONS, LEVELS, QUIZ, TERMS_VERSION };
