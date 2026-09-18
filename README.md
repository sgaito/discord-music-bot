# discord-music-bot

Bot chico de Discord para un server personal. Reproduce **enlaces de YouTube** (video, Shorts, live, playlist, music.youtube.com) y **links de Spotify** (tema, playlist, álbum, artista). El audio de Spotify no sale de Spotify: el bot lee el nombre y lo busca en YouTube.

## Dónde va el token

1. Copiá el ejemplo de entorno:

```bash
cp .env.example .env
```

2. Abrí `.env` y pegá el token acá:

```
DISCORD_TOKEN=el_token_que_copiaste_en_discord_developers
```

Ese valor sale de [Discord Developer Portal](https://discord.com/developers/applications) → tu aplicación → **Bot** → **Reset Token** / **Copy**.

3. En el mismo `.env` poné el ID de tu server (clic derecho en el icono del server → **Copiar ID de servidor**). Hace falta tener activado el modo desarrollador en Discord:

```
GUILD_ID=123456789012345678
```

Sin `GUILD_ID` los comandos slash pueden tardar hasta una hora en aparecer. Con el ID aparecen al toque.

**No subas el `.env` a git.** Ya está en `.gitignore`.

## Permisos del bot en Discord

En el portal, invitá el bot con scopes `bot` y `applications.commands`, y permisos:

- Connect
- Speak
- Send Messages
- Embed Links
- Use Voice Activity

URL de invitación (reemplazá `CLIENT_ID` por el Application ID):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=3148800&scope=bot%20applications.commands
```

Intents privilegiados: no hace falta ninguno.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/play url:` | Reproduce YouTube o Spotify. Si no es un link, busca **en YouTube** |
| `/skip` | Salta el tema |
| `/pause` / `/resume` | Pausa o sigue |
| `/queue` | Muestra la cola |
| `/np` | Lo que está sonando |
| `/stop` o `/leave` | Para todo y se va del canal |

También hay botones de pausa / skip / stop en el mensaje de “Reproduciendo”.

Se va solo a los 3 minutos de cola vacía.

## Spotify

1. Entrá a [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e iniciá sesión.
2. **Create app**. Nombre el que quieras. Redirect URI: `http://127.0.0.1:8888/callback` (Spotify no acepta `localhost`). No hace falta login de usuario.
3. Copiá **Client ID** y **Client Secret** al `.env`:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_MARKET=AR
```

4. Reiniciá el bot.

Acepta tema, playlist, álbum y artista (los más escuchados). Las playlists públicas las lee por la página embed de Spotify (la API oficial ya no da los temas de playlists ajenas). Playlists **privadas** no entran. Tope: 50 temas (`MAX_PLAYLIST`).

## Requisitos

- Node.js 20 o más nuevo
- ffmpeg
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (es lo que abre YouTube de verdad)

### En esta máquina (Arch)

Ya está `ffmpeg`. En esta PC no hay `npm` en el PATH; las dependencias de Node ya quedaron instaladas. `yt-dlp` quedó en `~/.local/bin/yt-dlp`.

```bash
cd ~/Projects/discord-music-bot
cp .env.example .env   # pegá token y GUILD_ID
node src/index.js
```

Si más adelante reinstalás dependencias: `sudo pacman -S npm && npm install`.

### En el VPS (Ubuntu)

```bash
sudo apt update
sudo apt install -y ffmpeg python3 python3-venv ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

Cloná el repo (o copialo con `scp`), instalá dependencias y creá el `.env` **en el VPS** (el token no viaja en git):

```bash
sudo mkdir -p /opt/discord-music-bot
sudo chown "$USER:$USER" /opt/discord-music-bot
git clone <url-del-repo> /opt/discord-music-bot
cd /opt/discord-music-bot
npm install
cp .env.example .env
nano .env
```

Servicio systemd (cambiá `User=ubuntu` en el archivo si tu usuario no se llama así):

```bash
sudo cp deploy/discord-music-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now discord-music-bot
sudo systemctl status discord-music-bot
```

Logs: `journalctl -u discord-music-bot -f`

## Si YouTube bloquea el VPS

Los IP de VPS a veces los marca como bot. Exportá cookies de tu navegador a `cookies.txt` (por ejemplo con la extensión “Get cookies.txt”), copiá el archivo al VPS y en el `.env`:

```
YTDLP_COOKIES=/opt/discord-music-bot/cookies.txt
```

Después: `sudo systemctl restart discord-music-bot`.
