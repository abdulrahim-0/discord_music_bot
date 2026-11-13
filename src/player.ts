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

export type RepeatMode = 'off' | 'song' | 'queue';

export interface Track {
  title: string;
  url: string;
  duration: string;
  requestedBy: string;
}

/**
 * Look up a URL (or search terms) with yt-dlp.
 * Returns one track, or every track of a playlist when the link has a `list=` parameter.
 */
export async function resolveTracks(query: string, requestedBy: string): Promise<Track[]> {
  const isUrl = /^https?:\/\//i.test(query);
  const isPlaylist = isUrl && /[?&]list=/.test(query);
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      ...(isPlaylist
        ? ['--flat-playlist', '--yes-playlist', '--playlist-end', String(config.playlistLimit)]
        : ['--no-playlist']),
      '--no-warnings',
      '--print',
      '%(.{title,url,webpage_url,duration_string})j',
      '--',
      isUrl ? query : `ytsearch1:${query}`,
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
      duration_string?: string;
    };
    const url = info.webpage_url ?? info.url;
    if (!url) continue;
    tracks.push({
      title: info.title ?? 'Unknown title',
      url,
      duration: info.duration_string ?? 'live',
      requestedBy,
    });
  }
  if (tracks.length === 0) throw new Error('No results found.');
  return tracks;
}

export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | null = null;
  /** off: play through once, song: loop the current song, queue: loop the whole queue. */
  repeat: RepeatMode = config.defaultRepeat;

  private readonly guildId: string;
  private readonly audio = createAudioPlayer();
  private connection: VoiceConnection | null = null;
  private procs: ChildProcess[] = [];
  private leaveTimer: NodeJS.Timeout | null = null;
  private resource: AudioResource | null = null;
  private skipping = false;
  private failures = 0;
  /** Called with a message for the text channel when something goes wrong during playback. */
  onNotice: ((message: string) => void) | null = null;

  constructor(guildId: string) {
    this.guildId = guildId;
    this.audio.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.audio.on('error', (err) => console.error(`[${guildId}] player error:`, err.message));
  }

  get paused(): boolean {
    return this.audio.state.status === AudioPlayerStatus.Paused;
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

  /** Add a track; starts playback if nothing is playing. Returns the queue position (0 = playing now). */
  enqueue(track: Track): number {
    this.queue.push(track);
    if (!this.current) {
      this.playNext();
      return 0;
    }
    return this.queue.length;
  }

  skip(): boolean {
    if (!this.current) return false;
    this.skipping = true; // a skipped song is not replayed in "song" repeat mode
    this.audio.stop(true); // triggers Idle -> playNext
    return true;
  }

  pause(): boolean {
    return this.audio.pause();
  }

  resume(): boolean {
    return this.audio.unpause();
  }

  /** Clear everything and leave the voice channel. */
  stop(): void {
    this.queue.length = 0;
    this.current = null;
    this.repeat = config.defaultRepeat;
    this.failures = 0;
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

  private playNext(): void {
    this.killProcs();

    // Decide what happens to the song that just ended.
    const finished = this.current;
    const skipped = this.skipping;
    const played = this.resource?.playbackDuration ?? 0;
    this.skipping = false;
    this.resource = null;
    if (finished) {
      if (!skipped && played < MIN_PLAYED_MS) {
        // Nothing was heard: removed, blocked or age-restricted video, or yt-dlp is broken.
        // Never repeat it, otherwise a bad link would loop forever.
        this.failures++;
        console.error(`[${this.guildId}] "${finished.title}" failed to play`);
        if (this.failures >= config.maxConsecutiveFailures) {
          this.queue.length = 0;
          this.failures = 0;
          this.onNotice?.('⚠️ Several songs in a row failed to play, so I cleared the queue. `yt-dlp` may need updating.');
        } else {
          this.onNotice?.(`⚠️ Couldn't play **${escapeMarkdown(finished.title)}**, skipping it.`);
        }
      } else {
        if (!skipped) this.failures = 0;
        if (this.repeat === 'song' && !skipped) this.queue.unshift(finished);
        else if (this.repeat === 'queue') this.queue.push(finished);
      }
    }

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      if (this.connection) {
        this.clearLeaveTimer();
        this.leaveTimer = setTimeout(() => this.stop(), config.idleLeaveMinutes * 60_000);
      }
      return;
    }
    this.clearLeaveTimer();
    this.current = next;

    // yt-dlp downloads the best audio stream -> ffmpeg transcodes to Ogg/Opus,
    // which Discord can send directly without any extra encoder library.
    const ytdlp = spawn(
      'yt-dlp',
      ['--no-playlist', '--quiet', '--no-warnings', '-f', 'bestaudio/best', '-o', '-', '--', next.url],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const ffmpeg = spawn(
      'ffmpeg',
      ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', `${config.audioBitrateKbps}k`, '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'],
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
