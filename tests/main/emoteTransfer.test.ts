import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSEMBLY_TIMEOUT_MS, EMOTE_CHUNK_BYTES, EmoteTransfer, LAN_TOTAL_CHUNKS_PER_TICK, MAX_ASSEMBLIES, MAX_PENDING_BYTES,
  REASKS_MAX, SOUND_ASSEMBLY_TIMEOUT_MS, type EmoteTransferDeps,
} from '../../src/main/emoteTransfer';
import { ROOM_SOUND_MAX_BYTES } from '../../src/shared/emotes';
import type { ChunkMsg, WantMsg } from '../../src/shared/roomProtocol';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A lossy WebP still whose headers are all the checks read; `size` lets a test build a multi-chunk file. */
const still = (size = 600, seed = 7): Uint8Array => {
  const out = new Uint8Array(size).fill(seed);
  out.set([...ascii('RIFF'), ...le32(size - 8), ...ascii('WEBPVP8 '), ...le32(size - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(160), ...le16(120)]);
  return out;
};
const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);
/** An OGG sound as far as the type check reads it. */
const ogg = (size = 600, seed = 5): Uint8Array => {
  const out = new Uint8Array(size).fill(seed);
  out.set(ascii('OggS'));
  return out;
};

/** The member whose custom emote we are receiving. */
const ANNOUNCER = 'aaaaaaaaaaaaaaaa';
/** The member receiving our still, in the serving tests. */
const REQUESTER = 'bbbbbbbbbbbbbbbb';

const chunkOf = (h: string, i: number, n: number, part: Uint8Array, peer = ANNOUNCER): ChunkMsg =>
  ({ peer, seq: 1, ts: 0, t: 'chunk', h, i, n, b: Buffer.from(part).toString('base64') });
const wantOf = (h: string, need: number[]): WantMsg =>
  ({ peer: REQUESTER, seq: 1, ts: 0, t: 'want', to: ANNOUNCER, h, need });
const soundChunkOf = (h: string, i: number, n: number, part: Uint8Array, peer = ANNOUNCER): ChunkMsg =>
  ({ ...chunkOf(h, i, n, part, peer), k: 's' });
const soundWantOf = (h: string, need: number[]): WantMsg => ({ ...wantOf(h, need), k: 's' });
/** Every chunk of `bytes`, the way its sender slices it. */
const soundChunks = (h: string, bytes: Uint8Array, peer = ANNOUNCER): ChunkMsg[] => {
  const n = Math.ceil(bytes.length / EMOTE_CHUNK_BYTES);
  return Array.from({ length: n }, (_, i) => soundChunkOf(h, i, n, bytes.subarray(i * EMOTE_CHUNK_BYTES, (i + 1) * EMOTE_CHUNK_BYTES), peer));
};

type Out = { kind: 'lan' | 'shared'; to?: string; body: Record<string, unknown> };

/** Fake room + library. The clock runs on vitest's fake timers, so tick() and the re-ask spacing are driven by the test. */
function harness() {
  const out: Out[] = [];
  const files = new Map<string, Uint8Array>();
  const cache = new Map<string, Uint8Array>();
  /** Our own shared sounds, by the hash we announce (a test may store bytes that no longer hash to it). */
  const sounds = new Map<string, Uint8Array>();
  const soundCache = new Map<string, Uint8Array>();
  const routes = new Map<string, 'lan' | 'shared' | null>();
  const reads = { still: 0, sound: 0 };
  const state = { enabled: true, fetchSounds: true, tokens: 10, announced: [] as string[], announcedSounds: [] as string[], diskFull: false };
  const deps: EmoteTransferDeps = {
    now: Date.now,
    have: (h) => files.has(h) || cache.has(h),
    still: (h) => {
      reads.still++;
      return files.get(h) ?? null;
    },
    announced: () => state.announced,
    enabled: () => state.enabled,
    put: (h, b) => void cache.set(h, b),
    haveSound: (h) => soundCache.has(h),
    sound: (h) => {
      reads.sound++;
      return sounds.get(h) ?? null;
    },
    announcedSounds: () => state.announcedSounds,
    fetchSounds: () => state.fetchSounds,
    // Like the real cache, the sound only counts as here once the write has finished, and a full disk keeps nothing.
    putSound: async (h, b) => {
      await Promise.resolve();
      if (state.diskFull) return false;
      soundCache.set(h, b);
      return true;
    },
    routeOf: (peer) => routes.get(peer) ?? null,
    sendToLan: (peer, body) => void out.push({ kind: 'lan', to: peer, body }),
    broadcastShared: (body) => void out.push({ kind: 'shared', body }),
    spareSharedToken: (keep) => (state.tokens >= keep + 1 ? (state.tokens--, true) : false),
  };
  const t = new EmoteTransfer(deps);
  return {
    t, out, cache, files, sounds, soundCache, routes, reads,
    setEnabled: (on: boolean) => (state.enabled = on),
    setFetchSounds: (on: boolean) => (state.fetchSounds = on),
    setTokens: (n: number) => (state.tokens = n),
    setAnnounced: (list: string[]) => (state.announced = list),
    setAnnouncedSounds: (list: string[]) => (state.announcedSounds = list),
    setDiskFull: (full: boolean) => (state.diskFull = full),
  };
}

