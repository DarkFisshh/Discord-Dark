# Street Spotter

A free, self-hostable multiplayer **Street View bingo**. Everyone gets the same list of
things to find ("red car", "windmill", "llama"...). Explore anywhere in Street View, capture
a view for each word before the timer runs out, then vote together on every capture.

## How a round works

1. **Lobby**: the host shares the invite link (or the 5-letter room code). The host chooses
   the words: reroll one 🎲 or all of them, lock 🔒 the ones to keep, edit any word, or add
   custom ones (`word one; word two`). Players can suggest words, and the host accepts or
   dismisses them. Settings:
   - **Time limit**: 1 to 30 minutes, default 10.
   - **Region**: the whole world or one country. The map zooms to that country, and the
     server rejects captures from outside it.
   - **Official coverage only**: no user-uploaded photospheres.
   - **Anonymous voting**: hides who captured what while voting.
   - **Everyone votes**: when off, only the host decides.
2. **Explore**: click a blue line on the map, or press `Space` for the map centre, to drop
   into Street View. Frame the thing and press its **Capture** button or number key `1` to
   `9`. You get one capture per word, and capturing again replaces it. Everyone can see
   which words the others have already found, but not where. `Esc` returns to the map.
3. **Voting**: everybody looks through each capture together in an interactive panorama,
   word by word, and votes 👍 keep or 👎 remove. You can't vote on your own capture. A
   capture is removed if it gets more 👎 than 👍. The host can overrule the votes and give
   **+1 bonus** for great finds.
4. **Score**: each kept capture is worth 1 point, or 2 with the bonus. Totals carry over
   from round to round.

## Run it

You need Node.js 18 or newer and a Google Maps API key.

```bash
cd street-spotter
npm install
GOOGLE_MAPS_API_KEY=AIza... npm start     # http://localhost:3000
```

If you leave out `GOOGLE_MAPS_API_KEY`, each player is asked to paste their own key in the
browser. The key is saved only in that browser.

### Getting a Google Maps key (free for friend groups)

1. Go to <https://console.cloud.google.com/>, create a project, and enable the
   **Maps JavaScript API**. Google requires a billing account, but small use stays within the
   free monthly quota.
2. Under *Credentials*, create an API key. Restrict it to **Websites** using your domain,
   such as `https://your-app.onrender.com/*` and `http://localhost:3000/*`, and to the
   Maps JavaScript API. The key is visible in the page, so this restriction is what keeps it
   safe.
3. Optional: set a budget alert or a quota cap so you can never be billed by surprise.

Cost notes: each player loads the map once per session. Street View is billed per panorama
*load*, and the game reuses one panorama per player. A 4-player, 10-minute round therefore
uses a few dozen of Google's free monthly Street View loads.

### Putting it online for your friends

- **Render (free)**: on render.com go to *New* → *Web Service*, connect this GitHub repo,
  and set *Root Directory* to `street-spotter`, *Build Command* to `npm ci`, and
  *Start Command* to `node server.js`. Add the environment variable `GOOGLE_MAPS_API_KEY`.
  Free instances sleep when idle, so the first visit takes about 30 seconds.
- **Docker**: `docker build -t street-spotter . && docker run -p 3000:3000 -e GOOGLE_MAPS_API_KEY=... street-spotter`
- **Your own PC**: run `npm start` and share it with a tunnel such as
  `cloudflared tunnel --url http://localhost:3000`.

The game keeps everything in memory, so there is no database. Rooms disappear 30 minutes after the last player leaves.

## Development

```bash
npm test        # game-rule unit tests
```

- `server.js`: HTTP and WebSocket server, rooms, and connections
- `src/game.js`: all game rules, with no networking, so it can be unit tested
- `src/countries.js`: country borders (Natural Earth 1:10m) for region-locked rounds
- `src/words.js`: the built-in word list (~340 things you can spot in Street View)
- `public/`: the browser client, plain HTML, CSS and JS with no build step
