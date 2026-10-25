// Tests for the index.js changes: validateInviteCode records a join intent without
// changing any response, and repairInviteJoin is wired to the inviteJoinRepair handler.
// firebase-admin is replaced with an in-memory stand-in before index.js loads, so
// nothing here touches the network or a real project.
// Run from functions/: npm test

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const { INTENTS_COLLECTION } = require('../inviteJoinRepair');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-15T18:00:00.000Z'); // fake server time for serverTimestamp()
const ORG_ID = 'org_1760000000000';                  // an org's `id` field, as codes store it

// -------------------------------------------------------------------------------------
// firebase-admin stand-in: only what index.js touches at load time, in
// validateInviteCode, and in the repairInviteJoin handler.
// -------------------------------------------------------------------------------------
class FakeTimestamp {
  constructor(millis) {
    this.millis = millis;
  }

  static fromMillis(millis) {
    return new FakeTimestamp(millis);
  }

  static fromDate(date) {
    return new FakeTimestamp(date.getTime());
  }

  toMillis() {
    return this.millis;
  }

  toDate() {
    return new Date(this.millis);
  }
}

const SERVER_TIMESTAMP = Object.freeze({ sentinel: 'serverTimestamp' });
const FieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
  increment: n => ({ sentinel: 'increment', n }),
  delete: () => ({ sentinel: 'delete' }),
};

function compareValues(a, b) {
  if (a instanceof FakeTimestamp && b instanceof FakeTimestamp) return a.millis - b.millis;
  if (typeof a === typeof b && (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    this.db.checkReads();
    return this.snapshot();
  }

  async update(data) {
    this.applyUpdate(data);
  }

  snapshot() {
    const stored = this.db.store.get(this.path);
    return {
      id: this.id,
      ref: this,
      exists: !!stored,
      createTime: stored ? new FakeTimestamp(stored.createTimeMillis) : undefined,
      data: () => (stored ? { ...stored.data } : undefined),
    };
  }

  applyUpdate(data) {
    const stored = this.db.store.get(this.path);
    if (!stored) throw new Error(`NOT_FOUND: No document to update: ${this.path}`);
    const next = { ...stored.data };
    for (const [key, value] of Object.entries(data)) {
      if (value && value.sentinel === 'increment') next[key] = (next[key] || 0) + value.n;
      else next[key] = this.db.resolve(value);
    }
    stored.data = next;
  }

  applySet(data) {
    const existing = this.db.store.get(this.path);
    const resolved = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, this.db.resolve(v)]));
    this.db.store.set(this.path, {
      data: resolved,
      createTimeMillis: existing ? existing.createTimeMillis : this.db.now(),
    });
  }
}

class FakeQuery {
  constructor(db, collectionName, filters = [], orders = [], limitCount = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.filters = filters;
    this.orders = orders;
    this.limitCount = limitCount;
  }

  where(field, op, value) {
    return new FakeQuery(this.db, this.collectionName, [...this.filters, { field, op, value }], this.orders, this.limitCount);
  }

  orderBy(field, direction = 'asc') {
    return new FakeQuery(this.db, this.collectionName, this.filters, [...this.orders, { field, direction }], this.limitCount);
  }

  limit(count) {
    return new FakeQuery(this.db, this.collectionName, this.filters, this.orders, count);
  }

  async get() {
    return this.run();
  }

