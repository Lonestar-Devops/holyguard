// Tests for accountDeletion.js: the URL helpers and the real deleteAccount handler from
// createDeleteAccountHandler, run against in-memory Firestore, Auth and Storage
// stand-ins. Nothing here touches the network or a real project.
// Run from functions/: npm test

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECENT_LOGIN_MS,
  PAGE_SIZE,
  profileOrgId,
  storagePathFromUrl,
  imagePathsOf,
  createDeleteAccountHandler,
} = require('../accountDeletion');

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const BUCKET = 'holyguard-app.firebasestorage.app';
const ORG_ID = 'org_1760000000000'; // the org's `id` field, as profiles store it

// A Firebase Storage download URL for a path in the app's bucket (or another one).
const url = (path, bucket = BUCKET) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=t-${path.length}`;

// -------------------------------------------------------------------------------------
// In-memory stand-ins. Firestore implements only what the handler uses:
//   collection(name).where(field, '==' | 'array-contains', value).limit(n).get()
//   collection(name).doc(id).get() / .delete(), batch().delete(ref).commit(),
//   runTransaction(fn) with tx.get(ref) / tx.update(ref, data)
// Every write (and Auth / Storage delete) is appended to `events`, so tests can check
// the order. Failures can be injected per step.
// -------------------------------------------------------------------------------------
class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    return this.snapshot();
  }

  async delete() {
    this.db.maybeFail('delete', [this]);
    this.db.store.delete(this.path);
    this.db.events.push(`delete ${this.path}`);
  }

  snapshot() {
    const stored = this.db.store.get(this.path);
    return {
      id: this.id,
      ref: this,
      exists: !!stored,
      data: () => (stored ? structuredClone(stored) : undefined),
    };
  }
}

class FakeQuery {
  constructor(db, collectionName, filters = [], limitCount = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.filters = filters;
    this.limitCount = limitCount;
  }

  where(field, op, value) {
    if (!['==', 'array-contains'].includes(op)) throw new Error(`unsupported op ${op}`);
    return new FakeQuery(this.db, this.collectionName, [...this.filters, { field, op, value }], this.limitCount);
  }

  limit(count) {
    return new FakeQuery(this.db, this.collectionName, this.filters, count);
  }

  async get() {
    this.db.queries.push(`${this.collectionName}:${this.filters.map(f => `${f.field}${f.op}${f.value}`).join('&')}`);
    let refs = this.db.idsIn(this.collectionName)
      .map(id => new FakeDocRef(this.db, this.collectionName, id))
      .filter(ref => this.filters.every(({ field, op, value }) => {
        const fieldValue = this.db.store.get(ref.path)[field];
        if (op === '==') return fieldValue === value;
        return Array.isArray(fieldValue) && fieldValue.includes(value);
      }));
    if (this.limitCount !== null) refs = refs.slice(0, this.limitCount);
    const docs = refs.map(ref => ref.snapshot());
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeCollection extends FakeQuery {
  doc(id) {
    return new FakeDocRef(this.db, this.collectionName, id);
  }
}

class FakeDb {
  constructor() {
    this.store = new Map();
    this.events = [];
    this.queries = [];
    this.batchSizes = [];
    this.failures = []; // [{ kind: 'batch' | 'delete', match: ref => bool, times }]
    this.beforeTransaction = null;
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  idsIn(collectionName) {
    const prefix = `${collectionName}/`;
    return [...this.store.keys()]
      .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(p => p.slice(prefix.length))
      .sort();
  }

  seed(docPath, data) {
    this.store.set(docPath, structuredClone(data));
  }

  read(docPath) {
    const data = this.store.get(docPath);
    return data ? structuredClone(data) : undefined;
  }

  failOnce(kind, match) {
    this.failures.push({ kind, match, times: 1 });
  }

  maybeFail(kind, refs) {
    const failure = this.failures.find(f => f.kind === kind && f.times > 0 && refs.some(f.match));
    if (failure) {
      failure.times--;
      const error = new Error('UNAVAILABLE: simulated failure');
      error.code = 14;
      throw error;
    }
  }

  batch() {
    const refs = [];
    return {
      delete: (ref) => {
        refs.push(ref);
      },
      commit: async () => {
        if (refs.length > 500) throw new Error('INVALID_ARGUMENT: maximum 500 writes allowed per request');
        this.maybeFail('batch', refs);
        this.batchSizes.push(refs.length);
        for (const ref of refs) {
          this.store.delete(ref.path);
          this.events.push(`delete ${ref.path}`);
        }
      },
    };
  }

  async runTransaction(updateFunction) {
    if (this.beforeTransaction) this.beforeTransaction();
    const writes = [];
    const tx = {
      get: async ref => ref.snapshot(),
      update: (ref, data) => writes.push({ ref, data }),
    };
    const result = await updateFunction(tx);
    for (const { ref, data } of writes) {
      const stored = this.store.get(ref.path);
      if (!stored) throw new Error(`NOT_FOUND: ${ref.path}`);
      this.store.set(ref.path, { ...stored, ...data });
      this.events.push(`update ${ref.path} ${JSON.stringify(data)}`);
    }
    return result;
  }
}

class FakeAuth {
  constructor(db) {
    this.db = db;
    this.users = new Set();
    this.tokens = new Map();
    this.failDeleteOnce = false;
  }

  // A token for uid that signed in `ageMs` ago.
  token(uid, ageMs = 60 * 1000) {
    const token = `token-${uid}-${ageMs}`;
    this.tokens.set(token, { uid, auth_time: Math.floor((NOW - ageMs) / 1000) });
    return token;
  }

  async verifyIdToken(token) {
    const decoded = this.tokens.get(token);
    if (!decoded) {
      const error = new Error('Decoding Firebase ID token failed');
      error.code = 'auth/argument-error';
      throw error;
    }
    return { ...decoded };
  }

  async deleteUser(uid) {
    if (this.failDeleteOnce) {
      this.failDeleteOnce = false;
      const error = new Error('simulated auth outage');
      error.code = 'auth/internal-error';
      throw error;
    }
    if (!this.users.has(uid)) {
      const error = new Error('There is no user record corresponding to the provided identifier.');
      error.code = 'auth/user-not-found';
      throw error;
    }
    this.users.delete(uid);
    this.db.events.push(`auth.deleteUser ${uid}`);
  }
}

class FakeStorage {
  constructor(db) {
    this.db = db;
    this.bucketName = BUCKET;
    this.files = new Set();
    this.failPaths = new Set();
  }

  async deleteFile(path) {
    if (this.failPaths.has(path)) {
      this.failPaths.delete(path);
      throw new Error('simulated storage outage');
    }
    this.files.delete(path); // ignoreNotFound: a missing object is fine
    this.db.events.push(`storage.delete ${path}`);
  }

  async listFiles(prefix) {
    return [...this.files].filter(p => p.startsWith(prefix)).sort();
  }
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

let db;
let auth;
let storage;
let logLines;
let handler;

function setup() {
  db = new FakeDb();
  auth = new FakeAuth(db);
  storage = new FakeStorage(db);
  logLines = [];
  const logger = {
    log: (...args) => logLines.push(['log', args.join(' ')]),
    warn: (...args) => logLines.push(['warn', args.join(' ')]),
    error: (...args) => logLines.push(['error', args.join(' ')]),
  };
  handler = createDeleteAccountHandler({ db, auth, storage, logger, now: () => NOW });
}

async function call({ token, body = {}, method = 'POST', headers } = {}) {
  const res = makeRes();
  await handler({
    method,
    body,
    headers: headers || (token ? { authorization: `Bearer ${token}` } : {}),
  }, res);
  return res;
}

function seedUser(uid, profile) {
  db.seed(`users/${uid}`, { id: uid, name: `Name ${uid}`, email: `${uid}@example.org`, ...profile });
  auth.users.add(uid);
}

function seedOrg() {
  db.seed('organizations/AutoDocId123', { id: ORG_ID, name: 'Grace Chapel', status: 'verified', maxSeats: 15 });
}

// The full footprint of `uid` (a member of ORG_ID) and of `other`, who shares a
// conversation with them. Returns what `uid` owns.
function seedFootprint(uid, other) {
  const files = {
    alert: `incidents/1760000000001_${uid}.jpg`,
    alert2: `incidents/1760000000002_${uid}.jpg`,
    watch: `watchlist/1760000000003_${uid}.jpg`,
    resource: `resources/${uid}_1760000000004.jpg`,
    orphanResource: `resources/${uid}_1760000000005.jpg`,
    dmMine: 'direct_messages/conv1/1760000000006.jpg',
    dmTheirs: 'direct_messages/conv1/1760000000007.jpg',
    dmOrphan: 'direct_messages/conv1/1760000000008.jpg',
    otherAlert: `incidents/1760000000009_${other}.jpg`,
    otherResource: `resources/${other}_1760000000010.jpg`,
    otherDm: 'direct_messages/conv2/1760000000011.jpg',
  };
  Object.values(files).forEach(p => storage.files.add(p));

  db.seed('alerts/a1', { reporterId: uid, organizationId: ORG_ID, imageUrl: url(files.alert), imageUrls: [url(files.alert), url(files.alert2)] });
  db.seed('alerts/a2', { reporterId: other, organizationId: ORG_ID, imageUrl: url(files.otherAlert), imageUrls: [url(files.otherAlert)] });
  db.seed('watchlist/w1', { createdBy: uid, organizationId: ORG_ID, imageUrls: [url(files.watch), url('watchlist/x.jpg', 'someone-else.appspot.com')] });
  db.seed('watchlist/w2', { createdBy: other, organizationId: ORG_ID, imageUrls: [] });
  db.seed('resources/r1', { postedBy: uid, organizationId: '', imageUrl: url(files.resource) });
  db.seed('resources/r2', { postedBy: other, organizationId: ORG_ID, imageUrl: url(files.otherResource) });
  db.seed('team_messages/t1', { senderId: uid, organizationId: ORG_ID, text: 'secret team text' });
  db.seed('team_messages/t2', { senderId: other, organizationId: ORG_ID, text: 'their team text' });
  db.seed('conversations/conv1', { participants: [uid, other] });
  db.seed('conversations/conv2', { participants: [other, 'third'] });
  db.seed('direct_messages/m1', { conversationId: 'conv1', senderId: uid, text: 'secret dm text', imageUrl: url(files.dmMine) });
  db.seed('direct_messages/m2', { conversationId: 'conv1', senderId: other, text: 'their reply', imageUrl: url(files.dmTheirs) });
  db.seed('direct_messages/m3', { conversationId: 'gone', senderId: uid, text: 'orphan dm text' });
  db.seed('direct_messages/m4', { conversationId: 'conv2', senderId: other, text: 'not mine', imageUrl: url(files.otherDm) });
  db.seed('dm_invites/i1', { fromUserId: uid, toUserId: 'third', status: 'pending' });
  db.seed('dm_invites/i2', { fromUserId: 'third', toUserId: uid, status: 'declined' });
  db.seed('dm_invites/i3', { fromUserId: other, toUserId: 'third', status: 'pending' });
  db.seed('invite_codes/c1', { createdBy: uid, organizationId: ORG_ID, code: 'JOIN-AAAA-BBBB' });
  db.seed('invite_codes/c2', { createdBy: other, organizationId: ORG_ID, code: 'JOIN-CCCC-DDDD' });
  return files;
}

const OWNED_DOCS = [
  'alerts/a1', 'watchlist/w1', 'resources/r1', 'team_messages/t1', 'conversations/conv1',
  'direct_messages/m1', 'direct_messages/m2', 'direct_messages/m3', 'dm_invites/i1', 'dm_invites/i2', 'invite_codes/c1',
];
const SURVIVING_DOCS = [
  'alerts/a2', 'watchlist/w2', 'resources/r2', 'team_messages/t2', 'conversations/conv2',
  'direct_messages/m4', 'dm_invites/i3', 'invite_codes/c2', 'organizations/AutoDocId123',
];

function assertEverythingDeleted(uid, files) {
  for (const path of OWNED_DOCS) assert.equal(db.read(path), undefined, `${path} should be deleted`);
  for (const path of SURVIVING_DOCS) assert.ok(db.read(path), `${path} should survive`);
  assert.equal(db.read(`users/${uid}`), undefined);
  assert.equal(auth.users.has(uid), false);
  for (const key of ['alert', 'alert2', 'watch', 'resource', 'orphanResource', 'dmMine', 'dmTheirs', 'dmOrphan']) {
    assert.equal(storage.files.has(files[key]), false, `${key} photo should be deleted`);
  }
  for (const key of ['otherAlert', 'otherResource', 'otherDm']) {
    assert.equal(storage.files.has(files[key]), true, `${key} photo should survive`);
  }
}

// -------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------
describe('storagePathFromUrl / imagePathsOf / profileOrgId', () => {
  it('reads the object path of a download URL in the app bucket', () => {
    assert.equal(storagePathFromUrl(url('incidents/1_a.jpg'), BUCKET), 'incidents/1_a.jpg');
    assert.equal(storagePathFromUrl(url('direct_messages/conv 1/2.jpg'), BUCKET), 'direct_messages/conv 1/2.jpg');
  });

  it('ignores other buckets, hosts, folders, schemes and path tricks', () => {
    assert.equal(storagePathFromUrl(url('incidents/1.jpg', 'other.appspot.com'), BUCKET), null);
    assert.equal(storagePathFromUrl(url('users/1.jpg'), BUCKET), null);
    assert.equal(storagePathFromUrl(url('incidents/'), BUCKET), null);
    assert.equal(storagePathFromUrl(url('incidents/../users/x'), BUCKET), null);
    assert.equal(storagePathFromUrl(url('incidents//x.jpg'), BUCKET), null);
    assert.equal(storagePathFromUrl(url('incidents/1.jpg').replace('https:', 'http:'), BUCKET), null);
    assert.equal(storagePathFromUrl(`https://evil.example.com/v0/b/${BUCKET}/o/incidents%2F1.jpg`, BUCKET), null);
    assert.equal(storagePathFromUrl('not a url', BUCKET), null);
    assert.equal(storagePathFromUrl(undefined, BUCKET), null);
    assert.equal(storagePathFromUrl(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/incidents%2F%E0%A4%A.jpg`, BUCKET), null);
  });

  it('collects imageUrl and imageUrls', () => {
    assert.deepEqual(imagePathsOf({ imageUrl: url('resources/u_1.jpg'), imageUrls: [url('incidents/2.jpg'), 7, ''] }, BUCKET),
      ['resources/u_1.jpg', 'incidents/2.jpg']);
    assert.deepEqual(imagePathsOf({ imageUrl: '' }, BUCKET), []);
    assert.deepEqual(imagePathsOf(undefined, BUCKET), []);
  });

  it('reads the org the way the rules do', () => {
    assert.equal(profileOrgId({ organization_id: ORG_ID, organizationId: 'legacy' }), ORG_ID);
    assert.equal(profileOrgId({ organization_id: '', organizationId: 'legacy' }), '');
    assert.equal(profileOrgId({ organization_id: 'removed' }), '');
    assert.equal(profileOrgId({ organizationId: 'legacy' }), 'legacy');
    assert.equal(profileOrgId({}), '');
    assert.equal(profileOrgId(null), '');
  });
});

// -------------------------------------------------------------------------------------
// deleteAccount
// -------------------------------------------------------------------------------------
describe('deleteAccount', () => {
  beforeEach(setup);

  it('deletes everything a member authored, their photos, the profile, and the Auth user last', async () => {
    seedOrg();
    seedUser('admin1', { role: 'admin', organization_id: ORG_ID });
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    seedUser('other', { role: 'member', organization_id: ORG_ID });
    const files = seedFootprint('u1', 'other');

    const res = await call({ token: auth.token('u1') });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { deleted: true });
    assert.deepEqual(res.headers, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    assertEverythingDeleted('u1', files);
    assert.ok(db.read('users/other'));
    assert.ok(db.read('users/admin1'));
    assert.deepEqual(db.read('organizations/AutoDocId123'),
      { id: ORG_ID, name: 'Grace Chapel', status: 'verified', maxSeats: 15 });

    // The Auth user goes last, right after the profile.
    assert.deepEqual(db.events.slice(-2), ['delete users/u1', 'auth.deleteUser u1']);
    // A doc's photos go before the doc, so a retry can still find them.
    assert.ok(db.events.indexOf(`storage.delete ${files.alert}`) < db.events.indexOf('delete alerts/a1'));
    assert.ok(db.events.indexOf(`storage.delete ${files.dmTheirs}`) < db.events.indexOf('delete direct_messages/m2'));
    assert.ok(db.events.indexOf('delete direct_messages/m2') < db.events.indexOf('delete conversations/conv1'));
    // No role was changed.
    assert.equal(db.events.some(e => e.startsWith('update')), false);
  });

  it('never logs message text, and logs one line per step', async () => {
    seedOrg();
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    seedUser('other', { role: 'member', organization_id: ORG_ID });
    seedFootprint('u1', 'other');
    await call({ token: auth.token('u1') });
    const text = logLines.map(([, line]) => line).join('\n');
    for (const secret of ['secret team text', 'secret dm text', 'their reply', 'orphan dm text', 'JOIN-AAAA']) {
      assert.equal(text.includes(secret), false, secret);
    }
    const steps = logLines.map(([, line]) => /step=(\S+)/.exec(line)?.[1]);
    assert.deepEqual(steps, [
      'start', 'alerts', 'watchlist', 'resources', 'resource_uploads', 'team_messages', 'conversations',
      'direct_messages', 'dm_invites_sent', 'dm_invites_received', 'invite_codes', 'profile', 'auth_user', 'done',
    ]);
    assert.match(text, /\[deleteAccount\] uid=u1 step=conversations conversations=1 messages=2 files=3/);
  });

  it("never deletes someone else's photo that the caller's docs merely point at", async () => {
    seedOrg();
    seedUser('attacker', { role: 'member', organization_id: ORG_ID });
    seedUser('victim', { role: 'member', organization_id: ORG_ID });
    seedUser('far', { role: 'admin', organization_id: 'org_other' });
    const victim = {
      incident: 'incidents/1760000000100_v.jpg',
      watch: 'watchlist/1760000000101_v.jpg',
      farResource: 'resources/far_1760000000102.jpg',
      otherConvDm: 'direct_messages/convVictim/1760000000103.jpg',
    };
    Object.values(victim).forEach(p => storage.files.add(p));
    db.seed('alerts/v1', { reporterId: 'victim', organizationId: ORG_ID, imageUrls: [url(victim.incident)] });
    db.seed('watchlist/v2', { createdBy: 'victim', organizationId: ORG_ID, imageUrls: [url(victim.watch)] });
    db.seed('resources/v3', { postedBy: 'far', organizationId: 'org_other', imageUrl: url(victim.farResource) });
    db.seed('conversations/convVictim', { participants: ['victim', 'far'] });
    db.seed('direct_messages/v4', { conversationId: 'convVictim', senderId: 'victim', imageUrl: url(victim.otherConvDm) });

    // The attacker's own docs point at all of those (nothing checks these URL fields).
    const everyVictimUrl = Object.values(victim).map(p => url(p));
    db.seed('alerts/x1', { reporterId: 'attacker', organizationId: ORG_ID, imageUrls: everyVictimUrl });
    db.seed('watchlist/x2', { createdBy: 'attacker', organizationId: ORG_ID, imageUrls: everyVictimUrl });
    db.seed('resources/x3', { postedBy: 'attacker', organizationId: '', imageUrl: url(victim.farResource) });
    db.seed('conversations/convX', { participants: ['attacker', 'far'] });
    db.seed('direct_messages/x4', { conversationId: 'convX', senderId: 'attacker', imageUrl: url(victim.otherConvDm) });
    db.seed('direct_messages/x5', { conversationId: 'convGone', senderId: 'attacker', imageUrl: url(victim.incident) });

    const res = await call({ token: auth.token('attacker') });
    assert.equal(res.statusCode, 200);
    for (const path of ['alerts/x1', 'watchlist/x2', 'resources/x3', 'conversations/convX', 'direct_messages/x4', 'direct_messages/x5']) {
      assert.equal(db.read(path), undefined, `${path} should be deleted`);
    }
    for (const [key, path] of Object.entries(victim)) {
      assert.equal(storage.files.has(path), true, `${key} photo should survive`);
    }
    assert.ok(db.read('alerts/v1'));
    assert.ok(db.read('direct_messages/v4'));
    assert.equal(db.events.some(e => e.startsWith('storage.delete')), false);
    assert.match(logLines.map(([, l]) => l).join('\n'), /step=photos_kept files=2/);
  });

  it("deletes an incident photo shared by the caller's own alert and watchlist entry", async () => {
    seedOrg();
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    seedUser('other', { role: 'member', organization_id: ORG_ID });
    const shared = 'incidents/1760000000200_u1.jpg';
    storage.files.add(shared);
    db.seed('alerts/a1', { reporterId: 'u1', organizationId: ORG_ID, imageUrl: url(shared), imageUrls: [url(shared)] });
    db.seed('watchlist/w1', { createdBy: 'u1', organizationId: ORG_ID, linkedAlertId: 'a1', imageUrls: [url(shared)] });
    db.seed('alerts/a2', { reporterId: 'other', organizationId: ORG_ID, imageUrls: [] });

    const res = await call({ token: auth.token('u1') });
    assert.equal(res.statusCode, 200);
    assert.equal(storage.files.has(shared), false);
    assert.equal(db.read('alerts/a1'), undefined);
    assert.equal(db.read('watchlist/w1'), undefined);
    assert.doesNotMatch(logLines.map(([, l]) => l).join('\n'), /photos_kept/);
  });

  it('pages through large collections in batches of at most 500 writes', async () => {
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    const count = PAGE_SIZE * 2 + 50;
    for (let i = 0; i < count; i++) {
      db.seed(`alerts/a${String(i).padStart(4, '0')}`, { reporterId: 'u1', organizationId: ORG_ID });
    }
    db.seed('alerts/zzOther', { reporterId: 'someoneElse', organizationId: ORG_ID });
    const res = await call({ token: auth.token('u1') });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(db.idsIn('alerts'), ['zzOther']);
    assert.ok(Math.max(...db.batchSizes) <= 500);
    assert.deepEqual(db.batchSizes.slice(0, 3), [PAGE_SIZE, PAGE_SIZE, 50]);
  });

  it('refuses a token whose sign-in is older than 5 minutes, and deletes nothing', async () => {
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    seedFootprint('u1', 'other');
    const before = new Map(db.store);
    for (const ageMs of [RECENT_LOGIN_MS + 1000, 24 * 60 * 60 * 1000]) {
      const res = await call({ token: auth.token('u1', ageMs) });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, { error: 'requires-recent-login' });
    }
    // No auth_time at all.
    auth.tokens.set('no-auth-time', { uid: 'u1' });
    const res = await call({ token: 'no-auth-time' });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'requires-recent-login' });

    assert.deepEqual(new Map(db.store), before);
    assert.equal(auth.users.has('u1'), true);
    assert.deepEqual(db.events, []);
  });

  it('accepts a sign-in just inside the 5 minutes', async () => {
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    const res = await call({ token: auth.token('u1', RECENT_LOGIN_MS - 1000) });
    assert.equal(res.statusCode, 200);
  });

  it('answers 401 without a valid ID token, 405 for other methods, 204 for preflight', async () => {
    seedUser('u1', { role: 'member', organization_id: ORG_ID });
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }, { authorization: 'Bearer forged' }]) {
      const res = await call({ headers });
      assert.equal(res.statusCode, 401, JSON.stringify(headers));
      assert.deepEqual(res.body, { error: 'unauthenticated' });
    }
    const get = await call({ method: 'GET', token: auth.token('u1') });
    assert.equal(get.statusCode, 405);
    const options = await call({ method: 'OPTIONS' });
    assert.equal(options.statusCode, 204);
    assert.equal(options.body, '');
    assert.ok(db.read('users/u1'));
    assert.equal(auth.users.has('u1'), true);
  });

  describe('last admin of an org with other members', () => {
    beforeEach(() => {
      seedOrg();
      seedUser('admin1', { role: 'admin', organization_id: ORG_ID });
      seedUser('m1', { role: 'member', organization_id: ORG_ID, name: 'Zed Member' });
      seedUser('s1', { role: 'security', organization_id: ORG_ID, name: 'Amy Guard' });
      // Legacy profile that only has the camelCase field.
      seedUser('legacy1', { role: 'member', organizationId: ORG_ID, name: 'Legacy Lou', email: 'lou@example.org' });
      // Not members: removed (camelCase still names the org), quarantined, another org.
      seedUser('removed1', { role: 'member', organization_id: 'removed', organizationId: ORG_ID });
      seedUser('quarantined1', { role: '', organization_id: '', organizationId: '' });
      seedUser('elsewhere1', { role: 'admin', organization_id: 'org_other' });
      db.seed('alerts/a1', { reporterId: 'admin1', organizationId: ORG_ID });
    });

    it('answers 409 with the org name and the members to choose from, and deletes nothing', async () => {
      const before = new Map(db.store);
      const res = await call({ token: auth.token('admin1') });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.body, {
        error: 'last-admin',
        organizationName: 'Grace Chapel',
        members: [
          { uid: 's1', name: 'Amy Guard', role: 'security' },
          { uid: 'legacy1', name: 'Legacy Lou', role: 'member' },
          { uid: 'm1', name: 'Zed Member', role: 'member' },
        ],
      });
      assert.deepEqual(new Map(db.store), before);
      assert.equal(auth.users.has('admin1'), true);
    });

    it('makes the chosen member admin (role only), then deletes the account', async () => {
      const res = await call({ token: auth.token('admin1'), body: { newAdminUid: 'm1' } });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { deleted: true });
      assert.deepEqual(db.read('users/m1'),
        { id: 'm1', name: 'Zed Member', email: 'm1@example.org', role: 'admin', organization_id: ORG_ID });
      assert.equal(db.read('users/admin1'), undefined);
      assert.equal(db.read('alerts/a1'), undefined);
      assert.equal(auth.users.has('admin1'), false);
      // Promotion first, Auth user last.
      assert.equal(db.events[0], 'update users/m1 {"role":"admin"}');
      assert.equal(db.events.at(-1), 'auth.deleteUser admin1');
      assert.match(logLines.map(([, l]) => l).join('\n'), /step=handoff org=org_1760000000000 newAdmin=m1/);
    });

    it('can hand the org to a legacy camelCase member', async () => {
      const res = await call({ token: auth.token('admin1'), body: { newAdminUid: 'legacy1' } });
      assert.equal(res.statusCode, 200);
      assert.equal(db.read('users/legacy1').role, 'admin');
      assert.equal(db.read('users/legacy1').organizationId, ORG_ID);
    });

    it('refuses a newAdminUid that is not one of the members, and changes nothing', async () => {
      for (const newAdminUid of ['elsewhere1', 'removed1', 'quarantined1', 'nobody', 'admin1', '', 42, { uid: 'm1' }]) {
        const before = new Map(db.store);
        const res = await call({ token: auth.token('admin1'), body: { newAdminUid } });
        assert.equal(res.statusCode, 400, JSON.stringify(newAdminUid));
        assert.deepEqual(res.body, { error: 'invalid-new-admin' });
        assert.deepEqual(new Map(db.store), before, JSON.stringify(newAdminUid));
      }
      assert.equal(auth.users.has('admin1'), true);
    });

    it('refuses the handoff when the member leaves the org before the promotion commits', async () => {
      db.beforeTransaction = () => {
        db.seed('users/m1', { ...db.read('users/m1'), organization_id: 'removed' });
      };
      const res = await call({ token: auth.token('admin1'), body: { newAdminUid: 'm1' } });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'invalid-new-admin' });
      assert.equal(db.read('users/m1').role, 'member');
      assert.ok(db.read('users/admin1'));
      assert.ok(db.read('alerts/a1'));
    });

    it('also applies to a super admin', async () => {
      seedUser('admin1', { role: 'super_admin', organization_id: ORG_ID });
      const res = await call({ token: auth.token('admin1') });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.members.length, 3);
    });

    it('applies to an admin whose own profile only has the legacy camelCase org', async () => {
      seedUser('admin1', { role: 'admin', organizationId: ORG_ID });
      const res = await call({ token: auth.token('admin1') });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.body.members.map(m => m.uid), ['s1', 'legacy1', 'm1']);
    });

    it('needs no handoff when another admin remains, even a legacy camelCase one', async () => {
      seedUser('legacy1', { role: 'admin', organizationId: ORG_ID });
      const res = await call({ token: auth.token('admin1'), body: { newAdminUid: 'm1' } });
      assert.equal(res.statusCode, 200);
      assert.equal(db.read('users/m1').role, 'member'); // newAdminUid ignored
      assert.equal(db.read('users/admin1'), undefined);
    });

    it('lets a plain member delete without a handoff, and never promotes on their say-so', async () => {
      seedUser('admin1', { role: 'member', organization_id: ORG_ID });
      const res = await call({ token: auth.token('admin1'), body: { newAdminUid: 'm1' } });
      assert.equal(res.statusCode, 200);
      assert.equal(db.read('users/m1').role, 'member');
      assert.equal(db.events.some(e => e.startsWith('update')), false);
    });
  });

  it('lets the sole member of an org (its admin) delete without a handoff, keeping the org', async () => {
    seedOrg();
    seedUser('admin1', { role: 'admin', organization_id: ORG_ID });
    seedUser('removed1', { role: 'member', organization_id: 'removed' });
    db.seed('invite_codes/c1', { createdBy: 'admin1', organizationId: ORG_ID });
    const res = await call({ token: auth.token('admin1') });
    assert.equal(res.statusCode, 200);
    assert.equal(db.read('users/admin1'), undefined);
    assert.equal(db.read('invite_codes/c1'), undefined);
    assert.ok(db.read('organizations/AutoDocId123'));
    assert.equal(auth.users.has('admin1'), false);
  });

  it('deletes an admin with no usable org, or with no profile at all', async () => {
    seedUser('orphan', { role: 'admin', organization_id: '' });
    assert.equal((await call({ token: auth.token('orphan') })).statusCode, 200);
    assert.equal(auth.users.has('orphan'), false);

    auth.users.add('bare'); // an Auth user whose profile is already gone
    db.seed('alerts/b1', { reporterId: 'bare', organizationId: ORG_ID });
    assert.equal((await call({ token: auth.token('bare') })).statusCode, 200);
    assert.equal(db.read('alerts/b1'), undefined);
    assert.equal(auth.users.has('bare'), false);
  });

  describe('partial failure and retry', () => {
    beforeEach(() => {
      seedOrg();
      seedUser('u1', { role: 'member', organization_id: ORG_ID });
      seedUser('other', { role: 'member', organization_id: ORG_ID });
    });

    it('finishes the job on retry after a batch fails midway', async (t) => {
      const files = seedFootprint('u1', 'other');
      db.failOnce('batch', ref => ref.path === 'direct_messages/m1');
      const first = await call({ token: auth.token('u1') });
      assert.equal(first.statusCode, 500);
      assert.deepEqual(first.body, { error: 'internal' });
      // Earlier steps are done, the rest isn't; the account still exists.
      assert.equal(db.read('alerts/a1'), undefined);
      assert.ok(db.read('direct_messages/m1'));
      assert.ok(db.read('conversations/conv1'));
      assert.ok(db.read('users/u1'));
      assert.equal(auth.users.has('u1'), true);
      assert.match(logLines.find(([level]) => level === 'error')[1], /uid=u1 step=conversations failed/);

      const retry = await call({ token: auth.token('u1') });
      assert.equal(retry.statusCode, 200);
      assertEverythingDeleted('u1', files);
    });

    it('finishes the job on retry after a photo delete fails, without losing the photo', async () => {
      const files = seedFootprint('u1', 'other');
      storage.failPaths.add(files.watch);
      const first = await call({ token: auth.token('u1') });
      assert.equal(first.statusCode, 500);
      // The doc stays until its photos are gone, so the retry still knows the photo.
      assert.ok(db.read('watchlist/w1'));
      assert.equal(storage.files.has(files.watch), true);

      const retry = await call({ token: auth.token('u1') });
      assert.equal(retry.statusCode, 200);
      assertEverythingDeleted('u1', files);
    });

    it('finishes the job on retry after the Auth delete fails (profile already gone)', async () => {
      seedFootprint('u1', 'other');
      auth.failDeleteOnce = true;
      const first = await call({ token: auth.token('u1') });
      assert.equal(first.statusCode, 500);
      assert.equal(db.read('users/u1'), undefined);
      assert.equal(auth.users.has('u1'), true);

      const retry = await call({ token: auth.token('u1') });
      assert.equal(retry.statusCode, 200);
      assert.equal(auth.users.has('u1'), false);
    });

    it('answers success when called again after everything is already gone', async () => {
      assert.equal((await call({ token: auth.token('u1') })).statusCode, 200);
      const again = await call({ token: auth.token('u1') });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.body, { deleted: true });
    });

    it('keeps the profile and the Auth user when the profile delete fails', async () => {
      db.failOnce('delete', ref => ref.path === 'users/u1');
      const first = await call({ token: auth.token('u1') });
      assert.equal(first.statusCode, 500);
      assert.ok(db.read('users/u1'));
      assert.equal(auth.users.has('u1'), true);
      assert.equal(db.events.some(e => e.startsWith('auth.deleteUser')), false);
    });
  });
});
