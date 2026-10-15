// ─────────────────────────────────────────────────────────────────────────────
// wall.js — IdeaWall: the free community feed (ideas, social work, life hacks, events…)
//
//   Posts      text + optional headline, up to 6 photos or 1 video, a category. Authors can
//              edit or delete; admins can remove. Contact details are blocked (people reach
//              each other through IdeaHub messages). Rate-limited.
//   Reactions  💡 Brilliant · 🔥 Hot · 🤝 I'd invest · 🌍 World changer · 👎 Needs work.
//              One per person per post; can be changed or removed. "Needs work" is counted
//              separately and never raises a post in Trending. Counts are recounted from the
//              reactions table after every change, so they can't drift.
//   Comments   up to 1000 characters; deletable by the commenter, the post author or an admin.
//   Notify     the author on a first reaction, an "I'd invest" (with a link to message), and comments.
//   Reports    members report a post with a reason. 3 different reporters hide it until an
//              admin keeps or removes it (Admin → IdeaWall).
//   Feeds      latest · trending this week · saved · one member's posts · one category · search.
//   Sharing    /wall/post/:id is a page for one post, with link previews for WhatsApp etc.
//
// server.js: require('./wall').mount(app, { supabase, authMiddleware, escrow })  — before the old wall routes
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const quality = require('./public/listing-quality');

const CATEGORIES = ['Social Work', 'Innovation', 'Life Hack', 'Event', 'Collaborators', 'Success Story', 'Other'];
const LIFE_HACK_TOPICS = ['Home', 'Food & Kitchen', 'Money', 'Health', 'Tech', 'Work & Study', 'Travel', 'Other'];
const REACTIONS = ['brilliant', 'hot', 'invest', 'world', 'needs_work'];
const POSITIVE = REACTIONS.filter(r => r !== 'needs_work');
const REPORT_REASONS = ['Spam or selling', 'Contact details', 'Offensive or abusive', 'False or misleading', 'Not related to ideas or social work', 'Other'];
const HIDE_AFTER_REPORTS = 3;
const MAX_IMAGES = 6;
const BUCKET = 'idea-images';
const SITE = (process.env.SITE_URL || 'https://ideahub.it.com').replace(/\/$/, '');
const AUTHOR = 'users(id, first_name, last_name, role, avatar_url, verification_status)';

const txt = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
const intId = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && String(n) === String(v).trim() ? n : null; };
const fullName = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'IdeaHub member' : 'IdeaHub member';
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// In-memory rate limits (one Railway instance)
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < ms);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

