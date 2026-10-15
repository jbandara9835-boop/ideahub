// ─────────────────────────────────────────────────────────────────────────────
// security.js — sign-in sessions, rate limits and small safety helpers
//
// Sessions: every login token carries the account's token_version (tv). Changing
// or resetting the password, "log out everywhere", suspension, deactivation and
// deletion all bump token_version, which ends every older login at once.
// Needs the columns in security.sql; until that runs, sessions behave as before.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let supabase = null;
let columnsReady = true;           // false until security.sql has been run
const stateCache = new Map();      // userId -> { at, st }
const STATE_TTL = 30 * 1000;

function init(sb) { supabase = sb; return module.exports; }

// ── Visitor IP ──
// Cloudflare sets cf-connecting-ip and it can't be faked through Cloudflare;
// direct hits on the Railway address are refused (see originLock), so it is trustworthy.
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

// ── Rate limits (in memory; one Railway instance) ──
const hits = new Map();
function recent(key, ms) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < ms);
  hits.set(key, list);
  return list;
}
/** Counts this attempt; true when it goes over `max` in the window. */
function limited(key, max, ms) {
  const list = recent(key, ms);
  if (list.length >= max) return true;
  list.push(Date.now());
  return false;
}
/** True when `key` already has `max` hits in the window (doesn't count one). */
function over(key, max, ms) { return recent(key, ms).length >= max; }
function hit(key) { const l = hits.get(key) || []; l.push(Date.now()); hits.set(key, l); }
function clear(key) { hits.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.length || now - l[l.length - 1] > 24 * 3600 * 1000) hits.delete(k); }, 3600 * 1000).unref();

// ── Account state (session version, suspension, deactivation, deletion) ──
const DEFAULT_STATE = { token_version: 0, suspended: false, deactivated_at: null, deleted_at: null };
async function accountState(id, fresh) {
  if (!columnsReady || !supabase || !id) return DEFAULT_STATE;
  const c = stateCache.get(id);
  if (!fresh && c && Date.now() - c.at < STATE_TTL) return c.st;
  const { data, error } = await supabase.from('users').select('token_version, suspended, deactivated_at, deleted_at').eq('id', id).single();
  if (error && /column|does not exist|schema cache/i.test(error.message || '')) {
    columnsReady = false;
    console.warn('security.js: run security.sql in Supabase to turn on session control, suspension and account deletion.');
    return DEFAULT_STATE;
  }
  if (!data) {
    // No such account → its logins are void. Any other database hiccup must not sign everyone out.
    if (error && error.code === 'PGRST116') { const st = { ...DEFAULT_STATE, deleted_at: 'missing' }; stateCache.set(id, { at: Date.now(), st }); return st; }
    return DEFAULT_STATE;
  }
  const st = { ...DEFAULT_STATE, ...data, token_version: Number(data.token_version) || 0 };
  stateCache.set(id, { at: Date.now(), st });
  return st;
}
function forget(id) { stateCache.delete(id); }
const ready = () => columnsReady;

const SESSION_MSG = {
  ended: 'Your session has ended. Please sign in again.',
  suspended: 'This account is suspended. Contact support@ideahub.it.com if you think this is a mistake.',
  gone: 'This account no longer exists.'
};
/** Checks a decoded token against the account. → { ok } or { ok:false, code, status } */
async function check(decoded) {
  if (!decoded || !decoded.id || decoded.purpose) return { ok: false, code: 'ended', status: 401 };
  const st = await accountState(decoded.id);
  if (st.deleted_at) return { ok: false, code: 'gone', status: 401 };
  if (st.suspended) return { ok: false, code: 'suspended', status: 403 };
  // Server-made helper tokens (2-minute, svc) act for the user and skip the version check
  if (!decoded.svc && (Number(decoded.tv) || 0) !== st.token_version) return { ok: false, code: 'ended', status: 401 };
  return { ok: true };
}
/** For routes that work signed in or out: the decoded token, or null. */
async function viewer(req) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return null;
  let d; try { d = jwt.verify(t, process.env.JWT_SECRET); } catch { return null; }
  return (await check(d)).ok ? d : null;
}
async function middleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  let d;
  try { d = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  if (!d || !d.id || d.purpose) return res.status(401).json({ error: 'Invalid token' }); // e.g. a Google sign-up ticket is not a login
  const c = await check(d);
  if (!c.ok) return res.status(c.status).json({ error: SESSION_MSG[c.code], code: 'session_' + c.code });
  req.user = d;
  next();
}

