import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/components/media/liveVideo.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness() {
  const calls = [], states = [], peers = [], timers = new Map();
  let now = 100, timerId = 0, stoppedTracks = 0, frameCount = 0;
  const roomId = '70000000-0000-4000-8000-000000000001';
  let reply = { room_id: roomId, epoch: 1, peer_present: false, signals: [], cursor: 0 };
  let status = 200;
  const tracks = [{ addEventListener() {}, removeEventListener() {}, stop() { stoppedTracks++; } }];
  const stream = { getTracks: () => tracks };
  class Peer {
    constructor(config) { this.config = config; this.connectionState = 'new'; this.tracks = []; peers.push(this); }
    addTrack(track, stream) { this.tracks.push({ track, stream }); }
    async createOffer() { return { type: 'offer', sdp: 'synthetic-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'synthetic-answer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate() {}
    async getStats() { return new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: frameCount }]]); }
    close() { this.closed = true; this.connectionState = 'closed'; }
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports, module, RTCPeerConnection: Peer, AbortController,
    crypto: { randomUUID: () => '60000000-0000-4000-8000-000000000001' },
    performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const current = init?.method === 'POST' ? 200 : status;
      return { ok: current === 200, status: current,
        json: async () => init?.method === 'POST' ? { accepted: true } : structuredClone(reply) };
    },
  });
  return {
    calls, states, peers, stream,
    create(role, extra = {}) { return module.exports.createLiveVideo({ sessionId: 'synthetic-session', role,
      token: role === 'student' ? 'synthetic-token' : undefined,
      stream: role === 'student' ? stream : undefined,
      onState: (state, message) => states.push({ state, message }), ...extra }); },
    reply(value, code = 200) { reply = { room_id: roomId, ...value }; status = code; },
    frames(value) { frameCount = value; },
    get stoppedTracks() { return stoppedTracks; },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= now);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      await flush();
    },
  };
}

test('student live controller reuses the assessed stream and never owns device cleanup', async () => {
  const h = harness();
  const client = h.create('student');
  await flush();
  assert.equal(h.states.at(-1).state, 'waiting');
  h.reply({ epoch: 2, peer_present: true, signals: [], cursor: 0 });
  await h.advance(2000);
  assert.equal(h.peers.length, 1);
  assert.equal(h.peers[0].config.iceServers.length, 0);
  assert.equal(h.peers[0].tracks[0].stream, h.stream);
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer synthetic-token');
  assert.ok(h.calls.some(call => call.init.method === 'POST' && JSON.parse(call.init.body).kind === 'offer'));
  client.stop();
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.stoppedTracks, 0);
  assert.equal(JSON.parse(h.calls.at(-1).init.body).kind, 'leave');
});

test('professor live state requires fresh decoded frames and fails closed on frozen video', async () => {
  const h = harness();
  h.reply({ epoch: 2, peer_present: true, cursor: 1, signals: [
    { sequence: 1, kind: 'offer', payload: JSON.stringify({ type: 'offer', sdp: 'synthetic-offer' }) },
  ] });
  const client = h.create('professor');
  await flush();
  assert.equal(h.peers.length, 1);
  assert.equal(h.states.at(-1).state, 'connecting');
  h.peers[0].connectionState = 'connected';
  h.peers[0].onconnectionstatechange();
  h.reply({ epoch: 2, peer_present: true, cursor: 1, signals: [] });
  h.frames(10);
  await h.advance(2000);
  assert.equal(h.states.at(-1).state, 'connected');
  await h.advance(7000);
  assert.equal(h.states.at(-1).state, 'reconnecting');
  await h.advance(6000);
  assert.equal(h.states.at(-1).state, 'unavailable');
  assert.equal(h.peers[0].closed, true);
  client.stop();
});

test('expired attempt response ends polling without attempting a connection', async () => {
  const h = harness();
  h.reply({ detail: 'The assessed recording is no longer active.' }, 410);
  h.create('professor');
  await flush();
  assert.equal(h.states.at(-1).state, 'ended');
  assert.equal(h.peers.length, 0);
  const callCount = h.calls.length;
  await h.advance(30000);
  assert.equal(h.calls.length, callCount);
});