  run() {
    this.db.checkReads();
    const ops = {
      '==': c => c === 0, '<': c => c < 0, '<=': c => c <= 0, '>': c => c > 0, '>=': c => c >= 0,
    };
    let refs = this.db.idsIn(this.collectionName)
      .map(id => new FakeDocRef(this.db, this.collectionName, id))
      .filter(ref => this.filters.every(({ field, op, value }) => {
        const cmp = compareValues(this.db.store.get(ref.path).data[field], value);
        return cmp !== null && ops[op](cmp);
      }));
    for (const { field, direction } of [...this.orders].reverse()) {
      refs.sort((a, b) => {
        const cmp = compareValues(this.db.store.get(a.path).data[field], this.db.store.get(b.path).data[field]) || 0;
        return direction === 'desc' ? -cmp : cmp;
      });
    }
    if (this.limitCount !== null) refs = refs.slice(0, this.limitCount);
    const docs = refs.map(ref => ref.snapshot());
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeCollection extends FakeQuery {
  doc(id) {
    return new FakeDocRef(this.db, this.collectionName, id);
  }

  async add(data) {
    if (this.db.failAddsTo === this.collectionName) {
      throw new Error('DEADLINE_EXCEEDED: simulated write failure');
    }
    const ref = this.doc(`auto${++this.db.autoId}`);
    ref.applySet(data);
    return ref;
  }
}

class FakeDb {
  constructor() {
    this.reset();
  }

  reset() {
    this.store = new Map();
    this.autoId = 0;
    this.failAddsTo = null;
    this.failReads = false;
    this.transactions = 0;
    this.now = () => NOW;
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(updateFunction) {
    this.transactions++;
    const writes = [];
    const tx = {
      get: async target => (target instanceof FakeDocRef ? target.snapshot() : target.run()),
      update: (ref, data) => writes.push(() => ref.applyUpdate(data)),
      set: (ref, data) => writes.push(() => ref.applySet(data)),
    };
    const result = await updateFunction(tx);
    writes.forEach(write => write());
    return result;
  }

  checkReads() {
    if (this.failReads) throw new Error('UNAVAILABLE: simulated read failure');
  }

  resolve(value) {
    return value === SERVER_TIMESTAMP ? new FakeTimestamp(this.now()) : value;
  }

  idsIn(collectionName) {
    const prefix = `${collectionName}/`;
    return [...this.store.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
  }

  seed(docPath, data, createTimeMillis = NOW) {
    this.store.set(docPath, { data: { ...data }, createTimeMillis });
  }

  read(docPath) {
    const stored = this.store.get(docPath);
    return stored ? { ...stored.data } : undefined;
  }

  docsIn(collectionName) {
    return this.idsIn(collectionName).map(id => ({ id, ...this.read(`${collectionName}/${id}`) }));
  }
}

const fakeDb = new FakeDb();
const fakeAdmin = {
  initializeApp: () => ({}),
  firestore: Object.assign(() => fakeDb, { FieldValue, Timestamp: FakeTimestamp }),
  // ID tokens in these tests are 'token-<uid>'.
  auth: () => ({
    verifyIdToken: async (token) => {
      if (!token.startsWith('token-')) throw new Error('auth/argument-error: invalid token');
      return { uid: token.slice('token-'.length) };
    },
  }),
};

// Make index.js's require('firebase-admin') return the stand-in.
const adminPath = require.resolve('firebase-admin', { paths: [path.join(__dirname, '..')] });
const adminStub = new Module(adminPath);
adminStub.filename = adminPath;
adminStub.loaded = true;
adminStub.exports = fakeAdmin;
require.cache[adminPath] = adminStub;

const index = require('../index.js');

// -------------------------------------------------------------------------------------
// Request helpers
// -------------------------------------------------------------------------------------
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = JSON.stringify(payload); // what express sends with default settings
      this.headersSent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

async function callValidate({ method = 'POST', body = {} } = {}) {
  const res = makeRes();
  await index.validateInviteCode({ method, body, headers: {} }, res);
  return res;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// A code minted by admin1, a long-standing admin of the code's org.
function seedCode(overrides = {}) {
  fakeDb.seed('users/admin1', { role: 'admin', organization_id: ORG_ID }, NOW - 30 * DAY);
  fakeDb.seed('invite_codes/code1', {
    code: 'JOIN-ABCD-EFGH',
    organizationId: ORG_ID,
    role: 'member',
    createdBy: 'admin1',
    createdAt: new FakeTimestamp(NOW - DAY),
    expiresAt: new FakeTimestamp(Date.now() + 30 * DAY),
    maxUses: 10,
    usedCount: 0,
    isActive: true,
    ...overrides,
  });
}

// Orgs created in the app get auto IDs, with ORG_ID stored in their `id` field.
function seedAppCreatedOrg() {
  fakeDb.seed('organizations/AutoDocId123', { id: ORG_ID, name: 'Grace Chapel', maxSeats: 15 });
}

// -------------------------------------------------------------------------------------
// validateInviteCode
// -------------------------------------------------------------------------------------
describe('validateInviteCode', () => {
  beforeEach(() => fakeDb.reset());

  it('finds an app-created org by its id field and records one join intent', async () => {
    seedCode();
    seedAppCreatedOrg();

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.headers, CORS_HEADERS);
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
    assert.equal(fakeDb.read('invite_codes/code1').usedCount, 1);
    assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION), [{
      id: 'auto1',
      code: 'JOIN-ABCD-EFGH',
      inviteCodeId: 'code1',
      organizationId: ORG_ID,
      role: 'member',
      validatedAt: new FakeTimestamp(NOW),
      consumed: false,
    }]);
  });

  it('stores the normalized code on the intent', async () => {
    seedCode();
    seedAppCreatedOrg();
    const res = await callValidate({ body: { inviteCode: '  join-abcd-efgh ' } });
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
    assert.equal(fakeDb.docsIn(INTENTS_COLLECTION)[0].code, 'JOIN-ABCD-EFGH');
  });

  it('uses the org name when the org doc id matches, and records the intent', async () => {
    seedCode({ role: 'security' });
    fakeDb.seed(`organizations/${ORG_ID}`, { id: ORG_ID, name: 'Grace Chapel', maxSeats: 15 });
    fakeDb.seed('users/existing', { organization_id: ORG_ID });

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, `{"valid":true,"role":"security","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
    assert.equal(fakeDb.docsIn(INTENTS_COLLECTION)[0].role, 'security');
  });

  it('keeps omitting role from the response when the code has none, but records member', async () => {
    seedCode({ role: undefined });
    seedAppCreatedOrg();
    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, `{"valid":true,"organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
    assert.equal(fakeDb.docsIn(INTENTS_COLLECTION)[0].role, 'member');
  });

  it('returns the same response when recording the intent fails, and logs it', async (t) => {
    const consoleError = t.mock.method(console, 'error', () => {});
    seedCode();
    seedAppCreatedOrg();
    fakeDb.failAddsTo = INTENTS_COLLECTION;

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.headers, CORS_HEADERS);
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
    assert.equal(fakeDb.read('invite_codes/code1').usedCount, 1);
    assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION), []);
    assert.equal(consoleError.mock.callCount(), 1);
    assert.equal(consoleError.mock.calls[0].arguments[0], 'Error recording invite join intent:');
    assert.match(consoleError.mock.calls[0].arguments[1].message, /simulated write failure/);
  });

  const rejections = [
    {
      name: 'an unknown code',
      seed: () => seedCode({ code: 'JOIN-ZZZZ-ZZZZ' }),
      status: 200,
      body: '{"valid":false,"error":"Invalid invite code"}',
    },
    {
      name: 'a deactivated code',
      seed: () => seedCode({ isActive: false }),
      status: 200,
      body: '{"valid":false,"error":"This invite code has been deactivated"}',
    },
    {
      name: 'an expired code',
      seed: () => seedCode({ expiresAt: new FakeTimestamp(Date.now() - DAY) }),
      status: 200,
      body: '{"valid":false,"error":"This invite code has expired"}',
    },
    {
      name: 'a used-up code',
      seed: () => seedCode({ usedCount: 10 }),
      status: 200,
      body: '{"valid":false,"error":"This invite code has reached its usage limit"}',
    },
    {
      name: 'an org at its seat limit',
      seed: () => {
        seedCode();
        fakeDb.seed(`organizations/${ORG_ID}`, { id: ORG_ID, name: 'Grace Chapel', maxSeats: 2 });
        fakeDb.seed('users/a', { organization_id: ORG_ID });
        fakeDb.seed('users/b', { organization_id: ORG_ID });
      },
      status: 200,
      body: '{"valid":false,"error":"This organization has reached its seat limit (2). Contact the admin to upgrade the plan."}',
    },
    {
      name: 'an app-created org at its seat limit',
      seed: () => {
        seedCode();
        fakeDb.seed('organizations/AutoDocId123', { id: ORG_ID, name: 'Grace Chapel', maxSeats: 3 });
        for (const uid of ['a', 'b', 'c']) fakeDb.seed(`users/${uid}`, { organization_id: ORG_ID });
      },
      status: 200,
      body: '{"valid":false,"error":"This organization has reached its seat limit (3). Contact the admin to upgrade the plan."}',
    },
    {
      name: 'an org without an id field (keyed by doc id) at its seat limit',
      seed: () => {
        seedCode();
        fakeDb.seed(`organizations/${ORG_ID}`, { name: 'Acme', maxSeats: 1 });
        fakeDb.seed('users/a', { organization_id: ORG_ID });
      },
      status: 200,
      body: '{"valid":false,"error":"This organization has reached its seat limit (1). Contact the admin to upgrade the plan."}',
    },
    {
      name: 'a code that names no organization',
      seed: () => seedCode({ organizationId: '' }),
      status: 200,
      body: '{"valid":false,"error":"Invalid invite code"}',
    },
    {
      name: 'a code for an organization that does not exist',
      seed: () => seedCode(),
      status: 200,
      body: '{"valid":false,"error":"Invalid invite code"}',
    },
  ];

  for (const { name, seed, status, body } of rejections) {
    it(`rejects ${name} unchanged and records no intent`, async () => {
      seed();
      const usedBefore = fakeDb.read('invite_codes/code1').usedCount;
      const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
      assert.equal(res.statusCode, status);
      assert.deepEqual(res.headers, CORS_HEADERS);
      assert.equal(res.body, body);
      assert.equal(fakeDb.read('invite_codes/code1').usedCount, usedBefore);
      assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION), []);
    });
  }

  it('turns off a code once its creator no longer administers the org', async () => {
    const formerCreators = {
      demoted: { role: 'member', organization_id: ORG_ID },
      moved: { role: 'admin', organization_id: 'org_elsewhere' },
      quarantined: { role: '', organization_id: '' },
    };
    for (const [name, creator] of Object.entries(formerCreators)) {
      fakeDb.reset();
      seedCode();
      fakeDb.seed('users/admin1', creator, NOW - 30 * DAY);
      const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
      assert.equal(res.body, '{"valid":false,"error":"This invite code has been deactivated"}', name);
      assert.equal(fakeDb.read('invite_codes/code1').usedCount, 0, name);
      assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION), [], name);
    }
  });

  it('turns off a code whose creator account is gone, but keeps script-made and super admin codes', async () => {
    seedCode({ createdBy: 'deletedUser' });
    const gone = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(gone.body, '{"valid":false,"error":"This invite code has been deactivated"}');

    for (const scriptCreator of ['system', 'test-admin', 'e2e-test']) {
      fakeDb.reset();
      seedCode({ createdBy: scriptCreator });
      seedAppCreatedOrg();
      assert.match((await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } })).body, /"valid":true/, scriptCreator);
    }

    fakeDb.reset();
    seedCode({ createdBy: 'owner' });
    seedAppCreatedOrg();
    fakeDb.seed('users/owner', { role: 'super_admin', organization_id: 'org_hq' }, NOW - 30 * DAY);
    assert.match((await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } })).body, /"valid":true/);

    fakeDb.reset();
    seedCode({ createdBy: undefined });
    seedAppCreatedOrg();
    assert.equal((await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } })).body,
      '{"valid":false,"error":"This invite code has been deactivated"}');
  });

  it('counts people who validated a code in the last few minutes as taking a seat', async () => {
    seedCode();
    fakeDb.seed(`organizations/${ORG_ID}`, { id: ORG_ID, name: 'Grace Chapel', maxSeats: 3 });
    fakeDb.seed('users/a', { organization_id: ORG_ID }); // with admin1: 2 members
    fakeDb.seed(`${INTENTS_COLLECTION}/joining`,
      { organizationId: ORG_ID, consumed: false, validatedAt: new FakeTimestamp(Date.now() - 60 * 1000) });

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, '{"valid":false,"error":"Someone is joining this organization with its last open seat right now. Please try again in a few minutes."}');
    assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION).map(i => i.id), ['joining']);
  });

  it('does not count people joining another organization', async () => {
    seedCode();
    fakeDb.seed(`organizations/${ORG_ID}`, { id: ORG_ID, name: 'Grace Chapel', maxSeats: 3 });
    fakeDb.seed('users/a', { organization_id: ORG_ID });
    fakeDb.seed(`${INTENTS_COLLECTION}/elsewhere`,
      { organizationId: 'org_other', consumed: false, validatedAt: new FakeTimestamp(Date.now() - 60 * 1000) });

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
  });

  it('does not count consumed or stale join intents', async () => {
    seedCode();
    fakeDb.seed(`organizations/${ORG_ID}`, { id: ORG_ID, name: 'Grace Chapel', maxSeats: 3 });
    fakeDb.seed('users/a', { organization_id: ORG_ID });
    fakeDb.seed(`${INTENTS_COLLECTION}/joined`,
      { organizationId: ORG_ID, consumed: true, validatedAt: new FakeTimestamp(Date.now() - 60 * 1000) });
    fakeDb.seed(`${INTENTS_COLLECTION}/abandoned`,
      { organizationId: ORG_ID, consumed: false, validatedAt: new FakeTimestamp(Date.now() - 10 * 60 * 1000) });

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
  });

  it('keeps a legacy org without an id field ahead of a later copy claiming its doc id', async () => {
    seedCode();
    fakeDb.seed(`organizations/${ORG_ID}`, { name: 'Acme', maxSeats: 30 }, NOW - 30 * DAY);
    fakeDb.seed('organizations/LaterImpostor', { id: ORG_ID, name: 'Impostor', maxSeats: 1 }, NOW - DAY);

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Acme"}`);
  });

  it('finds an org by its doc id when its codes use the doc id but the org has its own id field', async () => {
    seedCode();
    fakeDb.seed(`organizations/${ORG_ID}`, { id: 'org_other', name: 'Acme', maxSeats: 1 });

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, '{"valid":false,"error":"This organization has reached its seat limit (1). Contact the admin to upgrade the plan."}');
  });

  it('uses the oldest org doc when a later copy carries the same id field', async () => {
    seedCode();
    fakeDb.seed('organizations/RealOrgDoc', { id: ORG_ID, name: 'Grace Chapel', maxSeats: 15 }, NOW - 30 * DAY);
    fakeDb.seed('organizations/AAALaterTwin', { id: ORG_ID, name: 'Impostor', maxSeats: 1 }, NOW - DAY);
    fakeDb.seed('users/a', { organization_id: ORG_ID });

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.body, `{"valid":true,"role":"member","organizationId":"${ORG_ID}","organizationName":"Grace Chapel"}`);
  });

  it('keeps the request-shape responses (400 / 405 / 204) and records no intent', async () => {
    seedCode();
    const missing = await callValidate({ body: {} });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body, '{"valid":false,"error":"Invite code required"}');

    const notString = await callValidate({ body: { inviteCode: 42 } });
    assert.equal(notString.statusCode, 400);
    assert.equal(notString.body, '{"valid":false,"error":"Invite code required"}');

    const get = await callValidate({ method: 'GET' });
    assert.equal(get.statusCode, 405);
    assert.equal(get.body, '{"error":"Method not allowed"}');

    const options = await callValidate({ method: 'OPTIONS' });
    assert.equal(options.statusCode, 204);
    assert.equal(options.body, '');

    assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION), []);
  });

  it('keeps the 500 response on a lookup failure and records no intent', async (t) => {
    t.mock.method(console, 'error', () => {});
    seedCode();
    fakeDb.failReads = true;

    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body, '{"valid":false,"error":"Internal server error"}');
    assert.deepEqual(fakeDb.docsIn(INTENTS_COLLECTION), []);
  });
});

