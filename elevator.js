/* Deterministic car controller. Distances are floors; time is seconds. */
(function (root) {
  "use strict";
  const FLOORS = [
    ...Array.from({ length: 20 }, (_, i) => i + 1),
    50,
    100,
    150,
    200,
    201,
  ];
  const CONFIG = Object.freeze({
    maxSpeed: 2.5,
    acceleration: 0.45,
    braking: 0.55,
    doorTime: 2.2,
    dwell: 3.5,
  });

  class Elevator {
    constructor(onEvent = () => {}) {
      this.onEvent = onEvent;
      this.sequence = 0;
      this.reset();
    }
    reset() {
      this.sequence++;
      this.position = 1;
      this.speed = 0;
      this.direction = 0;
      this.target = null;
      this.pending = new Set();
      this.phase = "open";
      this.door = 1; // 0 = fully closed, 1 = fully open
      this.elapsed = 0;
      this.ready = true;
      this.openHeld = false;
      this.intercom = false;
      this.departureDirection = 0;
      this.onEvent({ type: "reset", token: this.sequence });
    }
    get floor() {
      // Change the indicator at floor crossings, never half a floor early.
      return this.phase === "running"
        ? this.direction > 0
          ? Math.floor(this.position + 1e-7)
          : Math.ceil(this.position - 1e-7)
        : Math.round(this.position);
    }
    emit(type, extra = {}, wait = false) {
      const token = ++this.sequence;
      this.ready = !wait;
      this.onEvent({ type, token, ...extra });
    }
    release(token) {
      if (token === this.sequence) this.ready = true;
    }
    enter(phase) {
      this.phase = phase;
      this.elapsed = 0;
    }
    request(floor) {
      if (!FLOORS.includes(floor)) return false;
      if (this.phase !== "running" && floor === this.floor) {
        this.openDoor();
        return false;
      }
      if (this.pending.has(floor)) return false;
      this.pending.add(floor);
      if (!this.direction) this.direction = Math.sign(floor - this.position);
      if (this.phase === "idle") this.prepare();
      if (this.phase === "running") this.retarget();
      return true;
    }
    cancel(floor) {
      // Once the car has committed to a stop, its destination cannot disappear.
      if (this.phase === "running" && this.target === floor) return false;
      return this.pending.delete(floor);
    }
    next() {
      const floors = [...this.pending];
      if (!floors.length) return null;
      if (!this.direction)
        this.direction = Math.sign(floors[0] - this.position);
      let ahead = floors.filter(
        (f) => (f - this.position) * this.direction > 1e-7,
      );
      if (!ahead.length) {
        this.direction *= -1;
        ahead = floors.filter(
          (f) => (f - this.position) * this.direction > 1e-7,
        );
      }
      return (
        ahead.sort(
          (a, b) => Math.abs(a - this.position) - Math.abs(b - this.position),
        )[0] ?? null
      );
    }
    retarget() {
      const brakingDistance = (this.speed * this.speed) / (2 * CONFIG.braking);
      const reachable = [...this.pending].filter((f) => {
        const distance = (f - this.position) * this.direction;
        return distance > brakingDistance + 0.12;
      });
      // The existing target remains valid even inside its braking zone.
      if (this.target !== null) reachable.push(this.target);
      this.target = reachable.sort(
        (a, b) => Math.abs(a - this.position) - Math.abs(b - this.position),
      )[0];
    }
    prepare() {
      if (
        this.openHeld ||
        ["preparing", "closing", "running", "arrival", "opening"].includes(
          this.phase,
        )
      )
        return;
      this.target = this.next();
      if (this.target === null) this.direction = 0;
      this.departureDirection = this.direction;
      this.enter("preparing");
      this.emit(
        "departure",
        { direction: this.direction, close: this.door > 0 },
        true,
      );
    }
    openDoor() {
      if (["running", "arrival"].includes(this.phase)) return false;
      this.elapsed = 0;
      if (this.phase === "open") return true;
      if (this.phase !== "opening") {
        this.enter("opening");
        this.emit("opening", {}, true);
      }
      return true;
    }
    holdOpen(held) {
      this.openHeld = held && !["running", "arrival"].includes(this.phase);
      if (this.openHeld) this.openDoor();
      this.elapsed = 0;
    }
    closeDoor() {
      if (this.openHeld || this.phase !== "open" || this.elapsed < 0.6)
        return false;
      this.prepare();
      return true;
    }
    call() {
      this.intercom = !this.intercom;
      // The call button is an intercom, not an emergency brake.
      this.onEvent({ type: "intercom", active: this.intercom });
    }
    update(seconds) {
      // Fixed small substeps make route decisions independent of frame rate.
      let remaining = Math.max(0, Math.min(seconds, 0.25));
      while (remaining > 1e-8) {
        const dt = Math.min(remaining, 1 / 120);
        this.step(dt);
        remaining -= dt;
      }
    }
    step(dt) {
      this.elapsed += dt;
      if (this.phase === "open") {
        if (!this.openHeld && this.elapsed >= CONFIG.dwell) this.prepare();
      } else if (this.phase === "preparing") {
        if (this.ready && this.elapsed >= 0.3) this.enter("closing");
      } else if (this.phase === "closing") {
        this.door = Math.max(0, this.door - dt / CONFIG.doorTime);
        if (this.door === 0) {
          this.target = this.next();
          if (this.target === null) {
            this.direction = 0;
            this.enter("idle");
          } else {
            this.direction = Math.sign(this.target - this.position);
            if (this.direction !== this.departureDirection) {
              // A first call may arrive during automatic door closing.
              this.departureDirection = this.direction;
              this.enter("preparing");
              this.emit(
                "departure",
                { direction: this.direction, close: false },
                true,
              );
              return;
            }
            this.enter("running");
            this.emit("moving");
          }
        }
      } else if (this.phase === "running") {
        this.retarget();
        const distance = Math.abs(this.target - this.position);
        // Semi-implicit braking envelope, with a short leveling approach.
        const allowed = Math.sqrt(
          2 * CONFIG.braking * Math.max(0, distance - 0.015),
        );
        const desired = Math.min(CONFIG.maxSpeed, Math.max(0.055, allowed));
        const oldSpeed = this.speed;
        this.speed =
          desired > oldSpeed
            ? Math.min(desired, oldSpeed + CONFIG.acceleration * dt)
            : Math.max(desired, oldSpeed - CONFIG.braking * dt);
        const movement = (oldSpeed + this.speed) * 0.5 * dt;
        if (movement >= distance) {
          this.position = this.target;
          this.speed = 0;
          this.pending.delete(this.target);
          this.enter("arrival");
          this.emit("arrival", { floor: this.target }, true);
        } else this.position += movement * this.direction;
      } else if (this.phase === "arrival") {
        if (this.ready && this.elapsed >= 0.3) {
          this.enter("opening");
          this.emit("opening", {}, true);
        }
      } else if (this.phase === "opening") {
        this.door = Math.min(1, this.door + dt / CONFIG.doorTime);
        if (this.door === 1 && this.ready) {
          this.target = null;
          if (!this.pending.size) this.direction = 0;
          this.enter("open");
        }
      }
    }
  }
  const api = { Elevator, FLOORS, CONFIG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ElevatorModel = api;
})(typeof window !== "undefined" ? window : globalThis);
