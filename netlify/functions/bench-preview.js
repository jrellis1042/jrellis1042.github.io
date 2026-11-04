// GET /.netlify/functions/bench-preview — AGGREGATE-ONLY bench shape for the
// public bench-preview page. Returns counts by role and coverage totals for
// APPROVED talent records (same "APPROVED by" note rule as /counts).
// NEVER returns names, emails, phones, or any per-person data — aggregates
// only, by design (limited public preview rule). Roles are counted from the
// INTAKE note on each approved bench deal (primary role + other roles), so
// the page can never drift from the registry: it reads the same records
// /counts reads. Role labels are normalized to the public catalog labels.
const L = require('./lib');
const P = require('./portal-lib'); // parseIntakeFields only (pure parser)
const C = require('./crm-lib');

// FALLBACK (store empty/unseeded): last verified snapshot — same rule as
// /counts. Role mix comes from the seed metadata when present, else the
// built-in mix in crm-lib (computed from the salvage seed's INTAKE notes).
function fallbackBody(meta) {
  const counts = (meta && meta.seedCounts) || C.FALLBACK_COUNTS;
  const mix = (meta && meta.seedRoleMix) || C.FALLBACK_ROLE_MIX;
  const ordered = {};
  for (const r of ROLE_ORDER) if (mix[r]) ordered[r] = mix[r];
  for (const r of Object.keys(mix)) if (!(r in ordered)) ordered[r] = mix[r];
  return {
    ok: true, aggregateOnly: true,
    talent: counts.talent, venue: counts.venue, combined: counts.talent + counts.venue, gate: L.GATE,
    claimingOpen: (counts.talent + counts.venue) >= L.GATE,
    foundingTalent: `${counts.talent} of ${L.FOUNDING_TALENT_CAP}`,
    foundingVenues: `${counts.venue} of ${L.FOUNDING_VENUE_CAP}`,
    roleMix: ordered, asOf: new Date().toISOString(), source: 'seed-snapshot',
  };
}

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
    // Source of record: the in-house CRM store (was Pipedrive via portal-lib
    // until the trial expired 2026-11-03). Same approval rule, same records.
    const store = C.getStore(event);
    const deals = await C.listAll(store, 'deals');
    const bench = deals.filter((d) => d.pipeline_id === L.PIPELINE_BENCH && !d.deleted && (d.status === 'open' || !d.status));
    if (!bench.length) {
      const meta = await C.getMeta(store).catch(() => null);
      return L.ok(fallbackBody(meta));
    }
    const withNotes = await Promise.all(bench.map(async (d) => ({ d, notes: await C.dealNotes(store, d.id) })));
    const roleMix = {};
    let talent = 0, venue = 0;
    for (const { d, notes } of withNotes) {
      if (!C.hasApprovalNote(notes)) continue;
      const type = String(d[L.REGISTRANT_TYPE_KEY] || '');
      if (type === String(L.TYPE_VENUE)) { venue += 1; continue; }
      if (type !== String(L.TYPE_TALENT)) continue;
      talent += 1;
      for (const r of rolesFromNotes(d.id, notes)) roleMix[r] = (roleMix[r] || 0) + 1;
    }
    if (talent + venue === 0) {
      // Same zero-guard as counts.js: never present a false empty registry.
      const meta = await C.getMeta(store).catch(() => null);
      return L.ok(fallbackBody(meta));
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
      source: 'crm',
    });
  } catch (e) {
    console.error('bench-preview error:', e.message);
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Bench preview is not available right now.' }) };
  }
};

// Exported for the offline tests only; the deployed handler is unchanged.
exports._test = { normalizeRole, rolesFromNotes };