/** Lets pending cache writes finish. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The sender's chunks for `h` assembled back into whole bytes, the way a receiver would. */
function sentFile(out: Out[], h: string): Uint8Array {
  const chunks = out.filter((o) => o.body.t === 'chunk' && o.body.h === h);
  const n = chunks[0].body.n as number;
  const parts = new Map<number, Uint8Array>(chunks.map((c) => [c.body.i as number, Buffer.from(c.body.b as string, 'base64')]));
  const full = new Uint8Array(n * EMOTE_CHUNK_BYTES);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const part = parts.get(i)!;
    full.set(part, at);
    at += part.length;
  }
  return full.subarray(0, at);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EmoteTransfer: receiving', () => {
  it('prefetches an announced hash it does not have, then reassembles the still into the cache', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES + 10); // two chunks
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    expect(h.out).toEqual([{ kind: 'lan', to: ANNOUNCER, body: { t: 'want', to: ANNOUNCER, h: hash, need: [] } }]);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect([...h.cache.keys()]).toEqual([hash]);
    expect(h.cache.get(hash)).toEqual(bytes);
    expect(h.t.stats.assembling).toBe(0);
  });

  it('never asks for what is already here', () => {
    const h = harness();
    const bytes = still();
    h.files.set(hashOf(bytes), bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(bytes)]);
    expect(h.out).toHaveLength(0);
  });

  it('ignores chunks from a member that never announced the hash, and keeps only the true content', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES), 'cccccccccccccccc')); // not an announcer
    expect(h.cache.size).toBe(0);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    const wrong = still(EMOTE_CHUNK_BYTES * 2, 9);
    h.t.onChunk(chunkOf(hash, 1, 2, wrong.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.size).toBe(0); // the hash check refuses the substituted bytes, and the failed assembly is gone

    h.t.announced(ANNOUNCER, [hash]); // the next presence starts over
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.get(hash)).toEqual(bytes);
  });

  it('drops an assembly whose sender contradicts itself about the chunk count', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 3, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.t.stats.assembling).toBe(0);
    expect(h.cache.size).toBe(0);
  });

  it('ignores everything while Show friends’ custom emotes is off', () => {
    const h = harness();
    h.setEnabled(false);
    const bytes = still();
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 1, bytes));
    expect(h.out).toHaveLength(0);
    expect(h.cache.size).toBe(0);
  });

  it('stops at the assembly cap and at the pending-byte cap', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const seen = new Set<string>();
    for (let n = 0; n < MAX_ASSEMBLIES + 3 && seen.size < MAX_ASSEMBLIES + 1; n++) {
      const hash = hashOf(still(600, n + 1));
      seen.add(hash);
      h.t.announced(ANNOUNCER, [hash]);
    }
    expect(h.t.stats.assembling).toBe(MAX_ASSEMBLIES);

    const h2 = harness();
    h2.routes.set(ANNOUNCER, 'lan');
    const first = hashOf(still(400_000));
    h2.t.announced(ANNOUNCER, [first]); // waits for its second chunk, holding 200 KB of the 256 KB budget
    h2.t.onChunk(chunkOf(first, 0, 2, still(400_000).subarray(0, 200_000)));
    const other = hashOf(still(400_000, 3));
    h2.t.announced(ANNOUNCER, [other]); // an empty assembly may wait; its bytes may not
    h2.t.onChunk(chunkOf(other, 0, 2, still(400_000, 3).subarray(0, 200_000))); // 400 KB pending would pass the cap
    expect(h2.t.stats.assembling).toBe(2);
    expect(h2.cache.size).toBe(0); // nothing entered the over-budget assembly
  });

  it('re-asks three times with the missing indexes, then waits for the next presence', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 3);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.out.length = 0;
    h.t.onChunk(chunkOf(hash, 0, 3, bytes.subarray(0, EMOTE_CHUNK_BYTES)));

    await vi.advanceTimersByTimeAsync(3000);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(1);
    expect(h.out.at(-1)!.body).toMatchObject({ t: 'want', to: ANNOUNCER, h: hash, need: [1, 2] });

    for (let n = 0; n < REASKS_MAX - 1; n++) {
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.out.at(-1)!.body.t).toBe('want');
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.t.stats.assembling).toBe(0); // gave up
    h.out.length = 0;
    h.t.announced(ANNOUNCER, [hash]); // the next presence starts over
    expect(h.out.some((o) => o.body.t === 'want')).toBe(true);
  });

  it('re-asks a want that never got a chunk, then gives up the same way', async () => {
    const h = harness();
    const hash = hashOf(still());
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.out.length = 0;
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(0); // nothing for almost three seconds
    await vi.advanceTimersByTimeAsync(1);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.t.stats.assembling).toBe(0); // three re-asks, no chunks: the next presence tries again
  });

  it('sends wants over relays only while five ping tokens stay, the rest on later ticks', async () => {
    const h = harness();
    const hashes = Array.from({ length: 9 }, (_, n) => hashOf(still(600, n + 1))); // a full wheel, met on joining
    h.routes.set(ANNOUNCER, 'shared');
    h.setTokens(7); // two wants' worth above the keep mark
    h.t.announced(ANNOUNCER, hashes);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(2); // the rest wait: pings keep their five
    expect(h.t.stats.assembling).toBe(9);

    h.setTokens(100);
    await vi.advanceTimersByTimeAsync(100);
    const asked = h.out.filter((o) => o.body.t === 'want').map((o) => o.body.h);
    expect(new Set(asked)).toEqual(new Set(hashes)); // each held-back want went once, not as a re-ask
    expect(asked).toHaveLength(9);
  });

  it('drops an assembly after its timeout, and when the announcer leaves', async () => {
    const h = harness();
    const hash = hashOf(still(EMOTE_CHUNK_BYTES * 2));
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    await vi.advanceTimersByTimeAsync(ASSEMBLY_TIMEOUT_MS + 1000);
    expect(h.t.stats.assembling).toBe(0);

    h.t.announced(ANNOUNCER, [hash]);
    h.t.memberGone(ANNOUNCER);
    expect(h.t.stats.assembling).toBe(0);
  });
});

