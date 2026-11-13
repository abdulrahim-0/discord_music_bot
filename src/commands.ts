import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from './config.ts';
import { getPlayer, resolveTracks, type RepeatMode, type Track } from './player.ts';

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube video or playlist link (or search for a song)')
    .addStringOption((o) =>
      o.setName('query').setDescription('YouTube video/playlist URL or search terms').setRequired(true),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
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
  new SlashCommandBuilder().setName('stop').setDescription('Stop, clear the queue and leave'),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

/** Discord rejects messages over 2000 characters. */
const MESSAGE_LIMIT = 1900;

function fmt(t: Track): string {
  let title = t.title.replace(/[[\]]/g, ''); // brackets would break the markdown link
  if (title.length > 80) title = `${title.slice(0, 79)}…`;
  return `[${escapeMarkdown(title)}](<${t.url}>) \`${t.duration}\``;
}

/** Turn a yt-dlp / connection error into one short line for the user. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if ((err as { killed?: boolean }).killed) return 'looking that up took too long.';
  const lines = err.message.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? 'unknown error').replace(/^ERROR:\s*/, '');
}

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const player = getPlayer(interaction.guildId);
  const me = interaction.guild.members.me;
  const botChannelId = me?.voice.channelId ?? null;
  const userChannel = interaction.member.voice.channel;
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (interaction.commandName === 'queue') {
    if (!player.current) {
      await interaction.reply('The queue is empty.');
      return;
    }
    let text = `**Now playing${player.paused ? ' (paused)' : ''}:** ${fmt(player.current)} — ${escapeMarkdown(player.current.requestedBy)}`;
    let shown = 0;
    for (const [i, t] of player.queue.entries()) {
      const line = `\n${i + 1}. ${fmt(t)} — ${escapeMarkdown(t.requestedBy)}`;
      if (shown === config.queuePageSize || text.length + line.length > MESSAGE_LIMIT - 60) break;
      text += line;
      shown++;
    }
    if (player.queue.length > shown) text += `\n…and ${player.queue.length - shown} more`;
    if (player.repeat !== 'off') text += `\nRepeat: **${player.repeat}**`;
    await interaction.reply(text);
    return;
  }

  // Everything below controls playback, so the user has to be in voice with the bot.
  if (!userChannel) {
    await ephemeral('Join a voice channel first.');
    return;
  }
  if (botChannelId && botChannelId !== userChannel.id && player.current) {
    await ephemeral(`I'm already playing in <#${botChannelId}>. Join that channel to control me.`);
    return;
  }

  switch (interaction.commandName) {
    case 'play': {
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
        const [position = 0] = tracks.map((t) => player.enqueue(t));
        const first = tracks[0]!;
        let message =
          position === 0 ? `▶️ Now playing ${fmt(first)}` : `➕ Queued at #${position}: ${fmt(first)}`;
        if (tracks.length > 1) message += `\n➕ Added ${tracks.length - 1} more from the playlist.`;
        await interaction.editReply(message);
      } catch (err) {
        console.error('play failed:', err);
        await interaction.editReply(`❌ Couldn't play that: ${describeError(err)}`.slice(0, MESSAGE_LIMIT));
      }
      return;
    }

    case 'skip':
      await interaction.reply(player.skip() ? '⏭️ Skipped.' : 'Nothing is playing.');
      return;

    case 'pause':
      await interaction.reply(player.pause() ? '⏸️ Paused.' : 'Nothing to pause.');
      return;

    case 'resume':
      await interaction.reply(player.resume() ? '▶️ Resumed.' : 'Nothing is paused.');
      return;

    case 'repeat': {
      const mode = interaction.options.getString('mode', true) as RepeatMode;
      player.repeat = mode;
      const text = {
        off: '➡️ Repeat is off.',
        song: '🔂 Repeating the current song.',
        queue: '🔁 Repeating the whole queue.',
      } satisfies Record<RepeatMode, string>;
      await interaction.reply(text[mode]);
      return;
    }

    case 'stop':
      player.stop();
      await interaction.reply('⏹️ Stopped and left the channel.');
      return;
  }
}
