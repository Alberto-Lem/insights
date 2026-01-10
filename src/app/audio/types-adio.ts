// src/app/audio/types-audio.ts

export type AudioProfile = 'seguridad' | 'estudio' | 'productividad' | 'bienestar';

export type SectionStyle =
  | 'BASE'
  | 'INVERT'
  | 'ADD7'
  | 'SUS2'
  | 'SUS4'
  | 'OCT_UP'
  | 'OCT_DN'
  | 'DRIFT';

export type EngineMode = 'NORMAL' | 'LIMITED' | 'STRICT';

export type StepEvent =
  | { kind: 'CHORD'; time: number; degree: number; style: SectionStyle }
  | { kind: 'PULSE'; time: number; accent: boolean; fill: boolean; hz?: number }
  | { kind: 'WHOOSH'; time: number; intensity?: number }
  | { kind: 'LEAD'; time: number; hz: number; dur: number; amp: number }
  // ✅ opcionales para “música real”
  | { kind: 'ARP'; time: number; notesHz: number[]; step: number; amp: number; dur: number }
  | { kind: 'BASS'; time: number; hz: number; dur: number; amp: number }
  | { kind: 'SWELL'; time: number; dur: number; amp: number };

export type EngineParams = {
  profile: AudioProfile;
  mode: EngineMode;

  bpm: number;
  rootHz: number;

  // pad
  padAmp: number;
  padCutoff: number;
  padQ: number;
  detuneCents: number;

  // noise
  noiseAmp: number;
  noiseHz: number;
  noiseQ: number;

  // pulse
  pulseAmp: number;
  pulseBaseHz: number;

  // fx
  spaceMix: number;
  delayTime: number;
  delayFb: number;
  verbMix: number;
};

export type EngineState = {
  stepIndex: number;         // contador global de steps
  barIndex: number;          // stepIndex/4
  sectionLenBars: number;    // por ejemplo 8
  sectionStyle: SectionStyle;
  patternRotate: number;     // rotación del pulso
  energy: number;            // 0..1 (para densidad y “vida”)
};
