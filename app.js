const MAX_FLOOR = 201;
const MIN_FLOOR = 1;
const FLOOR_HEIGHT_PCT = 100 / (MAX_FLOOR - MIN_FLOOR);
const ARRIVAL_CHIME_SRC = "assets/chime/mitsubishi-arrival.m4a";

const SELECTABLE_FLOORS = [
  { value: 201, label: "R" },
  { value: 200, label: "200" },
  { value: 150, label: "150" },
  { value: 100, label: "100" },
  { value:  50, label: "50" },
  ...Array.from({ length: 20 }, (_, i) => ({ value: 20 - i, label: String(20 - i) }))
];

const VOICE_FILES = {
  destination: "assets/voice/destination.m4a",
  up:          "assets/voice/up.m4a",
  down:        "assets/voice/down.m4a",
  doorClosing: "assets/voice/door-closing.m4a",
  doorOpening: "assets/voice/door-opening.m4a",
  emergency:   "assets/voice/emergency.m4a",
  ...Object.fromEntries(
    SELECTABLE_FLOORS.map(f => [
      `floor-${f.value}`,
      `assets/voice/floor-${f.value === 201 ? "r" : f.value}.m4a`
    ])
  )
};

const state = {
  currentFloor: 1,
  visualFloor:  1,
  queue:        [],
  moving:       false,
  direction:    0,
  doors:        "open",
  emergency:    false,
  audioReady:   false,
  audio:        null,
  voice:        null,
  announcementAudio: null,
  chimeAudio:   null,
  motor:        null,
  motorGain:    null,
  departureTimer: null,
};

const els = {
  floorGrid:    document.getElementById("floorGrid"),
  floorScale:   document.getElementById("floorScale"),
  car:          document.getElementById("car"),
  currentFloor: document.getElementById("currentFloor"),
  targetFloor:  document.getElementById("targetFloor"),
  speedLabel:   document.getElementById("speedLabel"),
  doorLabel:    document.getElementById("doorLabel"),
  arrowUp:      document.getElementById("arrowUp"),
  arrowDown:    document.getElementById("arrowDown"),
  floorDisplay: document.getElementById("floorDisplay"),
  queueLabel:   document.getElementById("queueLabel"),
};

function floorLabel(floor) { return floor === 201 ? "R" : String(floor); }
function spokenFloor(floor) { return floor === 201 ? "屋上階" : `${floor}階`; }

function init() {
  buildFloorButtons();
  buildScale();
  wireControls();
  loadVoices();
  render();
}

function buildFloorButtons() {
  const frag = document.createDocumentFragment();
  SELECTABLE_FLOORS.forEach(f => {
    const btn = document.createElement("button");
    btn.className = "floor-btn";
    btn.type = "button";
    btn.dataset.floor = String(f.value);
    btn.setAttribute("aria-label", f.value === 201 ? "屋上階" : `${f.value}階`);
    const label = document.createElement("span");
    label.className = "btn-label";
    label.textContent = f.label;
    btn.appendChild(label);
    frag.appendChild(btn);
  });
  els.floorGrid.appendChild(frag);
}

function buildScale() {
  const frag = document.createDocumentFragment();
  [201, 200, 150, 100, 50, 20, 10, 5, 1].forEach(floor => {
    const el = document.createElement("div");
    el.className = "floor-mark";
    el.textContent = floor === 201 ? "RF" : `${floor}F`;
    el.style.top = `${100 - (floor - 1) * FLOOR_HEIGHT_PCT}%`;
    frag.appendChild(el);
  });
  els.floorScale.appendChild(frag);
}

function wireControls() {
  els.floorGrid.addEventListener("click", e => {
    const btn = e.target.closest("[data-floor]");
    if (btn) requestFloor(Number(btn.dataset.floor));
  });
  document.querySelectorAll("[data-service]").forEach(btn => {
    btn.addEventListener("click", () => {
      ensureAudio();
      const action = btn.dataset.service;
      if (action === "open")   openDoors(true);
      if (action === "close")  closeDoors(true);
      if (action === "bell")   emergencyCall();
      if (action === "cancel") cancelQueue();
    });
  });
}

function requestFloor(floor) {
  ensureAudio();
  if (state.emergency) return;
  if (floor === state.currentFloor || state.queue.includes(floor)) return;
  const wasIdle = !state.moving && state.queue.length === 0;
  state.queue.push(floor);
  sortQueue();
  clickTone(880, 0.022, "sine", 0.038);
  render();
  if (wasIdle) {
    // Announce direction while doors still open, then close after voice finishes
    const dir = Math.sign(floor - state.currentFloor);
    if (dir !== 0) announce(dir > 0 ? "上にまいります" : "下にまいります", dir > 0 ? "up" : "down");
    clearTimeout(state.departureTimer);
    state.departureTimer = setTimeout(() => {
      if (!state.moving) closeDoors(true).then(processQueue);
    }, 1600);
  } else if (!state.moving && !state.departureTimer) {
    closeDoors(true).then(processQueue);
  }
}