function issue(user) {
  return jwt.sign({ id: user.id, email: user.email, tv: Number(user.token_version) || 0 }, process.env.JWT_SECRET, { expiresIn: '7d' });
}
/** Short-lived token the server uses to call its own routes for a user. */
function service(id) { return jwt.sign({ id, svc: 1 }, process.env.JWT_SECRET, { expiresIn: '2m' }); }

/** Ends every login of this account. Returns the new version (null before security.sql). */
async function bump(id, extra) {
  if (!columnsReady) { if (extra) await supabase.from('users').update(extra).eq('id', id); return null; }
  const st = await accountState(id, true);
  const tv = (st.token_version || 0) + 1;
  const { error } = await supabase.from('users').update({ token_version: tv, ...(extra || {}) }).eq('id', id);
  forget(id);
  if (error) { console.error('bump session:', error.message); return null; }
  return tv;
}

// ── Passwords ──
const COMMON = new Set(('password,password1,password123,12345678,123456789,1234567890,qwerty123,qwertyuiop,11111111,00000000,' +
  'iloveyou,abc12345,abcd1234,admin123,welcome1,welcome123,letmein1,sunshine,princess,football,baseball,monkey123,' +
  'dragon123,master123,trustno1,passw0rd,p@ssw0rd,p@ssword,ideahub1,ideahub123,picela123,srilanka,srilanka1,colombo1,' +
  '87654321,12341234,1q2w3e4r,1qaz2wsx,qwer1234,asdf1234,zxcvbnm1,superman,batman123,whatever,changeme,computer').split(','));
function passwordProblem(p) {
  p = String(p || '');
  if (p.length < 8) return 'Use a password of at least 8 characters.';
  if (p.length > 128) return 'That password is too long (128 characters at most).';
  if (COMMON.has(p.toLowerCase()) || /^(.)\1+$/.test(p)) return 'That password is too easy to guess. Choose a less common one.';
  return null;
}

// ── Text that goes into a database filter: keep letters, digits and spaces only ──
function filterText(q, max) {
  return String(q || '').replace(/[%_,()*\\.:"'`;<>{}\[\]|&=!?#$^~+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60);
}

// ── Uploads ──
/** Real image type from the file's first bytes (ignores what the browser claimed). */
function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
function safeFileName(n) {
  const s = String(n || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(-80);
  return s || 'file';
}

// ── Admin sign-in code (second step for admin logins) ──
const challenges = new Map(); // id -> { userId, hash, exp, tries }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function adminCodeOn() { return String(process.env.ADMIN_2FA || 'on').toLowerCase() !== 'off'; }
function newChallenge(userId) {
  for (const [k, c] of challenges) if (c.exp < Date.now()) challenges.delete(k);
  const id = crypto.randomBytes(18).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  challenges.set(id, { userId, hash: sha(id + code), exp: Date.now() + 10 * 60 * 1000, tries: 0 });
  return { id, code };
}
/** → userId when the code is right; otherwise { error } */
function solveChallenge(id, code) {
  const c = challenges.get(String(id || ''));
  if (!c || c.exp < Date.now()) { challenges.delete(String(id || '')); return { error: 'This code has expired. Please sign in again.' }; }
  if (++c.tries > 5) { challenges.delete(id); return { error: 'Too many wrong codes. Please sign in again.' }; }
  const a = Buffer.from(sha(id + String(code || '').replace(/\D/g, ''))), b = Buffer.from(c.hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'That code is not right. Check the latest email and try again.' };
  challenges.delete(id);
  return { userId: c.userId };
}

// ── Requests that skipped Cloudflare (the Railway address) ──
function originLock(req, res, next) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!/\.railway\.app$/.test(host) || String(process.env.ALLOW_RAILWAY_HOST || '').toLowerCase() === 'on') return next();
  if (req.path === '/api/health') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(403).json({ error: 'Please use https://ideahub.it.com' });
  return res.redirect(301, 'https://ideahub.it.com' + req.originalUrl);
}

// ── Standard security headers ──
function headers(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (req.headers['x-forwarded-proto'] === 'https' || req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ── Which websites may call the API from a browser ──
const ALLOWED_ORIGINS = ['https://ideahub.it.com', 'https://www.ideahub.it.com', 'https://picela.co', 'https://www.picela.co'];
function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true);                       // same-site page loads, server-to-server, apps
  const extra = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ALLOWED_ORIGINS.includes(origin) || extra.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
  return cb(null, false);                                   // no CORS headers: the browser blocks the reply
}

module.exports = {
  init, clientIp, limited, over, hit, clear, accountState, forget, ready, check, viewer, middleware, issue, service, bump,
  passwordProblem, filterText, imageType, safeFileName, adminCodeOn, newChallenge, solveChallenge, originLock, headers, corsOrigin, SESSION_MSG
};
