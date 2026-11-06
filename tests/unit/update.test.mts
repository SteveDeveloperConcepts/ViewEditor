// Which copies look for new versions, and what they do with one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMode } from '../../src/shared/update.ts';

test('the Windows installer updates itself', () => {
  assert.equal(updateMode({ packaged: true, platform: 'win32', testing: false }), 'install');
});

test('a Mac only hears about new versions, because ad-hoc signed apps cannot update themselves', () => {
  assert.equal(updateMode({ packaged: true, platform: 'darwin', testing: false }), 'notify');
});

test('development runs and test runs never check', () => {
  assert.equal(updateMode({ packaged: false, platform: 'win32', testing: false }), null);
  assert.equal(updateMode({ packaged: true, platform: 'win32', testing: true }), null);
  assert.equal(updateMode({ packaged: true, platform: 'darwin', testing: true }), null);
});

test('other systems never check, since no installer is published for them', () => {
  assert.equal(updateMode({ packaged: true, platform: 'linux', testing: false }), null);
});
