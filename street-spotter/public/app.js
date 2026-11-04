// Street Spotter web client.
const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const topCenter = $("#topbar-center");
const topRight = $("#topbar-right");

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function toast(msg, kind = "") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 4200);
}

// ---------- local identity ----------
const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let playerId = store.get("spotter.id");
if (!playerId) {
  playerId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  store.set("spotter.id", playerId);
}
let myName = store.get("spotter.name");
const serverKey = window.SPOTTER_CONFIG?.apiKey || "";
const apiKey = () => serverKey || store.get("spotter.key");

// ---------- connection ----------
let ws = null;
let state = null;
let wantRoom = new URLSearchParams(location.search).get("room")?.toUpperCase() || null;
let pendingCreate = false;
let retry = 0;
let clockOffset = 0;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/[^/]*$/, "")}`);
  ws.onopen = () => {
    retry = 0;
    if (state?.code) hello({ room: state.code });
    else if (pendingCreate) hello({ create: true });
    // coming back via a room link (or a page refresh) with a name already set: rejoin right away
    else if (wantRoom && myName && apiKey()) hello({ room: wantRoom });
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") {
      pendingCreate = false;
      const prev = state;
      state = msg.state;
      if (state.serverNow) clockOffset = state.serverNow - Date.now();
      if (!prev || prev.code !== state.code) {
        history.replaceState(null, "", `?room=${state.code}`);
      }
      render(prev);
    } else if (msg.type === "error") {
      toast(msg.message, "error");
      if (!state) { wantRoom = null; history.replaceState(null, "", location.pathname); render(); }
    } else if (msg.type === "left") {
      state = null;
      wantRoom = null;
      history.replaceState(null, "", location.pathname);
      render();
    }
  };
  ws.onclose = () => {
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    if (state) toast("Connection lost, reconnecting…", "error");
  };
}
function hello(extra) {
  send({ type: "hello", playerId, name: myName || "Player", ...extra });
}
function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast("Not connected yet, try again in a second.", "error");
}
const act = (type, extra = {}) => send({ type, ...extra });

// ---------- helpers ----------
const me = () => state?.players.find((p) => p.id === playerId);
const isHost = () => state?.hostId === playerId;
const nameOf = (id) => state?.players.find((p) => p.id === id)?.name ?? "Someone";
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// Keep focus/typing intact across re-renders triggered by other players.
function preserveFocus(fn) {
  const a = document.activeElement;
  const key = a?.dataset?.key;
  const info = key && { key, value: a.value, start: a.selectionStart, end: a.selectionEnd };
  fn();
  if (info) {
    const el = document.querySelector(`[data-key="${CSS.escape(info.key)}"]`);
    if (el) {
      el.value = info.value;
      el.focus();
      try { el.setSelectionRange(info.start, info.end); } catch {}
    }
  }
}

// ---------- render ----------
function render(prev) {
  const phase = state?.phase ?? "home";
  document.body.dataset.phase = phase;
  $("#explore").classList.toggle("hidden", phase !== "ingame");
  $("#vote-pano-wrap").classList.toggle("hidden", phase !== "voting");
  if (phase !== "ingame") stopTimer();
  renderTopbar();
  preserveFocus(() => {
    app.replaceChildren();
    if (phase === "home") app.append(viewHome());
    else if (phase === "lobby") app.append(viewLobby());
    else if (phase === "ingame") app.append(viewIngame(prev));
    else if (phase === "voting") app.append(viewVoting(prev));
    else if (phase === "score") app.append(viewScore());
  });
  app.style.padding = phase === "ingame" || phase === "voting" ? "0" : "";
}

function renderTopbar() {
  topCenter.replaceChildren();
  topRight.replaceChildren();
  if (!state) return;
  if (state.phase === "ingame") topCenter.append(h("span", { id: "timer", class: "timer" }, "--:--"));
  else topCenter.append(h("span", { class: "muted" }, `Room ${state.code}`, state.round ? ` · Round ${state.round}` : ""));
  topRight.append(
    h("span", { class: "pill" }, `${state.players.filter((p) => p.online).length} online`),
    h("button", {
      class: "btn small ghost",
      onclick: () => { if (confirm("Leave this room?")) act("leave"); },
    }, "Leave"),
  );
}

// ---------- home ----------
function viewHome() {
  const nameInput = h("input", { type: "text", placeholder: "Your name", maxlength: 24, value: myName, "data-key": "home-name" });
  const codeInput = h("input", { type: "text", placeholder: "Room code", maxlength: 5, value: wantRoom || "", "data-key": "home-code", style: "text-transform:uppercase" });
  const go = (create) => {
    myName = nameInput.value.trim() || "Player";
    store.set("spotter.name", myName);
    if (!apiKey()) return toast("Paste a Google Maps API key first (see below).", "error");
    if (create) { pendingCreate = true; hello({ create: true }); }
    else {
      const code = codeInput.value.trim().toUpperCase();
      if (!code) return toast("Enter a room code.", "error");
      hello({ room: code });
    }
  };
  codeInput.addEventListener("keydown", (e) => e.key === "Enter" && go(false));

  const keyBox = serverKey ? null : h("div", { class: "card stack" },
    h("h2", {}, "Google Maps key"),
    h("p", { class: "muted", style: "margin:0" },
      "Street View is provided by Google. Each player needs a key (or the person hosting the server sets ",
      h("code", {}, "GOOGLE_MAPS_API_KEY"), " once for everyone). Google's free monthly quota is plenty for a group of friends. ",
      h("a", { href: "https://developers.google.com/maps/documentation/javascript/get-api-key", target: "_blank", rel: "noopener" }, "Get a key"),
      " and enable the Maps JavaScript API."),
    h("input", {
      type: "password", placeholder: "AIza…", value: store.get("spotter.key"), "data-key": "home-key",
      onchange: (e) => { store.set("spotter.key", e.target.value.trim()); toast("Key saved in this browser.", "ok"); },
    }),
  );

  return h("div", { class: "home" },
    h("section", { class: "hero" },
      h("h1", {}, "Find it ", h("em", {}, "anywhere"), " on Earth."),
      h("p", {}, "A multiplayer Street View bingo. Everyone gets the same list of things to find. Explore the world in Street View, snap each one before time runs out, then vote on each other's finds."),
      h("ol", { class: "steps" },
        h("li", {}, h("b", { class: "n" }, "1"), h("div", {}, h("b", {}, "Create a room"), h("div", { class: "muted" }, "Share the link, pick or write the words."))),
        h("li", {}, h("b", { class: "n" }, "2"), h("div", {}, h("b", {}, "Explore & capture"), h("div", { class: "muted" }, "Click the map to drop into Street View, frame the thing and hit its capture button."))),
        h("li", {}, h("b", { class: "n" }, "3"), h("div", {}, h("b", {}, "Vote"), h("div", { class: "muted" }, "Go through every capture together. Is that really a llama? Keep or remove."))),
        h("li", {}, h("b", { class: "n" }, "4"), h("div", {}, h("b", {}, "Score"), h("div", { class: "muted" }, "1 point per accepted find, +1 bonus for great ones. Play as many rounds as you like."))),
      ),
    ),
    h("div", { class: "stack" },
      h("div", { class: "card stack" },
        h("h2", {}, wantRoom ? `Join room ${wantRoom}` : "Play"),
        nameInput,
        wantRoom
          ? h("button", { class: "btn primary big", onclick: () => go(false) }, "Join game")
          : h("button", { class: "btn primary big", onclick: () => go(true) }, "Create a room"),
        h("div", { class: "or" }, wantRoom ? "or" : "or join friends"),
        h("div", { class: "row" }, codeInput, h("button", { class: "btn", onclick: () => go(false) }, "Join")),
        wantRoom && h("button", { class: "btn ghost", onclick: () => go(true) }, "Create my own room instead"),
      ),
      keyBox,
    ),
  );
}

// ---------- lobby ----------
let countries = null;
async function loadCountries() {
  if (countries) return countries;
  countries = await fetch("countries.json").then((r) => r.json()).catch(() => []);
  return countries;
}

function viewLobby() {
  const host = isHost();
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
  const s = state.settings;

  const players = h("div", { class: "card" },
    h("h2", {}, "Players"),
    h("div", { class: "code" }, state.code),
    h("div", { class: "invite", style: "margin:8px 0 14px" },
      h("button", {
        class: "btn small primary",
        onclick: async () => {
          try { await navigator.clipboard.writeText(link); toast("Invite link copied!", "ok"); }
          catch { prompt("Copy this link:", link); }
        },
      }, "Copy invite link"),
    ),
    h("ul", { class: "players" }, state.players.map((p) =>
      h("li", { class: p.online ? "" : "off" },
        h("span", { class: "dot" }),
        h("span", { class: "name", title: p.name }, p.name, p.id === playerId ? " (you)" : ""),
        p.id === state.hostId && h("span", { class: "pill host" }, "host"),
        h("span", { class: "pts" }, p.total),
        host && p.id !== playerId && h("button", {
          class: "btn icon small ghost", title: "Make host",
          onclick: () => act("makeHost", { playerId: p.id }), disabled: !p.online,
        }, "👑"),
        host && p.id !== playerId && h("button", {
          class: "btn icon small ghost", title: "Kick",
          onclick: () => confirm(`Kick ${p.name}?`) && act("kick", { playerId: p.id }),
        }, "✕"),
      ))),
    h("div", { class: "row", style: "margin-top:12px" },
      h("input", {
        type: "text", maxlength: 24, value: me()?.name, "data-key": "rename", "aria-label": "Your name", placeholder: "Your name", title: "Change your name",
        onchange: (e) => { myName = e.target.value.trim() || "Player"; store.set("spotter.name", myName); act("rename", { name: myName }); },
      }),
    ),
  );

  const words = h("div", { class: "card col-words" },
    h("div", { class: "row" },
      h("h2", { style: "margin:0" }, `Words (${state.words.length})`),
      h("span", { class: "spacer" }),
      host && h("button", { class: "btn small", onclick: () => act("rerollAll"), title: "New random words (locked words stay)" }, "🎲 Reroll all"),
    ),
    h("p", { class: "muted", style: "margin:6px 0 12px;font-size:14px" },
      "Find one Street View spot for each word. Each accepted capture is worth 1 point."),
    h("ul", { class: "words" }, state.words.map((w, i) =>
      h("li", { class: w.locked ? "locked" : "" },
        host
          ? h("input", {
              type: "text", value: w.text, maxlength: 100, "data-key": `word-${i}`,
              onchange: (e) => act("setWord", { index: i, text: e.target.value }),
              onkeydown: (e) => e.key === "Enter" && e.target.blur(),
            })
          : h("span", { class: "text" }, w.text),
        host && h("button", { class: `btn icon small ${w.locked ? "on" : ""}`, title: w.locked ? "Unlock" : "Lock (keep when rerolling all)", onclick: () => act("toggleLock", { index: i }) }, w.locked ? "🔒" : "🔓"),
        host && h("button", { class: "btn icon small", title: "Random new word", onclick: () => act("rerollWord", { index: i }) }, "🎲"),
        host && h("button", { class: "btn icon small", title: "Remove", onclick: () => act("deleteWord", { index: i }) }, "✕"),
      ))),
    host ? hostWordTools() : suggestBox(),
  );

  const settings = h("div", { class: "card" },
    h("h2", {}, "Settings"),
    h("label", { class: "setting" },
      h("span", {}, `Time limit: ${s.minutes} min`),
      h("input", {
        type: "range", min: 1, max: 30, value: Math.min(30, s.minutes), disabled: !host,
        oninput: (e) => (e.target.previousSibling.textContent = `Time limit: ${e.target.value} min`),
        onchange: (e) => act("settings", { settings: { minutes: +e.target.value } }),
      }),
    ),
    h("label", { class: "setting" },
      h("span", {}, "Region"),
      countrySelect(host, s),
    ),
    toggle("onlyOfficial", "Official coverage only", "No user-uploaded photospheres.", host, s),
    toggle("anonVoting", "Anonymous voting", "Hide who captured what while voting.", host, s),
    toggle("everyoneVotes", "Everyone votes", "Off = only the host decides.", host, s),
    h("div", { class: "start-box stack" },
      host
        ? h("button", { class: "btn primary big", onclick: () => act("start"), disabled: !state.words.length }, "▶ Start round")
        : h("div", { class: "muted" }, `Waiting for ${nameOf(state.hostId)} to start…`),
      host && state.round > 0 && h("button", {
        class: "btn small ghost",
        onclick: () => confirm("Reset everyone's score to 0?") && act("resetScores"),
      }, "Reset scores"),
    ),
  );

  return h("div", {},
    state.notice && h("div", { class: "notice" }, state.notice),
    h("div", { class: "lobby" }, players, words, settings),
  );
}

function hostWordTools() {
  const custom = h("input", { type: "text", placeholder: "Add your own words (use ; for several)", "data-key": "custom-words", maxlength: 1000 });
  const add = () => { if (custom.value.trim()) { act("addWords", { text: custom.value }); custom.value = ""; } };
  custom.addEventListener("keydown", (e) => e.key === "Enter" && add());
  return h("div", { class: "stack" },
    h("div", { class: "row" }, custom, h("button", { class: "btn", onclick: add }, "Add")),
    h("div", { class: "row" }, h("button", { class: "btn small", onclick: () => act("addRandomWord") }, "+ Random word")),
    state.suggestions?.length > 0 && h("div", {},
      h("div", { class: "row" },
        h("b", {}, "Suggestions from players"), h("span", { class: "spacer" }),
        h("button", { class: "btn small ghost", onclick: () => act("clearSuggestions") }, "Clear all")),
      h("ul", { class: "suggestions" }, state.suggestions.map((sg, i) =>
        h("li", {},
          h("span", {}, sg.text, h("span", { class: "muted" }, ` · ${sg.by}`)),
          h("button", { class: "btn small good", onclick: () => act("acceptSuggestion", { index: i }) }, "Add"),
          h("button", { class: "btn small ghost", onclick: () => act("dismissSuggestion", { index: i }) }, "✕"),
        ))),
    ),
  );
}

function suggestBox() {
  const inp = h("input", { type: "text", placeholder: "Suggest a word to the host (; for several)", "data-key": "suggest", maxlength: 1000 });
  const go = () => { if (inp.value.trim()) { act("suggest", { text: inp.value }); inp.value = ""; toast("Suggestion sent!", "ok"); } };
  inp.addEventListener("keydown", (e) => e.key === "Enter" && go());
  return h("div", { class: "row" }, inp, h("button", { class: "btn", onclick: go }, "Suggest"));
}

function toggle(key, label, help, host, s) {
  return h("label", { class: "check" },
    h("input", { type: "checkbox", checked: s[key], disabled: !host, onchange: (e) => act("settings", { settings: { [key]: e.target.checked } }) }),
    h("span", {}, label, h("small", {}, help)),
  );
}

function countrySelect(host, s) {
  const sel = h("select", {
    disabled: !host,
    onchange: (e) => act("settings", { settings: { countryId: e.target.value || null } }),
  }, h("option", { value: "" }, "🌍 Whole world"));
  if (s.country) sel.append(h("option", { value: s.country.id, selected: true }, s.country.name));
  loadCountries().then((list) => {
    for (const c of list) if (c.id !== s.country?.id) sel.append(h("option", { value: c.id }, c.name));
    if (s.country) sel.value = s.country.id;
  });
  return sel;
}

// ---------- Google Maps ----------
let gmapsPromise = null;
function loadGoogleMaps() {
  if (window.google?.maps) return Promise.resolve();
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    window.__spotterMapsReady = resolve;
    window.gm_authFailure = () => {
      toast("Google rejected the Maps API key. Check that it's valid and the Maps JavaScript API is enabled.", "error");
      if (!serverKey) store.set("spotter.key", "");
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey())}&v=weekly&callback=__spotterMapsReady&loading=async`;
    s.async = true;
    s.onerror = () => { gmapsPromise = null; reject(new Error("Could not load Google Maps.")); };
    document.head.append(s);
  });
  return gmapsPromise;
}

