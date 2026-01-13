// src/app/service/mind.service.ts
import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { StorageService } from './storage.service';
import type { MindState, MemoryEvent, Emotion, MoodFx } from '../core/mind.types';
import type { Topic } from '../models/models';

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

export type MindEventType =
  | 'NEW_TIP'
  | 'TIP_LIKE'
  | 'TIP_DISLIKE'
  | 'COPY_TIP'
  | 'SHARE_TIP'
  | 'TOPIC'
  | 'AUDIO_BLOCKED'
  | 'SSE_DOWN'
  | 'SSE_UP'
  | 'ERROR'
  | 'SESSION_TICK';

export type AudioHint = {
  focusScore: number;  // 0..1
  stressScore: number; // 0..1
};

@Injectable({ providedIn: 'root' })
export class MindService {
  private readonly storage = inject(StorageService);

  private readonly initial: MindState = this.normalize(
    this.storage.getMindState?.() ?? {
      mood: 'calm',
      energy: 72,
      trust: 70,
      curiosity: 55,
      focus: 55,
      lastUpdateTs: Date.now(),
    }
  );

  private readonly stateSubject = new BehaviorSubject<MindState>(this.initial);
  readonly state$: Observable<MindState> = this.stateSubject.asObservable();

  observe(): Observable<MindState> {
    return this.state$;
  }

  snapshot(): MindState {
    return this.stateSubject.value;
  }

  ingest(
    type: MindEventType | string,
    topic: Topic,
    ok?: boolean,
    meta?: Record<string, unknown>
  ): MindState {
    const ev: MemoryEvent = { ts: Date.now(), type, topic, ok, meta };

    // ✅ Persistencia defensiva (por si el storage está temporalmente desfasado)
    this.storage.pushMindEvent?.(ev);

    const next = this.reduce(this.snapshot(), ev);
    this.stateSubject.next(next);
    this.storage.setMindState?.(next);

    return next;
  }

  getAudioHint(s: MindState = this.snapshot()): AudioHint {
    const focusScore = clamp((s.focus ?? 50) / 100, 0, 1);

    const trustInv = 1 - clamp((s.trust ?? 60) / 100, 0, 1);
    const energyInv = 1 - clamp((s.energy ?? 60) / 100, 0, 1);
    const moodBoost = s.mood === 'stressed' ? 0.25 : s.mood === 'tired' ? 0.1 : 0;

    const stressScore = clamp(trustInv * 0.55 + energyInv * 0.3 + moodBoost, 0, 1);
    return { focusScore, stressScore };
  }

  getFxMode(mood: Emotion): MoodFx {
    if (mood === 'stressed') return 'minimal';
    if (mood === 'tired') return 'low';
    if (mood === 'curious') return 'spark';
    if (mood === 'focused') return 'sharp';
    if (mood === 'happy') return 'confetti';
    return 'soft';
  }

  getToneLine(s: MindState, topic: Topic): string {
    if (s.mood === 'stressed') return 'Respiremos: un paso simple y claro.';
    if (s.mood === 'tired') return 'Suave y corto: cuide energía y enfoque.';
    if (s.mood === 'curious') return 'Modo exploración: probemos algo nuevo.';
    if (s.mood === 'focused') return 'Directo al punto: acción concreta.';
    if (s.mood === 'happy') return 'Excelente ritmo: mantenga constancia.';
    return topic === 'seguridad' ? 'Tip breve y aplicable hoy.' : 'Una acción pequeña, impacto real.';
  }

  // ========================= Reducer =========================

