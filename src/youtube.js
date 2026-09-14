import { spawn } from "node:child_process";

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export function isYouTubeUrl(input) {
  try {
    const url = new URL(input);
    return YT_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isPlaylistUrl(input) {
  try {
    const url = new URL(input);
    return url.pathname.includes("/playlist");
  } catch {
    return false;
  }
}

function cookieArgs(cookiesFile) {
  return cookiesFile ? ["--cookies", cookiesFile] : [];
}

function runYtdlp(bin, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("YouTube tardó demasiado en responder"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp no está instalado o no está en el PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(friendlyYtdlpError(stderr || `yt-dlp salió con código ${code}`)));
      } else {
        resolve(stdout);
      }
    });
  });
}

function friendlyYtdlpError(stderr) {
  const text = stderr.toLowerCase();
  if (text.includes("sign in") || text.includes("confirm you’re not a bot") || text.includes("not a bot")) {
    return "YouTube bloqueó el VPS. Exportá cookies del navegador a cookies.txt y poné YTDLP_COOKIES en el .env";
  }
  if (text.includes("private video") || text.includes("private")) {
    return "Ese video es privado";
  }
  if (text.includes("age") && text.includes("restrict")) {
    return "Ese video tiene restricción de edad. Probá con cookies de una cuenta logueada";
  }
  if (text.includes("unavailable") || text.includes("not available")) {
    return "Ese video no está disponible";
  }
  const firstLine = stderr.split("\n").map((l) => l.trim()).find(Boolean);
  return firstLine || "No pude leer ese enlace de YouTube";
}

function toTrack(entry, fallbackUrl) {
  const id = entry.id || entry.display_id;
  const url =
    entry.webpage_url ||
    entry.url ||
    (id ? `https://www.youtube.com/watch?v=${id}` : fallbackUrl);

  return {
    title: entry.title || "Sin título",
    url,
    duration: Number(entry.duration) || 0,
    thumbnail: Array.isArray(entry.thumbnails)
      ? entry.thumbnails.at(-1)?.url
      : entry.thumbnail || null,
    uploader: entry.uploader || entry.channel || entry.uploader_id || "YouTube",
  };
}

export async function resolveYouTube(input, { ytdlpBin, cookiesFile, maxPlaylist }) {
  const query = input.trim();
  if (!query) {
    throw new Error("Pasame un enlace de YouTube");
  }

  const args = [...cookieArgs(cookiesFile), "--no-warnings", "--skip-download", "-J", "--ignore-no-formats-error"];

  if (isYouTubeUrl(query)) {
    if (isPlaylistUrl(query)) {
      args.push("--yes-playlist", "--flat-playlist", "--playlist-end", String(maxPlaylist), query);
    } else {
      args.push("--no-playlist", "--no-flat-playlist", query);
    }
  } else if (/^https?:\/\//i.test(query)) {
    throw new Error("Solo reproduzco enlaces de YouTube (youtube.com / youtu.be / music.youtube.com)");
  } else {
    args.push("--no-playlist", `ytsearch1:${query}`);
  }

  const raw = await runYtdlp(ytdlpBin, args);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("YouTube devolvió una respuesta inválida");
  }

  if (data._type === "playlist") {
    const entries = (data.entries || []).filter(Boolean);
    if (!entries.length) {
      throw new Error("Esa playlist está vacía o no la pude leer");
    }

    const fromSearch = !isYouTubeUrl(query) || String(data.extractor || "").includes("search");
    if (fromSearch) {
      return { playlistTitle: null, tracks: [toTrack(entries[0], query)] };
    }

    return {
      playlistTitle: data.title || "Playlist",
      tracks: entries.map((entry) => toTrack(entry, query)),
    };
  }

  return { playlistTitle: null, tracks: [toTrack(data, query)] };
}

export function streamYouTube(url, { ytdlpBin, cookiesFile }) {
  const ytdlp = spawn(
    ytdlpBin,
    [
      ...cookieArgs(cookiesFile),
      "--no-warnings",
      "--quiet",
      "--no-playlist",
      "-f",
      "bestaudio/best",
      "--buffer-size",
      "16K",
      "-o",
      "-",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.stdout.on("error", () => {});
  ffmpeg.stdin.on("error", () => {});

  let stderr = "";
  ytdlp.stderr.setEncoding("utf8");
  ytdlp.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  ffmpeg.stderr.setEncoding("utf8");
  ffmpeg.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const cleanup = () => {
    if (!ytdlp.killed) ytdlp.kill("SIGKILL");
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  };

  ytdlp.on("error", cleanup);
  ffmpeg.on("error", cleanup);
  ytdlp.on("close", (code) => {
    if (code && code !== 0 && stderr) {
      ffmpeg.emit("error", new Error(friendlyYtdlpError(stderr)));
    }
    try {
      ffmpeg.stdin.end();
    } catch {
      // already closed
    }
  });

  return { stream: ffmpeg.stdout, cleanup };
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