// -------------------------------------------------------------------------------------
// generateInviteCode
// -------------------------------------------------------------------------------------
async function callGenerate(uid, body = { role: 'member' }) {
  const res = makeRes();
  await index.generateInviteCode({ method: 'POST', body, headers: { authorization: `Bearer token-${uid}` } }, res);
  return res;
}

describe('generateInviteCode', () => {
  beforeEach(() => {
    fakeDb.reset();
    seedAppCreatedOrg();
  });

  const established = Date.now() - DAY; // profile createTime of a long-standing admin

  it('lets an established admin mint a member code for their own org', async () => {
    fakeDb.seed('users/admin1', { role: 'admin', organization_id: ORG_ID }, established);
    const res = await callGenerate('admin1', { role: 'member', maxUses: 10, expiresInDays: 30 });
    assert.equal(res.statusCode, 200);
    const [code] = fakeDb.docsIn('invite_codes');
    assert.equal(code.organizationId, ORG_ID);
    assert.equal(code.createdBy, 'admin1');
    assert.equal(code.role, 'member');
    assert.equal(code.isActive, true);
    assert.equal(code.maxUses, 10);
    assert.ok(Math.abs(code.expiresAt.toMillis() - (Date.now() + 30 * DAY)) < 2 * DAY);
  });

  it('caps every code at 50 uses and 30 days, and never mints one without limits', async () => {
    fakeDb.seed('users/admin1', { role: 'admin', organization_id: ORG_ID }, established);
    await callGenerate('admin1', { role: 'member', maxUses: 100000, expiresInDays: 3650 });
    await callGenerate('admin1', { role: 'member', maxUses: 0, expiresInDays: 0 });
    const [big, unlimited] = fakeDb.docsIn('invite_codes');
    assert.equal(big.maxUses, 50);
    assert.equal(unlimited.maxUses, 10);
    for (const code of [big, unlimited]) {
      assert.ok(code.expiresAt.toMillis() - Date.now() <= 31 * DAY);
    }
  });

  it('refuses admins of an org that is pending, rejected or missing', async () => {
    fakeDb.seed('users/admin1', { role: 'admin', organization_id: ORG_ID }, established);
    for (const status of ['pending', 'rejected']) {
      fakeDb.seed('organizations/AutoDocId123', { id: ORG_ID, name: 'Grace Chapel', status });
      const res = await callGenerate('admin1');
      assert.equal(res.statusCode, 403, status);
      assert.equal(res.body, '{"error":"Your organization must be approved before it can invite members"}', status);
    }
    fakeDb.seed('users/claimant', { role: 'admin', organization_id: 'org_1999999999999' }, Date.now() - 60 * 1000);
    assert.equal((await callGenerate('claimant')).statusCode, 403);
    assert.deepEqual(fakeDb.docsIn('invite_codes'), []);
  });

  it('makes a brand-new admin profile in an org with other members wait before minting codes', async () => {
    fakeDb.seed('users/member1', { role: 'member', organization_id: ORG_ID }, established);
    fakeDb.seed('users/fresh', { role: 'admin', organization_id: ORG_ID }, Date.now() - 2 * 60 * 1000);
    const res = await callGenerate('fresh');
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, '{"error":"New accounts can create invite codes a few minutes after sign-up"}');
    assert.deepEqual(fakeDb.docsIn('invite_codes'), []);
  });

  it('lets a brand-new admin who is the only member of their org mint right away', async () => {
    fakeDb.seed('users/provisioned', { role: 'admin', organization_id: ORG_ID }, Date.now() - 60 * 1000);
    assert.equal((await callGenerate('provisioned')).statusCode, 200);
  });

  it('does not make a super admin wait', async () => {
    fakeDb.seed('users/member1', { role: 'member', organization_id: ORG_ID }, established);
    fakeDb.seed('users/super1', { role: 'super_admin', organization_id: ORG_ID }, Date.now() - 60 * 1000);
    assert.equal((await callGenerate('super1')).statusCode, 200);
  });

  it('reads a legacy camelCase-only org the way the rules do', async () => {
    fakeDb.seed('users/legacy', { role: 'admin', organizationId: ORG_ID }, established);
    assert.equal((await callGenerate('legacy')).statusCode, 200);
    assert.equal(fakeDb.docsIn('invite_codes')[0].organizationId, ORG_ID);
  });

  it('refuses an admin whose profile names no usable organization', async () => {
    for (const orgId of ['', 'removed']) {
      fakeDb.reset();
      fakeDb.seed('users/orphan', { role: 'admin', organization_id: orgId }, established);
      const res = await callGenerate('orphan');
      assert.equal(res.statusCode, 400, orgId);
      assert.equal(res.body, '{"error":"Your account is not linked to an organization"}', orgId);
      assert.deepEqual(fakeDb.docsIn('invite_codes'), [], orgId);
    }
  });

  it('keeps refusing non-admins, and elevated codes from plain admins', async () => {
    fakeDb.seed('users/member1', { role: 'member', organization_id: ORG_ID }, established);
    fakeDb.seed('users/admin1', { role: 'admin', organization_id: ORG_ID }, established);
    const notAdmin = await callGenerate('member1');
    assert.equal(notAdmin.statusCode, 403);
    assert.equal(notAdmin.body, '{"error":"Only admins can generate invite codes"}');
    const elevated = await callGenerate('admin1', { role: 'admin' });
    assert.equal(elevated.statusCode, 403);
    assert.equal(elevated.body, '{"error":"You can only create member invite codes"}');
    assert.deepEqual(fakeDb.docsIn('invite_codes'), []);
  });
});

