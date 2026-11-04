// POST /.netlify/functions/portal-auth  (also mapped to /portal-auth)
// PHASE 3 (2026-11-03): eligibility/overview reads now come from the
// in-house CRM via portal-lib.js (was Pipedrive; trial expired). Routes,
// request/response shapes, session behavior, and validation are unchanged.
// Website portal auth — one function, seven actions:
//   create-password {email, role, password}  — first-time password for an
//     ELIGIBLE email only (approved pipeline-5 deal for talent/venue, or an
//     approved recruiter record). Eligibility is checked server-side here.
//   signin {email, password}
//   signout {}
//   me {} — role-scoped portal state; also served on GET with a session.
//   forgot-password {email} — PHASE 4 (2026-11-03): ALWAYS returns the same
//     generic 200 (never reveals whether an account exists). When an
//     account does exist for the email, a PORTAL PASSWORD RESET REQUEST
//     note is logged on the person's CRM record (max one per day) for the
//     portal watch. The web request alone NEVER changes a password.
//   reset-password {email, code, password} — completes a reset with the
//     one-hour code the team emailed after confirming the request from
//     the account's own inbox (see admin-set-reset-code). The code is
//     stored scrypt-hashed only, single-use, and cleared on success.
//   admin-set-reset-code {email, role, code} — key-guarded (x-crm-key vs
//     CRM_API_KEY, same pattern as board-data/crm). Juju runs this ONLY
//     after the account holder confirms the reset by replying from the
//     account email, then emails them the code from the business inbox.
// Sessions are server-side, role-bound, fixed 7-day expiry (never sliding).
// Passwords: scrypt hashes only, stored in the auth store — never plaintext,
// never logged, never written to the CRM, never in any repo file.
// Store: Netlify Blobs ("nocturnal-portal-auth") in production; a
// clearly-marked file-backed store ONLY when PORTAL_AUTH_ALLOW_FILE_STORE=1
// (local tests). If PORTAL_SESSION_SECRET is missing, every action fails
// closed with a generic error. No secret value ever appears in code, tests,
// or logs. This function NEVER approves a registration, NEVER moves a deal
// or stage, NEVER creates an app account.
// Private pricing: amounts appear ONLY inside a signed-in recruiter session.
// Venue sessions receive the amount-free model description only; talent and
// anonymous callers receive no pricing at all.
// OWNER ROLE (front-door build, v1 — READ-ONLY overview only):
//   create-password {email, role:'owner', password} — allowed ONLY when
//     email matches env OWNER_LOGIN_EMAIL (never hardcoded anywhere) AND
//     no owner password hash exists yet; a second creation is refused.
//     If OWNER_LOGIN_EMAIL is missing, owner sign-in/creation fails closed.
//   signin {email, password} — owner accounts are tried only when the
//     email matches OWNER_LOGIN_EMAIL.
//   me {} for an owner session returns a READ-ONLY overview: live counts,
//     pipeline counts, and roster/status views read from the CRM.
//     NO toggles, NO payment-status changes, NO deal/stage moves,
//     NO approvals, NO Command Center tabs in v1. Full Command Center is
//     a later phase. The owner dashboard page is pages/owner-portal.html.
const crypto = require('crypto');
const L = require('./lib');
const C = require('./crm-lib');
const P = require('./portal-lib');

const GATE = L.GATE;
// The eligible owner email comes ONLY from this env var. It is never
// hardcoded in any page or function code. Missing = owner auth fails closed.
function ownerEmail() { return String(process.env.OWNER_LOGIN_EMAIL || '').trim().toLowerCase(); }

// CRM key guard (same pattern as board-data.js / crm.js): the admin reset
// action is callable ONLY with the CRM key. Missing env = fail closed.
function crmKeyOk(event) {
  const expected = process.env.CRM_API_KEY || '';
  if (!expected) return 'unconfigured';
  const headers = event.headers || {};
  const given = String(headers['x-crm-key'] || headers['X-Crm-Key'] || '');
  if (!given || given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? true : false;
  } catch { return false; }
}

