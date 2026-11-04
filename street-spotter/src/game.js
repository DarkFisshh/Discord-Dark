// Pure game logic for one room. No networking in here, so it can be unit tested.
//
// Round flow (same as the classic street-view bingo format):
//   lobby  -> host picks words + settings, players can suggest words
//   ingame -> timer runs, everyone explores Street View and captures one view per word
//   voting -> everyone walks through the captures together and votes keep/remove,
//             host can overrule and hand out a +1 bonus for great finds
//   score  -> 1 point per kept capture (+1 bonus), added to the running totals

import { WORDS } from "./words.js";
import { getCountry, isInCountry } from "./countries.js";

export const MAX_PLAYERS = 50;
export const MAX_WORDS = 100;
export const MAX_WORD_LEN = 100;
export const MAX_NAME_LEN = 24;

const PHASES = ["lobby", "ingame", "voting", "score"];
const OFFICIAL_PANO = /^[A-Za-z0-9_-]{22}$/;

export class GameError extends Error {}

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const cleanText = (s, max) =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function cleanName(name) {
  return cleanText(name, MAX_NAME_LEN) || "Player";
}

export class Room {
  constructor(code, { random = Math.random, now = () => Date.now(), onTimeUp } = {}) {
    this.code = code;
    this.random = random;
    this.now = now;
    this.onTimeUp = onTimeUp; // called when the round timer runs out
    this.players = new Map(); // id -> { id, name, online, joinedAt }
    this.kicked = new Set();
    this.hostId = null;
    this.phase = "lobby";
    this.settings = {
      minutes: 10,
      onlyOfficial: false,
      anonVoting: false,
      everyoneVotes: true,
      countryId: null,
    };
    this.words = [];
    for (let i = 0; i < 5; i++) this.words.push({ text: this.randomWord(), locked: false });
    this.suggestions = [];
    this.captures = [];
    this.voteIndex = 0;
    this.totals = {}; // committed scores from finished rounds: playerId -> points
    this.round = 0;
    this.endsAt = null;
    this.timer = null;
    this.notice = null;
    this.nextCaptureId = 1;
  }

  // ---------- players ----------

