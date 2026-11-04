// Nocturnal CRM — shared store library (intake, counts, bench-preview, crm).
// Replaces Pipedrive as the system of record (Pipedrive trial expired
// 2026-11-03; owner decision: stay free, build in-house — see
// files/pipedrive-exit-plan-2026-11-03.md).
//
// Store: Netlify Blobs, store name "nocturnal-crm", accessed EXACTLY the way
// portal-lib.js accesses its store in production: connectLambda(event) runs
// immediately before getStore, and no siteID/token is passed in code that
// runs on Netlify (Netlify supplies them with the Lambda event).
// Local tests set CRM_ALLOW_FILE_STORE=1 and CRM_FILE_STORE=<path> to use a
// clearly-marked FILE-BACKED TEST STORE (same pattern as portal-lib).
// If neither is available, operations throw — fail closed, never a silent
// in-memory store in production.
//
// Record shapes mirror the Pipedrive backup JSON (persons, organizations,
// deals, notes, activities with the same field names, including the custom
// field keys lib.js defines), so the salvage seed imports without mapping
// and counts/bench/portal semantics carry over unchanged.
//
// Layout inside the store:
//   meta                    -> { nextId: {persons, organizations, deals,
//                               notes, activities}, seededAt, seedCounts,
//                               seedRoleMix }
//   idx:<collection>        -> [record ids]
//   person:<id> / org:<id> / deal:<id> / note:<id> / activity:<id> -> record
const STORE_NAME = 'nocturnal-crm';
const COLLECTIONS = ['persons', 'organizations', 'deals', 'notes', 'activities'];
const PREFIX = { persons: 'person:', organizations: 'org:', deals: 'deal:', notes: 'note:', activities: 'activity:' };

// Last verified live counts (2026-11-03, before the Pipedrive lockout):
// 15 approved talent, 0 approved venues. Used ONLY when the CRM store is
// completely empty/unseeded, so /counts and /bench never report 0 or 502
// for a registry that exists. Role mix computed from the salvage seed's
// INTAKE notes by build_seed.py (see reconciliation.md).
const FALLBACK_COUNTS = { talent: 15, venue: 0 };
const FALLBACK_ROLE_MIX = { Bartender: 10, 'Venue Support': 7, 'VIP Host': 10, Barback: 8, 'Door Staff': 8, 'Bottle Service': 3 };

function getStore(event) {
  if (process.env.CRM_ALLOW_FILE_STORE === '1') {
    const p = process.env.CRM_FILE_STORE || '/tmp/nocturnal-crm-test-store.json';
    const fs = require('fs');
    const readAll = () => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
    const writeAll = (all) => fs.writeFileSync(p, JSON.stringify(all, null, 2));
    return {
      kind: 'file-test-only',
      async get(key) { const all = readAll(); return all[key] ?? null; },
      async set(key, value) { const all = readAll(); all[key] = value; writeAll(all); },
      async delete(key) { const all = readAll(); delete all[key]; writeAll(all); },
      async list(prefix) { return Object.keys(readAll()).filter((k) => k.startsWith(prefix)); },
    };
  }
  let blobs;
  try { blobs = require('@netlify/blobs'); } catch {
    throw new Error('CRM store is unavailable (Blobs not installed).');
  }
  if (event && typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch {}
  }
  // String form ONLY — proven in production with connectLambda above. The
  // options-object form ({ name, consistency }) constructs a store that
  // fails at first get() in this Lambda context (2026-11-03 redeploy
  // incident: every CRM call 502'd until this was reverted).
  const store = blobs.getStore(STORE_NAME);
  return {
    kind: 'blobs',
    async get(key) {
      // Strong-consistency reads: the default eventual reads lagged behind
      // writes by seconds in production, which collided id allocation when
      // two intakes landed back-to-back (2026-11-03 test incident).
      try { const v = await store.get(key, { type: 'json', consistency: 'strong' }); return v ?? null; }
      catch { const v = await store.get(key, { type: 'json' }); return v ?? null; }
    },
    async set(key, value) { await store.setJSON(key, value); },
    async delete(key) { await store.delete(key); },
    // Prefix key scan — the AUTHORITATIVE listing. The idx:<collection>
    // arrays are read-modify-write and Netlify Blobs' eventual consistency
    // clobbered them during the bulk seed (2026-11-03: indexes lost most
    // ids while every record key survived). Listings therefore derive from
    // the record keys themselves; idx is kept only as a legacy fallback.
    async list(prefix) {
      // @netlify/blobs list() returns a single result page when called with
      // { paginate: false }, and an async iterator of pages by default.
      // Support both shapes; never throw (callers fall back to the index).
      const collectFrom = async (opts) => {
        const keys = [];
        const collect = (page) => {
          for (const b of (page && page.blobs) || []) keys.push(b.key);
        };
        const res = await store.list(opts);
        if (res && Array.isArray(res.blobs)) { collect(res); return keys; }
        if (res && typeof res[Symbol.asyncIterator] === 'function') {
          for await (const page of res) collect(page);
          return keys;
        }
        return keys;
      };
      try { return await collectFrom({ prefix, paginate: false, consistency: 'strong' }); }
      catch { try { return await collectFrom({ prefix, paginate: false }); } catch { return []; } }
    },
  };
}