describe('EmoteTransfer: serving', () => {
  it('answers a want over LAN, chunk by chunk, until the whole still is sent', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2 + 5);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'lan')).toHaveLength(2); // two chunks per requester per tick
    await vi.advanceTimersByTimeAsync(100);
    expect(sentFile(h.out, hash)).toEqual(bytes);
    expect(h.t.stats.sending).toBe(0);
  });

  it('sends only the asked indexes', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, [2]));
    await vi.advanceTimersByTimeAsync(100);
    const chunks = h.out.filter((o) => o.body.t === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toMatchObject({ t: 'chunk', h: hash, i: 2, n: 4 });
  });

  it('never serves a hash that is not in our own current announcement', async () => {
    const h = harness();
    const bytes = still();
    h.files.set(hashOf(bytes), bytes);
    h.setAnnounced([]);
    h.t.onWant(wantOf(hashOf(bytes), []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out).toHaveLength(0);
  });

  it('broadcasts relay chunks only while five ping tokens stay, and stops when the hash leaves the wheel', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 6);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'shared');
    h.setAnnounced([hash]);
    h.setTokens(6); // one chunk's worth above the keep mark
    h.out.length = 0;

    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'shared')).toHaveLength(1); // a second would dip below the keep mark

    h.setAnnounced([]); // the emote left our wheel
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'shared')).toHaveLength(1);
    expect(h.t.stats.sending).toBe(0);
  });

  it('merges a second want for the same hash instead of resending what is queued', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, [1]));
    h.t.onWant(wantOf(hash, [1, 3]));
    await vi.advanceTimersByTimeAsync(100);
    const chunks = h.out.filter((o) => o.body.t === 'chunk');
    expect(chunks.map((c) => c.body.i).sort()).toEqual([1, 3]); // index 1 queued once
  });
});

