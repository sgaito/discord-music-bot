const SPOTIFY_TYPES = new Set(["track", "album", "playlist", "artist"]);
const SPOTIFY_SKIP = new Set(["episode", "show", "audiobook", "chapter"]);

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenClientId = null;
let tokenClientSecret = null;

export function isSpotifyInput(input) {
  const value = input?.trim() || "";
  if (/^spotify:[a-z]+:/i.test(value)) return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "spotify.link" ||
      host.endsWith(".spotify.link") ||
      host === "spotify.app.link" ||
      host === "open.spotify.com" ||
      host === "play.spotify.com" ||
      host.endsWith(".spotify.com")
    );
  } catch {
    return false;
  }
}

export async function resolveSpotify(input, config) {
  if (!config.spotifyClientId || !config.spotifyClientSecret) {
    throw new Error("No tengo Spotify configurado. Poné SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET en el .env");
  }

  const parsed = parseSpotify(await unwrapSpotifyUrl(input));
  if (!parsed) {
    throw new Error("No pude leer ese link de Spotify");
  }
  if (SPOTIFY_SKIP.has(parsed.type)) {
    throw new Error("Eso es un podcast o un audiolibro, no lo pongo");
  }
  if (!SPOTIFY_TYPES.has(parsed.type)) {
    throw new Error("Pasame un tema, playlist, álbum o artista de Spotify");
  }

  const token = await getToken(config.spotifyClientId, config.spotifyClientSecret);
  const market = config.spotifyMarket;

  if (parsed.type === "track") {
    const data = await spotifyGet(`/tracks/${parsed.id}?market=${encodeURIComponent(market)}`, token);
    const track = toTrack(data);
    if (!track) throw new Error("Ese tema no lo pude leer");
    return { playlistTitle: null, tracks: [track] };
  }

  if (parsed.type === "album") {
    try {
      const album = await spotifyGet(`/albums/${parsed.id}?market=${encodeURIComponent(market)}`, token);
      const images = album.images || [];
      const tracks = await collectPaged(
        album.tracks || album.items,
        token,
        config.maxPlaylist,
        (item) => toTrack(item, images),
      );
      if (tracks.length) {
        return { playlistTitle: album.name || "Álbum", tracks };
      }
    } catch (err) {
      console.error("[spotify album]", err.message);
    }
    return resolveFromEmbed("album", parsed.id, config.maxPlaylist);
  }

  if (parsed.type === "playlist") {
    return resolveFromEmbed("playlist", parsed.id, config.maxPlaylist);
  }

  try {
    const artist = await spotifyGet(`/artists/${parsed.id}`, token);
    const top = await spotifyGet(
      `/artists/${parsed.id}/top-tracks?market=${encodeURIComponent(market)}`,
      token,
    );
    const tracks = (top.tracks || [])
      .map((item) => toTrack(item))
      .filter(Boolean)
      .slice(0, config.maxPlaylist);
    if (tracks.length) {
      return { playlistTitle: artist.name ? `Lo más de ${artist.name}` : "Artista", tracks };
    }
  } catch (err) {
    console.error("[spotify artist]", err.message);
  }
  return resolveFromEmbed("artist", parsed.id, config.maxPlaylist);
}

async function unwrapSpotifyUrl(input) {
  const value = input.trim();
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host !== "spotify.link" && !host.endsWith(".spotify.link") && host !== "spotify.app.link") {
      return value;
    }
    const res = await fetch(value, { redirect: "follow" });
    const finalUrl = res.url || value;
    res.body?.cancel();
    return finalUrl;
  } catch {
    return value;
  }
}

function parseSpotify(input) {
  const value = input.trim();
  const uri = value.match(/^spotify:([a-z]+):([a-zA-Z0-9]+)/i);
  if (uri) {
    return { type: uri[1].toLowerCase(), id: uri[2] };
  }

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    let index = 0;
    if (parts[0] && /^intl-/i.test(parts[0])) index += 1;
    if (parts[index] === "embed") index += 1;
    const type = parts[index]?.toLowerCase();
    const id = parts[index + 1]?.split("?")[0];
    if (!type || !id) return null;
    return { type, id };
  } catch {
    return null;
  }
}