// ------------------------------------------------------------------ meta ---
async function getMeta(store) {
  const m = await store.get('meta');
  if (m && m.nextId) return m;
  return { nextId: { persons: 1, organizations: 1, deals: 1, notes: 1, activities: 1 }, seededAt: null, seedCounts: null, seedRoleMix: null };
}
async function setMeta(store, meta) { await store.set('meta', meta); }

// ----------------------------------------------------------------- CRUD ----
async function listIds(store, collection) {
  if (typeof store.list === 'function') {
    try {
      const keys = await store.list(PREFIX[collection]);
      const ids = keys
        .map((k) => Number(k.slice(PREFIX[collection].length)))
        .filter((n) => Number.isFinite(n));
      if (ids.length) return [...new Set(ids)].sort((a, b) => a - b);
    } catch { /* fall through to the legacy index */ }
  }
  return (await store.get(`idx:${collection}`)) || [];
}
async function listAll(store, collection) {
  const ids = await listIds(store, collection);
  const out = [];
  for (const id of ids) {
    const rec = await store.get(PREFIX[collection] + id);
    if (rec) out.push(rec);
  }
  return out;
}
async function getOne(store, collection, id) {
  return store.get(PREFIX[collection] + Number(id));
}
async function create(store, collection, fields) {
  const meta = await getMeta(store);
  let id = fields && fields.id != null ? Number(fields.id) : null;
  if (id == null) {
    // Allocate from the meta counter (single key, strong-read above), then
    // verify the candidate key is actually free before using it. Key scans
    // lag too much to allocate from (production collision, 2026-11-03).
    id = meta.nextId[collection] || 1;
    while (await getOne(store, collection, id)) id += 1;
  }
  if (id >= (meta.nextId[collection] || 1)) meta.nextId[collection] = id + 1;
  const now = new Date().toISOString();
  const rec = { ...fields, id, add_time: fields.add_time || now, update_time: now };
  await store.set(PREFIX[collection] + id, rec);
  const ids = await listIds(store, collection);
  if (!ids.includes(id)) { ids.push(id); await store.set(`idx:${collection}`, ids); }
  await setMeta(store, meta);
  return rec;
}
async function update(store, collection, id, patch) {
  const rec = await getOne(store, collection, id);
  if (!rec) return null;
  const next = { ...rec, ...patch, id: rec.id, update_time: new Date().toISOString() };
  await store.set(PREFIX[collection] + rec.id, next);
  return next;
}
async function remove(store, collection, id) {
  const rec = await getOne(store, collection, id);
  if (!rec) return false;
  await store.delete(PREFIX[collection] + rec.id);
  const ids = (await listIds(store, collection)).filter((x) => x !== rec.id);
  await store.set(`idx:${collection}`, ids);
  return true;
}

// --------------------------------------------------------------- domain ----
function personEmail(person) {
  if (!person) return '';
  const e = person.email;
  if (Array.isArray(e)) {
    const primary = e.find((x) => x && x.primary) || e[0];
    return String((primary && primary.value) || '').trim().toLowerCase();
  }
  return String(person.primary_email || e || '').trim().toLowerCase();
}
async function findPersonByEmail(store, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const persons = await listAll(store, 'persons');
  return persons.find((p) => personEmail(p) === target) || null;
}
async function findOrgByName(store, name) {
  const orgs = await listAll(store, 'organizations');
  return orgs.find((o) => o.name === name) || null;
}
function normalizeName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
async function findOrgNearName(store, name) {
  const orgs = await listAll(store, 'organizations');
  const target = normalizeName(name);
  const targetTokens = new Set(target.split(' ').filter((t) => t.length >= 3));
  return orgs.filter((o) => {
    if (o.name === name) return false;
    const n = normalizeName(o.name);
    if (n && (n.includes(target) || target.includes(n))) return true;
    const tokens = n.split(' ').filter((t) => t.length >= 3);
    return tokens.some((t) => targetTokens.has(t));
  }).slice(0, 5);
}
async function dealNotes(store, dealId) {
  const notes = await listAll(store, 'notes');
  return notes.filter((n) => Number(n.deal_id) === Number(dealId));
}
async function personNotes(store, personId) {
  const notes = await listAll(store, 'notes');
  return notes.filter((n) => Number(n.person_id) === Number(personId));
}
function hasApprovalNote(notes) {
  return (notes || []).some((n) => String(n.content || '').includes('APPROVED by'));
}

module.exports = {
  STORE_NAME, COLLECTIONS, FALLBACK_COUNTS, FALLBACK_ROLE_MIX,
  getStore, getMeta, setMeta, listIds, listAll, getOne, create, update, remove,
  personEmail, findPersonByEmail, findOrgByName, findOrgNearName,
  dealNotes, personNotes, hasApprovalNote,
};
