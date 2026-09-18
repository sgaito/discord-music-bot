import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const iconsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/player");

const ICONS = {
  shuffle: "gaito_shuffle",
  prev: "gaito_prev",
  pause: "gaito_pause",
  play: "gaito_play",
  skip: "gaito_skip",
  queue: "gaito_queue",
  stop: "gaito_stop",
};

export async function ensurePlayerEmojis(rest, appId) {
  const ids = {};
  let existing = [];

  try {
    const data = await rest.get(`/applications/${appId}/emojis`);
    existing = Array.isArray(data) ? data : data.items || [];
  } catch (err) {
    console.error("[emojis] no pude listar emojis de la app:", err.message);
    return ids;
  }

  const byName = new Map(existing.map((emoji) => [emoji.name, emoji.id]));

  for (const [key, name] of Object.entries(ICONS)) {
    if (byName.has(name)) {
      ids[key] = byName.get(name);
      continue;
    }

    const file = path.join(iconsDir, `${key}.png`);
    if (!existsSync(file)) {
      console.error(`[emojis] falta ${file}`);
      continue;
    }

    const image = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
    try {
      const uploaded = await rest.post(`/applications/${appId}/emojis`, {
        body: { name, image },
      });
      ids[key] = uploaded.id;
      console.log(`[emojis] subí ${name}`);
    } catch (err) {
      console.error(`[emojis] no pude subir ${name}:`, err.message);
    }
  }

  return ids;
}