describe('EmoteTransfer: audit regressions', () => {
  it('serves nothing while Show friends’ custom emotes is off, and drops pending work on the next tick', async () => {
    const h = harness();
    const bytes = still();
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.setEnabled(false);
    h.t.onWant(wantOf(hash, [])); // an attacker pulling at our stills while the switch is off: nothing leaves
    expect(h.out).toHaveLength(0);
    expect(h.reads.still).toBe(0);

    h.setEnabled(true);
    h.t.onWant(wantOf(hash, []));
    h.setEnabled(false);
    const announced2 = hashOf(still(EMOTE_CHUNK_BYTES * 3));
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [announced2]); // a pending assembly...
    await vi.advanceTimersByTimeAsync(100);
    expect(h.t.stats).toEqual({ assembling: 0, sending: 0 }); // ...is dropped, not paused, and no re-ask wants go out
  });

  it('a straggler chunk for a still already stored opens no zombie assembly', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.cache.set(hash, bytes); // already here
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    expect(h.t.stats.assembling).toBe(0);
  });

  it('caps the whole LAN egress at LAN_TOTAL_CHUNKS_PER_TICK, however many requesters ask', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 6);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.setAnnounced([hash]);
    for (let n = 0; n < 6; n++) {
      const peer = `${n}`.repeat(16);
      h.routes.set(peer, 'lan');
      h.t.onWant({ ...wantOf(hash, []), peer });
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.body.t === 'chunk')).toHaveLength(LAN_TOTAL_CHUNKS_PER_TICK);
  });

  it('reads the still from its source once per queue, whatever the want flood', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    for (let n = 0; n < 50; n++) h.t.onWant(wantOf(hash, []));
    expect(h.reads.still).toBe(1);
  });
});