async function getToken(clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  tokenClientId = clientId;
  tokenClientSecret = clientSecret;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("Spotify no me dio token. Revisá SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(30, Number(data.expires_in) || 3600) * 1000 - 60_000;
  return cachedToken;
}

async function spotifyGet(pathOrUrl, token, retried = false) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && !retried && tokenClientId && tokenClientSecret) {
    cachedToken = null;
    tokenExpiresAt = 0;
    const fresh = await getToken(tokenClientId, tokenClientSecret);
    return spotifyGet(pathOrUrl, fresh, true);
  }
  if (res.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    throw new Error("Se venció el token de Spotify, probá de nuevo");
  }
  if (res.status === 404) {
    throw new Error("No encontré eso en Spotify");
  }
  if (res.status === 403) {
    throw new Error("Spotify no me deja ver eso (puede ser privado o de otra región)");
  }
  if (res.status === 429) {
    throw new Error("Spotify me frenó un toque, probá de nuevo en un rato");
  }
  if (!res.ok) {
    throw new Error(data.error?.message || "Spotify me contestó mal");
  }
  return data;
}

async function collectPaged(firstPage, token, max, mapItem) {
  const tracks = [];
  let page = firstPage;

  while (page && tracks.length < max) {
    for (const item of page.items || []) {
      const track = mapItem(item);
      if (track) tracks.push(track);
      if (tracks.length >= max) break;
    }
    if (!page.next || tracks.length >= max) break;
    page = await spotifyGet(page.next, token);
  }

  return tracks;
}

async function resolveFromEmbed(type, id, max) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept: "text/html",
    },
  });
  if (!res.ok) {
    throw new Error(type === "playlist" ? "Esa playlist está vacía o es privada" : "No pude leer eso en Spotify");
  }

  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) {
    throw new Error("No pude leer esa playlist de Spotify");
  }

  const entity = JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity;
  const list = entity?.trackList;
  if (!entity || !Array.isArray(list) || list.length === 0) {
    throw new Error("Esa playlist está vacía o es privada");
  }

  const images = (entity.coverArt?.sources || []).map((source) => ({ url: source.url })).filter((img) => img.url);
  const tracks = list
    .filter((item) => !item.entityType || item.entityType === "track")
    .slice(0, max)
    .map((item) => embedToTrack(item, images))
    .filter(Boolean);

  if (!tracks.length) {
    throw new Error("Esa playlist está vacía o es privada");
  }

  return {
    playlistTitle: entity.title || entity.name || (type === "album" ? "Álbum" : "Playlist"),
    tracks,
  };
}

function embedToTrack(item, fallbackImages = []) {
  const title = item.title || item.name;
  if (!title) return null;

  const artist = item.subtitle || "Spotify";
  const id = String(item.uri || "").match(/spotify:track:([a-zA-Z0-9]+)/i)?.[1] || null;

  return {
    title,
    url: id ? `https://open.spotify.com/track/${id}` : null,
    youtubeQuery: `${artist} - ${title}`,
    duration: Math.round((Number(item.duration) || 0) / 1000),
    thumbnail: fallbackImages[0]?.url || null,
    uploader: artist,
  };
}

function toTrack(track, fallbackImages = []) {
  if (!track || track.is_local || track.type !== "track" || track.name == null) return null;

  const artists = (track.artists || []).map((artist) => artist.name).filter(Boolean);
  const artist = artists.join(", ") || "Spotify";
  const title = track.name || "Sin título";
  const images = track.album?.images?.length ? track.album.images : fallbackImages;
  const thumbnail = images[0]?.url || null;
  const id = track.id;

  return {
    title,
    url: id ? `https://open.spotify.com/track/${id}` : null,
    youtubeQuery: `${artist} - ${title}`,
    duration: Math.round((Number(track.duration_ms) || 0) / 1000),
    thumbnail,
    uploader: artist,
  };
}