// -------------------------------------------------------------------------------------
// Apple: appleNotifications and validateAppleReceipt
// -------------------------------------------------------------------------------------
const HOLYGUARD_BUNDLE_ID = 'com.lonestardevops.holyguard';
const IN_A_MONTH = String(Date.now() + 30 * DAY);

// DER of Apple's marker OIDs 1.2.840.113635.100.6.<n>.1 (11: App Store signing leaf,
// 2: WWDR intermediate), which index.js requires on the certificate chain.
const appleMarker = n => Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, n, 0x01]);

// A test can't hold Apple's signing keys, so stand in for the certificate checks: every
// certificate matches Apple's root, carries the given marker OIDs (both by default), and
// every signature verifies.
function stubAppleSignatures(t, { markers = [0x0b, 0x02] } = {}) {
  const crypto = require('node:crypto');
  const RealCertificate = crypto.X509Certificate;
  const raw = Buffer.concat([Buffer.from('apple-cert'), ...markers.map(appleMarker)]);
  crypto.X509Certificate = class {
    constructor() {
      this.raw = raw;
      this.publicKey = {};
    }

    verify() {
      return true;
    }
  };
  t.after(() => { crypto.X509Certificate = RealCertificate; });
  t.mock.method(crypto, 'verify', () => true);
}

