"use strict";
const { Elevator } = window.ElevatorModel;
const $ = (id) => document.getElementById(id);
const floorLabel = (floor) => (floor === 201 ? "R" : String(floor));
const spokenFloor = (floor) => (floor === 201 ? "屋上階" : `${floor}階`);
const clip = (key, text) => ({ src: `assets/voice/${key}.m4a`, text });
const audio = new window.ElevatorAudio((text) => {
  $("announcement").textContent = text;
});
let engine;
function onEvent(event) {
  if (event.type === "reset") {
    audio.cancel();
    $("announcement").textContent = "行先階のボタンを押してください";
    return;
  }
  let items = [];
  if (event.type === "departure") {
    audio.queue.cancel();
    if (event.direction)
      items.push(
        clip(
          event.direction > 0 ? "up" : "down",
          event.direction > 0 ? "上にまいります" : "下にまいります",
        ),
      );
    if (event.close) items.push(clip("door-closing", "ドアが閉まります"));
  }
  if (event.type === "arrival") {
    audio.stopMotor();
    items = [
      { src: "assets/chime/arrival.m4a", text: "♪ 到着チャイム", chime: true },
      clip(
        `floor-${event.floor === 201 ? "r" : event.floor}`,
        `${spokenFloor(event.floor)}です`,
      ),
    ];
  }
  if (event.type === "opening") {
    audio.queue.cancel();
    items = [clip("door-opening", "ドアが開きます")];
  }
  if (event.type === "intercom") {
    $("callButton").setAttribute("aria-pressed", String(event.active));
    if (event.active)
      audio.say([
        clip("emergency", "非常呼出の体験中です（外部への通報はありません）"),
      ]);
    else $("announcement").textContent = "非常呼出の体験を終了しました";
    return;
  }
  if (items.length || event.type === "departure")
    audio.say(items).then(() => {
      if (event.token === engine.sequence) {
        engine.release(event.token);
        $("announcement").textContent =
          event.type === "arrival"
            ? `${spokenFloor(event.floor)}に到着しました`
            : "行先階のボタンを押してください";
      }
    });
}
engine = new Elevator(onEvent);

// One fixed floor order in every orientation; touch targets scale with the viewport.
const rows = [
  [50, 100, 150, 200, 201],
  [16, 17, 18, 19, 20],
  [11, 12, 13, 14, 15],
  [6, 7, 8, 9, 10],
  [1, 2, 3, 4, 5],
];
const buttons = new Map();
let lastPress = { floor: null, time: -Infinity };
for (const row of rows)
  for (const floor of row) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `floor-btn${floor >= 50 ? " express" : ""}${floor === 1 ? " main-floor" : ""}`;
    button.dataset.floor = floor;
    button.setAttribute("aria-label", spokenFloor(floor));
    button.setAttribute("aria-pressed", "false");
    const label = document.createElement("span");
    label.className = "btn-label";
    label.textContent = floorLabel(floor);
    button.appendChild(label);
    button.addEventListener("click", () => {
      audio.unlock();
      const now = performance.now();
      if (
        lastPress.floor === floor &&
        now - lastPress.time < 450 &&
        engine.pending.has(floor)
      ) {
        if (engine.cancel(floor)) {
          audio.tone(440);
          $("announcement").textContent =
            `${spokenFloor(floor)}の予約を取り消しました`;
        } else {
          $("announcement").textContent = "この階への停車は確定しています";
        }
        lastPress = { floor: null, time: -Infinity };
      } else {
        if (engine.request(floor)) audio.tone();
        lastPress = { floor, time: now };
      }
      render();
    });
    buttons.set(floor, button);
    $("floorGrid").appendChild(button);
  }