// Amounts below are served ONLY to a signed-in recruiter session, per the
// recruiter pack (private sales conversations). They are NOT in any page,
// NOT in any public payload, and NOT served to talent/venue/anonymous.
const RECRUITER_PRIVATE_PRICING = {
  membershipPerMonth: 99,
  placementMember: 500,
  placementNonMember: 750,
  placementPremium: 1250,
  replacementGuaranteeDays: 30,
  introductionCoverageMonths: 12,
  note: 'Private — for one-to-one sales conversations only. Never publish or post.',
};
const VENUE_PRICING_MODEL = {
  model: 'Reserve membership with placement coverage',
  replacementGuaranteeDays: 30,
  introductionCoverageMonths: 12,
  note: 'Membership and placement terms are shared in a private conversation once your venue is verified.',
};

function json(statusCode, body, extraHeaders = {}) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) };
}
function refused() { return json(401, { ok: false, error: P.GENERIC_REFUSAL }); }
function unavailable() { return json(503, { ok: false, error: 'Sign-in is not available right now.' }); }

async function buildOwnerOverview(session) {
  // READ-ONLY v1 overview. No writes of any kind happen here.
  const deals = await P.listAllDeals();
  const bench = deals.filter((d) => d.pipeline_id === L.PIPELINE_BENCH && !d.deleted);
  let talent = 0, venue = 0;
  const talentRoster = [], venueRoster = [];
  for (const d of bench) {
    const notes = await P.dealNotes(d.id);
    if (!P.hasApprovalNote(notes)) continue;
    const type = String(d[L.REGISTRANT_TYPE_KEY] || '');
    // Roster entries carry name + status only — no emails, phones, or DOB.
    const entry = {
      name: String(d.title || '').split(' — ')[0] || 'Record',
      stage: P.stageLabel(d.stage_id),
      verification: P.verificationState(d.stage_id),
      zone: d[L.ZONE_KEY] || null,
    };
    if (type === String(L.TYPE_TALENT)) { talent += 1; talentRoster.push(entry); }
    else if (type === String(L.TYPE_VENUE)) { venue += 1; venueRoster.push({ ...entry, paymentActive: P.paymentActiveFromNotes(notes) }); }
  }
  const pipelineCounts = {};
  for (const d of deals.filter((x) => !x.deleted)) pipelineCounts[String(d.pipeline_id)] = (pipelineCounts[String(d.pipeline_id)] || 0) + 1;
  // Bench stage breakdown (approved records only) + who is sitting in
  // verification right now — read-only, name + type only, no contact PII.
  const benchStageCounts = {};
  for (const e of [...talentRoster, ...venueRoster]) benchStageCounts[e.stage] = (benchStageCounts[e.stage] || 0) + 1;
  const verificationQueue = [...talentRoster.map((r) => ({ ...r, type: 'Talent' })), ...venueRoster.map((r) => ({ ...r, type: 'Venue' }))]
    .filter((r) => r.verification === 'in_verification')
    .map((r) => ({ name: r.name, type: r.type }));
  return {
    ok: true, role: 'owner', email: session.email, readOnly: true,
    counts: { talent, venue, combined: talent + venue, gate: GATE, claimingOpen: (talent + venue) >= GATE },
    pipelineCounts, talentRoster, venueRoster, benchStageCounts, verificationQueue,
    note: 'Read-only overview (v1). No toggles, payment changes, deal moves, or approvals are available here.',
  };
}

