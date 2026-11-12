/**
 * Grandfather the existing organizations, so they never meet the paywall.
 *
 * 1.2.8 drops the in-app redemption codes, so the orgs that signed up before it are
 * grandfathered here instead. Each org that isn't grandfathered yet gets:
 *   grandfathered: true, subscriptionStatus 'active', subscriptionPlan 'grandfathered',
 *   no seat cap (maxSeats removed), a grandfatherNote, and subscriptionUpdatedAt = now.
 * Verification status is left alone: a pending org still waits for review.
 *
 * Left untouched, and listed with the reason:
 *   - orgs already grandfathered (sponsored orgs keep their seat cap)
 *   - orgs with a real (non-sandbox) App Store subscription, which Apple may still bill
 *     (--include-paying grandfathers them anyway)
 *   - the app's no-org placeholders ('default-org', 'removed') and any org named in --skip
 *     (doc ID or id field)
 *
 * The dry run prints the list and a code for it; --apply needs that code (--expect) and
 * stops if the list has changed since. Every write goes in one atomic commit, each guarded
 * by the update time this run read, so if any org changes in between, nothing is written.
 * Before committing it prints each org's previous values, for undoing by hand.
 *
 * Usage (Node 18+, no npm install needed). Dry run by default:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/grandfather-existing-orgs.js [--skip <id>[,<id>...]] [--include-paying] [--apply --expect <code>]
 */
const crypto = require('crypto');

const PROJECT = 'holyguard-app';
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST; // host:port, for testing against a local emulator
const BASE = `${EMULATOR ? `http://${EMULATOR}` : 'https://firestore.googleapis.com'}/v1/projects/${PROJECT}/databases/(default)/documents`;
const TOKEN = EMULATOR ? 'owner' : (process.env.GCLOUD_ACCESS_TOKEN || '').trim();
const NOTE = 'Existing org, grandfathered when 1.2.8 retired the redemption codes';
const PLACEHOLDER_IDS = new Set(['default-org', 'removed']); // what the app uses for "no org"
const TOUCHED = ['grandfathered', 'subscriptionStatus', 'subscriptionPlan', 'maxSeats', 'grandfatherNote', 'subscriptionUpdatedAt'];
const USAGE = 'Usage: node scripts/grandfather-existing-orgs.js [--skip <id>[,<id>...]] [--include-paying] [--apply --expect <code>]';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// A mistyped flag must not quietly drop a --skip, so only these are accepted.
const argv = process.argv.slice(2);
let APPLY = false;
let INCLUDE_PAYING = false;
let EXPECT = null;
const SKIP = new Set();
for (let i = 0; i < argv.length; i++) {
  const next = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  if (argv[i] === '--apply') APPLY = true;
  else if (argv[i] === '--include-paying') INCLUDE_PAYING = true;
  else if (argv[i] === '--skip' && next) {
    const ids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) fail(`--skip needs at least one org id\n${USAGE}`);
    ids.forEach(id => SKIP.add(id));
  } else if (argv[i] === '--expect' && next) EXPECT = argv[++i].trim();
  else fail(`Unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
}
if (APPLY && !/^[0-9a-f]{8}$/.test(EXPECT || '')) fail(`--apply needs --expect <code>, the 8-character code the dry run prints.\n${USAGE}`);
if (!APPLY && EXPECT) fail(`--expect only goes with --apply.\n${USAGE}`);
if (!TOKEN) fail('Set GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>)');

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Goog-User-Project': PROJECT },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`), { status: res.status });
  return JSON.parse(text);
}

function val(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  return '<complex>';
}
const plain = d => ({
  name: d.name,
  docId: d.name.split('/').pop(),
  createMs: Date.parse(d.createTime),
  updateTime: d.updateTime,
  raw: d.fields || {},
  f: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])),
});

async function runQuery(collectionId, fields) {
  const rows = await api(':runQuery', {
    structuredQuery: { from: [{ collectionId }], select: { fields: fields.map(fieldPath => ({ fieldPath })) } },
  });
  return rows.filter(r => r.document).map(r => plain(r.document));
}

const nonEmpty = s => typeof s === 'string' && s.length > 0;
const day = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '?');
// How profiles normally point at an org: its id field, or the doc ID for a legacy org without one.
const keyOf = o => (nonEmpty(o.f.id) ? o.f.id : o.docId);
// A profile's org the way the rules, the functions and 1.2.8 read it ('' = none).
function profileOrgId(u) {
  const orgId = 'organization_id' in u.f ? u.f.organization_id : u.f.organizationId;
  return typeof orgId === 'string' && orgId !== 'removed' ? orgId : '';
}
// The org review status as both app builds map it.
const reviewStatus = s => (s === 'pending' || s === 'rejected' ? s : 'verified');

