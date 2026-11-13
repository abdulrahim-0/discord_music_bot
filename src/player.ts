import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import { escapeMarkdown, type VoiceBasedChannel } from 'discord.js';
import { config } from './config.ts';

const execFileAsync = promisify(execFile);

/** A song that ends with less audio than this actually played is treated as failed. */
const MIN_PLAYED_MS = 1_000;
/** How many recently played videos autoplay avoids picking again. */
const AUTOPLAY_HISTORY = 50;
/** How many finished songs /previous can step back through. */
const HISTORY_SIZE = 50;

export type RepeatMode = 'off' | 'song' | 'queue';

export interface Track {
  title: string;
  url: string;
  /** Human-readable length such as "3:55", or "live". */
  duration: string;
  /** Length in seconds, or null for live streams and unknown lengths. */
  durationSec: number | null;
  requestedBy: string;
  /** Picked by autoplay rather than requested by someone. */
  auto?: boolean;
}

/**
 * Why the current song is ending:
 * normal = it finished by itself, skip = someone skipped it,
 * arranged = the caller (/previous, /jump) already put the queue in its final order,
 * restart = same song again from another position (seek, replay, volume).
 */
type Transition = 'normal' | 'skip' | 'arranged' | 'restart';

/** YouTube video ID of a URL, or null for anything that isn't a YouTube video. */
function videoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    if (!u.hostname.endsWith('youtube.com')) return null;
    return u.searchParams.get('v') ?? /^\/(?:shorts|live)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Run yt-dlp on a URL or search and return the tracks it lists. */
async function lookup(target: string, playlistEnd: number | null, requestedBy: string, auto = false): Promise<Track[]> {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      ...(playlistEnd !== null
        ? ['--flat-playlist', '--yes-playlist', '--playlist-end', String(playlistEnd)]
        : ['--no-playlist']),
      '--no-warnings',
      '--print',
      '%(.{title,url,webpage_url,duration,duration_string})j',
      '--',
      target,
    ],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );

  const tracks: Track[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const info = JSON.parse(line) as {
      title?: string;
      url?: string;
      webpage_url?: string;
      duration?: number | null;
      duration_string?: string;
    };
    const url = info.webpage_url ?? info.url;
    if (!url) continue;
    const track: Track = {
      title: info.title ?? 'Unknown title',
      url,
      duration: info.duration_string ?? 'live',
      durationSec: typeof info.duration === 'number' && info.duration > 0 ? info.duration : null,
      requestedBy,
    };
    if (auto) track.auto = true;
    tracks.push(track);
  }
  return tracks;
}

/**
 * Look up a URL (or search terms) with yt-dlp.
 * Returns one track, or every track of a playlist when the link has a `list=` parameter.
 */
export async function resolveTracks(query: string, requestedBy: string): Promise<Track[]> {
  const isUrl = /^https?:\/\//i.test(query);
  const isPlaylist = isUrl && /[?&]list=/.test(query);
  const tracks = await lookup(
    isUrl ? query : `ytsearch1:${query}`,
    isPlaylist ? config.playlistLimit : null,
    requestedBy,
  );
  if (tracks.length === 0) throw new Error('No results found.');
  return tracks;
}

/**
 * Find a song similar to `seed` using its YouTube Mix, skipping recently played videos.
 * Returns null when the seed isn't a YouTube video or nothing new is found.
 */
export async function resolveRelated(seed: Track, recent: readonly string[]): Promise<Track | null> {
  const id = videoId(seed.url);
  if (!id) return null;
  const mix = await lookup(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, 25, 'autoplay', true);
  return (
    mix.find((t) => {
      const candidate = videoId(t.url);
      return candidate !== null && candidate !== id && !recent.includes(candidate);
    }) ?? null
  );
}

