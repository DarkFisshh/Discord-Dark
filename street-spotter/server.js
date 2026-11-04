// Street Spotter server: serves the web client and runs game rooms over WebSockets.
//   PORT                 port to listen on (default 3000)
//   GOOGLE_MAPS_API_KEY  optional; if unset, each player pastes a key in the browser
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { Room, GameError, cleanName } from "./src/game.js";
import { listCountries } from "./src/countries.js";

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const countriesJson = JSON.stringify(listCountries());
const configJs = `window.SPOTTER_CONFIG = ${JSON.stringify({ apiKey: API_KEY })};`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/config.js") return send(res, 200, TYPES[".js"], configJs);
  if (url.pathname === "/countries.json") return send(res, 200, TYPES[".json"], countriesJson);
  if (url.pathname === "/healthz") return send(res, 200, "text/plain", "ok");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
  if (rel.startsWith("..")) return send(res, 400, "text/plain", "bad path");
  try {
    const body = await readFile(join(PUBLIC, rel));
    send(res, 200, TYPES[extname(rel)] || "application/octet-stream", body);
  } catch {
    // unknown paths fall back to the app so /?room=ABCD style links always work
    send(res, 200, TYPES[".html"], await readFile(join(PUBLIC, "index.html")));
  }
});

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
  res.end(body);
}

// ---------- rooms ----------

const rooms = new Map(); // code -> Room
const sockets = new Map(); // room code -> Set<ws>

function newCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  for (;;) {
    let code = "";
    const bytes = randomBytes(5);
    for (const b of bytes) code += letters[b % letters.length];
    if (!rooms.has(code)) return code;
  }
}

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const ws of sockets.get(code) || []) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "state", state: room.view(ws.playerId) }));
  }
}

function createRoom() {
  const code = newCode();
  const room = new Room(code, { onTimeUp: () => broadcast(code) });
  rooms.set(code, room);
  sockets.set(code, new Set());
  return room;
}

// rooms with nobody online for 30 minutes are deleted
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.isEmpty()) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > 30 * 60_000) {
      clearTimeout(room.timer);
      rooms.delete(code);
      sockets.delete(code);
    }
  }
}, 60_000).unref();

// ---------- websocket protocol ----------
// client -> server: {type:"hello", playerId, name, room?, create?} then {type:<action>, ...}
// server -> client: {type:"state", state} | {type:"error", message} | {type:"left"}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  const fail = (message) => ws.send(JSON.stringify({ type: "error", message }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail("Bad message.");
    }
    try {
      if (msg.type === "hello") return hello(ws, msg);
      if (msg.type === "leave") return leave(ws, true);
      const room = rooms.get(ws.roomCode);
      if (!room) return fail("You are not in a room.");
      if (msg.type === "rename") {
        const p = room.players.get(ws.playerId);
        if (p) p.name = cleanName(msg.name);
      } else {
        room.handle(ws.playerId, msg);
      }
      broadcast(room.code);
    } catch (e) {
      if (e instanceof GameError) return fail(e.message);
      console.error(e);
      fail("Something went wrong.");
    }
  });

  ws.on("close", () => leave(ws, false));
});

function hello(ws, { playerId, name, room: code, create }) {
  if (typeof playerId !== "string" || playerId.length < 8 || playerId.length > 64)
    throw new GameError("Bad player id.");
  if (ws.roomCode) leave(ws, false);
  let room;
  if (create) room = createRoom();
  else {
    room = rooms.get(String(code || "").toUpperCase());
    if (!room) throw new GameError("That room doesn't exist (anymore). Create a new one!");
  }
  room.join(playerId, name);
  // one live connection per player per room: close older tabs
  for (const other of sockets.get(room.code)) {
    if (other !== ws && other.playerId === playerId) {
      other.send(JSON.stringify({ type: "error", message: "You opened this room in another tab." }));
      other.roomCode = null;
      sockets.get(room.code).delete(other);
      other.close();
    }
  }
  ws.playerId = playerId;
  ws.roomCode = room.code;
  sockets.get(room.code).add(ws);
  broadcast(room.code);
}

function leave(ws, explicit) {
  const room = rooms.get(ws.roomCode);
  const set = sockets.get(ws.roomCode);
  if (set) set.delete(ws);
  if (room && ![...(set || [])].some((s) => s.playerId === ws.playerId)) {
    room.leave(ws.playerId);
    broadcast(room.code);
  }
  ws.roomCode = null;
  if (explicit && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "left" }));
}

// drop dead connections so players show as offline
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`Street Spotter running on http://localhost:${PORT}`);
  if (!API_KEY) console.log("No GOOGLE_MAPS_API_KEY set: players will be asked to paste a key in the browser.");
});
