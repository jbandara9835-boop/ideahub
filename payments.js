// ─────────────────────────────────────────────────────────────────────────────
// payments.js — the single place where money moves (used by server.js + escrow.js)
//
// PAYMENT_PROVIDER (Railway variable):
//   'test'   (default) — no real money; checkout just records the deal
//   'paypal' — real PayPal checkout (to be connected when the account is ready)
// TEST_PURCHASES=on  — allows purchases while in test mode (for your own testing).
//                      Leave it off so real users can't "buy" ideas without paying.
//
// Every money movement is written to the `payments` ledger:
//   purchase (buyer paid into escrow) · release (seller credited) · fee (platform 8%)
//   refund (buyer refunded) · payout (withdrawal paid out to seller)
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function makePayments(supabase) {
  const provider = () => (process.env.PAYMENT_PROVIDER || 'test').toLowerCase();

  function purchasesOpen() {
    if (provider() === 'paypal') return !!process.env.PAYPAL_CLIENT_ID;
    return (process.env.TEST_PURCHASES || '').toLowerCase() === 'on';
  }

  async function record({ kind, userId, amount, transactionId, withdrawalId, status = 'succeeded', ref, meta }) {
    const { error } = await supabase.from('payments').insert([{
      kind, user_id: userId || null, amount: Number(amount || 0), currency: 'USD',
      provider: kind === 'payout' ? (meta?.method || 'bank') : provider(),
      provider_ref: ref || null, status,
      transaction_id: transactionId != null ? String(transactionId) : null,
      withdrawal_id: withdrawalId || null, meta: meta || null
    }]);
    if (error) console.error(`Payment ledger (${kind}) failed:`, error.message);
  }

  // Called when a buyer checks out. Returns { ok, error }.
  async function chargePurchase(tx) {
    if (provider() === 'paypal') {
      // Connected in the PayPal phase: create + capture a PayPal order for tx.total
      return { ok: false, error: 'PayPal checkout is not connected yet.' };
    }
    await record({ kind: 'purchase', userId: tx.buyer_id, amount: tx.total, transactionId: tx.id, meta: { idea_id: tx.idea_id, test: true } });
    return { ok: true };
  }

  // Wallet: earned (lifetime, credited on release) minus withdrawals requested/paid
  async function wallet(userId) {
    const [{ data: u }, { data: w }] = await Promise.all([
      supabase.from('users').select('earnings').eq('id', userId).single(),
      supabase.from('withdrawals').select('amount, status').eq('user_id', userId)
    ]);
    const earned = Number(u?.earnings || 0);
    const paid = (w || []).filter(x => x.status === 'paid').reduce((s, x) => s + Number(x.amount), 0);
    const pending = (w || []).filter(x => x.status === 'requested').reduce((s, x) => s + Number(x.amount), 0);
    return { earned, withdrawn: paid, pending, available: Math.max(0, Math.round((earned - paid - pending) * 100) / 100) };
  }

  return { provider, purchasesOpen, record, chargePurchase, wallet };
};
