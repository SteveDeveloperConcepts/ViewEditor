import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkCue, parseSubtitles, splitSentences, toSrt } from '../../src/shared/subtitles.ts';
import { formatBytes, formatClock, formatTimecode, parseTimecode, snapToFrame } from '../../src/shared/time.ts';

test('reads SRT', () => {
  const cues = parseSubtitles('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nthere\r\n\r\n2\r\n00:01:00,000 --> 00:01:01,000\r\n<i>Second</i> &amp; last\r\n');
  assert.deepEqual(cues, [
    { start: 1, end: 2.5, text: 'Hello\nthere' },
    { start: 60, end: 61, text: 'Second & last' },
  ]);
});

test('reads WebVTT, skipping headers, notes and cue settings', () => {
  const cues = parseSubtitles('WEBVTT\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.000 align:center\nHi\n\n01:00:00.500 --> 01:00:01.000\nLater\n');
  assert.deepEqual(cues, [
    { start: 1, end: 2, text: 'Hi' },
    { start: 3600.5, end: 3601, text: 'Later' },
  ]);
});

test('skips broken cues and handles a byte order mark', () => {
  assert.deepEqual(parseSubtitles('﻿1\n00:00:05,000 --> 00:00:02,000\nBackwards\n\nnot a cue at all\n'), []);
});

test('SRT survives a round trip', () => {
  const cues = [
    { start: 0.5, end: 2, text: 'One' },
    { start: 3661.25, end: 3662, text: 'Two' },
  ];
  assert.deepEqual(parseSubtitles(toSrt(cues)), cues);
});

test('scripts split into sentences without tripping over abbreviations', () => {
  assert.deepEqual(splitSentences('Hello there. Mr. Smith arrived! Did he?\n\nNew paragraph without a stop'), ['Hello there.', 'Mr. Smith arrived!', 'Did he?', 'New paragraph without a stop']);
});

test('quotes after a full stop stay with their sentence', () => {
  assert.deepEqual(splitSentences('She said "go." Then we left.'), ['She said "go."', 'Then we left.']);
});

test('long sentences become readable cues that share out the time', () => {
  const text = 'This sentence is much longer than anything that should sit on the screen in one go, because nobody can read that fast';
  const cues = chunkCue(text, 10, 16, 44);
  assert.ok(cues.length >= 3);
  assert.ok(cues.every((c) => c.text.length <= 50), JSON.stringify(cues));
  assert.equal(cues[0].start, 10);
  assert.equal(cues.at(-1)!.end, 16);
  cues.forEach((c, i) => i && assert.equal(c.start, cues[i - 1].end));
  assert.equal(cues.map((c) => c.text).join(' '), text, 'no words lost');
});

test('short sentences stay whole', () => {
  assert.deepEqual(chunkCue('Short one.', 1, 2), [{ start: 1, end: 2, text: 'Short one.' }]);
});

test('time formats', () => {
  assert.equal(formatTimecode(0), '00:00.0');
  assert.equal(formatTimecode(65.34), '01:05.3');
  assert.equal(formatTimecode(59.96), '01:00.0', 'rounding carries over');
  assert.equal(formatTimecode(3725.5), '1:02:05.5');
  assert.equal(formatClock(59.6), '1:00');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(snapToFrame(1.0167, 30), 1.0333333333333334);
});

test('typed times are understood', () => {
  assert.equal(parseTimecode('1:02.5'), 62.5);
  assert.equal(parseTimecode('1:00:01'), 3601);
  assert.equal(parseTimecode('2,5'), 2.5);
  assert.equal(parseTimecode('12'), 12);
  assert.equal(parseTimecode('abc'), null);
  assert.equal(parseTimecode('1:2:3:4'), null);
});

test('file sizes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB');
});
