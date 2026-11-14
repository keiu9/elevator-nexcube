(function (root) {
  "use strict";
  function normalizeVoice(buffer) {
    let energy = 0,
      peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      for (const sample of buffer.getChannelData(channel)) {
        energy += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
    }
    if (peak < 0.0001) return buffer;
    const rms = Math.sqrt(energy / (buffer.length * buffer.numberOfChannels));
    const gain = Math.min(6, 0.85 / peak, 0.1 / rms);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] *= gain;
    }
    return buffer;
  }
  // One queue owns speech and chimes. Each caller can await actual completion.
  class AnnouncementQueue {
    constructor(play) {
      this.play = play;
      this.jobs = [];
      this.generation = 0;
      this.busy = false;
    }
    enqueue(items) {
      return new Promise((resolve) => {
        this.jobs.push({ items, resolve, generation: this.generation });
        this.drain();
      });
    }
    cancel() {
      this.generation++;
      for (const job of this.jobs.splice(0)) job.resolve(false);
      this.stop?.();
    }
    async drain() {
      if (this.busy) return;
      this.busy = true;
      try {
        while (this.jobs.length) {
          const job = this.jobs.shift();
          for (const item of job.items) {
            if (job.generation !== this.generation) break;
            try {
              await this.play(item, job.generation);
            } catch {
              /* Continue after a failed clip. */
            }
          }
          job.resolve(job.generation === this.generation);
        }
      } finally {
        this.busy = false;
      }
    }
  }

  class ElevatorAudio {
    constructor(onCaption) {
      this.enabled = true;
      this.context = null;
      this.buffers = new Map();
      this.onCaption = onCaption;
      this.queue = new AnnouncementQueue((item, generation) =>
        this.play(item, generation),
      );
      this.queue.stop = () => {
        this.stopClip?.();
        root.speechSynthesis?.cancel();
      };
    }
    unlock() {
      const Context = root.AudioContext || root.webkitAudioContext;
      if (!this.context && Context) this.context = new Context();
      // Called synchronously from every user gesture (including after iPad sleep).
      this.context?.resume().catch(() => {});
      root.speechSynthesis?.resume();
    }
    setEnabled(enabled) {
      this.enabled = enabled;
      if (!enabled) {
        this.queue.cancel();
        this.stopMotor();
      } else this.unlock();
    }
    cancel() {
      this.queue.cancel();
      this.stopMotor();
    }
    say(items) {
      return this.queue.enqueue(items);
    }
    buffer(src) {
      if (!this.buffers.has(src)) {
        const promise = (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 6000);
          try {
            const response = await fetch(src, { signal: controller.signal });
            if (!response.ok) throw new Error("Audio unavailable");
            const buffer = await this.context.decodeAudioData(
              await response.arrayBuffer(),
            );
            return src.includes("/voice/") ? normalizeVoice(buffer) : buffer;
          } finally {
            clearTimeout(timeout);
          }
        })();
        // Cache failures too: a missing recording should not stall every trip.
        promise.catch(() => {});
        this.buffers.set(src, promise);
      }
      return this.buffers.get(src);
    }
    async play(item, generation) {
      const current = () => generation === this.queue.generation;
      if (!current()) return;
      this.onCaption(item.text || "♪ 到着チャイム");
      if (!this.enabled || !this.context) return;
      let buffer;
      try {
        buffer = await this.buffer(item.src);
      } catch {
        /* Use Japanese speech below. */
      }
      if (!current() || !this.enabled) return;
      if (!buffer || this.context.state !== "running") {
        if (item.text) await this.speak(item.text, current);
        else this.tone(880, 0.22, 0.035);
        return;
      }
      await new Promise((resolve) => {
        const source = this.context.createBufferSource();
        const gain = this.context.createGain();
        gain.gain.value = item.chime ? 0.45 : 0.9;
        source.buffer = buffer;
        source.connect(gain).connect(this.context.destination);
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          source.disconnect();
          gain.disconnect();
          if (this.stopClip === stop) this.stopClip = null;
          resolve();
        };
        const stop = () => {
          try {
            source.stop();
          } catch {}
          done();
        };
        const watchdog = setTimeout(stop, (buffer.duration + 2) * 1000);
        source.onended = done;
        this.stopClip = stop;
        source.start();
      });
    }
    speak(text, current) {
      if (!root.speechSynthesis || !current()) return Promise.resolve();
      return new Promise((resolve) => {
        const utterance = new root.SpeechSynthesisUtterance(text);
        utterance.lang = "ja-JP";
        utterance.voice =
          root.speechSynthesis
            .getVoices()
            .find((v) => /^ja[-_]JP/i.test(v.lang)) || null;
        utterance.rate = 0.95;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          if (this.stopClip === stop) this.stopClip = null;
          resolve();
        };
        const stop = () => {
          root.speechSynthesis.cancel();
          done();
        };
        const watchdog = setTimeout(stop, 8000);
        utterance.onend = done;
        utterance.onerror = done;
        this.stopClip = stop;
        root.speechSynthesis.speak(utterance);
      });
    }
    tone(frequency = 880, duration = 0.035, volume = 0.025) {
      if (!this.enabled || this.context?.state !== "running") return;
      const now = this.context.currentTime;
      const source = this.context.createOscillator();
      const gain = this.context.createGain();
      source.type = "sine";
      source.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      source.connect(gain).connect(this.context.destination);
      source.start();
      source.stop(now + duration + 0.01);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
    }
    motor(speed) {
      if (!this.enabled || !speed || this.context?.state !== "running") {
        this.stopMotor();
        return;
      }
      if (!this.motorSource) {
        this.motorSource = this.context.createOscillator();
        this.motorGain = this.context.createGain();
        this.motorSource.type = "sine";
        this.motorGain.gain.value = 0;
        this.motorSource
          .connect(this.motorGain)
          .connect(this.context.destination);
        this.motorSource.start();
      }
      this.motorSource.frequency.setTargetAtTime(
        42 + speed * 28,
        this.context.currentTime,
        0.15,
      );
      this.motorGain.gain.setTargetAtTime(
        0.012 * Math.min(speed, 1),
        this.context.currentTime,
        0.2,
      );
    }
    stopMotor() {
      if (!this.motorSource) return;
      const source = this.motorSource,
        gain = this.motorGain;
      gain.gain.setTargetAtTime(0, this.context.currentTime, 0.08);
      source.stop(this.context.currentTime + 0.3);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      this.motorSource = null;
    }
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = { AnnouncementQueue, normalizeVoice };
  else root.ElevatorAudio = ElevatorAudio;
})(typeof window !== "undefined" ? window : globalThis);
