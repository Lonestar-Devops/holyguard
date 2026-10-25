// Hardened Firestore rules: each attack is denied, each live-app operation still works.
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert');
const { makeFirestoreEnv, seed, db, unauthDb } = require('./_env');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where, orderBy, limit,
} = require('firebase/firestore');

// The live app mints org ids as 'org_' + Date.now(); the rules accept only a freshly minted one.
const freshOrgId = () => 'org_' + Date.now();

// Writes fixtures with the rules off (legacy shapes the app itself can't produce).
async function seedExtra(docs) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const [path, data] of Object.entries(docs)) await setDoc(doc(ctx.firestore(), path), data);
  });
}

let env;
before(async () => { env = await makeFirestoreEnv(); });
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await seed(env); });

// ============================ ATTACKS ARE BLOCKED ============================
describe('attacks blocked', () => {
  test('ESC-01 fresh account cannot create itself as super_admin', async () => {
    await assertFails(setDoc(doc(db(env, 'atk'), 'users/atk'),
      { id: 'atk', name: 'x', email: 'x@x.com', role: 'super_admin', organization_id: '' }));
  });
  test('ESC-01 existing member cannot raise its own role', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'users/memberA'), { role: 'admin' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'users/memberA'), { role: 'super_admin' }));
  });
  test('ESC-02 member cannot change its own organization_id to claim another org', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'users/memberA'), { organization_id: 'org_B' }));
  });
  test('ESC-03 cannot create an org born verified/active/grandfathered', async () => {
    await assertFails(setDoc(doc(db(env, 'noorg'), 'organizations/evil'),
      { id: 'org_evil', name: 'E', address: 'a', latitude: 1, longitude: 2,
        status: 'verified', grandfathered: true, subscriptionStatus: 'active', maxSeats: 9999 }));
  });
  test('ESC-04 cannot rewrite ANOTHER org subscription/seats/name', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocB'),
      { subscriptionStatus: 'active', maxSeats: 9999 }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocB'), { name: 'Hacked' }));
  });
  test('ESC-04 cannot change sensitive fields on OWN org', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { subscriptionStatus: 'cancelled' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { maxSeats: 9999 }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { grandfathered: false }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { status: 'pending' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { ein: '99-9999999' }));
  });
  test('ESC-06/PD-2 cannot read another org plaintext email code, nor its checks', async () => {
    await assertFails(getDoc(doc(db(env, 'memberB'), 'organizations/orgdocA/verification/emailCode')));
    await assertFails(getDoc(doc(db(env, 'memberB'), 'organizations/orgdocB/verification/emailCode'))); // own org, but emailCode never readable
    await assertFails(getDoc(doc(db(env, 'memberA'), 'organizations/orgdocB/verification/checks')));   // other org checks
  });
  test('ESC-08/XORG-03 cannot inject a team message into another org', async () => {
    await assertFails(addDoc(collection(db(env, 'memberB'), 'team_messages'),
      { text: 'spoof', senderId: 'memberB', organizationId: 'org_A', channelId: 'chA' }));
  });
  test('XORG-02 cannot plant a watchlist entry in another org', async () => {
    await assertFails(addDoc(collection(db(env, 'memberB'), 'watchlist'),
      { name: 'Pastor', status: 'active', organizationId: 'org_A', createdBy: 'memberB', createdAt: 1 }));
  });
  test('XORG-04 cannot create or delete channels in another org', async () => {
    await assertFails(addDoc(collection(db(env, 'memberB'), 'channels'),
      { name: 'x', organizationId: 'org_A' }));
    await assertFails(deleteDoc(doc(db(env, 'memberB'), 'channels/chA')));
  });
  test('XORG-04 a plain member cannot create channels even in own org', async () => {
    await assertFails(addDoc(collection(db(env, 'memberA'), 'channels'),
      { name: 'x', organizationId: 'org_A' }));
  });
  test('XORG-12 cannot inject a DM into a conversation you are not part of', async () => {
    await assertFails(addDoc(collection(db(env, 'noorg'), 'direct_messages'),
      { conversationId: 'convAB', senderId: 'noorg', text: 'intrusion' }));
  });
  test('XORG-13 cannot forge an alert reporterId or move an alert across orgs', async () => {
    await assertFails(addDoc(collection(db(env, 'memberA'), 'alerts'),
      { reporterId: 'someoneelse', title: 'T', timestamp: 1, organizationId: 'org_A' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'alerts/alertA'), { organizationId: 'org_B' }));
  });
  test('ESC-09/XORG-09 client cannot create invite codes; cannot read another org codes', async () => {
    await assertFails(addDoc(collection(db(env, 'adminA'), 'invite_codes'),
      { code: 'JOIN-ZZZZ-ZZZZ', organizationId: 'org_A', role: 'admin' }));
    await assertFails(getDoc(doc(db(env, 'memberB'), 'invite_codes/icA')));
  });
  test('ESC-07/XORG-11 redemption keys cannot be read or burned from a client', async () => {
    await assertFails(getDoc(doc(db(env, 'memberA'), 'redemption_keys/keyA')));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'redemption_keys/keyA'),
      { used: true, redeemedBy: 'memberA' }));
  });
  test('ESC-10 non-super-admin cannot write audit logs', async () => {
    await assertFails(addDoc(collection(db(env, 'memberA'), 'admin_logs'),
      { action: 'x', performedBy: 'memberA', timestamp: 1 }));
  });
  test('ESC-11 client cannot enqueue mail', async () => {
    await assertFails(addDoc(collection(db(env, 'memberA'), 'mail'),
      { to: 'victim@x.com', message: { subject: 's', text: 't' } }));
  });
  test('server-only invite collections are not client-accessible', async () => {
    await assertFails(getDoc(doc(db(env, 'adminA'), 'invite_join_intents/iiA')));
    await assertFails(getDoc(doc(db(env, 'memberA'), 'invite_join_review/memberA')));
  });
  test('cross-org reads of org-scoped data are blocked', async () => {
    await assertFails(getDoc(doc(db(env, 'memberB'), 'alerts/alertA')));
    await assertFails(getDoc(doc(db(env, 'memberB'), 'watchlist/wA')));
    await assertFails(getDoc(doc(db(env, 'memberB'), 'team_messages/tmA')));
    await assertFails(getDoc(doc(db(env, 'memberB'), 'channels/chA')));
  });
  test('no-org account cannot reach org-scoped data (fail-closed sentinel)', async () => {
    await assertFails(getDoc(doc(db(env, 'noorg'), 'alerts/alertA')));
    await assertFails(getDoc(doc(db(env, 'noorg'), 'watchlist/wA')));
  });
  test('no-org account cannot read docs stored with an empty organizationId', async () => {
    await seedExtra({ 'alerts/alertBlank': { reporterId: 'memberA', title: 'T', timestamp: 1, organizationId: '' } });
    await assertFails(getDoc(doc(db(env, 'noorg'), 'alerts/alertBlank')));
  });
  test('resources: no reads signed out; other orgs cannot delete a post, admins included', async () => {
    await seedExtra({ 'users/adminB': { id: 'adminB', name: 'Admin B', role: 'admin', organization_id: 'org_B' } });
    await assertFails(getDocs(collection(unauthDb(env), 'resources')));
    await assertFails(deleteDoc(doc(db(env, 'memberB'), 'resources/rA')));
    await assertFails(deleteDoc(doc(db(env, 'adminB'), 'resources/rA')));
  });
  test('fresh account cannot claim an established org at profile create', async () => {
    await assertFails(setDoc(doc(db(env, 'atk'), 'users/atk'),
      { id: 'atk', name: 'x', email: 'x@x.com', role: 'admin', organization_id: 'org_A' }));
    await assertFails(setDoc(doc(db(env, 'atk'), 'users/atk'),
      { id: 'atk', name: 'x', email: 'x@x.com', role: 'member', organization_id: 'org_A' }));
  });
  test('camelCase organizationId can never be set by a client', async () => {
    await assertFails(setDoc(doc(db(env, 'atk'), 'users/atk'),
      { id: 'atk', name: 'x', email: 'x@x.com', role: '', organization_id: '', organizationId: 'org_A' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'users/memberA'), { organizationId: 'org_B' }));
  });
  test('team messages cannot be edited, so none can be moved into another org', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'team_messages/tmA'), { organizationId: 'org_B' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'team_messages/tmA'), { text: 'edited' }));
  });
  test('cannot plant a twin or a squat of an existing org, or forge its review score', async () => {
    const plain = { name: 'Alpha Church', address: 'a', latitude: 1, longitude: 2, status: 'pending' };
    await assertFails(addDoc(collection(db(env, 'noorg'), 'organizations'), { ...plain, id: 'org_A' }));
    await assertFails(setDoc(doc(db(env, 'noorg'), 'organizations/org_A'), { ...plain, id: freshOrgId() }));
    await assertFails(addDoc(collection(db(env, 'noorg'), 'organizations'),
      { ...plain, id: freshOrgId(), verificationScore: 100 }));
  });
  test('own-org members can edit only the four display fields of their org', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { created_at: 1 }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'), { rejectionReason: 'x' }));
  });
  test('DM invite recipient cannot rewrite who sent it', async () => {
    await seedExtra({ 'dm_invites/invAB': { fromUserId: 'memberA', toUserId: 'memberB', status: 'pending' } });
    await assertFails(updateDoc(doc(db(env, 'memberB'), 'dm_invites/invAB'), { fromUserId: 'superA' }));
    await assertFails(updateDoc(doc(db(env, 'memberB'), 'dm_invites/invAB'), { status: 'hijacked' }));
  });
  test('Remove is limited: not oneself, admins, super admins, other orgs, brand-new orgs, or other writes', async () => {
    const freshOrg = freshOrgId();
    await seedExtra({
      'users/admin2A': { id: 'admin2A', name: 'Admin 2', role: 'admin', organization_id: 'org_A' },
      'users/member2A': { id: 'member2A', name: 'Member 2', role: 'member', organization_id: 'org_A' },
      'users/adminF': { id: 'adminF', name: 'Admin F', role: 'admin', organization_id: freshOrg },
      'users/memberF': { id: 'memberF', name: 'Member F', role: 'member', organization_id: freshOrg },
    });
    const remove = (by, uid, data = { organization_id: 'removed', role: 'member' }) =>
      updateDoc(doc(db(env, by), `users/${uid}`), data);
    await assertFails(remove('adminA', 'adminA'));
    await assertFails(remove('adminA', 'admin2A'));
    await assertFails(remove('adminA', 'superA'));
    await assertFails(remove('adminA', 'memberB'));
    await assertFails(remove('memberA', 'member2A'));
    await assertFails(remove('adminF', 'memberF'));
    await assertFails(remove('adminA', 'memberA', { organization_id: 'org_B', role: 'member' }));
    await assertFails(remove('adminA', 'memberA', { organization_id: 'removed', role: 'admin' }));
    await assertFails(remove('adminA', 'memberA', { organization_id: 'removed', role: 'member', name: 'x' }));
  });
  test('a participant cannot swap who is in a conversation', async () => {
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'conversations/convAB'),
      { participants: ['memberA', 'noorg'] }));
  });
});

