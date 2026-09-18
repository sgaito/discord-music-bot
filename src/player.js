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
import { isYouTubeUrl, resolveYouTube, streamYouTube } from "./youtube.js";

export class MusicManager {
  constructor(config) {
    this.config = config;
    this.guilds = new Map();
    this.onTrackStart = null;
    this.onQueueEnd = null;
    this.onSessionEnd = null;
  }

  get(guildId) {
    let session = this.guilds.get(guildId);
    if (!session || session.dead) {
      session = new GuildSession(guildId, this.config, () => {
        this.guilds.delete(guildId);
        this.onSessionEnd?.(session);
      });
      session.onTrackStart = (track) => this.onTrackStart?.(session, track);
      session.onQueueEnd = () => this.onQueueEnd?.(session);
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
    this.history = [];
    this.current = null;
    this.resource = null;
    this.connection = null;
    this.cleanupStream = null;
    this.idleTimer = null;
    this.textChannel = null;
    this.starting = false;
    this.dead = false;
    this.skipHistory = false;
    this.onTrackStart = null;
    this.onQueueEnd = null;
    this.npMessage = null;
    this.npTimer = null;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on("stateChange", (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        this.playNext().catch(async (err) => {
          console.error("[player]", err);
          this.textChannel?.send(`Se me trabó este tema: ${err.message}`).catch(() => {});
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

  async playNext({ announce = true } = {}) {
    if (this.dead || this.starting) return this.current;
    this.starting = true;

    try {
      this.stopStream();

      const finished = this.current;
      if (finished && !this.skipHistory) {
        this.history.push(finished);
        if (this.history.length > 50) this.history.shift();
      }
      this.skipHistory = false;

      while (!this.dead) {
        this.current = this.queue.shift() || null;
        if (!this.current) {
          this.startIdle();
          try {
            await this.onQueueEnd?.();
          } catch (err) {
            console.error("[nowplaying]", err);
          }
          return null;
        }

        this.clearIdle();
        try {
          this.current = await resolveForPlayback(this.current, this.config);
        } catch (err) {
          console.error("[player]", err);
          this.textChannel
            ?.send(`No encontré "${this.current.title}" en YouTube, paso al siguiente.`)
            .catch(() => {});
          continue;
        }

        const { stream, cleanup } = streamYouTube(this.current.url, this.config);
        this.cleanupStream = cleanup;

        const resource = createAudioResource(stream, {
          inputType: StreamType.Raw,
          metadata: this.current,
        });
        this.resource = resource;
        this.player.play(resource);
        await entersState(this.player, AudioPlayerStatus.Playing, 20_000);
        if (announce) {
          try {
            await this.onTrackStart?.(this.current);
          } catch (err) {
            console.error("[nowplaying]", err);
          }
        }
        return this.current;
      }

      return null;
    } finally {
      this.starting = false;
    }
  }

  skip() {
    if (!this.current && this.queue.length === 0) {
      return false;
    }
    this.advance();
    return true;
  }

  previous() {
    if (!this.history.length) {
      return false;
    }
    const earlier = this.history.pop();
    if (this.current) this.queue.unshift(this.current);
    this.queue.unshift(earlier);
    this.skipHistory = true;
    this.advance();
    return true;
  }

  shuffle() {
    if (this.queue.length < 2) {
      return false;
    }
    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    return true;
  }

  position() {
    return Math.floor((this.resource?.playbackDuration || 0) / 1000);
  }

  advance() {
    if (this.player.state.status === AudioPlayerStatus.Idle) {
      this.playNext().catch((err) => console.error("[player]", err));
    } else {
      this.player.stop(true);
    }
  }

  stop() {
    this.queue = [];
    this.history = [];
    this.current = null;
    this.resource = null;
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
    this.history = [];
    this.current = null;
    this.resource = null;
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

async function resolveForPlayback(track, config) {
  if (track.url && isYouTubeUrl(track.url) && !track.youtubeQuery) {
    return track;
  }

  const query = track.youtubeQuery || track.title;
  if (!query) {
    throw new Error("No encontré ese tema en YouTube");
  }

  const { tracks } = await resolveYouTube(query, config);
  const yt = tracks[0];
  if (!yt?.url) {
    throw new Error(`No encontré "${track.title}" en YouTube`);
  }

  return {
    ...yt,
    title: track.title || yt.title,
    uploader: track.uploader || yt.uploader,
    thumbnail: track.thumbnail || yt.thumbnail,
    duration: track.duration || yt.duration,
    requestedBy: track.requestedBy,
    url: yt.url,
  };
}
