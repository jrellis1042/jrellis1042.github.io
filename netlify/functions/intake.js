// POST /.netlify/functions/intake  (also mapped to /intake at flip time)
// Creates a Pipedrive Person (+ Organization for venues) and a pipeline-5
// Bench Building deal at stage 24 New Registration. NEVER creates an app
// account. Approval is NOT done here — watcher v2 applies the existing
// policy to the new deal (approval note = approved). Flagged items get a
// flag note and must never be auto-approved.
const L = require('./lib');
const { pd, findPersonByEmail, findOrgByName, findOrgNearName } = L;

// Founding Talent referral capture (decided by Rashad 2026-10-31): a venue
// that names a referrer gets the value stored verbatim on the INTAKE note,
// and a value matching a known referral code — or a registrant's exact
// full name — sets the deal's Source Type to "Venue Referral". Anything
// ambiguous is noted only; attribution is never guessed.
const SOURCE_TYPE_KEY = 'a06cd9d1f8c43770b3dea231738ffac205729b58';
const SOURCE_VENUE_REFERRAL = '53';
const REFERRAL_CODES = ['EMANI-01', 'MELANIE-02', 'LARIEL-03', 'TONJA-04', 'TAYLOR-05', 'JORDAN-06', 'ERIKA-07', 'OLIVIA-08', 'SHANEL-09', 'MICHELLE-10', 'ALECZANDRA-11', 'MARK-12', 'CRYSTAL-01'];
const REFERRAL_NAMES = {
  'emani alvarado': 'EMANI-01', 'melanie peacock': 'MELANIE-02', 'lariel leal': 'LARIEL-03',
  'tonja rienks': 'TONJA-04', 'tonja c. rienks': 'TONJA-04', 'taylor priday-key': 'TAYLOR-05',
  'jordan dewey cech': 'JORDAN-06', 'erika black': 'ERIKA-07', 'olivia scott': 'OLIVIA-08',
  'shanel davidson': 'SHANEL-09', 'michelle chrisomalis': 'MICHELLE-10',
  'aleczandra fitzgerald': 'ALECZANDRA-11', 'mark levitt': 'MARK-12', 'crystal gayle': 'CRYSTAL-01',
};
function referralMatch(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (REFERRAL_CODES.some((c) => c.toLowerCase() === t)) return t.toUpperCase();
  return REFERRAL_NAMES[t] || null;
}

