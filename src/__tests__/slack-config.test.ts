import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { slackConfig } from '../providers/slack/config';

const SAVED: Record<string, string | undefined> = {};
const KEYS = ['SLACK_PORT', 'SLACK_ALLOWED_USER_IDS'];

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

test('port defaults to 3000 when SLACK_PORT is unset', () => {
  delete process.env.SLACK_PORT;
  assert.equal(slackConfig.port, 3000);
});

test('port parses a valid integer', () => {
  process.env.SLACK_PORT = '4000';
  assert.equal(slackConfig.port, 4000);
});

test('port falls back to 3000 for non-numeric value', () => {
  process.env.SLACK_PORT = 'not-a-number';
  assert.equal(slackConfig.port, 3000);
});

test('port falls back to 3000 for empty string', () => {
  process.env.SLACK_PORT = '';
  assert.equal(slackConfig.port, 3000);
});

test('port rejects values below 1', () => {
  process.env.SLACK_PORT = '0';
  assert.equal(slackConfig.port, 3000);
  process.env.SLACK_PORT = '-1';
  assert.equal(slackConfig.port, 3000);
});

test('port rejects values above 65535', () => {
  process.env.SLACK_PORT = '65536';
  assert.equal(slackConfig.port, 3000);
  process.env.SLACK_PORT = '70000';
  assert.equal(slackConfig.port, 3000);
});

test('port accepts boundary values 1 and 65535', () => {
  process.env.SLACK_PORT = '1';
  assert.equal(slackConfig.port, 1);
  process.env.SLACK_PORT = '65535';
  assert.equal(slackConfig.port, 65535);
});

test('allowedUserIds returns empty array when unset', () => {
  delete process.env.SLACK_ALLOWED_USER_IDS;
  assert.deepEqual(slackConfig.allowedUserIds, []);
});

test('allowedUserIds parses comma-separated values', () => {
  process.env.SLACK_ALLOWED_USER_IDS = 'U001,U002, U003 ';
  assert.deepEqual(slackConfig.allowedUserIds, ['U001', 'U002', 'U003']);
});

test('allowedUserIds filters empty entries', () => {
  process.env.SLACK_ALLOWED_USER_IDS = 'U001,,U002';
  assert.deepEqual(slackConfig.allowedUserIds, ['U001', 'U002']);
});
