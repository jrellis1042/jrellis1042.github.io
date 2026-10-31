// GET /.netlify/functions/bench-preview — AGGREGATE-ONLY bench shape for the
// public bench-preview page. Returns counts by role and coverage totals for
// APPROVED talent records (same "APPROVED by" note rule as /counts).
// NEVER returns names, emails, phones, or any per-person data — aggregates
// only, by design (limited public preview rule). Roles are counted from the
// INTAKE note on each approved bench deal (primary role + other roles), so
// the page can never drift from the registry: it reads the same records
// /counts reads. Role labels are normalized to the public catalog labels.
const L = require('./lib');
const P = require('./portal-lib');

const ROLE_ORDER = ['Bartender', 'Venue Support', 'VIP Host', 'Barback', 'Door Staff', 'Bottle Service', 'Other'];
function normalizeRole(r) {
  const t = String(r || '').trim();
  if (t === 'Venue Support Staff') return 'Venue Support';
  if (t === 'VIP Hosts') return 'VIP Host';
  if (t === 'Bartenders') return 'Bartender';
  if (t === 'Barbacks') return 'Barback';
  return t;
}

function rolesFromNotes(dealId, notes) {
  const roles = new Set();
  if (!notes.some((n) => String(n.content || '').startsWith('INTAKE '))) return roles;
  const fields = P.parseIntakeFields(notes);
  if (fields.primaryRole) roles.add(normalizeRole(fields.primaryRole));
  for (const r of String(fields.otherRoles || '').split(/[;,]/)) { const n = normalizeRole(r); if (n) roles.add(n); }
  return roles;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return L.ok({ ok: false, error: 'Method not allowed.' }, 405);
    const deals = await P.listAllDeals();
    const bench = deals.filter((d) => d.pipeline_id === L.PIPELINE_BENCH && !d.deleted);
    // Fetch every bench deal's notes in parallel — the previous version
    // awaited them one deal at a time, which made this endpoint (and the
    // bench page behind it) take seconds to answer (fix pass 2).
    const withNotes = await Promise.all(bench.map(async (d) => ({ d, notes: await P.dealNotes(d.id) })));
    const roleMix = {};
    let talent = 0, venue = 0;
    for (const { d, notes } of withNotes) {
      if (!P.hasApprovalNote(notes)) continue;
      const type = String(d[L.REGISTRANT_TYPE_KEY] || '');
      if (type === String(L.TYPE_VENUE)) { venue += 1; continue; }
      if (type !== String(L.TYPE_TALENT)) continue;
      talent += 1;
      for (const r of rolesFromNotes(d.id, notes)) roleMix[r] = (roleMix[r] || 0) + 1;
    }
    const ordered = {};
    for (const r of ROLE_ORDER) if (roleMix[r]) ordered[r] = roleMix[r];
    for (const r of Object.keys(roleMix)) if (!(r in ordered)) ordered[r] = roleMix[r];
    return L.ok({
      ok: true, aggregateOnly: true,
      talent, venue, combined: talent + venue, gate: L.GATE,
      claimingOpen: (talent + venue) >= L.GATE,
      foundingTalent: `${talent} of ${L.FOUNDING_TALENT_CAP}`,
      foundingVenues: `${venue} of ${L.FOUNDING_VENUE_CAP}`,
      roleMix: ordered,
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    console.error('bench-preview error:', e.message);
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Bench preview is not available right now.' }) };
  }
};

// Exported for the offline tests only; the deployed handler is unchanged.
exports._test = { normalizeRole, rolesFromNotes };
