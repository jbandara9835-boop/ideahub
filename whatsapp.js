// ─────────────────────────────────────────────────────────────────────────────
// whatsapp.js — IdeaHub on WhatsApp (Meta WhatsApp Cloud API, no Twilio)
//
//   1. VERIFY + LINK (free): on Profile the user taps "Verify WhatsApp". WhatsApp opens with
//      "IdeaHub code K7P2QX9M" already typed; they press Send. The message arrives from their
//      own WhatsApp, which proves the number. We mark the phone verified and link the number
//      to their account for the bot. Messages a user sends us cost nothing.
//      Optional paid fallback: we send a code with an approved authentication template
//      (only when WA_OTP_TEMPLATE is set).
//   2. BOT: a linked Idea Creator lists an idea step by step (title → summary → description →
//      industry → type → countries → price → visibility → photos → review → agreement). The
//      same listing rules as the website run at each step, and the final listing goes through
//      the normal POST /api/ideas (quality, seller agreement, originality check, matching).
//      "My ideas" shows their latest listings. Replies are sent inside WhatsApp's 24-hour
//      customer-service window, so they are free.
//   3. SIMULATOR: /wa-sim (admins) runs the same bot without Meta, so it can be tried first.
//
// Railway variables
//   WA_TOKEN          permanent access token (System User) — without it the bot runs in simulator mode
//   WA_PHONE_ID       phone number ID (WhatsApp → API Setup)
//   WA_NUMBER         the WhatsApp number people message, digits only, e.g. 94771234567
//   WA_VERIFY_TOKEN   any secret text; the same text goes in Meta's webhook settings
//   WA_APP_SECRET     App settings → Basic → App secret (checks that webhooks really come from Meta)
//   WA_OTP_TEMPLATE   optional: name of an approved authentication template (paid fallback)
//   WA_API_VERSION    optional, default v23.0
//
// server.js: require('./whatsapp').mount(app, { supabase, authMiddleware, escrow })
//            and express.json({ verify }) keeps the raw body for the webhook signature.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const quality = require('./public/listing-quality');
const ideaTerms = require('./public/idea-terms');

const SITE = (process.env.SITE_URL || 'https://ideahub.it.com').replace(/\/$/, '');
const API = () => `https://graph.facebook.com/${process.env.WA_API_VERSION || 'v23.0'}`;
const live = () => !!(process.env.WA_TOKEN && process.env.WA_PHONE_ID);
const botNumber = () => String(process.env.WA_NUMBER || '').replace(/\D/g, '');
const CREATOR_ROLES = ['idea_creator', 'patent_seller', 'admin'];
const LINK_TTL_MIN = 15;
const DRAFT_DAYS = 7;

const INDUSTRIES = ['Technology', 'Health & Wellness', 'Education', 'Finance', 'Food & Beverage', 'E-commerce', 'Entertainment', 'Real Estate', 'Travel', 'Environment', 'Agriculture', 'Other'];
const TYPES = ['New Business Idea', 'Product Concept', 'App / Software', 'Service Model', 'Invention', 'Social Enterprise'];
const VISIBILITY = { 1: 'Everyone', 2: 'Verified buyers only', 3: 'Private (invite link)' };
const COUNTRIES = ["Afghanistan","Albania","Algeria","Andorra","Angola","Antigua and Barbuda","Argentina","Armenia","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bhutan","Bolivia","Bosnia and Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Central African Republic","Chad","Chile","China","Colombia","Comoros","Congo","Costa Rica","Croatia","Cuba","Cyprus","Czechia","Denmark","Djibouti","Dominica","Dominican Republic","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini","Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia","Germany","Ghana","Greece","Grenada","Guatemala","Guinea","Guinea-Bissau","Guyana","Haiti","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Kosovo","Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Marshall Islands","Mauritania","Mauritius","Mexico","Micronesia","Moldova","Monaco","Mongolia","Montenegro","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","New Zealand","Nicaragua","Niger","Nigeria","North Korea","North Macedonia","Norway","Oman","Pakistan","Palau","Palestine","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda","Saint Kitts and Nevis","Saint Lucia","Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome and Principe","Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Slovakia","Slovenia","Solomon Islands","Somalia","South Africa","South Korea","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland","Syria","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Togo","Tonga","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Tuvalu","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Uruguay","Uzbekistan","Vanuatu","Vatican City","Venezuela","Vietnam","Yemen","Zambia","Zimbabwe"];
const COUNTRY_ALIAS = { usa: 'United States', us: 'United States', america: 'United States', uk: 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom', uae: 'United Arab Emirates', dubai: 'United Arab Emirates', srilanka: 'Sri Lanka', lanka: 'Sri Lanka', korea: 'South Korea' };
const STATUS_LABEL = { live: 'Live', under_review: 'Under review', rejected: 'Needs changes', escrow: 'Buyer has paid (in escrow)', sold: 'Sold', withdrawn: 'Withdrawn', hidden: 'Hidden' };

// ── small helpers ────────────────────────────────────────────────────────────
const digits = v => String(v == null ? '' : v).replace(/\D/g, '');
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const money = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const maskNumber = n => { const d = digits(n); return d.length > 6 ? '+' + d.slice(0, d.length - 7) + '•••' + d.slice(-4) : '+' + d; };
const maskEmail = e => { const [a, b] = String(e || '').split('@'); return b ? a.slice(0, 2) + '•••@' + b : 'another account'; };
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), x => CODE_ABC[x % 32]).join('');
const hash = s => crypto.createHash('sha256').update(String(s) + (process.env.JWT_SECRET || '')).digest('hex');
const CODE_RE = /IDEAHUB\s*CODE\s*:?\s*([A-Z2-9]{4}[\s-]?[A-Z2-9]{4})/i;
const BARE_CODE_RE = /^\s*([A-Z2-9]{4}[\s-]?[A-Z2-9]{4})\s*$/i;   // just the code, e.g. "ANQG-9DBF"

