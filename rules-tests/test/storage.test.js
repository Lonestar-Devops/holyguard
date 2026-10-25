// Hardened Storage rules: no overwrite of others' images, image/size limits,
// watchlist uploads restored. Cross-org read stays open (documented limitation).
const { test, before, after, beforeEach, describe } = require('node:test');
const { makeStorageEnv } = require('./_env');
const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // 8-byte PNG header
const big = new Uint8Array(6 * 1024 * 1024);                                   // 6MB
const img = { contentType: 'image/png' };

let env;
function st(uid) { return env.authenticatedContext(uid).storage(); }

before(async () => {
  env = await makeStorageEnv();
  // Seed one existing object in each bucket, rules off.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.storage();
    await uploadBytes(ref(s, 'incidents/existing.png'), png, img);
    await uploadBytes(ref(s, 'direct_messages/convAB/existing.png'), png, img);
  });
});
after(async () => { await env.cleanup(); });

describe('storage attacks blocked', () => {
  test('cannot overwrite an existing incident photo', async () => {
    await assertFails(uploadBytes(ref(st('memberB'), 'incidents/existing.png'), png, img));
  });
  test('cannot overwrite an existing DM photo', async () => {
    await assertFails(uploadBytes(ref(st('intruder'), 'direct_messages/convAB/existing.png'), png, img));
  });
  test('cannot delete an existing object', async () => {
    await assertFails(deleteObject(ref(st('memberB'), 'incidents/existing.png')));
  });
  test('cannot upload a non-image', async () => {
    await assertFails(uploadBytes(ref(st('memberA'), 'incidents/evil.txt'), png, { contentType: 'text/plain' }));
  });
  test('cannot upload an oversize image', async () => {
    await assertFails(uploadBytes(ref(st('memberA'), 'incidents/huge.png'), big, img));
  });
  test('unauthenticated cannot read or write', async () => {
    const anon = env.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(anon, 'incidents/existing.png')));
    await assertFails(uploadBytes(ref(anon, 'incidents/anon.png'), png, img));
  });
});

describe('live storage operations still work', () => {
  test('upload a new incident photo (timestamped path)', async () => {
    await assertSucceeds(uploadBytes(ref(st('memberA'), 'incidents/1699999999_photo.png'), png, img));
  });
  test('upload a new DM photo into own conversation path', async () => {
    await assertSucceeds(uploadBytes(ref(st('memberA'), 'direct_messages/convAB/1699999999.png'), png, img));
  });
  test('upload a new resource photo', async () => {
    await assertSucceeds(uploadBytes(ref(st('memberA'), 'resources/memberA_1699999999.png'), png, img));
  });
  test('watchlist photo upload now works (was denied before)', async () => {
    await assertSucceeds(uploadBytes(ref(st('memberA'), 'watchlist/1699999999_face.png'), png, img));
  });
  test('an image of exactly 5MB is accepted (the app allows up to 5MB)', async () => {
    await assertSucceeds(uploadBytes(ref(st('memberA'), 'incidents/1699999999_exact.png'),
      new Uint8Array(5 * 1024 * 1024), img));
  });
  test('reading an existing image still works for any signed-in user', async () => {
    await assertSucceeds(getBytes(ref(st('memberA'), 'incidents/existing.png')));
  });
});
