import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from './config.ts';
import { getPlayer, resolveTracks, type GuildPlayer, type RepeatMode, type Track } from './player.ts';

const queryOption = (o: import('discord.js').SlashCommandStringOption) =>
  o.setName('query').setDescription('YouTube video/playlist URL or search terms').setRequired(true);

const builders = [
  // --- Adding music ---
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube video or playlist link (or search for a song)')
    .addStringOption(queryOption),
  new SlashCommandBuilder()
    .setName('playnext')
    .setDescription('Like /play, but puts the song at the front of the queue')
    .addStringOption(queryOption),

  // --- Moving between songs ---
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip to the next song, or start the same song again')
    .addStringOption((o) =>
      o
        .setName('to')
        .setDescription('What to play after skipping (default: next song)')
        .addChoices(
          { name: 'Next song', value: 'next' },
          { name: 'Same song (start it again)', value: 'same' },
        ),
    ),
  new SlashCommandBuilder().setName('previous').setDescription('Go back to the song that played before this one'),
  new SlashCommandBuilder().setName('replay').setDescription('Start the current song again from the beginning'),
  new SlashCommandBuilder()
    .setName('jump')
    .setDescription('Skip straight to a song in the queue')
    .addIntegerOption((o) =>
      o.setName('position').setDescription('Queue number from /queue').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a time in the current song')
    .addStringOption((o) =>
      o.setName('time').setDescription('For example 90, 1:30 or 1:02:03').setRequired(true),
    ),

  // --- Playback ---
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or set the volume')
    .addIntegerOption((o) =>
      o.setName('percent').setDescription('1 to 200 (100 = original)').setMinValue(1).setMaxValue(200),
    ),
  new SlashCommandBuilder()
    .setName('repeat')
    .setDescription('Set the repeat mode')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('What to repeat')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Song (loop the current song)', value: 'song' },
          { name: 'Queue (loop the whole queue)', value: 'queue' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Keep playing similar songs when the queue runs out')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Turn autoplay on or off')
        .setRequired(true)
        .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
    ),

  // --- Queue ---
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song and how far in it is'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue')
    .addIntegerOption((o) =>
      o.setName('position').setDescription('Queue number from /queue').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a song to another place in the queue')
    .addIntegerOption((o) =>
      o.setName('from').setDescription('Current queue number').setRequired(true).setMinValue(1),
    )
    .addIntegerOption((o) =>
      o.setName('to').setDescription('New queue number (1 = plays next)').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming songs'),
  new SlashCommandBuilder().setName('clear').setDescription('Remove all upcoming songs but keep the current one'),

  // --- Other ---
  new SlashCommandBuilder().setName('stop').setDescription('Stop, clear the queue and leave'),
  new SlashCommandBuilder().setName('help').setDescription('List all commands'),
];

export const commands = builders.map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

/** Commands that only show information and work without being in a voice channel. */
const INFO_COMMANDS = new Set(['queue', 'nowplaying', 'help']);

/** Discord rejects messages over 2000 characters. */
const MESSAGE_LIMIT = 1900;

/** 75 -> "1:15", 3725 -> "1:02:05" */
function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "90", "1:30" or "1:02:03" -> seconds, or null if it isn't a time. */
function parseTime(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text)) return null;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function title(t: Track, max = 80): string {
  let text = t.title.replace(/[[\]]/g, ''); // brackets would break the markdown link
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return escapeMarkdown(text);
}

/** Title as a link with its length, e.g. [Song](<url>) `3:55` */
function fmt(t: Track): string {
  return `[${title(t)}](<${t.url}>) \`${t.duration}\``;
}

function progressBar(positionSec: number, durationSec: number, width = 20): string {
  const filled = Math.min(width - 1, Math.floor((positionSec / durationSec) * width));
  return `${'▬'.repeat(filled)}🔘${'▬'.repeat(width - 1 - filled)}`;
}

function settingsLine(player: GuildPlayer): string {
  return `Volume **${player.volume}%** · Repeat **${player.repeat}** · Autoplay **${player.autoplay ? 'on' : 'off'}**`;
}

/** Turn a yt-dlp / connection error into one short line for the user. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if ((err as { killed?: boolean }).killed) return 'looking that up took too long.';
  const lines = err.message.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? 'unknown error').replace(/^ERROR:\s*/, '');
}

