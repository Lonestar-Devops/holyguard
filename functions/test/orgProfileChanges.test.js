// Tests for orgProfileChanges.js: the pure helpers and the real handler from
// createRecordOrgProfileChangeHandler, run against an in-memory Firestore stand-in.
// Run from functions/: npm test

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLECTION,
  TRACKED_FIELDS,
  valuesEqual,
  changedTrackedFields,
  trackedValues,
  isUsableDocId,
  actorOrgId,
  needsReviewFor,
  haversineMiles,
  pinMovedMiles,
  recordIdFor,
  createRecordOrgProfileChangeHandler,
} = require('../orgProfileChanges');

// -------------------------------------------------------------------------------------
// In-memory Firestore stand-in. Implements only what the handler uses:
//   db.collection(name).doc(id), db.collection(name).doc() (auto id)
//   docRef.get(), docRef.create(data), FieldValue.serverTimestamp()
// It fails the way Firestore does: create() rejects with ALREADY_EXISTS (gRPC code 6)
// when the doc exists, the SDK refuses undefined values before sending anything, and
// the server refuses the ids the SDK lets through ('.', '..', '__x__', over 1500 bytes).
// Every get() and create() is recorded, so tests can check what was read and written.
// -------------------------------------------------------------------------------------
class FakeTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  static fromMillis(millis) {
    return new FakeTimestamp(Math.floor(millis / 1000), (millis % 1000) * 1e6);
  }

  isEqual(other) {
    return other instanceof FakeTimestamp &&
      other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
}

class FakeGeoPoint {
  constructor(latitude, longitude) {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  isEqual(other) {
    return other instanceof FakeGeoPoint &&
      other.latitude === this.latitude && other.longitude === this.longitude;
  }
}

const SERVER_TIMESTAMP = Object.freeze({ sentinel: 'serverTimestamp' });
const FakeFieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
};

// Errors from the server carry the numeric gRPC status as `code`, as in the Admin SDK.
function grpcError(code, status, details) {
  const error = new Error(`${code} ${status}: ${details}`);
  error.code = code;
  error.details = details;
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

// What the SDK refuses before sending a write (its validateUserInput).
function assertValidDocument(value, fieldPath = '') {
  const found = fieldPath ? ` (found in field "${fieldPath}")` : '';
  const at = key => (fieldPath ? `${fieldPath}.${key}` : String(key));
  if (value === undefined) {
    throw new Error('Value for argument "data" is not a valid Firestore document. ' +
      `Cannot use "undefined" as a Firestore value${found}. ` +
      'If you want to ignore undefined values, enable `ignoreUndefinedProperties`.');
  }
  if (value === null || value === SERVER_TIMESTAMP || value instanceof FakeTimestamp ||
      value instanceof FakeGeoPoint || ['string', 'number', 'boolean'].includes(typeof value)) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertValidDocument(item, at(i)));
    return;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) => assertValidDocument(item, at(key)));
    return;
  }
  throw new Error('Value for argument "data" is not a valid Firestore document. ' +
    `Couldn't serialize object of type "${(value.constructor && value.constructor.name) || typeof value}"${found}.`);
}

// Ids the SDK passes through but the server refuses.
function assertServerAcceptsId(id) {
  if (id === '.' || id === '..' || /^__.*__$/.test(id) || Buffer.byteLength(id, 'utf8') > 1500) {
    throw grpcError(3, 'INVALID_ARGUMENT', `Document id "${id.slice(0, 40)}" is invalid`);
  }
}

function clone(value) {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.seconds, value.nanoseconds);
  if (value instanceof FakeGeoPoint) return new FakeGeoPoint(value.latitude, value.longitude);
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

function resolveServerTimestamps(value, commitMillis) {
  if (value === SERVER_TIMESTAMP) return FakeTimestamp.fromMillis(commitMillis);
  if (Array.isArray(value)) return value.map(v => resolveServerTimestamps(v, commitMillis));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveServerTimestamps(v, commitMillis)])
    );
  }
  return clone(value);
}

// Yields like a network round trip, so concurrent calls interleave.
const roundTrip = () => new Promise(resolve => setImmediate(resolve));

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    this.db.reads.push(this.path);
    await roundTrip();
    if (this.db.readError) throw this.db.readError;
    assertServerAcceptsId(this.id);
    const stored = this.db.store.get(this.path);
    return {
      id: this.id,
      ref: this,
      exists: stored !== undefined,
      data: () => (stored === undefined ? undefined : clone(stored)),
    };
  }

  // Not async: like the SDK, invalid data throws before a promise is returned.
  create(data) {
    this.db.writes.push(this.path);
    assertValidDocument(data);
    return this.commitCreate(data);
  }

  async commitCreate(data) {
    await roundTrip();
    if (this.db.createError) throw this.db.createError;
    assertServerAcceptsId(this.id);
    if (this.db.store.has(this.path)) {
      throw grpcError(6, 'ALREADY_EXISTS',
        `Document already exists: projects/demo-test/databases/(default)/documents/${this.path}`);
    }
    this.db.store.set(this.path, resolveServerTimestamps(data, this.db.clock()));
    return { writeTime: FakeTimestamp.fromMillis(this.db.clock()) };
  }
}

class FakeCollection {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  // Like the SDK: no argument means an auto id; anything else must be a non-empty string.
  doc(...args) {
    const id = args.length === 0 ? `AutoId${String(++this.db.autoIds).padStart(14, '0')}` : args[0];
    if (typeof id !== 'string' || id === '') {
      throw new Error('Value for argument "documentPath" is not a valid resource path. Path must be a non-empty string.');
    }
    if (id.includes('/')) throw new Error(`FakeFirestore: nested document paths are not supported (${id})`);
    return new FakeDocRef(this.db, this.name, id);
  }
}

const COMMIT_MILLIS = Date.parse('2026-10-15T18:00:02.500Z'); // fake server time for serverTimestamp()

