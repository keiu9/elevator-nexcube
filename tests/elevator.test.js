const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Elevator, FLOORS, CONFIG } = require("../elevator.js");
const { AnnouncementQueue, normalizeVoice } = require("../audio.js");

function rig() {
  const events = [];
  let car;
  car = new Elevator((event) => {
    events.push(event);
  });
  const tick = (seconds = 1 / 60) => {
    car.release(car.sequence);
    car.update(seconds);
    assert.ok(car.position >= 1 && car.position <= 201);
    assert.ok(car.speed >= 0 && car.speed <= CONFIG.maxSpeed + 1e-8);
    if (car.speed > 0) assert.equal(car.door, 0, "moving with open doors");
  };
  const until = (condition, limit = 180) => {
    for (let i = 0; i < limit * 60; i++) {
      if (condition()) return;
      tick();
    }
    assert.fail(
      `Timed out: ${car.phase} at ${car.position}, target ${car.target}`,
    );
  };
  const arrivals = () =>
    events.filter((e) => e.type === "arrival").map((e) => e.floor);
  return { car, events, tick, until, arrivals };
}

test("serves floors in direction order, not button press order", () => {
  const r = rig();
  [20, 5, 10].forEach((f) => r.car.request(f));
  r.until(() => r.arrivals().length === 3);
  assert.deepEqual(r.arrivals(), [5, 10, 20]);
});

test("picks up a reachable new intermediate stop and keeps original reservation", () => {
  const r = rig();
  r.car.request(20);
  r.until(() => r.car.position > 2);
  r.car.request(10);
  r.until(() => r.arrivals().length === 2);
  assert.deepEqual(r.arrivals(), [10, 20]);
});

test("does not reverse or teleport for late and passed-floor requests", () => {
  const r = rig();
  r.car.request(20);
  r.until(() => r.car.position > 8 && r.car.position < 9);
  const position = r.car.position;
  r.car.request(9);
  r.car.request(2);
  assert.equal(r.car.target, 20, "insufficient braking distance for floor 9");
  assert.equal(r.car.position, position);
  r.until(() => r.arrivals().length === 3);
  assert.deepEqual(r.arrivals(), [20, 9, 2]);
});

test("collects downward stops before reversing upward", () => {
  const r = rig();
  r.car.request(20);
  r.until(() => r.arrivals().length === 1);
  r.until(() => r.car.phase === "open");
  r.car.request(1);
  r.car.request(10);
  r.car.request(15);
  r.car.request(50);
  r.until(() => r.arrivals().length === 5);
  assert.deepEqual(r.arrivals(), [20, 15, 10, 1, 50]);
});

test("can reopen while closing and hold indefinitely without departure", () => {
  const r = rig();
  r.car.request(5);
  r.until(() => r.car.phase === "closing" && r.car.door < 0.6);
  const aperture = r.car.door;
  r.car.holdOpen(true);
  r.tick();
  assert.equal(r.car.phase, "opening");
  assert.ok(r.car.door >= aperture);
  r.until(() => r.car.phase === "open");
  for (let i = 0; i < 1200; i++) r.tick();
  assert.equal(r.car.position, 1);
  assert.equal(r.car.door, 1);
  r.car.holdOpen(false);
  r.until(() => r.arrivals().length === 1);
  assert.deepEqual(r.arrivals(), [5]);
});

test("open and close controls cannot open a car between floors", () => {
  const r = rig();
  r.car.request(10);
  r.until(() => r.car.speed > 1);
  assert.equal(r.car.openDoor(), false);
  assert.equal(r.car.closeDoor(), false);
  r.car.holdOpen(true);
  assert.equal(r.car.openHeld, false);
  r.until(() => r.arrivals().length === 1);
  assert.equal(r.car.position, 10);
  assert.equal(r.car.door, 0);
});

test("intercom does not cancel requests, stop the motor or fork a journey", () => {
  const r = rig();
  r.car.request(10);
  r.car.request(15);
  r.until(() => r.car.speed > 1);
  const speed = r.car.speed;
  r.car.call();
  assert.equal(r.car.speed, speed);
  assert.equal(r.car.intercom, true);
  r.car.call();
  r.until(() => r.arrivals().length === 2);
  assert.deepEqual(r.arrivals(), [10, 15]);
});

test("canceling the last pending request never produces an unrequested trip", () => {
  const r = rig();
  r.car.request(10);
  r.car.cancel(10);
  for (let i = 0; i < 1200; i++) r.tick();
  assert.equal(r.car.phase, "idle");
  assert.equal(r.car.position, 1);
  r.car.request(5);
  r.until(() => r.car.phase === "running");
  assert.equal(r.car.cancel(5), false);
});

test("floor indicator changes at actual crossings in both directions", () => {
  const r = rig();
  r.car.request(5);
  r.until(() => r.car.position > 1.6);
  assert.equal(r.car.floor, 1);
  r.until(() => r.arrivals().length === 1);
  r.until(() => r.car.phase === "open");
  r.car.request(1);
  r.until(() => r.car.position < 4.4);
  assert.equal(r.car.floor, 5);
});