function nowPlayingText(player: GuildPlayer): string {
  const t = player.current;
  if (!t) return 'Nothing is playing.';
  const lines = [`**Now playing${player.paused ? ' (paused)' : ''}:** ${fmt(t)}`];
  if (t.durationSec) {
    const pos = Math.min(player.positionSec, t.durationSec);
    lines.push(`${progressBar(pos, t.durationSec)} \`${formatTime(pos)} / ${formatTime(t.durationSec)}\``);
  } else {
    lines.push(`🔴 Live · playing for \`${formatTime(player.positionSec)}\``);
  }
  lines.push(`Requested by ${escapeMarkdown(t.requestedBy)} · ${settingsLine(player)}`);
  const next = player.queue[0];
  lines.push(next ? `**Up next:** ${fmt(next)}` : player.autoplay ? '**Up next:** a similar song (autoplay)' : '**Up next:** nothing');
  return lines.join('\n');
}

function queueText(player: GuildPlayer, page: number): string {
  if (!player.current) return 'The queue is empty.';
  const size = config.queuePageSize;
  const pages = Math.max(1, Math.ceil(player.queue.length / size));
  const shownPage = Math.min(page, pages);
  const start = (shownPage - 1) * size;

  let text = `**Now playing${player.paused ? ' (paused)' : ''}:** ${fmt(player.current)} — ${escapeMarkdown(player.current.requestedBy)}`;
  // Rows are kept short so a full page always fits in one Discord message;
  // big pages drop the links to make room.
  const withLinks = size <= 10;
  let end = start;
  for (const t of player.queue.slice(start, start + size)) {
    const name = title(t, 45);
    const row = withLinks ? `[${name}](<${t.url}>)` : name;
    const line = `\n${end + 1}. ${row} \`${t.duration}\` — ${escapeMarkdown(t.requestedBy)}`;
    if (text.length + line.length > MESSAGE_LIMIT - 200) break; // safety net only
    text += line;
    end++;
  }

  if (player.queue.length === 0) {
    text += '\nNo songs queued after this one.';
  } else {
    const known = player.queue.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);
    text += `\nPage ${shownPage}/${pages} · ${player.queue.length} song${player.queue.length === 1 ? '' : 's'} queued · ${formatTime(known)} total`;
    if (end < player.queue.length && shownPage < pages) text += ` · \`/queue page:${shownPage + 1}\` for more`;
  }
  return `${text}\n${settingsLine(player)}`;
}