let map = null;
let pano = null; // the map's built-in Street View panorama
let svService = null;
let mapRound = 0;

async function ensureMap() {
  await loadGoogleMaps();
  if (map) return;
  map = new google.maps.Map($("#map"), {
    center: { lat: 25, lng: 10 }, zoom: 2, minZoom: 2,
    mapTypeControl: false, fullscreenControl: false, streetViewControl: true,
    clickableIcons: false, gestureHandling: "greedy",
  });
  new google.maps.StreetViewCoverageLayer().setMap(map);
  svService = new google.maps.StreetViewService();
  pano = map.getStreetView();
  pano.setOptions({
    addressControl: true, fullscreenControl: false, motionTracking: false,
    motionTrackingControl: false, showRoadLabels: true, enableCloseButton: false,
  });
  pano.addListener("visible_changed", () => { updateExploreUi(); });
  pano.addListener("pano_changed", () => updateExploreUi());
  map.addListener("click", (e) => enterStreetView(e.latLng));
}

function streetViewSources() {
  const S = google.maps.StreetViewSource;
  if (state?.settings.onlyOfficial) return S.GOOGLE ? { sources: [S.GOOGLE] } : { source: S.OUTDOOR };
  return {};
}

function enterStreetView(latLng) {
  if (!svService) return;
  const metersPerPx = 156543 / 2 ** map.getZoom();
  const radius = Math.min(200000, Math.max(50, metersPerPx * 40));
  svService.getPanorama(
    { location: latLng, radius, preference: google.maps.StreetViewPreference.NEAREST, ...streetViewSources() },
    (data, status) => {
      if (status !== "OK" || !data?.location?.pano) return toast("No Street View here. Try a blue line.", "error");
      pano.setPano(data.location.pano);
      pano.setPov({ heading: 0, pitch: 0 });
      pano.setZoom(0);
      pano.setVisible(true);
    },
  );
}

