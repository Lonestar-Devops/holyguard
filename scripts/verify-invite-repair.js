/**
 * End-to-end check, in production, of joining an org by invite code and of
 * Seat Management > Remove, using throwaway accounts.
 *
 * Makes the same requests as the live app, with each user's own ID token so the
 * security rules apply:
 *   1. a test admin mints an invite code with generateInviteCode
 *   2. the joiner's app POSTs {inviteCode} to validateInviteCode
 *   3. the joiner's Auth account is created through the public sign-up API (web API key)
 *   4. users/{uid} is created with the joiner's ID token, with role '' and
 *      organization_id '' (the live sign-up bug); the repairInviteJoin trigger
 *      then attaches the user to the org
 *   5. with the org full, another join is refused (seat limit)
 *   6. Remove: the rules refuse every write except the app's exact one, which the
 *      admin then makes, and the freed seat takes a new join
 * Also checks that a signed-in user can load the Resources list (the app's query).
 *
 * Uses a throwaway org (seat limit 2, no coordinates, so it never shows on the
 * Network map) and deletes everything it created at the end, pass or fail.
 * Dry run by default.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/verify-invite-repair.js [--apply]
 */
const crypto = require('crypto');

const PROJECT = 'holyguard-app';
const DB_PATH = `projects/${PROJECT}/databases/(default)/documents`;
const FIRESTORE = `https://firestore.googleapis.com/v1/${DB_PATH}`;
const IDENTITY = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;
const FUNCTIONS = `https://us-central1-${PROJECT}.cloudfunctions.net`;
// Public web API key from src/config/firebase.ts (same one the app uses)
const WEB_API_KEY = 'AIzaSyBXmbb6enSevC8eSbEDcJJZmSan90JWYoc';

const APPLY = process.argv.includes('--apply');
const TOKEN = (process.env.GCLOUD_ACCESS_TOKEN || '').trim();
const WAIT_MS = 90 * 1000;

if (!TOKEN) {
  console.error('Set GCLOUD_ACCESS_TOKEN (gcloud auth print-access-token --account=<project owner>)');
  process.exit(1);
}

async function call(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json, text };
}

const owner = { Authorization: `Bearer ${TOKEN}`, 'X-Goog-User-Project': PROJECT };

async function ownerApi(method, url, body) {
  const r = await call(method, url, body, owner);
  if (!r.ok) throw new Error(`${method} ${url.split('?')[0]} -> HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r.json;
}

function enc(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  throw new Error(`Unsupported value: ${value}`);
}

const fields = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)]));
const plain = doc => Object.fromEntries(Object.entries((doc && doc.fields) || {}).map(([k, v]) => [k, Object.values(v)[0]]));

function randomChars(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
}

async function getDoc(path) {
  const r = await call('GET', `${FIRESTORE}/${path}`, null, owner);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

async function queryByField(collectionId, fieldPath, value) {
  const rows = await ownerApi('POST', `${FIRESTORE}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: enc(value) } },
      limit: 20,
    },
  });
  return rows.filter(r => r.document).map(r => r.document);
}