async function buildMe(session) {
  if (session.role === 'owner') {
    if (!ownerEmail() || session.email !== ownerEmail()) return null;
    return buildOwnerOverview(session);
  }
  // Fresh CRM read on every call — portal state is never cached here.
  if (session.role === 'recruiter') {
    const notes = await P.personNotes(session.personId);
    const code = P.referralCodeFromNotes(notes);
    const referrals = P.parseReferrals(notes);
    let reviews = [];
    if (code) {
      const deals = await P.listAllDeals();
      const withNotes = [];
      for (const d of deals.filter((x) => x.pipeline_id === L.PIPELINE_BENCH)) {
        withNotes.push({ deal: d, notes: await P.dealNotes(d.id) });
      }
      reviews = P.parseCredentialReviews(withNotes, code);
    }
    return {
      ok: true, role: 'recruiter', email: session.email,
      referralCode: code,
      referrals, reviews,
      // Private to this signed-in recruiter session only.
      privatePricing: RECRUITER_PRIVATE_PRICING,
      pilotPay: {
        talentSharePercent: 10, venueShareOneTime: 25,
        earnedToDate: 0,
        note: 'Pilot pay is $0 until revenue: paid only after Nocturnal receives the fee, monthly in arrears.',
      },
      claimingNote: 'Claiming is a talent/venue flow; recruiters never claim, book, or verify.',
    };
  }
  // Talent / venue: re-derive eligibility + status from the CRM.
  const record = await P.eligibleBenchRecord(session.email, session.role);
  if (!record) return null; // eligibility lost since sign-in: refuse, generic
  const { deal, notes } = record;
  const fields = P.parseIntakeFields(notes);
  const stage = deal.stage_id;
  const verified = P.verificationState(stage) === 'verified';
  const base = {
    ok: true, role: session.role, email: session.email,
    stage: P.stageLabel(stage),
    verification: P.verificationState(stage),
    verified,
    agreement: 'accepted at registration',
    zone: deal[L.ZONE_KEY] || null,
    gate: GATE, claimingOpen: false, // v1: no claim books anything; see claimGate below
    claimGate: {
      claimingOpen: false,
      claimDisabled: true,
      message: verified
        ? 'Postings are in preview. Claiming opens at 75 combined registrations — founding talent may claim early once verified, and v1 preview claims do not book anything.'
        : 'Postings are in preview. Claiming opens at 75 combined registrations, and only once you are verified.',
      foundingEarlyAccess: verified, // early access applies once verified; v1 still books nothing
    },
  };
  if (session.role === 'talent') {
    // Preview inventory: venue staffing requests (no contact PII in notes).
    const venueDeals = (await P.listAllDeals()).filter(
      (d) => d.pipeline_id === L.PIPELINE_BENCH && String(d[L.REGISTRANT_TYPE_KEY] || '') === String(L.TYPE_VENUE) && !d.deleted,
    );
    const withNotes = [];
    for (const d of venueDeals) withNotes.push({ deal: d, notes: await P.dealNotes(d.id) });
    const preview = P.parseStaffingRequests(withNotes).map((s) => ({ ...s, claimDisabled: true }));
    return {
      ...base,
      primaryRole: fields.primaryRole || null, otherRoles: fields.otherRoles || null,
      otherSpecify: fields.otherSpecify || null,
      city: fields.city || null, state: fields.state || null,
      experience: fields.experience || null, certifications: fields.certifications || null,
      availability: fields.availability || null,
      placements: [],
      placementsNote: 'No placements are recorded in the website record yet. Placements appear here once venues post and confirm them.',
      credentialsStatus: fields.certifications ? `On file: ${fields.certifications}` : 'No credentials recorded yet.',
      // Points/rank are NOT invented: no points record exists in the CRM
      // for website registrants, so the portal reports that plainly.
      points: null, rank: null,
      pointsNote: 'Points and rank are tracked in the app and will appear here once your app record is linked.',
      weekendReady: null,
      weekendReadyNote: 'Ready This Weekend opt-in is not recorded in the website record yet.',
      shiftsPreview: preview,
      shiftsPreviewNote: preview.length
        ? 'Preview only — claim buttons are disabled until the claim gate opens.'
        : 'No postings in preview yet. Postings from verified venues will appear here as preview first.',
    };
  }
  // Venue
  const paymentActive = P.paymentActiveFromNotes(notes);
  // Also check pipeline-1 deals for the same org for a payment marker.
  let orgPaymentActive = false;
  if (deal.org_id) {
    const p1 = (await P.listAllDeals()).filter((d) => d.pipeline_id === 1 && d.org_id === deal.org_id && !d.deleted);
    for (const d of p1) { if (P.paymentActiveFromNotes(await P.dealNotes(d.id))) { orgPaymentActive = true; break; } }
  }
  const paid = paymentActive || orgPaymentActive;
  const myRequests = [];
  for (const n of notes) {
    const c = String(n.content || '');
    if (!c.startsWith('STAFFING REQUEST')) continue;
    const get = (k) => { const m = c.match(new RegExp(`${k}=([^;]+)`)); return m ? m[1].trim() : ''; };
    myRequests.push({ role: get('role'), date: get('date'), window: get('window'), dress: get('dress') });
  }
  return {
    ...base,
    venueName: String(deal.title || '').split(' — ')[0] || null,
    paymentActive: paid,
    paymentBanner: paid
      ? 'Payment received — postings are active once your venue is verified.'
      : 'Postings activate once your venue payment is received.',
    postDisabled: !(verified && paid),
    postGateMessage: !verified
      ? 'Your venue must be verified before postings go live.'
      : (!paid ? P.PAYMENT_GATE_MESSAGE : 'You can post a staffing request.'),
    requests: myRequests,
    placements: [],
    placementsNote: 'No placements are recorded in the website record yet.',
    pricingModel: VENUE_PRICING_MODEL, // amount-free, signed-in venue only
  };
}