function helpText(): string {
  return builders
    .map((b) => {
      const options = b.options
        .map((o) => {
          const json = o.toJSON();
          return json.required ? `<${json.name}>` : `[${json.name}]`;
        })
        .join(' ');
      return `\`/${b.name}${options ? ` ${options}` : ''}\` — ${b.description}`;
    })
    .join('\n');
}

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const player = getPlayer(interaction.guildId);
  const name = interaction.commandName;
  const reply = (content: string) => interaction.reply(content);
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (name === 'help') return void (await ephemeral(helpText()));
  if (name === 'nowplaying') return void (await reply(nowPlayingText(player)));
  if (name === 'queue') return void (await reply(queueText(player, interaction.options.getInteger('page') ?? 1)));
  if (INFO_COMMANDS.has(name)) return;

  // Everything below controls playback, so the user has to be in voice with the bot.
  const me = interaction.guild.members.me;
  const botChannelId = me?.voice.channelId ?? null;
  const userChannel = interaction.member.voice.channel;
  if (!userChannel) return void (await ephemeral('Join a voice channel first.'));
  if (botChannelId && botChannelId !== userChannel.id && player.current) {
    return void (await ephemeral(`I'm already playing in <#${botChannelId}>. Join that channel to control me.`));
  }

  switch (name) {
    case 'play':
    case 'playnext': {
      if (botChannelId !== userChannel.id) {
        const perms = me ? userChannel.permissionsFor(me) : null;
        if (!userChannel.joinable || !perms?.has(PermissionFlagsBits.Speak)) {
          await ephemeral(`I need the **Connect** and **Speak** permissions in <#${userChannel.id}>.`);
          return;
        }
      }
      await interaction.deferReply();
      try {
        const tracks = await resolveTracks(
          interaction.options.getString('query', true).trim(),
          interaction.user.displayName,
        );
        await player.connect(userChannel);
        // Playback problems (e.g. a blocked video) are reported in the channel /play was last used in.
        const textChannel = interaction.channel;
        player.onNotice = (message) => {
          textChannel?.send(message).catch(() => {});
        };
        const position = player.add(tracks, name === 'playnext');
        const first = tracks[0]!;
        let message: string;
        if (position === 0) message = `▶️ Now playing ${fmt(first)}`;
        else if (name === 'playnext') message = `⏫ Playing next: ${fmt(first)}`;
        else message = `➕ Queued at #${position}: ${fmt(first)}`;
        if (tracks.length > 1) message += `\n➕ Added ${tracks.length - 1} more from the playlist.`;
        await interaction.editReply(message);
      } catch (err) {
        console.error(`${name} failed:`, err);
        await interaction.editReply(`❌ Couldn't play that: ${describeError(err)}`.slice(0, MESSAGE_LIMIT));
      }
      return;
    }

    case 'skip': {
      const current = player.current;
      if (!current) return void (await reply('Nothing is playing.'));
      if (interaction.options.getString('to') === 'same') {
        player.replay();
        return void (await reply(`🔄 Starting **${title(current)}** again.`));
      }
      const next = player.queue[0];
      player.skip();
      let message = `⏭️ Skipped **${title(current)}**.`;
      if (next) message += ` Next: ${fmt(next)}`;
      else if (player.repeat === 'queue') message += ' It is the only song, so it plays again (repeat queue).';
      else if (player.autoplay) message += ' Autoplay is picking a similar song.';
      else message += ' The queue is now empty.';
      return void (await reply(message));
    }

    case 'previous': {
      const prev = player.previous();
      return void (await reply(prev ? `⏮️ Back to ${fmt(prev)}` : 'There is no previous song.'));
    }

    case 'replay': {
      const current = player.current;
      if (!current) return void (await reply('Nothing is playing.'));
      player.replay();
      return void (await reply(`🔄 Starting **${title(current)}** again.`));
    }

    case 'jump': {
      const position = interaction.options.getInteger('position', true);
      if (!player.current) return void (await reply('Nothing is playing.'));
      const target = player.jump(position);
      return void (await reply(
        target
          ? `⏭️ Jumped to ${fmt(target)}`
          : `There is no song at #${position}. The queue has ${player.queue.length}.`,
      ));
    }

    case 'seek': {
      const current = player.current;
      if (!current) return void (await reply('Nothing is playing.'));
      if (!current.durationSec) return void (await ephemeral("Can't seek in a live stream."));
      const seconds = parseTime(interaction.options.getString('time', true));
      if (seconds === null) return void (await ephemeral('Give a time like `90`, `1:30` or `1:02:03`.'));
      if (seconds >= current.durationSec) {
        return void (await ephemeral(`This song is only ${formatTime(current.durationSec)} long.`));
      }
      player.seek(seconds);
      return void (await reply(
        `⏩ Jumping to \`${formatTime(seconds)}\` in **${title(current)}**. It takes a few seconds to start.`,
      ));
    }

    case 'pause':
      return void (await reply(player.pause() ? '⏸️ Paused.' : 'Nothing to pause.'));

    case 'resume':
      return void (await reply(player.resume() ? '▶️ Resumed.' : 'Nothing is paused.'));

    case 'volume': {
      const percent = interaction.options.getInteger('percent');
      if (percent === null) return void (await reply(`🔊 Volume is at **${player.volume}%**.`));
      player.setVolume(percent);
      const note = player.current ? ' The song goes quiet for a few seconds while it is applied.' : '';
      return void (await reply(`🔊 Volume set to **${percent}%**.${note}`));
    }

    case 'repeat': {
      const mode = interaction.options.getString('mode', true) as RepeatMode;
      player.repeat = mode;
      const text = {
        off: '➡️ Repeat is off.',
        song: '🔂 Repeating the current song.',
        queue: '🔁 Repeating the whole queue.',
      } satisfies Record<RepeatMode, string>;
      return void (await reply(text[mode]));
    }

    case 'autoplay': {
      const on = interaction.options.getString('mode', true) === 'on';
      player.setAutoplay(on);
      return void (await reply(
        on
          ? "♾️ Autoplay is on. When the queue runs out I'll keep playing similar songs."
          : '➡️ Autoplay is off.',
      ));
    }

    case 'remove': {
      const position = interaction.options.getInteger('position', true);
      const removed = player.remove(position);
      return void (await reply(
        removed
          ? `🗑️ Removed ${fmt(removed)}`
          : `There is no song at #${position}. The queue has ${player.queue.length}.`,
      ));
    }

    case 'move': {
      const from = interaction.options.getInteger('from', true);
      const to = interaction.options.getInteger('to', true);
      const moved = player.move(from, to);
      return void (await reply(
        moved
          ? `↕️ Moved ${fmt(moved)} to #${to}.`
          : `Both positions have to be between 1 and ${player.queue.length}.`,
      ));
    }

    case 'shuffle': {
      const count = player.shuffle();
      return void (await reply(count > 1 ? `🔀 Shuffled ${count} songs.` : 'There are not enough songs queued to shuffle.'));
    }

    case 'clear': {
      const count = player.clear();
      return void (await reply(
        count > 0 ? `🧹 Removed ${count} song${count === 1 ? '' : 's'} from the queue.` : 'The queue is already empty.',
      ));
    }

    case 'stop':
      player.stop();
      return void (await reply('⏹️ Stopped and left the channel.'));
  }
}
