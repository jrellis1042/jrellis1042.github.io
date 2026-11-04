// GET /.netlify/functions/board-data — data feed for the Nocturnal CRM
// owner board (board.html). READ-ONLY: this function never writes.
// PHASE 3 (2026-11-03), built on the Phase 0/1 in-house CRM (crm-lib.js).
//
// GUARD: same pattern as crm.js — every request must carry header
// `x-crm-key` equal to the CRM_API_KEY env var. Missing env -> 503 fail
// closed. Wrong/missing key -> 401. (The owner-portal session was NOT
// reused: its overview payload in portal-auth is roster-shaped, and the
// key guard lets the board page ask for the key once and keep it in
// sessionStorage only — see board.html and README.)
//
// Response: { success: true, data: { pipelineTallies, pipelines: [
//   { id, name, stages: [ { id, name, deals: [card] } ] } ],
//   dealDetails: { "<dealId>": { notes: [...], activities: [...] } } } }
// Cards carry title + person/org display name + city/zone only.
// No prices anywhere. No contact emails/phones on cards; detail notes and
// open activities are included because the board sits behind the key guard.
const crypto = require('crypto');
const L = require('./lib');
const C = require('./crm-lib');
const P = require('./portal-lib'); // parseIntakeFields only (pure parser)

const PIPELINES = [
  { id: 1, name: 'NSA Pipeline' },
  { id: 3, name: 'NSA Marketing' },
  { id: 4, name: 'NSA Rotation Sources' },
  { id: 5, name: 'NSA Rotation Building' },
];
const STAGES = {
  1: [{ id: 1, name: 'Lead' }, { id: 2, name: 'Contacted' }, { id: 3, name: 'Meeting Set' }, { id: 4, name: 'Pilot' }, { id: 5, name: 'Signed' }],
  3: [],
  4: [],
  5: [
    { id: 24, name: 'New Registration' }, { id: 25, name: 'Contacted' },
    { id: 26, name: 'In Verification' }, { id: 27, name: 'On the Rotation' },
    { id: 28, name: 'Active' },
  ],
};

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
function ok(data) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, data }) };
}
function fail(code, error) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error }) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');
  const guard = keyOk(event);
  if (guard === 'unconfigured') return fail(503, 'CRM_API_KEY is not configured.');
  if (!guard) return fail(401, 'Unauthorized.');
  try {
    const store = C.getStore(event);
    const [deals, persons, orgs, notes, activities] = await Promise.all([
      C.listAll(store, 'deals'), C.listAll(store, 'persons'),
      C.listAll(store, 'organizations'), C.listAll(store, 'notes'),
      C.listAll(store, 'activities'),
    ]);
    const open = deals.filter((d) => !d.deleted && (d.status === 'open' || !d.status));
    const personName = new Map(persons.map((p) => [Number(p.id), p.name || '']));
    const orgName = new Map(orgs.map((o) => [Number(o.id), o.name || '']));
    const notesByDeal = new Map();
    for (const n of notes) {
      if (n.deal_id == null) continue;
      const k = Number(n.deal_id);
      if (!notesByDeal.has(k)) notesByDeal.set(k, []);
      notesByDeal.get(k).push(n);
    }
    const openActsByDeal = new Map();
    for (const a of activities) {
      if (a.deal_id == null || a.done) continue;
      const k = Number(a.deal_id);
      if (!openActsByDeal.has(k)) openActsByDeal.set(k, []);
      openActsByDeal.get(k).push(a);
    }

    const pipelineTallies = {};
    for (const d of open) pipelineTallies[String(d.pipeline_id)] = (pipelineTallies[String(d.pipeline_id)] || 0) + 1;

    const cardFor = (d) => {
      const dn = notesByDeal.get(Number(d.id)) || [];
      const fields = P.parseIntakeFields(dn);
      const city = fields.city ? (fields.state ? `${fields.city}, ${fields.state}` : fields.city) : null;
      return {
        id: d.id,
        title: d.title || 'Record',
        personName: d.person_id != null ? (personName.get(Number(d.person_id)) || null) : null,
        orgName: d.org_id != null ? (orgName.get(Number(d.org_id)) || d.org_name || null) : (d.org_name || null),
        city,
        zone: d[L.ZONE_KEY] || null,
        stageId: d.stage_id,
        pipelineId: d.pipeline_id,
      };
    };

    const pipelines = PIPELINES.map((pl) => {
      const plDeals = open.filter((d) => Number(d.pipeline_id) === pl.id);
      const stageDefs = STAGES[pl.id] && STAGES[pl.id].length
        ? STAGES[pl.id]
        : [...new Set(plDeals.map((d) => d.stage_id))].sort((a, b) => a - b).map((id) => ({ id, name: `Stage ${id}` }));
      const stages = stageDefs.map((s) => ({
        id: s.id, name: s.name,
        deals: plDeals.filter((d) => Number(d.stage_id) === s.id).map(cardFor),
      }));
      const placed = new Set(stages.flatMap((s) => s.deals.map((c) => c.id)));
      const rest = plDeals.filter((d) => !placed.has(Number(d.id)));
      if (rest.length) stages.push({ id: 0, name: 'Other Stage', deals: rest.map(cardFor) });
      return { id: pl.id, name: pl.name, total: plDeals.length, stages };
    });

    const dealDetails = {};
    for (const d of open) {
      const dn = (notesByDeal.get(Number(d.id)) || [])
        .map((n) => ({ id: n.id, content: String(n.content || ''), addTime: n.add_time || null }));
      const da = (openActsByDeal.get(Number(d.id)) || [])
        .map((a) => ({ id: a.id, subject: a.subject || '', type: a.type || '', dueDate: a.due_date || null, note: a.note || '' }));
      if (dn.length || da.length) dealDetails[String(d.id)] = { notes: dn, activities: da };
    }

    return ok({ pipelineTallies, totalOpen: open.length, pipelines, dealDetails });
  } catch (e) {
    console.error('board-data error:', e.message);
    return fail(502, 'CRM store unavailable.');
  }
};
