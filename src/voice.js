// Spoken calls and beeps. Sound goes to whatever output the phone uses,
// so connected Bluetooth earphones get it automatically.

import { phrase } from './court.js';

const COUNT = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];

export class Voice {
  constructor({ mode = 'both', rate = 1.1, keepAlive = true } = {}) {
    this.mode = mode; // 'both' | 'voice' | 'beep'
    this.rate = rate;
    this.keepAlive = keepAlive;
    this.ctx = null;
    this.keep = null;
    this.voice = null;
    this.spoken = [];
    this.alerts = [];
    this.voiceCount = 0;
    this.hasSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (this.hasSpeech) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voiceCount = vs.length;
        this.voice = vs.find((v) => /^ko/i.test(v.lang) && v.localService) || vs.find((v) => /^ko/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  get hasKoreanVoice() {
    return !!this.voice;
  }

  // Call from a tap handler: browsers only start audio after a user gesture.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      this.ctx?.resume?.();
    } catch {
      this.ctx = null;
    }
    this.setKeepAlive(this.keepAlive);
    if (this.hasSpeech) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }

  // Bluetooth earphones go to sleep after a few seconds of silence and clip
  // the start of the next sound ("인" is short). An inaudible tone keeps the
  // link awake.
  setKeepAlive(on) {
    this.keepAlive = on;
    if (!this.ctx) return;
    if (on && !this.keep) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.frequency.value = 30;
      g.gain.value = 0.002;
      osc.connect(g).connect(this.ctx.destination);
      osc.start();
      this.keep = { osc, g };
    } else if (!on && this.keep) {
      try { this.keep.osc.stop(); } catch { /* already stopped */ }
      this.keep.osc.disconnect();
      this.keep = null;
    }
  }

  _tone(freq, at, dur, vol = 0.32) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.01);
    g.gain.setValueAtTime(vol, at + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  // in: one high tone; out: two low tones; unsure: three quick tones;
  // alert: a falling pair, twice; test: short click.
  beep(kind) {
    if (!this.ctx) return 0;
    const t = this.ctx.currentTime + 0.02;
    if (kind === 'alert') {
      for (const k of [0, 1]) { this._tone(880, t + k * 0.5, 0.16, 0.4); this._tone(587, t + k * 0.5 + 0.18, 0.2, 0.4); }
      return 0.95;
    }
    if (kind === 'in') { this._tone(1320, t, 0.12); return 0.14; }
    if (kind === 'out') { this._tone(440, t, 0.13); this._tone(440, t + 0.2, 0.13); return 0.35; }
    if (kind === 'unsure') { this._tone(700, t, 0.07, 0.25); this._tone(560, t + 0.1, 0.07, 0.25); this._tone(700, t + 0.2, 0.07, 0.25); return 0.3; }
    this._tone(880, t, 0.06, 0.25);
    return 0.08;
  }

  say(text) {
    this.spoken.push({ at: Date.now(), text });
    if (this.spoken.length > 50) this.spoken.shift();
    if (!this.hasSpeech) return;
    const speak = () => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = this.rate;
      u.volume = 1;
      if (this.voice) u.voice = this.voice;
      this.current = u; // keep a reference; some engines drop unreferenced utterances
      speechSynthesis.speak(u);
    };
    // A newer call replaces one still being read (or still waiting to be).
    // speak() straight after cancel() is dropped by some Chrome versions, so
    // give it a moment.
    clearTimeout(this.sayTimer);
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      this.sayTimer = setTimeout(speak, 80);
    } else speak();
  }

  // Stops whatever is being said or about to be said.
  hush() {
    clearTimeout(this.sayTimer);
    clearTimeout(this.afterBeep);
    clearTimeout(this.alertTimer);
    clearTimeout(this.noticeTimer);
    if (this.hasSpeech) speechSynthesis.cancel();
  }

  // A remark that is not urgent (poor light, screen lock not available). A
  // call must never be cut short by it, so it waits until nothing is being
  // said and the last call is a few seconds old; after half a minute of
  // waiting it is dropped.
  notice(text, waited = 0) {
    clearTimeout(this.noticeTimer);
    const busy = this.hasSpeech && (speechSynthesis.speaking || speechSynthesis.pending);
    const sinceCall = Date.now() - (this.lastCallAt || 0);
    if (!busy && sinceCall > 3000) { this.say(text); return; }
    if (waited >= 30000) return;
    this.noticeTimer = setTimeout(() => this.notice(text, waited + 700), 700);
  }

  // Something is wrong with the phone: a warning sound, then the message.
  // Spoken in every mode, since a beep alone cannot say what is wrong.
  // atOnce: speak without waiting for the sound to finish (the page is being
  // hidden and may not get another chance).
  alert(text, atOnce = false) {
    this.alerts.push({ at: Date.now(), text });
    if (this.alerts.length > 20) this.alerts.shift();
    const d = this.beep('alert');
    clearTimeout(this.alertTimer); // its own timer: a call arriving now must not drop the message
    if (atOnce) this.say(text);
    else this.alertTimer = setTimeout(() => this.say(text), d * 1000);
  }

  announce(call) {
    this.lastCallAt = Date.now();
    const text = phrase(call);
    if (this.mode === 'beep') {
      this.spoken.push({ at: Date.now(), text: `[beep] ${text}` });
      this.beep(call.in ? 'in' : 'out');
      return;
    }
    if (this.mode === 'both') {
      const d = this.beep(call.in ? 'in' : 'out');
      clearTimeout(this.afterBeep);
      this.afterBeep = setTimeout(() => this.say(text), d * 1000);
    } else {
      this.say(text);
    }
  }

  // The ball came over but could not be judged.
  announceUnsure() {
    this.lastCallAt = Date.now();
    const text = '놓쳤어요';
    if (this.mode === 'beep') {
      this.spoken.push({ at: Date.now(), text: `[beep] ${text}` });
      this.beep('unsure');
      return;
    }
    if (this.mode === 'both') {
      const d = this.beep('unsure');
      clearTimeout(this.afterBeep);
      this.afterBeep = setTimeout(() => this.say(text), d * 1000);
    } else this.say(text);
  }

  countWord(i) {
    return i <= COUNT.length ? COUNT[i - 1] : String(i);
  }
}