class FakeFirestore {
  constructor({ clock = () => COMMIT_MILLIS } = {}) {
    this.store = new Map(); // 'collection/id' -> data
    this.clock = clock;
    this.autoIds = 0;
    this.reads = [];  // paths passed to get()
    this.writes = []; // paths passed to create()
    this.readError = null;   // set by tests to simulate an unexpected failure
    this.createError = null;
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  // ---- test helpers (not used by the handler) ----

  seed(path, data) {
    assertValidDocument(data);
    this.store.set(path, clone(data));
  }

  read(path) {
    const stored = this.store.get(path);
    return stored === undefined ? undefined : clone(stored);
  }

  idsIn(collectionName) {
    const prefix = `${collectionName}/`;
    return [...this.store.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
  }
}

// -------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------
const ORG_DOC_ID = 'orgDocTest1';
const ORG_ID_FIELD = 'org_1700000000000';
const BEFORE_UPDATE_TIME = new FakeTimestamp(1792000000, 0);
const UPDATE_TIME = new FakeTimestamp(1792087200, 123456789); // 2026-10-15T18:00:00.123456789Z
const RECORD_ID = 'orgDocTest1_1792087200_123456789';
const EVENT_TIME = '2026-10-15T18:00:00.400Z';

// A verified, subscribed org as the app stores it.
const ORG = {
  id: ORG_ID_FIELD,
  name: 'Test Church',
  address: '100 Main St, Springfield, AZ 85001',
  latitude: 33.45,
  longitude: -112.07,
  status: 'verified',
  subscriptionStatus: 'active',
  subscriptionPlan: 'team',
  maxSeats: 15,
};

const ADMIN = {
  id: 'uidAdmin1',
  name: 'Pat Admin',
  email: 'admin@example.org',
  role: 'admin',
  organization_id: ORG_ID_FIELD,
};
const SUPER_ADMIN = {
  id: 'uidSuper1',
  name: 'Sam Owner',
  email: 'owner@example.org',
  role: 'super_admin',
  organization_id: 'org_1600000000000',
};

const ADMIN_ACTOR = {
  authType: 'app_user',
  authId: 'uidAdmin1',
  uid: 'uidAdmin1',
  role: 'admin',
  name: 'Pat Admin',
  email: 'admin@example.org',
  orgId: ORG_ID_FIELD,
};

const SKIPPED = { outcome: 'skipped', reason: 'no_tracked_change' };
const NO_DATA = { outcome: 'skipped', reason: 'no_data' };

function without(data, field) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== field));
}

// An org doc snapshot as firebase-functions builds it (a QueryDocumentSnapshot).
function orgSnapshot(data, updateTime) {
  return {
    id: ORG_DOC_ID,
    exists: true,
    createTime: new FakeTimestamp(1700000000, 0),
    updateTime,
    data: () => clone(data),
  };
}

// The onDocumentUpdatedWithAuthContext event for organizations/orgDocTest1 changing from
// `before` to `after`, made by the app user uidAdmin1 unless overridden.
function updateEvent(before, after, overrides = {}) {
  return {
    id: 'event-1',
    time: EVENT_TIME,
    params: { orgId: ORG_DOC_ID },
    authType: 'app_user',
    authId: 'uidAdmin1',
    data: { before: orgSnapshot(before, BEFORE_UPDATE_TIME), after: orgSnapshot(after, UPDATE_TIME) },
    ...overrides,
  };
}

// ORG updated with `changes`.
function changeEvent(changes, overrides) {
  return updateEvent(ORG, { ...ORG, ...changes }, overrides);
}

function captureLogger() {
  const calls = { log: [], warn: [], error: [] };
  const record = level => (...args) => calls[level].push(args.map(String).join(' '));
  return { calls, log: record('log'), warn: record('warn'), error: record('error') };
}

function setup({ profiles = [ADMIN, SUPER_ADMIN], clock } = {}) {
  const db = new FakeFirestore(clock ? { clock } : undefined);
  for (const profile of profiles) db.seed(`users/${profile.id}`, profile);
  const logger = captureLogger();
  const handler = createRecordOrgProfileChangeHandler({ db, FieldValue: FakeFieldValue, logger });
  return { db, logger, handler };
}