describe('EmoteTransfer: receiving sounds', () => {
  it('asks for an announced sound once the announcer’s still is here, and keeps it when it hashes back', async () => {
    const h = harness();
    const img = still();
    const imgHash = hashOf(img);
    const snd = ogg(EMOTE_CHUNK_BYTES + 10);
    const sndHash = hashOf(snd);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [imgHash], [sndHash]);
    expect(h.out.map((o) => o.body)).toEqual([{ t: 'want', to: ANNOUNCER, h: imgHash, need: [] }]); // the still goes first

    h.t.onChunk(chunkOf(imgHash, 0, 1, img));
    expect(h.out.at(-1)?.body).toEqual({ t: 'want', to: ANNOUNCER, h: sndHash, need: [], k: 's' });
    for (const c of soundChunks(sndHash, snd)) h.t.onChunk(c);
    await settle();
    expect(h.soundCache.get(sndHash)).toEqual(snd);
    expect(h.cache.has(sndHash)).toBe(false);
    expect(h.t.stats.assembling).toBe(0);
  });

  it('asks for one sound per member at a time, in the order they announced them, each once', async () => {
    const h = harness();
    const imgs = [still(600, 1), still(600, 2)];
    for (const img of imgs) h.files.set(hashOf(img), img); // we have both images already
    const [a, b] = [ogg(600, 1), ogg(600, 2)];
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, imgs.map(hashOf), [hashOf(a), hashOf(b)]);
    expect(h.out.map((o) => o.body.h)).toEqual([hashOf(a)]);

    for (const c of soundChunks(hashOf(a), a)) h.t.onChunk(c); // done, but the cache is still writing it
    await settle();
    expect(h.out.map((o) => o.body.h)).toEqual([hashOf(a), hashOf(b)]);
  });

  it('stops asking for a sound the cache could not keep, and moves on to the next', async () => {
    const h = harness();
    const imgs = [still(600, 1), still(600, 2)];
    for (const img of imgs) h.files.set(hashOf(img), img);
    const [a, b] = [ogg(600, 1), ogg(600, 2)];
    h.routes.set(ANNOUNCER, 'lan');
    h.setDiskFull(true);
    h.t.announced(ANNOUNCER, imgs.map(hashOf), [hashOf(a), hashOf(b)]);
    for (const c of soundChunks(hashOf(a), a)) h.t.onChunk(c);
    await settle();
    h.t.announced(ANNOUNCER, imgs.map(hashOf), [hashOf(a), hashOf(b)]); // the next presence
    expect(h.out.filter((o) => o.body.h === hashOf(a))).toHaveLength(1); // asking again would only fetch it again
    expect(h.out.at(-1)?.body.h).toBe(hashOf(b));
  });

  it('gives the member’s next sound a turn when one never arrives', async () => {
    const h = harness();
    const imgs = [still(600, 1), still(600, 2)];
    for (const img of imgs) h.files.set(hashOf(img), img);
    const [a, b] = [hashOf(ogg(600, 1)), hashOf(ogg(600, 2))];
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, imgs.map(hashOf), [a, b]);
    await vi.advanceTimersByTimeAsync(3000 * (REASKS_MAX + 1)); // never answered: given up
    expect(h.t.stats.assembling).toBe(0);
    h.out.length = 0;
    h.t.announced(ANNOUNCER, imgs.map(hashOf), [a, b]);
    expect(h.out.map((o) => o.body.h)).toEqual([b]);
    await vi.advanceTimersByTimeAsync(3000 * (REASKS_MAX + 1));
    h.out.length = 0;
    h.t.announced(ANNOUNCER, imgs.map(hashOf), [a, b]); // both gave up: start over with the first
    expect(h.out.map((o) => o.body.h)).toEqual([a]);
  });

  it('keeps re-asking a sound while chunks still come between the silences', async () => {
    const h = harness();
    const img = still();
    h.files.set(hashOf(img), img);
    const snd = ogg(EMOTE_CHUNK_BYTES * 10);
    const sndHash = hashOf(snd);
    const chunks = soundChunks(sndHash, snd);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(img)], [sndHash]);
    for (let i = 0; i <= REASKS_MAX + 1; i++) {
      h.t.onChunk(chunks[i]);
      await vi.advanceTimersByTimeAsync(3000); // a pause long enough for a re-ask, then the sender carries on
    }
    // More re-asks than a still gets in all, each answered, and still the same assembly: it asks only for what is missing.
    expect(h.out.filter((o) => o.body.t === 'want').length).toBeGreaterThan(REASKS_MAX + 1);
    expect(h.out.at(-1)?.body).toMatchObject({ t: 'want', h: sndHash, need: [5, 6, 7, 8, 9], k: 's' });
    expect(h.t.stats.assembling).toBe(1);
  });

  it('asks for nothing for an emote without a sound, or a sound that is already here', () => {
    const h = harness();
    const imgs = [still(600, 1), still(600, 2)];
    for (const img of imgs) h.files.set(hashOf(img), img);
    const b = ogg();
    h.soundCache.set(hashOf(b), b);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, imgs.map(hashOf), ['', hashOf(b)]);
    expect(h.out).toHaveLength(0);
  });

  it.each([
    ['bytes that hash to something else', ogg(600, 1), ogg(600, 2)],
    ['bytes that are not a sound', still(600), still(600)],
    ['a sound over the room cap', ogg(ROOM_SOUND_MAX_BYTES + 1), ogg(ROOM_SOUND_MAX_BYTES + 1)],
  ])('keeps no sound made of %s', (_label, announced, sent) => {
    const h = harness();
    const img = still();
    h.files.set(hashOf(img), img);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(img)], [hashOf(announced)]);
    for (const c of soundChunks(hashOf(announced), sent)) h.t.onChunk(c);
    expect(h.soundCache.size).toBe(0);
    expect(h.t.stats.assembling).toBe(0);
  });

  it('takes sound chunks only from the member who announced that sound, and only as a sound', async () => {
    const h = harness();
    const img = still();
    const imgHash = hashOf(img);
    h.files.set(imgHash, img);
    const snd = ogg();
    const sndHash = hashOf(snd);
    h.t.announced(ANNOUNCER, [imgHash], [sndHash]); // no route: nothing is asked, chunks may still arrive

    h.t.onChunk(soundChunkOf(sndHash, 0, 1, snd, 'cccccccccccccccc')); // someone else claims it
    h.t.onChunk(chunkOf(sndHash, 0, 1, snd)); // the announcer's sound, sent as a still
    expect(h.soundCache.size).toBe(0);
    expect(h.cache.size).toBe(0);
    h.t.onChunk(soundChunkOf(imgHash, 0, 1, img)); // the announcer's still, sent as a sound
    expect(h.soundCache.size).toBe(0);

    h.t.onChunk(soundChunkOf(sndHash, 0, 1, snd));
    await settle();
    expect(h.soundCache.get(sndHash)).toEqual(snd);
  });

  it('asks for and takes no sounds while Play friends’ emote sounds is off, and drops sound work when it goes off', async () => {
    const h = harness();
    const img = still();
    h.files.set(hashOf(img), img);
    const snd = ogg(EMOTE_CHUNK_BYTES * 3);
    const sndHash = hashOf(snd);
    h.routes.set(ANNOUNCER, 'lan');
    h.setFetchSounds(false);
    h.t.announced(ANNOUNCER, [hashOf(img)], [sndHash]);
    for (const c of soundChunks(sndHash, snd)) h.t.onChunk(c);
    expect(h.out).toHaveLength(0);
    expect(h.soundCache.size).toBe(0);

    h.setFetchSounds(true);
    h.t.announced(ANNOUNCER, [hashOf(img)], [sndHash]);
    expect(h.t.stats.assembling).toBe(1);
    h.setFetchSounds(false);
    h.out.length = 0;
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.t.stats.assembling).toBe(0);
    expect(h.out).toHaveLength(0); // no re-ask either
  });

  it('keeps a sound coming in slowly past the still timeout, up to its own', async () => {
    const h = harness();
    const img = still();
    h.files.set(hashOf(img), img);
    const snd = ogg(ROOM_SOUND_MAX_BYTES); // 88 chunks
    const sndHash = hashOf(snd);
    const chunks = soundChunks(sndHash, snd);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(img)], [sndHash]);
    let i = 0;
    while ((i + 1) * 2000 < SOUND_ASSEMBLY_TIMEOUT_MS) { // a chunk every 2 s: never silent long enough to re-ask
      await vi.advanceTimersByTimeAsync(2000);
      h.t.onChunk(chunks[i++]);
      if (i * 2000 === ASSEMBLY_TIMEOUT_MS + 10_000) expect(h.t.stats.assembling).toBe(1); // a still would be gone
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.t.stats.assembling).toBe(0);
    expect(h.soundCache.size).toBe(0);
  });

  it('remembers the sound each member announced for each emote, until they leave', () => {
    const h = harness();
    const [i1, i2] = [hashOf(still(600, 1)), hashOf(still(600, 2))];
    const a = hashOf(ogg());
    h.t.announced(ANNOUNCER, [i1, i2], [a, '']);
    expect(h.t.soundOf(ANNOUNCER, i1)).toBe(a);
    expect(h.t.soundOf(ANNOUNCER, i2)).toBeNull();
    expect(h.t.soundOf(REQUESTER, i1)).toBeNull();
    h.t.announced(ANNOUNCER, [i1]); // the sound is no longer shared
    expect(h.t.soundOf(ANNOUNCER, i1)).toBeNull();
    h.t.announced(ANNOUNCER, [i1], [a]);
    h.t.memberGone(ANNOUNCER);
    expect(h.t.soundOf(ANNOUNCER, i1)).toBeNull();
  });
});