function inStreetView() {
  return !!(pano && pano.getVisible() && pano.getPano());
}

function updateExploreUi() {
  const sv = inStreetView();
  $("#exit-sv").classList.toggle("hidden", !sv);
  $("#explore-hint").textContent = sv
    ? "Frame the thing, then press its capture button (or its number key)"
    : "Click anywhere on a blue line to enter Street View (Space = map center)";
  document.querySelectorAll("[data-capture]").forEach((b) => (b.disabled = !sv));
}

function fitRegion() {
  const c = state.settings.country;
  if (c) {
    const { w, s, e, n } = c.bbox;
    map.fitBounds(new google.maps.LatLngBounds({ lat: s, lng: w }, { lat: n, lng: e }));
  } else {
    map.setCenter({ lat: 25, lng: 10 });
    map.setZoom(2);
  }
}

// ---------- in game ----------
let timerHandle = null;
function startTimer() {
  stopTimer();
  const tick = () => {
    const el = $("#timer");
    if (!el || !state?.endsAt) return;
    const left = Math.max(0, (state.endsAt - (Date.now() + clockOffset)) / 1000);
    el.textContent = fmtTime(Math.ceil(left));
    el.classList.toggle("low", left <= 30);
  };
  tick();
  timerHandle = setInterval(tick, 250);
}
function stopTimer() { clearInterval(timerHandle); timerHandle = null; }

