// src/app/service/tips.service.ts
import { Injectable, inject } from '@angular/core';
import { Tip, Topic } from '../models/models';
import { TIPS } from '../data/tips';
import { StorageService } from './storage.service';
import { TipRankerService } from './tip-ranker.service';

import { MindService } from './mind.service';

// ✅ Orquestador (UI/estado/bloqueo/gesto)
import { AudioService } from './audio.service';

// ✅ Tipos del motor (solo tipos)
import type { AudioContextHint, UserSignal } from '../audio/audio-engine';
import type { AudioProfile } from '../audio/types-adio';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

@Injectable({ providedIn: 'root' })
export class TipsService {
  private storage = inject(StorageService);
  private ranker = inject(TipRankerService);
  private mind = inject(MindService);

  // ✅ use AudioService (no el engine directo)
  private audio = inject(AudioService);

  private currentTopic: Topic = 'bienestar';

  getHint(topic: Topic): string {
    if (topic === 'seguridad') return 'Tip corto de ciberseguridad. Ideal para compartir.';
    if (topic === 'estudio') return 'Tip de estudio aplicable hoy. Rotación rápida.';
    if (topic === 'productividad') return 'Acción simple para mejorar enfoque y resultados.';
    return 'Higiene digital y descanso mental en pocos pasos.';
  }

  setTopic(topic: Topic): void {
    this.currentTopic = topic;

    this.mind.ingest('TOPIC', topic, true, { topic });

    // ✅ Señal semántica para que el motor “cambie de escena”
    this.pushAudioSignal({ type: 'TIP_VIEW', id: `topic:${topic}` });

    // ✅ Aplicar sensibilidad Mind -> AudioContextHint
    this.syncAudioFromMind();
  }

  /** Tip “inteligente” + registro de seen */
  nextTip(topic: Topic): Tip {
    this.currentTopic = topic;

    const history = this.storage.getTipHistoryIds();
    const stats = this.storage.getTipStats();
    const ctx = this.ranker.buildContext();

    const tip = this.ranker.pickBest(topic, TIPS, history, stats, ctx);

    this.storage.pushTipHistoryId(tip.id, 40);
    this.storage.bumpTipStat(tip.id, 'seen');

    this.mind.ingest('NEW_TIP', topic, true, { tipId: tip.id, title: tip.title });

    // ✅ Señal al motor (aprendizaje)
    this.pushAudioSignal({ type: 'TIP_VIEW', id: tip.id });

    // ✅ Contexto actual (mood/focus/stress)
    this.syncAudioFromMind();

    return tip;
  }

  likeTip(tip: Tip): void {
    this.mind.ingest('TIP_LIKE', tip.topic, true, { tipId: tip.id });
    this.pushAudioSignal({ type: 'TIP_LIKE', id: tip.id });
    this.syncAudioFromMind();
  }

  dislikeTip(tip: Tip): void {
    this.mind.ingest('TIP_DISLIKE', tip.topic, false, { tipId: tip.id });
    this.pushAudioSignal({ type: 'TIP_DISLIKE', id: tip.id });
    this.syncAudioFromMind();
  }

  copyTip(tip: Tip): void {
    this.storage.bumpTipStat(tip.id, 'copied');
    this.mind.ingest('COPY_TIP', tip.topic, true, { tipId: tip.id });

    // No existe TIP_COPY => use refuerzo por “engagement”
    this.pushAudioSignal({ type: 'SESSION_TICK', seconds: 20 });
    this.syncAudioFromMind();
  }

  shareTip(tip: Tip, channel?: string): void {
    this.storage.bumpTipStat(tip.id, 'shared');
    this.mind.ingest('SHARE_TIP', tip.topic, true, { tipId: tip.id, channel });

    this.pushAudioSignal({ type: 'SESSION_TICK', seconds: 25 });
    this.syncAudioFromMind();
  }

  audioBlocked(): void {
    this.mind.ingest('AUDIO_BLOCKED', this.currentTopic, false);
    this.pushAudioSignal({ type: 'MODE_CHANGE', mode: 'LIMITED' });
    this.syncAudioFromMind();
  }

  sseDown(): void {
    this.mind.ingest('SSE_DOWN', this.currentTopic, false);
    this.pushAudioSignal({ type: 'MODE_CHANGE', mode: 'STRICT' });
    this.syncAudioFromMind();
  }

  sseUp(): void {
    this.mind.ingest('SSE_UP', this.currentTopic, true);
    this.pushAudioSignal({ type: 'MODE_CHANGE', mode: 'NORMAL' });
    this.syncAudioFromMind();
  }

  sessionTick(seconds = 30): void {
    this.mind.ingest('SESSION_TICK', this.currentTopic, true, { seconds });
    this.pushAudioSignal({ type: 'SESSION_TICK', seconds });
    this.syncAudioFromMind();
  }

  toText(t: Tip): string {
    return [
      `✨ ${t.title}`,
      ...t.steps.map((s, i) => `${i + 1}) ${s}`),
      `— SystemBlacklem · Alberto Lem`,
    ].join('\n');
  }

  /* ===========================
     Audio glue: Tips → Audio
  ============================ */

  /** Map Topic -> AudioProfile (si sus nombres coinciden, queda 1:1) */
  private topicToProfile(topic: Topic): AudioProfile {
    // Si su AudioProfile y Topic tienen los mismos literales:
    return topic as unknown as AudioProfile;
  }

  /** Envia señales al motor a través del AudioService (sin exponer engine en TipsService) */
  private pushAudioSignal(signal: UserSignal): void {
    // Aquí asumimos que AudioService expone engine internamente.
    // Si usted desea, puede añadir en AudioService un método "signal()".
    (this.audio as any).engine?.onUserSignal?.(signal);
  }

  /**
   * Conecta MindState → AudioContextHint (focusScore/stressScore).
   * Esto da “sensibilidad” real, estable y predecible.
   */
  private syncAudioFromMind(): void {
    const s = this.mind.snapshot();

    const focusScore = clamp01((s.focus ?? 50) / 100);

    const trustInv = 1 - clamp01((s.trust ?? 60) / 100);
    const energyInv = 1 - clamp01((s.energy ?? 60) / 100);
    const stressScore = clamp01(trustInv * 0.65 + energyInv * 0.35);

    const mode =
      s.mood === 'stressed' ? 'STRICT' :
      s.mood === 'tired' ? 'LIMITED' :
      'NORMAL';

    const hint: AudioContextHint = { mode, focusScore, stressScore };

    // ✅ Aplica el hint al motor (via service)
    this.audio.setContextHint(hint);

    // ✅ Si su audio está en AUTO/ON, usted puede sincronizar perfil aquí
    //    (esto NO fuerza play; solo ajusta parámetros si ya está sonando)
    this.audio.setProfile(this.topicToProfile(this.currentTopic), hint);
  }
}