  private reduce(prev: MindState, ev: MemoryEvent): MindState {
    const prevN = this.normalize(prev);
    const s: MindState = { ...prevN };

    const dtMs = Math.max(0, ev.ts - (s.lastUpdateTs || ev.ts));
    const dtMin = clamp(dtMs / 60000, 0, 240);

    const baseEnergy = this.homeEnergyByHour(ev.ts);
    const baseFocus = 55;
    const baseCuriosity = 55;
    const baseTrust = 65;

    const relaxT = 1 - Math.exp(-dtMin / 60);

    s.energy = lerp(s.energy, baseEnergy, relaxT * 0.22);
    s.focus = lerp(s.focus, baseFocus, relaxT * 0.18);
    s.curiosity = lerp(s.curiosity, baseCuriosity, relaxT * 0.14);
    s.trust = lerp(s.trust, baseTrust, relaxT * 0.10);

    const topicBias = this.topicBias(ev.topic as Topic);
    s.focus = clamp(s.focus + topicBias.focus, 0, 100);
    s.curiosity = clamp(s.curiosity + topicBias.curiosity, 0, 100);

    const type = String(ev.type) as MindEventType | string;

    switch (type) {
      case 'NEW_TIP':
        s.curiosity = clamp(s.curiosity + 6, 0, 100);
        s.focus = clamp(s.focus + 2, 0, 100);
        s.energy = clamp(s.energy - 0.6, 0, 100);
        break;

      case 'TIP_LIKE':
        s.trust = clamp(s.trust + 2.2, 0, 100);
        s.energy = clamp(s.energy + 0.8, 0, 100);
        s.focus = clamp(s.focus + 0.8, 0, 100);
        s.curiosity = clamp(s.curiosity + 0.5, 0, 100);
        break;

      case 'TIP_DISLIKE':
        s.trust = clamp(s.trust - 2.4, 0, 100);
        s.energy = clamp(s.energy - 0.8, 0, 100);
        s.focus = clamp(s.focus - 1.2, 0, 100);
        s.curiosity = clamp(s.curiosity - 0.5, 0, 100);
        break;

      case 'COPY_TIP':
        s.focus = clamp(s.focus + 6, 0, 100);
        s.trust = clamp(s.trust + 2, 0, 100);
        break;

      case 'SHARE_TIP':
        s.trust = clamp(s.trust + 5, 0, 100);
        s.curiosity = clamp(s.curiosity + 2, 0, 100);
        break;

      case 'TOPIC':
        s.curiosity = clamp(s.curiosity + 3, 0, 100);
        s.focus = clamp(s.focus + 1, 0, 100);
        break;

      case 'AUDIO_BLOCKED':
        s.trust = clamp(s.trust - 5, 0, 100);
        s.energy = clamp(s.energy - 0.6, 0, 100);
        break;

      case 'SSE_DOWN':
        s.trust = clamp(s.trust - 4, 0, 100);
        s.focus = clamp(s.focus - 1.0, 0, 100);
        break;

      case 'SSE_UP':
        s.trust = clamp(s.trust + 2, 0, 100);
        break;

      case 'ERROR':
        s.trust = clamp(s.trust - 6, 0, 100);
        s.focus = clamp(s.focus - 2.0, 0, 100);
        s.energy = clamp(s.energy - 1.0, 0, 100);
        break;

      case 'SESSION_TICK': {
        const sec = clamp(Number((ev.meta as any)?.['seconds'] ?? 0), 0, 300);
        s.focus = clamp(s.focus + (sec / 60) * 0.6, 0, 100);
        s.trust = clamp(s.trust + (sec / 60) * 0.35, 0, 100);
        s.energy = clamp(s.energy - (sec / 60) * 0.25, 0, 100);
        break;
      }
    }

    if (ev.ok === true) {
      s.trust = clamp(s.trust + 0.8, 0, 100);
      s.focus = clamp(s.focus + 0.4, 0, 100);
    } else if (ev.ok === false) {
      s.trust = clamp(s.trust - 1.0, 0, 100);
      s.focus = clamp(s.focus - 0.6, 0, 100);
    }

    s.mood = this.deriveMood(s);
    s.lastUpdateTs = ev.ts;

    return this.normalize(s);
  }

  private deriveMood(s: MindState): Emotion {
    if (s.energy < 22) return 'tired';
    if (s.trust < 35) return 'stressed';
    if (s.focus > 75 && s.energy > 35) return 'focused';
    if (s.curiosity > 75 && s.energy > 30) return 'curious';
    if (s.trust > 82 && s.energy > 35) return 'happy';
    return 'calm';
  }

  private normalize(s: MindState): MindState {
    return {
      ...s,
      energy: clamp(s.energy ?? 0, 0, 100),
      trust: clamp(s.trust ?? 0, 0, 100),
      curiosity: clamp(s.curiosity ?? 0, 0, 100),
      focus: clamp(s.focus ?? 0, 0, 100),
      lastUpdateTs: typeof s.lastUpdateTs === 'number' ? s.lastUpdateTs : Date.now(),
      mood: (s.mood ?? 'calm') as Emotion,
    };
  }

  private homeEnergyByHour(ts: number): number {
    const hour = new Date(ts).getHours();
    if (hour >= 0 && hour <= 5) return 48;
    if (hour >= 6 && hour <= 9) return 68;
    if (hour >= 10 && hour <= 15) return 72;
    if (hour >= 16 && hour <= 20) return 66;
    return 58;
  }

  private topicBias(topic: Topic): { focus: number; curiosity: number } {
    if (topic === 'seguridad') return { focus: +0.6, curiosity: +0.2 };
    if (topic === 'estudio') return { focus: +0.8, curiosity: +0.3 };
    if (topic === 'productividad') return { focus: +0.5, curiosity: +0.4 };
    return { focus: +0.2, curiosity: +0.2 };
  }
}
