import { createHash } from 'node:crypto';
import { sniffAudio } from '../shared/audioSniff';
import { ROOM_SOUND_MAX_BYTES } from '../shared/emotes';
import { type ChunkMsg, type WantMsg } from '../shared/roomProtocol';
import { checkStill } from './emoteLibrary';

/** One chunk carries this many bytes: 1,000 base64 characters, and a sealed chunk stays under the 1,200-byte packet cap. */
export const EMOTE_CHUNK_BYTES = 750;
/** Assemblies in flight at once, bytes pending in total, and how long an assembly may take. */
export const MAX_ASSEMBLIES = 16;
export const MAX_PENDING_BYTES = 256 * 1024;
export const ASSEMBLY_TIMEOUT_MS = 60_000;
/** Sounds assemble beside the stills, within caps of their own: one per member at a time, a few at once. */
export const SOUND_ASSEMBLIES_MAX = 4;
export const SOUND_PENDING_BYTES = SOUND_ASSEMBLIES_MAX * ROOM_SOUND_MAX_BYTES;
/** A sender streams one sound at a time over relays, so a sound can wait its turn past the still timeout. */
export const SOUND_ASSEMBLY_TIMEOUT_MS = 120_000;
/** Silence before a want for the missing indexes; at most this many re-asks, then the hash waits for the next presence. */
export const REASK_MS = 3_000;
export const REASKS_MAX = 3;
/** Chunk pacing: LAN unicast per requester per tick; over relays a chunk or a want only goes when 5 ping tokens remain. */
export const TRANSFER_TICK_MS = 100;
export const LAN_CHUNKS_PER_TICK = 2;
/** Chunks per tick across every queue and requester: the LAN egress ceiling, ~60 KB/s however many members ask. */
export const LAN_TOTAL_CHUNKS_PER_TICK = 8;
export const RELAY_KEEP_TOKENS = 5;

/** What a hash names: an emote's still, or a sound (the hash of the sound file itself). */
type Kind = 'still' | 'sound';
/** Assemblies and send queues are keyed by kind too: a member can't pass a sound off as a still, or the other way round. */
const keyOf = (kind: Kind, hash: string): string => (kind === 'sound' ? `s:${hash}` : hash);
const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 32);
/** The `k` field a sound's want and chunk carry; a still's carry none, as before sounds travelled. */
const kindField = (kind: Kind): { k?: 's' } => (kind === 'sound' ? { k: 's' } : {});

interface Assembly {
  kind: Kind;
  hash: string;
  /** Chunk count, from the first chunk. 0 until then: a want sent, no bytes yet. */
  n: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** The announcer our wants go to. */
  ask: string;
  /** The first want went out. Over relays it can wait for a spare ping token. */
  asked: boolean;
  reasks: number;
}

interface SendQueue {
  kind: Kind;
  hash: string;
  bytes: Uint8Array;
  n: number;
  /** LAN requesters: chunks go unicast, at most LAN_CHUNKS_PER_TICK per requester per tick. */
  lan: Map<string, Set<number>>;
  /** Chunks that must ride a relay: one broadcast reaches the whole room, gated by the ping bucket. */
  shared: Set<number>;
}

