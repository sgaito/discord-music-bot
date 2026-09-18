import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { MusicManager } from "./player.js";
import { formatDuration } from "./youtube.js";
import { resolveQuery } from "./resolve.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(rootDir, "../.env") });

const config = loadConfig();
assertBinaries(config.ytdlpBin);

const music = new MusicManager(config);

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Pone un link de YouTube o Spotify")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("Link de YouTube o Spotify, o un nombre y lo busco")
        .setRequired(true),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Saltea este tema"),
  new SlashCommandBuilder().setName("stop").setDescription("Para todo, vacía la cola y se va"),
  new SlashCommandBuilder().setName("pause").setDescription("Pausa el tema"),
  new SlashCommandBuilder().setName("resume").setDescription("Sigue con el tema"),
  new SlashCommandBuilder().setName("queue").setDescription("Qué hay en cola"),
  new SlashCommandBuilder().setName("np").setDescription("Qué está sonando ahora"),
  new SlashCommandBuilder().setName("leave").setDescription("Saca a Gaito del canal de voz"),
].map((command) => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (readyClient) => {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const appId = readyClient.user.id;

  try {
    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(appId, config.guildId), { body: commands });
      console.log(`Comandos registrados en el server ${config.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      console.log("Comandos globales registrados (pueden tardar hasta 1 hora)");
    }
  } catch (err) {
    console.error("No pude registrar los comandos slash. Revisá que el bot esté invitado al server y que GUILD_ID sea correcto.");
    console.error(err.message);
  }

  console.log(`Listo como ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Esto es para usarlo en un server, no por acá.", ephemeral: true });
    return;
  }

  try {
    switch (interaction.commandName) {
      case "play":
        await handlePlay(interaction);
        break;
      case "skip":
        await handleSkip(interaction);
        break;
      case "stop":
      case "leave":
        await handleStop(interaction);
        break;
      case "pause":
        await handlePause(interaction);
        break;
      case "resume":
        await handleResume(interaction);
        break;
      case "queue":
        await handleQueue(interaction);
        break;
      case "np":
        await handleNowPlaying(interaction);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("[command]", err);
    const message = err.message || "Algo salió mal";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

async function handlePlay(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.type === ChannelType.GuildStageVoice) {
    await interaction.reply({ content: "Entrá a un canal de voz y después pedime el tema.", ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me;
  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
    await interaction.reply({
      content: "No me dejan entrar o hablar en ese canal de voz.",
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString("url", true).trim();
  await interaction.deferReply();

  const { playlistTitle, tracks } = await resolveQuery(query, config);
  const session = music.get(interaction.guildId);
  const wasIdle = !session.current && session.queue.length === 0;

  await session.connect(voiceChannel, interaction.channel);
  session.enqueue(tracks, interaction.user);

  if (wasIdle) {
    const playing = await session.playNext();
    if (!playing) {
      await interaction.editReply({ content: "No pude poner ninguno de esos temas." });
      return;
    }
    await interaction.editReply({
      embeds: [trackEmbed(playing, playlistTitle, tracks.length, true)],
      components: controls(),
    });
    return;
  }

  await interaction.editReply({
    embeds: [trackEmbed(tracks[0], playlistTitle, tracks.length, false)],
  });
}

async function handleSkip(interaction) {
  const session = requireSameVoice(interaction);
  if (!session.skip()) {
    await interaction.reply({ content: "No hay nada para saltear.", ephemeral: true });
    return;
  }
  await interaction.reply("Listo, siguiente.");
}

async function handleStop(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "No estoy tocando nada.", ephemeral: true });
    return;
  }
  requireSameVoice(interaction);
  session.stop();
  await interaction.reply("Chau, apagué todo y me fui.");
}

async function handlePause(interaction) {
  const session = requireSameVoice(interaction);
  if (!session.isPlaying()) {
    await interaction.reply({ content: "No hay nada puesto.", ephemeral: true });
    return;
  }
  session.pause();
  await interaction.reply("Quedó en pausa.");
}

async function handleResume(interaction) {
  const session = requireSameVoice(interaction);
  if (!session.isPaused()) {
    await interaction.reply({ content: "No está en pausa.", ephemeral: true });
    return;
  }
  session.resume();
  await interaction.reply("Dale, sigo.");
}

async function handleQueue(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session?.current && !(session?.queue.length)) {
    await interaction.reply({ content: "No hay nada en cola.", ephemeral: true });
    return;
  }

  const lines = [];
  if (session.current) {
    lines.push(`**Sonando:** ${session.current.title} \`${formatDuration(session.current.duration)}\``);
  }
  session.queue.slice(0, 10).forEach((track, index) => {
    lines.push(`\`${index + 1}.\` ${track.title} \`${formatDuration(track.duration)}\``);
  });
  if (session.queue.length > 10) {
    lines.push(`… y ${session.queue.length - 10} más`);
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("En cola")
        .setDescription(lines.join("\n")),
    ],
  });
}

async function handleNowPlaying(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session?.current) {
    await interaction.reply({ content: "No hay nada puesto.", ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [trackEmbed(session.current, null, 1, true)],
    components: controls(),
  });
}

function requireSameVoice(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session?.connection) {
    throw new Error("No estoy en ningún canal de voz.");
  }
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== session.connection.joinConfig.channelId) {
    throw new Error("Tenés que estar en el mismo canal que yo.");
  }
  return session;
}

function trackEmbed(track, playlistTitle, count, nowPlaying) {
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle(nowPlaying ? "Sonando" : "A la cola")
    .setDescription(track.url ? `[${track.title}](${track.url})` : track.title)
    .addFields(
      { name: "Duración", value: formatDuration(track.duration), inline: true },
      { name: "Canal", value: track.uploader || "YouTube", inline: true },
    );

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  if (playlistTitle && count > 1) {
    embed.setFooter({ text: `${playlistTitle} · ${count} temas` });
  } else if (count > 1) {
    embed.setFooter({ text: `Metí ${count} temas` });
  }
  return embed;
}

function controls() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("music_pause").setLabel("Pausa").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("music_skip").setLabel("Saltear").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("music_stop").setLabel("Parar").setStyle(ButtonStyle.Danger),
    ),
  ];
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith("music_")) return;

  try {
    if (interaction.customId === "music_pause") {
      const session = requireSameVoice(interaction);
      if (session.isPaused()) {
        session.resume();
        await interaction.reply({ content: "Dale, sigo.", ephemeral: true });
      } else {
        session.pause();
        await interaction.reply({ content: "Quedó en pausa.", ephemeral: true });
      }
      return;
    }
    if (interaction.customId === "music_skip") {
      const session = requireSameVoice(interaction);
      session.skip();
      await interaction.reply({ content: "Listo, siguiente.", ephemeral: true });
      return;
    }
    if (interaction.customId === "music_stop") {
      const session = requireSameVoice(interaction);
      session.stop();
      await interaction.reply({ content: "Corté todo.", ephemeral: true });
    }
  } catch (err) {
    await interaction.reply({ content: err.message || "No pude.", ephemeral: true }).catch(() => {});
  }
});

function assertBinaries(ytdlpBin) {
  try {
    execFileSync(ytdlpBin, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("No encuentro yt-dlp. Instalalo antes de arrancar el bot (ver README).");
  }
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("No encuentro ffmpeg. En Ubuntu: sudo apt install ffmpeg");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    music.destroyAll();
    client.destroy();
    process.exit(0);
  });
}

if (!existsSync(path.resolve(rootDir, "../.env"))) {
  console.warn("No hay archivo .env. Copiá .env.example a .env y pegá el token.");
}

await client.login(config.token);
