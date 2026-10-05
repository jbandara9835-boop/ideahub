/* ─────────────────────────────────────────────────────────────────────────────
   listing-quality.js — one set of listing rules, used in two places:
     • the submit page (live checklist as the creator types)   <script src="/listing-quality.js">
     • the server (POST/PUT /api/ideas), so the rules can't be skipped
                                                                 require('./public/listing-quality')
   checkListing(listing, { priceGuide }) → { score, grade, blocking, items[] }
   item = { id, level: 'block' | 'warn' | 'tip' | 'ok', field, message }
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ListingQuality = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var PENALTY = { block: 25, warn: 10, tip: 3, ok: 0 };

  // Placeholder / throwaway titles ("Test", "Hi", "Idea 1", "asdf", "Untitled")
  var PLACEHOLDER = /^\s*(test(ing)?|hi|hello|hey|asdf+|qwerty|idea\s*#?\d*|my idea|new idea|untitled|sample|demo|xx+|abc|aaa+|\d+)\s*[.!?]*\s*$/i;
  // Contact details in public text let buyers and sellers skip escrow
  var EMAIL = /[A-Z0-9._%+-]+\s*(@|\(at\)|\[at\])\s*[A-Z0-9.-]+\s*(\.|\(dot\)|\[dot\])\s*[A-Z]{2,}/i;
  var URL = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(com|net|org|io|co|lk|in|me|app|biz|info)\b/i;
  var PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
  var SOCIAL = /\b(whats\s?app|viber|telegram|wechat|imo|signal)\b|\bcall\s+me\b|\bcontact\s+me\s+(at|on|via)\b/i;

  function str(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()); }
  function hasContact(text) {
    if (!text) return null;
    if (EMAIL.test(text)) return 'an email address';
    if (URL.test(text)) return 'a website link';
    var p = text.match(PHONE);
    if (p && p[1].replace(/\D/g, '').length >= 9) return 'a phone number';
    if (SOCIAL.test(text)) return 'a messaging app or "contact me" details';
    return null;
  }
  function mostlyCaps(text) {
    var letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length < 10) return false;
    return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
  }
  function words(text) { return text.split(/\s+/).filter(Boolean).length; }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  function checkListing(l, opts) {
    l = l || {}; opts = opts || {};
    var items = [];
    var add = function (id, level, field, message) { items.push({ id: id, level: level, field: field, message: message }); };
    var title = str(l.title), summary = str(l.summary), desc = str(l.desc != null ? l.desc : l.description);
    var price = Number(l.price);

    // ── Title ──
    if (!title) add('title_missing', 'block', 'title', 'Add a title.');
    else if (PLACEHOLDER.test(title)) add('title_placeholder', 'block', 'title', 'Use a real title that says what the idea is, not "' + title.slice(0, 30) + '".');
    else if (title.length < 10 || words(title) < 2) add('title_short', 'block', 'title', 'Make the title a little longer (at least 2 words and 10 characters) so buyers know what it is.');
    else if (mostlyCaps(title)) add('title_caps', 'warn', 'title', 'Avoid writing the title in capitals; it reads as shouting.');
    else if (title.length < 25) add('title_specific', 'tip', 'title', 'A more specific title (who it is for, what it does) gets more clicks.');
    else add('title_ok', 'ok', 'title', 'Clear title.');
    var tc = hasContact(title);
    if (tc) add('title_contact', 'block', 'title', 'Remove ' + tc + ' from the title. Contact happens through IdeaHub messages so the deal stays protected by escrow.');

    // ── Summary (public) ──
    if (!summary) add('summary_missing', 'block', 'summary', 'Add a one-sentence summary. It is what buyers read before deciding.');
    else if (summary.toLowerCase() === title.toLowerCase()) add('summary_same', 'warn', 'summary', 'The summary repeats the title. Say what problem it solves or what makes it different.');
    else if (summary.length < 40) add('summary_short', 'warn', 'summary', 'Expand the summary (40+ characters): the problem, and who would buy it.');
    else add('summary_ok', 'ok', 'summary', 'Good summary.');
    var sc = hasContact(summary);
    if (sc) add('summary_contact', 'block', 'summary', 'Remove ' + sc + ' from the summary. Buyers contact you through IdeaHub messages so the deal stays protected by escrow.');

    // ── Full description (shared after payment) ──
    if (desc.length < 50) add('desc_missing', 'block', 'desc', 'Write the full description (at least 50 characters). It is what the buyer pays for, shared only after payment is held in escrow.');
    else if (desc.length < 200) add('desc_short', 'warn', 'desc', 'The description is short. Explain how it works, the target market and the first steps (200+ characters).');
    else if (desc.length < 500) add('desc_more', 'tip', 'desc', 'Good start. More detail (costs, competitors, how to launch) makes buyers more confident and reduces disputes.');
    else add('desc_ok', 'ok', 'desc', 'Detailed description.');

    // ── Category ──
    if (!str(l.industry)) add('industry_missing', 'block', 'industry', 'Choose an industry so buyers can find it.');

    // ── Price ──
    if (!(price >= 1)) add('price_missing', 'block', 'price', 'Enter a price of at least $1.');
    else {
      var g = opts.priceGuide;
      if (price < 10) add('price_low', 'warn', 'price', 'A price under $10 can look like a test listing. Make sure it is intentional.');
      else if (g && g.count >= 5 && g.p25 > 0 && price > g.p75 * 5) add('price_high', 'warn', 'price', 'This is far above similar ' + (l.industry || '') + ' ideas (most are ' + money(g.p25) + '–' + money(g.p75) + '). Explain the value in the summary, or adjust the price.');
      else if (g && g.count >= 5 && price < g.p25 / 5) add('price_under', 'tip', 'price', 'This is well below similar ideas (most are ' + money(g.p25) + '–' + money(g.p75) + '). You may be underselling it.');
      else add('price_ok', 'ok', 'price', g && g.count >= 5 ? 'Price is in a normal range for ' + l.industry + ' (' + money(g.p25) + '–' + money(g.p75) + ').' : 'Price set.');
    }

    // ── Extras ──
    var imgs = Array.isArray(l.images) ? l.images.length : 0;
    if (!imgs) add('images_none', 'tip', 'images', 'Add a photo, sketch or mock-up. Listings with a picture stand out in Browse.');
    else add('images_ok', 'ok', 'images', imgs + ' image' + (imgs > 1 ? 's' : '') + ' added.');
    if (l.hasPatent && !str(l.patentNumber)) add('patent_number', 'warn', 'patent', 'You marked a patent but gave no patent number.');
    if (l.engagements && typeof l.engagements === 'object') {
      var n = Object.keys(l.engagements).length;
      if (!n) add('engagement_none', 'tip', 'engagements', 'Offer at least a video call to explain the idea. Buyers trust creators who stay involved.');
      else add('engagement_ok', 'ok', 'engagements', n + ' way' + (n > 1 ? 's' : '') + ' to work with the buyer offered.');
    }

    // Don't praise a field that also has a blocking problem
    var blockedFields = {};
    items.forEach(function (i) { if (i.level === 'block') blockedFields[i.field] = true; });
    items = items.filter(function (i) { return !(i.level === 'ok' && blockedFields[i.field]); });

    var score = 100;
    items.forEach(function (i) { score -= PENALTY[i.level] || 0; });
    score = Math.max(0, Math.min(100, score));
    var blocking = items.filter(function (i) { return i.level === 'block'; });
    var warns = items.some(function (i) { return i.level === 'warn'; });
    var grade = blocking.length ? 'Needs fixes' : (score >= 90 && !warns) ? 'Excellent' : score >= 75 ? 'Good' : score >= 55 ? 'Fair' : 'Weak';
    return { score: score, grade: grade, blocking: blocking, items: items };
  }

  return { checkListing: checkListing, hasContact: hasContact };
});