// ======================= LIVE APP OPERATIONS STILL WORK =======================
describe('live v1.2.7 operations still work', () => {
  test('invite sign-up writes the 8-field blank profile', async () => {
    await assertSucceeds(setDoc(doc(db(env, 'newJoiner'), 'users/newJoiner'),
      { id: 'newJoiner', name: 'New', email: 'n@x.com', role: '', organization_id: '',
        email_verified: false, created_at: 1, tos_accepted_at: 2 }));
  });
  test('org creator writes its own admin profile', async () => {
    await assertSucceeds(setDoc(doc(db(env, 'creator'), 'users/creator'),
      { id: 'creator', name: 'C', email: 'c@x.com', role: 'admin', organization_id: freshOrgId(),
        email_verified: false, created_at: 1 }));
  });
  test('TOS acceptance update (tos_accepted_at only) preserves role/org', async () => {
    await assertSucceeds(updateDoc(doc(db(env, 'memberA'), 'users/memberA'),
      { tos_accepted_at: '2026-10-16T00:00:00Z' }));
  });
  test('create a new org as pending with plain fields', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'creator'), 'organizations'),
      { id: freshOrgId(), name: 'New Org', address: 'addr', latitude: 1, longitude: 2, status: 'pending',
        ein: '22-2222222', website: 'w', orgEmail: 'o@x.com', phone: '+1', verificationScore: 0 }));
  });
  test('Settings → Update Organization writes name/address/lat/lng on own org', async () => {
    await assertSucceeds(updateDoc(doc(db(env, 'memberA'), 'organizations/orgdocA'),
      { name: 'Alpha Church 2', address: '9 New St', latitude: 32.5, longitude: -111.5 }));
  });
  test('super admin may change org status (review/approve)', async () => {
    await assertSucceeds(updateDoc(doc(db(env, 'superA'), 'organizations/orgdocB'), { status: 'verified' }));
  });
  test('map lists all organizations; own profile readable', async () => {
    await assertSucceeds(getDocs(collection(db(env, 'memberA'), 'organizations')));
    await assertSucceeds(getDoc(doc(db(env, 'memberA'), 'users/memberA')));
  });
  test('cross-org user directory read still works (feature preserved)', async () => {
    await assertSucceeds(getDoc(doc(db(env, 'memberB'), 'users/memberA')));
  });
  test('report + edit an incident in own org', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'memberA'), 'alerts'),
      { reporterId: 'memberA', title: 'Incident', timestamp: 2, organizationId: 'org_A', latitude: 1, longitude: 2 }));
    await assertSucceeds(updateDoc(doc(db(env, 'memberA'), 'alerts/alertA'),
      { title: 'Updated', policeIncidentNumber: 'PD-1' }));
  });
  test('post a team message in own org channel', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'memberA'), 'team_messages'),
      { text: 'hello team', senderId: 'memberA', organizationId: 'org_A', channelId: 'chA' }));
  });
  test('admin creates and deletes a channel in own org', async () => {
    const ref = await assertSucceeds(addDoc(collection(db(env, 'adminA'), 'channels'),
      { name: 'ops', organizationId: 'org_A', createdBy: 'adminA' }));
    await assertSucceeds(deleteDoc(doc(db(env, 'adminA'), 'channels/' + ref.id)));
  });
  test('create a watchlist entry in own org and read it', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'memberA'), 'watchlist'),
      { name: 'P', status: 'active', organizationId: 'org_A', createdBy: 'memberA', createdAt: 2 }));
    await assertSucceeds(getDoc(doc(db(env, 'memberA'), 'watchlist/wA')));
  });
  test('create a resource in own org', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'memberA'), 'resources'),
      { title: 'R', description: 'd', category: 'c', postedBy: 'memberA', organizationId: 'org_A', timestamp: 2 }));
  });
  test('admin lists own org invite codes', async () => {
    await assertSucceeds(getDocs(query(collection(db(env, 'adminA'), 'invite_codes'),
      where('organizationId', '==', 'org_A'))));
  });
  test('DM between two conversation participants works', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'memberA'), 'direct_messages'),
      { conversationId: 'convAB', senderId: 'memberA', text: 'hi' }));
    await assertSucceeds(getDoc(doc(db(env, 'memberB'), 'direct_messages/dmA')));
  });
  test('super admin reads org verification checks (AdminReview) and own-org member reads own checks', async () => {
    await assertSucceeds(getDoc(doc(db(env, 'superA'), 'organizations/orgdocB/verification/checks')));
    await assertSucceeds(getDoc(doc(db(env, 'memberB'), 'organizations/orgdocB/verification/checks')));
  });
  test('Home feed and Network map alert queries work for own org only', async () => {
    const q = (uid, org, n) => query(collection(db(env, uid), 'alerts'),
      where('organizationId', '==', org), orderBy('timestamp', 'desc'), limit(n));
    await assertSucceeds(getDocs(q('memberA', 'org_A', 20)));
    await assertSucceeds(getDocs(q('memberA', 'org_A', 50)));
    await assertFails(getDocs(q('memberB', 'org_A', 20)));
  });
  test('legacy profiles (no role, or camelCase-only org) can still accept TOS', async () => {
    await seedExtra({
      'users/legacyNoRole': { id: 'legacyNoRole', name: 'L', organization_id: 'org_A' },
      'users/legacyCamel': { id: 'legacyCamel', name: 'L', role: 'member', organizationId: 'org_A' },
    });
    await assertSucceeds(updateDoc(doc(db(env, 'legacyNoRole'), 'users/legacyNoRole'),
      { tos_accepted_at: '2026-10-21T00:00:00Z' }));
    await assertSucceeds(updateDoc(doc(db(env, 'legacyCamel'), 'users/legacyCamel'),
      { tos_accepted_at: '2026-10-21T00:00:00Z' }));
  });
  test('TOS on a missing profile fails not-found, so the app falls back to setDoc merge', async () => {
    const ghost = db(env, 'ghost');
    await assert.rejects(updateDoc(doc(ghost, 'users/ghost'), { tos_accepted_at: 'x' }),
      (e) => e.code === 'not-found');
    await assertSucceeds(setDoc(doc(ghost, 'users/ghost'), { tos_accepted_at: 'x' }, { merge: true }));
  });
  test('an admin can edit a legacy alert that has no reporterId; a member cannot', async () => {
    await seedExtra({ 'alerts/legacyA': { title: 'Old', timestamp: 1, organizationId: 'org_A' } });
    await assertSucceeds(updateDoc(doc(db(env, 'adminA'), 'alerts/legacyA'), { description: 'edited' }));
    await assertFails(updateDoc(doc(db(env, 'memberA'), 'alerts/legacyA'), { description: 'edited' }));
  });
  test('members of a legacy org doc with no id field can update its display fields', async () => {
    await seedExtra({
      'organizations/ACMEDOC': { name: 'Acme', address: 'a', latitude: 1, longitude: 2, status: 'verified' },
      'users/acmeAdmin': { id: 'acmeAdmin', name: 'A', role: 'admin', organization_id: 'ACMEDOC' },
    });
    await assertSucceeds(updateDoc(doc(db(env, 'acmeAdmin'), 'organizations/ACMEDOC'),
      { name: 'Acme 2', address: 'b', latitude: 3, longitude: 4 }));
  });
  test('resources are shared: any signed-in user lists them all, newest first (live query)', async () => {
    const all = await assertSucceeds(getDocs(query(collection(db(env, 'memberB'), 'resources'),
      orderBy('timestamp', 'desc'))));
    assert.deepEqual(all.docs.map(d => d.id), ['rA']);
  });
  test('resource deletes: the poster (even with no org on the post), own-org admins, super admins', async () => {
    await seedExtra({
      'resources/rBlank': { title: 'R', description: 'd', category: 'c', postedBy: 'memberA', organizationId: '', timestamp: 1 },
      'resources/rB': { title: 'R', description: 'd', category: 'c', postedBy: 'memberB', organizationId: 'org_B', timestamp: 1 },
    });
    await assertSucceeds(deleteDoc(doc(db(env, 'memberA'), 'resources/rBlank')));
    await assertSucceeds(deleteDoc(doc(db(env, 'adminA'), 'resources/rA')));
    await assertSucceeds(deleteDoc(doc(db(env, 'superA'), 'resources/rB')));
  });
  test('resource post with organizationId "" (the live CreateResource shape) is accepted', async () => {
    await assertSucceeds(addDoc(collection(db(env, 'memberA'), 'resources'),
      { title: 'R', description: 'd', category: 'c', postedBy: 'memberA', organizationId: '', timestamp: 2 }));
  });
  test('super admin in-app redeem can read and burn a key', async () => {
    await assertSucceeds(getDocs(query(collection(db(env, 'superA'), 'redemption_keys'),
      where('code', '==', 'HG-GF-001'))));
    await assertSucceeds(updateDoc(doc(db(env, 'superA'), 'redemption_keys/keyA'),
      { used: true, redeemedBy: 'superA', redeemedAt: 1 }));
  });
  test('Seat Management > Remove: an admin removes a member or security member, who then loses access', async () => {
    const olderOrg = 'org_' + (Date.now() - 2 * 60 * 60 * 1000);
    await seedExtra({
      'users/securityA': { id: 'securityA', name: 'Sec A', role: 'security', organization_id: 'org_A' },
      'users/adminO': { id: 'adminO', name: 'Admin O', role: 'admin', organization_id: olderOrg },
      'users/memberO': { id: 'memberO', name: 'Member O', role: 'member', organization_id: olderOrg },
    });
    const removal = { organization_id: 'removed', role: 'member' };
    await assertSucceeds(updateDoc(doc(db(env, 'adminA'), 'users/memberA'), removal));
    await assertSucceeds(updateDoc(doc(db(env, 'adminA'), 'users/securityA'), removal));
    await assertSucceeds(updateDoc(doc(db(env, 'adminO'), 'users/memberO'), removal));
    await assertFails(getDoc(doc(db(env, 'memberA'), 'alerts/alertA')));
  });
  test('DM invite accept and conversation lastMessage update still work', async () => {
    await seedExtra({ 'dm_invites/invAB': { fromUserId: 'memberA', toUserId: 'memberB', status: 'pending' } });
    await assertSucceeds(updateDoc(doc(db(env, 'memberB'), 'dm_invites/invAB'), { status: 'accepted', updatedAt: 1 }));
    await assertSucceeds(updateDoc(doc(db(env, 'memberA'), 'conversations/convAB'),
      { lastMessage: 'hi', lastMessageAt: 1 }));
  });
});
