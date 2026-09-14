import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("poné_") || value.includes("poné el")) {
    throw new Error(`Falta ${name} en el archivo .env. Copiá .env.example a .env y pegá el valor.`);
  }
  return value;
}

function resolveYtdlp(explicit) {
  const candidates = [
    explicit,
    `${homedir()}/.local/bin/yt-dlp`,
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") && existsSync(candidate)) {
      return candidate;
    }
  }

  return explicit || "yt-dlp";
}

export function loadConfig() {
  const cookies = process.env.YTDLP_COOKIES?.trim();
  const cookiesFile = cookies ? resolve(cookies) : null;

  if (cookiesFile && !existsSync(cookiesFile)) {
    throw new Error(`No encontré el archivo de cookies: ${cookiesFile}`);
  }

  const guildIdRaw = process.env.GUILD_ID?.trim() || null;
  const guildId = !guildIdRaw || guildIdRaw.includes("poné_") ? null : guildIdRaw;

  return {
    token: required("DISCORD_TOKEN"),
    guildId,
    cookiesFile,
    ytdlpBin: resolveYtdlp(process.env.YTDLP_BIN?.trim()),
    idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS || 180_000),
    maxPlaylist: Number(process.env.MAX_PLAYLIST || 50),
  };
}
