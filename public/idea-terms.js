/* ─────────────────────────────────────────────────────────────────────────────
   idea-terms.js — the standard Idea Transfer Agreement accepted at checkout.
     browser: <script src="/idea-terms.js">  → window.IdeaTerms
     server:  require('./public/idea-terms')
   The version and full text are stored on each transaction when the buyer accepts.
   Change the text → bump VERSION (old deals keep the text they accepted).
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IdeaTerms = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var VERSION = 'v1';
  var POINTS = [
    'Transfer. When the payment is released to the seller, the seller transfers to the buyer all of the seller\'s rights, title and interest in the idea and in the materials delivered for it, including the right to use, develop, sell and license it.',
    'Seller\'s promises. The seller confirms the idea is their own work or that they have the right to sell it, and that, as far as they know, it does not copy anyone else\'s protected work.',
    'Exclusivity. After the sale the seller will not sell, license or publish the same idea to anyone else, and will not keep it listed on Picela or elsewhere.',
    'Confidentiality. Both sides keep the full description and delivered materials confidential, except with their own professional advisers.',
    'Patents. A patent or patent application is not part of this transfer unless the listing says so; patents are transferred separately with an attorney.',
    'Extras. Any extras chosen at checkout (video call, prototype, supply, etc.) are provided as described on the listing and agreed in Picela messages.',
    'No guarantee of success. The buyer decides how to use the idea. Neither Picela nor the seller guarantees that it will succeed commercially.',
    'Escrow and disputes. Payment is held by Picela until the buyer confirms delivery, or 7 days after delivery without a dispute. If there is a dispute, Picela reviews the messages and files and decides to release or refund.',
    'Law. This agreement is governed by the laws of Sri Lanka.'
  ];
  var TEXT = 'IDEA TRANSFER AGREEMENT (' + VERSION + ')\n\nThis agreement is between the seller and the buyer of the idea named on this page, made through Picela (picela.co, run by Picela (Pvt) Ltd), which hosts the payment but is not a party to the transfer.\n\n' +
    POINTS.map(function (p, i) { return (i + 1) + '. ' + p; }).join('\n\n');
  return { VERSION: VERSION, POINTS: POINTS, TEXT: TEXT };
});
