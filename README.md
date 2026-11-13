# musi_bot

A self-hosted Discord music bot written in TypeScript. It plays audio from YouTube links, playlists and search terms in a voice channel, using slash commands.

## Features

- Play a YouTube video link, a whole playlist, or just type a song name to search
- Per-server queue you can reorder: play next, move, remove, shuffle, clear, jump
- Skip forward, go back to the previous song, replay, or seek to a time in the song
- Volume control, pause and resume
- Repeat modes: loop one song or loop the whole queue
- Autoplay: keeps playing similar songs when the queue runs out
- Leaves the voice channel by itself when the queue has been empty for a while
- Tells you in chat when a video can't be played (removed, blocked, age-restricted) and moves on
- Settings in a plain `config.json` file

## Commands

`<name>` is a required option, `[name]` is optional. `/help` shows this list in Discord.

### Adding music

| Command | What it does |
|---|---|
| `/play <query>` | Plays a YouTube video or playlist link, or searches for the text and plays the first result. Adds to the end of the queue if something is already playing. |
| `/playnext <query>` | Same as `/play`, but the song (or playlist) goes to the front of the queue and plays right after the current song. |

### Moving between songs

| Command | What it does |
|---|---|
| `/skip [to]` | `to: Next song` (the default) skips to the next song. `to: Same song` starts the current song again from the beginning. |
| `/previous` | Goes back to the song that played before this one. The song you were on plays again right after it. Remembers the last 50 songs. |
| `/replay` | Starts the current song again from the beginning (same as `/skip to: Same song`). |
| `/jump <position>` | Skips straight to a queue number, dropping the songs in between. |
| `/seek <time>` | Jumps to a time in the current song: `90`, `1:30` or `1:02:03`. Not available for live streams. |

### Playback

| Command | What it does |
|---|---|
| `/pause` | Pauses playback |
| `/resume` | Resumes playback |
| `/volume [percent]` | Sets the volume from 1 to 200 (100 = original). Without a number it shows the current volume. |
| `/repeat <mode>` | Sets the repeat mode: `Off`, `Song` or `Queue` |
| `/autoplay <mode>` | `On`: when the queue runs out, keep playing similar songs. `Off`: stop when the queue ends. |

### Queue

| Command | What it does |
|---|---|
| `/nowplaying` | Shows the current song with a progress bar, the volume, repeat and autoplay settings, and what's up next |
| `/queue [page]` | Lists the upcoming songs with their queue numbers and the total length |
| `/remove <position>` | Removes one song from the queue |
| `/move <from> <to>` | Moves a song to another queue number (`to: 1` makes it play next) |
| `/shuffle` | Shuffles the upcoming songs |
| `/clear` | Removes all upcoming songs but keeps the current one playing |

### Other

| Command | What it does |
|---|---|
| `/stop` | Clears the queue and leaves the voice channel |
| `/help` | Lists all commands (only you see the reply) |

Notes:

- You have to be in a voice channel to use anything except `/queue`, `/nowplaying` and `/help`, and in the *same* channel as the bot while it is playing.
- Any link containing `list=` is treated as a playlist and queued from its first song.
- With repeat set to `Song`, `/skip` still moves on to the next song. With repeat set to `Queue`, skipped and jumped-over songs go to the back of the queue and come round again.
- `/seek` and `/volume` restart the audio stream at the right position, so there are a few seconds of silence while they take effect. Seeking far into a long video takes longer.
- The volume, like autoplay, stays as you set it until the bot restarts. `/stop` resets the repeat mode and forgets the `/previous` history.
- Autoplay picks songs from the YouTube Mix of the last song played and avoids the last 50 songs. It starts them silently, without posting a message; `/nowplaying` shows what is playing. It only applies to YouTube videos.
- Autoplay only kicks in when the queue is empty, so it does nothing while repeat is set to `Song` or `Queue`.

## Requirements

