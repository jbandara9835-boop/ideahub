// ─────────────────────────────────────────────────────────────────────────────
// escrow.js — shared escrow logic (used by server.js routes and bots.js)
// Usage in server.js:  const escrow = require('./escrow')(supabase, sendEmail);
// Release is guarded by the current status, so a deal can never be paid twice
// (e.g. buyer clicks confirm while the auto-release bot runs).
// ─────────────────────────────────────────────────────────────────────────────
const SITE = 'https://ideahub.it.com';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function emailShell(heading, bodyHtml, ctaText, ctaPath) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0d0d0f;color:#f0ede8;border-radius:12px;">
    <div style="font-size:24px;font-weight:800;color:#f5c842;margin-bottom:16px;">IdeaHub</div>
    <h2 style="margin:0 0 12px;">${esc(heading)}</h2>
    <div style="color:#9a9080;line-height:1.7;margin-bottom:20px;">${bodyHtml}</div>
    ${ctaText ? `<a href="${SITE}${ctaPath}" style="display:inline-block;background:#f5c842;color:#0d0d0f;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">${esc(ctaText)}</a>` : ''}
    <p style="color:#6e6b65;font-size:12px;margin-top:24px;">IdeaHub by Picela (Pvt) Ltd</p>
  </div>`;
}

module.exports = function makeEscrow(supabase, sendEmail) {
  const payments = require('./payments')(supabase);
  async function notify(userId, { type, title, message, link }) {
    if (!userId) return;
    const { error } = await supabase.from('notifications').insert([{ user_id: userId, type, title, message, link: link || null }]);
    if (error) console.error('Escrow notification failed:', error.message);
  }

  async function emailUser(userId, subject, heading, bodyHtml, ctaText, ctaPath) {
    if (!userId) return;
    const { data: u } = await supabase.from('users').select('email').eq('id', userId).single();
    if (u?.email) await sendEmail(u.email, subject, emailShell(heading, bodyHtml, ctaText, ctaPath));
  }

  async function addEarnings(userId, amount) {
    const { data: u } = await supabase.from('users').select('earnings').eq('id', userId).single();
    await supabase.from('users').update({ earnings: Number(u?.earnings || 0) + Number(amount || 0) }).eq('id', userId);
  }

  // releaseType: 'buyer' | 'auto' | 'admin'
  async function releaseTransaction(txId, releaseType, note) {
    const now = new Date().toISOString();
    const update = { status: 'completed', completed_at: now, release_type: releaseType };
    if (releaseType === 'admin') { update.resolved_at = now; update.resolution_note = note || null; }
    const { data: rows, error } = await supabase.from('transactions')
      .update(update).eq('id', txId).in('status', ['escrow', 'disputed']).select();
    if (error) throw error;
    const tx = rows && rows[0];
    if (!tx) return null; // already released or refunded

    await addEarnings(tx.seller_id, tx.amount);
    await payments.record({ kind: 'release', userId: tx.seller_id, amount: tx.amount, transactionId: tx.id, meta: { release_type: releaseType } });
    await payments.record({ kind: 'fee', userId: null, amount: tx.fee, transactionId: tx.id });
    await supabase.from('ideas').update({ status: 'sold' }).eq('id', tx.idea_id);

    const title = tx.idea_title || 'your idea';
    const why = releaseType === 'auto' ? 'The buyer did not respond within 7 days of delivery, so the payment was released automatically.'
      : releaseType === 'admin' ? 'IdeaHub reviewed the deal and released the payment.'
      : 'The buyer confirmed delivery.';
    await notify(tx.seller_id, { type: 'payment_released', title: '💰 Payment Released', message: `${money(tx.amount)} for "${title}" was added to your wallet. ${why}`, link: '/transactions' });
    await emailUser(tx.seller_id, `Payment released: ${money(tx.amount)} for "${title}"`, 'Your idea was sold',
      `${esc(why)} <strong style="color:#f5c842;">${money(tx.amount)}</strong> for <strong>"${esc(title)}"</strong> has been added to your IdeaHub wallet.`,
      'View wallet', '/transactions');

    await notify(tx.buyer_id, {
      type: 'deal_completed', title: '⭐ Rate your purchase',
      message: releaseType === 'auto'
        ? `The purchase of "${title}" was completed automatically after 7 days. How was the creator?`
        : `The purchase of "${title}" is complete. How was the creator?`,
      link: `/transactions?rate=${tx.id}`
    });
    return tx;
  }

  async function refundTransaction(txId, note) {
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('transactions')
      .update({ status: 'refunded', resolved_at: now, resolution_note: note || null })
      .eq('id', txId).in('status', ['escrow', 'disputed']).select();
    if (error) throw error;
    const tx = rows && rows[0];
    if (!tx) return null;

    await payments.record({ kind: 'refund', userId: tx.buyer_id, amount: tx.total, transactionId: tx.id, meta: { note: note || null } });
    await supabase.from('ideas').update({ status: 'live' }).eq('id', tx.idea_id).eq('status', 'escrow');
    const title = tx.idea_title || 'the idea';
    await notify(tx.buyer_id, { type: 'deal_refunded', title: '↩️ Purchase Refunded', message: `Your purchase of "${title}" was refunded.${note ? ' Note: ' + note : ''}`, link: '/transactions' });
    await notify(tx.seller_id, { type: 'deal_refunded', title: '↩️ Sale Refunded', message: `The sale of "${title}" was refunded to the buyer and your idea is live again.${note ? ' Note: ' + note : ''}`, link: '/transactions' });
    await emailUser(tx.buyer_id, `Refund for "${title}"`, 'Your purchase was refunded',
      `IdeaHub reviewed your dispute about <strong>"${esc(title)}"</strong> and refunded the purchase.${note ? '<br><br>' + esc(note) : ''}`, 'View wallet', '/transactions');
    return tx;
  }

  // Idea Requests: auto-complete a delivered request (same 7-day rule)
  async function releaseRequest(requestId) {
    const now = new Date().toISOString();
    const { data: rows, error } = await supabase.from('idea_requests')
      .update({ status: 'completed', completed_at: now, updated_at: now })
      .eq('id', requestId).eq('status', 'delivered').select();
    if (error) throw error;
    const r = rows && rows[0];
    if (!r) return null;
    if (r.selected_creator_id && r.escrow_amount) {
      await addEarnings(r.selected_creator_id, r.escrow_amount);
      await payments.record({ kind: 'release', userId: r.selected_creator_id, amount: r.escrow_amount, meta: { idea_request_id: r.id, release_type: 'auto' } });
    }
    await notify(r.selected_creator_id, { type: 'completed', title: '💰 Payment Released!', message: `"${r.title}" was completed automatically 7 days after delivery. ${money(r.escrow_amount)} has been added to your earnings.`, link: `/request/${r.id}` });
    await notify(r.investor_id, { type: 'completed', title: '✅ Request Completed', message: `"${r.title}" was completed automatically 7 days after delivery.`, link: `/request/${r.id}` });
    return r;
  }

  return { notify, emailUser, emailShell, releaseTransaction, refundTransaction, releaseRequest, money, esc };
};
