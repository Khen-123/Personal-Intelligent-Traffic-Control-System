/**
 * Intelligent Traffic Control Dashboard — script.js
 * ─────────────────────────────────────────────────
 * Key additions over v1:
 *   • Unified mode: "AUTO" | "MANUAL" with previousMode tracking
 *   • Single timerDuration (seconds) slider drives every auto phase
 *   • Cancellation-token pattern — no stale async chain can mutate state
 *   • Auto pedestrian: auto-deactivates and resumes traffic loop
 *   • Manual mode: timers = null; fully user-driven; no auto-loops
 *   • Stuck-state / freeze recovery at every await point
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const trafficSystem = {
  intersections: {
    NS: { state: "GREEN" },
    EW: { state: "RED"   }
  },
  pedestrian: {
    enabled: false,
    state: "DISABLED",        // DISABLED | WALK | RUN | STOP
    isDeactivating: false
  },
  activeDirection: "NS",      // direction currently holding GREEN

  mode: "MANUAL",             // "AUTO" | "MANUAL"
  previousMode: "MANUAL",

  timerDuration: 10,          // seconds — source of truth for AUTO phase lengths

  isTransitioning: false,
  queuedSwitch: false,

  // Cancellation token: each new async chain captures it; aborts if it drifts.
  _token: 0
};

// ═══════════════════════════════════════════════════════════════════════════════
// UI CACHE
// ═══════════════════════════════════════════════════════════════════════════════

const UI = {
  switchBtn: null,
  togglePedBtn: null,
  pedModeStatus: null,
  clearLogsBtn: null,
  autoModeBtn: null,
  modeBadge: null,
  timerDurationInput: null,
  timerDurationValue: null,
  nsText: null, ewText: null, pedStateText: null,
  logList: null,
  nsRoad: null, ewRoad: null, pedestrianLane: null,
  nsTimer: null, ewTimer: null, pedTimer: null,
  vehicles: [], pedestrians: [],
  nsLights: {}, ewLights: {}, pedLights: {},
  pedLightBox: null
};

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATION ENGINE STATE
// ═══════════════════════════════════════════════════════════════════════════════

let animationFrameId = null;
let previousFrameTime = 0;

const vehicleMotion = {
  NS:  { speed: 0, targetSpeed: 120 },
  EW:  { speed: 0, targetSpeed: 0   },
  PED: { speed: 0, targetSpeed: 0   }
};

// ═══════════════════════════════════════════════════════════════════════════════
// VISUAL TIMER STATE
// ═══════════════════════════════════════════════════════════════════════════════

const timerState = {
  NS:  { remaining: null, intervalId: null },
  EW:  { remaining: null, intervalId: null },
  PED: { remaining: null, intervalId: null }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function addLog(msg) {
  const li = document.createElement("li");
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  UI.logList.prepend(li);
  if (UI.logList.children.length > 40) UI.logList.removeChild(UI.logList.lastElementChild);
}

/** Mint a new cancellation token, invalidating all older async chains. */
function mintToken() {
  trafficSystem._token = (trafficSystem._token + 1) % 1_000_000;
  return trafficSystem._token;
}

/**
 * Waits `ms` ms. Returns true if the token is still valid after the wait,
 * false if a newer chain has taken over (abort signal).
 */
function delayOrAbort(ms, token) {
  return new Promise((resolve) => {
    const tid = setTimeout(() => {
      clearInterval(pid);
      resolve(trafficSystem._token === token);
    }, ms);
    // Fast-cancel poll every 80 ms to avoid leaving long timeouts alive
    const pid = setInterval(() => {
      if (trafficSystem._token !== token) {
        clearTimeout(tid);
        clearInterval(pid);
        resolve(false);
      }
    }, 80);
  });
}

function fmt(n) { return n < 10 ? `0${n}` : String(n); }

// ─── Timing config ────────────────────────────────────────────────────────────

