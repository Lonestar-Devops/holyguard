/**
 * Provision a sponsored (paywall-free) organization with its first admin.
 *
 * Creates, in one shot:
 *   - a Firebase Auth login for the admin (email pre-verified, temporary password)
 *   - organizations/{orgId} with doc ID == id field, status 'verified',
 *     grandfathered + subscriptionStatus 'active', and a seat cap (maxSeats)
 *   - the default #general channel (isDefault: true) the Team tab needs for INVITE
 *   - users/{uid} with role 'admin' and organization_id (no tos_accepted_at, so
 *     the admin accepts the Terms in-app on first login)
 *
 * The admin then adds members in-app: Team tab -> INVITE -> + GENERATE NEW CODE.
 *
 * Talks to the REST APIs directly (no npm install needed). Dry run by default.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/provision-sponsored-org.js \
 *     --org-name "Org Name" --admin-email admin@example.com --admin-name "Name" \
 *     --address "123 Main St, City, ST 12345, USA" --lat 32.1 --lng -111.1 \
 *     [--seats 7] [--org-email contact@example.com] [--note "Sponsored by ..."] [--apply]
 */
const crypto = require('crypto');

const PROJECT = 'holyguard-app';
const DB_PATH = `projects/${PROJECT}/databases/(default)/documents`;
const FIRESTORE = `https://firestore.googleapis.com/v1/${DB_PATH}`;
const IDENTITY = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APPLY = process.argv.includes('--apply');
const ORG_NAME = (arg('--org-name', '') || '').trim();
const ADMIN_EMAIL = (arg('--admin-email', '') || '').trim().toLowerCase();
const ADMIN_NAME = (arg('--admin-name', '') || '').trim();
const ADDRESS = (arg('--address', '') || '').trim();
const LAT = Number(arg('--lat', 'NaN'));
const LNG = Number(arg('--lng', 'NaN'));
const SEATS = parseInt(arg('--seats', '7'), 10);
const ORG_EMAIL = (arg('--org-email', ADMIN_EMAIL) || '').trim().toLowerCase();
const NOTE = arg('--note', null);
const TOKEN = (process.env.GCLOUD_ACCESS_TOKEN || '').trim();

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!ORG_NAME || !ADMIN_NAME || !ADDRESS) fail('Missing --org-name, --admin-name or --address');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL)) fail('Missing or invalid --admin-email');
if (!Number.isFinite(LAT) || !Number.isFinite(LNG) || Math.abs(LAT) > 90 || Math.abs(LNG) > 180) fail('Missing or invalid --lat/--lng');
if (!Number.isInteger(SEATS) || SEATS < 1) fail('Invalid --seats');
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

// Firestore REST value encoding for the field types we write
function enc(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  throw new Error(`Unsupported value: ${value}`);
}

function fields(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)]));
}

function autoId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) id += chars[crypto.randomInt(chars.length)];
  return id;
}

// Typeable on a phone, meets the app's rules (8+ chars, a letter and a number)
function tempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    const groups = [0, 1, 2].map(() => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''));
    const pw = `Hg-${groups.join('-')}`;
    if (/\d/.test(pw) && /[a-z]/i.test(pw)) return pw;
  }
}

async function queryEqual(collectionId, fieldPath, value) {
  const rows = await api('POST', `${FIRESTORE}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: enc(value) } },
      limit: 5,
    },
  });
  return rows.filter(r => r.document).map(r => r.document);
}

async function queryPrefix(collectionId, fieldPath, prefix) {
  const rows = await api('POST', `${FIRESTORE}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath }, op: 'GREATER_THAN_OR_EQUAL', value: enc(prefix) } },
            { fieldFilter: { field: { fieldPath }, op: 'LESS_THAN', value: enc(prefix + '') } },
          ],
        },
      },
      limit: 5,
    },
  });
  return rows.filter(r => r.document).map(r => r.document);
}

