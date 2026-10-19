import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sniffAudio } from '../shared/audioSniff';
import { HASH_RE, isCustomRef } from '../shared/emotes';
import { renameWithRetry } from './settingsStore';

/** At most this many stills and this many bytes of friends' emotes are kept; the rest is evicted least recently used first. */
export const CACHE_MAX_FILES = 200;
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;
/** Friends' sounds have a budget of their own, so a sound never pushes a still out: 15 members × 9 room-sized sounds fit. */
export const SOUND_CACHE_MAX_FILES = 200;
export const SOUND_CACHE_MAX_BYTES = 9 * 1024 * 1024;
/** A crashed put leaves a `.tmp` behind; a live one owns its file for milliseconds, so only tmp this old is swept. */
const STALE_TMP_MS = 5 * 60_000;
const NAME_RE = /^([0-9a-f]{32})\.webp$/;
const SOUND_RE = /^([0-9a-f]{32})\.sound\.(?:ogg|mp3|wav)$/;

/** A file on disk: its name, its size and when it was last stored or used (the file's mtime after a launch). */
type Entry = { name: string; size: number; at: number };

/** One kind of file with its own caps. Kept in use order too, so a tie on `at` goes to the newer use. */
interface Shelf {
  entries: Map<string, Entry>;
  maxFiles: number;
  maxBytes: number;
}

/**
 * Owns `<settings folder>/emote-cache/`: verified stills (`<hash>.webp`) and sounds (`<hash>.sound.<type>`, named by the
 * sound's own hash) that arrived over a room, each capped and evicted by last use.
 */
export class EmoteCache {
  readonly dir: string;
  private stills: Shelf = { entries: new Map(), maxFiles: CACHE_MAX_FILES, maxBytes: CACHE_MAX_BYTES };
  private sounds: Shelf = { entries: new Map(), maxFiles: SOUND_CACHE_MAX_FILES, maxBytes: SOUND_CACHE_MAX_BYTES };
  /** Set after the first write failure, so the log says so once: received stills stay unavailable (the placeholder). */
  private broken = false;

  constructor(dir: string, private readonly now: () => number) {
    this.dir = dir;
  }

  /** Reads what earlier sessions left behind. Run once at launch, before anything asks has(). */
  async present(): Promise<void> {
    await this.sweep();
  }

  has(hash: string): boolean {
    return this.stills.entries.has(hash);
  }

  hasSound(hash: string): boolean {
    return this.sounds.entries.has(hash);
  }

  /** A display showed this emote: it counts as the most recently used. */
  touch(hash: string): void {
    this.use(this.stills, hash);
  }

  /** An overlay is about to play this sound: it counts as the most recently used. */
  touchSound(hash: string): void {
    this.use(this.sounds, hash);
  }

  /** Stores a still that has already been verified against its hash and image header. False when the disk refused. */
  async put(hash: string, bytes: Uint8Array): Promise<boolean> {
    if (!isCustomRef(`c:${hash}`)) return false;
    return this.store(this.stills, hash, `${hash}.webp`, bytes);
  }

  /** Stores a sound already verified against its hash, under the type its first bytes name. False for anything else. */
  async putSound(hash: string, bytes: Uint8Array): Promise<boolean> {
    const type = sniffAudio(bytes);
    if (!HASH_RE.test(hash) || !type) return false;
    return this.store(this.sounds, hash, `${hash}.sound.${type}`, bytes);
  }

  /** Rebuilds the index from the folder, applies the caps and removes old temp files. A put only evicts. */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return; // nothing cached yet, or the folder can't be read: empty until a put succeeds
    }
    const stills = new Map<string, Entry>();
    const sounds = new Map<string, Entry>();
    for (const name of names) {
      const still = NAME_RE.exec(name);
      const sound = SOUND_RE.exec(name);
      const tmp = name.endsWith('.tmp');
      if (!still && !sound && !tmp) continue;
      try {
        const s = await stat(join(this.dir, name));
        if (still) stills.set(still[1], { name, size: s.size, at: this.stills.entries.get(still[1])?.at ?? s.mtimeMs });
        else if (sound) sounds.set(sound[1], { name, size: s.size, at: this.sounds.entries.get(sound[1])?.at ?? s.mtimeMs });
        else if (this.now() - s.mtimeMs > STALE_TMP_MS) await rm(join(this.dir, name), { force: true }).catch(() => undefined);
      } catch {
        // gone between readdir and stat: it is no longer served either
      }
    }
    this.stills.entries = stills;
    this.sounds.entries = sounds;
    await this.evict(this.stills);
    await this.evict(this.sounds);
  }

  private async store(shelf: Shelf, hash: string, name: string, bytes: Uint8Array): Promise<boolean> {
    const tmp = join(this.dir, `${name}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, bytes);
      await renameWithRetry(tmp, join(this.dir, name));
      this.use(shelf, hash, { name, size: bytes.length });
      await this.evict(shelf);
      return true;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (!this.broken) {
        this.broken = true;
        console.warn('[emotes] emote cache unavailable:', (err as Error).message);
      }
      return false;
    }
  }

  /** Marks `hash` used now; `file` is a new or replaced file, otherwise only a known one is touched. */
  private use(shelf: Shelf, hash: string, file?: { name: string; size: number }): void {
    const e = file ?? shelf.entries.get(hash);
    if (!e) return;
    shelf.entries.delete(hash);
    shelf.entries.set(hash, { name: e.name, size: e.size, at: this.now() });
  }

  /** Keeps at most the shelf's file and byte caps, evicting the least recently used. */
  private async evict(shelf: Shelf): Promise<void> {
    const byUse = [...shelf.entries].reverse().sort((a, b) => b[1].at - a[1].at);
    let files = 0;
    let bytes = 0;
    for (const [hash, e] of byUse) {
      if (files < shelf.maxFiles && bytes + e.size <= shelf.maxBytes) {
        files++;
        bytes += e.size;
        continue;
      }
      shelf.entries.delete(hash); // has() says no at once, before the file is gone
      await rm(join(this.dir, e.name), { force: true }).catch(() => undefined);
    }
  }
}