function mount(app, { supabase, authMiddleware, escrow }) {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const nf = res => res.status(404).json({ error: 'This post is no longer available.' });
  const mediaPrefix = () => { try { return supabase.storage.from(BUCKET).getPublicUrl('x').data.publicUrl.replace(/x$/, ''); } catch (e) { return null; } };

  async function viewerId(req) {
    const d = await require('./security').viewer(req); return d ? d.id : null;
  }
  async function roleOf(id) { if (!id) return null; const { data } = await supabase.from('users').select('role').eq('id', id).single(); return data ? data.role : null; }
  async function admins() { const { data } = await supabase.from('users').select('id').eq('role', 'admin'); return (data || []).map(a => a.id); }
  async function notify(userId, n) { try { await supabase.from('notifications').insert([{ user_id: userId, ...n }]); } catch (e) { /* never blocks */ } }

  function shape(p) {
    const u = p.users || {};
    const media = Array.isArray(p.media) && p.media.length ? p.media : (p.media_url ? [{ url: p.media_url, type: p.media_type === 'video' ? 'video' : 'image' }] : []);
    const { users, ...rest } = p;
    return {
      ...rest, media,
      first_name: u.first_name, last_name: u.last_name, role: u.role, avatar_url: u.avatar_url,
      author_verified: u.verification_status === 'verified',
      reaction_counts: p.reaction_counts || {}
    };
  }

  // Validate media sent by the browser: only files uploaded to IdeaHub storage
  function cleanMedia(list) {
    if (list == null) return { value: [] };
    if (!Array.isArray(list)) return { error: 'Photos could not be read. Please add them again.' };
    const prefix = mediaPrefix();
    const out = [];
    for (const m of list.slice(0, MAX_IMAGES + 1)) {
      const url = String(m && m.url || ''), type = m && m.type === 'video' ? 'video' : 'image';
      if (!prefix || !url.startsWith(prefix) || /["'<>\s]/.test(url)) return { error: 'Please upload photos and videos here rather than linking to them.' };
      out.push({ url, type });
    }
    const videos = out.filter(m => m.type === 'video').length;
    if (videos > 1 || (videos === 1 && out.length > 1)) return { error: 'A post can have one video, or up to 6 photos.' };
    if (out.length > MAX_IMAGES) return { error: 'Up to 6 photos per post.' };
    return { value: out };
  }

  // Check a post body (create and edit)
  async function readPost(b, uid, existing) {
    const category = CATEGORIES.includes(b.category) ? b.category : (existing && existing.category) || 'Other';
    const title = txt(b.title, 120);
    const description = txt(b.description, 5000);
    const m = cleanMedia(b.media !== undefined ? b.media : (existing ? existing.media : []));
    if (m.error) return { error: m.error };
    if (!description && !m.value.length) return { error: 'Write something, or add a photo or video.' };
    if (description.length > 0 && description.length < 2) return { error: 'Write a little more.' };
    let hackTopic = null;
    if (category === 'Life Hack') {
      if (title.length < 10) return { error: 'Give your life hack a clear headline (at least 10 characters).' };
      if (description.length < 40) return { error: 'Explain the hack (at least 40 characters) so people can try it.' };
      hackTopic = LIFE_HACK_TOPICS.includes(b.hack_topic) ? b.hack_topic : 'Other';
    }
    const contact = quality.hasContact(title) || quality.hasContact(description);
    if (contact) return { error: `Please remove ${contact}. On IdeaHub people reach you through your profile and messages, which keeps everyone safe.` };
    // "Listed on the Marketplace" link: only to the author's own live idea
    let sourceIdea = existing ? existing.source_idea_id : null;
    if (!existing && b.source_idea_id) {
      const iid = intId(b.source_idea_id);
      const { data: idea } = iid ? await supabase.from('ideas').select('id, creator_id, status').eq('id', iid).single() : { data: null };
      sourceIdea = idea && idea.creator_id === uid && ['live', 'escrow', 'sold'].includes(idea.status) ? idea.id : null;
    }
    return {
      fields: {
        title: title || null, description: description || null, category, hack_topic: hackTopic,
        media: m.value, media_url: m.value[0] ? m.value[0].url : null, media_type: m.value[0] ? m.value[0].type : 'image',
        source_idea_id: sourceIdea, is_from_idea: !!sourceIdea
      }
    };
  }

  async function recountReactions(postId) {
    const { data } = await supabase.from('wall_likes').select('reaction').eq('post_id', postId);
    const counts = {};
    for (const r of data || []) { const k = REACTIONS.includes(r.reaction) ? r.reaction : 'brilliant'; counts[k] = (counts[k] || 0) + 1; }
    const likes = POSITIVE.reduce((s, k) => s + (counts[k] || 0), 0);
    await supabase.from('wall_posts').update({ likes_count: likes, reaction_counts: counts }).eq('id', postId);
    return { likes_count: likes, reaction_counts: counts };
  }
  async function recountComments(postId) {
    const { data } = await supabase.from('wall_comments').select('id').eq('post_id', postId);
    const n = (data || []).length;
    await supabase.from('wall_posts').update({ comments_count: n }).eq('id', postId);
    return n;
  }
  async function loadPost(id) {
    const { data } = await supabase.from('wall_posts').select('*').eq('id', id).single();
    return data || null;
  }
  const visibleTo = (p, uid, role) => p && (p.status !== 'hidden' || p.user_id === uid || role === 'admin');

  async function removePost(p, byId, byAdmin) {
    for (const t of ['wall_likes', 'wall_comments', 'wall_saves', 'wall_reports']) {
      try { await supabase.from(t).delete().eq('post_id', p.id); } catch (e) { /* table may not exist yet */ }
    }
    await supabase.from('wall_posts').delete().eq('id', p.id);
    if (byAdmin && p.user_id !== byId) await notify(p.user_id, { type: 'wall_removed', title: 'A post was removed', message: `Your IdeaWall post${p.title ? ` "${p.title.slice(0, 60)}"` : ''} was removed by IdeaHub moderators because it did not follow the community guidelines.`, link: '/wall' });
  }

  // ── Uploads (photos up to 8 MB, videos up to 25 MB) ──
  const IMG = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const VID = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
  app.post('/api/wall/upload', authMiddleware, (req, res, next) => upload.single('file')(req, res, err => {
    if (err) { console.error('Wall upload (multer):', err.code || '', err.message); return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large. Photos up to 8 MB, videos up to 25 MB.' : 'Upload failed. Please try again.' }); }
    next();
  }), async (req, res) => {
    if (limited('up:' + req.user.id, 60, 3600000)) return res.status(429).json({ error: 'Too many uploads. Please wait a while.' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'Choose a photo or video.' });
    const isImg = !!IMG[f.mimetype], isVid = !!VID[f.mimetype];
    if (!isImg && !isVid) return res.status(400).json({ error: 'Use a JPG, PNG, WebP or GIF photo, or an MP4 / WebM / MOV video.' });
    if (isImg && f.size > 8 * 1024 * 1024) return res.status(400).json({ error: 'Photos can be up to 8 MB.' });
    const name = `wall/${req.user.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${IMG[f.mimetype] || VID[f.mimetype]}`;
    const { error } = await supabase.storage.from(BUCKET).upload(name, f.buffer, { contentType: f.mimetype, upsert: false });
    if (error) {
      const m = String(error.message || error.error || error);
      console.error('Wall upload (storage):', f.mimetype, f.size, m);
      const why = /size|exceed|too large|payload/i.test(m) ? `This file (${(f.size / 1048576).toFixed(1)} MB) is bigger than the storage allows. Try a smaller file.`
        : /mime|type|not supported|invalid/i.test(m) ? 'Storage does not accept this file type. Try a JPG or PNG photo, or an MP4 video.'
        : 'Upload failed. Please try again.';
      return res.status(500).json({ error: why, detail: m.slice(0, 200) });
    }
    res.json({ url: supabase.storage.from(BUCKET).getPublicUrl(name).data.publicUrl, type: isVid ? 'video' : 'image' });
  });

  // ── Feed ──
  app.get('/api/wall', async (req, res) => {
    const uid = await viewerId(req), role = await roleOf(uid);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const sort = req.query.sort === 'trending' ? 'trending' : 'latest';
    let q = supabase.from('wall_posts').select(`*, ${AUTHOR}`);
    if (req.query.category) q = q.eq('category', String(req.query.category).slice(0, 40));
    const onlyId = intId(req.query.id);
    if (onlyId) q = q.eq('id', onlyId);
    if (req.query.topic) q = q.eq('hack_topic', String(req.query.topic).slice(0, 40));
    const byUser = req.query.user_id === 'me' ? uid : intId(req.query.user_id);
    if (req.query.user_id && !byUser) return res.json({ posts: [], liked: [], saved: [], reactions: {}, has_more: false });
    if (byUser) q = q.eq('user_id', byUser);
    let savedOrder = null;
    if (req.query.saved === '1') {
      if (!uid) return res.status(401).json({ error: 'Sign in to see saved posts.' });
      const { data: sv } = await supabase.from('wall_saves').select('post_id, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(500);
      savedOrder = (sv || []).map(s => s.post_id);
      if (!savedOrder.length) return res.json({ posts: [], liked: [], saved: [], reactions: {}, has_more: false });
      q = q.in('id', savedOrder);
    }
    const search = String(req.query.search || '').replace(/[%,()*\\"'`.:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (search) {
      const words = search.split(' ').filter(w => w.length >= 2).slice(0, 4);
      if (words.length) q = q.or(words.flatMap(w => [`title.ilike.%${w}%`, `description.ilike.%${w}%`]).join(','));
    }
    // Hidden (reported) posts: only the author and admins see them. Guests are filtered in the
    // query; signed-in members are filtered below so authors still see their own.
    if (!uid) q = q.neq('status', 'hidden');

    let rows, hasMore;
    if (sort === 'trending' && !savedOrder && !onlyId) {
      // This week's most engaging posts: reactions + comments (comments count double)
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await q.gte('created_at', since).order('created_at', { ascending: false }).limit(300);
      if (error) return res.status(500).json({ error: error.message });
      const score = p => (p.likes_count || 0) + 2 * (p.comments_count || 0);
      const all = (data || []).filter(p => score(p) > 0).sort((a, b) => score(b) - score(a) || new Date(b.created_at) - new Date(a.created_at));
      rows = all.slice(offset, offset + limit); hasMore = all.length > offset + limit;
    } else {
      const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit);
      if (error) return res.status(500).json({ error: error.message });
      rows = (data || []).slice(0, limit); hasMore = (data || []).length > limit;
      if (savedOrder) rows.sort((a, b) => savedOrder.indexOf(a.id) - savedOrder.indexOf(b.id));
    }
    rows = rows.filter(p => visibleTo(p, uid, role));
    const posts = rows.map(shape);
    const ids = posts.map(p => p.id);

    // Latest two comments per post, shown under each card
    if (ids.length) {
      const { data: cs } = await supabase.from('wall_comments').select('id, post_id, user_id, text, created_at, users(id, first_name, last_name, avatar_url)').in('post_id', ids).order('created_at', { ascending: false }).limit(ids.length * 6);
      const by = {};
      for (const c of cs || []) { (by[c.post_id] = by[c.post_id] || []); if (by[c.post_id].length < 2) by[c.post_id].push(c); }
      for (const p of posts) p.recent_comments = (by[p.id] || []).reverse().map(commentShape);
    }
    let liked = [], saved = [], reactions = {};
    if (uid && ids.length) {
      const [lk, sv] = await Promise.all([
        supabase.from('wall_likes').select('post_id, reaction').eq('user_id', uid).in('post_id', ids),
        supabase.from('wall_saves').select('post_id').eq('user_id', uid).in('post_id', ids)
      ]);
      for (const l of lk.data || []) { liked.push(l.post_id); reactions[l.post_id] = REACTIONS.includes(l.reaction) ? l.reaction : 'brilliant'; }
      saved = (sv.data || []).map(s => s.post_id);
    }
    res.json({ posts, liked, saved, reactions, has_more: !!hasMore, viewer: { id: uid, is_admin: role === 'admin' } });
  });

  function commentShape(c) {
    const u = c.users || {};
    return { id: c.id, post_id: c.post_id, user_id: c.user_id, text: c.text, created_at: c.created_at, first_name: u.first_name, last_name: u.last_name, avatar_url: u.avatar_url };
  }

  // ── Create / edit / delete ──
  app.post('/api/wall', authMiddleware, async (req, res) => {
    if (limited('post:' + req.user.id, 10, 3600000)) return res.status(429).json({ error: 'You have posted a lot in the last hour. Please try again later.' });
    const r = await readPost(req.body || {}, req.user.id, null);
    if (r.error) return res.status(400).json({ error: r.error });
    const { data, error } = await supabase.from('wall_posts').insert([{ ...r.fields, user_id: req.user.id, likes_count: 0, comments_count: 0, reaction_counts: {}, status: 'visible' }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });
  app.put('/api/wall/:id', authMiddleware, async (req, res) => {
    const id = intId(req.params.id); const p = id && await loadPost(id);
    if (!p) return nf(res);
    if (p.user_id !== req.user.id) return res.status(403).json({ error: 'Only the author can edit this post.' });
    const r = await readPost(req.body || {}, req.user.id, p);
    if (r.error) return res.status(400).json({ error: r.error });
    const { data, error } = await supabase.from('wall_posts').update({ ...r.fields, edited_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });
  app.delete('/api/wall/:id', authMiddleware, async (req, res) => {
    const id = intId(req.params.id); const p = id && await loadPost(id);
    if (!p) return nf(res);
    const isAdmin = (await roleOf(req.user.id)) === 'admin';
    if (p.user_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'Only the author can delete this post.' });
    await removePost(p, req.user.id, isAdmin);
    res.json({ success: true });
  });

  // ── Reactions ──
  async function react(req, res, toggle) {
    const id = intId(req.params.id); const p = id && await loadPost(id);
    const role = await roleOf(req.user.id);
    if (!p || !visibleTo(p, req.user.id, role)) return nf(res);
    if (limited('react:' + req.user.id, 120, 600000)) return res.status(429).json({ error: 'Slow down a little.' });
    const { data: ex } = await supabase.from('wall_likes').select('id, reaction').eq('user_id', req.user.id).eq('post_id', id).limit(1);
    const existing = ex && ex[0];
    let want = req.body ? req.body.reaction : undefined;
    if (toggle) want = existing ? null : (REACTIONS.includes(want) ? want : 'brilliant');
    if (want !== null && !REACTIONS.includes(want)) return res.status(400).json({ error: 'Unknown reaction.' });
    if (want === null) { if (existing) await supabase.from('wall_likes').delete().eq('user_id', req.user.id).eq('post_id', id); }
    else if (existing) { if (existing.reaction !== want) await supabase.from('wall_likes').update({ reaction: want }).eq('user_id', req.user.id).eq('post_id', id); }
    else await supabase.from('wall_likes').insert([{ user_id: req.user.id, post_id: id, reaction: want }]);
    const counts = await recountReactions(id);
    // Tell the author (first reaction from this person, or an "I'd invest")
    if (want && p.user_id !== req.user.id && (!existing || (want === 'invest' && existing.reaction !== 'invest'))) {
      const { data: me } = await supabase.from('users').select('first_name, last_name').eq('id', req.user.id).single();
      const who = fullName(me), what = p.title ? `"${p.title.slice(0, 60)}"` : 'your post';
      if (want === 'invest') await notify(p.user_id, { type: 'wall_invest', title: '🤝 Someone would invest', message: `${who} reacted "I'd invest" to ${what}. Send them a message to talk.`, link: `/messages?user=${req.user.id}` });
      else if (want !== 'needs_work') await notify(p.user_id, { type: 'wall_reaction', title: 'New reaction', message: `${who} reacted to ${what}.`, link: `/wall/post/${id}` });
    }
    res.json({ reaction: want, liked: !!want, ...counts });
  }
  app.post('/api/wall/:id/react', authMiddleware, (req, res) => react(req, res, false));
  app.post('/api/wall/:id/like', authMiddleware, (req, res) => react(req, res, req.body == null || req.body.reaction === undefined));

  app.post('/api/wall/:id/save', authMiddleware, async (req, res) => {
    const id = intId(req.params.id); if (!id || !(await loadPost(id))) return nf(res);
    const { data: ex } = await supabase.from('wall_saves').select('id').eq('user_id', req.user.id).eq('post_id', id).limit(1);
    if (ex && ex.length) { await supabase.from('wall_saves').delete().eq('user_id', req.user.id).eq('post_id', id); return res.json({ saved: false }); }
    await supabase.from('wall_saves').insert([{ user_id: req.user.id, post_id: id }]);
    res.json({ saved: true });
  });

  // ── Comments ──
  app.get('/api/wall/:id/comments', async (req, res) => {
    const id = intId(req.params.id); const p = id && await loadPost(id);
    const uid = await viewerId(req), role = await roleOf(uid);
    if (!p || !visibleTo(p, uid, role)) return nf(res);
    const { data, error } = await supabase.from('wall_comments').select('id, post_id, user_id, text, created_at, users(id, first_name, last_name, avatar_url)').eq('post_id', id).order('created_at', { ascending: true }).limit(500);
    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(commentShape));
  });
  app.post('/api/wall/:id/comments', authMiddleware, async (req, res) => {
    const id = intId(req.params.id); const p = id && await loadPost(id);
    const role = await roleOf(req.user.id);
    if (!p || !visibleTo(p, req.user.id, role)) return nf(res);
    const text = txt(req.body && req.body.text, 1000);
    if (!text) return res.status(400).json({ error: 'Write a comment first.' });
    const contact = quality.hasContact(text);
    if (contact) return res.status(400).json({ error: `Please remove ${contact} from your comment. People can message each other on IdeaHub.` });
    if (limited('cmt:' + req.user.id, 20, 600000)) return res.status(429).json({ error: 'You are commenting very fast. Please wait a few minutes.' });
    const { data, error } = await supabase.from('wall_comments').insert([{ user_id: req.user.id, post_id: id, text }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const count = await recountComments(id);
    const { data: me } = await supabase.from('users').select('id, first_name, last_name, avatar_url').eq('id', req.user.id).single();
    if (p.user_id !== req.user.id) await notify(p.user_id, { type: 'wall_comment', title: '💬 New comment', message: `${fullName(me)} commented on ${p.title ? `"${p.title.slice(0, 60)}"` : 'your post'}: ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`, link: `/wall/post/${id}` });
    res.status(201).json({ ...commentShape({ ...data, users: me }), comments_count: count });
  });
  app.delete('/api/wall/comments/:cid', authMiddleware, async (req, res) => {
    const cid = intId(req.params.cid);
    const { data: c } = cid ? await supabase.from('wall_comments').select('id, post_id, user_id').eq('id', cid).single() : { data: null };
    if (!c) return res.status(404).json({ error: 'Comment not found.' });
    const p = await loadPost(c.post_id);
    const ok = c.user_id === req.user.id || (p && p.user_id === req.user.id) || (await roleOf(req.user.id)) === 'admin';
    if (!ok) return res.status(403).json({ error: 'You can only delete your own comments, or comments on your post.' });
    await supabase.from('wall_comments').delete().eq('id', cid);
    res.json({ success: true, comments_count: await recountComments(c.post_id) });
  });

  // ── Reports + admin review ──
  app.post('/api/wall/:id/report', authMiddleware, async (req, res) => {
    const id = intId(req.params.id); const p = id && await loadPost(id);
    if (!p) return nf(res);
    if (p.user_id === req.user.id) return res.status(400).json({ error: 'You can delete your own post instead.' });
    const reason = REPORT_REASONS.includes(req.body && req.body.reason) ? req.body.reason : 'Other';
    const note = txt(req.body && req.body.note, 300) || null;
    const { data: ex } = await supabase.from('wall_reports').select('id').eq('post_id', id).eq('user_id', req.user.id).limit(1);
    if (ex && ex.length) return res.json({ ok: true, already: true });
    const { error } = await supabase.from('wall_reports').insert([{ post_id: id, user_id: req.user.id, reason, note, status: 'open' }]);
    if (error) return res.status(500).json({ error: error.message });
    const { data: open } = await supabase.from('wall_reports').select('user_id').eq('post_id', id).eq('status', 'open');
    const n = new Set((open || []).map(r => r.user_id)).size;
    const patch = { report_count: n };
    if (n >= HIDE_AFTER_REPORTS && p.status !== 'hidden' && p.status !== 'kept') patch.status = 'hidden';
    await supabase.from('wall_posts').update(patch).eq('id', id);
    if (n === 1 || patch.status === 'hidden') for (const a of await admins()) await notify(a, { type: 'wall_report', title: patch.status === 'hidden' ? '🚩 IdeaWall post hidden' : '🚩 IdeaWall post reported', message: `${patch.status === 'hidden' ? `Hidden after ${n} reports` : `Reported for "${reason}"`}: ${(p.title || p.description || 'a post').slice(0, 80)}`, link: '/admin' });
    res.json({ ok: true });
  });
  app.get('/api/admin/wall/reports', authMiddleware, async (req, res) => {
    if ((await roleOf(req.user.id)) !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    const { data: reps, error } = await supabase.from('wall_reports').select('post_id, user_id, reason, note, created_at').eq('status', 'open').order('created_at', { ascending: false }).limit(500);
    if (error) return res.status(500).json({ error: error.message });
    const ids = [...new Set((reps || []).map(r => r.post_id))];
    if (!ids.length) return res.json([]);
    const { data: posts } = await supabase.from('wall_posts').select(`*, ${AUTHOR}`).in('id', ids);
    res.json((posts || []).map(shape).map(p => ({ ...p, reports: (reps || []).filter(r => r.post_id === p.id) })).sort((a, b) => b.reports.length - a.reports.length));
  });
  app.put('/api/admin/wall/:id/review', authMiddleware, async (req, res) => {
    if ((await roleOf(req.user.id)) !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    const id = intId(req.params.id); const p = id && await loadPost(id);
    if (!p) return nf(res);
    const action = req.body && req.body.action;
    if (action === 'remove') { await removePost(p, req.user.id, true); return res.json({ ok: true, removed: true }); }
    if (action !== 'keep') return res.status(400).json({ error: 'Choose keep or remove.' });
    await supabase.from('wall_reports').update({ status: 'dismissed' }).eq('post_id', id).eq('status', 'open');
    await supabase.from('wall_posts').update({ status: 'kept', report_count: 0 }).eq('id', id);
    res.json({ ok: true });
  });

  // ── One post as its own page (with a link preview for WhatsApp, Facebook, etc.) ──
  let pageCache = null;
  app.get('/wall/post/:id', async (req, res) => {
    const file = path.join(__dirname, 'public', 'wall.html');
    if (!pageCache || process.env.NODE_ENV !== 'production') pageCache = fs.readFileSync(file, 'utf8');
    const id = intId(req.params.id);
    let html = pageCache;
    const p = id ? await loadPost(id) : null;
    if (p && p.status !== 'hidden') {
      const { data: u } = await supabase.from('users').select('first_name, last_name').eq('id', p.user_id).single();
      const title = `${(p.title || (p.description || '').split('\n')[0] || 'Post').slice(0, 80)} — ${fullName(u)} on IdeaWall`;
      const desc = String(p.description || p.title || '').replace(/\s+/g, ' ').slice(0, 180);
      const media = Array.isArray(p.media) && p.media.length ? p.media : (p.media_url ? [{ url: p.media_url, type: p.media_type }] : []);
      const img = (media.find(m => m.type !== 'video') || {}).url;
      const meta = [
        `<meta property="og:type" content="article" />`,
        `<meta property="og:site_name" content="IdeaHub" />`,
        `<meta property="og:title" content="${escHtml(title)}" />`,
        `<meta property="og:description" content="${escHtml(desc)}" />`,
        `<meta property="og:url" content="${SITE}/wall/post/${p.id}" />`,
        img ? `<meta property="og:image" content="${escHtml(img)}" />` : '',
        `<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}" />`,
        `<meta name="description" content="${escHtml(desc)}" />`
      ].filter(Boolean).join('\n');
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>\n${meta}`);
    }
    res.type('html').send(html);
  });
}

module.exports = { mount, CATEGORIES, REACTIONS, LIFE_HACK_TOPICS, REPORT_REASONS };