test("speech completion gates departure and arrival; stale completions cannot close reopened doors", () => {
  const car = new Elevator();
  car.request(5);
  for (let i = 0; i < 300; i++) car.update(0.1);
  assert.equal(car.phase, "preparing");
  assert.equal(car.door, 1);
  const oldToken = car.sequence;
  car.openDoor();
  car.release(oldToken);
  assert.equal(car.ready, false);
  assert.equal(car.phase, "opening");
  car.release(car.sequence);
  car.update(0.1);
  assert.equal(car.phase, "open");
});

test("reset invalidates old callbacks and clears all travel state", () => {
  const r = rig();
  r.car.request(200);
  r.until(() => r.car.position > 4);
  const old = r.car.sequence;
  r.car.reset();
  r.car.release(old);
  assert.equal(r.car.position, 1);
  assert.equal(r.car.speed, 0);
  assert.equal(r.car.pending.size, 0);
  assert.equal(r.car.door, 1);
});

test("serves every selectable floor, including express floors and roof, without stranded requests", () => {
  const r = rig();
  FLOORS.filter((f) => f !== 1)
    .reverse()
    .forEach((f) => r.car.request(f));
  r.until(() => r.arrivals().length === FLOORS.length - 1, 600);
  assert.deepEqual(
    r.arrivals(),
    FLOORS.filter((f) => f !== 1),
  );
  assert.equal(r.car.pending.size, 0);
});

test("acceleration and braking stay bounded without position discontinuities", () => {
  const r = rig();
  r.car.request(50);
  let priorSpeed = 0,
    priorPosition = 1;
  for (let i = 0; i < 6000; i++) {
    r.tick();
    const acceleration = (r.car.speed - priorSpeed) * 60;
    // Final leveling stop (5.5 cm/s floor units) is the only discrete cutoff.
    if (r.car.phase !== "arrival")
      assert.ok(
        acceleration >= -CONFIG.braking - 0.001 &&
          acceleration <= CONFIG.acceleration + 0.001,
      );
    assert.ok(
      Math.abs(r.car.position - priorPosition) <= CONFIG.maxSpeed / 60 + 0.0001,
    );
    priorSpeed = r.car.speed;
    priorPosition = r.car.position;
    if (r.arrivals().length) break;
  }
  assert.deepEqual(r.arrivals(), [50]);
});

test("queue plays all arrival clips to completion in sequence, including failures", async () => {
  const log = [];
  const q = new AnnouncementQueue(async (item) => {
    log.push(`start:${item}`);
    await Promise.resolve();
    log.push(`end:${item}`);
    if (item === "bad") throw Error();
  });
  await Promise.all([
    q.enqueue(["chime", "floor-20", "open"]),
    q.enqueue(["bad", "up", "close"]),
  ]);
  assert.deepEqual(log, [
    "start:chime",
    "end:chime",
    "start:floor-20",
    "end:floor-20",
    "start:open",
    "end:open",
    "start:bad",
    "end:bad",
    "start:up",
    "end:up",
    "start:close",
    "end:close",
  ]);
});

test("cancel/reset discards stale clips and allows a fresh announcement", async () => {
  let release;
  const log = [];
  const q = new AnnouncementQueue(async (item) => {
    log.push(item);
    if (item === "old") await new Promise((r) => (release = r));
  });
  q.stop = () => release?.();
  const old = q.enqueue(["old", "must-not-play"]);
  const waiting = q.enqueue(["also-must-not-play"]);
  q.cancel();
  const fresh = q.enqueue(["fresh"]);
  assert.equal(await old, false);
  assert.equal(await waiting, false);
  assert.equal(await fresh, true);
  assert.deepEqual(log, ["old", "fresh"]);
});

test("quiet floor recordings gain audibility and loud clips cannot clip", () => {
  const fake = (value) => ({
    numberOfChannels: 1,
    length: 4,
    samples: new Float32Array([value, -value, value, -value]),
    getChannelData() {
      return this.samples;
    },
  });
  const quiet = fake(0.025);
  normalizeVoice(quiet);
  assert.ok(Math.abs(quiet.samples[0] - 0.1) < 1e-6);
  const loud = fake(0.99);
  normalizeVoice(loud);
  assert.ok(loud.samples.every((x) => Math.abs(x) <= 0.85));
  const silent = fake(0);
  normalizeVoice(silent);
  assert.ok(silent.samples.every((x) => x === 0));
});

test("a request arriving during empty automatic closing still announces direction before moving", () => {
  const r = rig();
  r.until(() => r.car.phase === "closing" && r.car.door < 0.7);
  r.car.request(5);
  r.until(() => r.car.phase === "running");
  const departures = r.events.filter((e) => e.type === "departure");
  assert.equal(departures[0].direction, 0);
  assert.equal(departures[1].direction, 1);
  assert.equal(departures[1].close, false);
});
