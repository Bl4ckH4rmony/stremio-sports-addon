# 🏟️ Stremio Sports Live TV Addon

Live sports and TV channels inside Stremio, powered by DaddyLive.

## Channels included
- Premier League, La Liga, Serie A, Bundesliga
- NFL, NBA, NHL, MLB
- UFC / Boxing
- Cricket, Rugby, Tennis, Golf, F1
- 500+ international TV channels

## Deploy to Render (free)

1. Fork or push this repo to your GitHub account
2. Go to [render.com](https://render.com) and sign in with GitHub
3. Click **New → Web Service**
4. Select this repo
5. Render will auto-detect the config. Click **Deploy**
6. Once deployed, copy your URL (e.g. `https://stremio-sports-addon.onrender.com`)

## Add to Stremio

1. Open Stremio
2. Go to **Search → Addons**
3. Paste your Render URL + `/manifest.json`:
   ```
   https://your-app-name.onrender.com/manifest.json
   ```
4. Click Install

## Notes
- Free Render instances spin down after 15 mins of inactivity. First load may take ~30 seconds to wake up.
- Channel list refreshes every 15 minutes automatically.
- If streams don't play, try using MX Player or VLC as external player in Stremio.
