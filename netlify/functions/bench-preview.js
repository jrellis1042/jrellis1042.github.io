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

// LEGACY ROLE BRIDGE (added 2026-10-31, fix pass 2). The eight founding
// registrants who signed up through the Google Form on Oct 25–26, 2026 —
// before the website intake existed — were approved from their form records
// and their pipeline-5 deals carry NO INTAKE note and no structured role
// field anywhere on the record (deal fields checked 2026-10-31: only
// Registrant Type is set). Counting INTAKE notes alone therefore counted
// ZERO roles for 8 of the 12 approved talent (the first deployed version
// returned a 15-assignment mix covering only the four website-intake
// registrants, and Bottle Service vanished entirely because the sole
// Bottle Service registrant is a form registrant). The role sets below
// are those eight registrants' actual form-record roles, as recorded when
// their registrations were processed and approved. Rules of the bridge:
//  - keyed by pipeline-5 deal id; used ONLY when the deal has no INTAKE
//    note — a deal's own INTAKE note always wins;
//  - the deal must still pass the live approval-note + Registrant Type
//    checks at read time, so a bridged deal that is deleted, closed, or
//    unapproved drops out of the mix automatically;
//  - Taylor Priday-Key (Deal 34) is counted at her APPROVED scope only
//    (VIP Host — her Venue Support listing was an unchosen alternative and
//    her performer primary was held, never approved).
// Long-term cleanup (registry step, outside this function): backfill
// INTAKE-format notes on these eight deals, after which this table can be
// deleted — the INTAKE path already covers every website registration.
const LEGACY_FORM_ROLES = {
  30: ['Bottle Service', 'Bartender', 'Barback', 'Door Staff', 'VIP Host'], // Emani Alvarado
  31: ['Bartender', 'Barback', 'Door Staff'], // Melanie Peacock
  32: ['Bartender', 'Barback', 'Door Staff', 'VIP Host', 'Venue Support'], // Tonja C Rienks
  33: ['Bartender', 'Barback'], // Lariel Leal
  34: ['VIP Host'], // Taylor Priday-Key (approved scope only)
  43: ['Venue Support', 'Barback', 'Door Staff', 'VIP Host'], // Jordan Dewey Cech
  44: ['Venue Support', 'Door Staff', 'VIP Host'], // Erika Black
  47: ['Bartender', 'Barback', 'VIP Host'], // Olivia Scott
};

function rolesFromNotes(dealId, notes) {
  const hasIntake = notes.some((n) => String(n.content || '').startsWith('INTAKE '));
  const roles = new Set();
  if (hasIntake) {
    const fields = P.parseIntakeFields(notes);
    if (fields.primaryRole) roles.add(normalizeRole(fields.primaryRole));
    for (const r of String(fields.otherRoles || '').split(/[;,]/)) { const n = normalizeRole(r); if (n) roles.add(n); }
    return roles;
  }
  for (const r of LEGACY_FORM_ROLES[dealId] || []) { const n = normalizeRole(r); if (n) roles.add(n); }
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
exports._test = { normalizeRole, rolesFromNotes, LEGACY_FORM_ROLES };