export interface EmoteTransferDeps {
  now(): number;
  /** The still for `hash` is here already: our own library, or the cache. */
  have(hash: string): boolean;
  /** Our own still for `hash`, when it is one of our announced emotes. */
  still(hash: string): Uint8Array | null;
  /** The hashes our presence announces right now. */
  announced(): readonly string[];
  /** The Show friends' custom emotes switch. */
  enabled(): boolean;
  /** Keeps a still that passed the hash and image checks. */
  put(hash: string, bytes: Uint8Array): void;
  /** A friend's sound for `hash` is in the cache already. */
  haveSound(hash: string): boolean;
  /** Our own shared sound announced as `hash`, as its file is now: the emote may have got another sound since. */
  sound(hash: string): Uint8Array | null;
  /** The sound hashes our presence announces right now. */
  announcedSounds(): readonly string[];
  /** The Play friends' emote sounds switch: ask for and keep friends' sounds. */
  fetchSounds(): boolean;
  /** Keeps a sound that passed the hash, type and size checks. Resolves once haveSound() knows it, false when it wasn't kept. */
  putSound(hash: string, bytes: Uint8Array): Promise<boolean>;
  /** How a member is reached right now: a LAN unicast, a relay broadcast, or neither. */
  routeOf(peer: string): 'lan' | 'shared' | null;
  sendToLan(peer: string, body: Record<string, unknown>): void;
  broadcastShared(body: Record<string, unknown>): void;
  /** True when a relay chunk may go: the shared bucket keeps `keep` tokens for pings and emotes. */
  spareSharedToken(keep: number): boolean;
}

/**
 * Moves custom emote stills and their sounds over a room, both ways. A still's ID is the SHA-256 prefix of the still,
 * and a sound is named the same way by its own bytes, so a finished assembly that doesn't hash back to its name is
 * dropped: nobody can substitute another member's image or sound. Bytes are only ever written to the cache as
 * `<hash>.webp` or `<hash>.sound.<type>` and only ever decoded by Chromium as an image or by Web Audio; nothing here
 * executes them. Stills go first: a sound only adds to an emote that shows already.
 *
 * RoomManager emits 'emotes' (a presence's announced hashes and sounds), 'want', 'chunk' and 'memberGone'; this class answers.
 */