function viewIngame(prev) {
  const newRound = prev?.phase !== "ingame" || prev?.round !== state.round;
  startTimer();
  ensureMap().then(() => {
    if (newRound && mapRound !== state.round) {
      mapRound = state.round;
      pano.setVisible(false);
      fitRegion();
    }
    updateExploreUi();
  }).catch((e) => toast(e.message, "error"));

  const mine = new Map(state.captures.filter((c) => c.playerId === playerId).map((c) => [c.word, c]));
  const finders = (i) => state.captures.filter((c) => c.word === i && c.playerId !== playerId);
  const region = state.settings.country ? `in ${state.settings.country.name}` : "anywhere in the world";
  const total = state.words.length;

  return h("aside", { class: "ingame-side" },
    h("div", { class: "row" },
      h("b", {}, `Found ${mine.size}/${total}`),
      h("span", { class: "spacer" }),
      isHost() && h("button", {
        class: "btn small", onclick: () => confirm("End the round now for everyone?") && act("endRound"),
      }, "End round"),
    ),
    h("div", { class: "muted", style: "font-size:13px" }, `Find these ${region}.`),
    h("ul", { class: "capture-list" }, state.words.map((w, i) => {
      const got = mine.get(i);
      const others = finders(i);
      return h("li", { class: `capture-item ${got ? "done" : ""}` },
        h("div", { class: "top" },
          i < 9 && h("kbd", {}, i + 1),
          h("span", { class: "w" }, w.text),
          got && h("span", { title: "Captured" }, "✅"),
        ),
        h("div", { class: "row" },
          h("button", {
            class: `btn small ${got ? "" : "primary"}`, "data-capture": i, disabled: !inStreetView(),
            onclick: () => doCapture(i),
          }, got ? "📸 Recapture" : "📸 Capture"),
          got && h("button", { class: "btn small ghost", title: "Go back to your capture", onclick: () => showCapture(got.pano) }, "👁 View"),
          got && h("button", { class: "btn small ghost", title: "Remove capture", onclick: () => act("uncapture", { word: i }) }, "✕"),
        ),
        others.length > 0 && h("div", { class: "finders" }, others.map((c) => h("span", { class: "finder" }, `✓ ${nameOf(c.playerId)}`))),
      );
    })),
  );
}

