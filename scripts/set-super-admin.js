/**
 * Make one existing account a super admin, so the Admin Review tab and the
 * reviewOrganization function work (new orgs wait there until they are approved).
 *
 * Writes exactly one field, users/{uid}.role = 'super_admin', and only if the profile is
 * unchanged since this run read it (update-time precondition). Nothing else on the
 * profile, its org or its Auth account changes. Clients can never set this role (the
 * security rules forbid it), so this script is the way to grant it.
 *
 * Refuses when no profile, or more than one, has the email. Prints the profile before
 * and after, plus the account's org: the Admin Review tab is only reachable from inside
 * the app, so the account's org must be active (paid or grandfathered) and verified.
 * The account then signs out and back in to pick up the new role.
 *
 * Talks to the REST API directly (Node 18+, no npm install needed). Dry run by default.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/set-super-admin.js <email> [--apply]
 */
const PROJECT = 'holyguard-app';
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST; // host:port, for testing against a local emulator
const BASE = `${EMULATOR ? `http://${EMULATOR}` : 'https://firestore.googleapis.com'}/v1/projects/${PROJECT}/databases/(default)/documents`;
const TOKEN = EMULATOR ? 'owner' : (process.env.GCLOUD_ACCESS_TOKEN || '').trim();
const ROLE = 'super_admin';
const USAGE = 'Usage: node scripts/set-super-admin.js <email> [--apply]';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Exactly one email and, optionally, --apply. Anything else is a typo, so stop.
let APPLY = false;
let EMAIL = null;
for (const arg of process.argv.slice(2)) {
  if (arg === '--apply') APPLY = true;
  else if (arg.startsWith('--')) fail(`Unknown option: ${arg}\n${USAGE}`);
  else if (EMAIL === null) EMAIL = arg.trim();
  else fail(`Only one email, please.\n${USAGE}`);
}
if (!EMAIL || !EMAIL.includes('@')) fail(USAGE);
if (!TOKEN) fail('Set GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>)');

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': PROJECT,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`${method} ${path.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 500)}`),
      { status: res.status, text });
  }
  return text ? JSON.parse(text) : {};
}

function val(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  return '<complex>';
}
const plain = d => ({
  docName: d.name,
  docId: d.name.split('/').pop(),
  updateTime: d.updateTime,
  f: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])),
});

async function where(collectionId, field, value, limit) {
  const rows = await api('POST', ':runQuery', {
    structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
      ...(limit ? { limit } : {}),
    },
  });
  return rows.filter(r => r.document).map(r => plain(r.document));
}

// A profile's org the way the rules, the functions and the app read it ('' = none).
function profileOrgId(u) {
  const orgId = 'organization_id' in u.f ? u.f.organization_id : u.f.organizationId;
  return typeof orgId === 'string' && orgId !== 'removed' ? orgId : '';
}

const show = v => (v === undefined ? '(absent)' : JSON.stringify(v));

function printProfile(label, p) {
  console.log(`${label}`);
  console.log(`  uid              ${p.docId}`);
  console.log(`  name             ${show(p.f.name)}`);
  console.log(`  email            ${show(p.f.email)}`);
  console.log(`  role             ${show(p.f.role)}`);
  console.log(`  organization_id  ${show(p.f.organization_id)}`);
  console.log(`  organizationId   ${show(p.f.organizationId)}`);
  console.log(`  updateTime       ${p.updateTime}`);
}

