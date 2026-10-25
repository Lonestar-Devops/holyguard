/**
 * Provision a grandfathered admin account end-to-end.
 *
 * Creates (or upgrades) a Firebase Auth user, gives them an admin user profile,
 * and puts them in a verified + grandfathered org so they bypass org review and
 * the subscription paywall entirely. Also reserves an unused HG-GF redemption
 * key to the email as a backup token (not marked used).
 *
 * Usage (dry-run by default):
 *   node scripts/provision-grandfather.js --email her@example.com \
 *     [--name "Her Name"] [--org "Her Church"] [--address "123 Main St, City, ST"] [--apply]
 *
 * Auth: uses ../serviceAccountKey.json if present, otherwise Application
 * Default Credentials (gcloud auth application-default login).
 */
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

let credSource = 'application default credentials';
try {
  const serviceAccount = require('../serviceAccountKey.json');
  initializeApp({ credential: cert(serviceAccount) });
  credSource = 'serviceAccountKey.json';
} catch (e) {
  if (process.env.GCLOUD_ACCESS_TOKEN) {
    // e.g. GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<owner>)
    const token = process.env.GCLOUD_ACCESS_TOKEN.trim();
    initializeApp({
      projectId: 'holyguard-app',
      credential: { getAccessToken: async () => ({ access_token: token, expires_in: 3000 }) },
    });
    credSource = 'gcloud access token (env)';
  } else {
    initializeApp({ projectId: 'holyguard-app' });
  }
}

const db = getFirestore();
const auth = getAuth();

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EMAIL = (arg('--email', '') || '').trim().toLowerCase();
const APPLY = process.argv.includes('--apply');
const NAME = arg('--name', EMAIL.split('@')[0]);
const ORG_NAME = arg('--org', `${NAME}'s Organization`);
const ADDRESS = arg('--address', null);

if (!EMAIL || !EMAIL.includes('@')) {
  console.error('Usage: node scripts/provision-grandfather.js --email <email> [--name ...] [--org ...] [--address ...] [--apply]');
  process.exit(1);
}

const GRANDFATHER_FIELDS = {
  status: 'verified',
  grandfathered: true,
  subscriptionStatus: 'active',
  subscriptionPlan: 'grandfathered',
  subscriptionUpdatedAt: FieldValue.serverTimestamp(),
};

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
  console.log(`Credentials: ${credSource}\n`);

  // 1. Auth user
  let authUser = null;
  let tempPassword = null;
  try {
    authUser = await auth.getUserByEmail(EMAIL);
    console.log(`Auth user exists: ${authUser.uid} (emailVerified: ${authUser.emailVerified})`);
    if (!authUser.emailVerified) {
      console.log('-> will set emailVerified: true');
      if (APPLY) await auth.updateUser(authUser.uid, { emailVerified: true });
    }
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    tempPassword = 'HG-' + crypto.randomBytes(9).toString('base64url');
    console.log(`Auth user not found -> will create with temp password`);
    if (APPLY) {
      authUser = await auth.createUser({
        email: EMAIL,
        password: tempPassword,
        displayName: NAME,
        emailVerified: true,
      });
      console.log(`Created auth user: ${authUser.uid}`);
    }
  }

  const uid = authUser ? authUser.uid : '(dry-run-uid)';

  // 2. Existing profile / org?
  let orgId = null;
  let orgDocRef = null;
  const userDocRef = db.collection('users').doc(uid);
  if (authUser) {
    const userDoc = await userDocRef.get();
    if (userDoc.exists) {
      const data = userDoc.data();
      orgId = data.organization_id || data.organizationId || null;
      console.log(`User profile exists (role: ${data.role}, org: ${orgId})`);
      if (data.role !== 'admin') {
        console.log('-> will promote role to admin');
        if (APPLY) await userDocRef.update({ role: 'admin' });
      }
    }
  }

  if (orgId) {
    const orgSnap = await db.collection('organizations').where('id', '==', orgId).limit(1).get();
    if (!orgSnap.empty) {
      orgDocRef = orgSnap.docs[0].ref;
      console.log(`Existing org "${orgSnap.docs[0].data().name}" -> will set verified + grandfathered + active, unlimited seats`);
      // A plan bought earlier leaves maxSeats behind; grandfathered orgs have no seat cap.
      if (APPLY) await orgDocRef.update({ ...GRANDFATHER_FIELDS, maxSeats: FieldValue.delete() });
    } else {
      console.log(`WARNING: user points at org ${orgId} but no org doc found; a new org will be created`);
      orgId = null;
    }
  }

  // 3. Create org + profile + default channel if needed
  if (!orgId) {
    orgId = `org_${Date.now()}`;
    console.log(`Will create org "${ORG_NAME}" (${orgId}) as verified + grandfathered + active`);
    console.log(`Will create user profile: ${NAME} <${EMAIL}> role=admin`);
    console.log(`Will create default #general channel`);
    if (APPLY) {
      await db.collection('organizations').add({
        id: orgId,
        name: ORG_NAME,
        address: ADDRESS,
        latitude: null,
        longitude: null,
        ein: null,
        website: null,
        orgEmail: EMAIL,
        phone: null,
        verificationScore: 100,
        verificationSubmittedAt: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
        ...GRANDFATHER_FIELDS,
      });
      await db.collection('channels').add({
        name: 'general',
        organizationId: orgId,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
        isDefault: true,
      });
      await userDocRef.set({
        id: uid,
        name: NAME,
        email: EMAIL,
        role: 'admin',
        organization_id: orgId,
        email_verified: true,
        created_at: FieldValue.serverTimestamp(),
        // tos_accepted_at intentionally omitted: she accepts TOS in-app on first login
      }, { merge: true });
    }
  }

  // 4. Reserve a redemption key as a backup token (not marked used)
  const keysSnap = await db.collection('redemption_keys').where('used', '==', false).get();
  const free = keysSnap.docs.find(d => !d.data().created_for && !d.data().region);
  if (free) {
    console.log(`Will reserve redemption key ${free.data().code} for ${EMAIL} (backup token, stays unused)`);
    if (APPLY) await free.ref.update({ created_for: EMAIL });
    console.log(`Backup redemption key: ${free.data().code}`);
  } else {
    console.log('No unallocated redemption keys available to reserve (not required — org is grandfathered directly)');
  }

  console.log('\n================ SUMMARY ================');
  console.log(`Email:        ${EMAIL}`);
  console.log(`UID:          ${uid}`);
  console.log(`Org:          ${orgId} ${orgDocRef ? '(existing, upgraded)' : `("${ORG_NAME}", created)`}`);
  console.log(`Role:         admin (can generate security/member/admin invite codes in-app)`);
  console.log(`Seats:        unlimited (no maxSeats set)`);
  if (tempPassword) console.log(`Temp password: ${APPLY ? tempPassword : '(generated on --apply)'}`);
  console.log('=========================================');
  if (!APPLY) console.log('\nDry run only — re-run with --apply to write.');
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e); process.exit(1); });
