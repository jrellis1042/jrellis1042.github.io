// Nocturnal website portals — shared server library (portal-auth, portal-request).
// Node, no dependencies except @netlify/blobs in production (see store below).
// HARD RULES (see build report):
//  - Portals READ Pipedrive eligibility; they NEVER approve a registration,
//    NEVER move a deal/stage, NEVER create an app account, NEVER write
//    "verified" from a recruiter action.
//  - No prices in any public payload. Amounts appear ONLY inside a signed-in
//    recruiter session (private pricing + pilot pay, per the recruiter pack).
//    Venue sessions get the amount-free model description only.
//  - No owner references, no internal tool names in any UI copy or payload.
//  - Roles catalog exactly: Bartender, Barback, Door Staff, VIP Host,
//    Bottle Service, Venue Support, Other (Other requires a specify,
//    performer-screened server-side via lib.performerHit).
//  - Claim gate: postings are preview only; claiming unlocks at 75 combined
//    registrations; founding talent may claim early ONLY once verified.
//    v1 implements NO claim that books anything — preview claim buttons are
//    disabled with the gate message.
const crypto = require('crypto');
const L = require('./lib');
const { pd, findPersonByEmail } = L;

const GENERIC_REFUSAL = 'Sign-in is not available for that email.';
const PAYMENT_GATE_MESSAGE = 'Postings activate once your venue payment is received.';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // fixed 7-day expiry, never sliding
const COOKIE_NAME = 'nocturnal_portal_session';
const ROLES = ['Bartender', 'Barback', 'Door Staff', 'VIP Host', 'Bottle Service', 'Venue Support', 'Other'];
const STAGE_LABELS = { 24: 'New Registration', 25: 'Contacted', 26: 'In Verification', 27: 'On the Bench', 28: 'Active' };

function sessionSecret() { return process.env.PORTAL_SESSION_SECRET || ''; }
function requireSecret() {
  const s = sessionSecret();
  if (!s) throw new Error('PORTAL_SESSION_SECRET is not configured.');
  return s;
}

