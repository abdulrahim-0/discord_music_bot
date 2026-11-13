import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands, handleCommand } from './commands.ts';
import { stopAll } from './player.ts';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  // Guild commands appear instantly; global ones can take a while to show up.
  const guildId = process.env.GUILD_ID;
  try {
    if (guildId) {
      await ready.application.commands.set(commands, guildId);
      // Remove global copies from an earlier run without GUILD_ID, or every command shows twice.
      await ready.application.commands.set([]);
      console.log(`Registered ${commands.length} commands in guild ${guildId}`);
    } else {
      await ready.application.commands.set(commands);
      console.log(`Registered ${commands.length} global commands`);
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
  }
});

client.on(Events.Error, (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// Leave voice channels and kill yt-dlp/ffmpeg cleanly on Ctrl+C or service stop.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    stopAll();
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(token);