function signed(payload) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256', x5c: ['AA==', 'AA==', 'AA=='] })}.${part(payload)}.c2ln`;
}

// A HolyGuard subscription transaction, as StoreKit 2 / the App Store sign it.
const transaction = fields => ({
  bundleId: HOLYGUARD_BUNDLE_ID,
  type: 'Auto-Renewable Subscription',
  originalTransactionId: 'otx1',
  expiresDate: IN_A_MONTH,
  ...fields,
});

async function notify(notificationType, subtype, tx) {
  const res = makeRes();
  const signedPayload = signed({ notificationType, subtype, data: { signedTransactionInfo: signed(tx) } });
  await index.appleNotifications({ method: 'POST', body: { signedPayload }, headers: {} }, res);
  return res;
}

async function callReceipt(uid, jws) {
  const res = makeRes();
  await index.validateAppleReceipt({ method: 'POST', body: { jws }, headers: { authorization: `Bearer token-${uid}` } }, res);
  return res;
}

describe('appleNotifications', () => {
  beforeEach(() => fakeDb.reset());

  function seedSubscribedOrg(productId, plan, maxSeats) {
    fakeDb.seed('organizations/AutoDocId123', {
      id: ORG_ID, name: 'Grace Chapel', subscriptionStatus: 'active', subscriptionPlan: plan,
      maxSeats, appleProductId: productId, appleOriginalTransactionId: 'otx1',
    });
  }

  it('applies an upgrade right away', async (t) => {
    stubAppleSignatures(t);
    seedSubscribedOrg('001', 'individual', 3);
    const res = await notify('DID_CHANGE_RENEWAL_PREF', 'UPGRADE', transaction({ productId: '002' }));
    assert.equal(res.statusCode, 200);
    const org = fakeDb.read('organizations/AutoDocId123');
    assert.equal(org.subscriptionStatus, 'active');
    assert.equal(org.subscriptionPlan, 'team');
    assert.equal(org.maxSeats, 15);
    assert.equal(org.appleProductId, '002');
    assert.equal(org.appleExpiresDateMs, Number(IN_A_MONTH));
  });

  it('leaves a downgrade, and a plan change with no subtype, for the next renewal', async (t) => {
    stubAppleSignatures(t);
    for (const subtype of ['DOWNGRADE', undefined]) {
      fakeDb.reset();
      seedSubscribedOrg('002', 'team', 15);
      const res = await notify('DID_CHANGE_RENEWAL_PREF', subtype, transaction({ productId: '001' }));
      assert.equal(res.statusCode, 200, subtype);
      const org = fakeDb.read('organizations/AutoDocId123');
      assert.equal(org.subscriptionPlan, 'team', subtype);
      assert.equal(org.maxSeats, 15, subtype);
      assert.equal(org.appleProductId, '002', subtype);
      assert.ok(org.subscriptionUpdatedAt, subtype);
    }
  });

  it('ignores an upgrade notice whose transaction was itself upgraded away, or names no known plan', async (t) => {
    stubAppleSignatures(t);
    for (const tx of [transaction({ productId: '003', isUpgraded: true }), transaction({ productId: '999' })]) {
      fakeDb.reset();
      seedSubscribedOrg('001', 'individual', 3);
      const res = await notify('DID_CHANGE_RENEWAL_PREF', 'UPGRADE', tx);
      assert.equal(res.statusCode, 200);
      const org = fakeDb.read('organizations/AutoDocId123');
      assert.equal(org.subscriptionPlan, 'individual');
      assert.equal(org.maxSeats, 3);
      assert.equal(org.appleProductId, '001');
      assert.ok(org.subscriptionUpdatedAt);
    }
  });

  it('still applies the plan on renewal', async (t) => {
    stubAppleSignatures(t);
    seedSubscribedOrg('002', 'team', 15);
    await notify('DID_RENEW', undefined, transaction({ productId: '001' }));
    const org = fakeDb.read('organizations/AutoDocId123');
    assert.equal(org.subscriptionPlan, 'individual');
    assert.equal(org.maxSeats, 3);
    assert.equal(org.appleProductId, '001');
  });

  it('keeps a grandfathered org uncapped when an old subscription renews', async (t) => {
    stubAppleSignatures(t);
    fakeDb.seed('organizations/AutoDocId123', {
      id: ORG_ID, name: 'Grace Chapel', subscriptionStatus: 'active', subscriptionPlan: 'grandfathered',
      grandfathered: true, appleProductId: '001', appleOriginalTransactionId: 'otx1',
    });
    await notify('DID_RENEW', undefined, transaction({ productId: '002' }));
    const org = fakeDb.read('organizations/AutoDocId123');
    assert.equal(org.subscriptionPlan, 'grandfathered');
    assert.equal('maxSeats' in org, false);
    assert.equal(org.appleProductId, '002');
    assert.equal(org.subscriptionStatus, 'active');
  });

  it("ignores another app's notification even when the product id matches", async (t) => {
    stubAppleSignatures(t);
    seedSubscribedOrg('001', 'individual', 3);
    const res = await notify('DID_RENEW', undefined, transaction({ productId: '003', bundleId: 'com.someone.else' }));
    assert.equal(res.body, '{"ok":true,"ignored":"other app"}');
    assert.equal(fakeDb.read('organizations/AutoDocId123').maxSeats, 3);
  });

  it('rejects a notification whose certificates lack Apple\'s App Store markers', async (t) => {
    stubAppleSignatures(t, { markers: [] });
    t.mock.method(console, 'error', () => {});
    seedSubscribedOrg('001', 'individual', 3);
    const res = await notify('DID_RENEW', undefined, transaction({ productId: '003' }));
    assert.equal(res.statusCode, 401);
    assert.equal(fakeDb.read('organizations/AutoDocId123').maxSeats, 3);
  });
});