function sortQueue() {
  if (!state.moving) return;
  state.queue.sort((a, b) => state.direction > 0 ? a - b : b - a);
}

async function processQueue() {
  if (state.moving || state.emergency) return;
  const target = state.queue[0];
  if (!target) { render(); return; }
  await travelTo(target);
  state.queue.shift();
  await openDoors(true);
  state.departureTimer = null;
  setTimeout(() => {
    if (state.queue.length && !state.emergency) {
      const dir = Math.sign(state.queue[0] - state.currentFloor);
      if (dir !== 0) announce(dir > 0 ? "上にまいります" : "下にまいります", dir > 0 ? "up" : "down");
      state.departureTimer = setTimeout(() => {
        state.departureTimer = null;
        if (!state.moving) closeDoors(true).then(processQueue);
      }, 1400);
    }
  }, 1550);
}

function travelTo(target) {
  return new Promise(resolve => {
    const start = state.currentFloor;
    const dist  = Math.abs(target - start);
    // 20階以上は高速運転モード（約2.5倍速）
    const baseDuration = Math.max(6000, dist * 1600 + 3500);
    const duration = dist >= 20 ? Math.round(baseDuration / 2.5) : baseDuration;
    const startedAt = performance.now();

    state.moving    = true;
    state.direction = Math.sign(target - start);
    state.doors     = "closed";
    state.departureTimer = null;

    startMotor(dist);
    render();

    const tick = now => {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = easeInOutCubic(progress);
      state.visualFloor  = start + (target - start) * eased;
      state.currentFloor = Math.round(state.visualFloor);
      updateMotorPitch(progress, dist);
      render();
      if (progress < 1) { requestAnimationFrame(tick); return; }
      state.currentFloor = target;
      state.visualFloor  = target;
      state.moving       = false;
      state.direction    = 0;
      stopMotor();
      render();
      arrivalChime();
      // チャイムの後に階数アナウンス（実機と同順序）
      setTimeout(() => announce(`${spokenFloor(target)}です`, `floor-${target}`), 950);
      // 最長音声(~1.5s)が終わってからドアを開く: 950 + 1500 + 余裕750 = 3200ms
      setTimeout(resolve, 3200);
    };
    requestAnimationFrame(tick);
  });
}

function closeDoors(withSound) {
  return new Promise(resolve => {
    if (state.doors === "closed") { resolve(); return; }
    state.doors = "closing";
    if (withSound) {
      if (Math.random() < 0.01) doorSafetyWarning();
      if (Math.random() < 0.3) doorTone(false);
      announce("ドアが閉まります", "doorClosing");
    }
    render();
    setTimeout(() => { state.doors = "closed"; render(); resolve(); }, 850);
  });
}

function openDoors(withSound) {
  return new Promise(resolve => {
    state.doors = "opening";
    if (withSound) {
      if (Math.random() < 0.3) doorTone(true);
      announce("ドアが開きます", "doorOpening");
    }
    render();
    setTimeout(() => {
      state.doors = "open";
      render();
      setTimeout(() => {
        if (!state.queue.length && !state.moving && !state.emergency)
          announce("行き先ボタンを押してください", "destination");
      }, 1200);
      resolve();
    }, 880);
  });
}

function emergencyCall() {
  state.emergency = !state.emergency;
  if (state.emergency) {
    state.queue = [];
    stopMotor();
    state.moving = false;
    alarmTone();
    announce("非常ボタンが押されました。係員におつなぎしています", "emergency");
    document.querySelector(".emg-btn").classList.add("active");
  } else {
    clickTone(520, 0.12, "sine", 0.06);
    document.querySelector(".emg-btn").classList.remove("active");
  }
  render();
}

function cancelQueue() {
  state.queue = [];
  clickTone(260, 0.08, "triangle", 0.05);
  render();
}