$("openButton").addEventListener("pointerdown", (event) => {
  audio.unlock();
  $("openButton").setPointerCapture(event.pointerId);
  engine.holdOpen(true);
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
  $("openButton").addEventListener(name, () => engine.holdOpen(false));
$("openButton").addEventListener("click", () => {
  audio.unlock();
  engine.openDoor();
  render();
});
$("openButton").addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    audio.unlock();
    engine.holdOpen(true);
  }
});
$("openButton").addEventListener("keyup", () => engine.holdOpen(false));
$("openButton").addEventListener("blur", () => engine.holdOpen(false));
$("closeButton").addEventListener("click", () => {
  audio.unlock();
  engine.closeDoor();
  render();
});
$("callButton").addEventListener("click", () => {
  audio.unlock();
  engine.call();
  render();
});
$("soundButton").addEventListener("click", () => {
  audio.unlock();
  audio.setEnabled(!audio.enabled);
  $("soundButton").textContent = `音声 ${audio.enabled ? "ON" : "OFF"}`;
  $("soundButton").setAttribute("aria-pressed", String(audio.enabled));
});
$("resetButton").addEventListener("click", () => {
  audio.unlock();
  engine.reset();
  lastPress = { floor: null, time: -Infinity };
  $("callButton").setAttribute("aria-pressed", "false");
  render();
});
document.addEventListener("visibilitychange", () => {
  engine.holdOpen(false);
  if (document.hidden) audio.stopMotor();
  lastFrame = performance.now();
});

// Seven-segment geometry for the panel floor indicator.
const segments = {
  a: "8,2 32,2 36,6 31,10 9,10 4,6",
  b: "33,12 38,8 38,31 34,35 30,31 30,16",
  c: "34,39 38,43 38,66 33,62 30,58 30,43",
  d: "9,64 31,64 36,68 32,72 8,72 4,68",
  e: "2,43 6,39 10,43 10,58 7,62 2,66",
  f: "2,8 7,12 10,16 10,31 6,35 2,31",
  g: "8,33 32,33 36,37 32,41 8,41 4,37",
  h: "20,42 28,42 38,68 32,72",
};
const digits = {
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "acdefg",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
  R: "efgabh",
};
let previousFloor = null;
function renderDigits(floor) {
  if (floor === previousFloor) return;
  previousFloor = floor;
  for (const display of document.querySelectorAll("[data-display]")) {
    display.replaceChildren();
    display.setAttribute("aria-label", `現在階 ${spokenFloor(floor)}`);
    for (const char of floorLabel(floor)) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 40 74");
      svg.setAttribute("aria-hidden", "true");
      for (const [name, points] of Object.entries(segments)) {
        if (name === "h" && char !== "R") continue;
        const path = document.createElementNS(svg.namespaceURI, "polygon");
        path.setAttribute("points", points);
        path.setAttribute(
          "class",
          `segment${digits[char].includes(name) ? " on" : ""}`,
        );
        svg.appendChild(path);
      }
      display.appendChild(svg);
    }
  }
}
const phaseNames = {
  idle: "待機中",
  open: "ドアが開いています",
  preparing: "出発します",
  closing: "ドアが閉まります",
  running: "運転中",
  arrival: "到着しました",
  opening: "ドアが開きます",
};
function render() {
  renderDigits(engine.floor);
  const displayDirection = engine.phase === "idle" ? 0 : engine.direction;
  for (const arrow of document.querySelectorAll("[data-direction]")) {
    arrow.classList.toggle("active", displayDirection !== 0);
    arrow.classList.toggle("down", displayDirection < 0);
    arrow.setAttribute(
      "aria-label",
      displayDirection > 0 ? "上り" : displayDirection < 0 ? "下り" : "停止",
    );
  }
  for (const [floor, button] of buttons) {
    const selected = engine.pending.has(floor);
    button.classList.toggle("lit", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  const running = ["running", "arrival"].includes(engine.phase);
  $("openButton").disabled = running;
  $("closeButton").disabled = engine.phase !== "open";
  $("screenMessage").textContent = engine.intercom
    ? "非常呼出中（体験）"
    : phaseNames[engine.phase];
  audio.motor(engine.speed);
}
let lastFrame = performance.now();
function frame(now) {
  if (!document.hidden) engine.update((now - lastFrame) / 1000);
  lastFrame = now;
  render();
  requestAnimationFrame(frame);
}
render();
requestAnimationFrame(frame);
