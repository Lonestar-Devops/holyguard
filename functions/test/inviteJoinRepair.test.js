// Tests for inviteJoinRepair.js: the pure decision function and the real handler from
// createRepairInviteJoinHandler, run against an in-memory Firestore stand-in.
// Run from functions/: npm test

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  INTENTS_COLLECTION,
  REVIEW_COLLECTION,
  WINDOW_BEFORE_MS,
  INTENT_QUERY_LIMIT,
  hasOrganization,
  isInviteSignupProfile,
  sanitizeRole,
  decideJoinRepair,
  createRepairInviteJoinHandler,
} = require('../inviteJoinRepair');

const SEC = 1000;
const MIN = 60 * SEC;
const T = Date.parse('2026-10-15T18:00:00.000Z'); // users/{uid} createTime in most tests
const COMMIT = T + 3 * SEC;                        // fake server time for serverTimestamp()

// -------------------------------------------------------------------------------------
// In-memory Firestore stand-in. Implements only what the handler uses:
//   db.collection(name).doc(id)
//   db.collection(name).where(field, op, value).orderBy(field).limit(n)
//   db.runTransaction(fn) with tx.get(docRef | query), tx.update(ref, data), tx.set(ref, data)
//   Timestamp.fromMillis / toMillis, FieldValue.serverTimestamp()
// Commits are optimistic like the real server: if anything a transaction read changed
// before it commits, the commit is rejected and the transaction function runs again.
// -------------------------------------------------------------------------------------
class FakeTimestamp {
  constructor(millis) {
    this.millis = millis;
  }

  static fromMillis(millis) {
    return new FakeTimestamp(millis);
  }

  toMillis() {
    return this.millis;
  }
}

const SERVER_TIMESTAMP = Object.freeze({ sentinel: 'serverTimestamp' });
const FakeFieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
};

const MAX_TRANSACTION_ATTEMPTS = 5;
const RANGE_OPS = ['<', '<=', '>', '>='];

function clone(value) {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.millis);
  if (value === SERVER_TIMESTAMP) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

