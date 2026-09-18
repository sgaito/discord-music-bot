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
  ContainerBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MediaGalleryBuilder,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
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
music.onTrackStart = (session, track) => sendNowPlaying(session, track);
music.onQueueEnd = (session) => clearNowPlaying(session);
music.onSessionEnd = (session) => clearNowPlaying(session);

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Pone un link de YouTube o Spotify, o busca normal, o pone lo que quieras wachin")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("Link de YouTube o Spotify, o un nombre y lo busco")
        .setRequired(true),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Saltea este tema"),
  new SlashCommandBuilder().setName("stop").setDescription("Para todo, te vacía la cola y se va"),
  new SlashCommandBuilder().setName("pause").setDescription("Pausa el tema, stop, quieto"),
  new SlashCommandBuilder().setName("resume").setDescription("Sigue con el tema"),
  new SlashCommandBuilder().setName("queue").setDescription("Qué tenes en la cola (Spoiler: waska)"),
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
    await interaction.reply({ content: "Que mierda haces? me estas mandando un dm imbécil", ephemeral: true });
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
    const message = err.message || "Se picó todo, exploto error";
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
    await interaction.reply({ content: "Si no estas en un canal donde mierda queres que ponga, imbécil", ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me;
  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
    await interaction.reply({
      content: "Liberen al tito wachooo, no me dejan cantar acá",
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString("url", true).trim();
  await interaction.reply({ content: "Pará que estoy pensando wacho" });

  const { playlistTitle, tracks } = await resolveQuery(query, config);
  const session = music.get(interaction.guildId);
  const wasIdle = !session.current && session.queue.length === 0;

  await session.connect(voiceChannel, interaction.channel);
  session.enqueue(tracks, interaction.user);

  if (wasIdle) {
    const playing = await session.playNext();
    if (!playing) {
      await interaction.editReply({ content: "No pude poner ninguno de esos temas, ni idea pa fijate vo" });
      return;
    }
    await interaction.deleteReply().catch(() => {});
    return;
  }

  await interaction.editReply({
    embeds: [queuedEmbed(tracks[0], playlistNote(playlistTitle, tracks.length))],
  });
}

async function handleSkip(interaction) {
  const session = requireSameVoice(interaction);
  if (!session.skip()) {
    await interaction.reply({ content: "No hay nada para saltear.", ephemeral: true });
    return;
  }
  await interaction.reply({ content: "Listo, siguiente.", ephemeral: true });
}

async function handleStop(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "Me queres sacar y ni siquiera estoy, enfermo.", ephemeral: true });
    return;
  }
  requireSameVoice(interaction);
  session.stop();
  await interaction.reply({ content: "Chaaau nos vimoo", ephemeral: true });
}

async function handlePause(interaction) {
  const session = requireSameVoice(interaction);
  if (!session.isPlaying()) {
    await interaction.reply({ content: "Que queres pausar si no hay nada genio", ephemeral: true });
    return;
  }
  session.pause();
  refreshCard(session);
  await interaction.reply({ content: "Pausé, de nada ahi te paso alias", ephemeral: true });
}

async function handleResume(interaction) {
  const session = requireSameVoice(interaction);
  if (!session.isPaused()) {
    await interaction.reply({ content: "como que resume si esta sonando bott", ephemeral: true });
    return;
  }
  session.resume();
  refreshCard(session);
  await interaction.reply({ content: "Dale, sigo.", ephemeral: true });
}

