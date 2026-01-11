// src/app/service/tips.service.ts
import { Injectable, inject } from '@angular/core';
import { Tip, Topic } from '../models/models';
import { TIPS } from '../data/tips';
import { StorageService } from './storage.service';
import { TipRankerService } from './tip-ranker.service';
import { MindService } from './mind.service';
import { AudioService } from './audio.service';

@Injectable({ providedIn: 'root' })
export class TipsService {
  private storage = inject(StorageService);
  private ranker = inject(TipRankerService);
  private mind = inject(MindService);
  private audio = inject(AudioService);

  private currentTopic: Topic = 'seguridad';

  getHint(topic: Topic): string {
    if (topic === 'seguridad') return 'Tip corto de ciberseguridad. Ideal para compartir.';
    if (topic === 'estudio') return 'Tip de estudio aplicable hoy. Rotación rápida.';
    if (topic === 'productividad') return 'Acción simple para mejorar enfoque y resultados.';
    return 'Higiene digital y descanso mental en pocos pasos.';
  }

  /** Fuente única del “topic actual” para servicios y App */
  getTopic(): Topic {
    return this.currentTopic;
  }

  /** Cambia topic: 1 sola memoria + 1 solo SFX + 1 solo hint */
  setTopic(topic: Topic): void {
    this.currentTopic = topic;

    this.mind.ingest('TOPIC', topic, true, { topic });
    void this.audio.sfx('TOPIC_CHANGE');

    this.syncAudioFromMind();
  }

  /** Elige tip: actualiza history + stats(seen) + mind + SFX (sin duplicar en App) */
  nextTip(topic: Topic): Tip {
    this.currentTopic = topic;

    const history = this.storage.getTipHistoryIds();
    const stats = this.storage.getTipStats();
    const ctx = this.ranker.buildContext();

    const tip = this.ranker.pickBest(topic, TIPS, history, stats, ctx);

    // ✅ 1) no repetir + historial
    this.storage.pushTipHistoryId(tip.id, 40);

    // ✅ 2) seen SOLO aquí (evita doble bump en App)
    this.storage.bumpTipStat(tip.id, 'seen');

    // ✅ 3) mente + SFX SOLO aquí
    this.mind.ingest('NEW_TIP', topic, true, { tipId: tip.id, title: tip.title });
    void this.audio.sfx('NEW_TIP');

    this.syncAudioFromMind();
    return tip;
  }

  /** Registre like/dislike desde UI si aplica (opcional) */
  likeTip(tip: Tip): void {
    this.mind.ingest('TIP_LIKE', tip.topic, true, { tipId: tip.id });
    this.syncAudioFromMind();
  }

  dislikeTip(tip: Tip): void {
    this.mind.ingest('TIP_DISLIKE', tip.topic, false, { tipId: tip.id });
    this.syncAudioFromMind();
  }

  /** Copia: App decide si fue OK; aquí se registra estado + stats + SFX 1 vez */
  copyTip(tip: Tip, ok: boolean): void {
    if (ok) this.storage.bumpTipStat(tip.id, 'copied');

    this.mind.ingest('COPY_TIP', tip.topic, ok, { tipId: tip.id });
    void this.audio.sfx(ok ? 'COPY' : 'ERROR');

    this.syncAudioFromMind();
  }

  /** Compartir: App decide si fue OK; aquí se registra estado + stats + SFX 1 vez */
  shareTip(tip: Tip, ok: boolean, channel?: string): void {
    if (ok) this.storage.bumpTipStat(tip.id, 'shared');

    this.mind.ingest('SHARE_TIP', tip.topic, ok, { tipId: tip.id, channel });
    void this.audio.sfx(ok ? 'SHARE' : 'ERROR');

    this.syncAudioFromMind();
  }

  /** Señales del sistema (audio bloqueado / SSE) */
  audioBlocked(): void {
    this.mind.ingest('AUDIO_BLOCKED', this.currentTopic, false);

    // modo “semántico” solo para SFX
    this.audio.setHint({ mode: 'REDUCED', stressScore: 0.75, focusScore: 0.35 });
  }

  sseDown(): void {
    this.mind.ingest('SSE_DOWN', this.currentTopic, false);
    void this.audio.sfx('SSE_DOWN', { strength: 0.9 });

    this.audio.setHint({ mode: 'REST', stressScore: 0.7, focusScore: 0.35 });
  }

  sseUp(): void {
    this.mind.ingest('SSE_UP', this.currentTopic, true);
    void this.audio.sfx('SSE_UP', { strength: 0.9 });

    this.syncAudioFromMind();
  }

  sessionTick(seconds = 30): void {
    this.mind.ingest('SESSION_TICK', this.currentTopic, true, { seconds });
    this.syncAudioFromMind();
  }

  toText(tip: Tip): string {
    const title = (tip as any)?.title ? String((tip as any).title).trim() : '';
    const body = (tip as any)?.text
      ? String((tip as any).text).trim()
      : (tip as any)?.content
      ? String((tip as any).content).trim()
      : (tip as any)?.tip
      ? String((tip as any).tip).trim()
      : '';

    const topic = (tip as any)?.topic ? String((tip as any).topic).trim() : '';
    const tag = topic ? `#${topic.replace(/\s+/g, '')}` : '';
    const brand = 'SystemBlacklem · Tips';

    const main = title ? `${title}\n${body}` : body;
    return [main, tag, brand].filter(Boolean).join('\n').trim();
  }

  private syncAudioFromMind(): void {
    const s = this.mind.snapshot();
    const hint = this.mind.getAudioHint(s);

    const mode =
      s.mood === 'stressed' ? 'REST' : s.mood === 'tired' ? 'REDUCED' : s.mood === 'focused' ? 'FOCUS' : 'NORMAL';

    this.audio.setHint({
      mode,
      focusScore: hint.focusScore,
      stressScore: hint.stressScore,
    });
  }
}