describe('validateAppleReceipt', () => {
  beforeEach(() => {
    fakeDb.reset();
    seedAppCreatedOrg();
    fakeDb.seed('users/admin1', { role: 'admin', organization_id: ORG_ID });
    fakeDb.seed('users/member1', { role: 'member', organization_id: ORG_ID });
  });

  it('activates the plan an admin bought', async (t) => {
    stubAppleSignatures(t);
    const res = await callReceipt('admin1', signed(transaction({ productId: '003', originalTransactionId: 'otxNew' })));
    assert.match(res.body, /"valid":true/);
    const org = fakeDb.read('organizations/AutoDocId123');
    assert.equal(org.subscriptionStatus, 'active');
    assert.equal(org.subscriptionPlan, 'enterprise');
    assert.equal(org.maxSeats, 30);
    assert.equal(org.appleOriginalTransactionId, 'otxNew');
  });

  it('refuses a plain member', async (t) => {
    stubAppleSignatures(t);
    const res = await callReceipt('member1', signed(transaction({ productId: '003' })));
    assert.equal(res.statusCode, 403);
    assert.equal(fakeDb.read('organizations/AutoDocId123').maxSeats, 15);
  });

  it("refuses another app's transaction, a non-subscription, and a transaction with no expiry", async (t) => {
    stubAppleSignatures(t);
    const cases = {
      'other app': [transaction({ productId: '003', bundleId: 'com.someone.else' }), 'Not a HolyGuard subscription'],
      consumable: [transaction({ productId: '003', type: 'Consumable' }), 'Not a HolyGuard subscription'],
      'no expiry': [transaction({ productId: '003', expiresDate: undefined }), 'Subscription expired'],
    };
    for (const [name, [tx, error]] of Object.entries(cases)) {
      const res = await callReceipt('admin1', signed(tx));
      assert.equal(JSON.parse(res.body).valid, false, name);
      assert.equal(JSON.parse(res.body).error, error, name);
    }
    assert.equal(fakeDb.read('organizations/AutoDocId123').maxSeats, 15);
  });

  it('refuses a transaction that does not carry the full leaf / intermediate / root chain', async (t) => {
    stubAppleSignatures(t);
    t.mock.method(console, 'warn', () => {});
    const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const shortChain = `${part({ alg: 'ES256', x5c: ['AA==', 'AA=='] })}.${part(transaction({ productId: '003' }))}.c2ln`;
    const res = await callReceipt('admin1', shortChain);
    assert.equal(res.body, '{"valid":false,"error":"Invalid signature"}');
    assert.equal(fakeDb.read('organizations/AutoDocId123').maxSeats, 15);
  });

  it("refuses a transaction unless the leaf carries the App Store marker and the intermediate the WWDR one", async (t) => {
    t.mock.method(console, 'warn', () => {});
    const chains = { 'no markers': [], 'leaf marker only': [0x0b], 'intermediate marker only': [0x02] };
    for (const [name, markers] of Object.entries(chains)) {
      await t.test(name, async (st) => {
        stubAppleSignatures(st, { markers });
        const res = await callReceipt('admin1', signed(transaction({ productId: '003' })));
        assert.equal(res.body, '{"valid":false,"error":"Invalid signature"}');
        assert.equal(fakeDb.read('organizations/AutoDocId123').maxSeats, 15);
      });
    }
  });
});

