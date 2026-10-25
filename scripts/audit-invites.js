/**
 * READ-ONLY audit of seat limits, invite codes and org admins, for the invite-function
 * changes (validateInviteCode finds orgs by their `id` field and enforces maxSeats for
 * every org; a code works only while its creator still administers the code's org).
 *
 * It only sends POST .../documents:runQuery (a read). It never writes.
 *
 * Usage (Node 18+, no npm install needed):
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/audit-invites.js
 *
 * Reports:
 *   1. orgs with maxSeats > 0: members (counted as validateInviteCode counts them), whether the
 *      cap is newly enforced, and whether the org is at or over it
 *   2. usable invite codes whose validation result changes after the deploy
 *   3. org docs that change which doc a code resolves to (duplicate id fields, shadowed orgs)
 *   4. every admin and security member, per org, to spot accounts that made themselves admin
 *      under the old rules (flags: joined through a member invite, several admins in one org,
 *      quarantined)
 */
const PROJECT = 'holyguard-app';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const TOKEN = (process.env.GCLOUD_ACCESS_TOKEN || '').trim();
const REVIEW_ORG_ID = 'org_review_1778267123'; // Apple Review Test Org
const SCRIPT_CODE_CREATORS = new Set(['system', 'test-admin', 'e2e-test']); // as in functions/index.js

if (!TOKEN) {
  console.error('Set GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>)');
  process.exit(1);
}

async function runQuery(collectionId, fields) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Goog-User-Project': PROJECT },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], select: { fields: fields.map(fieldPath => ({ fieldPath })) } } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`runQuery ${collectionId} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text).filter(r => r.document).map(r => r.document);
}

function val(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  return '<complex>';
}
const plain = d => ({
  docId: d.name.split('/').pop(),
  createMs: Date.parse(d.createTime),
  updateMs: Date.parse(d.updateTime),
  ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])),
});
const nonEmpty = s => typeof s === 'string' && s.length > 0;
const day = ms => new Date(ms).toISOString().slice(0, 10);

// A profile's org the way the rules and the functions read it.
function profileOrgId(u) {
  const orgId = 'organization_id' in u ? u.organization_id : u.organizationId;
  return typeof orgId === 'string' && orgId !== 'removed' ? orgId : '';
}