function render() {
  const floor = Math.max(MIN_FLOOR, Math.min(MAX_FLOOR, state.visualFloor));
  const carBottom = (floor - MIN_FLOOR) * FLOOR_HEIGHT_PCT;
  els.car.style.bottom = `${carBottom}%`;
  els.car.classList.toggle("open",   state.doors === "open" || state.doors === "opening");
  els.car.classList.toggle("moving", state.moving);

  els.currentFloor.textContent = floorLabel(state.currentFloor);
  els.targetFloor.textContent  = state.queue[0] ? floorLabel(state.queue[0]) : "---";
  els.speedLabel.textContent   = state.moving ? "運転中" : "停止";
  const doorTexts = { open: "開", closed: "閉", opening: "開動作", closing: "閉動作" };
  els.doorLabel.textContent = doorTexts[state.doors] ?? "---";

  els.arrowUp.classList.toggle("active",   state.direction > 0);
  els.arrowDown.classList.toggle("active", state.direction < 0);

  els.floorDisplay.textContent = floorLabel(state.currentFloor);

  els.queueLabel.textContent = state.queue.length
    ? state.queue.map(floorLabel).join(" → ")
    : "なし";

  document.querySelectorAll(".floor-btn").forEach(btn => {
    const n = Number(btn.dataset.floor);
    const isSelected = state.queue.includes(n);
    const isCurrent  = n === state.currentFloor;
    btn.classList.toggle("lit",     isSelected);
    btn.classList.toggle("current", isCurrent && !isSelected);
  });
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
}

function ensureAudio() {
  if (state.audioReady) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  state.audio = new Ctx();
  state.audioReady = true;
  loadVoices();
}

function doorTone(opening) {
  // ドア開閉警告音（ピッピッピッピッ×6回）
  const freq = opening ? 2600 : 2200;
  for (let i = 0; i < 6; i++) {
    setTimeout(() => clickTone(freq, 0.065, "square", 0.055), i * 130);
  }
}

function clickTone(freq, dur, type, vol) {
  if (!state.audio) return;
  const now = state.audio.currentTime;
  const osc  = state.audio.createOscillator();
  const gain = state.audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(vol,    now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(state.audio.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

function arrivalChime() {
  // 到着チャイムは合成音（ding-dong）
  fallbackChime();
}

function fallbackChime() {
  clickTone(880, 0.16, "sine", 0.06);
  setTimeout(() => clickTone(659, 0.22, "sine", 0.052), 155);
}

function doorSafetyWarning() {
  // ドア安全センサー警告音（1%で発動）
  if (!("Audio" in window)) return;
  const a = new Audio(ARRIVAL_CHIME_SRC);
  a.volume = 0.85;
  a.play().catch(() => {});
}

function alarmTone() {
  // エレベーター非常ベル：断続的な高音（実機に近い連続ベルパターン）
  for (let i = 0; i < 8; i++) {
    setTimeout(() => clickTone(1320, 0.09, "square", 0.07), i * 220);
  }
}

function startMotor(dist) {
  if (!state.audio) return;
  stopMotor();
  const now  = state.audio.currentTime;
  const osc  = state.audio.createOscillator();
  const gain = state.audio.createGain();
  const filt = state.audio.createBiquadFilter();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(48, now);
  filt.type = "lowpass";
  filt.frequency.setValueAtTime(220, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.min(0.055, 0.018 + dist / 4000), now + 0.45);
  osc.connect(filt).connect(gain).connect(state.audio.destination);
  osc.start(now);
  state.motor     = osc;
  state.motorGain = gain;
}

function updateMotorPitch(progress, dist) {
  if (!state.motor || !state.audio) return;
  const now   = state.audio.currentTime;
  const speed = Math.sin(progress * Math.PI);
  const freq  = 42 + speed * (82 + Math.min(dist, 120) * 0.34) * 1.42;
  state.motor.frequency.setTargetAtTime(freq, now, 0.06);
}

function stopMotor() {
  if (!state.motor || !state.audio) return;
  const now = state.audio.currentTime;
  state.motorGain.gain.cancelScheduledValues(now);
  state.motorGain.gain.setTargetAtTime(0.0001, now, 0.16);
  state.motor.stop(now + 0.5);
  state.motor     = null;
  state.motorGain = null;
}

function announce(text, key) {
  const src = VOICE_FILES[key];
  if (src && "Audio" in window) {
    if (state.announcementAudio) { state.announcementAudio.pause(); state.announcementAudio.currentTime = 0; }
    const a = new Audio(src);
    a.volume = 0.92;
    state.announcementAudio = a;
    a.play().catch(() => speakWithSynth(text));
    return;
  }
  speakWithSynth(text);
}

function speakWithSynth(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  if (state.voice) u.voice = state.voice;
  u.rate = 0.86; u.pitch = 1.08; u.volume = 0.86;
  window.speechSynthesis.speak(u);
}

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) { window.speechSynthesis.onvoiceschanged = loadVoices; return; }
  const ja = voices.filter(v => /^ja(-|_)?JP/i.test(v.lang) || /Japanese|Kyoko|Nanami|Haruka|Sayaka/i.test(v.name));
  const hints = ["Kyoko","Nanami","Haruka","Sayaka","Google 日本語","Japanese Japan"];
  state.voice =
    hints.map(h => ja.find(v => v.name.includes(h))).find(Boolean) ||
    ja.find(v => !/Otoya|Ichiro|Male|男/i.test(v.name)) ||
    ja[0] || voices[0];
}

init();
