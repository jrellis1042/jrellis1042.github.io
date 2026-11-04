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
    };
  }
  let blobs;
  try { blobs = require('@netlify/blobs'); } catch {
    throw new Error('CRM store is unavailable (Blobs not installed).');
  }
  if (event && typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch {}
  }
  const store = blobs.getStore(STORE_NAME);
  return {
    kind: 'blobs',
    async get(key) { const v = await store.get(key, { type: 'json' }); return v ?? null; },
    async set(key, value) { await store.setJSON(key, value); },
    async delete(key) { await store.delete(key); },
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
  if (id == null) id = meta.nextId[collection] || 1;
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