/**
 * Returns phase durations (ms) for the current mode.
 * MANUAL → all null (no automatic countdowns ever).
 * AUTO   → derived from trafficSystem.timerDuration.
 */
function getTimings() {
  if (trafficSystem.mode === "AUTO") {
    const base   = Math.max(2, trafficSystem.timerDuration) * 1000;
    const yellow = Math.max(1000, Math.min(3000, Math.round(base * 0.3)));
    return { GREEN: base, YELLOW: yellow, RED_BUFFER: 1000 };
  }
  return { GREEN: null, YELLOW: null, RED_BUFFER: null };
}

// ─── Visual countdown timers ──────────────────────────────────────────────────

function timerEl(dir) {
  if (dir === "NS")  return UI.nsTimer;
  if (dir === "EW")  return UI.ewTimer;
  if (dir === "PED") return UI.pedTimer;
  return null;
}

function stopTimer(dir) {
  const t = timerState[dir];
  if (t.intervalId) { clearInterval(t.intervalId); t.intervalId = null; }
}

function resetTimerDisplay(dir) {
  stopTimer(dir);
  const el = timerEl(dir);
  if (el) { el.textContent = "--"; el.setAttribute("data-state", "DISABLED"); }
}

function startTimer(dir, durationMs, lightState) {
  stopTimer(dir);
  const el = timerEl(dir);
  if (!el) return;

  // In MANUAL mode or when duration is null → show static label only
  if (durationMs == null || trafficSystem.mode === "MANUAL") {
    el.textContent = "--";
    el.setAttribute("data-state", lightState || "DISABLED");
    return;
  }

  let remaining = Math.ceil(durationMs / 1000);
  timerState[dir].remaining = remaining;
  el.setAttribute("data-state", lightState);
  el.textContent = fmt(remaining);

  timerState[dir].intervalId = setInterval(() => {
    remaining -= 1;
    timerState[dir].remaining = remaining;
    el.textContent = remaining > 0 ? fmt(remaining) : "00";
    if (remaining <= 0) stopTimer(dir);
  }, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI RENDER
// ═══════════════════════════════════════════════════════════════════════════════

function updateUI() {
  const isAuto    = trafficSystem.mode === "AUTO";
  const ped       = trafficSystem.pedestrian;
  const pedActive = ped.enabled || ped.isDeactivating;

  const ns       = pedActive ? "RED" : trafficSystem.intersections.NS.state;
  const ew       = pedActive ? "RED" : trafficSystem.intersections.EW.state;
  const pedState = derivePedState();

  // Lights
  ["red","yellow","green"].forEach((c) => {
    UI.nsLights[c].classList.toggle("active", ns.toLowerCase() === c);
    UI.ewLights[c].classList.toggle("active", ew.toLowerCase() === c);
  });
  UI.nsText.textContent  = ns;
  UI.ewText.textContent  = ew;
  UI.pedStateText.textContent = pedState;

  // Roads
  UI.nsRoad.setAttribute("data-signal", ns);
  UI.ewRoad.setAttribute("data-signal", ew);
  UI.pedestrianLane.setAttribute("data-state", pedState);

  // Ped signal
  UI.pedLights.stop.classList.toggle("active", pedState === "STOP" || pedState === "DISABLED");
  UI.pedLights.walk.classList.toggle("active", pedState === "WALK" || pedState === "RUN");
  UI.pedLightBox.setAttribute("data-state", pedState);

  // Vehicle speeds
  vehicleMotion.NS.targetSpeed  = speedFor(ns);
  vehicleMotion.EW.targetSpeed  = speedFor(ew);
  vehicleMotion.PED.targetSpeed = pedSpeedFor(pedState);

  // Buttons
  UI.switchBtn.disabled  = isAuto || trafficSystem.isTransitioning || pedActive;
  UI.togglePedBtn.disabled = trafficSystem.isTransitioning || ped.isDeactivating;
  UI.togglePedBtn.textContent = ped.enabled ? "Pedestrian System: ON" : "Pedestrian System: OFF";
  UI.togglePedBtn.setAttribute("aria-pressed", String(ped.enabled));
  UI.pedModeStatus.textContent = ped.enabled ? "Pedestrian Mode: ON" : "Pedestrian Mode: OFF";
  UI.pedModeStatus.classList.toggle("on", ped.enabled);

  // Auto badge
  UI.modeBadge.textContent = isAuto ? "AUTO MODE" : "MANUAL MODE";
  UI.modeBadge.classList.toggle("auto", isAuto);
  UI.autoModeBtn.textContent = isAuto ? "Disable Auto Mode" : "Enable Auto Mode";
  UI.autoModeBtn.classList.toggle("active", isAuto);
  document.body.classList.toggle("auto-mode", isAuto);

  // Timer duration input — editable any time (takes effect next cycle)
  UI.timerDurationInput.disabled = false;
  UI.timerDurationValue.textContent = `${trafficSystem.timerDuration}s`;
}

// ─── Derived state helpers ────────────────────────────────────────────────────

function derivePedState() {
  const ped = trafficSystem.pedestrian;
  if (ped.isDeactivating) return ped.state;
  if (ped.enabled)        return "WALK";
  return "DISABLED";
}

function speedFor(s)    { return s === "GREEN" ? 120 : s === "YELLOW" ? 38 : 0; }
function pedSpeedFor(s) { return s === "WALK" ? 42 : s === "RUN" ? 86 : 0; }
function pedRampRate(s) { return s === "WALK" ? 70 : s === "RUN" ? 85 : 55; }

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function easeDir(dir, dt) {
  const m    = vehicleMotion[dir];
  const diff = m.targetSpeed - m.speed;
  if (Math.abs(diff) < 0.5) { m.speed = m.targetSpeed; return; }
  let rate = diff > 0 ? 130 : 80;
  if (dir === "PED") rate = pedRampRate(trafficSystem.pedestrian.state);
  m.speed += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
}

function moveVehicle(v, dt) {
  const dir   = v.dataset.direction;
  const speed = vehicleMotion[dir].speed;
  const road  = v.closest(".road");
  const isNS  = road.classList.contains("road-ns");
  const fwd   = v.dataset.flow !== "reverse";
  const signed = speed * (fwd ? 1 : -1);
  const track  = isNS ? road.clientHeight : road.clientWidth;
  const body   = isNS ? v.offsetHeight : v.offsetWidth;
  const loop   = track + body;
  let pos = v.motionPosition + signed * dt;
  if (pos > loop) pos -= loop;
  if (pos < 0)    pos += loop;
  v.motionPosition = pos;
  const off = pos - body;
  const rot = fwd ? "rotate(0deg)" : "rotate(180deg)";
  if (isNS) {
    v.style.top = `${off}px`; v.style.left = v.dataset.lane === "a" ? "24%" : "64%";
    v.style.transform = `translate(-50%, 0) ${rot}`;
  } else {
    v.style.left = `${off}px`; v.style.top = v.dataset.lane === "a" ? "30%" : "72%";
    v.style.transform = `translate(0, -50%) ${rot}`;
  }
}

function movePedestrian(fig, dt) {
  const fwd    = fig.dataset.flow !== "reverse";
  const signed = vehicleMotion.PED.speed * (fwd ? 1 : -1);
  const track  = UI.pedestrianLane.clientWidth;
  const body   = fig.offsetWidth;
  const loop   = track + body;
  let pos = fig.motionPosition + signed * dt;
  if (pos > loop) pos -= loop;
  if (pos < 0)    pos += loop;
  fig.motionPosition = pos;
  fig.style.left = `${pos - body}px`;
  fig.style.transform = `translateY(-50%) ${fwd ? "scaleX(1)" : "scaleX(-1)"}`;
}

function animateLoop(ts) {
  if (!previousFrameTime) previousFrameTime = ts;
  const dt = Math.min((ts - previousFrameTime) / 1000, 0.05);
  previousFrameTime = ts;
  easeDir("NS", dt); easeDir("EW", dt); easeDir("PED", dt);
  UI.vehicles.forEach((v) => moveVehicle(v, dt));
  UI.pedestrians.forEach((f) => movePedestrian(f, dt));
  animationFrameId = requestAnimationFrame(animateLoop);
}

function initVehicleSimulation() {
  UI.vehicles    = Array.from(document.querySelectorAll(".vehicle"));
  UI.pedestrians = Array.from(document.querySelectorAll(".pedestrian-figure"));
  UI.vehicles.forEach((v, i) => {
    const lane = v.parentElement.classList.contains("lane-a") ? "a" : "b";
    v.dataset.lane = lane;
    v.dataset.flow = lane === "a" ? "forward" : "reverse";
    v.motionPosition = lane === "a" ? (i + 1) * 55 : 190 + i * 55;
  });
  UI.pedestrians.forEach((f, i) => {
    f.motionPosition = f.dataset.flow === "reverse" ? 210 + i * 65 : i * 58;
  });
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  animationFrameId = requestAnimationFrame(animateLoop);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PEDESTRIAN SUBSYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function togglePedestrianSystem() {
  if (trafficSystem.isTransitioning || trafficSystem.pedestrian.isDeactivating) return;
  if (trafficSystem.pedestrian.enabled) deactivatePedestrianMode();
  else activatePedestrianMode();
}

async function activatePedestrianMode() {
  if (trafficSystem.isTransitioning || trafficSystem.pedestrian.enabled) return;

  const token = mintToken();
  trafficSystem.isTransitioning = true;
  updateUI();
  addLog("Pedestrian mode requested — safe all-red transition…");

  // Bring active direction through YELLOW → RED
  const nsState = trafficSystem.intersections.NS.state;
  const ewState = trafficSystem.intersections.EW.state;

  if (nsState === "GREEN") {
    trafficSystem.intersections.NS.state = "YELLOW";
    updateUI();
    startTimer("NS", 1400, "YELLOW");
    addLog("NS: GREEN → YELLOW");
    const ok = await delayOrAbort(1400, token);
    if (!ok) return;
  }
  if (ewState === "GREEN") {
    trafficSystem.intersections.EW.state = "YELLOW";
    updateUI();
    startTimer("EW", 1400, "YELLOW");
    addLog("EW: GREEN → YELLOW");
    const ok = await delayOrAbort(1400, token);
    if (!ok) return;
  }

  // Open crossing
  trafficSystem.intersections.NS.state    = "RED";
  trafficSystem.intersections.EW.state    = "RED";
  trafficSystem.pedestrian.enabled        = true;
  trafficSystem.pedestrian.isDeactivating = false;
  trafficSystem.pedestrian.state          = "WALK";
  trafficSystem.queuedSwitch              = false;
  trafficSystem.isTransitioning           = false;
  resetTimerDisplay("NS"); resetTimerDisplay("EW");
  updateUI();
  addLog("Pedestrian crossing OPEN. Vehicles locked to RED.");

  // ── AUTO: run timed crossing then auto-close ──────────────────────────────
  if (trafficSystem.mode === "AUTO") {
    const crossMs = trafficSystem.timerDuration * 1000;
    startTimer("PED", crossMs, "WALK");
    const ok1 = await delayOrAbort(crossMs, token);
    if (!ok1 || !trafficSystem.pedestrian.enabled) return; // cancelled or already closed

    // RUN warning (2 s)
    trafficSystem.pedestrian.state          = "RUN";
    trafficSystem.pedestrian.isDeactivating = true;
    trafficSystem.isTransitioning           = true;
    updateUI();
    startTimer("PED", 2000, "WALK");
    addLog("Pedestrian: WALK → RUN (2 s)");
    const ok2 = await delayOrAbort(2000, token);
    if (!ok2) return;

    // STOP (1.5 s)
    trafficSystem.pedestrian.state = "STOP";
    updateUI();
    startTimer("PED", 1500, "STOP");
    addLog("Pedestrian: STOP (1.5 s)");
    const ok3 = await delayOrAbort(1500, token);
    if (!ok3) return;

    // Close
    trafficSystem.pedestrian.enabled        = false;
    trafficSystem.pedestrian.isDeactivating = false;
    trafficSystem.pedestrian.state          = "DISABLED";
    trafficSystem.isTransitioning           = false;
    resetTimerDisplay("PED");
    updateUI();
    addLog("Pedestrian crossing CLOSED. Resuming auto traffic cycle.");

    if (trafficSystem.mode === "AUTO" && trafficSystem._token === token) {
      runAutoStep(token);
    }
  }
  // MANUAL: stays open until user toggles off — nothing more to do here.
}

async function deactivatePedestrianMode() {
  if (trafficSystem.pedestrian.isDeactivating || !trafficSystem.pedestrian.enabled) return;

  const token = mintToken();
  trafficSystem.pedestrian.isDeactivating = true;
  trafficSystem.isTransitioning           = true;
  trafficSystem.pedestrian.state          = "WALK";
  updateUI();

  const ok1 = await delayOrAbort(2400, token);
  if (!ok1) return;

  trafficSystem.pedestrian.state = "RUN";
  updateUI();
  const ok2 = await delayOrAbort(1600, token);
  if (!ok2) return;

  trafficSystem.pedestrian.state = "STOP";
  updateUI();
  const ok3 = await delayOrAbort(1200, token);
  if (!ok3) return;

  trafficSystem.pedestrian.enabled        = false;
  trafficSystem.pedestrian.isDeactivating = false;
  trafficSystem.pedestrian.state          = "DISABLED";
  trafficSystem.isTransitioning           = false;
  resetTimerDisplay("PED");
  updateUI();
  addLog("Pedestrian mode DISABLED. Vehicle signals resuming.");

  if (trafficSystem.mode === "AUTO" && trafficSystem._token === token) {
    runAutoStep(token);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL LIGHT TRANSITION
// ═══════════════════════════════════════════════════════════════════════════════

async function transitionLights() {
  if (trafficSystem.mode !== "MANUAL") return;
  if (trafficSystem.isTransitioning || trafficSystem.pedestrian.enabled || trafficSystem.pedestrian.isDeactivating) return;

  const token = mintToken();
  trafficSystem.isTransitioning = true;
  updateUI();

  const from = trafficSystem.activeDirection;
  const to   = from === "NS" ? "EW" : "NS";
  addLog(`Manual transition: ${from} → ${to}`);

  // YELLOW (3 s)
  trafficSystem.intersections[from].state = "YELLOW";
  trafficSystem.intersections[to].state   = "RED";
  updateUI();
  addLog(`${from}: YELLOW (3 s)`);
  const ok1 = await delayOrAbort(3000, token);
  if (!ok1) return;

  // All-red buffer (1 s)
  trafficSystem.intersections[from].state = "RED";
  trafficSystem.intersections[to].state   = "RED";
  updateUI();
  addLog("All-red buffer (1 s)");
  const ok2 = await delayOrAbort(1000, token);
  if (!ok2) return;

  if (trafficSystem.pedestrian.enabled) {
    trafficSystem.isTransitioning = false;
    updateUI();
    addLog("Transition halted: pedestrian mode took priority.");
    return;
  }

  trafficSystem.intersections[to].state = "GREEN";
  trafficSystem.activeDirection         = to;
  trafficSystem.isTransitioning         = false;
  updateUI();
  addLog(`${to}: GREEN — transition complete.`);

  if (trafficSystem.queuedSwitch) {
    trafficSystem.queuedSwitch = false;
    addLog("Processing queued switch…");
    transitionLights();
  }
}

function handleManualSwitch() {
  if (trafficSystem.mode !== "MANUAL") { addLog("Ignored: in AUTO mode."); return; }
  if (trafficSystem.pedestrian.enabled) { addLog("Ignored: pedestrian mode is ON."); return; }
  if (trafficSystem.isTransitioning) {
    if (!trafficSystem.queuedSwitch) {
      trafficSystem.queuedSwitch = true;
      addLog("Switch queued — mid-transition.");
    } else {
      addLog("Ignored: switch already queued.");
    }
    return;
  }
  transitionLights();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO MODE CYCLE
// ═══════════════════════════════════════════════════════════════════════════════

async function runAutoStep(token) {
  if (trafficSystem.mode !== "AUTO" || trafficSystem._token !== token) return;
  if (trafficSystem.pedestrian.enabled || trafficSystem.pedestrian.isDeactivating) return;

  trafficSystem.isTransitioning = true;
  updateUI();

  const timings = getTimings();

  /**
   * Runs one direction's GREEN → YELLOW → all-RED-buffer half-cycle.
   * Returns false if the chain should be aborted.
   */
  async function halfCycle(active, passive) {
    if (trafficSystem._token !== token || trafficSystem.mode !== "AUTO") return false;

    // GREEN
    trafficSystem.intersections[active].state  = "GREEN";
    trafficSystem.intersections[passive].state = "RED";
    trafficSystem.activeDirection = active;
    updateUI();
    addLog(`[Auto] ${active}: GREEN (${timings.GREEN / 1000}s)`);
    startTimer(active,  timings.GREEN, "GREEN");
    startTimer(passive, timings.GREEN, "RED");
    const ok1 = await delayOrAbort(timings.GREEN, token);
    if (!ok1 || trafficSystem._token !== token || trafficSystem.mode !== "AUTO") return false;

    // YELLOW
    trafficSystem.intersections[active].state = "YELLOW";
    updateUI();
    addLog(`[Auto] ${active}: YELLOW (${timings.YELLOW / 1000}s)`);
    startTimer(active,  timings.YELLOW, "YELLOW");
    startTimer(passive, timings.YELLOW, "RED");
    const ok2 = await delayOrAbort(timings.YELLOW, token);
    if (!ok2 || trafficSystem._token !== token || trafficSystem.mode !== "AUTO") return false;

    // All-red buffer
    trafficSystem.intersections[active].state  = "RED";
    trafficSystem.intersections[passive].state = "RED";
    updateUI();
    startTimer(active,  timings.RED_BUFFER, "RED");
    startTimer(passive, timings.RED_BUFFER, "RED");
    const ok3 = await delayOrAbort(timings.RED_BUFFER, token);
    if (!ok3 || trafficSystem._token !== token || trafficSystem.mode !== "AUTO") return false;

    return true;
  }

  const ok1 = await halfCycle("NS", "EW");
  if (!ok1) { trafficSystem.isTransitioning = false; updateUI(); return; }

  const ok2 = await halfCycle("EW", "NS");
  if (!ok2) { trafficSystem.isTransitioning = false; updateUI(); return; }

  trafficSystem.isTransitioning = false;
  updateUI();

  // Loop if still valid
  if (trafficSystem.mode === "AUTO" && trafficSystem._token === token
      && !trafficSystem.pedestrian.enabled && !trafficSystem.pedestrian.isDeactivating) {
    runAutoStep(token);
  }
}

// ─── Enable / disable ─────────────────────────────────────────────────────────

function enableAutoMode() {
  if (trafficSystem.mode === "AUTO") return;
  if (trafficSystem.pedestrian.enabled) {
    addLog("Cannot enable Auto Mode while Pedestrian Mode is active.");
    return;
  }
  trafficSystem.previousMode    = "MANUAL";
  trafficSystem.mode            = "AUTO";
  trafficSystem.isTransitioning = false;
  trafficSystem.queuedSwitch    = false;
  ["NS","EW","PED"].forEach(resetTimerDisplay);
  updateUI();
  addLog(`Auto Mode ENABLED — phase duration: ${trafficSystem.timerDuration}s.`);
  const token = mintToken();
  runAutoStep(token);
}

function disableAutoMode() {
  if (trafficSystem.mode !== "AUTO") return;
  mintToken(); // cancel all in-flight chains
  trafficSystem.previousMode    = "AUTO";
  trafficSystem.mode            = "MANUAL";
  trafficSystem.isTransitioning = false;
  trafficSystem.queuedSwitch    = false;
  // Restore sane light state
  trafficSystem.intersections[trafficSystem.activeDirection].state = "GREEN";
  const other = trafficSystem.activeDirection === "NS" ? "EW" : "NS";
  trafficSystem.intersections[other].state = "RED";
  ["NS","EW","PED"].forEach(resetTimerDisplay);
  updateUI();
  addLog("Auto Mode DISABLED — Manual control active.");
}

function toggleAutoMode() {
  if (trafficSystem.mode === "AUTO") disableAutoMode();
  else enableAutoMode();
}

// ─── Timer duration slider ────────────────────────────────────────────────────

function onTimerDurationChange(e) {
  const val = parseInt(e.target.value, 10);
  if (isNaN(val)) return;
  trafficSystem.timerDuration = Math.max(2, Math.min(120, val));
  UI.timerDurationValue.textContent = `${trafficSystem.timerDuration}s`;
  if (trafficSystem.mode === "AUTO") {
    addLog(`Timer duration updated to ${trafficSystem.timerDuration}s (next cycle).`);
  }
}

// ─── Clear logs ───────────────────────────────────────────────────────────────

function clearLogs() {
  UI.logList.innerHTML = "";
  addLog("Logs cleared.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

function init() {
  UI.switchBtn          = document.querySelector("#switchBtn");
  UI.togglePedBtn       = document.querySelector("#togglePedBtn");
  UI.pedModeStatus      = document.querySelector("#pedModeStatus");
  UI.clearLogsBtn       = document.querySelector("#clearLogsBtn");
  UI.autoModeBtn        = document.querySelector("#autoModeBtn");
  UI.modeBadge          = document.querySelector("#modeBadge");
  UI.timerDurationInput = document.querySelector("#timerDuration");
  UI.timerDurationValue = document.querySelector("#timerDurationValue");
  UI.nsText             = document.querySelector("#ns-state-text");
  UI.ewText             = document.querySelector("#ew-state-text");
  UI.pedStateText       = document.querySelector("#ped-state-text");
  UI.logList            = document.querySelector("#logList");
  UI.nsRoad             = document.querySelector("#ns-road");
  UI.ewRoad             = document.querySelector("#ew-road");
  UI.pedestrianLane     = document.querySelector("#pedestrian-lane");
  UI.nsTimer            = document.querySelector("#ns-timer");
  UI.ewTimer            = document.querySelector("#ew-timer");
  UI.pedTimer           = document.querySelector("#ped-timer");

  UI.nsLights  = { red: document.querySelector("#ns-red"),  yellow: document.querySelector("#ns-yellow"),  green: document.querySelector("#ns-green")  };
  UI.ewLights  = { red: document.querySelector("#ew-red"),  yellow: document.querySelector("#ew-yellow"),  green: document.querySelector("#ew-green")  };
  UI.pedLights = { stop: document.querySelector("#ped-red"), walk: document.querySelector("#ped-green") };
  UI.pedLightBox = document.querySelector("#ped-signal");

  UI.switchBtn.addEventListener("click", handleManualSwitch);
  UI.togglePedBtn.addEventListener("click", togglePedestrianSystem);
  UI.clearLogsBtn.addEventListener("click", clearLogs);
  UI.autoModeBtn.addEventListener("click", toggleAutoMode);
  UI.timerDurationInput.addEventListener("input", onTimerDurationChange);

  initVehicleSimulation();
  updateUI();
  addLog("System initialized — NS: GREEN, EW: RED. Manual mode active.");
}

document.addEventListener("DOMContentLoaded", init);