// createUserWithEmailAndPassword
async function signUp(email, password) {
  const r = await call('POST', `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`, { email, password, returnSecureToken: true });
  if (!r.ok) throw new Error(`signUp failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return { uid: r.json.localId, idToken: r.json.idToken };
}

// The app's updateDoc(users/<uid>, data), made with a user's ID token
function updateUserAs(idToken, uid, data) {
  const mask = Object.keys(data).map(f => `updateMask.fieldPaths=${f}`).join('&');
  return call('PATCH', `${FIRESTORE}/users/${uid}?${mask}&currentDocument.exists=true`, { fields: fields(data) },
    { Authorization: `Bearer ${idToken}` });
}

const validate = code => call('POST', `${FUNCTIONS}/validateInviteCode`, { inviteCode: code.toLowerCase() });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const stamp = Date.now();
  // An 'org_<ms>' id minted two hours ago: Remove only works in orgs older than an
  // hour, as every real org an admin manages is.
  const orgId = `org_${stamp - 2 * 60 * 60 * 1000}`;
  const adminEmail = `e2e-invite-admin-${stamp}@example.com`;
  const email = `e2e-invite-repair-${stamp}@example.com`;
  const password = `E2e-${randomChars(10)}9`;

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to run the test)'}`);
  console.log(`Test org:   organizations/${orgId} (seat limit 2, no coordinates, not on the map)`);
  console.log(`Test admin: ${adminEmail} (mints a member code: 2 uses, expires in 1 day)`);
  console.log(`Test user:  ${email}`);
  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to run the test; everything created is deleted afterwards.');
    return;
  }

  const created = { org: false, uids: [] };
  const results = [];
  const check = (label, pass, detail) => {
    results.push({ label, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  };

  try {
    // Throwaway org and its admin, written with the owner token
    await ownerApi('POST', `${FIRESTORE}:commit`, {
      writes: [{
        update: { name: `${DB_PATH}/organizations/${orgId}`, fields: fields({ id: orgId, name: 'E2E invite + remove test (auto-deleted)', address: '', status: 'verified', maxSeats: 2 }) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'created_at', setToServerValue: 'REQUEST_TIME' }],
      }],
    });
    created.org = true;
    const admin = await signUp(adminEmail, password);
    created.uids.push(admin.uid);
    const adminCreated = new Date();
    await ownerApi('POST', `${FIRESTORE}/users?documentId=${admin.uid}`, {
      fields: fields({ id: admin.uid, name: 'E2E Admin', email: adminEmail, role: 'admin', organization_id: orgId, email_verified: false, created_at: adminCreated, tos_accepted_at: adminCreated }),
    });
    console.log(`\nSet up test org and admin (users/${admin.uid})\n`);

    // 1. Team tab > INVITE > + GENERATE NEW CODE
    const g = await call('POST', `${FUNCTIONS}/generateInviteCode`, { role: 'member', expiresInDays: 1, maxUses: 2 },
      { Authorization: `Bearer ${admin.idToken}` });
    const code = g.json && g.json.code;
    check('admin mints an invite code (generateInviteCode)', g.ok && typeof code === 'string', g.json ? JSON.stringify(g.json) : `HTTP ${g.status}`);
    if (typeof code !== 'string') throw new Error('no invite code to test with');

    // 2. What the app sends when the person taps NEXT on step 2
    const v = await validate(code);
    check('validateInviteCode accepts the code', v.ok && v.json && v.json.valid === true, v.json ? JSON.stringify(v.json) : `HTTP ${v.status}`);
    check('validateInviteCode returns the org id', !!(v.json && v.json.organizationId === orgId));

    // 3. createUserWithEmailAndPassword
    const member = await signUp(email, password);
    created.uids.push(member.uid);

    // 4. The buggy profile write: role '' and organization_id ''
    const now = new Date();
    const profile = await call('POST', `${FIRESTORE}/users?documentId=${member.uid}`, {
      fields: fields({ id: member.uid, name: 'E2E Test', email, role: '', organization_id: '', email_verified: false, created_at: now, tos_accepted_at: now }),
    }, { Authorization: `Bearer ${member.idToken}` });
    check('app-style profile write is accepted by the rules', profile.ok, profile.ok ? '' : `HTTP ${profile.status} ${profile.text.slice(0, 200)}`);

    // Wait for the trigger
    const started = Date.now();
    let user = null;
    let review = null;
    while (Date.now() - started < WAIT_MS) {
      await sleep(2000);
      user = plain(await getDoc(`users/${member.uid}`));
      review = await getDoc(`invite_join_review/${member.uid}`);
      if (user.organization_id || review) break;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    check('trigger attached the user to the org', user && user.organization_id === orgId, `organization_id=${JSON.stringify(user && user.organization_id)} after ${seconds}s`);
    check('role set from the invite code', user && user.role === 'member', `role=${JSON.stringify(user && user.role)}`);
    check('no manual-review record was needed', !review, review ? JSON.stringify(plain(review)) : '');

    const intents = await queryByField('invite_join_intents', 'code', code);
    const consumed = intents.map(plain).filter(i => i.consumed === true && i.consumedBy === member.uid);
    check('join intent recorded and consumed by this user', consumed.length === 1, `${intents.length} intent(s), ${consumed.length} consumed by the test user`);

    // 5. Admin + member fill both seats
    const full = await validate(code);
    check('a full org refuses another join', !!(full.json && full.json.valid === false && /seat limit/.test(full.json.error || '')), full.json ? full.json.error : `HTTP ${full.status}`);

    // Resources tab: every org's posts, newest first
    const resources = await call('POST', `${FIRESTORE}:runQuery`, {
      structuredQuery: { from: [{ collectionId: 'resources' }], orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }], limit: 5 },
    }, { Authorization: `Bearer ${member.idToken}` });
    check('Resources list loads for a signed-in member', resources.ok,
      resources.ok ? `${resources.json.filter(r => r.document).length} newest post(s) read` : `HTTP ${resources.status} ${resources.text.slice(0, 200)}`);

    // 6. Seat Management > Remove: only the app's exact write gets through
    const removal = { organization_id: 'removed', role: 'member' };
    const refused = (label, r) => check(label, r.status === 403, `HTTP ${r.status}`);
    refused('a member cannot remove the admin', await updateUserAs(member.idToken, admin.uid, removal));
    refused('the admin cannot remove themselves', await updateUserAs(admin.idToken, admin.uid, removal));
    refused('the admin cannot promote a member', await updateUserAs(admin.idToken, member.uid, { role: 'admin' }));
    refused('the admin cannot move a member to another org', await updateUserAs(admin.idToken, member.uid, { organization_id: 'org_1000000000000', role: 'member' }));
    refused('the admin cannot change other fields while removing', await updateUserAs(admin.idToken, member.uid, { ...removal, name: 'Renamed' }));
    const removed = await updateUserAs(admin.idToken, member.uid, removal);
    check('the admin can remove the member (the app\'s exact write)', removed.ok, removed.ok ? '' : `HTTP ${removed.status} ${removed.text.slice(0, 200)}`);
    const after = plain(await getDoc(`users/${member.uid}`));
    check('the removed member has no org', after.organization_id === 'removed' && after.role === 'member', `organization_id=${JSON.stringify(after.organization_id)} role=${JSON.stringify(after.role)}`);

    const again = await validate(code);
    check('the freed seat takes a new join', !!(again.json && again.json.valid === true), again.json ? JSON.stringify(again.json) : `HTTP ${again.status}`);
  } catch (e) {
    check('test ran without errors', false, e.message);
  } finally {
    // Clean up everything this run created, pass or fail
    const cleanup = [];
    for (const uid of created.uids) {
      cleanup.push(call('DELETE', `${FIRESTORE}/users/${uid}`, null, owner));
      cleanup.push(call('DELETE', `${FIRESTORE}/invite_join_review/${uid}`, null, owner));
      cleanup.push(call('POST', `${IDENTITY}/accounts:delete`, { localId: uid }, owner));
    }
    if (created.org) {
      try {
        // Every code minted for the test org, and every intent recorded for it
        const docs = [
          ...await queryByField('invite_codes', 'organizationId', orgId),
          ...await queryByField('invite_join_intents', 'organizationId', orgId),
        ];
        for (const d of docs) cleanup.push(call('DELETE', `https://firestore.googleapis.com/v1/${d.name}`, null, owner));
      } catch (e) {
        console.error('Could not list the test codes and intents for cleanup:', e.message);
      }
      cleanup.push(call('DELETE', `${FIRESTORE}/organizations/${orgId}`, null, owner));
    }
    const outcomes = await Promise.all(cleanup);
    const failed = outcomes.filter(r => !r.ok && r.status !== 404);
    console.log(`\nCleanup: ${outcomes.length - failed.length}/${outcomes.length} deletions OK${failed.length ? ` (failed: ${failed.map(r => r.status).join(', ')})` : ''}`);
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\nRESULT: ${passed}/${results.length} checks passed${passed === results.length ? ' (invite join and Remove are working)' : ''}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