function validateTalent(b) {
  const req = ['fullName', 'email', 'phone', 'dob', 'primaryRole', 'state', 'city', 'experience', 'transportation', 'confirmation'];
  for (const f of req) if (b[f] === undefined || b[f] === '' || b[f] === false) return `Missing required field: ${f}`;
  if (!L.isEmail(b.email)) return 'Invalid email address.';
  if (!L.US_STATES.includes(b.state)) return 'State must be one of the 50 states.';
  if (!L.TALENT_PRIMARY_ROLES.includes(b.primaryRole)) return 'Primary role is not in the allowed catalog.';
  if (b.primaryRole === 'Other' && !(b.otherSpecify || '').trim()) return 'Other role requires a one-line specify.';
  if (Array.isArray(b.otherRoles)) for (const r of b.otherRoles) if (!L.TALENT_OTHER_ROLES.includes(r)) return `Other role not in the audited checkbox list: ${r}`;
  if (!L.TALENT_EXPERIENCE.includes(b.experience)) return 'Experience value is not in the audited list.';
  if (Array.isArray(b.certifications)) for (const r of b.certifications) if (!L.TALENT_CERTS.includes(r)) return `Certification not in the audited list: ${r}`;
  if (!['Yes', 'No'].includes(b.transportation)) return 'Transportation must be Yes or No.';
  if (Array.isArray(b.availability)) for (const r of b.availability) if (!L.TALENT_AVAILABILITY.includes(r)) return `Availability not in the audited list: ${r}`;
  return null;
}
function validateVenue(b) {
  const req = ['venueName', 'contactName', 'contactRole', 'email', 'phone', 'venueType', 'state', 'city', 'calloutFrequency', 'confirmation'];
  for (const f of req) if (b[f] === undefined || b[f] === '' || b[f] === false) return `Missing required field: ${f}`;
  if (!L.isEmail(b.email)) return 'Invalid email address.';
  if (!L.US_STATES.includes(b.state)) return 'State must be one of the 50 states.';
  if (!L.VENUE_ROLES.includes(b.contactRole)) return 'Contact role is not in the audited list.';
  if (!L.VENUE_TYPES.includes(b.venueType)) return 'Venue type is not in the audited list.';
  if (Array.isArray(b.rolesNeeded)) for (const r of b.rolesNeeded) if (!L.VENUE_ROLES_NEEDED.includes(r)) return `Role needed not in the audited list: ${r}`;
  if (Array.isArray(b.busiestNights)) for (const r of b.busiestNights) if (!L.VENUE_NIGHTS.includes(r)) return `Busiest night not in the audited list: ${r}`;
  if (!L.VENUE_CALLOUT_FREQ.includes(b.calloutFrequency)) return 'Call-out frequency is not in the audited list.';
  return null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return L.ok({ ok: false, error: 'Method not allowed.' }, 405);
    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch { return L.bad('Invalid JSON body.'); }
    // Honeypot: bots that fill it are silently dropped (200, ignored) so the
    // form never tips them off, and nothing is written to Pipedrive.
    if (b.website) return L.ok({ ok: true, ignored: true });
    // Basic rate limiting is handled at the Netlify/edge layer at flip time;
    // v1 deliberately has no CAPTCHA (friction cost — see design §4).
    const kind = b.kind;
    if (kind !== 'talent' && kind !== 'venue') return L.bad('kind must be "talent" or "venue".');
    const err = kind === 'talent' ? validateTalent(b) : validateVenue(b);
    if (err) return L.bad(err);

    const flags = [];
    if (kind === 'talent' && b.primaryRole === 'Other' && L.performerHit(b.otherSpecify)) flags.push('performer term in Other specify');
    if (kind === 'talent' && b.primaryRole === 'Other' && L.performerHit(b.notes)) flags.push('performer term in notes');

    let person = await findPersonByEmail(b.email);
    if (!person) {
      person = await pd('/persons', 'POST', { name: kind === 'talent' ? b.fullName : b.contactName, email: [{ value: b.email, primary: true }], phone: [{ value: b.phone, primary: true }] });
    }
    let orgId = null, nearMatch = null;
    if (kind === 'venue') {
      const org = await findOrgByName(b.venueName);
      if (org) orgId = org.id;
      else {
        const near = await findOrgNearName(b.venueName);
        if (near.length) { nearMatch = near.map((o) => o.name); flags.push('near-identical org name exists — flagged, never merged'); }
        const created = await pd('/organizations', 'POST', { name: b.venueName });
        orgId = created.id;
      }
    }
    const zone = L.zoneFor(b.city, b.state);
    const referredBy = kind === 'venue' && typeof b.referredBy === 'string' ? b.referredBy : '';
    const referralCode = referralMatch(referredBy);
    const dealBody = {
      title: kind === 'talent' ? `${b.fullName} — Founding Talent registration` : `${b.venueName} — Founding Venue registration`,
      person_id: person.id, org_id: orgId, pipeline_id: L.PIPELINE_BENCH, stage_id: L.STAGE_NEW_REGISTRATION,
      [L.REGISTRANT_TYPE_KEY]: kind === 'talent' ? String(L.TYPE_TALENT) : String(L.TYPE_VENUE),
    };
    if (zone) dealBody[L.ZONE_KEY] = zone;
    if (referralCode) dealBody[SOURCE_TYPE_KEY] = SOURCE_VENUE_REFERRAL;
    const deal = await pd('/deals', 'POST', dealBody);
    // Store the full submission on the deal as a note (audit trail for
    // watcher v2 approval; never a substitute for an approval note).
    const fields = kind === 'talent'
      ? `Talent intake: name=${b.fullName}; email=${b.email}; phone=${b.phone}; dob=${b.dob}; primaryRole=${b.primaryRole}; otherSpecify=${b.otherSpecify || ''}; otherRoles=${(b.otherRoles || []).join(', ')}; state=${b.state}; city=${b.city}; experience=${b.experience}; certifications=${(b.certifications || []).join(', ')}; transportation=${b.transportation}; availability=${(b.availability || []).join(', ')}; notes=${b.notes || ''}`
      : `Venue intake: venue=${b.venueName}; contact=${b.contactName} (${b.contactRole}); email=${b.email}; phone=${b.phone}; type=${b.venueType}; state=${b.state}; city=${b.city}; address=${b.address || ''}; rolesNeeded=${(b.rolesNeeded || []).join(', ')}; busiestNights=${(b.busiestNights || []).join(', ')}; calloutFrequency=${b.calloutFrequency}; notes=${b.notes || ''}`;
    const referralLine = referredBy.trim() ? `\nReferred by: ${referredBy}` : '';
    await pd('/notes', 'POST', { deal_id: deal.id, content: `INTAKE ${new Date().toISOString()}: ${fields}${referralLine}` });
    if (flags.length) await pd('/notes', 'POST', { deal_id: deal.id, content: `FLAGGED — intake: ${flags.join('; ')}. Do NOT auto-approve; needs Rashad's decision.` });
    return L.ok({ ok: true, dealId: deal.id, personId: person.id, orgId, flagged: flags.length > 0, flags, nearMatch }, 201);
  } catch (e) {
    // A failed Pipedrive write returns an error to the visitor ("try again")
    // and never silently drops a registration. Token-misconfiguration is
    // reported generically — the token value is never in any message.
    console.error('intake error:', e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Registration could not be saved — please try again.' }) };
  }
};