// -------------------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------------------
describe('org profile change helpers', () => {
  it('tracks name, address, latitude and longitude in org_profile_changes', () => {
    assert.equal(COLLECTION, 'org_profile_changes');
    assert.deepEqual(TRACKED_FIELDS, ['name', 'address', 'latitude', 'longitude']);
  });

  it('valuesEqual compares Firestore values by value, both ways round', () => {
    const equal = [
      [undefined, undefined], [null, null], [undefined, null],
      [33.45, 33.45], [0, -0], [NaN, NaN],
      ['Test Church', 'Test Church'], ['', ''],
      [true, true],
      [new FakeTimestamp(1, 2), new FakeTimestamp(1, 2)],
      [new FakeGeoPoint(33.45, -112.07), new FakeGeoPoint(33.45, -112.07)],
      [{ line1: '100 Main St', tags: ['a', 'b'] }, { line1: '100 Main St', tags: ['a', 'b'] }],
      [[1, 'x'], [1, 'x']],
    ];
    const different = [
      [null, ''], [undefined, 0], [null, false], [undefined, NaN],
      [33.45, 33.46], [NaN, 0], [33.45, '33.45'], [1, true], [0, ''],
      ['Test Church', 'test church'], ['Test Church', 'Test Church '],
      ['', false], ['1', true], ['Test Church', ['Test Church']], // equal only under ==
      [true, false], [true, 'true'],
      [new FakeTimestamp(1, 2), new FakeTimestamp(1, 3)],
      [new FakeGeoPoint(33.45, -112.07), new FakeGeoPoint(-112.07, 33.45)],
      [new FakeGeoPoint(33.45, -112.07), { latitude: 33.45, longitude: -112.07 }],
      [{ line1: '100 Main St' }, { line1: '200 Oak Ave' }], [[1, 2], [2, 1]], [[], {}], [{ a: 1 }, 'x'],
    ];
    for (const [a, b] of equal) {
      assert.equal(valuesEqual(a, b), true, `${String(a)} == ${String(b)}`);
      assert.equal(valuesEqual(b, a), true, `${String(b)} == ${String(a)}`);
    }
    for (const [a, b] of different) {
      assert.equal(valuesEqual(a, b), false, `${String(a)} != ${String(b)}`);
      assert.equal(valuesEqual(b, a), false, `${String(b)} != ${String(a)}`);
    }
  });

  it('valuesEqual compares SDK types with isEqual, never their JSON', () => {
    // Like an SDK type whose JSON doesn't show its value (a DocumentReference, say).
    class FakeOpaque {
      constructor(value) {
        Object.defineProperty(this, 'value', { value, enumerable: false });
      }

      isEqual(other) {
        return this.value === other.value;
      }
    }
    assert.equal(JSON.stringify(new FakeOpaque(1)), JSON.stringify(new FakeOpaque(2)));
    assert.equal(valuesEqual(new FakeOpaque(1), new FakeOpaque(1)), true);
    assert.equal(valuesEqual(new FakeOpaque(1), new FakeOpaque(2)), false);
    assert.equal(valuesEqual(new FakeOpaque(2), new FakeOpaque(1)), false);
  });

  it('valuesEqual never hands a value of another type to isEqual', () => {
    // Like the SDK's VectorValue, whose isEqual throws for anything but another vector.
    class FakeVector {
      constructor(values) {
        this._values = values;
      }

      isEqual(other) {
        return this._values.length === other._values.length &&
          this._values.every((value, i) => value === other._values[i]);
      }
    }
    assert.equal(valuesEqual(new FakeVector([1, 2]), new FakeVector([1, 2])), true);
    assert.equal(valuesEqual(new FakeVector([1, 2]), new FakeVector([2, 1])), false);
    for (const other of [{ a: 'x' }, ['x'], true, new FakeTimestamp(1, 2), new FakeGeoPoint(1, 2)]) {
      assert.equal(valuesEqual(new FakeVector([1, 2]), other), false);
      assert.equal(valuesEqual(other, new FakeVector([1, 2])), false);
    }
  });

  it('changedTrackedFields lists changed tracked fields in a fixed order and ignores the rest', () => {
    const after = { maxSeats: 30, longitude: -112.0, status: 'rejected', latitude: 33.5, address: ORG.address, name: 'New' };
    assert.deepEqual(changedTrackedFields(ORG, after), ['name', 'latitude', 'longitude']);
    assert.deepEqual(changedTrackedFields(ORG, { ...ORG, status: 'pending' }), []);
    assert.deepEqual(changedTrackedFields({}, { name: null }), []);
  });

  it('trackedValues picks the four fields, null where absent', () => {
    assert.deepEqual(trackedValues(ORG),
      { name: 'Test Church', address: '100 Main St, Springfield, AZ 85001', latitude: 33.45, longitude: -112.07 });
    assert.deepEqual(trackedValues({ status: 'verified' }), { name: null, address: null, latitude: null, longitude: null });
  });

  it('isUsableDocId follows Firestore\'s document id rules', () => {
    const usable = [
      'uidAdmin1', 'a', '...', '.a', 'a.', '__', '___', '__a', 'a__', '__a__b', 'a__b__',
      'x'.repeat(1500), 'é'.repeat(750),
    ];
    const unusable = [
      '', 'users/uidAdmin1', 'a/b', '/', '.', '..', '__a__', '____', 'x'.repeat(1501), 'é'.repeat(751),
      42, null, undefined, {}, ['uidAdmin1'],
    ];
    for (const id of usable) assert.equal(isUsableDocId(id), true, `usable: ${String(id).slice(0, 20)}`);
    for (const id of unusable) assert.equal(isUsableDocId(id), false, `unusable: ${String(id).slice(0, 20)}`);
  });

  it('actorOrgId reads organization_id when present, else organizationId', () => {
    const cases = [
      [{ organization_id: 'org_a', organizationId: 'org_b' }, 'org_a'],
      [{ organizationId: 'org_b' }, 'org_b'],
      [{ organization_id: '', organizationId: 'org_b' }, null], // present but empty: no fallback
      [{ organization_id: null, organizationId: 'org_b' }, null],
      [{ organization_id: 42 }, null],
      [{ organizationId: '' }, null],
      [{ organization_id: 'removed' }, null], // removed from their org
      [{ organization_id: 'removed', organizationId: 'org_b' }, null],
      [{}, null],
    ];
    for (const [profile, expected] of cases) {
      assert.equal(actorOrgId(profile), expected, JSON.stringify(profile));
    }
  });

  it('needsReviewFor flags everything but super admin changes and pending or rejected orgs', () => {
    assert.equal(needsReviewFor('admin', 'verified'), true);
    assert.equal(needsReviewFor('admin', 'Active'), true);
    assert.equal(needsReviewFor('admin', undefined), true);
    assert.equal(needsReviewFor(null, 'verified'), true);
    assert.equal(needsReviewFor('Super_Admin', 'verified'), true);
    assert.equal(needsReviewFor('admin', 'Pending'), true);
    assert.equal(needsReviewFor('super_admin', 'verified'), false);
    assert.equal(needsReviewFor('admin', 'pending'), false);
    assert.equal(needsReviewFor('admin', 'rejected'), false);
    assert.equal(needsReviewFor(null, 'rejected'), false);
  });

  it('haversineMiles matches known distances', () => {
    const R = 3958.8;
    assert.ok(Math.abs(haversineMiles(0, 0, 1, 0) - (R * Math.PI) / 180) < 1e-9);  // one degree of a meridian
    assert.ok(Math.abs(haversineMiles(0, 0, 0, 90) - (R * Math.PI) / 2) < 1e-9);   // a quarter of the equator
    assert.ok(Math.abs(haversineMiles(0, 179.5, 0, -179.5) - (R * Math.PI) / 180) < 1e-9); // across the date line
    // Phoenix to Denver: both coordinates change, so the latitude scaling counts. The
    // spherical law of cosines gives the same distance.
    assert.ok(Math.abs(haversineMiles(33.4484, -112.074, 39.7392, -104.9903) - 585.5472306842) < 1e-6);
    // Antipodal points, where rounding pushes the haversine term just over 1.
    assert.ok(Math.abs(haversineMiles(-87.5, -180, 87.5, 0) - R * Math.PI) < 1e-6);
    assert.equal(haversineMiles(33.45, -112.07, 33.45, -112.07), 0);
  });

  it('pinMovedMiles rounds to 2 decimals and is null unless a valid pin moved', () => {
    const pin = (latitude, longitude) => ({ latitude, longitude });
    assert.equal(pinMovedMiles(pin(0, 0), pin(1, 0)), 69.09);
    assert.equal(pinMovedMiles(pin(0, 0), pin(0, 90)), 6218.47);
    assert.equal(pinMovedMiles(pin(-87.5, -180), pin(87.5, 0)), 12436.94);
    assert.equal(pinMovedMiles(pin(33.45, -112.07), pin(33.4501, -112.07)), 0.01);
    assert.equal(pinMovedMiles(pin(33.45, -112.07), pin(33.450001, -112.07)), 0);
    assert.equal(pinMovedMiles(pin(33.45, -112.07), pin(33.5, -112.0)), 5.31);
    assert.equal(pinMovedMiles(pin(33.45, -112.07), pin(39.74, -104.99)), 585.36);
    assert.equal(pinMovedMiles(pin(90, 180), pin(-90, -180)), 12436.94);

    // Unchanged pin, even when other fields changed.
    assert.equal(pinMovedMiles(ORG, { ...ORG, name: 'New' }), null);
    assert.equal(pinMovedMiles({}, {}), null);

    const invalid = [NaN, Infinity, -Infinity, null, undefined, '33.45', 90.0001, -90.0001, new FakeGeoPoint(1, 2)];
    for (const bad of invalid) {
      assert.equal(pinMovedMiles(pin(bad, -112.07), pin(33.45, -112.07)), null, `old latitude ${String(bad)}`);
      assert.equal(pinMovedMiles(pin(33.45, -112.07), pin(bad, -112.07)), null, `new latitude ${String(bad)}`);
    }
    for (const bad of [NaN, null, '-112.07', 180.5, -181]) {
      assert.equal(pinMovedMiles(pin(33.45, bad), pin(33.46, -112.07)), null, `old longitude ${String(bad)}`);
      assert.equal(pinMovedMiles(pin(33.45, -112.07), pin(33.46, bad)), null, `new longitude ${String(bad)}`);
    }
  });

  it('recordIdFor derives the id from the update time, or gives null', () => {
    assert.equal(recordIdFor(ORG_DOC_ID, UPDATE_TIME), RECORD_ID);
    assert.equal(recordIdFor(ORG_DOC_ID, new FakeTimestamp(1792087200, 0)), 'orgDocTest1_1792087200_0');
    const notTimestamps = [
      null, undefined, new Date(0),
      { seconds: '1792087200', nanoseconds: 0 }, { seconds: 1.5, nanoseconds: 0 },
      { seconds: 1792087200 }, { seconds: 1792087200, nanoseconds: 0.5 },
    ];
    for (const bad of notTimestamps) {
      assert.equal(recordIdFor(ORG_DOC_ID, bad), null, JSON.stringify(bad));
    }
    // Too long for a document id.
    assert.equal(recordIdFor('x'.repeat(1490), UPDATE_TIME), null);
  });
});