// Firestore rejects undefined field values (unless ignoreUndefinedProperties is set).
function assertNoUndefined(value, where) {
  if (value === undefined) {
    throw new Error(`Cannot use "undefined" as a Firestore value (${where})`);
  }
  if (value instanceof FakeTimestamp || value === SERVER_TIMESTAMP || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${where}[${i}]`));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => assertNoUndefined(v, `${where}.${k}`));
  }
}

function resolveServerTimestamps(value, commitMillis) {
  if (value === SERVER_TIMESTAMP) return new FakeTimestamp(commitMillis);
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.millis);
  if (Array.isArray(value)) return value.map(v => resolveServerTimestamps(v, commitMillis));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveServerTimestamps(v, commitMillis)])
    );
  }
  return value;
}

// Firestore ordering for the value types used here; null means "not comparable", and
// such documents are excluded from range filters, as in Firestore.
function compareValues(a, b) {
  if (a instanceof FakeTimestamp && b instanceof FakeTimestamp) return a.millis - b.millis;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function matchesFilter(data, { field, op, value }) {
  if (!(field in data)) return false;
  const cmp = compareValues(data[field], value);
  if (cmp === null) return false;
  switch (op) {
    case '==': return cmp === 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    default: throw new Error(`FakeFirestore: unsupported operator ${op}`);
  }
}

class FakeDocRef {
  constructor(collectionName, id) {
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }
}

class FakeQuery {
  constructor(collectionName, filters = [], orders = [], limitCount = null) {
    this.collectionName = collectionName;
    this.filters = filters;
    this.orders = orders;
    this.limitCount = limitCount;
  }

  doc(id) {
    if (this.filters.length || this.orders.length || this.limitCount !== null) {
      throw new Error('FakeFirestore: doc() is only available on a collection reference');
    }
    if (typeof id !== 'string' || !id) throw new Error('FakeFirestore: doc() needs an id');
    return new FakeDocRef(this.collectionName, id);
  }

  where(field, op, value) {
    if (op !== '==' && !RANGE_OPS.includes(op)) {
      throw new Error(`FakeFirestore: unsupported operator ${op}`);
    }
    return new FakeQuery(this.collectionName, [...this.filters, { field, op, value }], this.orders, this.limitCount);
  }

  orderBy(field, direction = 'asc') {
    return new FakeQuery(this.collectionName, this.filters, [...this.orders, { field, direction }], this.limitCount);
  }

  limit(count) {
    return new FakeQuery(this.collectionName, this.filters, this.orders, count);
  }
}

function snapshotOf(ref, stored) {
  return {
    id: ref.id,
    ref,
    exists: !!stored,
    createTime: stored ? new FakeTimestamp(stored.createTimeMillis) : undefined,
    data: () => (stored ? clone(stored.data) : undefined),
  };
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.docReads = [];   // { path, version }
    this.queryReads = []; // { query, signature }
    this.writes = [];
  }

  async get(target) {
    if (this.writes.length) {
      throw new Error('Firestore transactions require all reads to be executed before all writes.');
    }
    // Yield so concurrent transactions interleave their reads, as they can in production.
    await new Promise(resolve => setImmediate(resolve));
    if (target instanceof FakeDocRef) {
      const stored = this.db.store.get(target.path);
      this.docReads.push({ path: target.path, version: stored ? stored.version : 0 });
      return snapshotOf(target, stored);
    }
    if (target instanceof FakeQuery) {
      const docs = this.db.runQuery(target);
      this.db.executedQueries.push(target);
      this.queryReads.push({ query: target, signature: this.db.querySignature(target) });
      return { docs, size: docs.length, empty: docs.length === 0 };
    }
    throw new TypeError('FakeFirestore: tx.get() takes a document reference or a query');
  }

  update(ref, data) {
    if (!(ref instanceof FakeDocRef)) throw new TypeError('FakeFirestore: update() needs a document reference');
    this.writes.push({ kind: 'update', ref, data });
    return this;
  }

  set(ref, data, options) {
    if (!(ref instanceof FakeDocRef)) throw new TypeError('FakeFirestore: set() needs a document reference');
    if (options !== undefined) throw new Error('FakeFirestore: set() options are not supported');
    this.writes.push({ kind: 'set', ref, data });
    return this;
  }

  readsAreStale() {
    return this.docReads.some(r => this.db.versionOf(r.path) !== r.version) ||
      this.queryReads.some(r => this.db.querySignature(r.query) !== r.signature);
  }

  commit() {
    const commitMillis = this.db.clock();
    // Validate every write before applying any, so a rejected commit changes nothing.
    for (const w of this.writes) {
      assertNoUndefined(w.data, w.ref.path);
      if (w.kind === 'update' && !this.db.store.has(w.ref.path)) {
        throw new Error(`NOT_FOUND: No document to update: ${w.ref.path}`);
      }
    }
    for (const w of this.writes) {
      const existing = this.db.store.get(w.ref.path);
      const resolved = resolveServerTimestamps(w.data, commitMillis);
      this.db.store.set(w.ref.path, {
        data: w.kind === 'update' ? { ...existing.data, ...resolved } : resolved,
        version: this.db.nextVersion++,
        createTimeMillis: existing ? existing.createTimeMillis : commitMillis,
      });
    }
  }
}

class FakeFirestore {
  constructor({ clock = () => COMMIT } = {}) {
    this.store = new Map(); // 'collection/id' -> { data, version, createTimeMillis }
    this.clock = clock;
    this.nextVersion = 1;
    this.stats = { transactions: 0, attempts: 0, commits: 0 };
    this.executedQueries = [];
    this.transactionError = null; // set by tests to simulate an unexpected failure
  }

  collection(name) {
    return new FakeQuery(name);
  }

  async runTransaction(updateFunction) {
    this.stats.transactions++;
    if (this.transactionError) throw this.transactionError;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
      this.stats.attempts++;
      const tx = new FakeTransaction(this);
      const result = await updateFunction(tx);
      if (tx.readsAreStale()) continue; // ABORTED by contention: run the function again
      tx.commit();
      this.stats.commits++;
      return result;
    }
    throw new Error('FakeFirestore: transaction aborted after too many attempts');
  }

  // Composite indexes don't exist here: like production without firestore.indexes.json
  // entries, a query touching more than one field is rejected.
  runQuery(query) {
    const fields = new Set([...query.filters.map(f => f.field), ...query.orders.map(o => o.field)]);
    if (fields.size > 1) {
      throw new Error(`FAILED_PRECONDITION: The query requires a composite index (${[...fields].join(', ')})`);
    }
    const prefix = `${query.collectionName}/`;
    let rows = [...this.store.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, stored]) => ({ id: path.slice(prefix.length), stored }))
      .filter(({ stored }) => query.filters.every(f => matchesFilter(stored.data, f)));
    for (const { field } of query.orders) {
      rows = rows.filter(({ stored }) => field in stored.data);
    }
    rows.sort((a, b) => {
      for (const { field, direction } of query.orders) {
        const cmp = compareValues(a.stored.data[field], b.stored.data[field]) || 0;
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (query.limitCount !== null) rows = rows.slice(0, query.limitCount);
    return rows.map(({ id, stored }) => snapshotOf(new FakeDocRef(query.collectionName, id), stored));
  }

  querySignature(query) {
    return this.runQuery(query).map(doc => `${doc.id}@${this.versionOf(doc.ref.path)}`).join('|');
  }

  versionOf(path) {
    const stored = this.store.get(path);
    return stored ? stored.version : 0;
  }

  // ---- test helpers (not used by the handler) ----

  seed(path, data, createTimeMillis) {
    assertNoUndefined(data, path);
    this.store.set(path, { data: clone(data), version: this.nextVersion++, createTimeMillis });
  }

  read(path) {
    const stored = this.store.get(path);
    return stored ? clone(stored.data) : undefined;
  }

  snapshot(path) {
    const [collectionName, id] = path.split('/');
    return snapshotOf(new FakeDocRef(collectionName, id), this.store.get(path));
  }

  dump() {
    return Object.fromEntries([...this.store.entries()].map(([path, stored]) => [path, clone(stored.data)]));
  }
}

// -------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------

// The profile the live app writes on an invite-code sign-up (stale state: role and org '').
function buggyProfile(uid) {
  return {
    id: uid,
    name: 'Pat Doe',
    email: `${uid}@example.com`,
    role: '',
    organization_id: '',
    email_verified: false,
    created_at: new FakeTimestamp(T - 1500),
    tos_accepted_at: new FakeTimestamp(T - 1500),
  };
}

// Creates users/{uid} with exactly `data` and returns the onDocumentCreated event for it.
function createDoc(db, uid, data, createTimeMillis = T) {
  db.seed(`users/${uid}`, data, createTimeMillis);
  return {
    id: `event-${uid}`,
    time: new Date(createTimeMillis + 250).toISOString(),
    params: { uid },
    data: db.snapshot(`users/${uid}`),
  };
}

// Creates the live app's invite sign-up profile (plus any overrides) for uid.
function createUser(db, uid, overrides = {}, createTimeMillis = T) {
  return createDoc(db, uid, { ...buggyProfile(uid), ...overrides }, createTimeMillis);
}

// What TosAcceptanceScreen's setDoc(merge) fallback creates when the profile was deleted.
const TOS_FALLBACK_DOC = { tos_accepted_at: '2026-10-15T18:00:00.000Z' };

function addIntent(db, id, { organizationId, offsetMs, role = 'member', consumed = false, ...extra }) {
  db.seed(`${INTENTS_COLLECTION}/${id}`, {
    code: 'JOIN-ABCD-EFGH',
    inviteCodeId: `code_${id}`,
    organizationId,
    role,
    validatedAt: new FakeTimestamp(T + offsetMs),
    consumed,
    ...extra,
  }, T + offsetMs);
}

function captureLogger() {
  const calls = { log: [], warn: [], error: [] };
  const record = level => (...args) => calls[level].push(args.map(String).join(' '));
  return { calls, log: record('log'), warn: record('warn'), error: record('error') };
}

function setup(clock) {
  const db = new FakeFirestore(clock ? { clock } : undefined);
  const logger = captureLogger();
  const handler = createRepairInviteJoinHandler({
    db,
    FieldValue: FakeFieldValue,
    Timestamp: FakeTimestamp,
    logger,
  });
  return { db, logger, handler };
}

// -------------------------------------------------------------------------------------
// decideJoinRepair (pure)
// -------------------------------------------------------------------------------------
describe('decideJoinRepair', () => {
  const candidate = (id, organizationId, offsetMs, extra = {}) => ({
    id,
    organizationId,
    role: 'member',
    validatedAtMillis: T + offsetMs,
    consumed: false,
    ...extra,
  });

  it('flags no_intent when there are no candidates', () => {
    const expected = { action: 'review', reason: 'no_intent', candidateOrgIds: [] };
    assert.deepEqual(decideJoinRepair([], T), expected);
    assert.deepEqual(decideJoinRepair(undefined, T), expected);
  });

  it('assigns the only candidate, keeping its role', () => {
    assert.deepEqual(
      decideJoinRepair([candidate('i1', 'org_a', -5 * SEC, { role: 'security' })], T),
      { action: 'assign', intentId: 'i1', organizationId: 'org_a', role: 'security' }
    );
  });

  it('picks the oldest candidate when every candidate is for the same org', () => {
    const decision = decideJoinRepair([
      candidate('newer', 'org_a', -1 * MIN),
      candidate('oldest', 'org_a', -4 * MIN),
      candidate('middle', 'org_a', -2 * MIN),
    ], T);
    assert.deepEqual(decision, { action: 'assign', intentId: 'oldest', organizationId: 'org_a', role: 'member' });
  });

  it('breaks validatedAt ties by intent id', () => {
    const decision = decideJoinRepair([candidate('b', 'org_a', -MIN), candidate('a', 'org_a', -MIN)], T);
    assert.equal(decision.intentId, 'a');
  });

  it('flags ambiguous when candidates span more than one org', () => {
    assert.deepEqual(
      decideJoinRepair([
        candidate('i1', 'org_b', -1 * MIN),
        candidate('i2', 'org_a', -2 * MIN),
        candidate('i3', 'org_b', -3 * MIN),
      ], T),
      { action: 'review', reason: 'ambiguous', candidateOrgIds: ['org_a', 'org_b'] }
    );
  });

  it('only assigns an intent whose consumed flag is exactly false', () => {
    const decision = decideJoinRepair([
      candidate('used', 'org_a', -3 * MIN, { consumed: true }),
      candidate('no-flag', 'org_a', -2 * MIN, { consumed: undefined }),
      candidate('open', 'org_a', -1 * MIN),
    ], T);
    assert.deepEqual(decision, { action: 'assign', intentId: 'open', organizationId: 'org_a', role: 'member' });
  });

  it('counts consumed intents when comparing orgs', () => {
    // The user's own intent was consumed by someone else's doc: never fall through to
    // another org's intent.
    assert.deepEqual(
      decideJoinRepair([
        candidate('mine', 'org_a', -3 * SEC, { consumed: true }),
        candidate('other', 'org_z', -1 * SEC),
      ], T),
      { action: 'review', reason: 'ambiguous', candidateOrgIds: ['org_a', 'org_z'] }
    );
    assert.equal(
      decideJoinRepair([candidate('odd', 'org_b', -MIN, { consumed: undefined }), candidate('open', 'org_a', -SEC)], T).reason,
      'ambiguous'
    );
  });

  it('flags no_intent, naming the org, when every intent in the window is consumed', () => {
    assert.deepEqual(
      decideJoinRepair([candidate('used', 'org_b', -MIN, { consumed: true })], T),
      { action: 'review', reason: 'no_intent', candidateOrgIds: ['org_b'] }
    );
  });

  it('flags ambiguous_role when one org\'s intents grant different roles, consumed or not', () => {
    const expected = { action: 'review', reason: 'ambiguous_role', candidateOrgIds: ['org_a'] };
    assert.deepEqual(decideJoinRepair([
      candidate('admin-code', 'org_a', -5 * SEC, { role: 'admin' }),
      candidate('member-code', 'org_a', -3 * SEC),
    ], T), expected);
    // The member code's intent was consumed by someone else: never hand out the admin one.
    assert.deepEqual(decideJoinRepair([
      candidate('admin-code', 'org_a', -5 * SEC, { role: 'admin' }),
      candidate('member-code', 'org_a', -3 * SEC, { consumed: true }),
    ], T), expected);
  });

  it('compares roles after sanitizing them', () => {
    const decision = decideJoinRepair([
      candidate('odd', 'org_a', -5 * SEC, { role: 'super_admin' }),
      candidate('plain', 'org_a', -3 * SEC),
    ], T);
    assert.deepEqual(decision, { action: 'assign', intentId: 'odd', organizationId: 'org_a', role: 'member' });
  });

  it('uses the inclusive window [T - 5 min, T]', () => {
    assert.equal(WINDOW_BEFORE_MS, 5 * MIN);
    const actionAt = offsetMs => decideJoinRepair([candidate('i', 'org_a', offsetMs)], T).action;
    assert.equal(actionAt(-5 * MIN), 'assign');
    assert.equal(actionAt(-5 * MIN - 1), 'review');
    assert.equal(actionAt(0), 'assign');
    assert.equal(actionAt(1), 'review');
  });

  it('does not let out-of-window intents create ambiguity', () => {
    const decision = decideJoinRepair([
      candidate('too-old', 'org_b', -5 * MIN - SEC),
      candidate('too-late', 'org_c', 1), // validated after the doc was created
      candidate('match', 'org_a', -30 * SEC),
    ], T);
    assert.deepEqual(decision, { action: 'assign', intentId: 'match', organizationId: 'org_a', role: 'member' });
  });

  it('sanitizes the role taken from the intent', () => {
    const roleFor = role => decideJoinRepair([{ id: 'i', organizationId: 'org_a', role, validatedAtMillis: T, consumed: false }], T).role;
    assert.equal(roleFor('admin'), 'admin');
    assert.equal(roleFor('security'), 'security');
    assert.equal(roleFor('member'), 'member');
    assert.equal(roleFor('super_admin'), 'member');
    assert.equal(roleFor('Admin'), 'member');
    assert.equal(roleFor(''), 'member');
    assert.equal(roleFor(undefined), 'member');
  });

  it('ignores malformed candidates', () => {
    const decision = decideJoinRepair([
      null,
      { id: 'no-org', role: 'member', validatedAtMillis: T, consumed: false },
      { id: 'empty-org', organizationId: '', role: 'member', validatedAtMillis: T, consumed: false },
      { id: 'no-time', organizationId: 'org_b', role: 'member', validatedAtMillis: NaN, consumed: false },
    ], T);
    assert.deepEqual(decision, { action: 'review', reason: 'no_intent', candidateOrgIds: [] });
  });

  it('flags ambiguous when the intent query was truncated', () => {
    assert.deepEqual(
      decideJoinRepair([candidate('i1', 'org_a', -MIN)], T, { truncated: true }),
      { action: 'review', reason: 'ambiguous', candidateOrgIds: ['org_a'] }
    );
  });
});

describe('sanitizeRole and hasOrganization', () => {
  it('sanitizeRole keeps only member, security and admin', () => {
    assert.deepEqual(
      ['member', 'security', 'admin', 'super_admin', null, 7].map(sanitizeRole),
      ['member', 'security', 'admin', 'member', 'member', 'member']
    );
  });

  it('hasOrganization accepts either spelling, non-empty strings only', () => {
    assert.equal(hasOrganization({ organization_id: 'org_a' }), true);
    assert.equal(hasOrganization({ organizationId: 'org_a' }), true);
    assert.equal(hasOrganization({ organization_id: '', organizationId: '' }), false);
    assert.equal(hasOrganization({ organization_id: 42 }), false);
    assert.equal(hasOrganization({}), false);
    assert.equal(hasOrganization(undefined), false);
  });
});

describe('isInviteSignupProfile', () => {
  it('accepts the exact profile the live sign-up writes', () => {
    assert.equal(isInviteSignupProfile(buggyProfile('u1'), 'u1'), true);
  });

  it('rejects every other doc', () => {
    const base = buggyProfile('u1');
    const without = field => Object.fromEntries(Object.entries(base).filter(([key]) => key !== field));
    const cases = {
      'TOS screen fallback': TOS_FALLBACK_DOC,
      'console doc with a role': { id: 'u1', name: 'Ops', email: 'ops@example.com', role: 'super_admin' },
      'partial console doc': { id: 'u1', name: 'Pat Doe', email: 'u1@example.com', role: '', organization_id: '' },
      'org creator': { ...base, role: 'admin', organization_id: 'org_a' },
      'role but no org': { ...base, role: 'admin' },
      'another uid': { ...base, id: 'u2' },
      'verified email': { ...base, email_verified: true },
      'string timestamp': { ...base, created_at: '2026-10-15T18:00:00.000Z' },
      'missing timestamp': { ...base, tos_accepted_at: null },
      'non-string email': { ...base, email: null },
      'non-string name': { ...base, name: 7 },
      'extra field': { ...base, inviteJoinIntentId: 'intent1' },
      'camelCase organizationId': { ...base, organizationId: '' },
      'missing field': without('created_at'),
      'empty doc': {},
    };
    for (const [label, data] of Object.entries(cases)) {
      assert.equal(isInviteSignupProfile(data, 'u1'), false, label);
    }
    assert.equal(isInviteSignupProfile(undefined, 'u1'), false);
    assert.equal(isInviteSignupProfile(null, 'u1'), false);
  });
});

// -------------------------------------------------------------------------------------
// repairInviteJoin handler (real handler, fake Firestore)
// -------------------------------------------------------------------------------------
describe('repairInviteJoin handler', () => {
  it('leaves the sole member (org creator) of a claimed org untouched', async () => {
    const { db, handler } = setup();
    addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -5 * SEC });
    const event = createUser(db, 'u1', { role: 'admin', organization_id: 'org_mine' });
    const before = db.dump();

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'sole_member' });
    assert.deepEqual(db.dump(), before);
  });

  it('leaves the sole member untouched when the org is named in camelCase', async () => {
    const { db, handler } = setup();
    addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -5 * SEC });
    const event = createUser(db, 'u1', { organizationId: 'org_mine' });
    const before = db.dump();

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'sole_member' });
    assert.deepEqual(db.dump(), before);
  });

  it('quarantines a profile that self-asserts into an org with existing members', async () => {
    const { db, handler, logger } = setup();
    db.seed('users/incumbent', { id: 'incumbent', role: 'member', organization_id: 'org_victim' }, T - MIN);
    const event = createUser(db, 'attacker', { role: 'admin', organization_id: 'org_victim' });

    const result = await handler(event);
    assert.equal(result.outcome, 'quarantined');
    assert.equal(result.claimedOrgId, 'org_victim');
    const user = db.read('users/attacker');
    assert.equal(user.role, '');
    assert.equal(user.organization_id, '');
    assert.equal(user.inviteJoinClaimedOrgId, 'org_victim');
    const review = db.read(`${REVIEW_COLLECTION}/attacker`);
    assert.equal(review.reason, 'unauthorized_org_claim');
    assert.equal(review.claimedOrgId, 'org_victim');
    // the incumbent member is left alone
    assert.deepEqual(db.read('users/incumbent'), { id: 'incumbent', role: 'member', organization_id: 'org_victim' });
    assert.equal(logger.calls.warn.length, 1);
  });

  it('judges the org as it was when the profile was created, so a late redelivery keeps its creator', async () => {
    const { db, handler } = setup();
    const event = createUser(db, 'creator', { role: 'admin', organization_id: 'org_new' });
    db.seed('users/joiner', { id: 'joiner', role: 'member', organization_id: 'org_new' }, T + 5 * MIN);

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'sole_member' });
    assert.equal(db.read('users/creator').role, 'admin');
    assert.equal(db.read('users/creator').organization_id, 'org_new');
  });

  it('quarantines a camelCase self-assertion and clears both org fields', async () => {
    const { db, handler } = setup();
    db.seed('users/incumbent', { id: 'incumbent', role: 'admin', organization_id: 'org_victim' }, T - MIN);
    const event = createUser(db, 'attacker', { organizationId: 'org_victim' });

    assert.equal((await handler(event)).outcome, 'quarantined');
    const user = db.read('users/attacker');
    assert.equal(user.organization_id, '');
    assert.equal(user.organizationId, '');
  });

  it('never touches a super_admin profile (trusted origin)', async () => {
    const { db, handler } = setup();
    db.seed('users/incumbent', { id: 'incumbent', role: 'member', organization_id: 'org_x' }, T - MIN);
    const event = createUser(db, 'newsuper', { role: 'super_admin', organization_id: 'org_x' });
    const before = db.dump();

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'trusted_role' });
    assert.deepEqual(db.dump(), before);
  });

  it('attaches the user to the org of a single intent and consumes it', async () => {
    const { db, logger, handler } = setup();
    addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -8 * SEC });
    const event = createUser(db, 'u1');

    assert.deepEqual(await handler(event), {
      outcome: 'assigned',
      organizationId: 'org_a',
      role: 'member',
      intentId: 'intent1',
    });
    assert.deepEqual(db.read('users/u1'), {
      ...buggyProfile('u1'),
      organization_id: 'org_a',
      role: 'member',
      inviteJoinRepairedAt: new FakeTimestamp(COMMIT),
      inviteJoinIntentId: 'intent1',
    });
    const intent = db.read(`${INTENTS_COLLECTION}/intent1`);
    assert.equal(intent.consumed, true);
    assert.equal(intent.consumedBy, 'u1');
    assert.deepEqual(intent.consumedAt, new FakeTimestamp(COMMIT));
    assert.equal(db.read(`${REVIEW_COLLECTION}/u1`), undefined);
    assert.equal(logger.calls.log.length, 1);
    assert.match(logger.calls.log[0], /attached users\/u1 to org org_a as member \(intent intent1\)/);
    assert.deepEqual(logger.calls.warn, []);
  });

  it('with two intents for the same org consumes the oldest and leaves the other', async () => {
    const { db, handler } = setup();
    addIntent(db, 'newer', { organizationId: 'org_a', offsetMs: -1 * MIN });
    addIntent(db, 'older', { organizationId: 'org_a', offsetMs: -4 * MIN });
    const event = createUser(db, 'u1');

    const result = await handler(event);
    assert.equal(result.outcome, 'assigned');
    assert.equal(result.intentId, 'older');
    assert.equal(db.read('users/u1').inviteJoinIntentId, 'older');
    assert.equal(db.read(`${INTENTS_COLLECTION}/older`).consumed, true);
    assert.equal(db.read(`${INTENTS_COLLECTION}/newer`).consumed, false);
    assert.equal(db.read(`${INTENTS_COLLECTION}/newer`).consumedBy, undefined);
  });

  it('flags the user for review when intents span two orgs, assigning nothing', async () => {
    const { db, logger, handler } = setup();
    addIntent(db, 'intentA', { organizationId: 'org_b', offsetMs: -2 * MIN });
    addIntent(db, 'intentB', { organizationId: 'org_a', offsetMs: -1 * MIN });
    const event = createUser(db, 'u1');

    assert.deepEqual(await handler(event), {
      outcome: 'review',
      reason: 'ambiguous',
      candidateOrgIds: ['org_a', 'org_b'],
    });
    // No email or name on the review doc (they stay on users/u1 only).
    assert.deepEqual(db.read(`${REVIEW_COLLECTION}/u1`), {
      uid: 'u1',
      reason: 'ambiguous',
      candidateOrgIds: ['org_a', 'org_b'],
      userCreatedAt: new FakeTimestamp(T),
      createdAt: new FakeTimestamp(COMMIT),
    });
    assert.deepEqual(db.read('users/u1'), buggyProfile('u1'));
    assert.equal(db.read(`${INTENTS_COLLECTION}/intentA`).consumed, false);
    assert.equal(db.read(`${INTENTS_COLLECTION}/intentB`).consumed, false);
    assert.equal(logger.calls.warn.length, 1);
    assert.match(logger.calls.warn[0], /users\/u1 has no organization.*ambiguous.*org_a, org_b/);
  });

  it('flags the user for review when there are no intents', async () => {
    const { db, logger, handler } = setup();
    const event = createUser(db, 'u1');

    assert.deepEqual(await handler(event), { outcome: 'review', reason: 'no_intent', candidateOrgIds: [] });
    const review = db.read(`${REVIEW_COLLECTION}/u1`);
    assert.equal(review.reason, 'no_intent');
    assert.deepEqual(review.candidateOrgIds, []);
    assert.deepEqual(db.read('users/u1'), buggyProfile('u1'));
    assert.match(logger.calls.warn[0], /no_intent; candidate orgs: none/);
  });

  it('never re-assigns a consumed intent, but counts it when comparing orgs', async () => {
    // Same org: the open intent is used and the consumed one is left as it was.
    const { db, handler } = setup();
    addIntent(db, 'taken', { organizationId: 'org_a', offsetMs: -2 * MIN, consumed: true, consumedBy: 'someone' });
    addIntent(db, 'open', { organizationId: 'org_a', offsetMs: -1 * MIN });
    const result = await handler(createUser(db, 'u1'));
    assert.equal(result.outcome, 'assigned');
    assert.equal(result.intentId, 'open');
    assert.equal(db.read(`${INTENTS_COLLECTION}/taken`).consumedBy, 'someone');

    // A consumed intent for another org makes the window ambiguous.
    const second = setup();
    addIntent(second.db, 'taken', { organizationId: 'org_b', offsetMs: -2 * MIN, consumed: true, consumedBy: 'someone' });
    addIntent(second.db, 'open', { organizationId: 'org_a', offsetMs: -1 * MIN });
    assert.deepEqual(await second.handler(createUser(second.db, 'u2')),
      { outcome: 'review', reason: 'ambiguous', candidateOrgIds: ['org_a', 'org_b'] });
    assert.equal(second.db.read(`${INTENTS_COLLECTION}/open`).consumed, false);
    assert.equal(second.db.read('users/u2').organization_id, '');

    // Nothing unconsumed left: no_intent, naming the org for staff.
    const third = setup();
    addIntent(third.db, 'taken', { organizationId: 'org_b', offsetMs: -2 * MIN, consumed: true, consumedBy: 'someone' });
    assert.deepEqual(await third.handler(createUser(third.db, 'u3')),
      { outcome: 'review', reason: 'no_intent', candidateOrgIds: ['org_b'] });
    assert.deepEqual(third.db.read(`${REVIEW_COLLECTION}/u3`).candidateOrgIds, ['org_b']);
  });

  it('ignores intents outside the window', async () => {
    const { db, handler } = setup();
    addIntent(db, 'too-old', { organizationId: 'org_b', offsetMs: -5 * MIN - SEC });
    addIntent(db, 'too-late', { organizationId: 'org_c', offsetMs: 1 }); // after the doc was created
    const event = createUser(db, 'u1');

    assert.deepEqual(await handler(event), { outcome: 'review', reason: 'no_intent', candidateOrgIds: [] });
    assert.equal(db.read(`${INTENTS_COLLECTION}/too-old`).consumed, false);
    assert.equal(db.read(`${INTENTS_COLLECTION}/too-late`).consumed, false);

    const second = setup();
    addIntent(second.db, 'too-old', { organizationId: 'org_b', offsetMs: -5 * MIN - SEC });
    addIntent(second.db, 'too-late', { organizationId: 'org_c', offsetMs: 1 });
    addIntent(second.db, 'match', { organizationId: 'org_a', offsetMs: -30 * SEC });
    const event2 = createUser(second.db, 'u2');
    const result = await second.handler(event2);
    assert.equal(result.outcome, 'assigned');
    assert.equal(result.intentId, 'match');
  });

  it('treats a duplicate delivery after an assignment as a no-op', async () => {
    let now = COMMIT;
    const { db, handler } = setup(() => now);
    addIntent(db, 'older', { organizationId: 'org_a', offsetMs: -3 * MIN });
    addIntent(db, 'newer', { organizationId: 'org_a', offsetMs: -1 * MIN });
    const event = createUser(db, 'u1');

    assert.equal((await handler(event)).outcome, 'assigned');
    const afterFirst = db.dump();
    now += 30 * SEC;

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'has_org' });
    assert.deepEqual(db.dump(), afterFirst);
    assert.equal(db.read(`${INTENTS_COLLECTION}/newer`).consumed, false);
  });

  it('treats a duplicate delivery after a review flag as a no-op', async () => {
    let now = COMMIT;
    const { db, handler } = setup(() => now);
    addIntent(db, 'intentA', { organizationId: 'org_a', offsetMs: -2 * MIN });
    addIntent(db, 'intentB', { organizationId: 'org_b', offsetMs: -1 * MIN });
    const event = createUser(db, 'u1');

    assert.equal((await handler(event)).outcome, 'review');
    const afterFirst = db.dump();
    now += 30 * SEC;

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'already_flagged' });
    assert.deepEqual(db.dump(), afterFirst);
  });

  it('assigns exactly once when the same event is delivered twice concurrently', async () => {
    const { db, handler } = setup();
    addIntent(db, 'older', { organizationId: 'org_a', offsetMs: -3 * MIN });
    addIntent(db, 'newer', { organizationId: 'org_a', offsetMs: -1 * MIN });
    const event = createUser(db, 'u1');

    const results = await Promise.all([handler(event), handler(event)]);
    assert.deepEqual(results.map(r => r.outcome).sort(), ['assigned', 'skipped']);
    assert.equal(db.read(`${INTENTS_COLLECTION}/older`).consumed, true);
    assert.equal(db.read(`${INTENTS_COLLECTION}/newer`).consumed, false);
    assert.ok(db.stats.attempts > db.stats.transactions, 'the losing transaction should have been retried');
  });

  it('gives concurrent sign-ups for the same org different intents', async () => {
    const { db, handler } = setup();
    addIntent(db, 'first', { organizationId: 'org_a', offsetMs: -40 * SEC });
    addIntent(db, 'second', { organizationId: 'org_a', offsetMs: -20 * SEC });
    const event1 = createUser(db, 'u1');
    const event2 = createUser(db, 'u2', {}, T + 2 * SEC);

    const results = await Promise.all([handler(event1), handler(event2)]);
    assert.deepEqual(results.map(r => r.outcome), ['assigned', 'assigned']);
    assert.deepEqual(results.map(r => r.intentId).sort(), ['first', 'second']);
    for (const uid of ['u1', 'u2']) {
      const user = db.read(`users/${uid}`);
      assert.equal(user.organization_id, 'org_a');
      const intent = db.read(`${INTENTS_COLLECTION}/${user.inviteJoinIntentId}`);
      assert.equal(intent.consumed, true);
      assert.equal(intent.consumedBy, uid);
    }
  });

  it('sanitizes the role taken from the intent', async () => {
    const cases = [
      { role: 'super_admin', expected: 'member' },
      { role: 'admin', expected: 'admin' },
      { role: 'security', expected: 'security' },
    ];
    for (const { role, expected } of cases) {
      const { db, handler } = setup();
      addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -SEC, role });
      const event = createUser(db, 'u1');
      assert.equal((await handler(event)).role, expected, `intent role ${role}`);
      assert.equal(db.read('users/u1').role, expected);
    }

    const { db, handler } = setup();
    db.seed(`${INTENTS_COLLECTION}/no-role`, {
      code: 'JOIN-ABCD-EFGH',
      inviteCodeId: 'code_no_role',
      organizationId: 'org_a',
      validatedAt: new FakeTimestamp(T - SEC),
      consumed: false,
    }, T - SEC);
    const event = createUser(db, 'u1');
    assert.equal((await handler(event)).role, 'member');
    assert.equal(db.read('users/u1').role, 'member');
  });

  it('leaves a TOS-fallback doc and every intent alone', async () => {
    const { db, logger, handler } = setup();
    addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -4 * MIN });
    const event = createDoc(db, 'returning', TOS_FALLBACK_DOC);
    const before = db.dump();

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'unexpected_shape' });
    assert.equal(db.stats.transactions, 0);
    assert.deepEqual(db.dump(), before); // intent still consumed: false, no review doc
    assert.match(logger.calls.log[0], /users\/returning has no organization but is not an invite sign-up profile/);
    assert.deepEqual(logger.calls.warn, []);
  });

  it('leaves console-made and partial org-less docs alone', async () => {
    const docs = {
      superAdmin: { id: 'superAdmin', name: 'Ops', email: 'ops@example.com', role: 'super_admin' },
      partial: { id: 'partial', name: 'Pat Doe', email: 'partial@example.com', role: '', organization_id: '' },
      roleOnly: { ...buggyProfile('roleOnly'), role: 'admin' },
    };
    for (const [uid, data] of Object.entries(docs)) {
      const { db, handler } = setup();
      addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -30 * SEC });
      const event = createDoc(db, uid, data);

      assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'unexpected_shape' }, uid);
      assert.deepEqual(db.read(`users/${uid}`), data, uid);
      assert.equal(db.read(`${INTENTS_COLLECTION}/intent1`).consumed, false, uid);
      assert.equal(db.read(`${REVIEW_COLLECTION}/${uid}`), undefined, uid);
    }
  });

  it('leaves an in-flight join\'s intent for its owner when a TOS-fallback doc appears', async () => {
    const { db, handler } = setup();
    addIntent(db, 'joinerIntent', { organizationId: 'org_a', offsetMs: -4 * SEC });
    const stranger = createDoc(db, 'stranger', TOS_FALLBACK_DOC, T - SEC);
    assert.equal((await handler(stranger)).reason, 'unexpected_shape');

    const joiner = createUser(db, 'joiner');
    assert.deepEqual(await handler(joiner),
      { outcome: 'assigned', organizationId: 'org_a', role: 'member', intentId: 'joinerIntent' });
    assert.deepEqual(db.read('users/stranger'), TOS_FALLBACK_DOC);
  });

  it('skips a profile that was changed or replaced after it was created', async () => {
    const replacements = {
      'replaced by the TOS fallback': TOS_FALLBACK_DOC,
      'role set by hand': { ...buggyProfile('u1'), role: 'admin' },
    };
    for (const [label, data] of Object.entries(replacements)) {
      const { db, handler } = setup();
      addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -SEC });
      const event = createUser(db, 'u1');
      db.seed('users/u1', data, T); // the event still carries the original sign-up profile
      const before = db.dump();

      assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'unexpected_shape' }, label);
      assert.deepEqual(db.dump(), before, label);
    }
  });

  it('never steers a joiner into another org after their intent was consumed by someone else', async () => {
    let now = T - 500;
    const { db, handler } = setup(() => now);
    addIntent(db, 'victimIntent', { organizationId: 'org_y', offsetMs: -2 * SEC });
    // A stranger's sign-up-shaped doc takes the victim's intent first...
    assert.equal((await handler(createUser(db, 'stranger', {}, T - SEC))).organizationId, 'org_y');
    // ...then codes for org_z are validated, just before and just after the victim's doc.
    addIntent(db, 'zBefore', { organizationId: 'org_z', offsetMs: -500 });
    addIntent(db, 'zAfter', { organizationId: 'org_z', offsetMs: 2 * SEC });
    now = T + 3 * SEC;

    assert.deepEqual(await handler(createUser(db, 'victim')),
      { outcome: 'review', reason: 'ambiguous', candidateOrgIds: ['org_y', 'org_z'] });
    assert.equal(db.read('users/victim').organization_id, '');
    assert.equal(db.read(`${INTENTS_COLLECTION}/zBefore`).consumed, false);
    assert.equal(db.read(`${INTENTS_COLLECTION}/zAfter`).consumed, false);

    // With only the later org_z intent, the victim's window holds just their own (consumed) intent.
    const second = setup();
    addIntent(second.db, 'victimIntent', { organizationId: 'org_y', offsetMs: -2 * SEC, consumed: true, consumedBy: 'stranger' });
    addIntent(second.db, 'zAfter', { organizationId: 'org_z', offsetMs: 2 * SEC });
    assert.deepEqual(await second.handler(createUser(second.db, 'victim')),
      { outcome: 'review', reason: 'no_intent', candidateOrgIds: ['org_y'] });
    assert.equal(second.db.read(`${INTENTS_COLLECTION}/zAfter`).consumed, false);
  });

  it('repairs an account at most once, even if its profile is deleted and re-created', async () => {
    let now = COMMIT;
    const { db, handler } = setup(() => now);
    addIntent(db, 'first', { organizationId: 'org_a', offsetMs: -2 * SEC });
    assert.equal((await handler(createUser(db, 'u1'))).outcome, 'assigned');

    // 20 minutes later the doc is deleted and re-created in sign-up shape while another
    // org's join is in flight.
    const later = T + 20 * MIN;
    db.store.delete('users/u1');
    addIntent(db, 'second', { organizationId: 'org_b', offsetMs: 20 * MIN - 2 * SEC });
    now = later + 3 * SEC;

    assert.deepEqual(await handler(createUser(db, 'u1', {}, later)), { outcome: 'skipped', reason: 'already_repaired' });
    assert.equal(db.read('users/u1').organization_id, '');
    assert.equal(db.read(`${INTENTS_COLLECTION}/second`).consumed, false);
    assert.equal(db.read(`${REVIEW_COLLECTION}/u1`), undefined);
  });

  it('flags ambiguous_role when one org\'s admin and member codes are in the window', async () => {
    const { db, handler } = setup();
    addIntent(db, 'adminCode', { organizationId: 'org_a', offsetMs: -5 * SEC, role: 'admin' });
    addIntent(db, 'memberCode', { organizationId: 'org_a', offsetMs: -3 * SEC, role: 'member' });

    const results = [
      await handler(createUser(db, 'memberHolder', {}, T - SEC)),
      await handler(createUser(db, 'adminHolder')),
    ];
    for (const result of results) {
      assert.deepEqual(result, { outcome: 'review', reason: 'ambiguous_role', candidateOrgIds: ['org_a'] });
    }
    for (const uid of ['memberHolder', 'adminHolder']) {
      assert.equal(db.read(`users/${uid}`).role, '');
      assert.equal(db.read(`${REVIEW_COLLECTION}/${uid}`).reason, 'ambiguous_role');
    }
    assert.equal(db.read(`${INTENTS_COLLECTION}/adminCode`).consumed, false);
    assert.equal(db.read(`${INTENTS_COLLECTION}/memberCode`).consumed, false);
  });

  it('runs only single-field intent queries: consumedBy, then a validatedAt range', async () => {
    const { db, handler } = setup();
    const event = createUser(db, 'u1');
    await handler(event);

    assert.equal(db.executedQueries.length, 2);
    const [consumedQuery, windowQuery] = db.executedQueries;
    assert.equal(consumedQuery.collectionName, INTENTS_COLLECTION);
    assert.deepEqual(consumedQuery.filters, [{ field: 'consumedBy', op: '==', value: 'u1' }]);
    assert.deepEqual(consumedQuery.orders, []);
    assert.equal(consumedQuery.limitCount, 1);

    assert.equal(windowQuery.collectionName, INTENTS_COLLECTION);
    assert.deepEqual(windowQuery.filters, [
      { field: 'validatedAt', op: '>=', value: new FakeTimestamp(T - 5 * MIN) },
      { field: 'validatedAt', op: '<=', value: new FakeTimestamp(T) },
    ]);
    assert.deepEqual(windowQuery.orders, [{ field: 'validatedAt', direction: 'asc' }]);
    assert.equal(windowQuery.limitCount, INTENT_QUERY_LIMIT + 1);
  });

  it('falls back to the event time when the snapshot has no createTime', async () => {
    const { db, handler } = setup();
    const eventMillis = T + 20 * MIN;
    addIntent(db, 'near-event', { organizationId: 'org_a', offsetMs: 20 * MIN - 4 * MIN });
    const event = createUser(db, 'u1');
    event.data = { ...event.data, createTime: undefined };
    event.time = new Date(eventMillis).toISOString();

    const result = await handler(event);
    assert.equal(result.outcome, 'assigned');
    assert.equal(result.intentId, 'near-event');

    const { db: db2, handler: handler2 } = setup();
    const event2 = createUser(db2, 'u2');
    event2.data = { ...event2.data, createTime: undefined };
    event2.time = new Date(eventMillis).toISOString();
    assert.equal((await handler2(event2)).reason, 'no_intent');
    assert.deepEqual(db2.read(`${REVIEW_COLLECTION}/u2`).userCreatedAt, new FakeTimestamp(eventMillis));
  });

  it('flags ambiguous when the window holds more intents than the query limit', async () => {
    const { db, handler } = setup();
    for (let i = 0; i <= INTENT_QUERY_LIMIT; i++) {
      addIntent(db, `intent${String(i).padStart(3, '0')}`, { organizationId: 'org_a', offsetMs: -5 * MIN + i * SEC });
    }
    const event = createUser(db, 'u1');
    assert.deepEqual(await handler(event), { outcome: 'review', reason: 'ambiguous', candidateOrgIds: ['org_a'] });
    assert.equal(db.read('users/u1').organization_id, '');

    const { db: db2, handler: handler2 } = setup();
    for (let i = 0; i < INTENT_QUERY_LIMIT; i++) {
      addIntent(db2, `intent${String(i).padStart(3, '0')}`, { organizationId: 'org_a', offsetMs: -5 * MIN + i * SEC });
    }
    const event2 = createUser(db2, 'u2');
    const result = await handler2(event2);
    assert.equal(result.outcome, 'assigned');
    assert.equal(result.intentId, 'intent000');
  });

  it('skips quietly when the user doc is gone by the time the repair runs', async () => {
    const { db, handler } = setup();
    addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -SEC });
    const event = createUser(db, 'u1');
    db.store.delete('users/u1');

    assert.deepEqual(await handler(event), { outcome: 'skipped', reason: 'user_missing' });
    assert.equal(db.read(`${INTENTS_COLLECTION}/intent1`).consumed, false);
    assert.equal(db.read(`${REVIEW_COLLECTION}/u1`), undefined);
  });

  it('keeps email and name off every review doc', async () => {
    const reviewFields = ['candidateOrgIds', 'createdAt', 'reason', 'uid', 'userCreatedAt'];
    const { db, handler } = setup();
    await handler(createUser(db, 'noIntent'));
    addIntent(db, 'intentA', { organizationId: 'org_a', offsetMs: 2 * MIN });
    addIntent(db, 'intentB', { organizationId: 'org_b', offsetMs: 2 * MIN });
    await handler(createUser(db, 'twoOrgs', {}, T + 3 * MIN));

    for (const uid of ['noIntent', 'twoOrgs']) {
      assert.deepEqual(Object.keys(db.read(`${REVIEW_COLLECTION}/${uid}`)).sort(), reviewFields, uid);
    }
  });

  it('skips an event without document data', async () => {
    const { db, handler } = setup();
    assert.deepEqual(await handler({ id: 'e', time: new Date(T).toISOString(), params: { uid: 'u1' } }),
      { outcome: 'skipped', reason: 'no_data' });
    assert.equal(db.stats.transactions, 0);
  });

  it('logs and rethrows unexpected errors', async () => {
    const { db, logger, handler } = setup();
    addIntent(db, 'intent1', { organizationId: 'org_a', offsetMs: -SEC });
    const event = createUser(db, 'u1');
    db.transactionError = new Error('UNAVAILABLE: simulated outage');

    await assert.rejects(handler(event), /simulated outage/);
    assert.equal(logger.calls.error.length, 1);
    assert.match(logger.calls.error[0], /repairInviteJoin: failed for users\/u1/);
    assert.equal(db.read(`${INTENTS_COLLECTION}/intent1`).consumed, false);
  });
});