function doCapture(i) {
  if (!inStreetView()) return toast("Enter Street View first.", "error");
  const pos = pano.getPosition();
  const pov = pano.getPov();
  act("capture", {
    word: i,
    pano: { id: pano.getPano(), lat: pos.lat(), lng: pos.lng(), heading: pov.heading, pitch: pov.pitch, zoom: pano.getZoom() },
  });
  flash();
}

function flash() {
  const f = h("div", { style: "position:fixed;inset:0;background:#fff;opacity:.7;z-index:50;pointer-events:none;transition:opacity .35s" });
  document.body.append(f);
  requestAnimationFrame(() => requestAnimationFrame(() => (f.style.opacity = "0")));
  setTimeout(() => f.remove(), 400);
}

function showCapture(p) {
  if (!pano) return;
  pano.setPano(p.id);
  pano.setPov({ heading: p.heading, pitch: p.pitch });
  pano.setZoom(p.zoom);
  pano.setVisible(true);
}

$("#exit-sv").addEventListener("click", () => pano?.setVisible(false));

document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, textarea, select")) return;
  if (state?.phase === "ingame") {
    if (e.key === "Escape" && inStreetView()) { pano.setVisible(false); e.preventDefault(); }
    else if (e.key === " " && map && !inStreetView()) { enterStreetView(map.getCenter()); e.preventDefault(); }
    else if (/^[1-9]$/.test(e.key) && inStreetView() && +e.key <= state.words.length) doCapture(+e.key - 1);
  } else if (state?.phase === "voting" && isHost()) {
    if (e.key === "ArrowRight") act("setVoteIndex", { index: state.voteIndex + 1 });
    if (e.key === "ArrowLeft") act("setVoteIndex", { index: state.voteIndex - 1 });
  }
});