test('authorization loss closes an existing peer and prevents further negotiation', async () => {
  const h = harness();
  h.reply({ epoch: 2, peer_present: true, cursor: 0, signals: [] });
  h.create('student');
  await flush();
  h.reply({ detail: 'Invalid or expired student token.' }, 401);
  await h.advance(2000);
  assert.equal(h.states.at(-1).state, 'unavailable');
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.stoppedTracks, 0);
});

test('negotiation is bounded and an absent peer closes stale connections', async () => {
  const h = harness();
  h.reply({ epoch: 2, peer_present: true, cursor: 0, signals: [] });
  h.create('student');
  await flush();
  await h.advance(16000);
  assert.equal(h.states.at(-1).state, 'unavailable');
  assert.equal(h.peers[0].closed, true);
  const next = harness();
  next.reply({ epoch: 2, peer_present: true, cursor: 0, signals: [] });
  next.create('student');
  await flush();
  next.reply({ epoch: 3, peer_present: false, cursor: 0, signals: [] });
  await next.advance(2000);
  assert.equal(next.states.at(-1).state, 'waiting');
  assert.equal(next.peers[0].closed, true);
});

test('changed connection epoch cannot retain a live label from an earlier peer', async () => {
  const h = harness();
  h.reply({ epoch: 2, peer_present: true, cursor: 1, signals: [
    { sequence: 1, kind: 'offer', payload: JSON.stringify({ type: 'offer', sdp: 'synthetic' }) },
  ] });
  h.create('professor');
  await flush();
  h.peers[0].connectionState = 'connected';
  h.peers[0].onconnectionstatechange();
  h.reply({ epoch: 2, peer_present: true, cursor: 1, signals: [] });
  h.frames(10);
  await h.advance(2000);
  assert.equal(h.states.at(-1).state, 'connected');
  h.reply({ epoch: 3, peer_present: true, cursor: 1, signals: [] });
  await h.advance(2000);
  assert.equal(h.states.at(-1).state, 'connecting');
  assert.equal(h.peers[0].closed, true);
});

test('established connections receive the bounded eight-second reconnect window', async () => {
  const h = harness();
  h.reply({ epoch: 2, peer_present: true, cursor: 0, signals: [] });
  h.create('student');
  await flush();
  h.peers[0].connectionState = 'connected';
  h.peers[0].onconnectionstatechange();
  await h.advance(30000);
  h.peers[0].connectionState = 'disconnected';
  h.peers[0].onconnectionstatechange();
  await h.advance(2000);
  assert.equal(h.states.at(-1).state, 'reconnecting');
  assert.notEqual(h.peers[0].closed, true);
  await h.advance(7000);
  assert.equal(h.states.at(-1).state, 'unavailable');
  assert.equal(h.peers[0].closed, true);
});

test('new room nonce with repeated epoch replaces peer and discards its late ICE callbacks', async () => {
  const h=harness();
  h.reply({epoch:2,peer_present:true,cursor:0,signals:[]});
  h.create('student'); await flush();
  const old=h.peers[0], late=old.onicecandidate;
  h.reply({room_id:'70000000-0000-4000-8000-000000000099',epoch:2,peer_present:true,cursor:0,signals:[]});
  await h.advance(2000);
  assert.equal(old.closed,true); assert.equal(h.peers.length,2);
  const before=h.calls.length;
  late({candidate:{toJSON:()=>({candidate:'synthetic stale ICE'})}}); await flush();
  assert.equal(h.calls.length,before);
  assert.notEqual(h.peers[1].closed,true);
  const offers=h.calls.filter(call=>call.init.method==='POST'&&JSON.parse(call.init.body).kind==='offer');
  assert.equal(JSON.parse(offers.at(-1).init.body).room_id,'70000000-0000-4000-8000-000000000099');
});

test('an invalid server generation fails closed without creating a peer', async () => {
  const h=harness();
  h.reply({room_id:'',epoch:2,peer_present:true,cursor:0,signals:[]});
  h.create('professor'); await flush();
  assert.equal(h.states.at(-1).state,'unavailable');
  assert.equal(h.peers.length,0);
});
