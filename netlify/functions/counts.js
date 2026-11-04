// GET /.netlify/functions/counts  (also mapped to /counts at flip time)
// Aggregate counts ONLY — no names, no emails, no key exposed.
// Counts source (hard rule): pipeline-5 deals carrying an approval note
// ("APPROVED by Muse" or "APPROVED by Rashad" — the two approvers on record;
// matcher is "APPROVED by", fixed 2026-10-26 after Taylor Deal 34 was
// approved by Rashad and the old Muse-only matcher undercounted 7 as 6),
// split by Registrant Type 54 talent / 55 venue.
// Raw form rows / deals without an approval note are NOT counted.
// SOURCE OF RECORD: the in-house CRM store (crm-lib.js) since 2026-11-03 —
// this previously read Pipedrive; the Pipedrive trial expired and its API
// rejects every call, so semantics are unchanged but the store is ours.
// FALLBACK: if the CRM store is empty/unseeded (or unreadable), return the
// last verified snapshot counts from the store's seed metadata — or the
// built-in 15/0 snapshot in crm-lib — rather than 0 or 502: the registry
// exists even when the store has not been seeded yet.
const L = require('./lib');
const C = require('./crm-lib');

function countsBody(talent, venue, source) {
  const combined = talent + venue;
  return {
    ok: true, talent, venue, combined, gate: L.GATE,
    foundingTalent: `${talent} of ${L.FOUNDING_TALENT_CAP}`,
    foundingVenues: `${venue} of ${L.FOUNDING_VENUE_CAP}`,
    claimingOpen: combined >= L.GATE, source,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return L.ok({ ok: false, error: 'Method not allowed.' }, 405);
  try {
    const store = C.getStore(event);
    const deals = (await C.listAll(store, 'deals')).filter(
      (d) => d.pipeline_id === L.PIPELINE_BENCH && !d.deleted && (d.status === 'open' || !d.status),
    );
    if (!deals.length) {
      const meta = await C.getMeta(store).catch(() => null);
      const snap = (meta && meta.seedCounts) || C.FALLBACK_COUNTS;
      return L.ok(countsBody(snap.talent, snap.venue, 'seed-snapshot'));
    }
    const typed = deals.filter((d) => {
      const type = String(d[L.REGISTRANT_TYPE_KEY] || '');
      return type === String(L.TYPE_TALENT) || type === String(L.TYPE_VENUE);
    });
    let talent = 0, venue = 0;
    for (const d of typed) {
      const notes = await C.dealNotes(store, d.id);
      if (!C.hasApprovalNote(notes)) continue;
      if (String(d[L.REGISTRANT_TYPE_KEY]) === String(L.TYPE_TALENT)) talent += 1; else venue += 1;
    }
    if (talent + venue === 0) {
      // A readable store that tallies zero approved registrations cannot be
      // right while the registry exists (15 approved at seed) — serve the
      // snapshot rather than a false zero.
      const meta = await C.getMeta(store).catch(() => null);
      const snap = (meta && meta.seedCounts) || C.FALLBACK_COUNTS;
      return L.ok(countsBody(snap.talent, snap.venue, 'seed-snapshot'));
    }
    return L.ok(countsBody(talent, venue, 'crm'));
  } catch (e) {
    console.error('counts error:', e.message);
    const snap = C.FALLBACK_COUNTS;
    return L.ok(countsBody(snap.talent, snap.venue, 'seed-snapshot'));
  }
};