// In-memory limits (one Railway instance)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();
const seen = new Map();   // webhook retries: ignore message ids we already handled
function firstTime(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  if (seen.size > 5000) for (const [k] of [...seen].slice(0, 1000)) seen.delete(k);
  return true;
}

// ── outgoing ─────────────────────────────────────────────────────────────────
// A reply is { text, buttons?: [{id,title}], list?: { button, rows: [{id,title,description}] } }
const outbox = new Map();   // simulator: number → replies waiting to be read
function toGraph(to, m) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (m.template) return { ...base, type: 'template', template: m.template };
  const body = clip(m.text, m.buttons || m.list ? 1024 : 4096);
  if (m.buttons && m.buttons.length) return { ...base, type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: m.buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })) } } };
  if (m.list && m.list.rows.length) return { ...base, type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button: clip(m.list.button || 'Choose', 20), sections: [{ title: clip(m.list.title || 'Options', 24), rows: m.list.rows.slice(0, 10).map(r => ({ id: r.id, title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })) }] } } };
  return { ...base, type: 'text', text: { body, preview_url: false } };
}
async function graph(path, body) {
  const r = await fetch(`${API()}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `WhatsApp API ${r.status}`);
  return j;
}

function core(supabase) {
  async function log(number, userId, direction, kind, body, msgId) {
    try { await supabase.from('wa_log').insert([{ wa_number: number, user_id: userId || null, direction, kind, body: clip(body, 500), wa_message_id: msgId || null }]); } catch (e) { /* logging never blocks */ }
  }
  async function send(to, m, opts = {}) {
    const number = digits(to);
    const sim = opts.sim || !live();
    if (sim) {
      const q = outbox.get(number) || []; q.push({ ...m, at: new Date().toISOString() }); outbox.set(number, q.slice(-50));
    } else {
      try { await graph(`${process.env.WA_PHONE_ID}/messages`, toGraph(number, m)); }
      catch (e) { console.error('WhatsApp send failed:', e.message); return false; }
    }
    log(number, opts.userId, 'out', m.template ? 'template' : m.buttons ? 'buttons' : m.list ? 'list' : 'text', m.template ? `template ${m.template.name}` : m.text, null);
    return true;
  }

  // ── accounts ──
  async function userByNumber(number) {
    const { data } = await supabase.from('users').select('id, role, first_name, last_name, email, whatsapp_number').eq('whatsapp_number', number).limit(1);
    return data && data[0] ? data[0] : null;
  }
  // Link a WhatsApp number to an account (and mark the phone verified). Returns { ok } or { error }.
  async function linkNumber(userId, number) {
    const other = await userByNumber(number);
    if (other && other.id !== userId) return { error: 'taken', email: other.email };
    const now = new Date().toISOString();
    const { error } = await supabase.from('users').update({ whatsapp_number: number, whatsapp_linked_at: now, phone: '+' + number, phone_verified: true, phone_verified_at: now }).eq('id', userId);
    if (error) return { error: error.message };
    await supabase.from('wa_verifications').delete().eq('user_id', userId);
    await supabase.from('notifications').insert([{ user_id: userId, type: 'whatsapp_linked', title: '✅ WhatsApp verified', message: `Your WhatsApp number ${maskNumber(number)} is verified and linked to IdeaHub.`, link: '/profile' }]);
    return { ok: true };
  }

  // ── sessions (bot state per number) ──
  async function getSession(number) {
    const { data } = await supabase.from('wa_sessions').select('*').eq('wa_number', number).maybeSingle();
    return data || null;
  }
  async function saveSession(number, patch) {
    const row = { wa_number: number, updated_at: new Date().toISOString(), ...patch };
    await supabase.from('wa_sessions').upsert([row], { onConflict: 'wa_number' });
  }

  return { send, log, userByNumber, linkNumber, getSession, saveSession };
}

// ── the bot ──────────────────────────────────────────────────────────────────
// Steps of the idea form, in order
const STEPS = ['title', 'summary', 'desc', 'industry', 'type', 'countries', 'price', 'visibility', 'photos'];
const STEP_NAME = { title: 'Title', summary: 'Summary', desc: 'Description', industry: 'Industry', type: 'Idea type', countries: 'Countries', price: 'Price', visibility: 'Who can see it', photos: 'Photos' };

function prompt(step, d) {
  const n = STEPS.indexOf(step) + 1, head = `*Step ${n} of ${STEPS.length}: ${STEP_NAME[step]}*\n`;
  switch (step) {
    case 'title': return { text: head + 'What is your idea called? Say what it is and who it is for.\n_Example: Solar cold box for small vegetable farmers_' };
    case 'summary': return { text: head + 'In one or two sentences: what problem does it solve, and who would buy it? Buyers see this before they pay.\n\nDo not add phone numbers, emails or links. Buyers contact you through IdeaHub so the deal is protected.' };
    case 'desc': return { text: head + 'Now the full idea: how it works, the market, costs, and the first steps to launch. Only the buyer sees this, after paying.\n\nYou can send it in several messages. Tap *Done* when finished.' + (d.desc ? `\n\n(So far: ${d.desc.length} characters. Send more, or tap Done.)` : ''), buttons: d.desc ? [{ id: 'done', title: 'Done' }] : undefined };
    case 'industry': return { text: head + 'Which industry? Reply with the number.\n\n' + INDUSTRIES.map((x, i) => `${i + 1}. ${x}`).join('\n') };
    case 'type': return { text: head + 'What kind of idea is it?', list: { button: 'Choose type', title: 'Idea type', rows: TYPES.map((t, i) => ({ id: 'type_' + i, title: t })) } };
    case 'countries': return { text: head + 'Where can the buyer use it?\nTap *All countries*, or type the countries separated by commas.\n_Example: Sri Lanka, India, Maldives_', buttons: [{ id: 'all', title: 'All countries' }] };
    case 'price': return { text: head + 'Your price in US dollars (numbers only).\n_Example: 1500_\nIdeaHub keeps 8% when it sells.' };
    case 'visibility': return { text: head + 'Who can see this listing?', buttons: [{ id: 'vis_1', title: 'Everyone' }, { id: 'vis_2', title: 'Verified buyers' }, { id: 'vis_3', title: 'Private link' }] };
    case 'photos': return { text: head + `Send up to 3 photos (a sketch, mock-up or prototype). Listings with a picture get more views.${d.images && d.images.length ? `\n\n${d.images.length} added.` : ''}`, buttons: [{ id: d.images && d.images.length ? 'done' : 'skip', title: d.images && d.images.length ? 'Done' : 'Skip' }] };
  }
}

function blockingFor(field, d) {
  const r = quality.checkListing({ title: d.title, summary: d.summary, desc: d.desc, industry: d.industry || 'x', price: d.price || 1, images: d.images || [], engagements: {} });
  return {
    block: r.items.filter(i => i.field === field && i.level === 'block').map(i => i.message),
    warn: r.items.filter(i => i.field === field && i.level === 'warn').map(i => i.message)
  };
}

function review(d) {
  const lines = [
    '*Check your listing*',
    '',
    `*Title:* ${d.title}`,
    `*Summary:* ${d.summary}`,
    `*Description:* ${clip(d.desc, 300)} _(${(d.desc || '').length} characters)_`,
    `*Industry:* ${d.industry}`,
    `*Type:* ${d.ideaType}`,
    `*Countries:* ${d.countries && d.countries[0] === 'ALL' ? 'All countries' : (d.countries || []).join(', ')}`,
    `*Price:* ${money(d.price)}`,
    `*Who can see it:* ${VISIBILITY[d.visibility] || 'Everyone'}`,
    `*Photos:* ${(d.images || []).length}`,
    '',
    'You can add extras (video call, prototype, supply…) and patent details later on the website.'
  ];
  return { text: lines.join('\n'), buttons: [{ id: 'submit', title: 'List it' }, { id: 'edit', title: 'Change something' }, { id: 'cancel', title: 'Cancel' }] };
}

const AGREE = {
  text: '*Idea Transfer Agreement*\nEvery sale on IdeaHub uses the same agreement. In short: when the buyer\'s payment is released to you, the idea and its materials pass to the buyer; you confirm the idea is yours to sell; after the sale you won\'t sell, license or publish it to anyone else; both sides keep it confidential; a patent is only included if the listing says so; Sri Lankan law applies.\n\nDo you agree to sell this idea under the agreement?',
  buttons: [{ id: 'agree', title: 'I agree, list it' }, { id: 'terms', title: 'Read it in full' }, { id: 'cancel', title: 'Cancel' }]
};

function menu(u, hasDraft) {
  const name = (u.first_name || '').trim();
  return {
    text: `Hi${name ? ' ' + name : ''} 👋 This is IdeaHub. What would you like to do?\n\nYou can type *menu* at any time to come back here.`,
    buttons: [hasDraft ? { id: 'continue', title: 'Continue my draft' } : { id: 'new', title: 'List a new idea' }, { id: 'mine', title: 'My ideas' }, { id: 'help', title: 'Help' }]
  };
}
const HELP = { text: '*How this works*\n• *List a new idea*: I ask a few questions, then publish it on IdeaHub under your account.\n• *My ideas*: your latest listings and their status.\n• Type *menu* to start again, *back* to go to the previous question, or *cancel* to throw away a draft.\n\nBuyers, payments and messages are handled on the website: ' + SITE + '/dashboard' };

function parseCountries(text) {
  const parts = String(text).split(/[,\n;]+| and /i).map(s => s.trim()).filter(Boolean).slice(0, 60);
  const found = [], unknown = [];
  for (const p of parts) {
    const k = norm(p);
    if (['all', 'allcountries', 'worldwide', 'global', 'everywhere', 'anywhere'].includes(k)) return { all: true };
    const c = COUNTRIES.find(x => norm(x) === k) || COUNTRY_ALIAS[k] || COUNTRIES.find(x => k.length >= 4 && norm(x).startsWith(k));
    if (c) { if (!found.includes(c)) found.push(c); } else unknown.push(p);
  }
  return { found, unknown };
}
function pick(list, input, prefix) {
  if (input.replyId && input.replyId.startsWith(prefix)) return list[parseInt(input.replyId.slice(prefix.length), 10)] || null;
  const t = (input.text || '').trim();
  const n = parseInt(t, 10);
  if (/^\d+$/.test(t) && n >= 1 && n <= list.length) return list[n - 1];
  return list.find(x => norm(x) === norm(t)) || list.find(x => norm(t).length >= 3 && norm(x).startsWith(norm(t))) || null;
}

function bot(supabase, opts = {}) {
  const C = core(supabase);
  const port = () => process.env.PORT || 3000;

  // POST the idea through the normal website route, so every check is the same
  async function createIdea(userId, d) {
    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '2m' });
    const body = { title: d.title, summary: d.summary, desc: d.desc, industry: d.industry, ideaType: d.ideaType, countries: d.countries, price: d.price, visibility: d.visibility || 1, level: 1, hasPatent: false, engagements: {}, images: d.images || [], sellerAgreement: ideaTerms.VERSION };
    const r = await (opts.fetch || fetch)(`http://127.0.0.1:${port()}/api/ideas`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { idea: j } : { error: j.error || 'Something went wrong.', quality: j.quality };
  }

  async function myIdeas(u) {
    const { data } = await supabase.from('ideas').select('id, title, status, price, views, created_at').eq('creator_id', u.id).order('created_at', { ascending: false }).limit(5);
    if (!data || !data.length) return { text: 'You have no ideas listed yet.', buttons: [{ id: 'new', title: 'List a new idea' }, { id: 'menu', title: 'Menu' }] };
    return {
      text: '*Your latest ideas*\n\n' + data.map(i => `• *${clip(i.title, 60)}*\n  ${STATUS_LABEL[i.status] || i.status} · ${money(i.price)} · ${i.views || 0} views\n  ${SITE}/idea?id=${i.id}`).join('\n\n') + `\n\nAll your ideas: ${SITE}/dashboard`,
      buttons: [{ id: 'new', title: 'List a new idea' }, { id: 'menu', title: 'Menu' }]
    };
  }

  // After listing: tell them the originality result (a few minutes later, still inside the free window)
  function followUp(number, ideaId, sim) {
    const delay = opts.followUpMs != null ? opts.followUpMs : 4 * 60 * 1000;
    const t = setTimeout(async () => {
      try {
        const { data: i } = await supabase.from('ideas').select('id, title, status, originality_score, moderation').eq('id', ideaId).single();
        if (!i) return;
        let text;
        if (i.status === 'live') text = `✅ *${clip(i.title, 60)}* passed the originality check${i.originality_score != null ? ` (score ${i.originality_score}/100)` : ''} and is live.\n${SITE}/idea?id=${i.id}`;
        else if (i.status === 'under_review') text = `⏳ *${clip(i.title, 60)}* is held for a review.${i.moderation && i.moderation.note ? '\nReason: ' + i.moderation.note : ''}\nYou can improve it here: ${SITE}/submit?edit=${i.id}\nOr ask "Ask IdeaHub" on the website why it was held.`;
        else return;
        await C.send(number, { text }, { sim });
      } catch (e) { console.error('WhatsApp follow-up:', e.message); }
    }, delay);
    if (t.unref) t.unref();
  }

  async function ask(number, s, step, extra) {
    const d = s.draft || {};
    await C.saveSession(number, { user_id: s.user_id, state: step, draft: d, sim: !!s.sim });
    const out = [];
    if (extra) out.push(extra);
    out.push(step === 'review' ? review(d) : step === 'agree' ? AGREE : prompt(step, d));
    return out;
  }
  const nextStep = (s, step) => s.draft && s.draft._edit ? 'review' : STEPS[STEPS.indexOf(step) + 1] || 'review';

  // input: { from, name, msgId, type: text|reply|image|other, text, replyId, image: { id, mime } }
  async function handle(input, ctx = {}) {
    const number = digits(input.from), sim = !!ctx.sim;
    const replies = [];
    const say = m => replies.push(m);
    const flush = async list => { for (const x of list) await C.send(number, x, { sim }); return list; };
    const text = (input.text || '').trim();
    const cmd = (input.replyId || norm(text));
    C.log(number, null, 'in', input.type, input.type === 'reply' ? `[${input.replyId}] ${input.text || ''}` : input.type === 'image' ? '[photo]' : text, input.msgId);

    if (limited('in:' + number, 40, 60000)) return replies;   // flooding: ignore quietly

    // 1. A verification code from the Profile page → link this number
    // The full pre-written message, or just the code from a number that isn't linked yet
    let m = (text.toUpperCase().match(CODE_RE) || [])[1];
    if (!m && input.type === 'text' && BARE_CODE_RE.test(text) && !(await C.userByNumber(number))) m = text.toUpperCase().match(BARE_CODE_RE)[1];
    if (m) {
      if (limited('code:' + number, 6, 3600000)) { return flush([{ text: 'Too many attempts. Please try again in an hour.' }]); }
      const code = m.replace(/[\s-]/g, '');
      const { data: v } = await supabase.from('wa_verifications').select('*').eq('code', code).eq('kind', 'inbound').maybeSingle();
      if (!v || new Date(v.expires_at) < new Date()) { return flush([{ text: 'That code is not valid or has expired. On the IdeaHub Profile page, tap *Verify WhatsApp* again to get a new one.' }]); }
      const r = await C.linkNumber(v.user_id, number);
      if (r.error === 'taken') { return flush([{ text: `This WhatsApp number is already linked to another IdeaHub account (${maskEmail(r.email)}). Unlink it there first (Profile → WhatsApp), then try again.` }]); }
      if (r.error) { return flush([{ text: 'Sorry, something went wrong. Please try again in a minute.' }]); }
      const { data: u } = await supabase.from('users').select('id, role, first_name').eq('id', v.user_id).single();
      await C.saveSession(number, { user_id: v.user_id, state: 'menu', draft: {}, sim, last_inbound_at: new Date().toISOString() });
      say({ text: `✅ Done! Your WhatsApp number is verified and linked to your IdeaHub account${u && u.first_name ? ', ' + u.first_name : ''}.` });
      if (u && CREATOR_ROLES.includes(u.role)) say(menu(u, false));
      else say({ text: `You can now get help from IdeaHub here. Listing ideas from WhatsApp is for Idea Creator accounts.` });
      for (const x of replies) await C.send(number, x, { sim, userId: v.user_id });
      return replies;
    }

    // 2. Who is this?
    const u = await C.userByNumber(number);
    if (!u) {
      say({ text: `Hi${input.name ? ' ' + clip(input.name, 30) : ''}! This is *IdeaHub*, the marketplace for business ideas.\n\nTo list ideas from WhatsApp, link this number to your account:\n1. Log in at ${SITE}/profile\n2. Tap *Verify WhatsApp* and send the message it opens.\n\nNo account yet? Join free: ${SITE}/signup` });
      for (const x of replies) await C.send(number, x, { sim });
      return replies;
    }
    let s = await C.getSession(number);
    const fresh = !s || s.user_id !== u.id || (Date.now() - new Date(s.updated_at || 0).getTime()) > DRAFT_DAYS * 86400000;
    if (fresh) s = { wa_number: number, user_id: u.id, state: 'menu', draft: {}, sim };
    s.sim = sim;
    await C.saveSession(number, { user_id: u.id, state: s.state, draft: s.draft || {}, sim, last_inbound_at: new Date().toISOString() });
    const d = s.draft || {};
    const isCreator = CREATOR_ROLES.includes(u.role);
    const hasDraft = !!(d.title);
    const out = async list => { for (const x of list) await C.send(number, x, { sim, userId: u.id }); return list; };

    // Commands that work anywhere
    if (['menu', 'hi', 'hello', 'start', 'home'].includes(cmd)) { await C.saveSession(number, { user_id: u.id, state: 'menu', draft: d, sim }); return out([menu(u, hasDraft)]); }
    if (cmd === 'help') return out([HELP, menu(u, hasDraft)]);
    if (cmd === 'mine' || cmd === 'myideas') return out([await myIdeas(u)]);
    if (cmd === 'cancel' || cmd === 'stop') {
      await C.saveSession(number, { user_id: u.id, state: 'menu', draft: {}, sim });
      return out([{ text: hasDraft ? 'Draft deleted. Nothing was listed.' : 'OK.' }, menu(u, false)]);
    }
    if (cmd === 'new' || cmd === 'continue' || cmd === 'list' || cmd === 'listanidea' || cmd === 'listanewidea') {
      if (!isCreator) return out([{ text: `Listing ideas is for Idea Creator accounts. You can switch your role on the website: ${SITE}/switch-role` }]);
      if (cmd === 'continue' && hasDraft) {
        const at = STEPS.find(st => !done(st, d)) || 'review';
        return out(await ask(number, s, at, { text: 'Welcome back. Let\'s carry on.' }));
      }
      s.draft = {};
      return out(await ask(number, s, 'title', { text: 'Great, let\'s list your idea. It takes about 5 minutes. Type *back* to go to the previous question or *cancel* to stop.' }));
    }
    if (cmd === 'back' && STEPS.includes(s.state)) {
      const i = STEPS.indexOf(s.state);
      return out(await ask(number, s, STEPS[Math.max(0, i - 1)]));
    }
    if (cmd === 'back' && ['review', 'agree'].includes(s.state)) return out(await ask(number, s, 'photos'));

    // The step we are on
    const state = s.state || 'menu';
    if (state === 'menu' || !isCreator) {
      if (!isCreator) return out([{ text: `Hi ${u.first_name || ''}! Listing ideas from WhatsApp is for Idea Creator accounts. You can switch your role at ${SITE}/switch-role, or use the website for everything else.` }]);
      return out([menu(u, hasDraft)]);
    }

    if (state === 'title' || state === 'summary') {
      if (input.type !== 'text' || !text) return out([prompt(state, d)]);
      const value = text.replace(/\s+/g, ' ').slice(0, state === 'title' ? 120 : 400);
      const probe = { ...d, [state]: value };
      const q = blockingFor(state, probe);
      if (q.block.length) return out([{ text: '✋ ' + q.block.join(' ') + '\n\nPlease send it again.' }]);
      d[state] = value;
      s.draft = d;
      return out(await ask(number, s, nextStep(s, state), q.warn.length ? { text: '💡 Tip: ' + q.warn.join(' ') + ' (You can change it at the end.)' } : null));
    }

    if (state === 'desc') {
      if (cmd === 'done') {
        const q = blockingFor('desc', d);
        if (q.block.length) return out([{ text: '✋ ' + q.block.join(' ') }, prompt('desc', d)]);
        return out(await ask(number, s, nextStep(s, 'desc'), q.warn.length ? { text: '💡 Tip: ' + q.warn.join(' ') } : null));
      }
      if (input.type !== 'text' || !text) return out([prompt('desc', d)]);
      if (d._edit && !d._descStarted) { d.desc = ''; d._descStarted = true; }
      d.desc = ((d.desc ? d.desc + '\n\n' : '') + text).slice(0, 10000);
      s.draft = d;
      await C.saveSession(number, { user_id: u.id, state: 'desc', draft: d, sim });
      return out([{ text: `Got it (${d.desc.length} characters so far). Send more, or tap *Done*.`, buttons: [{ id: 'done', title: 'Done' }] }]);
    }

    if (state === 'industry') {
      const v = pick(INDUSTRIES, input, 'ind_');
      if (!v) return out([{ text: 'Please reply with a number from the list.' }, prompt('industry', d)]);
      d.industry = v; s.draft = d;
      return out(await ask(number, s, nextStep(s, 'industry')));
    }
    if (state === 'type') {
      const v = pick(TYPES, input, 'type_');
      if (!v) return out([prompt('type', d)]);
      d.ideaType = v; s.draft = d;
      return out(await ask(number, s, nextStep(s, 'type')));
    }
    if (state === 'countries') {
      if (cmd === 'all') d.countries = ['ALL'];
      else {
        const r = parseCountries(text);
        if (r.all) d.countries = ['ALL'];
        else if (!r.found.length) return out([{ text: 'I couldn\'t recognise those countries. Type full country names separated by commas, or tap *All countries*.', buttons: [{ id: 'all', title: 'All countries' }] }]);
        else if (r.unknown.length) {
          return out([{ text: `I didn't recognise: ${r.unknown.slice(0, 5).join(', ')}. Please type the list again with full country names.\n(I understood: ${r.found.join(', ')})`, buttons: [{ id: 'all', title: 'All countries' }] }]);
        } else d.countries = r.found;
      }
      s.draft = d;
      return out(await ask(number, s, nextStep(s, 'countries')));
    }
    if (state === 'price') {
      const n = parseFloat(text.replace(/usd|us\$|\$|,|\s/gi, ''));
      if (!(n >= 1) || n > 10000000) return out([{ text: 'Please send the price as a number of US dollars, at least 1. Example: 1500' }]);
      d.price = Math.round(n * 100) / 100; s.draft = d;
      const tip = d.price < 10 ? { text: '💡 A price under $10 can look like a test listing. You can change it at the end.' } : null;
      return out(await ask(number, s, nextStep(s, 'price'), tip));
    }
    if (state === 'visibility') {
      const id = input.replyId || '';
      const t = norm(text);
      const v = id.startsWith('vis_') ? parseInt(id.slice(4), 10) : t.startsWith('every') || t === '1' ? 1 : t.startsWith('verif') || t === '2' ? 2 : t.startsWith('priv') || t === '3' ? 3 : null;
      if (!VISIBILITY[v]) return out([prompt('visibility', d)]);
      d.visibility = v; s.draft = d;
      return out(await ask(number, s, nextStep(s, 'visibility')));
    }
    if (state === 'photos') {
      if (input.type === 'image') {
        d.images = d.images || [];
        if (d.images.length >= 3) return out([{ text: 'You already have 3 photos.', buttons: [{ id: 'done', title: 'Done' }] }]);
        const url = await (opts.saveImage || saveImage)(supabase, u.id, input.image, sim);
        if (!url) return out([{ text: 'Sorry, I couldn\'t save that photo. Send a JPG or PNG under 5 MB, or tap Skip.', buttons: [{ id: 'skip', title: 'Skip' }] }]);
        d.images.push(url); s.draft = d;
        await C.saveSession(number, { user_id: u.id, state: 'photos', draft: d, sim });
        if (d.images.length >= 3) return out(await ask(number, s, 'review', { text: '3 photos added.' }));
        return out([{ text: `Photo ${d.images.length} added. Send another, or tap *Done*.`, buttons: [{ id: 'done', title: 'Done' }] }]);
      }
      if (cmd === 'skip' || cmd === 'done' || cmd === 'no' || cmd === 'next') return out(await ask(number, s, 'review'));
      return out([prompt('photos', d)]);
    }

    if (state === 'review') {
      if (cmd === 'submit' || cmd === 'listit' || cmd === 'yes') return out(await ask(number, s, 'agree'));
      if (cmd === 'edit' || cmd === 'changesomething') {
        await C.saveSession(number, { user_id: u.id, state: 'pick_edit', draft: d, sim });
        return out([{ text: 'What would you like to change?', list: { button: 'Choose', title: 'Change', rows: STEPS.map(st => ({ id: 'edit_' + st, title: STEP_NAME[st] })) } }]);
      }
      return out([review(d)]);
    }
    if (state === 'pick_edit') {
      const st = (input.replyId || '').startsWith('edit_') ? input.replyId.slice(5) : STEPS.find(x => norm(STEP_NAME[x]) === norm(text));
      if (!STEPS.includes(st)) return out([{ text: 'Please choose from the list.' }]);
      d._edit = true; delete d._descStarted; s.draft = d;
      if (st === 'photos') d.images = [];
      return out(await ask(number, s, st, st === 'desc' ? { text: 'Send the new description (it replaces the old one).' } : null));
    }
    if (state === 'agree') {
      if (cmd === 'terms' || cmd === 'readitinfull') return out([{ text: ideaTerms.TEXT }, AGREE]);
      if (cmd !== 'agree' && cmd !== 'iagreelistit' && cmd !== 'iagree') return out([AGREE]);
      if (limited('submit:' + u.id, 10, 3600000)) return out([{ text: 'You have listed a lot of ideas in the last hour. Please try again later.' }]);
      const clean = { ...d }; delete clean._edit; delete clean._descStarted;
      const r = await createIdea(u.id, clean);
      if (r.error) {
        await C.saveSession(number, { user_id: u.id, state: 'review', draft: d, sim });
        return out([{ text: '✋ The listing needs a change before it can go live:\n' + r.error }, review(d)]);
      }
      await C.saveSession(number, { user_id: u.id, state: 'menu', draft: {}, sim });
      C.log(number, u.id, 'event', 'idea_listed', `idea ${r.idea.id}`, null);
      followUp(number, r.idea.id, sim);
      return out([{ text: `🎉 *Your idea is listed!*\n${SITE}/idea?id=${r.idea.id}\n\nWe're running the originality check now and I'll message you the result in a few minutes. You can add photos, extras and patent details on the website any time: ${SITE}/submit?edit=${r.idea.id}`, buttons: [{ id: 'new', title: 'List another idea' }, { id: 'mine', title: 'My ideas' }] }]);
    }
    return out([menu(u, hasDraft)]);
  }
  function done(step, d) {
    return ({ title: !!d.title, summary: !!d.summary, desc: !!d.desc && (d.desc || '').length >= 50, industry: !!d.industry, type: !!d.ideaType, countries: !!(d.countries && d.countries.length), price: !!d.price, visibility: !!d.visibility, photos: false })[step];
  }

  return { handle, core: C };
}

