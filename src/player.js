import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { streamYouTube } from "./youtube.js";

export class MusicManager {
  constructor(config) {
    this.config = config;
    this.guilds = new Map();
  }

  get(guildId) {
    let session = this.guilds.get(guildId);
    if (!session || session.dead) {
      session = new GuildSession(guildId, this.config, () => this.guilds.delete(guildId));
      this.guilds.set(guildId, session);
    }
    return session;
  }

  destroyAll() {
    for (const session of this.guilds.values()) {
      session.destroy();
    }
  }
}

class GuildSession {
  constructor(guildId, config, onDestroy) {
    this.guildId = guildId;
    this.config = config;
    this.onDestroy = onDestroy;
    this.queue = [];
    this.current = null;
    this.connection = null;
    this.cleanupStream = null;
    this.idleTimer = null;
    this.textChannel = null;
    this.starting = false;
    this.dead = false;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on("stateChange", (oldState, newState) => {
      if (oldState.status === AudioPlayerStatus.Playing && newState.status === AudioPlayerStatus.Idle) {
        this.playNext().catch(async (err) => {
          console.error("[player]", err);
          this.textChannel?.send(`No pude reproducir eso: ${err.message}`).catch(() => {});
          this.playNext().catch((nextErr) => console.error("[player]", nextErr));
        });
      }
    });

    this.player.on("error", (err) => {
      console.error("[player]", err);
    });
  }

  async connect(voiceChannel, textChannel) {
    this.textChannel = textChannel;
    this.clearIdle();

    if (this.connection) {
      if (this.connection.joinConfig.channelId !== voiceChannel.id) {
        this.connection.rejoin({
          channelId: voiceChannel.id,
          selfDeaf: true,
        });
      }
      if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      }
      return;
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.destroy();
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
  }

  enqueue(tracks, requestedBy) {
    const items = tracks.map((track) => ({ ...track, requestedBy }));
    this.queue.push(...items);
    return items;
  }

  async playNext() {
    if (this.dead || this.starting) return this.current;
    this.starting = true;

    try {
      this.stopStream();
      this.current = this.queue.shift() || null;

      if (!this.current) {
        this.startIdle();
        return null;
      }

      this.clearIdle();
      const { stream, cleanup } = streamYouTube(this.current.url, this.config);
      this.cleanupStream = cleanup;

      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
        metadata: this.current,
      });
      this.player.play(resource);
      await entersState(this.player, AudioPlayerStatus.Playing, 20_000);
      return this.current;
    } finally {
      this.starting = false;
    }
  }

  skip() {
    if (!this.current && this.queue.length === 0) {
      return false;
    }
    this.player.stop(true);
    return true;
  }

  stop() {
    this.queue = [];
    this.current = null;
    this.player.stop(true);
    this.stopStream();
    this.destroy();
  }

  pause() {
    return this.player.pause(true);
  }

  resume() {
    return this.player.unpause();
  }

  isPlaying() {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  startIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.destroy(), this.config.idleTimeoutMs);
  }

  clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  stopStream() {
    if (this.cleanupStream) {
      this.cleanupStream();
      this.cleanupStream = null;
    }
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.clearIdle();
    this.stopStream();
    this.queue = [];
    this.current = null;
    try {
      this.player.stop(true);
    } catch {
      // already stopped
    }
    if (this.connection) {
      const connection = this.connection;
      this.connection = null;
      try {
        connection.destroy();
      } catch {
        // already destroyed
      }
    }
    this.onDestroy();
  }
}
