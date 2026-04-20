const trafficSystem = {
  intersections: {
    NS: { state: "GREEN" },
    EW: { state: "RED" }
  },
  activeDirection: "NS",
  isTransitioning: false,
  queuedSwitch: false
};

const UI = {
  switchBtn: null,
  clearLogsBtn: null,
  nsText: null,
  ewText: null,
  logList: null,
  nsRoad: null,
  ewRoad: null,
  vehicles: [],
  nsLights: {},
  ewLights: {}
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let animationFrameId = null;
let previousFrameTime = 0;

const vehicleMotion = {
  NS: { speed: 0, targetSpeed: 120 },
  EW: { speed: 0, targetSpeed: 0 }
};

/**
 * Writes a timestamped event to the logs panel.
 * Control flow: this function is synchronous, so it always completes in one call stack pass.
 * Event loop note: no async operations are queued here; DOM updates occur immediately.
 */
function addLog(message) {
  const li = document.createElement("li");
  li.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  UI.logList.prepend(li);

  if (UI.logList.children.length > 40) {
    UI.logList.removeChild(UI.logList.lastElementChild);
  }
}

/**
 * Applies the current trafficSystem state to the visual bulbs and labels.
 * Control flow: it first clears all active bulbs, then activates exactly one color per direction.
 * Event loop note: because this is synchronous DOM work, browser paint happens after this function
 * returns and the call stack is clear.
 */
function updateUI() {
  const ns = trafficSystem.intersections.NS.state;
  const ew = trafficSystem.intersections.EW.state;

  UI.nsLights.red.classList.toggle("active", ns === "RED");
  UI.nsLights.yellow.classList.toggle("active", ns === "YELLOW");
  UI.nsLights.green.classList.toggle("active", ns === "GREEN");

  UI.ewLights.red.classList.toggle("active", ew === "RED");
  UI.ewLights.yellow.classList.toggle("active", ew === "YELLOW");
  UI.ewLights.green.classList.toggle("active", ew === "GREEN");

  UI.nsText.textContent = ns;
  UI.ewText.textContent = ew;
  UI.switchBtn.disabled = trafficSystem.isTransitioning;

  UI.nsRoad.setAttribute("data-signal", ns);
  UI.ewRoad.setAttribute("data-signal", ew);

  // Speed targets are state-driven so road motion always mirrors light logic.
  vehicleMotion.NS.targetSpeed = getTargetSpeed(ns);
  vehicleMotion.EW.targetSpeed = getTargetSpeed(ew);
}

/**
 * Maps a traffic light state to a target vehicle speed in pixels per second.
 * Control flow: this is a pure function with a small deterministic branch table.
 * Event loop note: pure computation means no queued work; it safely runs every render update.
 */
function getTargetSpeed(state) {
  if (state === "GREEN") {
    return 120;
  }

  if (state === "YELLOW") {
    return 38;
  }

  return 0;
}

/**
 * Smoothly eases a direction's speed toward its target based on frame delta.
 * Control flow: acceleration/deceleration are clamped per frame to avoid sudden jumps.
 * Event loop note: this runs inside requestAnimationFrame, so updates are synchronized to paint frames.
 */
function easeDirectionalSpeed(direction, deltaSeconds) {
  const motion = vehicleMotion[direction];
  const difference = motion.targetSpeed - motion.speed;

  if (Math.abs(difference) < 0.5) {
    motion.speed = motion.targetSpeed;
    return;
  }

  const rampRate = difference > 0 ? 130 : 80;
  const step = Math.sign(difference) * Math.min(Math.abs(difference), rampRate * deltaSeconds);
  motion.speed += step;
}

/**
 * Advances one vehicle along its lane and wraps it when it exits the road bounds.
 * Control flow: movement is axis-based (vertical for NS, horizontal for EW), then modulo wrapping is applied.
 * Event loop note: no timers are created here; this executes once per animation frame.
 */
function moveVehicle(vehicle, deltaSeconds) {
  const direction = vehicle.dataset.direction;
  const speed = vehicleMotion[direction].speed;
  const road = vehicle.closest(".road");
  const isNSRoad = road.classList.contains("road-ns");
  const laneDirection = vehicle.dataset.flow === "reverse" ? -1 : 1;
  const signedSpeed = speed * laneDirection;

  const trackLength = isNSRoad ? road.clientHeight : road.clientWidth;
  const carLength = isNSRoad ? vehicle.offsetHeight : vehicle.offsetWidth;
  const loopLength = trackLength + carLength;

  let nextPosition = vehicle.motionPosition + signedSpeed * deltaSeconds;
  if (nextPosition > loopLength) {
    nextPosition -= loopLength;
  }
  if (nextPosition < 0) {
    nextPosition += loopLength;
  }

  vehicle.motionPosition = nextPosition;
  const offset = nextPosition - carLength;

  if (isNSRoad) {
    vehicle.style.top = `${offset}px`;
    vehicle.style.left = vehicle.dataset.lane === "a" ? "24%" : "64%";
    vehicle.style.transform = `translate(-50%, 0) ${laneDirection < 0 ? "rotate(180deg)" : "rotate(0deg)"}`;
  } else {
    vehicle.style.left = `${offset}px`;
    vehicle.style.top = vehicle.dataset.lane === "a" ? "30%" : "72%";
    vehicle.style.transform = `translate(0, -50%) ${laneDirection < 0 ? "rotate(180deg)" : "rotate(0deg)"}`;
  }
}

/**
 * Main animation loop for the road simulation.
 * Control flow: calculates frame delta, eases each direction's speed, then moves all vehicles.
 * Event loop note: requestAnimationFrame schedules the next callback in the browser's render phase,
 * giving smooth motion and preventing timer drift that can happen with setInterval.
 */
function animateVehicles(timestamp) {
  if (!previousFrameTime) {
    previousFrameTime = timestamp;
  }

  const deltaSeconds = Math.min((timestamp - previousFrameTime) / 1000, 0.05);
  previousFrameTime = timestamp;

  easeDirectionalSpeed("NS", deltaSeconds);
  easeDirectionalSpeed("EW", deltaSeconds);

  UI.vehicles.forEach((vehicle) => moveVehicle(vehicle, deltaSeconds));
  animationFrameId = window.requestAnimationFrame(animateVehicles);
}

/**
 * Prepares vehicle metadata and starts the real-time animation engine.
 * Control flow: each vehicle receives a deterministic initial offset so cars are evenly distributed.
 * Event loop note: starts one persistent requestAnimationFrame loop; no parallel loops are created.
 */
function initVehicleSimulation() {
  UI.vehicles = Array.from(document.querySelectorAll(".vehicle"));

  UI.vehicles.forEach((vehicle, index) => {
    const lane = vehicle.parentElement.classList.contains("lane-a") ? "a" : "b";
    vehicle.dataset.lane = lane;
    vehicle.dataset.flow = lane === "a" ? "forward" : "reverse";
    vehicle.motionPosition = lane === "a" ? (index + 1) * 55 : 190 + index * 55;
  });

  if (animationFrameId) {
    window.cancelAnimationFrame(animationFrameId);
  }

  animationFrameId = window.requestAnimationFrame(animateVehicles);
}

/**
 * Clears log entries from the panel while preserving runtime state.
 * Control flow: removes list children synchronously and then logs the clear operation.
 * Event loop note: this operation is immediate DOM mutation and does not spawn async work.
 */
function clearLogs() {
  UI.logList.innerHTML = "";
  addLog("System logs cleared.");
}

/**
 * Runs a safe light handoff with yellow and all-red buffers:
 * 1) Active direction becomes YELLOW for 3 seconds.
 * 2) Then becomes RED.
 * 3) Wait 1 second all-red safety window.
 * 4) Opposite direction turns GREEN.
 *
 * Control flow: async/await keeps the sequence linear and readable while pausing between steps.
 * Event loop note: each await yields control back to the event loop, so UI remains responsive and paints
 * intermediate states (yellow/red) at real time intervals.
 */
async function transitionLights() {
  if (trafficSystem.isTransitioning) {
    return;
  }

  trafficSystem.isTransitioning = true;
  updateUI();

  const from = trafficSystem.activeDirection;
  const to = from === "NS" ? "EW" : "NS";

  addLog(`Transition requested: ${from} -> ${to}`);

  trafficSystem.intersections[from].state = "YELLOW";
  trafficSystem.intersections[to].state = "RED";
  updateUI();
  addLog(`${from} set to YELLOW (3s buffer)`);
  await delay(3000);

  trafficSystem.intersections[from].state = "RED";
  trafficSystem.intersections[to].state = "RED";
  updateUI();
  addLog(`${from} set to RED. All-red hold (1s)`);
  await delay(1000);

  trafficSystem.intersections[to].state = "GREEN";
  trafficSystem.activeDirection = to;
  updateUI();
  addLog(`${to} set to GREEN. Transition complete.`);

  trafficSystem.isTransitioning = false;
  updateUI();

  if (trafficSystem.queuedSwitch) {
    trafficSystem.queuedSwitch = false;
    addLog("Processing queued switch request...");
    transitionLights();
  }
}

/**
 * Handles user actions and guards against race conditions.
 * Control flow:
 * - If idle, start transition immediately.
 * - If already transitioning, store one queued request and ignore additional spam clicks.
 * Event loop note: click handlers are macrotasks; by using flags in shared state before awaiting,
 * we prevent overlapping async transitions from ever running in parallel.
 */
function handleLogic() {
  if (trafficSystem.isTransitioning) {
    if (!trafficSystem.queuedSwitch) {
      trafficSystem.queuedSwitch = true;
      addLog("Switch queued: system is mid-transition.");
    } else {
      addLog("Ignored: switch already queued.");
    }
    return;
  }

  transitionLights();
}

/**
 * Boots the dashboard by caching DOM references, binding events, and performing first render.
 * Control flow: setup is deterministic and runs once after DOMContentLoaded.
 * Event loop note: this callback runs when the document parsing task is complete, ensuring all queried
 * elements exist before listener binding and initial paint.
 */
function init() {
  UI.switchBtn = document.querySelector("#switchBtn");
  UI.clearLogsBtn = document.querySelector("#clearLogsBtn");
  UI.nsText = document.querySelector("#ns-state-text");
  UI.ewText = document.querySelector("#ew-state-text");
  UI.logList = document.querySelector("#logList");
  UI.nsRoad = document.querySelector("#ns-road");
  UI.ewRoad = document.querySelector("#ew-road");

  UI.nsLights = {
    red: document.querySelector("#ns-red"),
    yellow: document.querySelector("#ns-yellow"),
    green: document.querySelector("#ns-green")
  };

  UI.ewLights = {
    red: document.querySelector("#ew-red"),
    yellow: document.querySelector("#ew-yellow"),
    green: document.querySelector("#ew-green")
  };

  UI.switchBtn.addEventListener("click", handleLogic);
  UI.clearLogsBtn.addEventListener("click", clearLogs);

  initVehicleSimulation();
  updateUI();
  addLog("System initialized: NS GREEN, EW RED");
}

document.addEventListener("DOMContentLoaded", init);