// ---------- voting ----------
let votePano = null;
let shownCapture = null;

async function showVotePano(c) {
  await loadGoogleMaps();
  if (!votePano) {
    votePano = new google.maps.StreetViewPanorama($("#vote-pano"), {
      addressControl: true, fullscreenControl: true, motionTracking: false, motionTrackingControl: false,
      enableCloseButton: false, showRoadLabels: true,
    });
  }
  const key = `${c.id}:${c.pano.id}:${c.pano.heading}`;
  if (shownCapture === key) return;
  shownCapture = key;
  votePano.setPano(c.pano.id);
  votePano.setPov({ heading: c.pano.heading, pitch: c.pano.pitch });
  votePano.setZoom(c.pano.zoom);
  votePano.setVisible(true);
}

function viewVoting() {
  const caps = state.captures;
  const idx = Math.min(state.voteIndex, caps.length - 1);
  const c = caps[idx];
  const host = isHost();
  showVotePano(c).catch((e) => toast(e.message, "error"));

  const myVote = c.keep.includes(playerId) ? "keep" : c.remove.includes(playerId) ? "remove" : null;
  const canVote = !c.mine && (state.settings.everyoneVotes || host);
  const vote = (v) => act("vote", { captureId: c.id, vote: myVote === v ? null : v });
  const who = c.playerId ? nameOf(c.playerId) : "???";
  const gmaps = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(c.pano.id)}&heading=${c.pano.heading}&pitch=${c.pano.pitch}`;
  const names = (ids) => ids.map(nameOf).join(", ");

  return h("aside", { class: "vote-side" },
    h("div", { class: "row" },
      h("span", { class: "muted" }, `Capture ${idx + 1} of ${caps.length}`),
      h("span", { class: "spacer" }),
      h("span", { class: `status ${c.removed ? "removed" : "kept"}` }, c.removed ? "Removed" : c.extra ? "Kept +1" : "Kept"),
    ),
    h("h1", { class: "vote-word" }, state.words[c.word]?.text ?? "?"),
    h("div", { class: "vote-by" },
      c.mine ? "Your capture" : `Found by ${who}`, ` · after ${fmtTime(c.time)}`, " · ",
      h("a", { href: gmaps, target: "_blank", rel: "noopener" }, "open in Google Maps")),
    canVote
      ? h("div", { class: "vote-buttons" },
          h("button", { class: `btn good ${myVote === "keep" ? "chosen" : ""}`, onclick: () => vote("keep") }, `👍 Keep (${c.keep.length})`),
          h("button", { class: `btn bad ${myVote === "remove" ? "chosen" : ""}`, onclick: () => vote("remove") }, `👎 Remove (${c.remove.length})`),
        )
      : h("div", { class: "muted" }, c.mine ? `You can't vote on your own capture. 👍 ${c.keep.length} · 👎 ${c.remove.length}` : `Only the host votes in this room. 👍 ${c.keep.length} · 👎 ${c.remove.length}`),
    h("div", { class: "voters" },
      c.keep.length > 0 && h("div", {}, "👍 ", names(c.keep)),
      c.remove.length > 0 && h("div", {}, "👎 ", names(c.remove))),
    host && h("div", { class: "stack card", style: "padding:12px" },
      h("b", {}, "Host decision"),
      h("div", { class: "segmented" },
        [["Follow votes", null], ["Keep", false], ["Remove", true]].map(([label, val]) =>
          h("button", { class: c.override === val ? "sel" : "", onclick: () => act("setOverride", { captureId: c.id, value: val }) }, label)),
      ),
      h("button", {
        class: `btn ${c.extra ? "gold" : ""}`, disabled: c.removed,
        onclick: () => act("toggleExtra", { captureId: c.id }),
      }, c.extra ? "⭐ +1 bonus point given" : "⭐ Give +1 bonus point"),
    ),
    host && h("div", { class: "row" },
      h("button", { class: "btn", disabled: idx === 0, onclick: () => act("setVoteIndex", { index: idx - 1 }) }, "← Prev"),
      h("span", { class: "spacer" }),
      idx < caps.length - 1
        ? h("button", { class: "btn primary", onclick: () => act("setVoteIndex", { index: idx + 1 }) }, "Next →")
        : h("button", { class: "btn primary", onclick: () => act("toScore") }, "Show scores 🏆"),
    ),
    !host && h("div", { class: "muted", style: "font-size:13px" }, `${nameOf(state.hostId)} moves to the next capture.`),
    h("div", {},
      h("div", { class: "muted", style: "font-size:13px;margin-bottom:6px" }, "All captures"),
      h("div", { class: "thumbs" }, caps.map((x, i) =>
        h("button", {
          class: `thumb ${x.removed ? "removed" : ""} ${x.extra ? "extra" : ""} ${i === idx ? "current" : ""}`,
          title: `${state.words[x.word]?.text}${x.playerId ? ` · ${nameOf(x.playerId)}` : ""}`,
          disabled: !host, onclick: () => act("setVoteIndex", { index: i }),
        }, x.word + 1))),
    ),
    host && h("button", { class: "btn small ghost", onclick: () => act("toScore") }, "Skip to scores"),
  );
}