// ---------------------------------------------------------------- store ----
// Production store: Netlify Blobs, store name "nocturnal-portal-auth".
// The Blobs client is only required in production. Local tests set
// PORTAL_AUTH_ALLOW_FILE_STORE=1 and PORTAL_AUTH_FILE_STORE=<path> to use a
// clearly-marked FILE-BACKED TEST STORE. If neither is available, every auth
// action fails closed (never a silent in-memory store in production).
let fileStorePath = null;
function getStore() {
  if (process.env.PORTAL_AUTH_ALLOW_FILE_STORE === '1') {
    const p = process.env.PORTAL_AUTH_FILE_STORE || '/tmp/nocturnal-portal-auth-test-store.json';
    fileStorePath = p;
    return {
      kind: 'file-test-only',
      async get(key) {
        try { const all = JSON.parse(require('fs').readFileSync(p, 'utf8')); return all[key] ?? null; }
        catch { return null; }
      },
      async set(key, value) {
        const fs = require('fs');
        let all = {};
        try { all = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
        all[key] = value;
        fs.writeFileSync(p, JSON.stringify(all, null, 2));
      },
      async delete(key) {
        const fs = require('fs');
        let all = {};
        try { all = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
        delete all[key];
        fs.writeFileSync(p, JSON.stringify(all, null, 2));
      },
    };
  }
  let blobs;
  try { blobs = require('@netlify/blobs'); } catch {
    throw new Error('Portal auth store is unavailable (Blobs not installed).');
  }
  const store = blobs.getStore('nocturnal-portal-auth');
  return {
    kind: 'blobs',
    async get(key) { const v = await store.get(key, { type: 'json' }); return v ?? null; },
    async set(key, value) { await store.setJSON(key, value); },
    async delete(key) { await store.delete(key); },
  };
}

// ------------------------------------------------------------- passwords ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function checkPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split(':');
    const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 128;
}

// -------------------------------------------------------------- sessions ---
function signToken(rawToken, secret) {
  return crypto.createHmac('sha256', secret).update(rawToken).digest('hex');
}
async function createSession(store, account) {
  const secret = requireSecret();
  const raw = crypto.randomBytes(32).toString('hex');
  const record = {
    email: account.email, role: account.role, personId: account.personId,
    dealId: account.dealId || null, orgId: account.orgId || null,
    createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS,
  };
  await store.set(`session:${signToken(raw, secret)}`, record);
  return raw;
}
async function readSession(store, rawToken) {
  if (!rawToken) return null;
  const secret = sessionSecret();
  if (!secret) return null;
  const record = await store.get(`session:${signToken(rawToken, secret)}`);
  if (!record) return null;
  if (Date.now() > record.expiresAt) { await store.delete(`session:${signToken(rawToken, secret)}`); return null; }
  return record; // fixed expiry: never extended on read
}
async function destroySession(store, rawToken) {
  if (!rawToken) return;
  const secret = sessionSecret();
  if (!secret) return;
  await store.delete(`session:${signToken(rawToken, secret)}`);
}
function sessionCookie(rawToken) {
  return `${COOKIE_NAME}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function clearedCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
function tokenFromEvent(event) {
  const headers = event.headers || {};
  const cookie = String(headers.cookie || headers.Cookie || '');
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (m) return decodeURIComponent(m[1]);
  const auth = String(headers.authorization || headers.Authorization || '');
  const b = auth.match(/^Bearer\s+(.+)$/i);
  return b ? b[1] : null;
}

// ------------------------------------------------------------ Pipedrive ---
async function listDealsByPerson(personId) {
  const data = await pd(`/deals?person_id=${personId}&status=open&limit=100`);
  return Array.isArray(data) ? data : (data && data.items ? data.items : []);
}
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
async function dealNotes(dealId) {
  const notes = await pd(`/deals/${dealId}/notes?limit=100`);
  return Array.isArray(notes) ? notes : [];
}
async function personNotes(personId) {
  const notes = await pd(`/notes?person_id=${personId}&limit=100`);
  return Array.isArray(notes) ? notes : [];
}
function hasApprovalNote(notes) {
  return notes.some((n) => String(n.content || '').includes('APPROVED by'));
}
// Venue payment: derived ONLY from a payment marker note. There is no
// payment field on the record in v1, so a marker note is the source of
// truth until the payment webhook writes one. Payment-active NEVER equals
// verified, and verified NEVER equals payment-active.
function paymentActiveFromNotes(notes) {
  return notes.some((n) => {
    const c = String(n.content || '');
    if (/payment-active/i.test(c)) return true;
    if (/payment received/i.test(c) && !/not yet received/i.test(c) && !/payment not received/i.test(c)) return true;
    return false;
  });
}
function verificationState(stageId) {
  if (stageId === 27 || stageId === 28) return 'verified';
  if (stageId === 26) return 'in_verification';
  return 'in_queue'; // approved but not yet verified (stages 24/25)
}
function stageLabel(stageId) { return STAGE_LABELS[stageId] || 'Registered'; }

// Eligibility: approved pipeline-5 deal for the requested talent/venue role.
// Returns null when not eligible (caller maps every null to GENERIC_REFUSAL).
async function eligibleBenchRecord(email, role) {
  const person = await findPersonByEmail(email);
  if (!person) return null;
  const wantedType = role === 'talent' ? String(L.TYPE_TALENT) : String(L.TYPE_VENUE);
  const deals = (await listDealsByPerson(person.id)).filter(
    (d) => d.pipeline_id === L.PIPELINE_BENCH && String(d[L.REGISTRANT_TYPE_KEY] || '') === wantedType && !d.deleted,
  );
  // Prefer the most advanced stage among approved deals.
  deals.sort((a, b) => (b.stage_id || 0) - (a.stage_id || 0));
  for (const deal of deals) {
    const notes = await dealNotes(deal.id);
    if (!hasApprovalNote(notes)) continue;
    return { person, deal, notes };
  }
  return null;
}
// Recruiter eligibility: an explicit approval note on the Person record.
// A proof-complete application alone does NOT grant login (proof gate).
// Cutover note: an approved recruiter's Person record must carry a note
// containing "RECRUITER APPROVED" before first sign-in.
async function eligibleRecruiterRecord(email) {
  const person = await findPersonByEmail(email);
  if (!person) return null;
  const notes = await personNotes(person.id);
  if (!notes.some((n) => String(n.content || '').includes('RECRUITER APPROVED'))) return null;
  return { person, notes };
}
function referralCodeFromNotes(notes) {
  for (const n of notes) {
    const m = String(n.content || '').match(/code=([A-Za-z0-9-]+)/);
    if (m && m[1].toLowerCase() !== 'none' && m[1].toLowerCase() !== 'none yet') return m[1].toUpperCase();
  }
  return null;
}
function stripEmailParen(s) {
  // Referral notes record "Name (email)"; payloads carry the name only.
  return String(s || '').replace(/\s*\([^)]*@[^)]*\)/g, '').trim();
}
function parseReferrals(notes) {
  // Referral attribution ONLY. Names + role + city; emails are stripped.
  const out = [];
  for (const n of notes) {
    const c = String(n.content || '');
    let m = c.match(/RECRUITER REFERRAL .*?talent=([^;]+).*?role=([^;]+)/);
    if (m) { out.push({ kind: 'talent', name: stripEmailParen(m[1]), role: m[2].trim() }); continue; }
    m = c.match(/RECRUITER VENUE REFERRAL .*?venue=([^;]+).*?city=([^;]+)/);
    if (m) out.push({ kind: 'venue', name: stripEmailParen(m[1]), city: m[2].trim() });
  }
  return out;
}
function parseCredentialReviews(deals, code) {
  // Recruiter reviews the recruiter recorded on pipeline-5 deals, matched by
  // referral code. Endorsement only — never "verified" from a recruiter.
  const out = [];
  if (!code) return out;
  for (const deal of deals) {
    for (const n of deal.notes || []) {
      const c = String(n.content || '');
      if (c.includes(`(${code})`) && /Recruiter review by/i.test(c)) {
        const outcome = /flagged/i.test(c) ? 'flagged' : 'endorsed';
        out.push({ talent: String(deal.title || '').split(' — ')[0] || 'Candidate', outcome });
      }
    }
  }
  return out;
}
function parseStaffingRequests(dealsWithNotes) {
  // STAFFING REQUEST notes are the v1 postings inventory. Notes are written
  // WITHOUT contact email/phone, so preview payloads carry no contact PII.
  const out = [];
  for (const { deal, notes } of dealsWithNotes) {
    for (const n of notes) {
      const c = String(n.content || '');
      if (!c.startsWith('STAFFING REQUEST')) continue;
      const get = (k) => { const m = c.match(new RegExp(`${k}=([^;]+)`)); return m ? m[1].trim() : ''; };
      out.push({ venue: get('venue'), role: get('role'), date: get('date'), window: get('window'), dress: get('dress') });
    }
  }
  return out.reverse(); // newest first
}
function parseIntakeFields(dealNotesList) {
  const note = dealNotesList.find((n) => String(n.content || '').startsWith('INTAKE '));
  if (!note) return {};
  const c = String(note.content);
  const get = (k) => { const m = c.match(new RegExp(`${k}=([^;]*)`)); return m ? m[1].trim() : ''; };
  return {
    primaryRole: get('primaryRole'), otherSpecify: get('otherSpecify'),
    otherRoles: get('otherRoles'), city: get('city'), state: get('state'),
    experience: get('experience'), certifications: get('certifications'),
    transportation: get('transportation'), availability: get('availability'),
  };
}

module.exports = {
  GENERIC_REFUSAL, PAYMENT_GATE_MESSAGE, SESSION_TTL_MS, COOKIE_NAME, ROLES,
  sessionSecret, requireSecret, getStore, hashPassword, checkPassword, validPassword,
  createSession, readSession, destroySession, sessionCookie, clearedCookie, tokenFromEvent,
  listDealsByPerson, listAllDeals, dealNotes, personNotes, hasApprovalNote,
  paymentActiveFromNotes, verificationState, stageLabel,
  eligibleBenchRecord, eligibleRecruiterRecord, referralCodeFromNotes,
  parseReferrals, parseCredentialReviews, parseStaffingRequests, parseIntakeFields,
};