// -------------------------------------------------------------------------------------
// repairInviteJoin wiring
// -------------------------------------------------------------------------------------
describe('repairInviteJoin export', () => {
  beforeEach(() => fakeDb.reset());

  it('is a gen2 Firestore onDocumentCreated trigger on users/{uid} in us-central1', () => {
    const endpoint = index.repairInviteJoin.__endpoint;
    assert.equal(endpoint.platform, 'gcfv2');
    assert.deepEqual(endpoint.region, ['us-central1']);
    assert.deepEqual(endpoint.eventTrigger, {
      eventType: 'google.cloud.firestore.document.v1.created',
      eventFilters: { database: '(default)', namespace: '(default)' },
      eventFilterPathPatterns: { document: 'users/{uid}' },
      retry: true,
    });
  });

  it('repairs a live-app sign-up end to end: validate the code, then create the profile', async (t) => {
    const consoleLog = t.mock.method(console, 'log', () => {});
    seedCode();
    seedAppCreatedOrg();
    const res = await callValidate({ body: { inviteCode: 'join-abcd-efgh' } });
    assert.match(res.body, /"valid":true/);

    // What SignUpScreen writes a few seconds later (stale state: role and org '').
    const profile = {
      id: 'newUser',
      name: 'Pat Doe',
      email: 'pat@example.com',
      role: '',
      organization_id: '',
      email_verified: false,
      created_at: new FakeTimestamp(NOW + 4000),
      tos_accepted_at: new FakeTimestamp(NOW + 4000),
    };
    fakeDb.seed('users/newUser', profile, NOW + 5000);
    fakeDb.now = () => NOW + 7000;
    const event = {
      id: 'event-newUser',
      time: new Date(NOW + 5100).toISOString(),
      params: { uid: 'newUser' },
      data: new FakeDocRef(fakeDb, 'users', 'newUser').snapshot(),
    };

    const result = await index.repairInviteJoin.run(event);
    assert.deepEqual(result, { outcome: 'assigned', organizationId: ORG_ID, role: 'member', intentId: 'auto1' });
    assert.deepEqual(fakeDb.read('users/newUser'), {
      ...profile,
      organization_id: ORG_ID,
      role: 'member',
      inviteJoinRepairedAt: new FakeTimestamp(NOW + 7000),
      inviteJoinIntentId: 'auto1',
    });
    assert.deepEqual(fakeDb.read(`${INTENTS_COLLECTION}/auto1`), {
      code: 'JOIN-ABCD-EFGH',
      inviteCodeId: 'code1',
      organizationId: ORG_ID,
      role: 'member',
      validatedAt: new FakeTimestamp(NOW),
      consumed: true,
      consumedBy: 'newUser',
      consumedAt: new FakeTimestamp(NOW + 7000),
    });
    assert.equal(fakeDb.transactions, 1);
    assert.equal(consoleLog.mock.callCount(), 1);
    assert.match(consoleLog.mock.calls[0].arguments[0], /attached users\/newUser to org/);
  });

  it('leaves an org creator (sole member of their org) untouched', async () => {
    fakeDb.seed('users/admin1', { id: 'admin1', role: 'admin', organization_id: ORG_ID }, NOW);
    const event = {
      id: 'event-admin1',
      time: new Date(NOW).toISOString(),
      params: { uid: 'admin1' },
      data: new FakeDocRef(fakeDb, 'users', 'admin1').snapshot(),
    };
    assert.deepEqual(await index.repairInviteJoin.run(event), { outcome: 'skipped', reason: 'sole_member' });
  });

  it('quarantines a profile that self-asserts into an org that already has a member', async () => {
    fakeDb.seed('users/incumbent', { id: 'incumbent', role: 'member', organization_id: ORG_ID }, NOW - 60000);
    fakeDb.seed('users/intruder', { id: 'intruder', role: 'admin', organization_id: ORG_ID }, NOW);
    const event = {
      id: 'event-intruder',
      time: new Date(NOW).toISOString(),
      params: { uid: 'intruder' },
      data: new FakeDocRef(fakeDb, 'users', 'intruder').snapshot(),
    };
    assert.equal((await index.repairInviteJoin.run(event)).outcome, 'quarantined');
    assert.equal(fakeDb.read('users/intruder').role, '');
    assert.equal(fakeDb.read('users/intruder').organization_id, '');
  });

  it('leaves a TOS-fallback doc alone even right after a successful validation', async (t) => {
    t.mock.method(console, 'log', () => {});
    seedCode();
    seedAppCreatedOrg();
    const res = await callValidate({ body: { inviteCode: 'JOIN-ABCD-EFGH' } });
    assert.match(res.body, /"valid":true/);

    // TosAcceptanceScreen's setDoc(merge) fallback for a user whose profile was deleted.
    const tosOnly = { tos_accepted_at: new Date(NOW + 4000).toISOString() };
    fakeDb.seed('users/returning', tosOnly, NOW + 5000);
    const event = {
      id: 'event-returning',
      time: new Date(NOW + 5100).toISOString(),
      params: { uid: 'returning' },
      data: new FakeDocRef(fakeDb, 'users', 'returning').snapshot(),
    };

    assert.deepEqual(await index.repairInviteJoin.run(event), { outcome: 'skipped', reason: 'unexpected_shape' });
    assert.equal(fakeDb.transactions, 0);
    assert.deepEqual(fakeDb.read('users/returning'), tosOnly);
    assert.equal(fakeDb.read(`${INTENTS_COLLECTION}/auto1`).consumed, false);
  });
});
