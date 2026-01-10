// src/app/audio/audio-engine.ts
import { MelodyEngine } from './melody-engine';
import { buildTriadMidi, midiToHz } from './music-theory';
import { AudioProfile, EngineMode, SectionStyle } from './types-adio';

export type AudioContextHint = {
  sseAlive?: boolean;
  onlineNow?: number;
  mode?: EngineMode | string;
  focusScore?: number;  // 0..1
  stressScore?: number; // 0..1
};

export type UserSignal =
  | { type: 'TIP_VIEW'; id?: string }
  | { type: 'TIP_LIKE'; id?: string }
  | { type: 'TIP_DISLIKE'; id?: string }
  | { type: 'SKIP_AUDIO' }
  | { type: 'SESSION_TICK'; seconds: number }
  | { type: 'MODE_CHANGE'; mode: string };

type Motif = {
  id: string;
  scale: number[];
  progression: number[];
  pulsePattern: Array<0 | 1 | 2>;
  bpmMin: number;
  bpmMax: number;
  padWave: OscillatorType;
  pulseWave: OscillatorType;
};

type ProfileParams = {
  masterAmp: number;

  rootHz: number;
  padAmp: number;
  padCutoff: number;
  padQ: number;
  detuneCents: number;

  noiseAmp: number;
  noiseHz: number;
  noiseQ: number;

  pulseAmp: number;
  pulseBaseHz: number;
  bpm: number;

  lfoHz: number;
  lfoDepth: number;

  spaceMix: number;
  delayTime: number;
  delayFb: number;

  verbMix: number;
};

type EmotionState = {
  valence: number; // -1..+1
  arousal: number; // 0..1
  trust: number;   // 0..1
};

type BanditStats = { n: number; r: number; last: number };

type LearningState = {
  version: number;
  bandit: Record<AudioProfile, Record<string, BanditStats>>;
  profileBias: Record<AudioProfile, { calm: number; drive: number }>;
  lastTipId?: string;
  lastProfile?: AudioProfile;
  emotion: EmotionState;

  // ✅ anti repetición real
  lastMotifByProfile?: Partial<Record<AudioProfile, string>>;
  motifCooldown?: Record<string, number>; // motifId -> timestamp last used
};

type Nodes = {
  master: GainNode;

  padOscA: OscillatorNode;
  padOscB: OscillatorNode;
  padOscC: OscillatorNode;
  padGain: GainNode;
  padFilter: BiquadFilterNode;

  lfoOsc: OscillatorNode;
  lfoGain: GainNode;

  noiseSrc: AudioBufferSourceNode;
  noiseGain: GainNode;
  noiseFilter: BiquadFilterNode;

  pulseOsc: OscillatorNode;
  pulseEnv: GainNode;
  pulseGain: GainNode;

  dryBus: GainNode;

  // Space (delay)
  spaceSend: GainNode;
  delay: DelayNode;
  delayFb: GainNode;
  delayLP: BiquadFilterNode;
  spaceReturn: GainNode;

  // Reverb
  verb: ConvolverNode;
  verbSend: GainNode;
  verbReturn: GainNode;

  // ✅ Para verificación real de salida
  analyser: AnalyserNode;
};

type LeadStep = { step: number; durSteps: number; vel: number };

const EPS = 0.0001;
const STORE_KEY = 'gaudio_learning_v2';

export class AudioEngine {
  private ctx?: AudioContext;
  private nodes?: Nodes;

  private started = false;
  private profile: AudioProfile = 'bienestar';

  private schedulerTimer?: number;
  private nextStepTime = 0;
  private stepIndex = 0;

  private hint: Required<AudioContextHint> = {
    sseAlive: true,
    onlineNow: 0,
    mode: 'NORMAL',
    focusScore: 0.5,
    stressScore: 0.3,
  };

  private seed = 123456789;
  private motifKey = 'default';
  private currentMotif: Motif = this.getMotifPool('bienestar')[0];

  private learning: LearningState = this.loadLearning();
  private sessionSeconds = 0;

  private sectionStyle: SectionStyle = 'BASE';
  private sectionLenBars = 8;
  private patternRotate = 0;

  private melody = new MelodyEngine();
  private leadEnabled = true;
  private leadSteps: LeadStep[] = [];
  private leadChanceBase = 0.78;
  private leadAmpMax = 0.045;

  private lastTimbreKey = '';

  // ✅ NUEVO: swing/humanización (anti robot)
  private swing = 0.10;         // 0..0.22 aprox
  private humanMs = 0.012;      // 0..0.02 (segundos)
  private pulseHuman = 0.10;    // variación de volumen
  private chordHuman = 0.02;    // variación de tiempo (acorde)
  private breakChance = 0.08;   // micro breaks para respirar
  private fillChance = 0.55;    // fills en cierre de 16 pasos