  join(id, name) {
    if (this.kicked.has(id)) throw new GameError("You were kicked from this room.");
    let p = this.players.get(id);
    if (!p) {
      const online = [...this.players.values()].filter((x) => x.online).length;
      if (online >= MAX_PLAYERS) throw new GameError("This room is full.");
      p = { id, name: cleanName(name), online: true, joinedAt: this.now() };
      this.players.set(id, p);
    } else {
      p.online = true;
      if (name) p.name = cleanName(name);
    }
    if (!this.hostId || !this.players.get(this.hostId)?.online) this.hostId = id;
    return p;
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.online = false;
    if (this.hostId === id) {
      const next = [...this.players.values()]
        .filter((x) => x.online)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) this.hostId = next.id;
    }
  }

  isEmpty() {
    return ![...this.players.values()].some((p) => p.online);
  }

  // ---------- actions ----------

  handle(playerId, msg) {
    const fn = ACTIONS[msg?.type];
    if (!fn) throw new GameError("Unknown action.");
    if (!this.players.has(playerId)) throw new GameError("You are not in this room.");
    const def = fn;
    if (def.host && playerId !== this.hostId) throw new GameError("Only the host can do that.");
    if (def.phase && !def.phase.includes(this.phase))
      throw new GameError("You can't do that right now.");
    this.notice = null;
    def.run.call(this, playerId, msg);
  }

  randomWord() {
    const used = new Set(this.words.map((w) => w.text.toLowerCase()));
    const pool = WORDS.filter((w) => !used.has(w.toLowerCase()));
    const list = pool.length ? pool : WORDS;
    return list[Math.floor(this.random() * list.length)];
  }

  wordAt(i) {
    const w = Number.isInteger(i) ? this.words[i] : undefined;
    if (!w) throw new GameError("No such word.");
    return w;
  }

  addWords(text, by) {
    const parts = String(text ?? "")
      .split(";")
      .map((s) => cleanText(s, MAX_WORD_LEN))
      .filter(Boolean);
    for (const t of parts) {
      if (this.words.length >= MAX_WORDS) break;
      this.words.push({ text: t, locked: false, by });
    }
  }

  start() {
    if (!this.words.length) throw new GameError("Add at least one word first.");
    this.phase = "ingame";
    this.round += 1;
    this.captures = [];
    this.voteIndex = 0;
    this.endsAt = this.now() + this.settings.minutes * 60_000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.phase === "ingame") {
        this.endRound();
        this.onTimeUp?.();
      }
    }, this.settings.minutes * 60_000);
    this.timer.unref?.();
  }

  endRound() {
    clearTimeout(this.timer);
    this.timer = null;
    this.endsAt = null;
    if (!this.captures.length) {
      this.phase = "lobby";
      this.notice = "Time's up! Nobody captured anything, so the round was skipped.";
      return;
    }
    // walk through the captures word by word, earliest find first
    this.captures.sort((a, b) => a.word - b.word || a.time - b.time);
    this.voteIndex = 0;
    this.phase = "voting";
  }

  capture(playerId, { word, pano }) {
    this.wordAt(word);
    if (!pano || typeof pano !== "object") throw new GameError("Missing Street View position.");
    const id = cleanText(pano.id, 300);
    const lat = Number(pano.lat);
    const lng = Number(pano.lng);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      throw new GameError("Invalid Street View position.");
    if (this.settings.onlyOfficial && !OFFICIAL_PANO.test(id))
      throw new GameError("Only official Street View is allowed in this room (no user photospheres).");
    if (this.settings.countryId && !isInCountry(this.settings.countryId, lat, lng)) {
      const c = getCountry(this.settings.countryId);
      throw new GameError(`That spot is not in ${c ? c.name : "the selected country"}.`);
    }
    const clean = {
      id,
      lat,
      lng,
      heading: Number(pano.heading) || 0,
      pitch: Number(pano.pitch) || 0,
      zoom: Number(pano.zoom) || 0,
    };
    const elapsed = Math.max(0, Math.round((this.now() - (this.endsAt - this.settings.minutes * 60_000)) / 1000));
    const existing = this.captures.find((c) => c.playerId === playerId && c.word === Number(word));
    if (existing) {
      existing.pano = clean;
      existing.time = elapsed;
    } else {
      this.captures.push({
        id: this.nextCaptureId++,
        playerId,
        word: Number(word),
        pano: clean,
        time: elapsed,
        keep: new Set(),
        remove: new Set(),
        override: null, // host decision: true = removed, false = kept, null = follow the votes
        extra: false,
      });
    }
  }

  captureById(id) {
    const c = this.captures.find((x) => x.id === Number(id));
    if (!c) throw new GameError("No such capture.");
    return c;
  }

  isRemoved(c) {
    if (c.override !== null) return c.override;
    return c.remove.size > c.keep.size;
  }

  roundPoints() {
    const pts = {};
    for (const c of this.captures) {
      if (this.isRemoved(c)) continue;
      pts[c.playerId] = (pts[c.playerId] || 0) + (c.extra ? 2 : 1);
    }
    return pts;
  }

  // ---------- state sent to a client ----------

  view(forId) {
    const players = [...this.players.values()]
      .sort((a, b) => b.online - a.online || a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, online: p.online, total: this.totals[p.id] || 0 }));
    const base = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      you: forId,
      players,
      settings: { ...this.settings, country: this.settings.countryId ? getCountry(this.settings.countryId) : null },
      words: this.words.map((w) => ({ text: w.text, locked: w.locked })),
      round: this.round,
      notice: this.notice,
    };
    if (this.phase === "lobby") {
      base.suggestions = this.suggestions;
    } else if (this.phase === "ingame") {
      base.endsAt = this.endsAt;
      base.serverNow = this.now();
      // everyone sees who has found what, but only you see your own spots
      base.captures = this.captures.map((c) => ({
        id: c.id,
        word: c.word,
        playerId: c.playerId,
        ...(c.playerId === forId ? { pano: c.pano } : {}),
      }));
    } else {
      const anon = this.phase === "voting" && this.settings.anonVoting;
      base.voteIndex = this.voteIndex;
      base.captures = this.captures.map((c) => ({
        id: c.id,
        word: c.word,
        playerId: anon && c.playerId !== forId ? null : c.playerId,
        mine: c.playerId === forId,
        pano: c.pano,
        time: c.time,
        keep: [...c.keep],
        remove: [...c.remove],
        override: c.override,
        removed: this.isRemoved(c),
        extra: c.extra,
      }));
      if (this.phase === "score") base.roundPoints = this.roundPoints();
    }
    return base;
  }
}