exports.handler = async (event) => {
  try {
    if (!P.sessionSecret()) return unavailable();
    const store = P.getStore(event);
    const method = event.httpMethod;
    let body = {};
    if (event.body) { try { body = JSON.parse(event.body); } catch { return L.bad('Invalid JSON body.'); } }
    const action = body.action || (method === 'GET' ? 'me' : '');

    if (action === 'signout') {
      await P.destroySession(store, P.tokenFromEvent(event));
      return json(200, { ok: true }, { 'Set-Cookie': P.clearedCookie() });
    }

    if (action === 'me') {
      const session = await P.readSession(store, P.tokenFromEvent(event));
      if (!session) return refused();
      const me = await buildMe(session);
      if (!me) return refused();
      return json(200, me);
    }

    if (action === 'create-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const role = body.role;
      const password = body.password;
      if (!L.isEmail(email) || !['talent', 'venue', 'recruiter', 'owner'].includes(role) || !P.validPassword(password)) return refused();
      const existing = await store.get(`account:${email}:${role}`);
      if (existing) return refused(); // generic: never reveal an account exists
      let account;
      if (role === 'owner') {
        // First-time owner password ONLY for the env owner email, and only
        // if no owner password hash exists yet (existing check above
        // already refused a second creation). Missing env = fail closed.
        if (!ownerEmail() || email !== ownerEmail()) return refused();
        account = { email, role, personId: null, dealId: null, orgId: null };
      } else if (role === 'recruiter') {
        const rec = await P.eligibleRecruiterRecord(email);
        if (!rec) return refused();
        account = { email, role, personId: rec.person.id, dealId: null, orgId: null };
      } else {
        const rec = await P.eligibleBenchRecord(email, role);
        if (!rec) return refused();
        account = { email, role, personId: rec.person.id, dealId: rec.deal.id, orgId: rec.deal.org_id || null };
      }
      await store.set(`account:${email}:${role}`, { ...account, passwordHash: P.hashPassword(password), createdAt: Date.now() });
      const raw = await P.createSession(store, account);
      return json(201, { ok: true, role }, { 'Set-Cookie': P.sessionCookie(raw) });
    }

    if (action === 'signin') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = body.password;
      if (!L.isEmail(email) || typeof password !== 'string') return refused();
      // Role is not requested at sign-in: try each role's account, in order,
      // and refuse generically on any miss (never reveal which part failed).
      let account = null;
      for (const role of ['talent', 'venue', 'recruiter', 'owner']) {
        if (role === 'owner' && (!ownerEmail() || email !== ownerEmail())) continue;
        const cand = await store.get(`account:${email}:${role}`);
        if (cand && P.checkPassword(password, cand.passwordHash)) { account = cand; break; }
      }
      if (!account) return refused();
      const raw = await P.createSession(store, account);
      return json(200, { ok: true, role: account.role }, { 'Set-Cookie': P.sessionCookie(raw) });
    }

    if (action === 'forgot-password') {
      // Generic in EVERY case — never reveal whether an account exists.
      const generic = { ok: true, message: 'If an account matches that email, a reset request has been logged and our team will email you a reset code.' };
      const email = String(body.email || '').trim().toLowerCase();
      if (!L.isEmail(email)) return json(200, generic);
      let found = null;
      for (const role of ['talent', 'venue', 'recruiter', 'owner']) {
        const cand = await store.get(`account:${email}:${role}`);
        if (cand) { found = { role, account: cand }; break; }
      }
      if (found && found.account.personId) {
        // Log the request on the person's CRM record for the portal watch
        // (Portia) — at most one note per day per account.
        const notes = await P.personNotes(found.account.personId);
        const today = new Date().toISOString().slice(0, 10);
        const already = notes.some((n) => {
          const c = String(n.content || '');
          return c.startsWith('PORTAL PASSWORD RESET REQUEST') && c.includes(today);
        });
        if (!already) {
          const crm = C.getStore(event);
          await C.create(crm, 'notes', {
            person_id: found.account.personId,
            deal_id: found.account.dealId || null,
            content: `PORTAL PASSWORD RESET REQUEST ${new Date().toISOString()}: ${found.role} portal password reset requested for the account email on file. Runbook: (1) email the account address from the business inbox asking them to reply to confirm; (2) on their reply, set a one-hour reset code with the key-guarded admin-set-reset-code action and email them the code; (3) the member finishes in the portal's Forgot password panel. Do NOT clear or change the password on the web request alone.`,
          });
        }
      }
      return json(200, generic);
    }

    if (action === 'admin-set-reset-code') {
      const guard = crmKeyOk(event);
      if (guard === 'unconfigured') return unavailable();
      if (!guard) return json(401, { ok: false, error: 'Unauthorized.' });
      const email = String(body.email || '').trim().toLowerCase();
      const role = body.role;
      const code = String(body.code || '').trim();
      if (!L.isEmail(email) || !['talent', 'venue', 'recruiter', 'owner'].includes(role) || code.length < 6) {
        return L.bad('email, role, and a reset code of at least 6 characters are required.');
      }
      const account = await store.get(`account:${email}:${role}`);
      if (!account) return json(404, { ok: false, error: 'No account for that email and role.' });
      account.resetCodeHash = P.hashPassword(code);
      account.resetExpires = Date.now() + 60 * 60 * 1000; // one hour
      await store.set(`account:${email}:${role}`, account);
      return json(200, { ok: true, expiresInMinutes: 60 });
    }

    if (action === 'reset-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').trim();
      const password = body.password;
      if (!L.isEmail(email) || code.length < 6 || !P.validPassword(password)) return refused();
      let target = null;
      for (const role of ['talent', 'venue', 'recruiter', 'owner']) {
        const cand = await store.get(`account:${email}:${role}`);
        if (cand && cand.resetCodeHash) { target = { role, account: cand }; break; }
      }
      if (!target) return refused();
      const { account } = target;
      if (!account.resetExpires || Date.now() > account.resetExpires) return refused(); // expired: generic
      if (!P.checkPassword(code, account.resetCodeHash)) return refused(); // wrong code: generic
      account.passwordHash = P.hashPassword(password);
      delete account.resetCodeHash;
      delete account.resetExpires;
      account.passwordResetAt = Date.now();
      await store.set(`account:${email}:${target.role}`, account);
      return json(200, { ok: true });
    }

    return L.bad('Unknown action. Use create-password, signin, signout, me, forgot-password, or reset-password.');
  } catch (e) {
    // Never leak store/key detail to the caller.
    console.error('portal-auth error:', e.message);
    if (/PORTAL_SESSION_SECRET|store is unavailable/.test(e.message)) return unavailable();
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Sign-in is not available right now.' }) };
  }
};