// The org a profile points at: by its id field, else a legacy org keyed by doc id.
async function findOrg(orgId) {
  const byField = await where('organizations', 'id', orgId, 2);
  if (byField.length) return byField;
  try {
    return [plain(await api('GET', `/organizations/${encodeURIComponent(orgId)}`))];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function describeOrg(profile) {
  const orgId = profileOrgId(profile);
  if (!orgId) {
    console.log('\nOrg: none. WARNING: an account without an org never gets past sign-in to the');
    console.log('     Admin Review tab. Put it in an active org first (e.g. the owner org).');
    return;
  }
  const orgs = await findOrg(orgId);
  if (!orgs.length) {
    console.log(`\nOrg ${orgId}: NOT FOUND. WARNING: the app can't open the tabs without the org.`);
    return;
  }
  if (orgs.length > 1) console.log(`\nWARNING: ${orgs.length} org docs carry id ${orgId}; showing the first.`);
  const o = orgs[0].f;
  console.log(`\nOrg ${orgId} (doc ${orgs[0].docId}): ${show(o.name)}`);
  console.log(`  status ${show(o.status)}, subscriptionStatus ${show(o.subscriptionStatus)}, grandfathered ${show(o.grandfathered)}`);
  if (o.status === 'pending' || o.status === 'rejected') {
    console.log(`  WARNING: the org is ${o.status}, so the app shows its ${o.status} screen instead of the tabs.`);
  } else if (o.grandfathered !== true && o.subscriptionStatus !== 'active') {
    console.log('  WARNING: the org is neither active nor grandfathered, so the app shows the paywall');
    console.log('  instead of the tabs. Grandfather it or move the account to an active org.');
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);

  // Profiles keep the email as typed at sign-up, so compare every profile's email
  // ignoring case (Firestore has no case-insensitive query; the users collection is
  // small). A second profile whose email differs only in case is found, and the script
  // refuses.
  const rows = await api('POST', ':runQuery', {
    structuredQuery: { from: [{ collectionId: 'users' }], select: { fields: [{ fieldPath: 'email' }] } },
  });
  const ids = rows.filter(r => r.document).map(r => plain(r.document))
    .filter(p => typeof p.f.email === 'string' && p.f.email.trim().toLowerCase() === EMAIL.toLowerCase())
    .map(p => p.docId);
  const matches = [];
  for (const id of ids) matches.push(plain(await api('GET', `/users/${encodeURIComponent(id)}`)));
  if (matches.length === 0) fail(`No profile has email ${EMAIL}. Nothing written.`);
  if (matches.length > 1) {
    fail(`${matches.length} profiles have email ${EMAIL} (uids ${matches.map(p => p.docId).join(', ')}). ` +
      'Refusing to guess. Nothing written.');
  }
  const profile = matches[0];
  printProfile('Profile now:', profile);

  const current = await where('users', 'role', ROLE);
  console.log(`\nExisting super admins: ${current.length ? current.map(p => `${p.docId} (${show(p.f.email)})`).join(', ') : 'none'}`);

  await describeOrg(profile);

  if (profile.f.role === ROLE) {
    console.log(`\nAlready ${ROLE}. Nothing to do.`);
    return;
  }

  console.log(`\n${APPLY ? 'Writing' : 'Would write'}: role ${show(profile.f.role)} -> "${ROLE}"`);
  console.log(`  (only that field, and only if the profile's update time is still ${profile.updateTime})`);
  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return;
  }

  const path = `/users/${encodeURIComponent(profile.docId)}` +
    `?updateMask.fieldPaths=role&currentDocument.updateTime=${encodeURIComponent(profile.updateTime)}`;
  try {
    await api('PATCH', path, { fields: { role: { stringValue: ROLE } } });
  } catch (error) {
    if (error.status === 400 && /FAILED_PRECONDITION/.test(error.text || '')) {
      fail('\nThe profile changed after it was read. Nothing written; run the script again.');
    }
    throw error;
  }

  const after = plain(await api('GET', `/users/${encodeURIComponent(profile.docId)}`));
  console.log('');
  printProfile('Profile after:', after);
  if (after.f.role !== ROLE) fail(`\nUNEXPECTED: role reads ${show(after.f.role)} after the write.`);
  console.log(`\nDone. Sign that account out of the app and back in to load the ${ROLE} role.`);
}

main().catch(e => fail(`FAILED: ${e.message}`));
