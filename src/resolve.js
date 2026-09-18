import { isSpotifyInput, resolveSpotify } from "./spotify.js";
import { resolveYouTube } from "./youtube.js";

export async function resolveQuery(input, config) {
  const query = input.trim();
  if (!query) {
    throw new Error("Pasame un link o un nombre");
  }
  if (isSpotifyInput(query)) {
    return resolveSpotify(query, config);
  }
  return resolveYouTube(query, config);
}
