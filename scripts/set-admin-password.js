/**
 * Set (reset) a user's password directly — no reset email is sent.
 *
 * The Firebase console's "Reset password" button emails the user a reset link,
 * which is useless before they have the app installed. This sets the password
 * server-side via the Identity Toolkit admin API so you can hand it to them
 * directly (e.g. in an onboarding email).
 *
 * Generates a phone-typeable password that meets the app's rules (8+ chars, a
 * letter and a number) unless you pass --password. Dry run by default; the new
 * password is printed only on --apply.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token --account=<project owner>) \
 *   node scripts/set-admin-password.js --email person@example.com [--password 'Hg-...'] [--apply]
 */
const crypto = require('crypto');

const PROJECT = 'holyguard-app';
const IDENTITY = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APPLY = process.argv.includes('--apply');
const EMAIL = (arg('--email', '') || '').trim().toLowerCase();
const PASSWORD_ARG = arg('--password', null);
const TOKEN = (process.env.GCLOUD_ACCESS_TOKEN || '').trim();

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) fail('Missing or invalid --email');
if (!TOKEN) fail('Set GCLOUD_ACCESS_TOKEN (gcloud auth print-access-token --account=<project owner>)');
if (PASSWORD_ARG && PASSWORD_ARG.length < 8) fail('--password must be at least 8 characters');

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

// Typeable on a phone, meets the app's rules (8+ chars, a letter and a number)
function tempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    const groups = [0, 1, 2].map(() => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''));
    const pw = `Hg-${groups.join('-')}`;
    if (/\d/.test(pw) && /[a-z]/i.test(pw)) return pw;
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}\n`);

  const lookup = await api('POST', `${IDENTITY}/accounts:lookup`, { email: [EMAIL] });
  if (!lookup.users || !lookup.users.length) fail(`ABORT: no Auth account for ${EMAIL}`);
  const uid = lookup.users[0].localId;
  console.log(`Account: ${EMAIL} (uid ${uid}, emailVerified ${lookup.users[0].emailVerified === true})`);

  const password = PASSWORD_ARG || tempPassword();

  if (!APPLY) {
    console.log('\nWill set a new password directly. No reset email is sent; nothing else on the account changes.');
    console.log('Re-run with --apply to write. The new password prints only on --apply.');
    return;
  }

  // Only localId + password: email, emailVerified, displayName, etc. are left untouched.
  await api('POST', `${IDENTITY}/accounts:update`, { localId: uid, password });

  console.log('\n================ DONE ================');
  console.log(`Password set for ${EMAIL} — no email was sent.`);
  console.log(`New password: ${password}`);
  console.log('=====================================');
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