describe('EmoteTransfer: serving sounds', () => {
  it('answers a sound want with chunks marked as sound, until the whole sound is sent', async () => {
    const h = harness();
    const snd = ogg(EMOTE_CHUNK_BYTES * 2 + 5);
    const sndHash = hashOf(snd);
    h.sounds.set(sndHash, snd);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnouncedSounds([sndHash]);

    h.t.onWant(soundWantOf(sndHash, []));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.out.every((o) => o.body.t === 'chunk' && o.body.k === 's')).toBe(true);
    expect(sentFile(h.out, sndHash)).toEqual(snd);
  });

  it('serves no sound it does not announce, none whose file changed, and never a sound as a still', async () => {
    const h = harness();
    const snd = ogg();
    const sndHash = hashOf(snd);
    h.routes.set(REQUESTER, 'lan');
    h.sounds.set(sndHash, snd);
    h.t.onWant(soundWantOf(sndHash, [])); // not announced
    expect(h.reads.sound).toBe(0);

    h.setAnnouncedSounds([sndHash]);
    h.t.onWant(wantOf(sndHash, [])); // asked for as a still
    h.sounds.set(sndHash, ogg(600, 9)); // the emote got another sound since we announced this one
    h.t.onWant(soundWantOf(sndHash, []));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.out).toHaveLength(0);
  });

  it('over relays, sends stills before sounds and streams one sound at a time', async () => {
    const h = harness();
    const img = still(EMOTE_CHUNK_BYTES * 2);
    const [a, b] = [ogg(EMOTE_CHUNK_BYTES * 2, 1), ogg(EMOTE_CHUNK_BYTES * 2, 2)];
    h.files.set(hashOf(img), img);
    h.sounds.set(hashOf(a), a);
    h.sounds.set(hashOf(b), b);
    h.setAnnounced([hashOf(img)]);
    h.setAnnouncedSounds([hashOf(a), hashOf(b)]);
    h.routes.set(REQUESTER, 'shared');
    h.setTokens(6); // one chunk's worth above the keep mark

    h.t.onWant(soundWantOf(hashOf(a), []));
    h.t.onWant(soundWantOf(hashOf(b), []));
    h.t.onWant(wantOf(hashOf(img), []));
    await vi.advanceTimersByTimeAsync(100);
    h.setTokens(100);
    await vi.advanceTimersByTimeAsync(400);
    const order = h.out.map((o) => `${o.body.h === hashOf(img) ? 'img' : o.body.h === hashOf(a) ? 'a' : 'b'}${o.body.i}`);
    expect(order).toEqual(['img0', 'img1', 'a0', 'a1', 'b0', 'b1']);
  });

  it('counts sound chunks in the LAN egress cap, and stills go first', async () => {
    const h = harness();
    const img = still(EMOTE_CHUNK_BYTES * 2);
    const snd = ogg(EMOTE_CHUNK_BYTES * 6);
    h.files.set(hashOf(img), img);
    h.sounds.set(hashOf(snd), snd);
    h.setAnnounced([hashOf(img)]);
    h.setAnnouncedSounds([hashOf(snd)]);
    for (let n = 0; n < 6; n++) {
      const peer = `${n}`.repeat(16);
      h.routes.set(peer, 'lan');
      h.t.onWant({ ...soundWantOf(hashOf(snd), []), peer });
    }
    h.routes.set(REQUESTER, 'lan');
    h.t.onWant(wantOf(hashOf(img), []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out).toHaveLength(LAN_TOTAL_CHUNKS_PER_TICK);
    expect(h.out.slice(0, 2).map((o) => o.body.h)).toEqual([hashOf(img), hashOf(img)]);
  });
});