// A real App Store subscription in any state: Apple may still bill it (renewing, or in its
// 60-day billing retry after a failed renewal). Sandbox purchases are free TestFlight tests.
function appStoreSubscription(f) {
  if (!nonEmpty(f.appleOriginalTransactionId) || f.appleEnvironment === 'Sandbox') return null;
  const ends = day(Number(f.appleExpiresDateMs));
  const state = f.subscriptionStatus !== 'active' ? `${f.subscriptionStatus || 'no status'}, ended ${ends}`
    : f.subscriptionCancelledAt ? `auto-renew off, ends ${ends}` : `renews ${ends}`;
  return `App Store ${f.appleProductId || '?'}: ${state}`;
}

function decide(o) {
  const ids = [o.docId, keyOf(o)];
  if (ids.some(id => PLACEHOLDER_IDS.has(id))) return { skip: "the app's no-org placeholder" };
  if (ids.some(id => SKIP.has(id))) return { skip: 'named in --skip' };
  if (o.f.grandfathered === true) return { skip: 'already grandfathered' };
  const sub = appStoreSubscription(o.f);
  if (sub && !INCLUDE_PAYING) return { skip: `${sub} (--include-paying)` };
  return { write: true, warn: sub };
}

function grandfatherWrite(o) {
  return {
    update: {
      name: o.name,
      fields: {
        grandfathered: { booleanValue: true },
        subscriptionStatus: { stringValue: 'active' },
        subscriptionPlan: { stringValue: 'grandfathered' },
        grandfatherNote: { stringValue: NOTE },
      },
    },
    // maxSeats is in the mask but not in the fields, so the commit deletes it: a
    // grandfathered org has no seat cap.
    updateMask: { fieldPaths: ['grandfathered', 'subscriptionStatus', 'subscriptionPlan', 'grandfatherNote', 'maxSeats'] },
    updateTransforms: [{ fieldPath: 'subscriptionUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { updateTime: o.updateTime },
  };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (nothing is written)'}${EMULATOR ? ` against the emulator at ${EMULATOR}` : ''}\n`);

  const [orgs, users] = await Promise.all([
    runQuery('organizations', ['id', 'name', 'status', 'appleProductId', 'appleOriginalTransactionId', 'appleExpiresDateMs',
      'appleEnvironment', 'subscriptionCancelledAt', ...TOUCHED]),
    runQuery('users', ['name', 'organization_id', 'organizationId']),
  ]);

  const unmatched = [...SKIP].filter(id => !orgs.some(o => o.docId === id || keyOf(o) === id));
  if (unmatched.length) fail(`ABORT: --skip names no org: ${unmatched.join(', ')}. Nothing was written.`);

  // The org a pointer reaches, the way both builds' AuthContext find it: by id field
  // (lowest doc ID first, Firestore's default order), else by doc ID.
  const orgFor = ptr => orgs.filter(o => o.f.id === ptr).sort((a, b) => (a.docId < b.docId ? -1 : 1))[0]
    || orgs.find(o => o.docId === ptr) || null;

  // Members are the profiles whose pointer reaches the org, so one that points at it by
  // doc ID (an old hand edit) still counts.
  const members = new Map();
  for (const u of users) {
    const o = profileOrgId(u) ? orgFor(profileOrgId(u)) : null;
    if (o) members.set(o, (members.get(o) || 0) + 1);
  }

  const plans = orgs.map(o => ({ o, ...decide(o) }));
  plans.sort((a, b) => Number(!!b.write) - Number(!!a.write) || a.o.createMs - b.o.createMs);
  console.table(plans.map(({ o, write, skip }) => {
    const f = o.f;
    return {
      org: f.name || '(no name)',
      doc: o.docId,
      'id field': nonEmpty(f.id) ? f.id : '(none)',
      created: day(o.createMs),
      review: f.status || '-',
      members: members.get(o) || 0,
      'plan/status': `${f.subscriptionPlan || '-'}/${f.subscriptionStatus || '-'}${f.appleProductId ? `/apple:${f.appleProductId}` : ''}`,
      seats: f.maxSeats ?? '-',
      action: write ? `GRANDFATHER${f.maxSeats != null ? ', no seat cap' : ''}` : `leave: ${skip}`,
    };
  }));

  const toWrite = plans.filter(p => p.write);
  for (const p of toWrite.filter(p => p.warn)) {
    console.log(`WARNING: ${p.o.f.name || p.o.docId} has a real App Store subscription (${p.warn}). If it still renews, Apple keeps billing until its admin cancels in Settings > Apple ID > Subscriptions.`);
  }

  // Who still won't reach the app afterwards, by each build's AuthContext.
  const grandfatheredAfter = new Set([...orgs.filter(o => o.f.grandfathered === true), ...toWrite.map(p => p.o)]);
  const blocked = ptr => {
    if (ptr === 'removed') return 'removed from their org';
    if (!ptr || ptr === 'default-org') return 'no org';
    const o = orgFor(ptr);
    if (!o) return `org ${ptr} not found`;
    const label = o.f.name || o.docId;
    if (reviewStatus(o.f.status) !== 'verified') return `${label} is ${o.f.status}`;
    if (grandfatheredAfter.has(o) || o.f.subscriptionStatus === 'active') return null;
    return `${label} is left unpaid`;
  };
  const stuck = users.map(u => {
    const raw = 'organization_id' in u.f ? u.f.organization_id : u.f.organizationId;
    // live 1.2.7 reads organizationId first and maps only an empty pointer to no org
    const live = blocked(u.f.organizationId || u.f.organization_id || '');
    const next = blocked(raw === 'removed' ? 'removed' : profileOrgId(u));
    return { u, live, next };
  }).filter(r => r.live || r.next);
  if (stuck.length) {
    console.log(`\nProfiles that still won't reach the app afterwards (${stuck.length}):`);
    for (const { u, live, next } of stuck) {
      console.log(`  ${u.f.name || '-'} (uid ${u.docId}): 1.2.7 ${live || 'gets in'}; 1.2.8 ${next || 'gets in'}`);
    }
  }

  const code = crypto.createHash('sha256').update(toWrite.map(p => p.o.docId).sort().join(',')).digest('hex').slice(0, 8);
  console.log(`\n${orgs.length} orgs read: ${toWrite.length} to grandfather, ${plans.length - toWrite.length} left as they are.`);
  if (!toWrite.length) {
    console.log('Nothing to write.');
    return;
  }
  if (!APPLY) {
    console.log(`\nDry run only. To grandfather exactly these ${toWrite.length}, re-run with the same options plus: --apply --expect ${code}`);
    return;
  }
  if (EXPECT !== code) fail(`ABORT: the list has changed since the dry run (code ${code}, expected ${EXPECT}). Nothing was written. Run the dry run again.`);

  console.log('\nPrevious values, for undoing by hand ("absent" = field not set):');
  for (const p of toWrite) {
    console.log(`  organizations/${p.o.docId} ${JSON.stringify(Object.fromEntries(TOUCHED.map(k => [k, p.o.raw[k] ?? 'absent'])))}`);
  }

  let outcomeUnknown = false;
  try {
    await api(':commit', { writes: toWrite.map(p => grandfatherWrite(p.o)) });
    console.log(`\nCommitted: ${toWrite.length} orgs grandfathered.`);
  } catch (e) {
    if (e.status >= 400 && e.status < 500) {
      const why = e.status === 401 || e.status === 403 ? 'the token was refused (expired, or not the project owner)'
        : 'an org changed or was deleted since the read, or the request was refused';
      fail(`\nNothing was written: ${why}. The commit is all-or-nothing; run the dry run again.\n${e.message}`);
    }
    // A timeout, a 5xx or a dropped connection can arrive after the commit went through.
    outcomeUnknown = true;
    console.error(`\nThe commit did not answer cleanly (${e.message}). Reading the orgs back to see what happened...`);
  }

  let got;
  try {
    got = await api(':batchGet', {
      documents: toWrite.map(p => p.o.name),
      mask: { fieldPaths: ['grandfathered', 'subscriptionStatus', 'subscriptionPlan', 'maxSeats', 'grandfatherNote'] },
    });
  } catch (e) {
    fail(`Could not read the orgs back (${e.message}). Run the dry run again: orgs that were written show "leave: already grandfathered".`);
  }
  const done = got.filter(r => {
    const f = r.found ? plain(r.found).f : null;
    return f && f.grandfathered === true && f.subscriptionStatus === 'active' && f.subscriptionPlan === 'grandfathered'
      && !('maxSeats' in f) && f.grandfatherNote === NOTE;
  });
  if (outcomeUnknown && !done.length) fail('Read back: no org carries this run\'s change, so nothing was written. Run the dry run again.');
  console.log(`Read back: ${done.length}/${toWrite.length} orgs grandfathered with no seat cap.`);
  if (done.length !== toWrite.length) {
    const ok = new Set(done.map(r => r.found.name));
    fail(`CHECK THESE: ${toWrite.filter(p => !ok.has(p.o.name)).map(p => p.o.docId).join(', ')}`);
  }
}

main().catch(e => fail(`FAILED: ${e.message}`));