async function handleQueue(interaction) {
  const session = music.guilds.get(interaction.guildId);
  const embed = queueEmbed(session);
  if (!embed) {
    await interaction.reply({ content: "No tenes nada en la cola (por ahora)", ephemeral: true });
    return;
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleNowPlaying(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session?.current) {
    await interaction.reply({ content: "No hay nada puesto wachin", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "Pará que piense wacho", ephemeral: true });
  session.textChannel = interaction.channel;
  await sendNowPlaying(session, session.current);
  await interaction.deleteReply().catch(() => {});
}

function requireSameVoice(interaction) {
  const session = music.guilds.get(interaction.guildId);
  if (!session?.connection) {
    throw new Error("No se que tocas si ni quiera estoy");
  }
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== session.connection.joinConfig.channelId) {
    throw new Error("Tenés que estar en el mismo canal que yo.");
  }
  return session;
}

function playlistNote(playlistTitle, count) {
  if (playlistTitle && count > 1) return `${playlistTitle} · ${count} temas`;
  if (count > 1) return `Metí ${count} temas`;
  return null;
}

function playerCard(session, track) {
  const container = new ContainerBuilder().setAccentColor(0xff0000);

  if (track.thumbnail) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems({ media: { url: track.thumbnail } }),
    );
  }

  const total = track.duration ? formatDuration(track.duration) : "en vivo";
  const lines = [
    `**${escapeMarkdown(track.title)}**`,
    escapeMarkdown(track.uploader || "YouTube"),
    `\`${formatDuration(session?.position() ?? 0)} / ${total}\``,
  ];

  const extra = [];
  if (session?.queue.length) extra.push(`${session.queue.length} en cola`);
  const who = track.requestedBy;
  if (who) extra.push(`pidió ${escapeMarkdown(who.displayName || who.username || String(who))}`);
  if (extra.length) lines.push(`-# ${extra.join(" · ")}`);

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  for (const row of playerControls(session)) {
    container.addActionRowComponents(row);
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function playerControls(session) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("music_shuffle").setLabel("⇄").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("music_prev").setLabel("|<").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("music_pause")
        .setLabel(session?.isPaused() ? ">" : "||")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("music_skip").setLabel(">|").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("music_lista").setLabel("≡").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("music_stop").setLabel("[]").setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function sendNowPlaying(session, track) {
  clearNowPlaying(session);
  if (!session.textChannel) return;

  try {
    const message = await session.textChannel.send(playerCard(session, track));
    session.npMessage = message;
    startNpTicker(session, message);
  } catch (err) {
    console.error("[nowplaying]", err);
  }
}

function clearNowPlaying(session) {
  if (!session) return;
  stopNpTicker(session);
  const message = session.npMessage;
  session.npMessage = null;
  message?.delete().catch(() => {});
}

function startNpTicker(session, message) {
  stopNpTicker(session);
  session.npTimer = setInterval(() => {
    if (session.dead || !session.current || session.npMessage !== message) {
      stopNpTicker(session);
      return;
    }
    message.edit(playerCard(session, session.current)).catch(() => stopNpTicker(session));
  }, 10_000);
}

function stopNpTicker(session) {
  if (session?.npTimer) {
    clearInterval(session.npTimer);
    session.npTimer = null;
  }
}

function refreshCard(session) {
  if (!session?.npMessage || !session.current) return;
  session.npMessage.edit(playerCard(session, session.current)).catch(() => {});
}

function queuedEmbed(track, note) {
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle("A la cola")
    .setDescription(track.url ? `[${track.title}](${track.url})` : track.title)
    .addFields(
      { name: "Duración", value: track.duration ? formatDuration(track.duration) : "en vivo", inline: true },
      { name: "Canal", value: track.uploader || "YouTube", inline: true },
    );

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  if (note) embed.setFooter({ text: note });
  return embed;
}

function queueEmbed(session) {
  if (!session?.current && !(session?.queue.length)) return null;

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

  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle("En cola")
    .setDescription(lines.join("\n"));
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith("music_")) return;

  try {
    if (interaction.customId === "music_lista") {
      const session = music.guilds.get(interaction.guildId);
      const embed = queueEmbed(session);
      if (!embed) {
        await interaction.reply({ content: "No tenes nada en la cola (por ahora)", ephemeral: true });
        return;
      }
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    const session = requireSameVoice(interaction);

    if (interaction.customId === "music_pause") {
      if (session.isPaused()) {
        session.resume();
      } else {
        session.pause();
      }
      await refreshPlayer(interaction, session);
      return;
    }
    if (interaction.customId === "music_shuffle") {
      if (!session.shuffle()) {
        await interaction.reply({ content: "No se que queres que mezcle si no tenes nada puesto.", ephemeral: true });
        return;
      }
      await refreshPlayer(interaction, session);
      return;
    }
    if (interaction.customId === "music_prev") {
      if (!session.history.length) {
        await interaction.reply({ content: "No hay nada antes de este tema.", ephemeral: true });
        return;
      }
      await interaction.deferUpdate().catch(() => {});
      session.previous();
      return;
    }
    if (interaction.customId === "music_skip") {
      await interaction.deferUpdate().catch(() => {});
      session.skip();
      return;
    }
    if (interaction.customId === "music_stop") {
      await interaction.reply({ content: "Corté todo.", ephemeral: true });
      session.stop();
    }
  } catch (err) {
    await interaction.reply({ content: err.message || "No pude.", ephemeral: true }).catch(() => {});
  }
});

async function refreshPlayer(interaction, session) {
  if (!session.current) {
    await interaction.deferUpdate();
    return;
  }
  await interaction.update(playerCard(session, session.current));
}

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
