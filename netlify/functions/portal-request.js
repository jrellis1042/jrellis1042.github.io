// POST /.netlify/functions/portal-request  (also mapped to /portal-request)
// Signed-in venue staffing requests (v1). A request is stored as a
// STAFFING REQUEST note on the venue's OWN pipeline-5 deal only — it never
// moves a deal/stage, never approves anything, never creates an app account,
// and never writes "verified". The note carries NO contact email or phone,
// so the same note can safely feed the talent preview.
// Gates, in order (per the venue payment gate rule): verification first,
// then payment. Role must be in the exact catalog; Other requires a specify
// that is performer-screened server-side (a performer hit is refused here,
// because a posted request with a performer role must never enter preview).
const L = require('./lib');
const P = require('./portal-lib');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return L.ok({ ok: false, error: 'Method not allowed.' }, 405);
    if (!P.sessionSecret()) return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Sign-in is not available right now.' }) };
    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch { return L.bad('Invalid JSON body.'); }
    const store = P.getStore(event);
    const session = await P.readSession(store, P.tokenFromEvent(event));
    if (!session || session.role !== 'venue') return { statusCode: 401, body: JSON.stringify({ ok: false, error: P.GENERIC_REFUSAL }) };

    // Re-derive status from Pipedrive on every request (never trust the session).
    const record = await P.eligibleBenchRecord(session.email, 'venue');
    if (!record) return { statusCode: 401, body: JSON.stringify({ ok: false, error: P.GENERIC_REFUSAL }) };
    const { deal, notes } = record;
    if (P.verificationState(deal.stage_id) !== 'verified') {
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Your venue must be verified before postings go live.' }) };
    }
    let paid = P.paymentActiveFromNotes(notes);
    if (!paid && deal.org_id) {
      const p1 = (await P.listAllDeals()).filter((d) => d.pipeline_id === 1 && d.org_id === deal.org_id && !d.deleted);
      for (const d of p1) { if (P.paymentActiveFromNotes(await P.dealNotes(d.id))) { paid = true; break; } }
    }
    if (!paid) {
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: P.PAYMENT_GATE_MESSAGE }) };
    }

    const role = b.role, date = String(b.date || '').trim();
    if (!P.ROLES.includes(role)) return L.bad('Role is not in the allowed catalog.');
    if (role === 'Other') {
      if (!(b.otherSpecify || '').trim()) return L.bad('Other role requires a one-line specify.');
      if (L.performerHit(b.otherSpecify)) return L.bad('That role cannot be posted — Nocturnal does not place performers.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return L.bad('Date is required (YYYY-MM-DD).');
    const venueName = String(deal.title || '').split(' — ')[0] || 'Venue';
    const content = `STAFFING REQUEST ${new Date().toISOString()}: venue=${venueName}; role=${role}${role === 'Other' ? ` (${b.otherSpecify.trim()})` : ''}; date=${date}; window=${String(b.window || '').trim()}; dress=${String(b.dress || '').trim()}; notes=${String(b.notes || '').trim()}`;
    const saved = await L.pd('/notes', 'POST', { deal_id: deal.id, content });
    return L.ok({ ok: true, noteId: saved.id }, 201);
  } catch (e) {
    console.error('portal-request error:', e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Your request could not be saved — please try again.' }) };
  }
};
