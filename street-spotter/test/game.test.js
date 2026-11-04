import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, GameError } from "../src/game.js";
import { isInCountry, listCountries } from "../src/countries.js";

const pano = (id = "AbCdEfGhIjKlMnOpQrStUv", lat = 48.8584, lng = 2.2945) => ({ id, lat, lng, heading: 10, pitch: 0, zoom: 1 });

function room() {
  const r = new Room("TEST");
  r.join("host-0001", "Ann");
  r.join("play-0002", "Bob");
  r.join("play-0003", "Cy");
  return r;
}

test("first player is host, host passes on when they leave", () => {
  const r = room();
  assert.equal(r.hostId, "host-0001");
  r.leave("host-0001");
  assert.equal(r.hostId, "play-0002");
  r.join("host-0001");
  assert.equal(r.hostId, "play-0002");
});

test("starts with 5 distinct random words, host-only word editing", () => {
  const r = room();
  assert.equal(r.words.length, 5);
  assert.equal(new Set(r.words.map((w) => w.text)).size, 5);
  assert.throws(() => r.handle("play-0002", { type: "addWords", text: "x" }), GameError);
  r.handle("host-0001", { type: "addWords", text: "red phone box; ; giant duck" });
  assert.deepEqual(r.words.slice(-2).map((w) => w.text), ["red phone box", "giant duck"]);
  r.handle("host-0001", { type: "toggleLock", index: 0 });
  const locked = r.words[0].text;
  r.handle("host-0001", { type: "rerollAll" });
  assert.equal(r.words[0].text, locked);
  assert.throws(() => r.handle("host-0001", { type: "deleteWord", index: 99 }), GameError);
});

test("suggestions flow from players to host", () => {
  const r = room();
  r.handle("play-0002", { type: "suggest", text: "llama;camel" });
  assert.equal(r.suggestions.length, 2);
  r.handle("host-0001", { type: "acceptSuggestion", index: 0 });
  assert.equal(r.words.at(-1).text, "llama");
  assert.equal(r.suggestions.length, 1);
});

test("full round: capture, vote, override, bonus, score", () => {
  const r = room();
  r.handle("host-0001", { type: "start" });
  assert.equal(r.phase, "ingame");
  assert.throws(() => r.handle("play-0002", { type: "start" }), GameError);

  r.handle("host-0001", { type: "capture", word: 0, pano: pano() });
  r.handle("play-0002", { type: "capture", word: 0, pano: pano() });
  r.handle("play-0002", { type: "capture", word: 1, pano: pano() });
  r.handle("play-0002", { type: "capture", word: 1, pano: pano("ZZZZZZZZZZZZZZZZZZZZZZ") }); // recapture replaces
  r.handle("play-0003", { type: "capture", word: 2, pano: pano() });
  r.handle("play-0003", { type: "uncapture", word: 2 });
  assert.equal(r.captures.length, 3);

  // other players can't see your spot during the round
  const v = r.view("play-0003");
  assert.ok(v.captures.every((c) => !c.pano));
  assert.ok(r.view("play-0002").captures.some((c) => c.pano));

  r.handle("host-0001", { type: "endRound" });
  assert.equal(r.phase, "voting");
  assert.deepEqual(r.captures.map((c) => c.word), [0, 0, 1]);

  const [a, b, c] = r.captures;
  assert.throws(() => r.handle("host-0001", { type: "vote", captureId: a.id, vote: "keep" }), /own capture/);
  r.handle("play-0002", { type: "vote", captureId: a.id, vote: "remove" });
  r.handle("play-0003", { type: "vote", captureId: a.id, vote: "remove" });
  assert.equal(r.isRemoved(a), true);
  r.handle("host-0001", { type: "setOverride", captureId: a.id, value: false });
  assert.equal(r.isRemoved(a), false);

  r.handle("host-0001", { type: "vote", captureId: b.id, vote: "remove" });
  r.handle("play-0003", { type: "vote", captureId: b.id, vote: "keep" }); // tie -> kept
  assert.equal(r.isRemoved(b), false);
  r.handle("host-0001", { type: "toggleExtra", captureId: c.id });

  r.handle("host-0001", { type: "toScore" });
  assert.deepEqual(r.view("host-0001").roundPoints, { "host-0001": 1, "play-0002": 3 });
  r.handle("host-0001", { type: "toLobby" });
  assert.equal(r.phase, "lobby");
  assert.deepEqual(r.totals, { "host-0001": 1, "play-0002": 3 });
});

test("anonymous voting hides finders", () => {
  const r = room();
  r.handle("host-0001", { type: "settings", settings: { anonVoting: true, minutes: 999 } });
  assert.equal(r.settings.minutes, 60);
  r.handle("host-0001", { type: "start" });
  r.handle("play-0002", { type: "capture", word: 0, pano: pano() });
  r.handle("host-0001", { type: "endRound" });
  assert.equal(r.view("play-0003").captures[0].playerId, null);
  assert.equal(r.view("play-0002").captures[0].playerId, "play-0002");
});

test("empty round goes back to lobby", () => {
  const r = room();
  r.handle("host-0001", { type: "start" });
  r.handle("host-0001", { type: "endRound" });
  assert.equal(r.phase, "lobby");
  assert.match(r.notice, /Nobody captured/);
  clearTimeout(r.timer);
});

test("official-only and country restriction are enforced", () => {
  const r = room();
  const france = listCountries().find((c) => c.name === "France");
  r.handle("host-0001", { type: "settings", settings: { onlyOfficial: true, countryId: france.id } });
  r.handle("host-0001", { type: "start" });
  assert.throws(() => r.handle("play-0002", { type: "capture", word: 0, pano: pano("CIHM0ogKEICAgICE-user-photosphere") }), /official/);
  assert.throws(() => r.handle("play-0002", { type: "capture", word: 0, pano: pano(undefined, 52.52, 13.405) }), /not in France/);
  r.handle("play-0002", { type: "capture", word: 0, pano: pano() }); // Eiffel tower
  assert.equal(r.captures.length, 1);
  clearTimeout(r.timer);
});

test("country lookup", () => {
  const id = (n) => listCountries().find((c) => c.name === n).id;
  assert.ok(isInCountry(id("Japan"), 35.6762, 139.6503));
  assert.ok(!isInCountry(id("Japan"), 37.5665, 126.978));
  assert.ok(isInCountry(id("Brazil"), -22.9068, -43.1729));
  assert.ok(isInCountry(id("United States of America"), 21.3069, -157.8583)); // Honolulu
});

test("kicked players can't come back", () => {
  const r = room();
  r.handle("host-0001", { type: "kick", playerId: "play-0003" });
  assert.throws(() => r.join("play-0003", "Cy"), /kicked/);
});
