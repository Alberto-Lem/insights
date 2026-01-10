// src/app/audio/step-sequencer-engine.ts

import { MelodyEngine } from './melody-engine';
import { buildTriadMidi, midiToHz } from './music-theory';
import { EngineParams, EngineState, SectionStyle, StepEvent } from './types-adio';

type Motif = {
  id: string;
  scale: number[];
  progression: number[];
  pulsePattern: Array<0 | 1 | 2>;
};

export class StepSequencerEngine {
  private melody = new MelodyEngine();

  reset(seedLike: number): void {
    this.melody.reset(seedLike);
  }

  /** Genera eventos para un step (y acorde al inicio de compás). */
  nextStep(
    params: EngineParams,
    state: EngineState,
    motif: Motif,
    rand: () => number,
    time: number
  ): StepEvent[] {
    const ev: StepEvent[] = [];

    const stepInBar = state.stepIndex % 4;
    const barIndex = Math.floor(state.stepIndex / 4);
    state.barIndex = barIndex;

    // Nueva sección cada N compases
    if (stepInBar === 0 && barIndex > 0 && (barIndex % state.sectionLenBars === 0)) {
      state.sectionStyle = this.pickSectionStyle(rand, params, state);
      state.patternRotate = (state.patternRotate + 1 + Math.floor(rand() * 3)) % 8;

      // resetea “memoria melódica” al cambiar sección (clave para no sonar igual)
      this.melody.reset((barIndex + Math.floor(params.rootHz)) | 0);
    }

    // CHORD al inicio de cada compás
    const progIndex = barIndex % Math.max(1, motif.progression.length);
    const degree = motif.progression[progIndex] ?? 0;

    if (stepInBar === 0) {
      ev.push({ kind: 'CHORD', time, degree, style: state.sectionStyle });
    }

    // PULSE según patrón (con rotación para evitar loop)
    const patIndex = (state.stepIndex + state.patternRotate) % motif.pulsePattern.length;
    const pat = motif.pulsePattern[patIndex];

    const isBar16 = (state.stepIndex % 16 === 15);
    const doFill = isBar16 && rand() < (0.45 + state.energy * 0.20);
    const accent = (pat === 2) || (doFill && rand() < 0.65);

    if (pat !== 0 && params.pulseAmp > 0.001) {
      const hz = params.pulseBaseHz * (accent ? 1.08 : 1.0) * (1 + (rand() - 0.5) * 0.02);
      ev.push({ kind: 'PULSE', time, accent, fill: doFill, hz });
    } else {
      if (rand() < (0.05 + state.energy * 0.02) && params.noiseAmp > 0.001) {
        ev.push({ kind: 'WHOOSH', time, intensity: 0.8 + rand() * 0.6 });
      }
    }

    // LEAD: melodía coherente con el acorde (usa MIDI entero)
    const leadChance =
      (params.profile === 'bienestar' ? 0.10 : params.profile === 'estudio' ? 0.08 : 0.07) *
      (0.65 + (1 - state.energy) * 0.55);

    if (rand() < leadChance && params.mode !== 'STRICT') {
      const triadMidi = buildTriadMidi(params.rootHz, motif.scale, degree);
      const nextMidi = this.melody.pickNext(triadMidi, rand);

      const hz = midiToHz(nextMidi) * (1 + (rand() - 0.5) * 0.006);
      const stepDur = 60 / Math.max(1, params.bpm);
      const dur = stepDur * (rand() < 0.75 ? 1 : 2);

      const ampBase = 0.010 + (1 - params.pulseAmp) * 0.020;
      const amp = Math.max(0.006, Math.min(0.045, ampBase + rand() * 0.010));

      ev.push({ kind: 'LEAD', time: time + stepDur * 0.15, hz, dur, amp });
    }

    state.stepIndex += 1;
    return ev;
  }

  private pickSectionStyle(rand: () => number, params: EngineParams, state: EngineState): SectionStyle {
    const e = Math.max(0, Math.min(1, state.energy));
    const r = rand();

    if (params.profile === 'bienestar') {
      if (r < 0.40) return 'BASE';
      if (r < 0.58) return 'SUS2';
      if (r < 0.72) return 'SUS4';
      if (r < 0.86) return 'INVERT';
      return 'DRIFT';
    }

    if (r < 0.28) return 'INVERT';
    if (r < 0.46) return 'ADD7';
    if (r < 0.62) return (e > 0.55 ? 'OCT_UP' : 'SUS2');
    if (r < 0.80) return 'DRIFT';
    return 'BASE';
  }
}