const host = true;
const ACTIONS = {
  // lobby: settings
  settings: {
    host,
    phase: ["lobby"],
    run(_, { settings: s = {} }) {
      const t = this.settings;
      if ("minutes" in s) t.minutes = clampInt(s.minutes, 1, 60, t.minutes);
      for (const k of ["onlyOfficial", "anonVoting", "everyoneVotes"]) if (k in s) t[k] = !!s[k];
      if ("countryId" in s) t.countryId = s.countryId && getCountry(s.countryId) ? String(s.countryId) : null;
    },
  },
  // lobby: words
  setWord: {
    host,
    phase: ["lobby"],
    run(_, { index, text }) {
      const t = cleanText(text, MAX_WORD_LEN);
      if (!t) throw new GameError("A word can't be empty.");
      this.wordAt(index).text = t;
    },
  },
  rerollWord: {
    host,
    phase: ["lobby"],
    run(_, { index }) {
      this.wordAt(index).text = this.randomWord();
    },
  },
  rerollAll: {
    host,
    phase: ["lobby"],
    run() {
      for (const w of this.words) if (!w.locked) w.text = this.randomWord();
    },
  },
  toggleLock: {
    host,
    phase: ["lobby"],
    run(_, { index }) {
      const w = this.wordAt(index);
      w.locked = !w.locked;
    },
  },
  deleteWord: {
    host,
    phase: ["lobby"],
    run(_, { index }) {
      this.wordAt(index);
      this.words.splice(index, 1);
    },
  },
  addRandomWord: {
    host,
    phase: ["lobby"],
    run() {
      if (this.words.length < MAX_WORDS) this.words.push({ text: this.randomWord(), locked: false });
    },
  },
  addWords: {
    host,
    phase: ["lobby"],
    run(_, { text }) {
      this.addWords(text);
    },
  },
  suggest: {
    phase: ["lobby"],
    run(pid, { text }) {
      const name = this.players.get(pid).name;
      for (const t of String(text ?? "").split(";").map((s) => cleanText(s, MAX_WORD_LEN)).filter(Boolean)) {
        if (this.suggestions.length >= 200) break;
        this.suggestions.push({ text: t, by: name });
      }
    },
  },
  acceptSuggestion: {
    host,
    phase: ["lobby"],
    run(_, { index }) {
      const s = this.suggestions[index];
      if (!s) throw new GameError("No such suggestion.");
      this.suggestions.splice(index, 1);
      this.addWords(s.text);
    },
  },
  dismissSuggestion: {
    host,
    phase: ["lobby"],
    run(_, { index }) {
      if (!this.suggestions[index]) throw new GameError("No such suggestion.");
      this.suggestions.splice(index, 1);
    },
  },
  clearSuggestions: {
    host,
    phase: ["lobby"],
    run() {
      this.suggestions = [];
    },
  },
  resetScores: {
    host,
    phase: ["lobby"],
    run() {
      this.totals = {};
      this.round = 0;
    },
  },
  kick: {
    host,
    run(pid, { playerId }) {
      if (playerId === pid || !this.players.has(playerId)) throw new GameError("Can't kick that player.");
      this.kicked.add(playerId);
      this.players.delete(playerId);
      this.captures = this.captures.filter((c) => c.playerId !== playerId);
      this.voteIndex = Math.min(this.voteIndex, Math.max(0, this.captures.length - 1));
      if (this.phase === "voting" && !this.captures.length) this.phase = "lobby";
    },
  },
  makeHost: {
    host,
    run(_, { playerId }) {
      if (!this.players.get(playerId)?.online) throw new GameError("That player is not online.");
      this.hostId = playerId;
    },
  },
  start: {
    host,
    phase: ["lobby"],
    run() {
      this.start();
    },
  },
  // ingame
  capture: {
    phase: ["ingame"],
    run(pid, msg) {
      this.capture(pid, msg);
    },
  },
  uncapture: {
    phase: ["ingame"],
    run(pid, { word }) {
      this.captures = this.captures.filter((c) => !(c.playerId === pid && c.word === Number(word)));
    },
  },
  endRound: {
    host,
    phase: ["ingame"],
    run() {
      this.endRound();
    },
  },
  // voting
  vote: {
    phase: ["voting"],
    run(pid, { captureId, vote }) {
      if (!this.settings.everyoneVotes && pid !== this.hostId)
        throw new GameError("Only the host votes in this room.");
      const c = this.captureById(captureId);
      if (c.playerId === pid) throw new GameError("You can't vote on your own capture.");
      c.keep.delete(pid);
      c.remove.delete(pid);
      if (vote === "keep") c.keep.add(pid);
      else if (vote === "remove") c.remove.add(pid);
    },
  },
  setVoteIndex: {
    host,
    phase: ["voting"],
    run(_, { index }) {
      this.voteIndex = clampInt(index, 0, Math.max(0, this.captures.length - 1), 0);
    },
  },
  setOverride: {
    host,
    phase: ["voting"],
    run(_, { captureId, value }) {
      this.captureById(captureId).override = value === null || value === undefined ? null : !!value;
    },
  },
  toggleExtra: {
    host,
    phase: ["voting"],
    run(_, { captureId }) {
      const c = this.captureById(captureId);
      c.extra = !c.extra;
    },
  },
  toScore: {
    host,
    phase: ["voting"],
    run() {
      this.phase = "score";
    },
  },
  backToVoting: {
    host,
    phase: ["score"],
    run() {
      this.phase = "voting";
    },
  },
  toLobby: {
    host,
    phase: ["voting", "score"],
    run() {
      // leaving the score screen locks the round's points into the totals;
      // skipping straight from voting throws the round away
      if (this.phase === "score") {
        for (const [id, pts] of Object.entries(this.roundPoints()))
          this.totals[id] = (this.totals[id] || 0) + pts;
      }
      this.captures = [];
      this.voteIndex = 0;
      this.phase = "lobby";
    },
  },
};

export { PHASES };
