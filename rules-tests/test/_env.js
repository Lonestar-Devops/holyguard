// Shared test environment + seed data for the security-rules suite.
// Runs only against the Firestore/Storage emulators under a demo- project id,
// so it never touches production. `npm test` (see ../package.json) boots the
// emulators and runs every *.test.js in this directory.
const fs = require('fs');
const path = require('path');
const rut = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

const PROJECT = 'demo-holyguard';
const FS_RULES = process.env.FS_RULES || path.resolve(__dirname, '../../firestore.rules');
const ST_RULES = process.env.ST_RULES || path.resolve(__dirname, '../../storage.rules');

async function makeFirestoreEnv() {
  return rut.initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: fs.readFileSync(FS_RULES, 'utf8') },
  });
}

async function makeStorageEnv() {
  return rut.initializeTestEnvironment({
    projectId: PROJECT,
    storage: { rules: fs.readFileSync(ST_RULES, 'utf8') },
  });
}

// Seed users and orgs with security rules disabled.
// Org A is app-style (doc id != `id` field); org B too. users.organization_id
// holds the org's `id` FIELD value ('org_A'/'org_B'), matching production.
async function seed(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'organizations/orgdocA'), {
      id: 'org_A', name: 'Alpha Church', address: '1 A St', latitude: 32.1, longitude: -111.1,
      status: 'verified', grandfathered: true, subscriptionStatus: 'active',
      subscriptionPlan: 'grandfathered', maxSeats: 7,
      ein: '11-1111111', phone: '+15200000001', orgEmail: 'a@alpha.org', website: 'alpha.org',
      verificationScore: 100, appleOriginalTransactionId: 'tx_A',
    });
    await setDoc(doc(db, 'organizations/orgdocB'), {
      id: 'org_B', name: 'Bravo Church', address: '2 B St', latitude: 33.2, longitude: -112.2,
      status: 'verified',
    });
    await setDoc(doc(db, 'organizations/orgdocB/verification/emailCode'), {
      code: '123456', email: 'b@bravo.org', domain: 'bravo.org', attempts: 0,
    });
    await setDoc(doc(db, 'organizations/orgdocB/verification/checks'), {
      totalScore: 80, autoApproved: true,
    });
    await setDoc(doc(db, 'users/adminA'),  { id: 'adminA',  name: 'Admin A',  email: 'adminA@x.com',  role: 'admin',       organization_id: 'org_A', email_verified: true });
    await setDoc(doc(db, 'users/memberA'), { id: 'memberA', name: 'Member A', email: 'memberA@x.com', role: 'member',      organization_id: 'org_A', email_verified: true });
    await setDoc(doc(db, 'users/superA'),  { id: 'superA',  name: 'Super A',  email: 'superA@x.com',  role: 'super_admin', organization_id: 'org_A', email_verified: true });
    await setDoc(doc(db, 'users/memberB'), { id: 'memberB', name: 'Member B', email: 'memberB@x.com', role: 'member',      organization_id: 'org_B', email_verified: true });
    await setDoc(doc(db, 'users/noorg'),   { id: 'noorg',   name: 'No Org',   email: 'noorg@x.com',   role: '',            organization_id: '',      email_verified: false });
    await setDoc(doc(db, 'alerts/alertA'),        { reporterId: 'memberA', title: 'T', timestamp: 1, organizationId: 'org_A' });
    await setDoc(doc(db, 'team_messages/tmA'),    { text: 'hi', senderId: 'memberA', organizationId: 'org_A', channelId: 'c1' });
    await setDoc(doc(db, 'channels/chA'),         { name: 'general', organizationId: 'org_A', createdBy: 'adminA', isDefault: true });
    await setDoc(doc(db, 'watchlist/wA'),         { name: 'Person', status: 'active', organizationId: 'org_A', createdBy: 'memberA', createdAt: 1 });
    await setDoc(doc(db, 'resources/rA'),         { title: 'R', description: 'd', category: 'c', postedBy: 'memberA', organizationId: 'org_A', timestamp: 1 });
    await setDoc(doc(db, 'invite_codes/icA'),     { code: 'JOIN-AAAA-AAAA', organizationId: 'org_A', role: 'member', createdBy: 'adminA', usedCount: 0, isActive: true });
    await setDoc(doc(db, 'conversations/convAB'), { participants: ['memberA', 'memberB'] });
    await setDoc(doc(db, 'direct_messages/dmA'),  { conversationId: 'convAB', senderId: 'memberA', text: 'hello' });
    await setDoc(doc(db, 'redemption_keys/keyA'), { code: 'HG-GF-001', used: false });
    await setDoc(doc(db, 'admin_logs/logA'),      { action: 'review', performedBy: 'superA', timestamp: 1 });
    await setDoc(doc(db, 'mail/mailA'),           { to: 'x@y.com', message: { subject: 's', text: 't' } });
    await setDoc(doc(db, 'invite_join_intents/iiA'), { code: 'JOIN-AAAA-AAAA', organizationId: 'org_A', consumed: false });
  });
}

function db(env, uid) { return env.authenticatedContext(uid).firestore(); }
function unauthDb(env) { return env.unauthenticatedContext().firestore(); }

module.exports = { makeFirestoreEnv, makeStorageEnv, seed, db, unauthDb, PROJECT };
