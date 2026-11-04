// Nocturnal CRM API — key-guarded CRUD over the in-house CRM store
// (Netlify Blobs, store "nocturnal-crm"; see crm-lib.js). Replaces the
// Pipedrive API for the agent desks after the Pipedrive trial expired
// 2026-11-03. Record shapes mirror Pipedrive's, and the response envelope
// is { success, data } like Pipedrive's, so desk tooling translates 1:1.
//
// GUARD: every request must carry header `x-crm-key` equal to the
// CRM_API_KEY env var (set in Netlify env by the owner — never committed).
// Missing env -> 503 fail closed. Wrong key -> 401.
//
// Routes (path after /.netlify/functions/crm):
//   GET    /deals?status=open&pipeline_id=5&stage_id=24&person_id=&org_id=
//   GET    /deals/:id            POST /deals           PUT /deals/:id
//   DELETE /deals/:id
//   GET    /deals/:id/notes      (notes for one deal)
//   ... same CRUD for /organizations, /persons, /activities
//   GET    /notes?deal_id=&person_id=
//   POST   /notes                (deal_id in body, mirrors Pipedrive)
//   POST   /seed                 { collection, records: [...] } per chunk,
//                                or { meta: {...} } to set seed metadata
//   GET    /health               record counts (key-guarded like everything)
const crypto = require('crypto');
const L = require('./lib');
const C = require('./crm-lib');

const COLLECTIONS = new Set(C.COLLECTIONS);

function keyOk(event) {
  const expected = process.env.CRM_API_KEY || '';
  if (!expected) return 'unconfigured';
  const headers = event.headers || {};
  const given = String(headers['x-crm-key'] || headers['X-Crm-Key'] || '');
  if (!given || given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? true : false;
  } catch { return false; }
}
function ok(data, code = 200) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, data }) };
}
function fail(code, error) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error }) };
}
function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); } catch { return null; }
}
function routeOf(event) {
  // Netlify passes the full path; strip the function prefix and any
  // /crm redirect prefix so both /.netlify/functions/crm/deals/5 and
  // /crm/deals/5 (redirect target keeps the original path) work.
  let p = String(event.path || '');
  p = p.replace(/^.*\/\.netlify\/functions\/crm/, '');
  if (p === '/crm' || p.startsWith('/crm/')) p = p.slice(4);
  return p || '/';
}
function applyFilters(records, q, collection) {
  let out = records;
  const get = (k) => q.get(k);
  if (collection === 'deals') {
    if (get('status')) out = out.filter((d) => String(d.status || 'open') === get('status'));
    if (get('pipeline_id')) out = out.filter((d) => Number(d.pipeline_id) === Number(get('pipeline_id')));
    if (get('stage_id')) out = out.filter((d) => Number(d.stage_id) === Number(get('stage_id')));
    if (get('person_id')) out = out.filter((d) => Number(d.person_id) === Number(get('person_id')));
    if (get('org_id')) out = out.filter((d) => Number(d.org_id) === Number(get('org_id')));
  }
  if (collection === 'notes') {
    if (get('deal_id')) out = out.filter((n) => Number(n.deal_id) === Number(get('deal_id')));
    if (get('person_id')) out = out.filter((n) => Number(n.person_id) === Number(get('person_id')));
  }
  if (collection === 'activities') {
    if (get('deal_id')) out = out.filter((a) => Number(a.deal_id) === Number(get('deal_id')));
    if (get('done')) out = out.filter((a) => String(Boolean(a.done)) === get('done'));
  }
  const limit = Number(get('limit') || 0);
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

exports.handler = async (event) => {
  const guard = keyOk(event);
  if (guard === 'unconfigured') return fail(503, 'CRM_API_KEY is not configured.');
  if (!guard) return fail(401, 'Unauthorized.');
  const method = event.httpMethod;
  const route = routeOf(event);
  // Prefer rawQuery when present; fall back to queryStringParameters.
  const params = event.rawQuery ? new URLSearchParams(event.rawQuery) : new URLSearchParams(event.queryStringParameters || {});
  try {
    const store = C.getStore(event);

    if (route === '/health' && method === 'GET') {
      const counts = {};
      for (const c of C.COLLECTIONS) counts[c] = (await C.listIds(store, c)).length;
      const meta = await C.getMeta(store);
      return ok({ counts, seededAt: meta.seededAt || null });
    }

    if (route === '/seed' && method === 'POST') {
      const body = parseBody(event);
      if (!body) return fail(400, 'Invalid JSON body.');
      if (body.meta) {
        const meta = await C.getMeta(store);
        const next = { ...meta, ...body.meta, nextId: { ...meta.nextId, ...(body.meta.nextId || {}) } };
        next.seededAt = new Date().toISOString();
        await C.setMeta(store, next);
        return ok({ seeded: 'meta' });
      }
      const collection = body.collection;
      if (!COLLECTIONS.has(collection) || !Array.isArray(body.records)) {
        return fail(400, 'Seed chunk needs { collection, records: [] }.');
      }
      let n = 0;
      for (const rec of body.records) { await C.create(store, collection, rec); n += 1; }
      return ok({ seeded: collection, records: n });
    }

    const m = route.match(/^\/([a-z]+)(?:\/(\d+))?(\/notes)?$/);
    if (!m) return fail(404, 'Not found.');
    const collection = m[1];
    const id = m[2] ? Number(m[2]) : null;
    const subNotes = Boolean(m[3]);
    if (!COLLECTIONS.has(collection)) return fail(404, 'Unknown collection.');

    if (subNotes) {
      if (collection !== 'deals' || method !== 'GET') return fail(404, 'Not found.');
      return ok(await C.dealNotes(store, id));
    }
    if (id == null) {
      if (method === 'GET') return ok(applyFilters(await C.listAll(store, collection), params, collection));
      if (method === 'POST') {
        const body = parseBody(event);
        if (!body) return fail(400, 'Invalid JSON body.');
        return ok(await C.create(store, collection, body), 201);
      }
      return fail(405, 'Method not allowed.');
    }
    if (method === 'GET') {
      const rec = await C.getOne(store, collection, id);
      return rec ? ok(rec) : fail(404, 'Record not found.');
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = parseBody(event);
      if (!body) return fail(400, 'Invalid JSON body.');
      const rec = await C.update(store, collection, id, body);
      return rec ? ok(rec) : fail(404, 'Record not found.');
    }
    if (method === 'DELETE') {
      const done = await C.remove(store, collection, id);
      return done ? ok({ deleted: id }) : fail(404, 'Record not found.');
    }
    return fail(405, 'Method not allowed.');
  } catch (e) {
    console.error('crm error:', e.message);
    return fail(502, 'CRM store unavailable.');
  }
};