  async init(): Promise<boolean> {
    if (this.ctx && this.nodes) return true;

    try {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctx) return false;

      this.ctx = new Ctx();
      this.nodes = this.buildGraph(this.ctx);

      this.refreshTimbreIfNeeded('INIT');
      return true;
    } catch {
      this.ctx = undefined;
      this.nodes = undefined;
      return false;
    }
  }

  get contextState(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  get isRunning(): boolean {
    return !!(this.ctx && this.nodes && this.started && this.ctx.state === 'running');
  }

  /** Para que el service pueda validar si “sale audio” */
  readRms(): number {
    if (!this.nodes) return 0;
    const a = this.nodes.analyser;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / Math.max(1, buf.length));
  }

  async start(profile: AudioProfile = this.profile, hint?: AudioContextHint): Promise<boolean> {
    const ok = await this.ensureReady();
    if (!ok) return false;

    if (hint) this.setContextHint(hint);
    this.profile = profile;

    try {
      await this.resumeContext();

      if (!this.started && this.ctx && this.nodes) {
        this.nodes.padOscA.start();
        this.nodes.padOscB.start();
        this.nodes.padOscC.start();
        this.nodes.pulseOsc.start();
        this.nodes.noiseSrc.start();
        this.nodes.lfoOsc.start();
        this.started = true;
      }

      this.setDailyAnchorSeed(profile);

      this.currentMotif = this.pickMotifLearned(profile);
      this.resetSections(true);

      this.applyProfile(profile, true);
      this.restartScheduler(true);

      this.learning.lastProfile = profile;
      this.saveLearning();
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (!this.ctx || !this.nodes) return;

    this.stopScheduler();

    const t = this.ctx.currentTime;
    this.nodes.master.gain.cancelScheduledValues(t);
    this.nodes.master.gain.setTargetAtTime(EPS, t, 0.12);
  }

  setProfile(profile: AudioProfile, hint?: AudioContextHint): void {
    this.profile = profile;
    if (hint) this.setContextHint(hint);

    this.setDailyAnchorSeed(profile);
    this.currentMotif = this.pickMotifLearned(profile);
    this.resetSections(true);

    if (!this.ctx || !this.nodes || !this.started) return;
    this.applyProfile(profile, false);
    this.restartScheduler(true);

    this.learning.lastProfile = profile;
    this.saveLearning();
  }

  setContextHint(hint: AudioContextHint): void {
    this.hint = {
      sseAlive: hint.sseAlive ?? this.hint.sseAlive,
      onlineNow: hint.onlineNow ?? this.hint.onlineNow,
      mode: (hint.mode ?? this.hint.mode) as any,
      focusScore: this.clamp(hint.focusScore ?? this.hint.focusScore, 0, 1),
      stressScore: this.clamp(hint.stressScore ?? this.hint.stressScore, 0, 1),
    };

    this.updateEmotionFromContext();
    this.tuneHumanizationFromContext(); // ✅ nuevo

    if (!this.ctx || !this.nodes || !this.started) return;
    this.applyProfile(this.profile, false);
    this.restartScheduler(false);
  }

  onUserSignal(signal: UserSignal): void {
    if (signal.type === 'TIP_VIEW') {
      this.learning.lastTipId = signal.id ?? this.learning.lastTipId;
      this.motifKey = (signal.id || 'default');

      this.setDailyAnchorSeed(this.profile);
      this.bumpEmotion({ arousal: +0.03, valence: +0.01, trust: +0.01 });

      this.currentMotif = this.pickMotifLearned(this.profile, { gentle: true });
      this.rewardMotif(+0.08);

      this.resetSections(true);
    }

    if (signal.type === 'TIP_LIKE') {
      this.bumpEmotion({ valence: +0.08, trust: +0.05, arousal: +0.02 });
      this.rewardMotif(+0.35);
    }

    if (signal.type === 'TIP_DISLIKE') {
      this.bumpEmotion({ valence: -0.10, trust: -0.06, arousal: +0.02 });
      this.rewardMotif(-0.30);
      this.currentMotif = this.pickMotifLearned(this.profile, { exploreBoost: 0.25 });
      this.resetSections(true);
    }

    if (signal.type === 'SKIP_AUDIO') {
      this.bumpEmotion({ valence: -0.05, trust: -0.03, arousal: +0.04 });
      this.rewardMotif(-0.18);
      this.currentMotif = this.pickMotifLearned(this.profile, { exploreBoost: 0.20 });
      this.resetSections(true);
    }

    if (signal.type === 'MODE_CHANGE') {
      this.setContextHint({ mode: signal.mode });
      this.rewardMotif(signal.mode !== 'NORMAL' ? -0.05 : +0.02);
    }

    if (signal.type === 'SESSION_TICK') {
      this.sessionSeconds += Math.max(0, signal.seconds);
      const r = this.clamp(signal.seconds / 120, 0, 0.06);
      this.rewardMotif(r);
      this.bumpEmotion({ valence: +0.005, trust: +0.004, arousal: -0.004 });
    }

    if (this.ctx && this.nodes && this.started) {
      this.applyProfile(this.profile, false);
      this.restartScheduler(false);
    }

    this.saveLearning();
  }

  onTipChanged(seedKey: string): void {
    this.motifKey = seedKey || 'default';
    this.setDailyAnchorSeed(this.profile);
    this.resetSections(false);

    if (this.ctx && this.nodes && this.started) {
      this.applyProfile(this.profile, false);
      this.restartScheduler(false);
    }
    this.saveLearning();
  }

  async destroy(): Promise<void> {
    this.stopScheduler();
    try { await this.ctx?.close(); } catch {}
    this.ctx = undefined;
    this.nodes = undefined;
    this.started = false;
  }

  /* -------------------------
     Internals
  ------------------------- */

  private async ensureReady(): Promise<boolean> {
    if (this.ctx && this.nodes) return true;
    return this.init();
  }

  private async resumeContext(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private resetSections(hard: boolean): void {
    this.patternRotate = Math.floor(this.randFloat() * 8) % 8;
    this.sectionStyle = this.pickSectionStyle();

    if (hard) this.melody.reset(this.seed);
    else this.melody.reset((this.seed ^ 0xA5A5) >>> 0);

    const e = this.learning.emotion;
    const calm = this.clamp(1 - e.arousal, 0, 1);
    const happy = this.clamp((e.valence + 1) / 2, 0, 1);

    const chance = this.clamp(
      this.leadChanceBase
        + calm * 0.12
        + happy * 0.06
        - (this.hint.mode !== 'NORMAL' ? 0.22 : 0)
        - (this.hint.sseAlive ? 0 : 0.18),
      0.25,
      0.95
    );

    this.leadEnabled = this.randFloat() < chance;

    // ✅ patrón nuevo por sección (varía de verdad)
    this.currentMotif = {
      ...this.currentMotif,
      pulsePattern: this.buildPulsePatternForSection(this.profile),
    };

    const sectionSteps = this.sectionLenBars * 4;
    this.leadSteps = this.buildLeadPattern(sectionSteps, hard);

    this.refreshTimbreIfNeeded(hard ? 'SECTION_HARD' : 'SECTION_SOFT');
    this.tuneHumanizationFromContext(); // ✅ nuevo
  }

  private pickSectionStyle(): SectionStyle {
    const e = this.learning.emotion;
    const calm = this.clamp(1 - e.arousal, 0, 1);
    const happy = this.clamp((e.valence + 1) / 2, 0, 1);

    const r = this.randFloat();
    if (calm > 0.65 && r < 0.30) return 'BASE';
    if (calm > 0.65 && r < 0.52) return 'SUS2';
    if (calm > 0.65 && r < 0.68) return 'SUS4';
    if (happy > 0.55 && r < 0.78) return 'ADD7';
    if (r < 0.86) return 'INVERT';
    if (r < 0.93) return 'DRIFT';
    return (r < 0.965) ? 'OCT_UP' : 'OCT_DN';
  }

  private tuneHumanizationFromContext(): void {
    const strict = (this.hint.mode ?? 'NORMAL') !== 'NORMAL';
    const stress = this.clamp(this.hint.stressScore ?? 0.3, 0, 1);
    const ar = this.clamp(this.learning.emotion.arousal, 0, 1);

    // ✅ más estrés/strict => menos swing y menos caos; más calma => más “aire”
    const baseSwing = this.profile === 'bienestar' ? 0.14 : this.profile === 'estudio' ? 0.11 : 0.09;
    this.swing = this.clamp(baseSwing + (1 - stress) * 0.06 + (1 - ar) * 0.03 - (strict ? 0.06 : 0), 0.03, 0.22);

    const baseHuman = this.profile === 'bienestar' ? 0.015 : 0.012;
    this.humanMs = this.clamp(baseHuman + (1 - stress) * 0.006 - (strict ? 0.006 : 0), 0.004, 0.020);

    this.pulseHuman = this.clamp(0.08 + (1 - stress) * 0.10, 0.04, 0.22);
    this.chordHuman = this.clamp(0.012 + (1 - stress) * 0.020, 0.004, 0.030);

    // breaks/fills: dan “respiración” y evitan loop evidente
    this.breakChance = this.clamp(0.05 + (1 - stress) * 0.10 - (strict ? 0.05 : 0), 0.02, 0.14);
    this.fillChance = this.clamp(0.45 + (1 - stress) * 0.25, 0.35, 0.80);
  }

  private buildGraph(ctx: AudioContext): Nodes {
    const master = ctx.createGain();
    master.gain.value = EPS;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    master.connect(analyser);
    analyser.connect(ctx.destination);

    const dryBus = ctx.createGain();
    dryBus.gain.value = 1;
    dryBus.connect(master);

    // Pad
    const padOscA = ctx.createOscillator();
    const padOscB = ctx.createOscillator();
    const padOscC = ctx.createOscillator();

    const padGain = ctx.createGain();
    padGain.gain.value = 0;

    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 600;
    padFilter.Q.value = 0.8;

    padOscA.connect(padGain);
    padOscB.connect(padGain);
    padOscC.connect(padGain);
    padGain.connect(padFilter);
    padFilter.connect(dryBus);

    // LFO -> padFilter frequency
    const lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 0.08;

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 50;
    lfoOsc.connect(lfoGain);
    lfoGain.connect(padFilter.frequency);

    // Noise
    const noiseBuf = this.makeNoiseBufferSeeded(ctx, 3.0);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 950;
    noiseFilter.Q.value = 0.9;

    noiseSrc.connect(noiseGain);
    noiseGain.connect(noiseFilter);
    noiseFilter.connect(dryBus);

    // Pulse
    const pulseOsc = ctx.createOscillator();
    pulseOsc.type = 'triangle';

    const pulseEnv = ctx.createGain();
    pulseEnv.gain.value = 0;

    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0;

    pulseOsc.connect(pulseEnv);
    pulseEnv.connect(pulseGain);
    pulseGain.connect(dryBus);

    // Space (delay)
    const spaceSend = ctx.createGain();
    spaceSend.gain.value = 0;

    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.18;

    const delayFb = ctx.createGain();
    delayFb.gain.value = 0.25;

    const delayLP = ctx.createBiquadFilter();
    delayLP.type = 'lowpass';
    delayLP.frequency.value = 1400;
    delayLP.Q.value = 0.6;

    const spaceReturn = ctx.createGain();
    spaceReturn.gain.value = 0.0;

    dryBus.connect(spaceSend);
    spaceSend.connect(delay);
    delay.connect(delayLP);
    delayLP.connect(spaceReturn);
    spaceReturn.connect(master);

    delayLP.connect(delayFb);
    delayFb.connect(delay);

    // Reverb
    const verb = ctx.createConvolver();
    verb.buffer = this.makeImpulseResponse(ctx, 2.4, 0.55);

    const verbSend = ctx.createGain();
    verbSend.gain.value = 0;

    const verbReturn = ctx.createGain();
    verbReturn.gain.value = 0;

    dryBus.connect(verbSend);
    verbSend.connect(verb);
    verb.connect(verbReturn);
    verbReturn.connect(master);

    return {
      master,

      padOscA,
      padOscB,
      padOscC,
      padGain,
      padFilter,

      lfoOsc,
      lfoGain,

      noiseSrc,
      noiseGain,
      noiseFilter,

      pulseOsc,
      pulseGain,
      pulseEnv,

      dryBus,

      spaceSend,
      delay,
      delayFb,
      delayLP,
      spaceReturn,

      verb,
      verbSend,
      verbReturn,

      analyser,
    };
  }

  /* -------------------------
     Timbre
  ------------------------- */

  private refreshTimbreIfNeeded(tag: string): void {
    if (!this.ctx || !this.nodes) return;

    const key = `${tag}|seed:${this.seed}|motif:${this.currentMotif?.id}|style:${this.sectionStyle}`;
    if (key === this.lastTimbreKey) return;
    this.lastTimbreKey = key;

    this.nodes.verb.buffer = this.makeImpulseResponse(
      this.ctx,
      2.2 + this.randFloat() * 0.9,
      0.40 + this.randFloat() * 0.35
    );

    const noiseBuf = this.makeNoiseBufferSeeded(this.ctx, 2.4 + this.randFloat() * 1.3);

    try { this.nodes.noiseSrc.stop(); } catch {}

    const src = this.ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.connect(this.nodes.noiseGain);

    this.nodes.noiseSrc = src;

    if (this.started) {
      try { this.nodes.noiseSrc.start(); } catch {}
    }
  }

  private makeImpulseResponse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let localSeed = (this.seed ^ (ch ? 0x9e3779b9 : 0x7f4a7c15)) >>> 0;

      for (let i = 0; i < length; i++) {
        localSeed = (localSeed + 0x6D2B79F5) >>> 0;
        let t = localSeed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        const rnd = ((t ^ (t >>> 14)) >>> 0) / 4294967296;

        const env = Math.pow(1 - i / length, 2 + decay * 6);
        data[i] = (rnd * 2 - 1) * env * 0.35;
      }
    }
    return buffer;
  }

  private makeNoiseBufferSeeded(ctx: AudioContext, seconds: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);

    const baseSeed = this.seed ^ 0xA53A9D1B;
    let s = baseSeed >>> 0;

    let b0 = 0, b1 = 0, b2 = 0;

    for (let i = 0; i < length; i++) {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const white = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;

      b0 = 0.997 * b0 + 0.029 * white;
      b1 = 0.985 * b1 + 0.021 * white;
      b2 = 0.950 * b2 + 0.012 * white;

      const pinkish = (b0 + b1 + b2 + 0.15 * white) * 0.35;
      data[i] = this.clamp(pinkish, -0.6, 0.6);
    }

    return buffer;
  }

  private applyProfile(profile: AudioProfile, fadeIn: boolean): void {
    if (!this.ctx || !this.nodes) return;
    const t = this.ctx.currentTime;

    const base = this.getBaseParams(profile);
    const p = this.applyContextModifiers(base);
    const motif = this.currentMotif;

    this.refreshTimbreIfNeeded('APPLY_PROFILE');

    this.nodes.padOscA.type = motif.padWave;
    this.nodes.padOscB.type = motif.padWave;
    this.nodes.padOscC.type = motif.padWave;
    this.nodes.pulseOsc.type = motif.pulseWave;

    this.nodes.lfoOsc.frequency.setTargetAtTime(p.lfoHz, t, 0.25);
    this.nodes.lfoGain.gain.setTargetAtTime(p.lfoDepth, t, 0.25);

    const degree = motif.progression[this.stepIndex % motif.progression.length];
    const chord = this.buildChordHzStyled(p.rootHz, motif.scale, degree, this.sectionStyle);

    this.nodes.padOscA.frequency.setTargetAtTime(chord[0], t, 0.10);
    this.nodes.padOscB.frequency.setTargetAtTime(chord[1], t, 0.10);
    this.nodes.padOscC.frequency.setTargetAtTime(chord[2], t, 0.10);

    this.nodes.padOscB.detune.setTargetAtTime(p.detuneCents, t, 0.10);
    this.nodes.padOscC.detune.setTargetAtTime(-p.detuneCents, t, 0.10);

    this.nodes.padFilter.frequency.setTargetAtTime(p.padCutoff, t, 0.18);
    this.nodes.padFilter.Q.setTargetAtTime(p.padQ, t, 0.18);
    this.nodes.padGain.gain.setTargetAtTime(p.padAmp, t, 0.20);

    this.nodes.noiseFilter.frequency.setTargetAtTime(p.noiseHz, t, 0.20);
    this.nodes.noiseFilter.Q.setTargetAtTime(p.noiseQ, t, 0.20);
    this.nodes.noiseGain.gain.setTargetAtTime(p.noiseAmp, t, 0.20);

    this.nodes.pulseOsc.frequency.setTargetAtTime(p.pulseBaseHz, t, 0.10);
    this.nodes.pulseGain.gain.setTargetAtTime(p.pulseAmp, t, 0.20);

    this.nodes.spaceSend.gain.setTargetAtTime(p.spaceMix * 0.75, t, 0.22);
    this.nodes.spaceReturn.gain.setTargetAtTime(p.spaceMix * 0.45, t, 0.22);
    this.nodes.delay.delayTime.setTargetAtTime(p.delayTime, t, 0.22);
    this.nodes.delayFb.gain.setTargetAtTime(p.delayFb, t, 0.25);

    this.nodes.verbSend.gain.setTargetAtTime(p.verbMix * 0.85, t, 0.25);
    this.nodes.verbReturn.gain.setTargetAtTime(p.verbMix * 0.55, t, 0.25);

    if (fadeIn) {
      this.nodes.master.gain.cancelScheduledValues(t);
      this.nodes.master.gain.setValueAtTime(EPS, t);
      this.nodes.master.gain.setTargetAtTime(p.masterAmp, t + 0.02, 0.18);
    } else {
      this.nodes.master.gain.setTargetAtTime(p.masterAmp, t, 0.18);
    }
  }

  private getBaseParams(profile: AudioProfile): ProfileParams {
    switch (profile) {
      case 'productividad':
        return {
          masterAmp: 0.56,
          rootHz: 196,
          padAmp: 0.22,
          padCutoff: 980,
          padQ: 0.8,
          detuneCents: 8,
          noiseAmp: 0.028,
          noiseHz: 1500,
          noiseQ: 0.9,
          pulseAmp: 0.11,
          pulseBaseHz: 220,
          bpm: 96,
          lfoHz: 0.12,
          lfoDepth: 90,
          spaceMix: 0.22,
          delayTime: 0.17,
          delayFb: 0.24,
          verbMix: 0.18,
        };

      case 'seguridad':
        return {
          masterAmp: 0.52,
          rootHz: 110,
          padAmp: 0.24,
          padCutoff: 620,
          padQ: 0.95,
          detuneCents: 6,
          noiseAmp: 0.022,
          noiseHz: 980,
          noiseQ: 0.95,
          pulseAmp: 0.07,
          pulseBaseHz: 165,
          bpm: 72,
          lfoHz: 0.08,
          lfoDepth: 70,
          spaceMix: 0.18,
          delayTime: 0.20,
          delayFb: 0.22,
          verbMix: 0.22,
        };

      case 'estudio':
        return {
          masterAmp: 0.50,
          rootHz: 146.83,
          padAmp: 0.20,
          padCutoff: 780,
          padQ: 0.75,
          detuneCents: 7,
          noiseAmp: 0.024,
          noiseHz: 1120,
          noiseQ: 0.85,
          pulseAmp: 0.08,
          pulseBaseHz: 196,
          bpm: 84,
          lfoHz: 0.10,
          lfoDepth: 80,
          spaceMix: 0.20,
          delayTime: 0.18,
          delayFb: 0.23,
          verbMix: 0.20,
        };

      default:
        return {
          masterAmp: 0.48,
          rootHz: 174.61,
          padAmp: 0.26,
          padCutoff: 520,
          padQ: 0.70,
          detuneCents: 6,
          noiseAmp: 0.020,
          noiseHz: 820,
          noiseQ: 0.75,
          pulseAmp: 0.05,
          pulseBaseHz: 130.81,
          bpm: 60,
          lfoHz: 0.07,
          lfoDepth: 60,
          spaceMix: 0.28,
          delayTime: 0.22,
          delayFb: 0.26,
          verbMix: 0.32,
        };
    }
  }

  private applyContextModifiers(base: ProfileParams): ProfileParams {
    const h = this.hint;
    const e = this.learning.emotion;

    const onlineFactor = this.clamp((h.onlineNow ?? 0) / 12, 0, 1);
    const sseDown = h.sseAlive ? 0 : 1;
    const strict = (h.mode ?? 'NORMAL') !== 'NORMAL';

    const bias = this.learning.profileBias[this.profile] || { calm: 0, drive: 0 };
    const micro = this.microRandForStep(this.stepIndex);

    const ar = this.clamp(e.arousal, 0, 1);
    const va = this.clamp(e.valence, -1, 1);
    const tr = this.clamp(e.trust, 0, 1);

    const masterAmp = this.clamp(
      base.masterAmp
        + onlineFactor * 0.04
        - (strict ? 0.06 : 0)
        - sseDown * 0.02
        + micro * (0.012 * tr)
        + (va > 0 ? 0.01 : -0.005),
      0.12,
      0.75
    );

    const padCutoff = this.clamp(
      base.padCutoff
        + onlineFactor * 170
        - sseDown * 90
        + micro * (70 * tr)
        + ar * 120
        + bias.drive * 80
        - bias.calm * 90,
      220,
      1800
    );

    const padAmp = this.clamp(
      base.padAmp + (va > 0 ? 0.04 : -0.02) - ar * 0.03 + bias.calm * 0.03,
      0.10,
      0.36
    );

    const noiseAmp = this.clamp(
      base.noiseAmp
        + sseDown * 0.02
        + onlineFactor * 0.006
        - (strict ? 0.006 : 0)
        + Math.max(0, micro) * (0.004 * tr)
        + (va < 0 ? 0.010 : -0.006)
        + ar * 0.004,
      0,
      0.12
    );

    const pulseAmp = this.clamp(
      base.pulseAmp
        - (strict ? 0.04 : 0)
        - sseDown * 0.015
        + Math.max(0, micro) * (0.012 * tr)
        + ar * 0.035
        + bias.drive * 0.02
        - bias.calm * 0.02,
      0,
      0.16
    );

    const motif = this.currentMotif || this.getMotifPool(this.profile)[0];
    const bpmTarget = this.clamp(
      base.bpm
        - (strict ? 10 : 0)
        - sseDown * 6
        + onlineFactor * 4
        + Math.round(micro * (6 * tr))
        + Math.round(ar * 10)
        + Math.round(bias.drive * 6)
        - Math.round(bias.calm * 6),
      motif.bpmMin,
      motif.bpmMax
    );

    const lfoHz = this.clamp(base.lfoHz + micro * (0.035 * tr) + ar * 0.03, 0.05, 0.22);
    const lfoDepth = this.clamp(base.lfoDepth + micro * (40 * tr) + onlineFactor * 12 + ar * 18, 30, 150);
    const detuneCents = this.clamp(base.detuneCents + micro * (4 * tr) + (va > 0 ? 1 : 0), 3, 16);

    const spaceMix = this.clamp(base.spaceMix + (va > 0 ? 0.10 : -0.05) - ar * 0.12, 0, 0.55);
    const delayTime = this.clamp(base.delayTime + micro * 0.03 + (va > 0 ? 0.02 : 0), 0.10, 0.38);
    const delayFb = this.clamp(base.delayFb + (va > 0 ? 0.06 : -0.03) - (strict ? 0.05 : 0), 0.05, 0.65);

    const calmBoost = this.clamp(0.25 + (1 - ar) * 0.35 + (va > 0 ? 0.10 : 0), 0, 0.60);
    const verbMix = this.clamp(base.verbMix + calmBoost * 0.25 - (strict ? 0.10 : 0) + (sseDown ? -0.08 : 0), 0, 0.65);

    let rootHz = base.rootHz;
    if (this.sectionStyle === 'DRIFT') {
      const driftSemis = this.microRandForStep(this.stepIndex + 999) * 0.18;
      rootHz = base.rootHz * Math.pow(2, driftSemis / 12);
    }

    return {
      ...base,
      masterAmp,
      rootHz,
      padAmp,
      padCutoff,
      noiseAmp,
      pulseAmp,
      bpm: Math.round(bpmTarget),
      lfoHz,
      lfoDepth,
      detuneCents,
      spaceMix,
      delayTime,
      delayFb,
      verbMix,
    };
  }

  /* -------------------------
     Scheduler
  ------------------------- */

  private restartScheduler(resetStep = false): void {
    if (!this.ctx || !this.nodes || !this.started) return;

    this.stopScheduler();
    if (resetStep) this.stepIndex = 0;

    this.nextStepTime = this.ctx.currentTime + 0.08;
    this.schedulerTimer = window.setInterval(() => this.schedulerTick(), 50);
  }

  private stopScheduler(): void {
    if (this.schedulerTimer) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
  }

  private schedulerTick(): void {
    if (!this.ctx || !this.nodes) return;

    const p = this.applyContextModifiers(this.getBaseParams(this.profile));
    const motif = this.currentMotif;
    if (p.pulseAmp <= 0.001) return;

    const stepDur = 60 / Math.max(1, p.bpm);
    const lookAhead = 0.18;

    const sectionSteps = this.sectionLenBars * 4;

    while (this.nextStepTime < this.ctx.currentTime + lookAhead) {
      const stepInBar = this.stepIndex % 4;
      const barIndex = Math.floor(this.stepIndex / 4);

      if (stepInBar === 0 && barIndex > 0 && (barIndex % this.sectionLenBars === 0)) {
        this.sectionStyle = this.pickSectionStyle();
        this.patternRotate = (this.patternRotate + 1 + Math.floor(this.randFloat() * 3)) % 8;
        this.resetSections(false);
      }

      // ✅ human time (acorde) + swing leve
      const chordTime = this.humanizeTime(this.nextStepTime, stepInBar, stepDur, this.chordHuman);
      if (stepInBar === 0) this.applyChordAtTime(chordTime);

      const patIndex = (this.stepIndex + this.patternRotate) % motif.pulsePattern.length;
      const pat = motif.pulsePattern[patIndex];

      const isBar16 = (this.stepIndex % 16 === 15);
      const doFill = isBar16 && this.randFloat() < this.fillChance;

      // ✅ micro break para respirar (evita loop evidente)
      const doBreak = (stepInBar === 0) && (this.randFloat() < this.breakChance) && !doFill;

      if (!doBreak) {
        if (pat !== 0) {
          const accent = pat === 2 || (doFill && this.randFloat() < 0.65);
          const pulseTime = this.humanizeTime(this.nextStepTime, stepInBar, stepDur, this.humanMs);
          this.triggerPulseAtTime(pulseTime, p.pulseAmp, accent, p.pulseBaseHz, doFill);
        } else {
          if (this.randFloat() < 0.06) {
            const whooshTime = this.humanizeTime(this.nextStepTime, stepInBar, stepDur, this.humanMs);
            this.microWhooshAtTime(whooshTime, p.noiseAmp);
          }
        }
      } else {
        // break suave (bajón de ruido)
        if (this.randFloat() < 0.30) this.microWhooshAtTime(this.nextStepTime, p.noiseAmp * 0.55);
      }

      const sparkleChance =
        (this.profile === 'bienestar' ? 0.10 : this.profile === 'estudio' ? 0.07 : 0.05)
        * this.clamp(0.7 + (1 - this.learning.emotion.arousal), 0.6, 1.2);

      if (this.randFloat() < sparkleChance) {
        const spTime = this.humanizeTime(this.nextStepTime + stepDur * 0.15, stepInBar, stepDur, this.humanMs);
        this.sparkleAtTime(spTime, p, motif);
      }

      if (this.leadEnabled && this.leadSteps.length) {
        const posInSection = ((this.stepIndex % sectionSteps) + sectionSteps) % sectionSteps;
        for (const ev of this.leadSteps) {
          if (ev.step === posInSection) {
            const lt = this.humanizeTime(this.nextStepTime, stepInBar, stepDur, this.humanMs);
            this.triggerLeadAtTime_MelodyEngine(lt, p, motif, ev.durSteps, ev.vel);
          }
        }
      }

      this.stepIndex++;
      this.nextStepTime += stepDur;
    }
  }

  private applyChordAtTime(time: number): void {
    if (!this.ctx || !this.nodes) return;

    const p = this.applyContextModifiers(this.getBaseParams(this.profile));
    const motif = this.currentMotif;

    const progIndex = Math.floor(this.stepIndex / 4) % motif.progression.length;
    let degree = motif.progression[progIndex];

    const barIndex = Math.floor(this.stepIndex / 4);
    const inSection = barIndex % this.sectionLenBars;

    if (inSection !== 0 && inSection === (this.sectionLenBars - 2)) {
      if (this.randFloat() < 0.35) degree = (degree + 1) % motif.scale.length;
    }

    // ✅ pequeña variación: a veces “suspende” el grado (evita loop idéntico)
    if (inSection === (this.sectionLenBars - 1) && this.randFloat() < 0.22) {
      degree = (degree + (this.randFloat() < 0.5 ? 2 : 4)) % motif.scale.length;
    }

    const chord = this.buildChordHzStyled(p.rootHz, motif.scale, degree, this.sectionStyle);
    const det = p.detuneCents;

    this.nodes.padOscA.frequency.setTargetAtTime(chord[0], time, 0.12);
    this.nodes.padOscB.frequency.setTargetAtTime(chord[1], time, 0.12);
    this.nodes.padOscC.frequency.setTargetAtTime(chord[2], time, 0.12);

    this.nodes.padOscB.detune.setTargetAtTime(det, time, 0.12);
    this.nodes.padOscC.detune.setTargetAtTime(-det, time, 0.12);
  }

  private triggerPulseAtTime(time: number, pulseAmp: number, accent: boolean, baseHz: number, fill: boolean): void {
    if (!this.ctx || !this.nodes) return;

    const env = this.nodes.pulseEnv.gain;
    const fillBoost = fill ? 1.16 : 1.0;

    const hz =
      baseHz
      * (accent ? 1.08 : 1.0)
      * fillBoost
      * (1 + (this.microRandForStep(this.stepIndex + 333) * 0.02));

    this.nodes.pulseOsc.frequency.setTargetAtTime(hz, time, 0.02);

    // ✅ human velocity: volumen no fijo (anti robot)
    const velHuman = 1 + (this.microRandForStep(this.stepIndex + 1234) * this.pulseHuman);
    const peak = this.clamp((accent ? 1.15 : 1.0) * (0.9 + this.randFloat() * 0.2) * velHuman, 0.55, 1.45);

    env.cancelScheduledValues(time);
    env.setValueAtTime(EPS, time);

    const attack = 0.010 + this.randFloat() * 0.010;
    const rel = (accent ? 0.22 : 0.18) * (0.92 + this.randFloat() * 0.20);

    env.linearRampToValueAtTime(peak, time + attack);
    env.exponentialRampToValueAtTime(EPS, time + rel);

    this.nodes.pulseGain.gain.setTargetAtTime(pulseAmp, time, 0.08);
  }

  private microWhooshAtTime(time: number, noiseAmp: number): void {
    if (!this.ctx || !this.nodes) return;

    const g = this.nodes.noiseGain.gain;
    const up = this.clamp(noiseAmp * (1.45 + this.randFloat() * 0.35), 0, 0.14);

    g.cancelScheduledValues(time);
    g.setValueAtTime(this.nodes.noiseGain.gain.value || EPS, time);
    g.linearRampToValueAtTime(up, time + (0.02 + this.randFloat() * 0.03));
    g.exponentialRampToValueAtTime(Math.max(EPS, noiseAmp), time + (0.18 + this.randFloat() * 0.14));
  }

  private sparkleAtTime(time: number, p: ProfileParams, motif: Motif): void {
    if (!this.ctx || !this.nodes) return;

    const progIndex = Math.floor(this.stepIndex / 4) % motif.progression.length;
    const degree = motif.progression[progIndex];

    const chord = this.buildChordHzStyled(p.rootHz, motif.scale, degree, this.sectionStyle);
    const pick = Math.floor(this.randFloat() * 3);
    const base = chord[pick] * 2;

    const n = (this.randFloat() < 0.65) ? 2 : 3;
    const interval = [1.0, 1.12246, 1.25992, 1.33484];
    const step = 0.07 + this.randFloat() * 0.06;

    for (let i = 0; i < n; i++) {
      const hz = base * interval[(i + Math.floor(this.randFloat() * interval.length)) % interval.length];

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';

      const g = this.ctx.createGain();
      g.gain.value = EPS;

      osc.connect(g);
      g.connect(this.nodes.dryBus);

      const t0 = time + i * step;
      osc.frequency.setValueAtTime(hz, t0);

      const peak = this.clamp(0.010 + (1 - p.pulseAmp) * 0.02 + this.randFloat() * 0.008, 0.010, 0.040);
      g.gain.setValueAtTime(EPS, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(EPS, t0 + (0.16 + this.randFloat() * 0.08));

      try { osc.start(t0); osc.stop(t0 + 0.22); } catch {}
    }
  }

  private buildLeadPattern(sectionSteps: number, hard: boolean): LeadStep[] {
    const events: LeadStep[] = [];

    const e = this.learning.emotion;
    const calm = this.clamp(1 - e.arousal, 0, 1);
    const stress = this.clamp(this.hint.stressScore ?? 0.3, 0, 1);

    const density = this.clamp(
      (0.10 + (hard ? 0.06 : 0.03) + (1 - calm) * 0.04) * (1 - stress * 0.45),
      0.08,
      0.22
    );

    const maxEvents = Math.max(3, Math.floor(sectionSteps * density));
    const used = new Set<number>();

    const beatSlots = [0, 1, 2, 3, 0, 2, 1];

    for (let i = 0; i < maxEvents; i++) {
      const bar = Math.floor(this.randFloat() * this.sectionLenBars);

      const half = Math.floor(this.sectionLenBars / 2);
      const phaseBias = (bar >= half) ? 1.15 : 0.85;
      if (this.randFloat() > phaseBias) continue;

      const slot = beatSlots[Math.floor(this.randFloat() * beatSlots.length)] ?? 0;

      const step = (bar * 4 + slot) % sectionSteps;
      if (used.has(step)) continue;
      used.add(step);

      // ✅ fraseo: más notas cortas, algunas más largas
      const durSteps = (this.randFloat() < 0.58) ? 1 : (this.randFloat() < 0.90 ? 2 : 3);
      const vel = this.clamp(0.52 + this.randFloat() * 0.48, 0.52, 1.0);

      events.push({ step, durSteps, vel });
    }

    events.sort((a, b) => a.step - b.step);
    return events;
  }

  private triggerLeadAtTime_MelodyEngine(time: number, p: ProfileParams, motif: Motif, durSteps: number, vel: number): void {
    if (!this.ctx || !this.nodes) return;

    const strict = (this.hint.mode ?? 'NORMAL') !== 'NORMAL';
    const stress = this.clamp(this.hint.stressScore ?? 0.3, 0, 1);
    const calm = this.clamp(1 - this.learning.emotion.arousal, 0, 1);

    const amp = this.clamp(
      this.leadAmpMax * (0.60 + calm * 0.55) * (1 - stress * 0.60) * (strict ? 0.55 : 1.0) * vel,
      0.006,
      this.leadAmpMax
    );

    const progIndex = Math.floor(this.stepIndex / 4) % motif.progression.length;
    const degree = motif.progression[progIndex];

    const triadMidi = buildTriadMidi(p.rootHz, motif.scale, degree);

    // ✅ evita “robot”: preferir repetir una nota cercana antes de saltar
    const nextMidi = this.melody.pickNext(triadMidi, () => this.randFloat());

    // ✅ micro detune en Hz para organicidad
    const hz = midiToHz(nextMidi) * (1 + (this.microRandForStep(this.stepIndex + 777) * 0.010));

    const osc = this.ctx.createOscillator();
    osc.type = (this.randFloat() < 0.72) ? 'sine' : 'triangle';

    const g = this.ctx.createGain();
    g.gain.value = EPS;

    osc.connect(g);
    g.connect(this.nodes.dryBus);

    const stepDur = 60 / Math.max(1, p.bpm);
    const dur = stepDur * this.clamp(durSteps, 1, 3);

    osc.frequency.setValueAtTime(hz, time);

    const attack = 0.010 + this.randFloat() * 0.018;
    const decay = this.clamp(dur * (0.65 + this.randFloat() * 0.30), 0.12, 0.60);

    // ✅ vibrato leve (muy humano) usando detune del osc
    const vib = (this.randFloat() < 0.65) ? (5 + this.randFloat() * 10) : 0;
    if (vib > 0) {
      osc.detune.setValueAtTime(0, time);
      osc.detune.linearRampToValueAtTime(vib, time + decay * 0.35);
      osc.detune.linearRampToValueAtTime(0, time + decay);
    }

    g.gain.setValueAtTime(EPS, time);
    g.gain.linearRampToValueAtTime(amp, time + attack);
    g.gain.exponentialRampToValueAtTime(EPS, time + decay);

    try { osc.start(time); osc.stop(time + decay + 0.05); } catch {}
  }

  /* -------------------------
     Motifs
  ------------------------- */

  private getMotifPool(profile: AudioProfile): Motif[] {
    const seguridad: Motif[] = [
      { id: 'sec_minor_anchor', scale: [0, 2, 3, 5, 7, 8, 10], progression: [0, 5, 3, 4], pulsePattern: [2, 0, 1, 0, 1, 0, 1, 0], bpmMin: 64, bpmMax: 78, padWave: 'sawtooth', pulseWave: 'triangle' },
      { id: 'sec_phrygian_tension', scale: [0, 1, 3, 5, 7, 8, 10], progression: [0, 1, 4, 0], pulsePattern: [2, 0, 0, 1, 0, 1, 0, 1], bpmMin: 60, bpmMax: 74, padWave: 'square', pulseWave: 'sine' },
      { id: 'sec_dorian_resolve', scale: [0, 2, 3, 5, 7, 9, 10], progression: [0, 3, 4, 0], pulsePattern: [2, 0, 1, 0, 0, 1, 0, 1], bpmMin: 62, bpmMax: 78, padWave: 'triangle', pulseWave: 'triangle' },
      { id: 'sec_minor_hush', scale: [0, 2, 3, 5, 7, 8, 10], progression: [0, 4, 5, 3], pulsePattern: [1, 0, 0, 1, 0, 1, 0, 0], bpmMin: 60, bpmMax: 76, padWave: 'triangle', pulseWave: 'sine' },
    ];

    const estudio: Motif[] = [
      { id: 'stu_major_clean', scale: [0, 2, 4, 5, 7, 9, 11], progression: [0, 3, 4, 1], pulsePattern: [1, 0, 1, 0, 1, 0, 0, 1], bpmMin: 76, bpmMax: 92, padWave: 'sine', pulseWave: 'triangle' },
      { id: 'stu_dorian_flow', scale: [0, 2, 3, 5, 7, 9, 10], progression: [0, 4, 5, 3], pulsePattern: [1, 0, 1, 0, 2, 0, 1, 0], bpmMin: 72, bpmMax: 88, padWave: 'triangle', pulseWave: 'sine' },
      { id: 'stu_penta_focus', scale: [0, 2, 4, 7, 9], progression: [0, 2, 3, 1], pulsePattern: [1, 0, 0, 1, 0, 1, 0, 0], bpmMin: 74, bpmMax: 90, padWave: 'triangle', pulseWave: 'triangle' },
      { id: 'stu_lydian_air', scale: [0, 2, 4, 6, 7, 9, 11], progression: [0, 4, 1, 5], pulsePattern: [1, 0, 0, 0, 1, 0, 1, 0], bpmMin: 70, bpmMax: 86, padWave: 'sine', pulseWave: 'sine' },
    ];

    const productividad: Motif[] = [
      { id: 'pro_penta_drive', scale: [0, 2, 4, 7, 9], progression: [0, 2, 1, 3], pulsePattern: [2, 0, 1, 1, 0, 1, 0, 1], bpmMin: 88, bpmMax: 108, padWave: 'triangle', pulseWave: 'square' },
      { id: 'pro_minor_push', scale: [0, 3, 5, 7, 10], progression: [0, 1, 3, 2], pulsePattern: [2, 1, 0, 1, 0, 1, 1, 0], bpmMin: 90, bpmMax: 112, padWave: 'sawtooth', pulseWave: 'triangle' },
      { id: 'pro_dorian_grid', scale: [0, 2, 3, 5, 7, 9, 10], progression: [0, 5, 3, 4], pulsePattern: [2, 0, 1, 0, 2, 0, 1, 0], bpmMin: 86, bpmMax: 106, padWave: 'square', pulseWave: 'square' },
      { id: 'pro_major_snap', scale: [0, 2, 4, 5, 7, 9, 11], progression: [0, 4, 5, 3], pulsePattern: [2, 0, 1, 0, 1, 1, 0, 1], bpmMin: 90, bpmMax: 110, padWave: 'triangle', pulseWave: 'triangle' },
    ];

    const bienestar: Motif[] = [
      { id: 'wel_major_breath', scale: [0, 2, 4, 5, 7, 9, 11], progression: [0, 5, 3, 4], pulsePattern: [1, 0, 0, 0, 1, 0, 0, 0], bpmMin: 54, bpmMax: 68, padWave: 'sine', pulseWave: 'sine' },
      { id: 'wel_dorian_soft', scale: [0, 2, 3, 5, 7, 9, 10], progression: [0, 3, 0, 4], pulsePattern: [1, 0, 0, 1, 0, 0, 1, 0], bpmMin: 56, bpmMax: 72, padWave: 'triangle', pulseWave: 'sine' },
      { id: 'wel_penta_sleep', scale: [0, 2, 4, 7, 9], progression: [0, 3, 1, 2], pulsePattern: [1, 0, 0, 0, 0, 0, 1, 0], bpmMin: 52, bpmMax: 66, padWave: 'sine', pulseWave: 'triangle' },
      { id: 'wel_major_warm', scale: [0, 2, 4, 5, 7, 9, 11], progression: [0, 4, 1, 5], pulsePattern: [1, 0, 0, 0, 1, 0, 1, 0], bpmMin: 52, bpmMax: 70, padWave: 'triangle', pulseWave: 'sine' },
      { id: 'wel_mixolydian_glow', scale: [0, 2, 4, 5, 7, 9, 10], progression: [0, 5, 4, 0], pulsePattern: [1, 0, 0, 1, 0, 0, 0, 0], bpmMin: 54, bpmMax: 68, padWave: 'sine', pulseWave: 'sine' },
    ];

    switch (profile) {
      case 'seguridad': return seguridad;
      case 'estudio': return estudio;
      case 'productividad': return productividad;
      default: return bienestar;
    }
  }

  // ✅ MODIFICADO: anti repetición + cooldown + “spice”
  private pickMotifLearned(profile: AudioProfile, opts?: { gentle?: boolean; exploreBoost?: number }): Motif {
    const pool = this.getMotifPool(profile);
    const b = this.learning.bandit[profile] || (this.learning.bandit[profile] = {});
    const now = Date.now();

    this.learning.lastMotifByProfile = this.learning.lastMotifByProfile || {};
    this.learning.motifCooldown = this.learning.motifCooldown || {};
    const lastMotif = this.learning.lastMotifByProfile[profile];
    const cd = this.learning.motifCooldown;

    const total = Math.max(1, pool.reduce((acc, m) => acc + (b[m.id]?.n || 0), 0));
    const explore = this.clamp((opts?.exploreBoost ?? 0) + (opts?.gentle ? 0.06 : 0.12), 0.04, 0.35);
    const cooldownMs = (opts?.gentle ? 4 : 7) * 60 * 1000;

    let best: Motif = pool[0];
    let bestScore = -Infinity;

    for (const m of pool) {
      // no repetir seguido
      if (m.id === lastMotif && pool.length > 1) continue;

      // cooldown
      const lastUsed = cd[m.id] || 0;
      const inCooldown = (now - lastUsed) < cooldownMs;
      if (inCooldown && pool.length > 2) continue;

      const st = b[m.id] || { n: 0, r: 0, last: 0 };
      const mean = st.n > 0 ? (st.r / st.n) : 0;
      const ucb = explore * Math.sqrt(Math.log(total + 1) / (st.n + 1));

      const rec = st.last ? Math.min(1, (now - st.last) / (10 * 60 * 1000)) : 1;
      const recBonus = (opts?.gentle ? 0.05 : 0.10) * rec;

      const spice = (this.randFloat() - 0.5) * (opts?.gentle ? 0.02 : 0.05);

      const score = mean + ucb + recBonus + spice;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }

    b[best.id] = b[best.id] || { n: 0, r: 0, last: 0 };
    b[best.id].n += 1;
    b[best.id].last = now;

    this.learning.lastMotifByProfile[profile] = best.id;
    this.learning.motifCooldown[best.id] = now;

    return best;
  }

  private rewardMotif(reward: number): void {
    const p = this.profile;
    const m = this.currentMotif;
    if (!m) return;

    const b = this.learning.bandit[p] || (this.learning.bandit[p] = {});
    const st = b[m.id] || (b[m.id] = { n: 1, r: 0, last: Date.now() });

    const r = this.clamp(reward, -0.5, 0.5);
    st.r += r;

    const bias = this.learning.profileBias[p] || (this.learning.profileBias[p] = { calm: 0, drive: 0 });
    if (r > 0) {
      bias.drive = this.clamp(bias.drive + 0.01, -0.35, 0.35);
      bias.calm = this.clamp(bias.calm + 0.006, -0.35, 0.35);
    } else {
      bias.drive = this.clamp(bias.drive - 0.012, -0.35, 0.35);
    }
    this.learning.profileBias[p] = bias;
  }

  private updateEmotionFromContext(): void {
    const h = this.hint;
    const e = this.learning.emotion;

    const online = this.clamp((h.onlineNow ?? 0) / 12, 0, 1);
    const strict = (h.mode ?? 'NORMAL') !== 'NORMAL';
    const sseDown = h.sseAlive ? 0 : 1;

    const focus = this.clamp(h.focusScore ?? 0.5, 0, 1);
    const stress = this.clamp(h.stressScore ?? 0.3, 0, 1);

    const targetArousal = this.clamp(0.25 + stress * 0.55 + online * 0.20 + (strict ? 0.10 : 0) + sseDown * 0.12, 0, 1);
    const targetValence = this.clamp(0.20 + focus * 0.45 - stress * 0.55 - (strict ? 0.15 : 0) - sseDown * 0.10, -1, 1);
    const targetTrust = this.clamp(0.55 + (h.sseAlive ? 0.10 : -0.15) + (strict ? -0.10 : 0) + focus * 0.10, 0, 1);

    this.learning.emotion = {
      arousal: this.lerp(e.arousal, targetArousal, 0.18),
      valence: this.lerp(e.valence, targetValence, 0.16),
      trust: this.lerp(e.trust, targetTrust, 0.12),
    };
  }

  private bumpEmotion(delta: Partial<EmotionState>): void {
    const e = this.learning.emotion;
    this.learning.emotion = {
      valence: this.clamp(e.valence + (delta.valence ?? 0), -1, 1),
      arousal: this.clamp(e.arousal + (delta.arousal ?? 0), 0, 1),
      trust: this.clamp(e.trust + (delta.trust ?? 0), 0, 1),
    };
  }

  private buildChordHz(rootHz: number, scale: number[], degree: number): [number, number, number] {
    const deg = ((degree % scale.length) + scale.length) % scale.length;

    const i0 = deg;
    const i1 = (deg + 2) % scale.length;
    const i2 = (deg + 4) % scale.length;

    const s0 = scale[i0];
    let s1 = scale[i1];
    let s2 = scale[i2];

    while (s1 < s0) s1 += 12;
    while (s2 < s1) s2 += 12;

    return [this.semitoneToHz(rootHz, s0), this.semitoneToHz(rootHz, s1), this.semitoneToHz(rootHz, s2)];
  }

  private buildChordHzStyled(rootHz: number, scale: number[], degree: number, style: SectionStyle): [number, number, number] {
    let [a, b, c] = this.buildChordHz(rootHz, scale, degree);

    switch (style) {
      case 'INVERT':
        if (this.randFloat() < 0.5) a *= 2; else b *= 2;
        break;
      case 'ADD7': {
        const seventh = a * Math.pow(2, 10 / 12);
        c = (this.randFloat() < 0.5) ? seventh : (seventh * 2);
        break;
      }
      case 'SUS2':
        b = a * Math.pow(2, 2 / 12);
        break;
      case 'SUS4':
        b = a * Math.pow(2, 5 / 12);
        break;
      case 'OCT_UP':
        a *= 2; b *= 2; c *= 2;
        break;
      case 'OCT_DN':
        a *= 0.5; b *= 0.5; c *= 0.5;
        break;
      default:
        break;
    }

    return [a, b, c].sort((x, y) => x - y) as [number, number, number];
  }

  private semitoneToHz(rootHz: number, semitone: number): number {
    return rootHz * Math.pow(2, semitone / 12);
  }

  private genEuclid(steps: number, pulses: number): Array<0 | 1> {
    const out: Array<0 | 1> = [];
    let bucket = 0;
    for (let i = 0; i < steps; i++) {
      bucket += pulses;
      if (bucket >= steps) { bucket -= steps; out.push(1); }
      else out.push(0);
    }
    return out;
  }

  private buildPulsePatternForSection(profile: AudioProfile): Array<0 | 1 | 2> {
    const e = this.learning.emotion;
    const strict = (this.hint.mode ?? 'NORMAL') !== 'NORMAL';
    const sseDown = this.hint.sseAlive ? 0 : 1;

    const ar = this.clamp(e.arousal, 0, 1);

    const densityBase =
      profile === 'productividad' ? 0.55 :
      profile === 'estudio' ? 0.45 :
      profile === 'seguridad' ? 0.40 : 0.30;

    const density = this.clamp(densityBase + ar * 0.20 - (strict ? 0.18 : 0) - sseDown * 0.12, 0.18, 0.75);

    const steps = 16;
    const pulses = Math.max(2, Math.floor(steps * density));
    const base = this.genEuclid(steps, pulses);

    const out: Array<0 | 1 | 2> = base.map(v => (v ? 1 : 0)) as Array<0 | 1 | 2>;

    for (let i = 0; i < out.length; i += 4) {
      if (out[i] !== 0) out[i] = 2;
    }

    // ✅ variación: rota y “rompe” un poco el patrón para que no sea loop perfecto
    const rot = (Math.floor(this.randFloat() * out.length)) % out.length;
    const rotated = out.map((_, i) => out[(i + rot) % out.length]) as Array<0 | 1 | 2>;

    if (this.randFloat() < 0.55) {
      const k = (Math.floor(this.randFloat() * rotated.length) + 1) % rotated.length;
      if (rotated[k] !== 0) rotated[k] = 2;
    }

    if (this.randFloat() < 0.22) {
      const drop = Math.floor(this.randFloat() * rotated.length);
      if (rotated[drop] !== 2) rotated[drop] = 0; // drop suave
    }

    return rotated;
  }

  private setDailyAnchorSeed(profile: AudioProfile): void {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    const hourBlock = Math.floor(d.getHours() / 4);
    const dayKey = `${y}-${m}-${day}|H${hourBlock}`;
    this.setSeedFromString(`DAY|${dayKey}|${profile}|${this.motifKey}`);

    this.refreshTimbreIfNeeded('ANCHOR');
  }

  private loadLearning(): LearningState {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return this.defaultLearning();

      const obj = JSON.parse(raw) as LearningState;
      if (!obj || obj.version !== 2) return this.defaultLearning();

      for (const p of ['seguridad', 'estudio', 'productividad', 'bienestar'] as AudioProfile[]) {
        obj.bandit[p] = obj.bandit[p] || {};
        obj.profileBias[p] = obj.profileBias[p] || { calm: 0, drive: 0 };
      }

      obj.emotion = obj.emotion || { valence: 0.2, arousal: 0.25, trust: 0.6 };

      // ✅ anti repetición
      obj.lastMotifByProfile = obj.lastMotifByProfile || {};
      obj.motifCooldown = obj.motifCooldown || {};

      return obj;
    } catch {
      return this.defaultLearning();
    }
  }

  private saveLearning(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.learning)); } catch {}
  }

  private defaultLearning(): LearningState {
    return {
      version: 2,
      bandit: { seguridad: {}, estudio: {}, productividad: {}, bienestar: {} },
      profileBias: {
        seguridad: { calm: 0, drive: 0 },
        estudio: { calm: 0, drive: 0 },
        productividad: { calm: 0, drive: 0 },
        bienestar: { calm: 0, drive: 0 },
      },
      emotion: { valence: 0.2, arousal: 0.25, trust: 0.6 },
      lastTipId: undefined,
      lastProfile: undefined,

      // ✅ anti repetición
      lastMotifByProfile: {},
      motifCooldown: {},
    };
  }

  private setSeedFromString(s: string): void {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    this.seed = (h >>> 0) || 123456789;
  }

  private randFloat(): number {
    let t = (this.seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private microRandForStep(stepIndex: number): number {
    let x = (stepIndex + 1) * 2654435761;
    x ^= x >>> 16;
    x = Math.imul(x, 2246822507);
    x ^= x >>> 13;
    x = Math.imul(x, 3266489909);
    x ^= x >>> 16;
    return ((x >>> 0) / 4294967296) - 0.5;
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * this.clamp(t, 0, 1);
  }

  // ✅ NUEVO: swing + micro timing
  private humanizeTime(baseTime: number, stepInBar: number, stepDur: number, humanMaxSec: number): number {
    const offbeat = (stepInBar % 2) === 1;
    const swingShift = offbeat ? (stepDur * this.swing * 0.50) : 0;

    const jitter = this.microRandForStep(this.stepIndex + 9999) * humanMaxSec; // +/- humanMaxSec/2 aprox
    const t = baseTime + swingShift + jitter;

    // evita ir “al pasado”
    if (!this.ctx) return t;
    return Math.max(this.ctx.currentTime + 0.001, t);
  }
}
