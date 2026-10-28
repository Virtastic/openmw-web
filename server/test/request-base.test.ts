import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { requestBase } from '../src/data/fsstorage';

const req = (host?: string) => ({ headers: host ? { host } : {}, socket: {} }) as unknown as IncomingMessage;
const hosts = ['opentes3.com', 'b.example'];
const fb = 'https://opentes3.com';

test('links follow the request host when listed, else the fallback', () => {
  assert.equal(requestBase(req('b.example'), hosts, fb), 'http://b.example');
  assert.equal(requestBase(req('opentes3.com:8080'), hosts, fb), 'http://opentes3.com:8080');
  assert.equal(requestBase(req('evil.test'), hosts, fb), fb);
  assert.equal(requestBase(req(), hosts, fb), fb);
});