function docName(doc) {
  const f = doc.fields || {};
  return `${doc.name.split('/').pop()} (name: ${f.name ? f.name.stringValue : '?'}, id: ${f.id ? f.id.stringValue : '?'})`;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);

  // 1. Preflight: refuse to touch anything that already exists
  const lookup = await api('POST', `${IDENTITY}/accounts:lookup`, { email: [ADMIN_EMAIL] });
  if (lookup.users && lookup.users.length) {
    fail(`ABORT: an Auth account already exists for ${ADMIN_EMAIL} (uid ${lookup.users[0].localId}). Fix it by hand instead.`);
  }
  const existingProfiles = await queryEqual('users', 'email', ADMIN_EMAIL);
  if (existingProfiles.length) fail(`ABORT: users doc(s) already exist for ${ADMIN_EMAIL}: ${existingProfiles.map(d => d.name.split('/').pop()).join(', ')}`);

  const exact = await queryEqual('organizations', 'name', ORG_NAME);
  if (exact.length) fail(`ABORT: an organization named "${ORG_NAME}" already exists:\n  ${exact.map(docName).join('\n  ')}`);
  const firstWord = ORG_NAME.split(/\s+/)[0];
  const similar = await queryPrefix('organizations', 'name', firstWord);
  if (similar.length) {
    console.warn(`WARNING: organizations starting with "${firstWord}" exist (check this isn't a duplicate):\n  ${similar.map(docName).join('\n  ')}\n`);
  }
  console.log(`Preflight OK: no Auth account or profile for ${ADMIN_EMAIL}; no org named "${ORG_NAME}"\n`);

  const orgId = `org_${Date.now()}`;
  const channelId = autoId();
  const org = {
    id: orgId,
    name: ORG_NAME,
    address: ADDRESS,
    latitude: LAT,
    longitude: LNG,
    status: 'verified',
    ein: null,
    website: null,
    orgEmail: ORG_EMAIL,
    phone: null,
    verificationScore: 100,
    grandfathered: true,
    subscriptionStatus: 'active',
    subscriptionPlan: 'grandfathered',
    maxSeats: SEATS,
    ...(NOTE ? { sponsorNote: NOTE } : {}),
  };

  console.log(`Will create Auth login: ${ADMIN_NAME} <${ADMIN_EMAIL}> (email pre-verified, temporary password)`);
  console.log(`Will create organizations/${orgId}:`);
  console.log(JSON.stringify(org, null, 2).replace(/^/gm, '    '));
  console.log(`Will create channels/${channelId}: #general (isDefault: true, organizationId: ${orgId})`);
  console.log(`Will create users/<new uid>: role admin, organization_id ${orgId}, email_verified true (Terms accepted in-app)`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return;
  }

  // 2. Auth login
  const password = tempPassword();
  const created = await api('POST', `${IDENTITY}/accounts`, {
    email: ADMIN_EMAIL,
    password,
    displayName: ADMIN_NAME,
    emailVerified: true,
  });
  const uid = created.localId;
  console.log(`\nCreated Auth user ${uid}`);

  // 3. Org + channel + profile in a single atomic commit
  const now = 'REQUEST_TIME';
  try {
    await api('POST', `${FIRESTORE}:commit`, {
      writes: [
        {
          update: { name: `${DB_PATH}/organizations/${orgId}`, fields: fields(org) },
          currentDocument: { exists: false },
          updateTransforms: [
            { fieldPath: 'created_at', setToServerValue: now },
            { fieldPath: 'verificationSubmittedAt', setToServerValue: now },
            { fieldPath: 'subscriptionUpdatedAt', setToServerValue: now },
          ],
        },
        {
          update: {
            name: `${DB_PATH}/channels/${channelId}`,
            fields: fields({ name: 'general', organizationId: orgId, createdBy: uid, isDefault: true }),
          },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: now }],
        },
        {
          update: {
            name: `${DB_PATH}/users/${uid}`,
            fields: fields({ id: uid, name: ADMIN_NAME, email: ADMIN_EMAIL, role: 'admin', organization_id: orgId, email_verified: true }),
          },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'created_at', setToServerValue: now }],
        },
      ],
    });
  } catch (e) {
    console.error('Firestore commit failed, deleting the new Auth user so nothing is half-created');
    await api('POST', `${IDENTITY}/accounts:delete`, { localId: uid }).catch(err => console.error('Rollback failed:', err.message));
    throw e;
  }

  // 4. Read back what was written
  const [orgDoc, channelDoc, userDoc] = await Promise.all([
    api('GET', `${FIRESTORE}/organizations/${orgId}`),
    api('GET', `${FIRESTORE}/channels/${channelId}`),
    api('GET', `${FIRESTORE}/users/${uid}`),
  ]);
  const plain = doc => Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, Object.values(v)[0]]));

  console.log('\n================ SUMMARY ================');
  console.log(`Org:      ${ORG_NAME}  (organizations/${orgId})`);
  console.log(`          ${JSON.stringify(plain(orgDoc))}`);
  console.log(`Channel:  channels/${channelId}  ${JSON.stringify(plain(channelDoc))}`);
  console.log(`Admin:    users/${uid}  ${JSON.stringify(plain(userDoc))}`);
  console.log(`Seats:    ${SEATS} total (admin + ${SEATS - 1})`);
  console.log(`Login:    ${ADMIN_EMAIL}`);
  console.log(`Temp password: ${password}`);
  console.log('=========================================');
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
