// GET /.netlify/functions/counts  (also mapped to /counts at flip time)
// Aggregate counts ONLY — no names, no emails, no token exposed.
// Counts source (hard rule): pipeline-5 deals carrying an approval note
// ("APPROVED by Muse" or "APPROVED by Rashad" — the two approvers on record;
// matcher is "APPROVED by", fixed 2026-10-26 after Taylor Deal 34 was
// approved by Rashad and the old Muse-only matcher undercounted 7 as 6),
// split by Registrant Type 54 talent / 55 venue.
// Raw form rows / deals without an approval note are NOT counted.
const L = require('./lib');
const { pd } = L;

async function listAllDeals() {
  const out = [];
  let start = 0;
  for (;;) {
    const data = await pd(`/deals?status=open&limit=100&start=${start}`);
    const deals = Array.isArray(data) ? data : (data && data.items ? data.items : []);
    out.push(...deals);
    const more = data && data.additional_data && data.additional_data.pagination && data.additional_data.pagination.more_items_in_collection;
    if (!more) break;
    start += 100;
    if (start > 5000) break;
  }
  return out;
}
async function hasApprovalNote(dealId) {
  const notes = await pd(`/deals/${dealId}/notes?limit=100`);
  const list = Array.isArray(notes) ? notes : [];
  return list.some((n) => String(n.content || '').includes('APPROVED by'));
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return L.ok({ ok: false, error: 'Method not allowed.' }, 405);
    const deals = (await listAllDeals()).filter((d) => d.pipeline_id === L.PIPELINE_BENCH && !d.deleted);
    // Approval checks run in parallel (fix pass 2, 2026-10-31): the old
    // loop awaited one Pipedrive notes call per deal in sequence, which
    // made /counts take ~1.5s and left the portal pages sitting on their
    // "loading…" placeholder. Semantics unchanged — same matcher, same
    // type split, raw rows still never counted.
    const typed = deals.filter((d) => {
      const type = String(d[L.REGISTRANT_TYPE_KEY] || '');
      return type === String(L.TYPE_TALENT) || type === String(L.TYPE_VENUE);
    });
    const approved = await Promise.all(typed.map(async (d) => ((await hasApprovalNote(d.id)) ? d : null)));
    let talent = 0, venue = 0;
    for (const d of approved) {
      if (!d) continue;
      if (String(d[L.REGISTRANT_TYPE_KEY] || '') === String(L.TYPE_TALENT)) talent += 1; else venue += 1;
    }
    const combined = talent + venue;
    return L.ok({ ok: true, talent, venue, combined, gate: L.GATE, foundingTalent: `${talent} of ${L.FOUNDING_TALENT_CAP}`, foundingVenues: `${venue} of ${L.FOUNDING_VENUE_CAP}`, claimingOpen: combined >= L.GATE });
  } catch (e) {
    console.error('counts error:', e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Counts unavailable.' }) };
  }
};
