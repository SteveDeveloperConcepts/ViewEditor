// Which copies look for new versions, and what they do with one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMode } from '../../src/shared/update.ts';

test('the Windows installer updates itself', () => {
  assert.equal(updateMode({ packaged: true, platform: 'win32', testing: false }), 'install');
});

test('a Mac in Applications updates itself, since releases are signed with the Developer ID', () => {
  assert.equal(updateMode({ packaged: true, platform: 'darwin', testing: false, inApplications: true }), 'install');
});

test('a Mac copy anywhere else only hears about new versions, because macOS cannot replace it there', () => {
  assert.equal(updateMode({ packaged: true, platform: 'darwin', testing: false, inApplications: false }), 'notify');
  assert.equal(updateMode({ packaged: true, platform: 'darwin', testing: false }), 'notify');
});

test('development runs and test runs never check', () => {
  assert.equal(updateMode({ packaged: false, platform: 'win32', testing: false }), null);
  assert.equal(updateMode({ packaged: false, platform: 'darwin', testing: false, inApplications: true }), null);
  assert.equal(updateMode({ packaged: true, platform: 'win32', testing: true }), null);
  assert.equal(updateMode({ packaged: true, platform: 'darwin', testing: true, inApplications: true }), null);
});

test('other systems never check, since no installer is published for them', () => {
  assert.equal(updateMode({ packaged: true, platform: 'linux', testing: false }), null);
});
