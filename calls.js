// ─────────────────────────────────────────────────────────────────────────────
// calls.js — built-in video calls (Daily.co Prebuilt)
//
// Railway variable: DAILY_API_KEY  (Daily dashboard → Developers → API key)
//
// Every call belongs to something the user is already part of:
//   message  → an accepted call request in a 1-to-1 chat   (messages.id)
//   group    → an accepted call request in a group chat     (group_messages.id)
//   patent   → a patent application (creator + attorney)     (patent_applications.id)
//   mandate  → a manager mandate: hiring interview (opens 15 min before the agreed time) or a call while active
// The server checks membership, creates a PRIVATE Daily room that expires, and
// gives each person a personal meeting token. Nobody can join with just the link.
// Video and audio go directly between browsers and Daily; nothing passes through
// our server.
//
// server.js:  require('./calls').mount(app, { supabase, authMiddleware, escrow });
// ─────────────────────────────────────────────────────────────────────────────
const DAILY = 'https://api.daily.co/v1';
const HOUR = 3600 * 1000;
const EARLY_MIN = 15; // a scheduled call opens 15 minutes before its time

const callPath = (type, id) => `/call?type=${type}&id=${id}`;
const isSafeLink = l => typeof l === 'string' && (/^https:\/\/[^\s"'<>]+$/i.test(l) || /^\/call\?type=(message|group|patent|licence|room|hire|expansion|mandate)&id=\d+$/.test(l));

function mount(app, { supabase, authMiddleware, escrow }) {
  const key = () => process.env.DAILY_API_KEY || '';

  async function daily(path, body) {
    const r = await fetch(DAILY + path, { method: 'POST', headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.info || d.error || `Daily error ${r.status}`);
    return d;
  }

  const name = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Picela member' : 'Picela member';
  async function users(ids) {
    const { data } = await supabase.from('users').select('id, first_name, last_name').in('id', ids);
    return Object.fromEntries((data || []).map(u => [u.id, u]));
  }

  // Who may join, when, and what the call is called. Returns { error } or { participants, title, opensAt, expiresAt, max }
  async function context(type, id, userId) {
    const now = Date.now();
    if (type === 'message') {
      const { data: m } = await supabase.from('messages').select('id, from_id, to_id, type, call_status, call_date').eq('id', id).single();
      if (!m || m.type !== 'call_request' || ![m.from_id, m.to_id].includes(userId)) return { error: 'Call not found.', status: 404 };
      if (m.call_status !== 'accepted') return { error: m.call_status === 'declined' ? 'This call was declined.' : 'This call has not been accepted yet.', status: 400 };
      const other = m.from_id === userId ? m.to_id : m.from_id;
      const u = await users([other]);
      const at = m.call_date ? new Date(m.call_date).getTime() : now;
      return { participants: [m.from_id, m.to_id], title: `Call with ${name(u[other])}`, opensAt: at - EARLY_MIN * 60000, expiresAt: Math.max(at, now) + 4 * HOUR, max: 4, back: `/messages?user=${other}` };
    }
    if (type === 'group') {
      const { data: m } = await supabase.from('group_messages').select('id, conversation_id, type, call_status, call_date').eq('id', id).single();
      if (!m || m.type !== 'call_request') return { error: 'Call not found.', status: 404 };
      const { data: mem } = await supabase.from('group_members').select('user_id, status').eq('conversation_id', m.conversation_id);
      const members = (mem || []).filter(x => x.status === 'approved').map(x => x.user_id);
      if (!members.includes(userId)) return { error: 'Call not found.', status: 404 };
      if (m.call_status !== 'accepted') return { error: 'This call has not been accepted yet.', status: 400 };
      const at = m.call_date ? new Date(m.call_date).getTime() : now;
      return { participants: members, title: 'Group call', opensAt: at - EARLY_MIN * 60000, expiresAt: Math.max(at, now) + 4 * HOUR, max: 10, back: '/messages' };
    }
    if (type === 'patent') {
      const { data: a } = await supabase.from('patent_applications').select('id, title, creator_id, attorney_id, status').eq('id', id).single();
      if (!a || ![a.creator_id, a.attorney_id].includes(userId)) return { error: 'Call not found.', status: 404 };
      if (['declined', 'cancelled', 'refunded'].includes(a.status)) return { error: 'This application is closed.', status: 400 };
      return { participants: [a.creator_id, a.attorney_id], title: `Call about "${a.title}"`, opensAt: 0, expiresAt: now + 3 * HOUR, max: 4, back: `/patent-application?id=${a.id}` };
    }
    if (type === 'hire') {
      const { data: h } = await supabase.from('hire_requests').select('id, title, client_id, support_id, status').eq('id', id).single();
      if (!h || ![h.client_id, h.support_id].includes(userId)) return { error: 'Call not found.', status: 404 };
      if (['rejected', 'cancelled'].includes(h.status)) return { error: 'This hire is closed.', status: 400 };
      return { participants: [h.client_id, h.support_id], title: `Call about "${h.title}"`, opensAt: 0, expiresAt: now + 3 * HOUR, max: 4, back: `/hire?id=${h.id}` };
    }
    if (type === 'expansion') {
      const { data: x } = await supabase.from('expansion_applications').select('id, investor_id, listing_id, status').eq('id', id).single();
      const { data: b } = x ? await supabase.from('business_listings').select('owner_id, business_name').eq('id', x.listing_id).single() : { data: null };
      if (!x || !b || ![x.investor_id, b.owner_id].includes(userId)) return { error: 'Call not found.', status: 404 };
      if (['withdrawn', 'rejected'].includes(x.status)) return { error: 'This application is closed.', status: 400 };
      return { participants: [x.investor_id, b.owner_id], title: `Call about "${b.business_name}"`, opensAt: 0, expiresAt: now + 3 * HOUR, max: 6, back: `/expansion?id=${x.id}` };
    }
    if (type === 'room') {
      const { data: room } = await supabase.from('deal_rooms').select('id, title, status').eq('id', id).single();
      const { data: mem } = await supabase.from('deal_room_members').select('user_id, status').eq('room_id', id);
      const ids = (mem || []).filter(m => m.status === 'active' && m.user_id).map(m => m.user_id);
      if (!room || !ids.includes(userId)) return { error: 'Call not found.', status: 404 };
      return { participants: ids, title: `Deal room: ${room.title}`, opensAt: 0, expiresAt: now + 3 * HOUR, max: 12, back: `/deal-room?id=${room.id}` };
    }
    if (type === 'licence') {
      const { data: d } = await supabase.from('licence_deals').select('id, idea_title, licensor_id, licensee_id, status').eq('id', id).single();
      if (!d || ![d.licensor_id, d.licensee_id].includes(userId)) return { error: 'Call not found.', status: 404 };
      if (['declined', 'cancelled'].includes(d.status)) return { error: 'This deal is closed.', status: 400 };
      return { participants: [d.licensor_id, d.licensee_id], title: `Call about licensing "${d.idea_title}"`, opensAt: 0, expiresAt: now + 3 * HOUR, max: 6, back: `/licence?id=${d.id}` };
    }
    if (type === 'mandate') {
      const { data: m } = await supabase.from('mandates').select('id, title, client_id, manager_id, status').eq('id', id).single();
      if (!m || ![m.client_id, m.manager_id].includes(userId)) return { error: 'Call not found.', status: 404 };
      if (!['proposed', 'active'].includes(m.status)) return { error: 'This mandate is closed.', status: 400 };
      const { data: iv } = await supabase.from('mandate_interviews').select('chosen_at').eq('mandate_id', m.id).eq('status', 'scheduled');
      const times = (iv || []).map(x => new Date(x.chosen_at).getTime()).filter(t => t + 3 * HOUR > now).sort((a, b) => a - b);
      if (m.status === 'proposed' && !times.length) return { error: 'Agree a time for the video interview on the mandate page first.', status: 400 };
      const at = times.length ? times[0] : now;
      return { participants: [m.client_id, m.manager_id], title: `${m.status === 'proposed' ? 'Interview' : 'Call'}: ${m.title}`, opensAt: m.status === 'proposed' ? at - EARLY_MIN * 60000 : 0, expiresAt: Math.max(at, now) + 3 * HOUR, max: 4, back: `/mandate?id=${m.id}` };
    }
    return { error: 'Unknown call type.', status: 400 };
  }

  // Join (creates the room if needed) → { url, token, title, back }
  app.post('/api/calls/join', authMiddleware, async (req, res) => {
    const type = String(req.body?.type || ''), id = parseInt(req.body?.id, 10);
    if (!id) return res.status(400).json({ error: 'Missing call.' });
    const ctx = await context(type, id, req.user.id);
    if (ctx.error) return res.status(ctx.status || 400).json({ error: ctx.error });
    if (Date.now() < ctx.opensAt) {
      return res.status(425).json({ error: 'This call opens 15 minutes before the scheduled time.', code: 'too_early', opens_at: new Date(ctx.opensAt).toISOString() });
    }
    if (!key()) return res.status(503).json({ error: 'Video calls are being set up. Please try again later.', code: 'video_not_configured' });

    try {
      const { data: existing } = await supabase.from('video_calls').select('*').eq('context_type', type).eq('context_id', id).single();
      let call = existing && new Date(existing.expires_at).getTime() > Date.now() + 10 * 60000 ? existing : null;
      if (!call) {
        const exp = Math.floor(ctx.expiresAt / 1000);
        const room = await daily('/rooms', {
          name: `ih-${type[0]}${id}-${Math.random().toString(36).slice(2, 8)}`,
          privacy: 'private',
          properties: { exp, eject_at_room_exp: true, max_participants: ctx.max, enable_chat: true, enable_screenshare: true, enable_prejoin_ui: true, enable_knocking: false }
        });
        const row = { context_type: type, context_id: id, room_name: room.name, room_url: room.url, created_by: req.user.id, expires_at: new Date(exp * 1000).toISOString() };
        if (existing) { await supabase.from('video_calls').update(row).eq('id', existing.id); call = { ...existing, ...row }; }
        else {
          const { data, error } = await supabase.from('video_calls').insert([row]).select().single();
          if (error) { // someone else created it at the same moment: use theirs
            const { data: again } = await supabase.from('video_calls').select('*').eq('context_type', type).eq('context_id', id).single();
            if (!again) throw error;
            call = again;
          } else call = data;
        }
      }
      const { data: me } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
      const tokenExp = Math.min(Math.floor(new Date(call.expires_at).getTime() / 1000), Math.floor(Date.now() / 1000) + 4 * 3600);
      const t = await daily('/meeting-tokens', { properties: { room_name: call.room_name, user_name: name(me), user_id: String(req.user.id), exp: tokenExp } });

      // Patent calls have no call request, so ring the other person (at most every 10 minutes)
      if (['patent', 'licence', 'room', 'hire', 'expansion', 'mandate'].includes(type) && (!existing || !existing.last_rung_at || Date.now() - new Date(existing.last_rung_at).getTime() > 10 * 60000 || existing.room_name !== call.room_name)) {
        for (const uid of ctx.participants.filter(x => x && x !== req.user.id)) {
          await escrow.notify(uid, { type: 'call_now', title: '📹 Video call started', message: `${name(me)} started a video call: ${ctx.title.replace(/^Call about /, '')}. Join now.`, link: callPath(type, id) });
        }
        await supabase.from('video_calls').update({ last_rung_at: new Date().toISOString() }).eq('id', call.id);
      }
      await supabase.from('video_calls').update({ last_joined_at: new Date().toISOString() }).eq('id', call.id);
      res.json({ url: call.room_url, token: t.token, title: ctx.title, back: ctx.back, expires_at: call.expires_at });
    } catch (e) {
      console.error('Video call error:', e.message);
      res.status(502).json({ error: 'Could not start the video call. Please try again in a moment.' });
    }
  });

  // Small status check for pages (is video available?)
  app.get('/api/calls/config', (req, res) => res.json({ enabled: !!key() }));

  return { callPath, isSafeLink };
}

module.exports = { mount, callPath, isSafeLink };