// -------------------------------------------------------------------------------------
// recordOrgProfileChange handler (real handler, fake Firestore)
// -------------------------------------------------------------------------------------
describe('recordOrgProfileChange handler', () => {
  it('writes the full record for an admin\'s name and address change and flags it', async () => {
    const { db, logger, handler } = setup();
    const event = changeEvent({ name: 'Test Church North', address: '200 Oak Ave, Springfield, AZ 85002' });

    assert.deepEqual(await handler(event), { outcome: 'recorded', id: RECORD_ID, needsReview: true });
    assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`), {
      orgDocId: ORG_DOC_ID,
      orgIdField: ORG_ID_FIELD,
      orgName: 'Test Church North',
      orgStatus: 'verified',
      changedFields: ['name', 'address'],
      before: { name: 'Test Church', address: '100 Main St, Springfield, AZ 85001', latitude: 33.45, longitude: -112.07 },
      after: { name: 'Test Church North', address: '200 Oak Ave, Springfield, AZ 85002', latitude: 33.45, longitude: -112.07 },
      pinMovedMiles: null,
      changedBy: ADMIN_ACTOR,
      changedAt: UPDATE_TIME,
      eventId: 'event-1',
      eventTime: EVENT_TIME,
      recordedAt: FakeTimestamp.fromMillis(COMMIT_MILLIS),
      needsReview: true,
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    });
    // One profile read, one write, and nothing written to the org itself.
    assert.deepEqual(db.reads, ['users/uidAdmin1']);
    assert.deepEqual(db.writes, [`${COLLECTION}/${RECORD_ID}`]);
    assert.deepEqual(db.idsIn('organizations'), []);
    assert.deepEqual(logger.calls, {
      log: [],
      warn: ['[recordOrgProfileChange] needs review: org orgDocTest1 fields name,address by uidAdmin1 (orgDocTest1_1792087200_123456789)'],
      error: [],
    });
  });

  it('writes the full record for a super admin\'s pin move without flagging it', async () => {
    const { db, logger, handler } = setup();
    const event = changeEvent({ latitude: 34.45 }, { authId: 'uidSuper1' });

    assert.deepEqual(await handler(event), { outcome: 'recorded', id: RECORD_ID, needsReview: false });
    assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`), {
      orgDocId: ORG_DOC_ID,
      orgIdField: ORG_ID_FIELD,
      orgName: 'Test Church',
      orgStatus: 'verified',
      changedFields: ['latitude'],
      before: { name: 'Test Church', address: '100 Main St, Springfield, AZ 85001', latitude: 33.45, longitude: -112.07 },
      after: { name: 'Test Church', address: '100 Main St, Springfield, AZ 85001', latitude: 34.45, longitude: -112.07 },
      pinMovedMiles: 69.09,
      changedBy: {
        authType: 'app_user',
        authId: 'uidSuper1',
        uid: 'uidSuper1',
        role: 'super_admin',
        name: 'Sam Owner',
        email: 'owner@example.org',
        orgId: 'org_1600000000000',
      },
      changedAt: UPDATE_TIME,
      eventId: 'event-1',
      eventTime: EVENT_TIME,
      recordedAt: FakeTimestamp.fromMillis(COMMIT_MILLIS),
      needsReview: false,
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    });
    assert.deepEqual(logger.calls, {
      log: ['[recordOrgProfileChange] recorded: org orgDocTest1 fields latitude by uidSuper1 (orgDocTest1_1792087200_123456789)'],
      warn: [],
      error: [],
    });
  });

  it('records a change to each tracked field on its own', async () => {
    const changes = {
      name: 'Test Church North',
      address: '200 Oak Ave, Springfield, AZ 85002',
      latitude: 33.5,
      longitude: -112.0,
    };
    for (const [field, value] of Object.entries(changes)) {
      const { db, logger, handler } = setup();
      assert.deepEqual(await handler(changeEvent({ [field]: value })),
        { outcome: 'recorded', id: RECORD_ID, needsReview: true }, field);
      const record = db.read(`${COLLECTION}/${RECORD_ID}`);
      assert.deepEqual(record.changedFields, [field], field);
      assert.deepEqual(record.before, trackedValues(ORG), field);
      assert.deepEqual(record.after, { ...trackedValues(ORG), [field]: value }, field);
      assert.equal(record.pinMovedMiles === null, field === 'name' || field === 'address', field);
      assert.deepEqual(logger.calls.warn,
        [`[recordOrgProfileChange] needs review: org orgDocTest1 fields ${field} by uidAdmin1 (${RECORD_ID})`], field);
    }
  });

  it('records several fields changed at once in one record, in a fixed order', async () => {
    const { db, logger, handler } = setup();
    // Keys deliberately in another order than TRACKED_FIELDS.
    const after = {
      longitude: -112.0,
      latitude: 33.5,
      address: '200 Oak Ave, Springfield, AZ 85002',
      name: 'Test Church North',
      ...without(without(without(without(ORG, 'name'), 'address'), 'latitude'), 'longitude'),
    };
    assert.equal((await handler(updateEvent(ORG, after))).outcome, 'recorded');
    assert.deepEqual(db.idsIn(COLLECTION), [RECORD_ID]);
    const record = db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(record.changedFields, ['name', 'address', 'latitude', 'longitude']);
    assert.equal(record.pinMovedMiles, 5.31);
    assert.match(logger.calls.warn[0], / fields name,address,latitude,longitude by /);
  });

  it('skips updates that change no tracked field without reading or writing anything', async () => {
    const untracked = {
      'review approval': { status: 'verified', verificationCompletedAt: new FakeTimestamp(1792087200, 0) },
      rejection: { status: 'rejected', rejectionReason: 'Did not meet verification requirements' },
      subscription: { subscriptionStatus: 'expired', subscriptionUpdatedAt: '2026-10-15T18:00:00.000Z' },
      'plan change': { subscriptionPlan: 'enterprise', maxSeats: 30, appleProductId: '003' },
      grandfathering: { grandfathered: true },
      'form saved unchanged': {},
    };
    for (const [label, change] of Object.entries(untracked)) {
      const { db, logger, handler } = setup();
      assert.deepEqual(await handler(changeEvent(change)), SKIPPED, label);
      assert.deepEqual(db.reads, [], label);
      assert.deepEqual(db.writes, [], label);
      assert.deepEqual(logger.calls, { log: [], warn: [], error: [] }, label);
    }
  });

  it('treats null and a missing field as the same value', async () => {
    const noAddress = without(ORG, 'address');
    const { db, handler } = setup();
    assert.deepEqual(await handler(updateEvent({ ...ORG, address: null }, noAddress)), SKIPPED);
    assert.deepEqual(await handler(updateEvent(noAddress, { ...ORG, address: null })), SKIPPED);
    assert.deepEqual(db.reads, []);
    assert.deepEqual(db.writes, []);

    // Missing before, set after: a change, with the missing value recorded as null.
    assert.equal((await handler(updateEvent(noAddress, ORG))).outcome, 'recorded');
    const record = db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(record.changedFields, ['address']);
    assert.equal(record.before.address, null);
    assert.equal(record.after.address, ORG.address);
  });

  it('treats NaN as equal to NaN', async () => {
    const nanPin = { ...ORG, latitude: NaN };
    const { db, handler } = setup();
    assert.deepEqual(await handler(updateEvent(nanPin, { ...nanPin, maxSeats: 30 })), SKIPPED);
    assert.deepEqual(db.writes, []);

    // NaN to a number is a change; how far the pin moved is unknown.
    assert.equal((await handler(updateEvent(nanPin, ORG))).outcome, 'recorded');
    const record = db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(record.changedFields, ['latitude']);
    assert.ok(Number.isNaN(record.before.latitude));
    assert.equal(record.after.latitude, 33.45);
    assert.equal(record.pinMovedMiles, null);
  });

  it('compares numbers by value', async () => {
    const { db, handler } = setup();
    assert.deepEqual(await handler(changeEvent({ latitude: 33.45, longitude: -112.07 })), SKIPPED);
    assert.deepEqual(await handler(updateEvent({ ...ORG, latitude: 0 }, { ...ORG, latitude: -0 })), SKIPPED);

    // The smallest move is still a change.
    assert.equal((await handler(changeEvent({ latitude: 33.4501 }))).outcome, 'recorded');
    const record = db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(record.changedFields, ['latitude']);
    assert.equal(record.pinMovedMiles, 0.01);

    // A number and the same digits as a string are different values.
    const second = setup();
    assert.equal((await second.handler(changeEvent({ longitude: '-112.07' }))).outcome, 'recorded');
    const stringRecord = second.db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(stringRecord.changedFields, ['longitude']);
    assert.equal(stringRecord.after.longitude, '-112.07');
    assert.equal(stringRecord.pinMovedMiles, null);
  });

  it('compares GeoPoints, Timestamps and maps by value, not by identity', async () => {
    // Shapes the app never writes, but a console edit could.
    const odd = {
      ...ORG,
      address: { line1: '100 Main St', city: 'Springfield' },
      latitude: new FakeGeoPoint(33.45, -112.07),
      name: new FakeTimestamp(1, 2),
    };
    const { db, handler } = setup();
    assert.deepEqual(await handler(updateEvent(odd, clone(odd))), SKIPPED);
    assert.deepEqual(db.writes, []);

    const moved = { ...clone(odd), latitude: new FakeGeoPoint(34.45, -112.07), address: { line1: '200 Oak Ave', city: 'Springfield' } };
    assert.equal((await handler(updateEvent(odd, moved))).outcome, 'recorded');
    const record = db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(record.changedFields, ['address', 'latitude']);
    assert.deepEqual(record.before.latitude, new FakeGeoPoint(33.45, -112.07));
    assert.deepEqual(record.after.address, { line1: '200 Oak Ave', city: 'Springfield' });
    assert.equal(record.pinMovedMiles, null); // a GeoPoint is not a valid latitude
    assert.deepEqual(record.orgName, new FakeTimestamp(1, 2));
  });

  it('flags changes to orgs whose status is missing, Active or verified', async () => {
    for (const status of [undefined, 'Active', 'verified']) {
      const base = status === undefined ? without(ORG, 'status') : { ...ORG, status };
      const { db, handler } = setup();
      const result = await handler(updateEvent(base, { ...base, name: 'Test Church North' }));
      assert.deepEqual(result, { outcome: 'recorded', id: RECORD_ID, needsReview: true }, String(status));
      const record = db.read(`${COLLECTION}/${RECORD_ID}`);
      assert.equal(record.needsReview, true, String(status));
      assert.equal(record.orgStatus, status ?? null, String(status));
    }
  });

  it('does not flag changes to pending or rejected orgs, but still records them', async () => {
    for (const status of ['pending', 'rejected']) {
      const base = { ...ORG, status };
      const { db, logger, handler } = setup();
      assert.deepEqual(await handler(updateEvent(base, { ...base, address: '200 Oak Ave' })),
        { outcome: 'recorded', id: RECORD_ID, needsReview: false }, status);
      const record = db.read(`${COLLECTION}/${RECORD_ID}`);
      assert.equal(record.needsReview, false, status);
      assert.equal(record.orgStatus, status, status);
      assert.deepEqual(record.changedBy, ADMIN_ACTOR, status);
      assert.deepEqual(logger.calls.log,
        [`[recordOrgProfileChange] recorded: org orgDocTest1 fields address by uidAdmin1 (${RECORD_ID})`], status);
      assert.deepEqual(logger.calls.warn, [], status);
    }
  });

  it('never flags a super admin\'s change, whatever the org\'s status', async () => {
    for (const status of ['verified', 'Active', 'pending']) {
      const base = { ...ORG, status };
      const { db, handler } = setup();
      const result = await handler(updateEvent(base, { ...base, name: 'Renamed' }, { authId: 'uidSuper1' }));
      assert.equal(result.needsReview, false, status);
      assert.equal(db.read(`${COLLECTION}/${RECORD_ID}`).changedBy.role, 'super_admin', status);
    }
  });

  it('flags by the org\'s status after the change, and records its status and id field from then', async () => {
    // A console or Admin SDK write can change the status or the id field together with a
    // tracked field (an admin can't: the org update rule pins both).
    const script = { authType: 'service_account', authId: 'scripts@demo-test.iam.gserviceaccount.com' };
    const cases = [
      // [status before, status after, flagged]
      ['pending', 'verified', true],
      ['rejected', 'Active', true],
      ['verified', 'pending', false],
      ['verified', 'rejected', false],
    ];
    for (const [statusBefore, statusAfter, flagged] of cases) {
      const label = `${statusBefore} -> ${statusAfter}`;
      const { db, handler } = setup();
      const before = { ...ORG, id: 'org_1650000000000', status: statusBefore };
      const after = { ...ORG, id: ORG_ID_FIELD, status: statusAfter, name: 'Test Church North' };
      assert.deepEqual(await handler(updateEvent(before, after, script)),
        { outcome: 'recorded', id: RECORD_ID, needsReview: flagged }, label);
      const record = db.read(`${COLLECTION}/${RECORD_ID}`);
      assert.equal(record.needsReview, flagged, label);
      assert.equal(record.orgStatus, statusAfter, label);
      assert.equal(record.orgIdField, ORG_ID_FIELD, label);
    }
  });

  it('never reads a profile for an authId that is not a usable document id', async () => {
    const unusable = {
      'a path': 'users/uidAdmin1',
      'a slash': 'uid/Admin1',
      'a single period': '.',
      'two periods': '..',
      'a reserved id': '__uidAdmin1__',
      'an empty string': '',
      'over 1500 bytes': 'é'.repeat(751),
      'a number': 42,
      'an object': { uid: 'uidAdmin1' },
      null: null,
    };
    for (const [label, authId] of Object.entries(unusable)) {
      const { db, logger, handler } = setup();
      const result = await handler(changeEvent({ name: 'Test Church North' }, { authId }));
      assert.deepEqual(result, { outcome: 'recorded', id: RECORD_ID, needsReview: true }, label);
      assert.deepEqual(db.reads, [], label);
      assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`).changedBy, {
        authType: 'app_user', authId, uid: null, role: null, name: null, email: null, orgId: null,
      }, label);
      assert.deepEqual(logger.calls.warn,
        [`[recordOrgProfileChange] needs review: org orgDocTest1 fields name by app_user (${RECORD_ID})`], label);
    }

    // No authId at all (and an explicit undefined) is recorded as null.
    for (const event of [without(changeEvent({ name: 'X' }), 'authId'), changeEvent({ name: 'X' }, { authId: undefined })]) {
      const { db, handler } = setup();
      assert.equal((await handler(event)).needsReview, true);
      assert.deepEqual(db.reads, []);
      assert.equal(db.read(`${COLLECTION}/${RECORD_ID}`).changedBy.authId, null);
    }
  });

  it('leaves the actor unresolved when authId names no profile', async () => {
    const { db, logger, handler } = setup();
    const event = changeEvent({ name: 'Test Church North' },
      { authType: 'service_account', authId: 'firebase-adminsdk-test@demo-test.iam.gserviceaccount.com' });

    assert.deepEqual(await handler(event), { outcome: 'recorded', id: RECORD_ID, needsReview: true });
    assert.deepEqual(db.reads, ['users/firebase-adminsdk-test@demo-test.iam.gserviceaccount.com']);
    assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`).changedBy, {
      authType: 'service_account',
      authId: 'firebase-adminsdk-test@demo-test.iam.gserviceaccount.com',
      uid: null, role: null, name: null, email: null, orgId: null,
    });
    // The log names the auth type only, never the authId.
    assert.deepEqual(logger.calls.warn,
      [`[recordOrgProfileChange] needs review: org orgDocTest1 fields name by service_account (${RECORD_ID})`]);
  });

  it('logs "unknown" for a change without any auth context', async () => {
    const { db, logger, handler } = setup();
    const event = without(without(changeEvent({ name: 'Test Church North' }), 'authType'), 'authId');
    assert.equal((await handler(event)).needsReview, true);
    assert.deepEqual(db.reads, []);
    const changedBy = db.read(`${COLLECTION}/${RECORD_ID}`).changedBy;
    assert.equal(changedBy.authType, null);
    assert.equal(changedBy.authId, null);
    assert.match(logger.calls.warn[0], / by unknown \(/);
  });

  it('takes the actor\'s org from organization_id when present, else organizationId', async () => {
    const cases = [
      [{ organization_id: 'org_a', organizationId: 'org_b' }, 'org_a'],
      [{ organizationId: 'org_b' }, 'org_b'],
      [{ organization_id: '', organizationId: 'org_b' }, null],
      [{}, null],
    ];
    for (const [orgFields, expected] of cases) {
      const profile = { ...without(ADMIN, 'organization_id'), ...orgFields };
      const { db, handler } = setup({ profiles: [profile] });
      await handler(changeEvent({ name: 'Test Church North' }));
      const changedBy = db.read(`${COLLECTION}/${RECORD_ID}`).changedBy;
      assert.equal(changedBy.orgId, expected, JSON.stringify(orgFields));
      assert.equal(changedBy.uid, 'uidAdmin1', JSON.stringify(orgFields));
    }
  });

  it('records null for a profile\'s role, name or email that is missing or not a string', async () => {
    const profiles = [
      { id: 'uidAdmin1', role: 7, name: ['Pat'] },
      { id: 'uidAdmin1', email: { address: 'admin@example.org' } },
    ];
    for (const profile of profiles) {
      const { db, handler } = setup({ profiles: [profile] });
      assert.equal((await handler(changeEvent({ name: 'Test Church North' }))).needsReview, true);
      assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`).changedBy, {
        authType: 'app_user', authId: 'uidAdmin1', uid: 'uidAdmin1', role: null, name: null, email: null, orgId: null,
      }, JSON.stringify(profile));
    }
  });

  it('keeps a profile\'s empty role, name or email as an empty string', async () => {
    // An invite join the repair hasn't fixed yet leaves role '' (and organization_id '').
    const profile = { id: 'uidAdmin1', role: '', name: '', email: '', organization_id: '' };
    const { db, handler } = setup({ profiles: [profile] });
    assert.equal((await handler(changeEvent({ name: 'Test Church North' }))).needsReview, true);
    assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`).changedBy, {
      authType: 'app_user', authId: 'uidAdmin1', uid: 'uidAdmin1', role: '', name: '', email: '', orgId: null,
    });
  });

  it('records null for an org without an id field, name or status, and for an event without id or time', async () => {
    const bare = { latitude: 33.45, longitude: -112.07 };
    const { db, handler } = setup();
    const event = without(without(updateEvent(bare, { ...bare, longitude: -112.0 }), 'id'), 'time');
    assert.equal((await handler(event)).outcome, 'recorded');
    const record = db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.equal(record.orgIdField, null);
    assert.equal(record.orgName, null);
    assert.equal(record.orgStatus, null);
    assert.equal(record.eventId, null);
    assert.equal(record.eventTime, null);
    assert.deepEqual(record.before, { name: null, address: null, latitude: 33.45, longitude: -112.07 });

    for (const id of ['', 7]) {
      const second = setup();
      const base = { ...ORG, id };
      await second.handler(updateEvent(base, { ...base, name: 'Test Church North' }));
      assert.equal(second.db.read(`${COLLECTION}/${RECORD_ID}`).orgIdField, null, String(id));
    }
  });

  it('records an emptied name and a zero coordinate as they are, not as null', async () => {
    // 0 is a coordinate like any other (the equator, the prime meridian).
    const pinned = setup();
    assert.deepEqual(await pinned.handler(changeEvent({ latitude: 0, longitude: 0 })),
      { outcome: 'recorded', id: RECORD_ID, needsReview: true });
    const pinRecord = pinned.db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(pinRecord.changedFields, ['latitude', 'longitude']);
    assert.deepEqual(pinRecord.after, { ...trackedValues(ORG), latitude: 0, longitude: 0 });
    assert.equal(pinRecord.pinMovedMiles, 7480.86);

    // The admin rule needs a name, but a super admin can clear it.
    const renamed = setup();
    assert.equal((await renamed.handler(changeEvent({ name: '' }, { authId: 'uidSuper1' }))).outcome, 'recorded');
    const nameRecord = renamed.db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(nameRecord.changedFields, ['name']);
    assert.equal(nameRecord.orgName, '');
    assert.equal(nameRecord.after.name, '');
  });

  it('records a redelivered event once', async () => {
    let now = COMMIT_MILLIS;
    const { db, logger, handler } = setup({ clock: () => now });
    const event = changeEvent({ name: 'Test Church North' });

    assert.equal((await handler(event)).outcome, 'recorded');
    const first = db.read(`${COLLECTION}/${RECORD_ID}`);
    now += 30 * 1000;

    assert.deepEqual(await handler(event), { outcome: 'duplicate', id: RECORD_ID });
    assert.deepEqual(db.idsIn(COLLECTION), [RECORD_ID]);
    assert.deepEqual(db.read(`${COLLECTION}/${RECORD_ID}`), first);
    // Only the first delivery logs.
    assert.equal(logger.calls.warn.length, 1);
    assert.deepEqual(logger.calls.log, []);
    assert.deepEqual(logger.calls.error, []);
  });

  it('records the same event delivered twice at once only once', async () => {
    const { db, handler } = setup();
    const event = changeEvent({ name: 'Test Church North' });
    const results = await Promise.all([handler(event), handler(event)]);
    assert.deepEqual(results.map(r => r.outcome).sort(), ['duplicate', 'recorded']);
    assert.deepEqual(db.idsIn(COLLECTION), [RECORD_ID]);
  });

  it('keeps one record per change of the same org', async () => {
    const { db, handler } = setup();
    await handler(changeEvent({ name: 'Test Church North' }));
    const later = changeEvent({ name: 'Test Church South' });
    later.data.after = orgSnapshot({ ...ORG, name: 'Test Church South' }, new FakeTimestamp(1792087260, 0));
    assert.deepEqual(await handler(later),
      { outcome: 'recorded', id: 'orgDocTest1_1792087260_0', needsReview: true });
    assert.deepEqual(db.idsIn(COLLECTION).sort(), [RECORD_ID, 'orgDocTest1_1792087260_0']);
  });

  it('lets any other write error propagate so the event is retried', async () => {
    const failures = [
      grpcError(14, 'UNAVAILABLE', 'simulated outage'),
      grpcError(10, 'ABORTED', 'simulated contention'),
      new Error('simulated failure without a code'),
    ];
    for (const failure of failures) {
      const { db, logger, handler } = setup();
      const event = changeEvent({ name: 'Test Church North' });
      db.createError = failure;

      await assert.rejects(handler(event), error => error === failure);
      assert.deepEqual(db.idsIn(COLLECTION), [], failure.message);
      assert.equal(logger.calls.error.length, 1, failure.message);
      assert.match(logger.calls.error[0], /^\[recordOrgProfileChange\] failed for org orgDocTest1: /);
      assert.deepEqual(logger.calls.warn, [], failure.message);

      // The redelivery records it.
      db.createError = null;
      assert.deepEqual(await handler(event), { outcome: 'recorded', id: RECORD_ID, needsReview: true });
    }
  });

  it('lets a failed profile read propagate so the event is retried', async () => {
    const { db, logger, handler } = setup();
    db.readError = grpcError(14, 'UNAVAILABLE', 'simulated outage');
    await assert.rejects(handler(changeEvent({ name: 'Test Church North' })), /UNAVAILABLE/);
    assert.deepEqual(db.writes, []);
    assert.equal(logger.calls.error.length, 1);
  });

  it('uses an auto id when the snapshot has no update time, so the change is still recorded', async () => {
    for (const updateTime of [undefined, null, { seconds: '1792087200', nanoseconds: 0 }, { seconds: 1792087200 }]) {
      const { db, logger, handler } = setup();
      const event = changeEvent({ name: 'Test Church North' });
      event.data.after = orgSnapshot({ ...ORG, name: 'Test Church North' }, updateTime);

      const result = await handler(event);
      assert.equal(result.outcome, 'recorded', String(updateTime));
      assert.equal(result.id, 'AutoId00000000000001', String(updateTime));
      assert.deepEqual(db.idsIn(COLLECTION), [result.id], String(updateTime));
      const record = db.read(`${COLLECTION}/${result.id}`);
      assert.equal(record.changedAt, null, String(updateTime));
      assert.deepEqual(record.changedFields, ['name'], String(updateTime));
      assert.match(logger.calls.warn[0], /\(AutoId00000000000001\)$/);
    }
  });

  it('falls back to the snapshot id when the event has no params', async () => {
    const { db, handler } = setup();
    const event = without(changeEvent({ name: 'Test Church North' }), 'params');
    assert.equal((await handler(event)).id, RECORD_ID);
    assert.equal(db.read(`${COLLECTION}/${RECORD_ID}`).orgDocId, ORG_DOC_ID);
  });

  it('takes the org doc id from the event params before the snapshot id', async () => {
    const { db, handler } = setup();
    const event = changeEvent({ name: 'Test Church North' });
    event.data.after = { ...event.data.after, id: 'snapshotDocId' };
    assert.equal((await handler(event)).id, RECORD_ID);
    assert.deepEqual(db.idsIn(COLLECTION), [RECORD_ID]);
    assert.equal(db.read(`${COLLECTION}/${RECORD_ID}`).orgDocId, ORG_DOC_ID);
  });

  it('skips an event without document data, reading and writing nothing', async () => {
    const events = {
      'no event': undefined,
      'no data': { id: 'e', time: EVENT_TIME, params: { orgId: ORG_DOC_ID } },
      'no before': { id: 'e', params: { orgId: ORG_DOC_ID }, data: { after: orgSnapshot(ORG, UPDATE_TIME) } },
      'no after': { id: 'e', params: { orgId: ORG_DOC_ID }, data: { before: orgSnapshot(ORG, UPDATE_TIME) } },
      'snapshots without data()': { id: 'e', params: { orgId: ORG_DOC_ID }, data: { before: {}, after: {} } },
      'no org doc id': {
        id: 'e',
        data: {
          before: without(orgSnapshot(ORG, BEFORE_UPDATE_TIME), 'id'),
          after: without(orgSnapshot({ ...ORG, name: 'Test Church North' }, UPDATE_TIME), 'id'),
        },
      },
      'an empty org doc id': {
        id: 'e',
        params: { orgId: '' },
        data: {
          before: { ...orgSnapshot(ORG, BEFORE_UPDATE_TIME), id: '' },
          after: { ...orgSnapshot({ ...ORG, name: 'Test Church North' }, UPDATE_TIME), id: '' },
        },
      },
    };
    for (const [label, event] of Object.entries(events)) {
      const { db, logger, handler } = setup();
      assert.deepEqual(await handler(event), NO_DATA, label);
      assert.deepEqual(db.reads, [], label);
      assert.deepEqual(db.writes, [], label);
      assert.deepEqual(logger.calls.warn, ['[recordOrgProfileChange] event has no document data, skipping'], label);
    }
  });

  it('treats a version without data as an empty document', async () => {
    // firebase-functions gives a snapshot whose data() is undefined when the event lacks
    // that version. Update events carry both; if one didn't, the change would still be
    // recorded instead of failing on every retry.
    const missing = { id: ORG_DOC_ID, exists: false, data: () => undefined };
    const nulls = { name: null, address: null, latitude: null, longitude: null };

    const first = setup();
    const noBefore = changeEvent({});
    noBefore.data.before = missing;
    assert.deepEqual(await first.handler(noBefore), { outcome: 'recorded', id: RECORD_ID, needsReview: true });
    const fromNothing = first.db.read(`${COLLECTION}/${RECORD_ID}`);
    assert.deepEqual(fromNothing.changedFields, ['name', 'address', 'latitude', 'longitude']);
    assert.deepEqual(fromNothing.before, nulls);
    assert.deepEqual(fromNothing.after, trackedValues(ORG));
    assert.equal(fromNothing.pinMovedMiles, null);

    const second = setup();
    const noAfter = changeEvent({});
    noAfter.data.after = missing;
    const result = await second.handler(noAfter);
    assert.deepEqual(result, { outcome: 'recorded', id: 'AutoId00000000000001', needsReview: true });
    const toNothing = second.db.read(`${COLLECTION}/${result.id}`);
    assert.deepEqual(toNothing.changedFields, ['name', 'address', 'latitude', 'longitude']);
    assert.deepEqual(toNothing.before, trackedValues(ORG));
    assert.deepEqual(toNothing.after, nulls);
    assert.equal(toNothing.orgIdField, null);
    assert.equal(toNothing.orgName, null);
    assert.equal(toNothing.orgStatus, null);
    assert.equal(toNothing.changedAt, null);
  });

  it('keeps names, emails, addresses and values out of the log', async () => {
    const { logger, handler } = setup();
    await handler(changeEvent({ name: 'Test Church North', address: '200 Oak Ave', latitude: 34.45 }));
    const logged = [...logger.calls.log, ...logger.calls.warn, ...logger.calls.error].join('\n');
    for (const secret of ['Test Church', 'Pat Admin', 'admin@example.org', 'Main St', 'Oak Ave', '33.45', '34.45', '69.09']) {
      assert.equal(logged.includes(secret), false, secret);
    }
  });
});
