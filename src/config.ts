import { readFileSync } from 'node:fs';

/** Settings from config.json in the project root. Restart the bot after changing them. */
export interface Config {
  /** Minutes to stay in voice with an empty queue before leaving. */
  idleLeaveMinutes: number;
  /** Most songs a single playlist link may add. */
  playlistLimit: number;
  /** Audio quality sent to Discord, in kbps (8-512). Discord caps what listeners hear by channel bitrate. */
  audioBitrateKbps: number;
  /** Repeat mode the bot starts in, and returns to after /stop: "off", "song" or "queue". */
  defaultRepeat: 'off' | 'song' | 'queue';
  /** How many upcoming songs /queue lists. */
  queuePageSize: number;
  /** After this many failed songs in a row the queue is cleared. */
  maxConsecutiveFailures: number;
  /** Volume in percent the bot starts with (100 = original loudness). Change it live with /volume. */
  defaultVolume: number;
}

const defaults: Config = {
  idleLeaveMinutes: 5,
  playlistLimit: 100,
  audioBitrateKbps: 128,
  defaultRepeat: 'off',
  queuePageSize: 10,
  maxConsecutiveFailures: 5,
  defaultVolume: 100,
};

const limits: Record<Exclude<keyof Config, 'defaultRepeat'>, [min: number, max: number]> = {
  idleLeaveMinutes: [0, 24 * 60],
  playlistLimit: [1, 1000],
  audioBitrateKbps: [8, 512],
  queuePageSize: [1, 15],
  maxConsecutiveFailures: [1, 100],
  defaultVolume: [1, 200],
};

function load(): Config {
  // Works from both src/ (dev) and dist/ (built): config.json sits one level up.
  const path = new URL('../config.json', import.meta.url);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    console.warn(`config.json ${missing ? 'not found' : `is invalid (${(err as Error).message})`}, using defaults`);
    return defaults;
  }

  const config = { ...defaults };
  for (const [key, [min, max]] of Object.entries(limits) as [keyof typeof limits, [number, number]][]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && value >= min && value <= max) config[key] = value;
    else console.warn(`config.json: "${key}" must be a number from ${min} to ${max}, using ${defaults[key]}`);
  }
  const repeat = raw.defaultRepeat;
  if (repeat === 'off' || repeat === 'song' || repeat === 'queue') config.defaultRepeat = repeat;
  else if (repeat !== undefined) console.warn('config.json: "defaultRepeat" must be "off", "song" or "queue", using "off"');
  return config;
}

export const config: Config = load();