| Tool | Version | Why |
|---|---|---|
| [Node.js](https://nodejs.org/) | 22.18 or newer | Runs the bot |
| [ffmpeg](https://ffmpeg.org/) | Any recent build with `libopus` | Converts audio to the format Discord uses |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | As new as possible | Downloads audio from YouTube |

Both `ffmpeg` and `yt-dlp` must be on your `PATH`. Check with:

```sh
node --version
ffmpeg -version
yt-dlp --version
```

Installing them:

```sh
# Arch Linux
sudo pacman -S nodejs npm ffmpeg yt-dlp

# Debian / Ubuntu (the apt version of yt-dlp is usually too old, so install it directly)
sudo apt install nodejs npm ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp

# macOS
brew install node ffmpeg yt-dlp
```

The bot is developed and tested on Linux. It should work on macOS and Windows as long as the three tools above are installed, but that is untested.

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **Bot** page and click **Reset Token**, then copy the token. Treat it like a password: anyone who has it controls your bot.
3. Open the **Installation** page and make sure **Guild Install** is enabled. (A music bot has to be a member of the server to join voice channels, so User Install is not enough.)
4. Open **OAuth2 → URL Generator** and tick:
   - Scopes: `bot` and `applications.commands`
   - Bot permissions: **View Channels**, **Send Messages**, **Connect**, **Speak**
5. Open the generated URL in your browser and add the bot to your server.

No privileged intents are needed.

## 2. Install

```sh
git clone <your-repo-url> musi_bot
cd musi_bot
npm install
```

## 3. Configure

Copy the example environment file and fill it in:

```sh
cp .env.example .env
```

| Variable | Required | What it is |
|---|---|---|
| `DISCORD_TOKEN` | Yes | The bot token from step 1 |
| `GUILD_ID` | No | Your server's ID. With it, slash commands appear in that server instantly. Without it, commands are registered globally for every server the bot is in, which can take a while to show up. |

To get your server ID, enable **Developer Mode** in Discord (User Settings → Advanced), then right-click the server icon and choose **Copy Server ID**.

`.env` is listed in `.gitignore`. Never commit it.

## 4. Run

For development, this runs the TypeScript directly and restarts when you edit a file:

```sh
npm run dev
```

For normal use, build once and run the compiled version:

```sh
npm run build
npm start
```

When it works you will see:

```
Logged in as yourbot#1234
Registered 20 commands in guild 123456789012345678
```

Join a voice channel and try `/play` with a YouTube link.

## Settings (`config.json`)

Edit `config.json` in the project root and restart the bot.

| Setting | Default | Allowed | What it controls |
|---|---|---|---|
| `idleLeaveMinutes` | `5` | 0 – 1440 | How long the bot stays in voice with an empty queue before leaving |
| `playlistLimit` | `100` | 1 – 1000 | Most songs a single playlist link can add |
| `audioBitrateKbps` | `128` | 8 – 512 | Audio quality sent to Discord. What listeners actually hear is capped by the voice channel's own bitrate. |
| `defaultRepeat` | `"off"` | `"off"`, `"song"`, `"queue"` | Repeat mode at startup and after `/stop` |
| `queuePageSize` | `10` | 1 – 15 | How many upcoming songs `/queue` shows per page. Above 10, the song links are left out so a page fits in one message. |
| `maxConsecutiveFailures` | `5` | 1 – 100 | Failed songs in a row before the bot gives up and clears the queue |
| `defaultVolume` | `100` | 1 – 200 | Volume in percent the bot starts with. Change it while running with `/volume`. |

If the file is missing, broken, or a value is out of range, the bot prints a warning and uses the default for that setting.

## Keeping it running

`npm start` stops when you close the terminal. To keep the bot online and start it at boot, use one of the following. Run only one copy of the bot at a time: two copies with the same token will both answer every command.

### systemd (Linux)

Create `~/.config/systemd/user/musi-bot.service`, replacing the paths with your own (`which node` shows the Node path):

```ini
[Unit]
Description=musi Discord music bot

[Service]
WorkingDirectory=/home/YOU/musi_bot
ExecStart=/usr/bin/node --env-file=.env dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then:

```sh
npm run build
systemctl --user daemon-reload
systemctl --user enable --now musi-bot
loginctl enable-linger "$USER"     # start at boot, without waiting for you to log in
```

Useful commands:

```sh
systemctl --user status musi-bot
journalctl --user -u musi-bot -f       # live logs
systemctl --user restart musi-bot
```

If Node was installed with nvm, use the full path to that Node binary in `ExecStart`, and add a line such as `Environment=PATH=/home/YOU/.nvm/versions/node/vXX/bin:/usr/local/bin:/usr/bin` so the service can find `yt-dlp` and `ffmpeg`.

### pm2

```sh
npm install -g pm2
npm run build
pm2 start dist/index.js --name musi-bot --node-args="--env-file=.env"
pm2 save
pm2 startup        # prints one sudo command; run it to start pm2 at boot
```

Start it from the project folder, because the `.env` path is relative.

## Updating

```sh
git pull
npm install
npm run build
```

Then restart the bot (`systemctl --user restart musi-bot` or `pm2 restart musi-bot`). Restart it as well after changing `config.json` or `.env`.

## Troubleshooting

| Problem | What to do |
|---|---|
| `DISCORD_TOKEN is not set` | Create `.env` from `.env.example` and put your token in it. Start the bot from the project folder. |
| Slash commands don't appear | Set `GUILD_ID` in `.env` and restart; global commands can take a while. Also check the bot was invited with the `applications.commands` scope. |
| Every command appears twice | Commands were registered both globally and for your server. Start the bot once with `GUILD_ID` set; it removes the global copies. |
| "I need the Connect and Speak permissions" | Give the bot's role those permissions in that voice channel. |
| "Couldn't play …, skipping it" | The video is removed, private, region-blocked or age-restricted. If it happens for every song, update yt-dlp (`yt-dlp -U`, or through your package manager). |
| Songs stopped working after working fine for weeks | YouTube changed something. Update yt-dlp. This is the most common fix. |
| "Sign in to confirm you're not a bot" in the logs | YouTube is blocking your IP address. This is common on cloud servers (AWS, Azure and similar) and rare on home connections. |
| Commands get answered twice or fail randomly | Two copies of the bot are running. Stop one. |
| Bot joins but there is no sound | Check `ffmpeg -version` works and lists `--enable-libopus`, and that the bot isn't server-muted. |

Logs go to the terminal, or to `journalctl` / `pm2 logs` when run as a service. yt-dlp and ffmpeg errors are printed there with the server ID in front.

## How it works

For each song the bot starts `yt-dlp` to download the best audio stream and pipes it into `ffmpeg`, which converts it to Ogg/Opus. That stream goes straight to Discord through [`@discordjs/voice`](https://github.com/discordjs/discord.js/tree/main/packages/voice), so no native audio libraries have to be compiled.

```
src/
  index.ts      startup, slash-command registration, shutdown
  commands.ts   the slash commands and their replies
  player.ts     per-server queue, voice connection, yt-dlp/ffmpeg pipeline
  config.ts     loads and validates config.json
config.json     user settings
.env            your token and server ID (not committed)
```

Scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with auto-restart |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled bot |
| `npm run typecheck` | Check types without building |
