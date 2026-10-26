// Nocturnal intake shared library — Netlify Functions (Node, no dependencies).
// Token rule: PIPEDRIVE_API_TOKEN comes ONLY from Netlify env settings, placed
// there by Rashad's hand. Never commit a real token, never log it, never put
// it in client-side code. In this repo it is always the placeholder below
// in docs; at runtime process.env.PIPEDRIVE_API_TOKEN is the only source.
const PIPEDRIVE_BASE = process.env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com/v1';
const REGISTRANT_TYPE_KEY = '492d2968a51b96b509c0eb23d78e145ba2651304';
const ZONE_KEY = 'c62a2488924ae58b25eb7a26bdd719948eef2de6';
const PIPELINE_BENCH = 5;
const STAGE_NEW_REGISTRATION = 24;
const TYPE_TALENT = 54;
const TYPE_VENUE = 55;
const GATE = 75;
const FOUNDING_TALENT_CAP = 50;
const FOUNDING_VENUE_CAP = 10;

const US_STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'];
// Talent Primary role (RADIO) — audited 2026-10-25, exact.
// Talent Other roles (CHECKBOX) — audited EXACT list: Bottle Service is NOT
// in this checkbox list. Mirror it exactly; do not silently "fix" it.
const TALENT_PRIMARY_ROLES = ['Bartender','Barback','Door Staff','VIP Host','Bottle Service','Venue Support Staff','Other'];
const TALENT_OTHER_ROLES = ['Bartender','Barback','Door Staff','VIP Host','Venue Support Staff'];
const TALENT_EXPERIENCE = ['Less than 1 year','1–2 years','3–5 years','5+ years'];
const TALENT_CERTS = ['Florida Responsible Vendor','alcohol service training','Food handler card','Security Class D license','CPR or first aid','None yet'];
const TALENT_AVAILABILITY = ['Thursday','Friday','Saturday','Sunday','Weeknights'];
const VENUE_ROLES = ['Owner','General Manager','Bar Manager','Hiring Manager','Other'];
const VENUE_TYPES = ['Nightclub','Bar','Lounge','Restaurant with bar','Event venue','Other'];
const VENUE_ROLES_NEEDED = ['Bartenders','Barbacks','Door staff','VIP hosts','Bottle Service','Venue support staff','Other'];
const VENUE_NIGHTS = ['Thursday','Friday','Saturday','Sunday','Weeknights','Special events only'];
const VENUE_CALLOUT_FREQ = ['Almost every weekend','A few times a month','Rarely — but it burns when it happens','Almost never'];
// Performer screen — same server-side screen the app applies to Other specify.
// A hit does NOT reject the submission; it flags it (deal created, flag note
// added, watcher v2 must never auto-approve it).
const PERFORMER_TERMS = ['dj','disc jockey','musician','singer','performer','entertainment','emcee','mc ','host/entertainment','model','promotional model','dancer','stripper','go-go','actor','actress','comedian','magician'];
function performerHit(text) {
  const t = String(text || '').toLowerCase();
  return PERFORMER_TERMS.some((w) => t.includes(w));
}
function zoneFor(city, state) {
  const c = String(city || '').toLowerCase();
  if (state === 'Florida') {
    if (/(tampa|ybor)/.test(c)) return 'West - Tampa/Ybor';
    if (/(lakeland|winter haven|polk|plant city|haines city|davenport)/.test(c)) return 'Center - Lakeland/Polk';
    if (/(orlando|kissimmee|clermont)/.test(c)) return 'East - Orlando';
  }
  return null; // registration is nationwide; Zone unset outside corridor cities
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }
function bad(msg) { return { statusCode: 400, body: JSON.stringify({ ok: false, error: msg }) }; }
function ok(body, code = 200) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

async function pd(path, method = 'GET', body) {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) throw new Error('PIPEDRIVE_API_TOKEN is not configured in Netlify env settings.');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${PIPEDRIVE_BASE}${path}${sep}api_token=${encodeURIComponent(token)}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(`Pipedrive ${method} ${path} failed: ${JSON.stringify(json.error || json).slice(0, 300)}`);
  return json.data;
}
async function findPersonByEmail(email) {
  const data = await pd(`/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true`);
  const items = data && data.items ? data.items : [];
  return items.length ? items[0].item : null;
}
async function findOrgByName(name) {
  const data = await pd(`/organizations/search?term=${encodeURIComponent(name)}&exact_match=true`);
  const items = data && data.items ? data.items : [];
  const exact = items.find((i) => i.item && i.item.name === name);
  return exact ? exact.item : null;
}
async function findOrgNearName(name) {
  const data = await pd(`/organizations/search?term=${encodeURIComponent(name)}`);
  const items = (data && data.items ? data.items : []).map((i) => i.item).filter(Boolean);
  return items.filter((o) => o.name !== name).slice(0, 5);
}
module.exports = { REGISTRANT_TYPE_KEY, ZONE_KEY, PIPELINE_BENCH, STAGE_NEW_REGISTRATION, TYPE_TALENT, TYPE_VENUE, GATE, FOUNDING_TALENT_CAP, FOUNDING_VENUE_CAP, US_STATES, TALENT_PRIMARY_ROLES, TALENT_OTHER_ROLES, TALENT_EXPERIENCE, TALENT_CERTS, TALENT_AVAILABILITY, VENUE_ROLES, VENUE_TYPES, VENUE_ROLES_NEEDED, VENUE_NIGHTS, VENUE_CALLOUT_FREQ, performerHit, zoneFor, isEmail, bad, ok, pd, findPersonByEmail, findOrgByName, findOrgNearName };