// Download a WhatsApp photo and store it like a website upload
async function saveImage(supabase, userId, image, sim) {
  if (!image || !image.id || sim || !live()) return null;
  try {
    const meta = await fetch(`${API()}/${image.id}`, { headers: { Authorization: `Bearer ${process.env.WA_TOKEN}` } }).then(r => r.json());
    if (!meta.url || !/^image\/(jpeg|png|webp)$/.test(meta.mime_type || '') || Number(meta.file_size) > 5 * 1024 * 1024) return null;
    const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.WA_TOKEN}` } });
    if (!bin.ok) return null;
    const buf = Buffer.from(await bin.arrayBuffer());
    const ext = meta.mime_type.split('/')[1];
    const name = `idea-${userId}-${Date.now()}-wa.${ext}`;
    const { error } = await supabase.storage.from('idea-images').upload(name, buf, { contentType: meta.mime_type, upsert: false });
    if (error) return null;
    return supabase.storage.from('idea-images').getPublicUrl(name).data.publicUrl;
  } catch (e) { console.error('WhatsApp photo:', e.message); return null; }
}

// Meta webhook → our input shape
function parseWebhook(body) {
  const out = [];
  for (const e of (body && body.entry) || []) for (const ch of e.changes || []) {
    const v = ch.value || {};
    const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile && c.profile.name]));
    for (const m of v.messages || []) {
      const base = { from: m.from, name: names[m.from] || null, msgId: m.id };
      if (m.type === 'text') out.push({ ...base, type: 'text', text: (m.text && m.text.body) || '' });
      else if (m.type === 'interactive' && m.interactive) {
        const r = m.interactive.button_reply || m.interactive.list_reply || {};
        out.push({ ...base, type: 'reply', replyId: r.id, text: r.title || '' });
      } else if (m.type === 'button' && m.button) out.push({ ...base, type: 'reply', replyId: norm(m.button.payload || m.button.text), text: m.button.text });
      else if (m.type === 'image' && m.image) out.push({ ...base, type: 'image', image: { id: m.image.id, mime: m.image.mime_type }, text: m.image.caption || '' });
      else out.push({ ...base, type: 'other', text: '' });
    }
  }
  return out;
}

// ── routes ───────────────────────────────────────────────────────────────────
function mount(app, { supabase, authMiddleware }) {
  const B = bot(supabase);
  const C = B.core;
  async function isAdmin(id) { const { data } = await supabase.from('users').select('role').eq('id', id).single(); return data && data.role === 'admin'; }

  // Meta checks the webhook URL once
  app.get('/api/whatsapp/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && process.env.WA_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge'] || ''));
    res.sendStatus(403);
  });
  // Incoming messages
  app.post('/api/whatsapp/webhook', async (req, res) => {
    const secret = process.env.WA_APP_SECRET;
    if (!secret) { console.error('WhatsApp webhook: WA_APP_SECRET is not set; ignoring.'); return res.sendStatus(200); }
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
    res.sendStatus(200);   // answer Meta at once; work after
    for (const input of parseWebhook(req.body)) {
      if (!firstTime(input.msgId)) continue;
      if (live() && input.msgId) graph(`${process.env.WA_PHONE_ID}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: input.msgId }).catch(() => {});
      try { await B.handle(input, { sim: false }); } catch (e) { console.error('WhatsApp bot error:', e.message); }
    }
  });

  // ── Profile: verify + link ──
  app.get('/api/whatsapp/status', authMiddleware, async (req, res) => {
    const { data: u } = await supabase.from('users').select('phone, phone_verified, whatsapp_number, whatsapp_linked_at').eq('id', req.user.id).single();
    const { data: v } = await supabase.from('wa_verifications').select('kind, expires_at').eq('user_id', req.user.id).maybeSingle();
    res.json({
      linked: !!(u && u.whatsapp_number), number: u && u.whatsapp_number ? '+' + u.whatsapp_number : null, linked_at: u && u.whatsapp_linked_at,
      phone_verified: !!(u && u.phone_verified), phone: u && u.phone,
      pending: v && new Date(v.expires_at) > new Date() ? v.kind : null,
      bot_number: botNumber() ? '+' + botNumber() : null, mode: live() ? 'live' : 'simulator',
      can_send_code: !!process.env.WA_OTP_TEMPLATE && live()
    });
  });
  // A code the user sends to us from WhatsApp (free)
  app.post('/api/whatsapp/link-code', authMiddleware, async (req, res) => {
    if (limited('linkcode:' + req.user.id, 10, 3600000)) return res.status(429).json({ error: 'Too many tries. Please wait a while.' });
    const code = newCode();
    const expires = new Date(Date.now() + LINK_TTL_MIN * 60000).toISOString();
    await supabase.from('wa_verifications').delete().eq('user_id', req.user.id);
    const { error } = await supabase.from('wa_verifications').insert([{ user_id: req.user.id, kind: 'inbound', code, expires_at: expires, attempts: 0 }]);
    if (error) return res.status(500).json({ error: error.message });
    const message = `IdeaHub code ${code.slice(0, 4)}-${code.slice(4)} (sending this verifies my WhatsApp number)`;
    res.json({ code: code.slice(0, 4) + '-' + code.slice(4), message, expires_at: expires, bot_number: botNumber() ? '+' + botNumber() : null, wa_link: botNumber() ? `https://wa.me/${botNumber()}?text=${encodeURIComponent(message)}` : null, mode: live() ? 'live' : 'simulator' });
  });
  // Paid fallback: we send a code with an approved authentication template
  app.post('/api/whatsapp/send-code', authMiddleware, async (req, res) => {
    if (!process.env.WA_OTP_TEMPLATE || !live()) return res.status(400).json({ error: 'Please use "Verify WhatsApp" and send us the message instead.' });
    const number = digits(req.body && req.body.phone);
    if (number.length < 8 || number.length > 15) return res.status(400).json({ error: 'Enter your WhatsApp number with the country code, e.g. +94 77 123 4567.' });
    if (limited('otp:' + req.user.id, 3, 3600000) || limited('otpn:' + number, 3, 3600000)) return res.status(429).json({ error: 'Too many codes requested. Please wait an hour.' });
    const other = await C.userByNumber(number);
    if (other && other.id !== req.user.id) return res.status(400).json({ error: 'This WhatsApp number is already linked to another IdeaHub account.' });
    const code = String(crypto.randomInt(100000, 1000000));
    await supabase.from('wa_verifications').delete().eq('user_id', req.user.id);
    await supabase.from('wa_verifications').insert([{ user_id: req.user.id, kind: 'outbound', phone: number, code_hash: hash(code), expires_at: new Date(Date.now() + 10 * 60000).toISOString(), attempts: 0 }]);
    const ok = await C.send(number, { template: { name: process.env.WA_OTP_TEMPLATE, language: { code: process.env.WA_OTP_LANG || 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] } }, { userId: req.user.id });
    if (!ok) return res.status(502).json({ error: 'We couldn\'t send a WhatsApp message to that number. Check it has WhatsApp and includes the country code.' });
    res.json({ sent: true, number: maskNumber(number) });
  });
  app.post('/api/whatsapp/verify-code', authMiddleware, async (req, res) => {
    const code = digits(req.body && req.body.code);
    const { data: v } = await supabase.from('wa_verifications').select('*').eq('user_id', req.user.id).eq('kind', 'outbound').maybeSingle();
    if (!v) return res.status(400).json({ error: 'Request a new code first.' });
    if (new Date(v.expires_at) < new Date()) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    if ((v.attempts || 0) >= 5) return res.status(400).json({ error: 'Too many wrong codes. Request a new one.' });
    const a = Buffer.from(hash(code)), b = Buffer.from(String(v.code_hash || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await supabase.from('wa_verifications').update({ attempts: (v.attempts || 0) + 1 }).eq('user_id', req.user.id);
      return res.status(400).json({ error: 'That code is not right. Please check and try again.' });
    }
    const r = await C.linkNumber(req.user.id, v.phone);
    if (r.error) return res.status(400).json({ error: r.error === 'taken' ? 'This WhatsApp number is already linked to another IdeaHub account.' : r.error });
    res.json({ ok: true, number: '+' + v.phone });
  });
  app.post('/api/whatsapp/unlink', authMiddleware, async (req, res) => {
    const { data: u } = await supabase.from('users').select('whatsapp_number').eq('id', req.user.id).single();
    if (u && u.whatsapp_number) await supabase.from('wa_sessions').delete().eq('wa_number', u.whatsapp_number);
    // The number stays verified on the profile; it just stops working with the bot
    await supabase.from('users').update({ whatsapp_number: null, whatsapp_linked_at: null }).eq('id', req.user.id);
    res.json({ ok: true });
  });

  // ── Simulator (admins) ──
  app.post('/api/whatsapp/sim', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req.user.id))) return res.status(403).json({ error: 'Admins only.' });
    const b = req.body || {};
    const from = digits(b.from);
    if (from.length < 8) return res.status(400).json({ error: 'Enter a test number with the country code.' });
    const input = b.reply_id ? { from, name: b.name, type: 'reply', replyId: String(b.reply_id), text: String(b.reply_title || '') }
      : b.image ? { from, name: b.name, type: 'image', image: { id: 'sim' }, text: '' }
      : { from, name: b.name, type: 'text', text: String(b.text || '').slice(0, 4096) };
    await B.handle(input, { sim: true });
    const q = outbox.get(from) || []; outbox.delete(from);
    res.json({ replies: q });
  });
  app.get('/api/whatsapp/sim', authMiddleware, async (req, res) => {
    if (!(await isAdmin(req.user.id))) return res.status(403).json({ error: 'Admins only.' });
    const from = digits(req.query.from);
    const q = outbox.get(from) || []; outbox.delete(from);
    res.json({ replies: q, mode: live() ? 'live' : 'simulator', bot_number: botNumber() ? '+' + botNumber() : null });
  });
}

module.exports = { mount, bot, core, parseWebhook, toGraph, parseCountries, outbox, newCode };
