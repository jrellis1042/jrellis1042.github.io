// POST /.netlify/functions/recruiter (also mapped to /recruiter)
// Recruiter portal backend — production, no demo data.
// Kinds:
//   application — a person applies to be a recruiter (future recruiters;
//     Crystal Gayle's application is by email reply, not this form, but
//     this form creates the same system record for anyone else).
//   referral — a recruiter reports a talent they referred. This does NOT
//     register the talent and does NOT create an app account. The talent
//     must still register themselves at /pages/talent-form.html; this
//     note only attributes the referral to the recruiter code.
//   edit-request — a recruiter requests a change to her portal. The request
//     is logged as a note for review; it is NOT applied automatically.
//     Requests that would break standing rules (public pricing, owner
//     references in public copy, verifying talent without the verifier,
//     creating app accounts, moving deals, promising placements or pay)
//     are flagged in the note and must be reviewed by Rashad first.
// NEVER creates an app account. NEVER moves a deal between stages.
// NEVER writes "verified" in a recruiter note — recruiter approval is an
// endorsement, verification is a separate step through the verifier.
const L = require('./lib');
const { pd, findPersonByEmail } = L;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return L.ok({ ok: false, error: 'Method not allowed.' }, 405);
    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch { return L.bad('Invalid JSON body.'); }
    if (b.website) return L.ok({ ok: true, ignored: true });
    const kind = b.kind;
    if (!['application', 'referral', 'edit-request'].includes(kind)) return L.bad('kind must be "application", "referral", or "edit-request".');
    if (!b.recruiterName || !b.recruiterEmail || !L.isEmail(b.recruiterEmail)) return L.bad('Recruiter name and a valid email are required.');
    if (kind === 'application') {
      if (!b.phone || !b.city || !b.history) return L.bad('Application requires phone, city, and promoting history.');
    }
    if (kind === 'referral') {
      if (!b.talentName || !b.talentEmail || !L.isEmail(b.talentEmail) || !b.talentRole) return L.bad('Referral requires talent name, valid talent email, and talent role.');
      if (!L.TALENT_PRIMARY_ROLES.includes(b.talentRole)) return L.bad('Talent role is not in the allowed catalog.');
      if (b.talentRole === 'Other' && L.performerHit(b.talentNotes || '')) return L.bad('Referral notes contain a performer term — flag, do not submit as a standard referral. Contact Nocturnal directly.');
    }
    if (kind === 'edit-request') {
      if (!b.editText || !b.editText.trim()) return L.bad('Edit request text is required.');
    }

    let person = await findPersonByEmail(b.recruiterEmail);
    if (!person) {
      person = await pd('/persons', 'POST', { name: b.recruiterName, email: [{ value: b.recruiterEmail, primary: true }], phone: b.phone ? [{ value: b.phone, primary: true }] : [] });
    }
    const code = (b.recruiterCode || '').trim().toUpperCase();
    let content = '';
    if (kind === 'application') content = `RECRUITER APPLICATION ${new Date().toISOString()}: name=${b.recruiterName}; email=${b.recruiterEmail}; phone=${b.phone}; city=${b.city}; code=${code || 'none yet'}; reference=${b.reference || ''}; history=${b.history}; venues=${b.venues || ''}. Application only — NOT an approval, NOT verification, NOT an app account.`;
    if (kind === 'referral') content = `RECRUITER REFERRAL ${new Date().toISOString()}: recruiter=${b.recruiterName} (${b.recruiterEmail}, code=${code || 'none'}); talent=${b.talentName} (${b.talentEmail}); role=${b.talentRole}; notes=${b.talentNotes || ''}. Referral attribution ONLY — talent must still register themselves; this is NOT a registration, NOT an app account, NOT verification.`;
    if (kind === 'edit-request') {
      const flag = /price|\$|owner|verif|guarantee|placement.*fee/i.test(b.editText) ? ' FLAGGED for Rashad review — edit text touches pricing, owner, verification, or a guarantee. Do NOT apply without Rashad.' : '';
      content = `RECRUITER PORTAL EDIT REQUEST ${new Date().toISOString()}: recruiter=${b.recruiterName} (${b.recruiterEmail}, code=${code || 'none'}); request=${b.editText}.${flag}`;
    }
    const note = await pd('/notes', 'POST', { person_id: person.id, content });
    return L.ok({ ok: true, kind, personId: person.id, noteId: note.id }, 201);
  } catch (e) {
    console.error('recruiter error:', e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Could not be saved — please try again.' }) };
  }
};