async function main() {
  const [orgs, users, codes] = await Promise.all([
    runQuery('organizations', ['id', 'name', 'status', 'maxSeats', 'grandfathered', 'subscriptionPlan', 'subscriptionStatus', 'appleProductId']).then(ds => ds.map(plain)),
    runQuery('users', ['name', 'email', 'role', 'organization_id', 'organizationId', 'inviteJoinQuarantinedAt', 'inviteJoinIntentId']).then(ds => ds.map(plain)),
    runQuery('invite_codes', ['code', 'organizationId', 'role', 'isActive', 'expiresAt', 'maxUses', 'usedCount', 'createdBy']).then(ds => ds.map(plain)),
  ]);

  const byDocId = new Map(orgs.map(o => [o.docId, o]));
  const byIdField = new Map();
  for (const o of orgs) if (nonEmpty(o.id)) byIdField.set(o.id, [...(byIdField.get(o.id) || []), o]);
  const usersById = new Map(users.map(u => [u.docId, u]));

  // The deployed lookup, and the new one (functions/index.js findInviteOrgDoc).
  const oldLookup = key => byDocId.get(key) || null;
  const newLookup = key => {
    const candidates = [...(byIdField.get(key) || [])];
    const direct = byDocId.get(key);
    if (direct && !candidates.includes(direct)) candidates.push(direct);
    return candidates.length ? candidates.reduce((a, b) => (b.createMs < a.createMs ? b : a)) : null;
  };
  const counted = key => users.filter(u => u.organization_id === key).length;
  const capOf = org => (org && Number(org.maxSeats) > 0 ? Number(org.maxSeats) : 0);
  // Why the code's creator no longer vouches for it (null when they still do).
  const creatorProblem = c => {
    const creator = usersById.get(c.createdBy);
    if (!creator) return SCRIPT_CODE_CREATORS.has(c.createdBy) ? null : `unknown creator "${c.createdBy ?? ''}"`;
    if (creator.role === 'super_admin') return null;
    return creator.role === 'admin' && profileOrgId(creator) === c.organizationId ? null : 'creator no longer an admin of this org';
  };

  console.log('\n=== 1. Orgs with maxSeats > 0 ===');
  const capped = orgs.filter(o => capOf(o) > 0).map(o => ({ o, key: nonEmpty(o.id) ? o.id : o.docId }));
  capped.sort((a, b) => (counted(b.key) - capOf(b.o)) - (counted(a.key) - capOf(a.o))); // fullest first
  const rows = capped.map(({ o, key }) => {
    const members = counted(key);
    return {
      name: o.name,
      key,
      plan: `${o.subscriptionPlan || '-'}/${o.subscriptionStatus || '-'}${o.grandfathered === true ? '/grandfathered' : ''}${o.appleProductId ? `/apple:${o.appleProductId}` : ''}`,
      seats: `${members}/${capOf(o)}`,
      enforcement: newLookup(key) !== o ? 'ignored (another doc wins)' : oldLookup(key) === o ? 'already enforced' : 'NEWLY ENFORCED',
      status: members > capOf(o) ? 'OVER LIMIT' : members === capOf(o) ? 'AT LIMIT' : `${capOf(o) - members} free`,
    };
  });
  console.table(rows);

  console.log('\n=== 2. Usable invite codes whose result changes after the deploy ===');
  const now = Date.now();
  const usable = codes.filter(c => c.isActive === true && !(c.expiresAt && c.expiresAt < now) && !(c.maxUses && (c.usedCount || 0) >= c.maxUses));
  const seatResult = (org, key) => {
    const cap = capOf(org);
    const members = cap ? counted(key) : 0;
    return `${cap && members >= cap ? 'BLOCKED (seat limit)' : 'ok'} "${org.name}"${cap ? ` ${members}/${cap}` : ''}`;
  };
  // The deployed function: doc-id lookup, no creator check, unknown orgs still pass.
  const before = (c, key) => {
    if (!nonEmpty(key)) return 'server error (no organization)';
    const org = oldLookup(key);
    return org ? seatResult(org, key) : 'ok "Unknown Organization"';
  };
  // The new function, in its order of checks.
  const after = (c, key) => {
    if (!nonEmpty(key)) return 'REJECTED (no organization)';
    const problem = creatorProblem(c);
    if (problem) return `REJECTED (${problem})`;
    const org = newLookup(key);
    return org ? seatResult(org, key) : 'REJECTED (organization not found)';
  };
  const changed = [];
  for (const c of usable) {
    const key = c.organizationId;
    const was = before(c, key);
    const will = after(c, key);
    if (was !== will) changed.push({ code: c.code, org: String(key), createdBy: c.createdBy, before: was, after: will });
  }
  console.table(changed);

  console.log('\n=== 3. Org docs that change which doc a code resolves to ===');
  let anomalies = 0;
  for (const [id, list] of byIdField) {
    if (list.length > 1) {
      anomalies++;
      console.log(`DUPLICATE id field ${id}: ${list.map(o => `${o.docId} ("${o.name}", created ${day(o.createMs)}, maxSeats ${o.maxSeats ?? '-'})`).join(' | ')}`);
    }
    const legacy = byDocId.get(id);
    if (legacy && !list.includes(legacy) && legacy.id === undefined) {
      anomalies++;
      console.log(`SHADOW: legacy org ${legacy.docId} ("${legacy.name}", created ${day(legacy.createMs)}) vs ${list.map(o => `${o.docId} ("${o.name}", created ${day(o.createMs)})`).join(', ')} carrying its doc id; codes resolve to "${newLookup(id).name}"`);
    }
  }
  if (!anomalies) console.log('none');
  const review = newLookup(REVIEW_ORG_ID);
  console.log(`Apple Review Test Org: ${review ? `doc ${review.docId}, maxSeats ${review.maxSeats ?? '-'}, members ${counted(REVIEW_ORG_ID)}, ${review.grandfathered ? 'grandfathered' : 'not grandfathered'}` : 'not found'}`);

  console.log('\n=== 4. Admins and security members by org ===');
  const staff = users.filter(u => ['admin', 'security', 'super_admin'].includes(u.role));
  const orgName = key => (newLookup(key) || {}).name || '(no org doc)';
  const byOrg = new Map();
  for (const u of staff) {
    const key = profileOrgId(u) || '(none)';
    byOrg.set(key, [...(byOrg.get(key) || []), u]);
  }
  for (const [key, list] of [...byOrg].sort((a, b) => orgName(a[0]).localeCompare(orgName(b[0])))) {
    const admins = list.filter(u => u.role === 'admin').length;
    console.log(`${orgName(key)} [${key}]${admins > 1 ? `  <- ${admins} admins: confirm each` : ''}`);
    for (const u of list.sort((a, b) => a.createMs - b.createMs)) {
      const flags = [
        u.inviteJoinIntentId && 'JOINED THROUGH A MEMBER INVITE',
        u.inviteJoinQuarantinedAt && 'quarantined',
      ].filter(Boolean).join(', ');
      console.log(`  ${u.role.padEnd(11)} ${u.name || '-'} <${u.email || '-'}>  created ${day(u.createMs)}, last changed ${day(u.updateMs)}  uid ${u.docId}${flags ? `  <- ${flags}` : ''}`);
    }
  }

  console.log(`\n${orgs.length} orgs, ${users.length} users, ${codes.length} codes (${usable.length} usable) read. Nothing was written.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