export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | null = null;
  /** off: play through once, song: loop the current song, queue: loop the whole queue. */
  repeat: RepeatMode = config.defaultRepeat;
  /** Called with a message for the text channel when something goes wrong during playback. */
  onNotice: ((message: string) => void) | null = null;

  private readonly guildId: string;
  private readonly audio = createAudioPlayer();
  private connection: VoiceConnection | null = null;
  private procs: ChildProcess[] = [];
  private leaveTimer: NodeJS.Timeout | null = null;
  private resource: AudioResource | null = null;
  /** Where in the song the current stream started (after a seek), in ms. */
  private offsetMs = 0;
  private transition: Transition = 'normal';
  private restartAtSec = 0;
  private failures = 0;
  private volumePercent = config.defaultVolume;
  /** Finished songs, oldest first, for /previous. */
  private history: Track[] = [];
  /** When on, a similar song is picked whenever the queue runs out. */
  private autoplayOn = false;
  private lastTrack: Track | null = null;
  private recent: string[] = [];
  private autoplayRun = 0;

  constructor(guildId: string) {
    this.guildId = guildId;
    this.audio.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.audio.on('error', (err) => console.error(`[${guildId}] player error:`, err.message));
  }

  get paused(): boolean {
    return this.audio.state.status === AudioPlayerStatus.Paused;
  }

  get connected(): boolean {
    return this.connection !== null;
  }

  /** Position in the current song, in seconds. */
  get positionSec(): number {
    return Math.floor((this.offsetMs + (this.resource?.playbackDuration ?? 0)) / 1000);
  }

  get volume(): number {
    return this.volumePercent;
  }

  get autoplay(): boolean {
    return this.autoplayOn;
  }

  get hasPrevious(): boolean {
    return this.history.length > 0;
  }

  setAutoplay(on: boolean): void {
    this.autoplayOn = on;
    this.autoplayRun++; // cancels a lookup that is still in flight
    // Turned on while sitting idle in voice: start right away from the last song.
    if (on && !this.current && this.connection && this.lastTrack) void this.queueRelated(this.lastTrack);
  }

  /** Join (or move to) a voice channel. */
  async connect(channel: VoiceBasedChannel): Promise<void> {
    if (this.connection?.joinConfig.channelId === channel.id) return;
    this.connection?.destroy();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    this.connection = connection;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved to another channel or brief network drop: it will recover by itself.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // Really kicked / disconnected.
        if (this.connection === connection) this.stop();
        else if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      if (this.connection === connection) this.connection = null;
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw new Error('Could not connect to the voice channel.', { cause: err });
    }
    connection.subscribe(this.audio);
  }

  /**
   * Add tracks to the end of the queue, or to the front with `atFront`.
   * Starts playback if nothing is playing. Returns the queue position of the first
   * added track (0 = it is playing now).
   */
  add(tracks: Track[], atFront = false): number {
    if (tracks.length === 0) return this.queue.length;
    if (atFront) this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    if (!this.current) {
      this.playNext();
      return 0;
    }
    return atFront ? 1 : this.queue.length - tracks.length + 1;
  }

  /** Skip to the next song. */
  skip(): boolean {
    if (!this.current) return false;
    this.end('skip');
    return true;
  }

  /** Skip straight to a queue position (1 = next song). Returns the song jumped to. */
  jump(position: number): Track | null {
    const target = this.queue[position - 1];
    if (!target || !this.current) return null;
    const passed = this.queue.splice(0, position - 1);
    if (this.repeat === 'queue') {
      // Looping: the current song and the ones jumped over come round again, in their original order.
      this.queue.push(this.current, ...passed);
      this.remember(this.current);
      this.end('arranged');
    } else {
      this.end('skip');
    }
    return target;
  }

  /** Go back to the song that played before this one. */
  previous(): Track | null {
    // With repeat-song the current song is also the newest history entry; step past it.
    while (this.history.length > 0 && this.history.at(-1) === this.current) this.history.pop();
    const prev = this.history.pop();
    if (!prev) return null;
    if (this.repeat === 'queue') {
      // In queue-repeat the finished song was also re-added at the end; don't play it twice.
      const dup = this.queue.lastIndexOf(prev);
      if (dup !== -1) this.queue.splice(dup, 1);
    }
    if (this.current) {
      this.queue.unshift(prev, this.current); // current song comes right after it again
      this.end('arranged');
    } else {
      this.queue.unshift(prev);
      this.playNext();
    }
    return prev;
  }

  /** Jump to a position in the current song. */
  seek(seconds: number): boolean {
    if (!this.current) return false;
    this.restartAtSec = Math.max(0, Math.floor(seconds));
    this.end('restart');
    return true;
  }

  /** Start the current song again from the beginning. */
  replay(): boolean {
    return this.seek(0);
  }

  /** Set the volume in percent (100 = original). Applies to the current song right away. */
  setVolume(percent: number): void {
    this.volumePercent = percent;
    // Volume is applied by ffmpeg, so the stream is restarted at the current position.
    if (this.current) this.seek(this.positionSec);
  }

  pause(): boolean {
    return this.audio.pause();
  }

  resume(): boolean {
    return this.audio.unpause();
  }

  /** Remove the song at a queue position (1 = next song). */
  remove(position: number): Track | null {
    if (!Number.isInteger(position) || position < 1 || position > this.queue.length) return null;
    return this.queue.splice(position - 1, 1)[0] ?? null;
  }

  /** Move a queued song to another position. */
  move(from: number, to: number): Track | null {
    const size = this.queue.length;
    if (from < 1 || from > size || to < 1 || to > size) return null;
    const [track] = this.queue.splice(from - 1, 1);
    if (!track) return null;
    this.queue.splice(to - 1, 0, track);
    return track;
  }

  /** Shuffle the upcoming songs. Returns how many were shuffled. */
  shuffle(): number {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    }
    return this.queue.length;
  }

  /** Remove all upcoming songs but keep the current one playing. Returns how many were removed. */
  clear(): number {
    const removed = this.queue.length;
    this.queue.length = 0;
    return removed;
  }

  /** Clear everything and leave the voice channel. */
  stop(): void {
    this.queue.length = 0;
    this.history.length = 0;
    this.current = null;
    this.repeat = config.defaultRepeat;
    this.failures = 0;
    this.transition = 'normal';
    this.autoplayRun++;
    this.clearLeaveTimer();
    this.killProcs();
    // Detach the connection first: stopping the audio fires Idle -> playNext,
    // which must not schedule a new leave timer for a connection we are closing.
    const connection = this.connection;
    this.connection = null;
    this.audio.stop(true);
    this.resource = null;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
  }

  /** End the current stream; playNext() then decides what follows based on `transition`. */
  private end(transition: Transition): void {
    this.transition = transition;
    // Stopping fires Idle -> playNext synchronously. If the player was somehow idle already, call it directly.
    if (!this.audio.stop(true)) this.playNext();
  }

  private playNext(): void {
    this.killProcs();

    const finished = this.current;
    const transition = this.transition;
    const played = this.resource?.playbackDuration ?? 0;
    const startedFromBeginning = this.offsetMs === 0;
    this.transition = 'normal';
    this.resource = null;

    // Seek / replay / volume change: same song, new position.
    if (finished && transition === 'restart') {
      this.startStream(finished, this.restartAtSec);
      return;
    }

    // Decide what happens to the song that just ended.
    let gaveUp = false;
    if (finished) {
      if (transition === 'normal' && startedFromBeginning && played < MIN_PLAYED_MS) {
        // Nothing was heard: removed, blocked or age-restricted video, or yt-dlp is broken.
        // Never repeat it, otherwise a bad link would loop forever.
        this.failures++;
        console.error(`[${this.guildId}] "${finished.title}" failed to play`);
        if (this.failures >= config.maxConsecutiveFailures) {
          this.queue.length = 0;
          this.failures = 0;
          gaveUp = true; // also stops autoplay from picking yet another song
          this.onNotice?.('⚠️ Several songs in a row failed to play, so I cleared the queue. `yt-dlp` may need updating.');
        } else if (!finished.auto) {
          // Autoplay picks fail silently; nobody asked for that exact song.
          this.onNotice?.(`⚠️ Couldn't play **${escapeMarkdown(finished.title)}**, skipping it.`);
        }
      } else if (transition !== 'arranged') {
        if (transition === 'normal') this.failures = 0;
        this.remember(finished);
        if (this.repeat === 'song' && transition === 'normal') this.queue.unshift(finished);
        else if (this.repeat === 'queue') this.queue.push(finished);
      }
    }

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      if (this.connection) {
        this.clearLeaveTimer();
        this.leaveTimer = setTimeout(() => this.stop(), config.idleLeaveMinutes * 60_000);
        if (this.autoplayOn && !gaveUp && this.lastTrack) void this.queueRelated(this.lastTrack);
      }
      return;
    }
    this.clearLeaveTimer();
    this.current = next;
    this.lastTrack = next;
    const id = videoId(next.url);
    if (id && this.recent.at(-1) !== id) {
      this.recent.push(id);
      if (this.recent.length > AUTOPLAY_HISTORY) this.recent.shift();
    }
    this.startStream(next, 0);
  }

  /** Add a finished song to the /previous history. */
  private remember(track: Track): void {
    if (this.history.at(-1) === track) return;
    this.history.push(track);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
  }

  /** Start streaming a track into the voice connection, optionally from a position in seconds. */
  private startStream(track: Track, offsetSec: number): void {
    this.offsetMs = offsetSec * 1000;

    // yt-dlp downloads the best audio stream -> ffmpeg transcodes to Ogg/Opus,
    // which Discord can send directly without any extra encoder library.
    const ytdlp = spawn(
      'yt-dlp',
      ['--no-playlist', '--quiet', '--no-warnings', '-f', 'bestaudio/best', '-o', '-', '--', track.url],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-i', 'pipe:0',
        ...(offsetSec > 0 ? ['-ss', String(offsetSec)] : []),
        '-vn',
        ...(this.volumePercent !== 100 ? ['-af', `volume=${this.volumePercent / 100}`] : []),
        '-c:a', 'libopus',
        '-b:a', `${config.audioBitrateKbps}k`,
        '-ar', '48000',
        '-ac', '2',
        '-f', 'ogg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.procs = [ytdlp, ffmpeg];

    const tag = `[${this.guildId}]`;
    ytdlp.stderr.on('data', (d: Buffer) => console.error(`${tag} yt-dlp: ${d.toString().trim()}`));
    ffmpeg.stderr.on('data', (d: Buffer) => console.error(`${tag} ffmpeg: ${d.toString().trim()}`));
    ytdlp.on('error', (err) => console.error(`${tag} failed to start yt-dlp:`, err.message));
    ffmpeg.on('error', (err) => console.error(`${tag} failed to start ffmpeg:`, err.message));
    // Pipes break on skip/stop when the processes are killed; that is expected.
    ytdlp.stdout.on('error', () => {});
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdout.on('error', () => {});
    ytdlp.stdout.pipe(ffmpeg.stdin);

    this.resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    this.audio.play(this.resource);
  }

  /** Autoplay: look up a song similar to `seed` and play it, unless something changed meanwhile. */
  private async queueRelated(seed: Track): Promise<void> {
    const run = ++this.autoplayRun;
    try {
      const track = await resolveRelated(seed, this.recent);
      if (run !== this.autoplayRun || !this.autoplayOn || !this.connection || this.current) return;
      if (track) this.add([track]);
      else console.error(`[${this.guildId}] autoplay found nothing similar to "${seed.title}"`);
    } catch (err) {
      console.error(`[${this.guildId}] autoplay lookup failed:`, err instanceof Error ? err.message : err);
    }
  }

  private killProcs(): void {
    for (const p of this.procs) {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    }
    this.procs = [];
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }
}

const players = new Map<string, GuildPlayer>();

export function getPlayer(guildId: string): GuildPlayer {
  let player = players.get(guildId);
  if (!player) {
    player = new GuildPlayer(guildId);
    players.set(guildId, player);
  }
  return player;
}

/** Stop every player and leave all voice channels (used on shutdown). */
export function stopAll(): void {
  for (const player of players.values()) player.stop();
}
