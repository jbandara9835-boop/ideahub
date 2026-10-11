/* ─────────────────────────────────────────────────────────────────────────────
   expansion-routes.js — the ways a business can expand, shared by the listing
   form, the directory, the business page and the server.
     browser: <script src="/expansion-routes.js">  → window.Routes
     server:  require('./public/expansion-routes')

   A listing has:
     direction  'offer' (we offer this opportunity) | 'seek' (we are looking for a partner)
     route      one of 5 groups (grow into new markets, horizontal, backward, forward, brand)
     expansion_types  one or more deal forms inside that route
     details    route-specific facts (see FIELDS)
     confidential  true → the public sees only an anonymous summary; the full listing opens
                   after the owner approves a signed confidentiality agreement
   Old listings used franchise/license/joint_venture/distribution/white_label; those keys are kept.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Routes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var GROUPS = [
    { key: 'markets', icon: '🌍', label: 'Grow into new markets', short: 'New markets',
      help: 'Replicate a proven business in new places: franchises and licences.' },
    { key: 'horizontal', icon: '🤝', label: 'Horizontal integration', short: 'Horizontal',
      help: 'Combine with a business at the same level: mergers, acquisitions, stakes, joint ventures.' },
    { key: 'backward', icon: '🏭', label: 'Vertical integration: towards supply', short: 'Backward (supply)',
      help: 'Secure inputs: acquire or partner with suppliers and manufacturers.' },
    { key: 'forward', icon: '🚚', label: 'Vertical integration: towards customers', short: 'Forward (distribution)',
      help: 'Reach customers: distributors, dealers, agents and retail partners.' },
    { key: 'brand', icon: '🏷️', label: 'Product & brand extension', short: 'Brand extension',
      help: 'Put products under other brands, or brands on other products: white label, private label, co-branding.' }
  ];
  // offer = wording when the lister offers it; seek = wording when the lister is looking for it.
  // sym = both sides are the same kind of party (either direction matches either direction).
  // conf = an 'offer' listing of this form must be confidential (selling a business or shares).
  var TYPES = [
    { key: 'franchise', group: 'markets', label: 'Franchise', offer: 'Offering franchises', seek: 'Looking to take a franchise', a: 'Franchisor', b: 'Franchisee' },
    { key: 'master_franchise', group: 'markets', label: 'Master / area franchise', offer: 'Offering master or area franchise rights', seek: 'Looking for master or area franchise rights', a: 'Franchisor', b: 'Master franchisee' },
    { key: 'license', group: 'markets', label: 'Brand or IP licence', offer: 'Licensing out our brand or know-how', seek: 'Looking to license a brand or know-how', a: 'Licensor', b: 'Licensee' },

    { key: 'merger', group: 'horizontal', label: 'Merger', offer: 'Open to a merger', seek: 'Looking for a merger partner', sym: true, conf: true, a: 'Party', b: 'Party' },
    { key: 'acquisition', group: 'horizontal', label: 'Sale of the business', offer: 'Selling the business', seek: 'Looking to acquire a business', conf: true, a: 'Seller', b: 'Buyer' },
    { key: 'stake', group: 'horizontal', label: 'Stake / equity', offer: 'Selling a stake', seek: 'Looking to buy a stake', conf: true, a: 'Seller', b: 'Investor' },
    { key: 'joint_venture', group: 'horizontal', label: 'Joint venture', offer: 'Seeking a joint-venture partner', seek: 'Seeking a joint-venture partner', sym: true, a: 'Partner', b: 'Partner' },
    { key: 'alliance', group: 'horizontal', label: 'Strategic alliance', offer: 'Open to a strategic alliance', seek: 'Seeking a strategic alliance', sym: true, a: 'Partner', b: 'Partner' },

    { key: 'supplier_acquisition', group: 'backward', label: 'Acquire a supplier', offer: 'Open to being acquired by a customer', seek: 'Looking to acquire a supplier', conf: true, a: 'Supplier', b: 'Acquirer' },
    { key: 'supply_agreement', group: 'backward', label: 'Long-term supply', offer: 'We supply under long-term contracts', seek: 'Looking for a long-term supplier', a: 'Supplier', b: 'Buyer' },
    { key: 'contract_manufacturing', group: 'backward', label: 'Contract manufacturing', offer: 'We offer contract manufacturing', seek: 'Looking for a contract manufacturer', a: 'Manufacturer', b: 'Brand owner' },

    { key: 'distribution', group: 'forward', label: 'Distribution', offer: 'Looking for distributors', seek: 'Want to distribute products', a: 'Brand / principal', b: 'Distributor' },
    { key: 'dealership', group: 'forward', label: 'Dealership', offer: 'Appointing dealers', seek: 'Want to become a dealer', a: 'Brand / principal', b: 'Dealer' },
    { key: 'agency', group: 'forward', label: 'Sales agency', offer: 'Appointing sales agents', seek: 'Want to become a sales agent', a: 'Principal', b: 'Agent' },
    { key: 'retail_partnership', group: 'forward', label: 'Retail partnership', offer: 'Looking for retail partners', seek: 'Retailer looking for products to stock', a: 'Brand', b: 'Retailer' },
    { key: 'distributor_acquisition', group: 'forward', label: 'Acquire a distributor', offer: 'Distributor open to being acquired by a brand', seek: 'Looking to acquire a distributor or retailer', conf: true, a: 'Distributor', b: 'Acquirer' },

    { key: 'white_label', group: 'brand', label: 'White label', offer: 'We make products for white label', seek: 'Looking for a white-label maker', a: 'Maker', b: 'Brand' },
    { key: 'private_label', group: 'brand', label: 'Private label', offer: 'We make private-label products', seek: 'Looking for a private-label supplier', a: 'Maker', b: 'Retailer' },
    { key: 'co_branding', group: 'brand', label: 'Co-branding', offer: 'Seeking a co-branding partner', seek: 'Seeking a co-branding partner', sym: true, a: 'Brand', b: 'Brand' }
  ];
  var BY_KEY = {}, BY_GROUP = {};
  TYPES.forEach(function (t) { BY_KEY[t.key] = t; (BY_GROUP[t.group] = BY_GROUP[t.group] || []).push(t); });
  var GROUP = {}; GROUPS.forEach(function (g) { GROUP[g.key] = g; });

  // Deal forms that fit each other besides the same form (e.g. someone acquiring a supplier ↔ a business for sale)
  var CROSS = {
    supplier_acquisition: ['acquisition', 'stake'], distributor_acquisition: ['acquisition', 'stake'],
    acquisition: ['supplier_acquisition', 'distributor_acquisition', 'stake'], stake: ['acquisition', 'supplier_acquisition', 'distributor_acquisition'],
    supply_agreement: ['contract_manufacturing'], contract_manufacturing: ['supply_agreement', 'white_label', 'private_label'],
    white_label: ['private_label', 'contract_manufacturing'], private_label: ['white_label', 'contract_manufacturing'],
    franchise: ['master_franchise'], master_franchise: ['franchise'], distribution: ['dealership', 'agency'], dealership: ['distribution'], agency: ['distribution'],
    joint_venture: ['alliance'], alliance: ['joint_venture']
  };

  var REVENUE = ['Under $100k', '$100k – $500k', '$500k – $1M', '$1M – $5M', '$5M – $20M', 'Over $20M'];
  var PROFIT = ['Loss-making', 'Break-even', 'Under $50k', '$50k – $250k', '$250k – $1M', 'Over $1M'];
  // Route-specific facts. teaser: shown even on a confidential listing.
  var FIELDS = {
    markets: {
      offer: [
        { key: 'franchise_fee', label: 'Initial franchise / licence fee (USD)', type: 'money' },
        { key: 'royalty_pct', label: 'Ongoing royalty (% of sales)', type: 'pct' },
        { key: 'term_years', label: 'Agreement term (years)', type: 'int', max: 50 },
        { key: 'support', label: 'Training and support you give', type: 'text', max: 600, placeholder: 'e.g. 4 weeks of training, opening team, supply chain, marketing' }
      ],
      seek: [
        { key: 'target_region', label: 'Where you want to operate', type: 'line', max: 120 },
        { key: 'experience', label: 'Your experience', type: 'text', max: 600, placeholder: 'e.g. I run two cafés in Galle' }
      ]
    },
    horizontal: {
      offer: [
        { key: 'revenue_range', label: 'Annual revenue', type: 'select', options: REVENUE, teaser: true },
        { key: 'profit_range', label: 'Annual profit (EBITDA)', type: 'select', options: PROFIT, teaser: true },
        { key: 'stake_pct', label: 'Stake on offer (%)', type: 'pct', teaser: true },
        { key: 'reason', label: 'Why now', type: 'text', max: 600, placeholder: 'e.g. Founder retiring; funding a second factory' },
        { key: 'brings', label: 'What you bring, and look for in a partner', type: 'text', max: 800 }
      ],
      seek: [
        { key: 'revenue_range', label: 'Size of business you are looking for (revenue)', type: 'select', options: REVENUE, teaser: true },
        { key: 'stake_pct', label: 'Stake you want (%)', type: 'pct', teaser: true },
        { key: 'criteria', label: 'What you are looking for', type: 'text', max: 800, teaser: true, placeholder: 'e.g. A bakery chain in the Western Province with its own outlets' }
      ]
    },
    backward: {
      offer: [
        { key: 'products', label: 'What you supply or make', type: 'text', max: 600, teaser: true },
        { key: 'capacity', label: 'Capacity', type: 'line', max: 120, placeholder: 'e.g. 20 tonnes a month', teaser: true },
        { key: 'certifications', label: 'Certifications', type: 'line', max: 200, placeholder: 'e.g. ISO 22000, GMP, organic', teaser: true }
      ],
      seek: [
        { key: 'inputs_needed', label: 'What you need', type: 'text', max: 600, teaser: true, placeholder: 'e.g. Packaging film, dried spices, cocoa' },
        { key: 'volume', label: 'Volume', type: 'line', max: 120, teaser: true },
        { key: 'certifications', label: 'Certifications you require', type: 'line', max: 200, teaser: true }
      ]
    },
    forward: {
      offer: [
        { key: 'products', label: 'Products', type: 'text', max: 600, teaser: true },
        { key: 'exclusivity', label: 'Exclusivity', type: 'select', options: ['Exclusive per territory', 'Non-exclusive', 'Open to discuss'], teaser: true },
        { key: 'margin', label: 'Partner margin / commission', type: 'line', max: 120, placeholder: 'e.g. 25% trade margin' },
        { key: 'min_order', label: 'Minimum order', type: 'line', max: 120 }
      ],
      seek: [
        { key: 'products_wanted', label: 'Products you want to sell', type: 'text', max: 600, teaser: true },
        { key: 'network', label: 'Your network', type: 'text', max: 600, teaser: true, placeholder: 'e.g. 120 retail outlets across the Southern Province, 6 delivery vans' }
      ]
    },
    brand: {
      offer: [
        { key: 'products', label: 'Products you can make', type: 'text', max: 600, teaser: true },
        { key: 'min_order', label: 'Minimum order', type: 'line', max: 120, teaser: true },
        { key: 'lead_time', label: 'Lead time', type: 'line', max: 120, teaser: true },
        { key: 'certifications', label: 'Certifications', type: 'line', max: 200, teaser: true }
      ],
      seek: [
        { key: 'products_wanted', label: 'Products you want made or co-branded', type: 'text', max: 600, teaser: true },
        { key: 'volume', label: 'Volume', type: 'line', max: 120, teaser: true }
      ]
    }
  };

  function typeLabel(key, direction) { var t = BY_KEY[key]; if (!t) return key; return direction === 'seek' ? t.seek : t.offer; }
  function mustBeConfidential(direction, types) { return direction === 'offer' && (types || []).some(function (k) { return BY_KEY[k] && BY_KEY[k].conf; }); }
  function groupOf(types) { for (var i = 0; i < (types || []).length; i++) if (BY_KEY[types[i]]) return BY_KEY[types[i]].group; return null; }

  // Clean the details for a route and direction. Returns { value } or { error }
  function cleanDetails(group, direction, input) {
    var fields = (FIELDS[group] || {})[direction === 'seek' ? 'seek' : 'offer'] || [], out = {};
    input = input || {};
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], v = input[f.key];
      if (v === undefined || v === null || v === '') continue;
      if (f.type === 'money') { var n = Number(v); if (!(n >= 0 && n <= 1e9)) return { error: 'Check "' + f.label + '".' }; out[f.key] = Math.round(n * 100) / 100; }
      else if (f.type === 'pct') { var p = Number(v); if (!(p > 0 && p <= 100)) return { error: '"' + f.label + '" must be between 0 and 100.' }; out[f.key] = Math.round(p * 100) / 100; }
      else if (f.type === 'int') { var k = parseInt(v, 10); if (!(k >= 1 && k <= (f.max || 1000))) return { error: 'Check "' + f.label + '".' }; out[f.key] = k; }
      else if (f.type === 'select') { if (f.options.indexOf(String(v)) < 0) return { error: 'Choose an option for "' + f.label + '".' }; out[f.key] = String(v); }
      else out[f.key] = String(v).replace(/\r\n/g, '\n').trim().slice(0, f.max || 600);
    }
    return { value: out };
  }
  // Details that may be shown on a confidential listing
  function teaserDetails(group, direction, details) {
    var fields = (FIELDS[group] || {})[direction === 'seek' ? 'seek' : 'offer'] || [], out = {};
    fields.forEach(function (f) { if (f.teaser && details && details[f.key] !== undefined) out[f.key] = details[f.key]; });
    return out;
  }
  function fieldLabel(group, direction, key) {
    var fields = (FIELDS[group] || {})[direction === 'seek' ? 'seek' : 'offer'] || [];
    for (var i = 0; i < fields.length; i++) if (fields[i].key === key) return fields[i];
    return null;
  }
  function formatDetail(f, v) {
    if (!f) return String(v);
    if (f.type === 'money') return '$' + Number(v).toLocaleString('en-US');
    if (f.type === 'pct') return v + '%';
    if (f.type === 'int' && /years/.test(f.label)) return v + ' years';
    return String(v);
  }

  // Do two listings fit each other? Returns 0–100 (0 = no).
  function matchScore(a, b) {
    if (!a || !b || a.id === b.id || a.owner_id === b.owner_id) return 0;
    var fits = false;
    (a.expansion_types || []).forEach(function (x) {
      (b.expansion_types || []).forEach(function (y) {
        var t = BY_KEY[x]; if (!t || !BY_KEY[y]) return;
        var related = x === y || (CROSS[x] || []).indexOf(y) >= 0;
        if (!related) return;
        if (t.sym && BY_KEY[y].sym) fits = true;
        else if ((a.direction || 'offer') !== (b.direction || 'offer')) fits = true;
      });
    });
    if (!fits) return 0;
    var s = 55;
    if (a.industry && a.industry === b.industry) s += 25;
    if (a.country && a.country === b.country) s += 12;
    if (b.is_verified) s += 8;
    return Math.min(100, s);
  }

  var NDA_VERSION = 'v1';
  var NDA_TEXT = 'I agree to keep confidential everything the business shares with me through IdeaHub about this opportunity (its identity, finances, customers, suppliers and plans). I will use it only to evaluate the opportunity, will not share it except with my own professional advisers who are bound by the same duty, will not contact its staff, customers or suppliers about it without permission, and will return or delete it if asked. This applies for 2 years from today. I understand the business may enforce this agreement directly against me.';

  return { GROUPS: GROUPS, GROUP: GROUP, TYPES: TYPES, BY_KEY: BY_KEY, BY_GROUP: BY_GROUP, CROSS: CROSS, FIELDS: FIELDS, REVENUE: REVENUE, PROFIT: PROFIT,
    typeLabel: typeLabel, mustBeConfidential: mustBeConfidential, groupOf: groupOf, cleanDetails: cleanDetails, teaserDetails: teaserDetails,
    fieldLabel: fieldLabel, formatDetail: formatDetail, matchScore: matchScore, NDA_VERSION: NDA_VERSION, NDA_TEXT: NDA_TEXT };
});
