/**
 * Remove a member from their organization, freeing the seat. Does what the app's
 * Seat Management > Remove would do (the rules deny that write from the app):
 * users/{uid}.organization_id = 'removed' and role = 'member'. The account itself is
 * kept; it simply has no org, so the rules give it no org data and the seat count
 * (users where organization_id == org id) drops by one.
 *
 * Talks to the REST APIs directly (no npm install needed). Dry run by default.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/remove-member.js (--email person@example.com | --uid <uid>) [--apply]
 */
const PROJECT = 'holyguard-app';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APPLY = process.argv.includes('--apply');
const EMAIL = (arg('--email', '') || '').trim().toLowerCase();
const UID = (arg('--uid', '') || '').trim();
const TOKEN = (process.env.GCLOUD_ACCESS_TOKEN || '').trim();

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!EMAIL === !UID) fail('Pass exactly one of --email or --uid');
if (!TOKEN) fail('Set GCLOUD_ACCESS_TOKEN (gcloud auth print-access-token --account=<project owner>)');

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': PROJECT,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

const str = (doc, field) => (doc.fields && doc.fields[field] ? doc.fields[field].stringValue : undefined);

async function usersWhere(field, value) {
  const rows = await api('POST', `${FIRESTORE}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
    },
  });
  return rows.filter(r => r.document).map(r => r.document);
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);

  let doc;
  if (UID) {
    doc = await api('GET', `${FIRESTORE}/users/${encodeURIComponent(UID)}`);
  } else {
    const matches = await usersWhere('email', EMAIL);
    if (matches.length !== 1) fail(`Expected exactly one profile with email ${EMAIL}, found ${matches.length}`);
    doc = matches[0];
  }
  const uid = doc.name.split('/').pop();
  const role = str(doc, 'role');
  const orgId = doc.fields && 'organization_id' in doc.fields ? str(doc, 'organization_id') : str(doc, 'organizationId');

  console.log(`User:   ${str(doc, 'name') || '-'} <${str(doc, 'email') || '-'}>  uid ${uid}`);
  console.log(`Now:    role ${role || '-'}, organization ${orgId || '(none)'}`);
  if (role === 'super_admin') fail('Refusing to remove a super_admin.');
  if (!orgId || orgId === 'removed') fail('This profile is not in an organization; nothing to do.');

  const seatsUsed = (await usersWhere('organization_id', orgId)).length;
  console.log(`Org ${orgId}: ${seatsUsed} seat(s) used now, ${seatsUsed - 1} after removal`);
  console.log(`Will set: organization_id 'removed', role 'member'`);

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to write.');
    return;
  }
  await api('PATCH',
    `${FIRESTORE}/users/${encodeURIComponent(uid)}?updateMask.fieldPaths=organization_id&updateMask.fieldPaths=role&currentDocument.exists=true`,
    { fields: { organization_id: { stringValue: 'removed' }, role: { stringValue: 'member' } } });
  console.log('\nRemoved.');
}

main().catch(e => fail(`FAILED: ${e.message}`));
