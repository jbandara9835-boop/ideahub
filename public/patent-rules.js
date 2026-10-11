/* ─────────────────────────────────────────────────────────────────────────────
   patent-rules.js — shared patent rules for the browser and the server
     browser: <script src="/patent-rules.js">   → window.PatentRules
     server:  require('./public/patent-rules')
   Plain guidance only; the attorney confirms the right route for each case.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PatentRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Patent offices a practitioner can be registered with
  var OFFICES = {
    NIPO:  { label: 'Sri Lanka (NIPO)', country: 'Sri Lanka' },
    USPTO: { label: 'United States (USPTO)', country: 'United States', register: 'https://oedci.uspto.gov/OEDCI/' },
    EPO:   { label: 'Europe (EPO)', country: null },
    UKIPO: { label: 'United Kingdom (UKIPO)', country: 'United Kingdom' },
    IPIN:  { label: 'India (IPO)', country: 'India' },
    IPAU:  { label: 'Australia (IP Australia)', country: 'Australia' },
    IPOS:  { label: 'Singapore (IPOS)', country: 'Singapore' }
  };
  // Where the creator can file. office null = any registered practitioner may handle it (PCT goes through a home office).
  var JURISDICTIONS = [
    { label: 'Sri Lanka (NIPO)', office: 'NIPO' },
    { label: 'United States (USPTO)', office: 'USPTO' },
    { label: 'Europe (EPO)', office: 'EPO' },
    { label: 'United Kingdom (UKIPO)', office: 'UKIPO' },
    { label: 'India (IPO)', office: 'IPIN' },
    { label: 'Australia (IP Australia)', office: 'IPAU' },
    { label: 'Singapore (IPOS)', office: 'IPOS' },
    { label: 'International (PCT)', office: null },
    { label: 'Other / not sure', office: null }
  ];
  var JUR_LABELS = JURISDICTIONS.map(function (j) { return j.label; });
  function officeFor(jurisdiction) { for (var i = 0; i < JURISDICTIONS.length; i++) if (JURISDICTIONS[i].label === jurisdiction) return JURISDICTIONS[i].office; return null; }

  // Each piece of patent work is a stage. filing = it produces an application number from a patent office.
  var STAGES = {
    advise:        { label: 'First filing (attorney to advise route)', filing: true, first: true },
    search:        { label: 'Patentability search and opinion', filing: false, refLabel: 'Report reference (optional)', proof: 'search report', done: 'Report delivered' },
    provisional:   { label: 'Provisional application', filing: true, first: true },
    complete:      { label: 'Complete / non-provisional application', filing: true, first: true },
    pct:           { label: 'International (PCT) application', filing: true, first: true },
    national:      { label: 'National phase entry', filing: true },
    design:        { label: 'Design registration', filing: true, first: true },
    office_action: { label: 'Response to an examiner (office action)', filing: false, refLabel: 'Office action reference (optional)', proof: 'filed response', done: 'Response filed' },
    grant:         { label: 'Grant and issue fee', filing: false, refLabel: 'Patent number', refRequired: true, proof: 'grant certificate', done: 'Granted' },
    other:         { label: 'Other patent work', filing: false, refLabel: 'Reference (optional)', proof: 'deliverable', done: 'Delivered' }
  };
  // Filing types offered in the application form → stage
  var FILING_TYPES = [
    { label: 'Provisional application', stage: 'provisional', help: 'Secures an early filing date quickly and cheaply. The full application is due within 12 months. Not every country offers it.' },
    { label: 'Complete / non-provisional application', stage: 'complete', help: 'The full application with claims, examined by the patent office.' },
    { label: 'International (PCT) application', stage: 'pct', help: 'One filing that keeps your options open in 150+ countries for about 30 months.' },
    { label: 'Design registration', stage: 'design', help: 'Protects how a product looks, not how it works.' },
    { label: 'Patentability search first', stage: 'search', help: 'An attorney searches existing patents and tells you whether filing is worth it.' },
    { label: 'Not sure, please advise', stage: 'advise', help: 'The attorney recommends the right route in their quote.' }
  ];
  var FILING_LABELS = FILING_TYPES.map(function (f) { return f.label; });
  function stageForFilingType(label) { for (var i = 0; i < FILING_TYPES.length; i++) if (FILING_TYPES[i].label === label) return FILING_TYPES[i].stage; return 'advise'; }
  var NEXT_STAGES = ['search', 'provisional', 'complete', 'pct', 'national', 'office_action', 'grant', 'design', 'other'];
  var QUOTE_STAGES = ['search', 'provisional', 'complete', 'pct', 'design']; // what an attorney can choose when asked to advise

  var COUNTRIES = ['Sri Lanka', 'India', 'United States', 'United Kingdom', 'Australia', 'Singapore', 'Other'];
  var MARKETS = ['Sri Lanka', 'India', 'United States', 'United Kingdom', 'Europe', 'Australia', 'Singapore', 'Other countries', 'Worldwide / not sure'];
  var HOME = { 'Sri Lanka': 'Sri Lanka (NIPO)', 'India': 'India (IPO)', 'United States': 'United States (USPTO)', 'United Kingdom': 'United Kingdom (UKIPO)', 'Australia': 'Australia (IP Australia)', 'Singapore': 'Singapore (IPOS)' };
  var MARKET_JUR = { 'Sri Lanka': 'Sri Lanka (NIPO)', 'India': 'India (IPO)', 'United States': 'United States (USPTO)', 'United Kingdom': 'United Kingdom (UKIPO)', 'Europe': 'Europe (EPO)', 'Australia': 'Australia (IP Australia)', 'Singapore': 'Singapore (IPOS)' };

  // Suggests a filing route from where the applicant lives and where they want to sell.
  // Returns { jurisdiction, filing_type, title, steps[], notes[] }
  function recommend(opts) {
    opts = opts || {};
    var home = opts.residence, markets = (opts.markets || []).slice();
    var homeJur = HOME[home] || null;
    var foreign = markets.filter(function (m) { return m !== home; });
    var worldwide = foreign.indexOf('Worldwide / not sure') >= 0 || foreign.indexOf('Other countries') >= 0;
    var abroadCount = worldwide ? 99 : foreign.length;
    var notes = [], steps = [], r = {};
    var isUS = home === 'United States';

    if (!markets.length) return null;
    if (abroadCount === 0) {
      r = { jurisdiction: homeJur || 'Other / not sure', filing_type: isUS ? 'Provisional application' : 'Not sure, please advise', title: 'Protect it at home' };
      steps.push('File with ' + (homeJur || 'your national patent office') + ' to protect it where you sell.');
      if (isUS) steps.push('File the full (non-provisional) application within 12 months of the provisional.');
    } else if (abroadCount === 1 && homeJur) {
      var target = MARKET_JUR[foreign[0]] || foreign[0];
      r = { jurisdiction: homeJur, filing_type: isUS ? 'Provisional application' : 'Not sure, please advise', title: 'Home first, then ' + foreign[0] };
      steps.push('File with ' + homeJur + ' first. This sets your priority date, usually at the lowest cost.');
      steps.push('Within 12 months, file in ' + target + ' claiming that date.');
    } else if (homeJur) {
      r = { jurisdiction: homeJur, filing_type: isUS ? 'Provisional application' : 'Not sure, please advise', title: 'Home first, then PCT' };
      steps.push('File with ' + homeJur + ' first to set your priority date.');
      steps.push('Within 12 months, file one international (PCT) application.');
      steps.push('At about 30 months from the first filing, choose the countries and enter the national phase in each. The big costs come here, so you have time to test the market.');
    } else {
      r = { jurisdiction: 'International (PCT)', filing_type: 'International (PCT) application', title: 'Start with PCT' };
      steps.push('File an international (PCT) application, or ask the attorney about filing in your own country first.');
      steps.push('At about 30 months, enter the national phase in the countries you want.');
    }
    var wantsUS = markets.indexOf('United States') >= 0 || worldwide;
    if (wantsUS && !isUS) notes.push('Since 20 July 2026, applicants living outside the US must file in the US through a USPTO-registered patent attorney or agent. IdeaHub only shows registered practitioners for US filings.');
    if (home === 'India' && abroadCount > 0) notes.push('Indian residents generally must file in India first, or get permission, before filing abroad. Your attorney will check.');
    else if (abroadCount > 0) notes.push('Some countries require you to file at home first or get permission before filing abroad. Your attorney will check this for you.');
    notes.push('Keep the invention confidential until it is filed. Most countries refuse a patent for anything already made public.');
    r.steps = steps; r.notes = notes;
    return r;
  }

  // US fee discounts (attorney confirms). Returns { level: 'micro'|'small'|'large'|null, text }
  function usEntity(e) {
    e = e || {};
    if (e.employees_500 === undefined) return { level: null, text: '' };
    if (e.employees_500 === true || e.assigned_large === true) return { level: 'large', text: 'Standard USPTO fees probably apply.' };
    if (e.prior_apps_over_4 === false && e.income_over_limit === false && e.assigned_large === false)
      return { level: 'micro', text: 'You may qualify as a micro entity: about 80% off most USPTO fees.' };
    return { level: 'small', text: 'You may qualify as a small entity: about 60% off most USPTO fees.' };
  }

  function addMonths(dateStr, months) {
    var d = new Date(dateStr + 'T00:00:00Z');
    var day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
    var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }

  // Deadlines created automatically when a stage is completed.
  // ctx: { stage, date (YYYY-MM-DD), jurisdiction, priorityDate (earliest filing in the case or null), firstFiling (bool) }
  function autoDeadlines(ctx) {
    var out = [], d = ctx.date;
    if (!d) return out;
    if (ctx.stage === 'provisional') out.push({ kind: 'priority', due: addMonths(d, 12), title: 'File the full application and/or PCT', note: '12 months from the provisional filing. Missing it loses the provisional filing date.' });
    else if ((ctx.stage === 'complete' || ctx.stage === 'advise') && ctx.firstFiling) out.push({ kind: 'priority', due: addMonths(d, 12), title: 'Last day to file abroad with this filing date', note: '12 months from the first filing (Paris Convention / PCT).' });
    else if (ctx.stage === 'design' && ctx.firstFiling) out.push({ kind: 'priority', due: addMonths(d, 6), title: 'Last day to file the design abroad with this date', note: '6 months from the first design filing (Paris Convention).' });
    if (ctx.stage === 'pct') out.push({ kind: 'national_phase', due: addMonths(ctx.priorityDate || d, 30), title: 'Enter the national phase', note: '30 months from the first filing in most countries (31 in some). Choose the countries before this date.' });
    if (ctx.stage === 'grant') {
      if (officeFor(ctx.jurisdiction) === 'USPTO') {
        [[42, '3.5'], [90, '7.5'], [138, '11.5']].forEach(function (m) {
          out.push({ kind: 'maintenance', due: addMonths(d, m[0]), title: 'US maintenance fee (' + m[1] + ' years)', note: 'Can be paid from 6 months before. A 6-month grace period with a surcharge follows; after that the patent lapses.' });
        });
      } else out.push({ kind: 'renewal', due: addMonths(d, 12), title: 'Check renewal fees', note: 'Most offices charge yearly renewal fees to keep a patent in force. Confirm the schedule with your attorney.' });
    }
    return out;
  }

  return { OFFICES: OFFICES, JURISDICTIONS: JURISDICTIONS, JUR_LABELS: JUR_LABELS, officeFor: officeFor, STAGES: STAGES, FILING_TYPES: FILING_TYPES, FILING_LABELS: FILING_LABELS,
    stageForFilingType: stageForFilingType, NEXT_STAGES: NEXT_STAGES, QUOTE_STAGES: QUOTE_STAGES, COUNTRIES: COUNTRIES, MARKETS: MARKETS,
    recommend: recommend, usEntity: usEntity, addMonths: addMonths, autoDeadlines: autoDeadlines };
});
