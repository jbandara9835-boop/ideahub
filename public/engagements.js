/* ─────────────────────────────────────────────────────────────────────────────
   engagements.js — the engagement levels a creator can offer with an idea.
   Shared by the submit page, the idea page, Browse and the server.
     browser: <script src="/engagements.js">   → window.Engagements
     server:  require('./public/engagements')
   Stored on ideas.engagements as { video_call: { pricing, price, note }, ... }
   pricing: 'free' (included) | 'fixed' (added at checkout) | 'quote' (price on request)
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engagements = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var LEVELS = [
    { key: 'video_call', icon: '📹', label: 'Explain it on a video call', short: 'Video call',
      help: 'Walk the buyer through the idea and answer questions live.' },
    { key: 'meet_in_person', icon: '🤝', label: 'Meet the buyer in person', short: 'Meet in person',
      help: 'A face-to-face meeting.', warning: 'In-person meetings happen outside IdeaHub. We are not responsible for them, so meet in a public place.' },
    { key: 'prototype', icon: '🧪', label: 'Sell the prototype', short: 'Prototype',
      help: 'Hand over a working prototype or sample with the idea.' },
    { key: 'supplier', icon: '🏭', label: 'Make the product and supply it', short: 'Supplier',
      help: 'Produce and supply the product to the buyer.' },
    { key: 'sales_support', icon: '📈', label: 'Help until the product sells', short: 'Sales support',
      help: 'Stay involved until the buyer is selling the product.' },
    { key: 'partnership', icon: '👥', label: 'Join the buyer as a partner', short: 'Partnership',
      help: 'Build the business together as a partner.' }
  ];
  var BY_KEY = {};
  LEVELS.forEach(function (l) { BY_KEY[l.key] = l; });
  var MAX_PRICE = 10000000;

  // Cleans whatever the browser sent into the stored shape. Unknown keys are dropped.
  function sanitize(input) {
    var out = {};
    if (!input || typeof input !== 'object') return out;
    LEVELS.forEach(function (l) {
      var v = input[l.key];
      if (!v || typeof v !== 'object' || v.offered === false) return;
      var pricing = ['free', 'fixed', 'quote'].indexOf(v.pricing) >= 0 ? v.pricing : 'quote';
      var price = Math.round(Number(v.price) * 100) / 100;
      if (pricing === 'fixed' && !(price >= 1 && price <= MAX_PRICE)) pricing = 'quote';
      out[l.key] = {
        pricing: pricing,
        price: pricing === 'fixed' ? price : null,
        note: String(v.note == null ? '' : v.note).replace(/\s+/g, ' ').trim().slice(0, 200)
      };
    });
    return out;
  }

  // Returns the levels offered, in the standard order, with their definitions
  function offered(engagements) {
    var e = engagements || {};
    return LEVELS.filter(function (l) { return e[l.key]; }).map(function (l) {
      var v = e[l.key];
      return { key: l.key, icon: l.icon, label: l.label, short: l.short, help: l.help, warning: l.warning || null, pricing: v.pricing, price: v.price, note: v.note || '' };
    });
  }

  // Validates the buyer's chosen add-ons. Free ones are always included; quote ones can't be bought here.
  function addOns(engagements, chosenKeys) {
    var e = engagements || {}, chosen = Array.isArray(chosenKeys) ? chosenKeys : [];
    var items = [], total = 0, errors = [];
    offered(e).forEach(function (o) {
      if (o.pricing === 'free') items.push({ key: o.key, label: o.label, price: 0 });
      else if (o.pricing === 'fixed' && chosen.indexOf(o.key) >= 0) { items.push({ key: o.key, label: o.label, price: o.price }); total += o.price; }
    });
    chosen.forEach(function (k) {
      var v = e[k];
      if (!v) errors.push('"' + k + '" is not offered for this idea.');
      else if (v.pricing === 'quote') errors.push((BY_KEY[k] ? BY_KEY[k].short : k) + ' is priced on request — agree it with the creator in messages first.');
    });
    return { items: items, total: Math.round(total * 100) / 100, errors: errors };
  }

  function priceLabel(o) {
    if (o.pricing === 'free') return 'Included';
    if (o.pricing === 'fixed') return '+$' + Number(o.price).toLocaleString('en-US');
    return 'Price on request';
  }

  return { LEVELS: LEVELS, BY_KEY: BY_KEY, sanitize: sanitize, offered: offered, addOns: addOns, priceLabel: priceLabel };
});