// ---------- score ----------
function viewScore() {
  const round = state.roundPoints || {};
  const rows = state.players
    .map((p) => ({ ...p, round: round[p.id] || 0, sum: p.total + (round[p.id] || 0) }))
    .filter((p) => p.online || p.sum > 0)
    .sort((a, b) => b.sum - a.sum || b.round - a.round);
  const host = isHost();
  const top = rows[0]?.sum;
  return h("div", { class: "score card" },
    h("h2", {}, `Round ${state.round} results`),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Player"), h("th", { class: "num" }, "This round"), h("th", { class: "num" }, "Total"))),
      h("tbody", {}, rows.map((p, i) =>
        h("tr", { class: p.sum === top && top > 0 ? "first" : "" },
          h("td", {}, p.sum === top && top > 0 ? "🏆" : i + 1),
          h("td", {}, p.name, p.id === playerId ? " (you)" : ""),
          h("td", { class: "num plus" }, p.round ? `+${p.round}` : "0"),
          h("td", { class: "num" }, p.sum),
        ))),
    ),
    h("div", { class: "row", style: "margin-top:18px" },
      host ? [
        h("button", { class: "btn", onclick: () => act("backToVoting") }, "← Back to voting"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn primary big", onclick: () => act("toLobby") }, "Next round →"),
      ] : h("span", { class: "muted" }, `Waiting for ${nameOf(state.hostId)} to start the next round…`),
    ),
  );
}

render();
connect();