export class EmoteTransfer {
  private readonly announcers = new Map<string, Set<string>>();
  /** Per member, in their announced order: each emote's still hash → the hash of its shared sound. */
  private readonly sounds = new Map<string, Map<string, string>>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly sends = new Map<string, SendQueue>();
  /** Sounds verified and on their way to the cache: here already, as far as asking goes. */
  private readonly storing = new Set<string>();
  /** Sounds the cache refused this session (a full disk, say): asking again would only fetch them again. */
  private readonly unkept = new Set<string>();
  /** Sounds whose last assembly gave up: a member's other sounds get their turn first. */
  private readonly gaveUp = new Set<string>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: EmoteTransferDeps) {
    this.timer = setInterval(() => this.tick(), TRANSFER_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * A presence announced `hashes`, and `sounds` beside them ('' for an emote without one): prefetch whatever isn't here
   * yet, on the announcer's route.
   */
  announced(peer: string, hashes: readonly string[], sounds: readonly string[] = []): void {
    this.announcers.set(peer, new Set(hashes));
    const bySound = new Map<string, string>();
    hashes.forEach((hash, i) => {
      if (sounds[i]) bySound.set(hash, sounds[i]);
    });
    this.sounds.set(peer, bySound);
    if (!this.deps.enabled()) return;
    for (const hash of hashes) {
      if (this.deps.have(hash) || this.assemblies.has(keyOf('still', hash))) continue;
      if (this.count('still') >= MAX_ASSEMBLIES) break;
      const asked = this.sendWant(peer, 'still', hash, []);
      this.assemblies.set(keyOf('still', hash), this.assembly('still', hash, peer, asked));
    }
    this.nextSound(peer);
  }

  /** The sound `peer` shares for the emote whose still is `hash`, by the sound's own hash. */
  soundOf(peer: string, hash: string): string | null {
    return this.sounds.get(peer)?.get(hash) ?? null;
  }

  /** Another member asks for one of our stills or sounds. Only hashes in our own current announcement are served. */
  onWant(w: WantMsg): void {
    if (!this.deps.enabled()) return; // the switch stops both directions: nothing of ours leaves either
    const kind: Kind = w.k === 's' ? 'sound' : 'still';
    if (!(kind === 'sound' ? this.deps.announcedSounds() : this.deps.announced()).includes(w.h)) return;
    const lane = this.deps.routeOf(w.peer);
    if (lane !== 'lan' && lane !== 'shared') return;
    let queue = this.sends.get(keyOf(kind, w.h));
    if (!queue) {
      // read once per queue: a flood of wants can't make it read the disk each time
      const bytes = kind === 'sound' ? this.ownSound(w.h) : this.deps.still(w.h);
      if (!bytes) return;
      queue = { kind, hash: w.h, bytes, n: Math.ceil(bytes.length / EMOTE_CHUNK_BYTES), lan: new Map(), shared: new Set() };
      this.sends.set(keyOf(kind, w.h), queue);
    }
    const n = queue.n;
    const want = w.need.length > 0 ? w.need.filter((i) => i < n) : Array.from({ length: n }, (_, i) => i);
    if (want.length === 0) return;
    if (lane === 'lan') {
      const set = queue.lan.get(w.peer) ?? new Set<number>();
      for (const i of want) set.add(i);
      queue.lan.set(w.peer, set);
    } else {
      for (const i of want) queue.shared.add(i); // a broadcast reaches the requester as well as everyone else
    }
  }

  /** One slice of a still or a sound, from the member that announced it. Assemblies finish into the cache once verified. */
  onChunk(c: ChunkMsg): void {
    if (!this.deps.enabled()) return;
    const kind: Kind = c.k === 's' ? 'sound' : 'still';
    // only from a member who announced that hash, as that kind
    if (kind === 'sound' ? !this.deps.fetchSounds() || !this.announcedSound(c.peer, c.h) : !(this.announcers.get(c.peer)?.has(c.h) ?? false)) return;
    const part = Buffer.from(c.b, 'base64');
    const key = keyOf(kind, c.h);
    let a = this.assemblies.get(key);
    if (!a) {
      if (kind === 'sound' ? this.soundHere(c.h) : this.deps.have(c.h)) return; // a straggler chunk must not open a zombie assembly
      if (!this.roomFor(kind, part.length)) return;
      a = this.assembly(kind, c.h, c.peer, true);
      this.assemblies.set(key, a);
    }
    if (a.n === 0) a.n = c.n;
    else if (a.n !== c.n) {
      this.giveUp(key, a); // one sender, two ideas about the length: drop and wait for the next presence
      return;
    }
    if (c.i >= a.n || a.parts.has(c.i)) return;
    a.parts.set(c.i, part);
    a.bytes += part.length;
    a.lastAt = this.deps.now();
    if (kind === 'sound') a.reasks = 0; // a long sound may pause while its sender serves another: only silence in a row gives up
    if (a.parts.size === a.n) this.finish(key, a);
  }

  memberGone(peer: string): void {
    this.announcers.delete(peer);
    this.sounds.delete(peer);
    for (const [key, q] of this.sends) {
      q.lan.delete(peer);
      if (q.lan.size === 0 && q.shared.size === 0) this.sends.delete(key);
    }
    for (const [key, a] of this.assemblies) if (a.ask === peer) this.assemblies.delete(key);
  }

  get stats(): { assembling: number; sending: number } {
    return { assembling: this.assemblies.size, sending: this.sends.size };
  }

  private assembly(kind: Kind, hash: string, ask: string, asked: boolean): Assembly {
    const now = this.deps.now();
    return { kind, hash, n: 0, parts: new Map(), bytes: 0, firstAt: now, lastAt: now, ask, asked, reasks: 0 };
  }

  private count(kind: Kind): number {
    return [...this.assemblies.values()].filter((a) => a.kind === kind).length;
  }

  /** Whether a new assembly of `kind` holding `bytes` fits its caps. */
  private roomFor(kind: Kind, bytes: number): boolean {
    let pending = 0;
    for (const a of this.assemblies.values()) if (a.kind === kind) pending += a.bytes;
    return kind === 'sound'
      ? this.count('sound') < SOUND_ASSEMBLIES_MAX && pending + bytes <= SOUND_PENDING_BYTES
      : this.count('still') < MAX_ASSEMBLIES && pending + bytes <= MAX_PENDING_BYTES;
  }

  private announcedSound(peer: string, hash: string): boolean {
    return [...(this.sounds.get(peer)?.values() ?? [])].includes(hash);
  }

  /** In the cache, on its way there, or refused by it: nothing to ask for. */
  private soundHere(hash: string): boolean {
    return this.deps.haveSound(hash) || this.storing.has(hash) || this.unkept.has(hash);
  }

  /** Drops an assembly that failed; a sound that failed waits behind its member's other sounds. */
  private giveUp(key: string, a: Assembly): void {
    this.assemblies.delete(key);
    if (a.kind === 'sound') this.gaveUp.add(a.hash);
  }

  /** Our sound file for `hash`, only while it still hashes to it and fits the room cap. */
  private ownSound(hash: string): Uint8Array | null {
    const bytes = this.deps.sound(hash);
    return bytes && bytes.length <= ROOM_SOUND_MAX_BYTES && hashOf(bytes) === hash ? bytes : null;
  }

  /**
   * Asks `peer` for their next sound we don't have, in their announced order: one at a time per member, and only once
   * their stills are in. One that gave up goes after the rest, so it can't hold them back. Called on their presence and
   * when one of their assemblies finishes.
   */
  private nextSound(peer: string): void {
    if (!this.deps.enabled() || !this.deps.fetchSounds()) return;
    const busy = [...this.assemblies.values()].some((a) => a.ask === peer);
    if (busy || this.count('sound') >= SOUND_ASSEMBLIES_MAX) return;
    const missing = [...(this.sounds.get(peer)?.values() ?? [])]
      .filter((hash) => !this.soundHere(hash) && !this.assemblies.has(keyOf('sound', hash)));
    if (missing.length === 0) return;
    let hash = missing.find((h) => !this.gaveUp.has(h));
    if (!hash) {
      for (const h of missing) this.gaveUp.delete(h); // every one gave up: start over with the first
      hash = missing[0];
    }
    const asked = this.sendWant(peer, 'sound', hash, []);
    this.assemblies.set(keyOf('sound', hash), this.assembly('sound', hash, peer, asked));
  }

  /** The finished assembly, in chunk order: kept only when it hashes back to its name and is a file this app would import. */
  private finish(key: string, a: Assembly): void {
    this.assemblies.delete(key);
    const full = new Uint8Array(a.bytes);
    let at = 0;
    for (let i = 0; i < a.n; i++) {
      const part = a.parts.get(i);
      if (!part) return; // finish only runs once every index is in
      full.set(part, at);
      at += part.length;
    }
    if (hashOf(full) !== a.hash) return this.giveUp(key, a);
    if (a.kind === 'still') {
      if (checkStill(full) !== null) return;
      this.deps.put(a.hash, full);
      this.nextSound(a.ask);
      return;
    }
    if (full.length > ROOM_SOUND_MAX_BYTES || !sniffAudio(full)) return this.giveUp(key, a);
    this.gaveUp.delete(a.hash);
    this.storing.add(a.hash);
    // The next sound is picked once this one is in the cache, or it would look missing and be fetched again.
    void this.deps.putSound(a.hash, full).catch(() => false).then((kept) => {
      this.storing.delete(a.hash);
      if (!kept) this.unkept.add(a.hash);
      this.nextSound(a.ask);
    });
  }

  /** False when it didn't go: no route, or no spare relay token (joining a room can find 9 hashes per member at once). */
  private sendWant(peer: string, kind: Kind, hash: string, need: readonly number[]): boolean {
    const body = { t: 'want', to: peer, h: hash, need: [...need], ...kindField(kind) };
    const lane = this.deps.routeOf(peer);
    if (lane === 'lan') this.deps.sendToLan(peer, body);
    else if (lane === 'shared' && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) this.deps.broadcastShared(body); // `to` addresses it, the seal protects it
    else return false;
    return true;
  }

  private chunkBody(q: SendQueue, i: number): Record<string, unknown> {
    const slice = q.bytes.subarray(i * EMOTE_CHUNK_BYTES, Math.min((i + 1) * EMOTE_CHUNK_BYTES, q.bytes.length));
    return { t: 'chunk', h: q.hash, i, n: q.n, b: Buffer.from(slice).toString('base64'), ...kindField(q.kind) };
  }

  /** Sender pacing and receiver re-asks. Anything thrown is dropped: a timer must never take the app down. */
  private tick(): void {
    try {
      if (!this.deps.enabled()) {
        this.assemblies.clear(); // the switch stops both directions: pending work is dropped, not paused
        this.sends.clear();
        return;
      }
      if (!this.deps.fetchSounds()) {
        for (const [key, a] of this.assemblies) if (a.kind === 'sound') this.assemblies.delete(key);
      }
      let egress = 0; // chunks sent this tick, across every queue and requester
      let relaySound = false; // over relays, one sound streams at a time: its listeners finish before the next starts
      const ours = { still: new Set(this.deps.announced()), sound: new Set(this.deps.announcedSounds()) };
      // Stills first, in the order they were asked for, then sounds (sort keeps that order within a kind).
      const queues = [...this.sends].sort(([, a], [, b]) => (a.kind === b.kind ? 0 : a.kind === 'still' ? -1 : 1));
      for (const [key, q] of queues) {
        if (!ours[q.kind].has(q.hash)) {
          this.sends.delete(key); // the emote left our wheel, or its sound stopped being shared: nobody may still be served it
          continue;
        }
        for (const [peer, need] of [...q.lan]) {
          for (let k = 0; k < LAN_CHUNKS_PER_TICK && need.size > 0 && egress < LAN_TOTAL_CHUNKS_PER_TICK; k++) {
            const i = need.values().next().value as number;
            need.delete(i);
            this.deps.sendToLan(peer, this.chunkBody(q, i));
            egress++;
          }
          if (need.size === 0) q.lan.delete(peer);
        }
        if (q.shared.size > 0 && !(q.kind === 'sound' && relaySound)) {
          if (q.kind === 'sound') relaySound = true;
          if (this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) {
            const i = q.shared.values().next().value as number;
            q.shared.delete(i);
            this.deps.broadcastShared(this.chunkBody(q, i));
          }
        }
        if (q.lan.size === 0 && q.shared.size === 0) this.sends.delete(key);
      }
      const now = this.deps.now();
      for (const [key, a] of [...this.assemblies]) {
        if (a.n > 0 && a.parts.size === a.n) continue; // completes inside onChunk
        const announced = a.kind === 'sound' ? this.announcedSound(a.ask, a.hash) : (this.announcers.get(a.ask)?.has(a.hash) ?? false);
        if (!announced) {
          this.assemblies.delete(key);
          continue;
        }
        if (now - a.firstAt >= (a.kind === 'sound' ? SOUND_ASSEMBLY_TIMEOUT_MS : ASSEMBLY_TIMEOUT_MS)) {
          this.giveUp(key, a);
          continue;
        }
        if (!a.asked) {
          a.asked = this.sendWant(a.ask, a.kind, a.hash, []);
          a.lastAt = now;
          continue;
        }
        if (now - a.lastAt < REASK_MS) continue;
        if (a.reasks >= REASKS_MAX) {
          this.giveUp(key, a); // the next presence starts over
          continue;
        }
        const need = a.n === 0 ? [] : Array.from({ length: a.n }, (_, i) => i).filter((i) => !a.parts.has(i));
        if (!this.sendWant(a.ask, a.kind, a.hash, need)) continue; // waits for a token: not a re-ask yet
        a.reasks++;
        a.lastAt = now;
      }
    } catch {
      // a send that failed (a packet that wouldn't seal, a route that vanished) waits for the next tick
    }
  }
}
