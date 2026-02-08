// src/app/service/tips.service.ts
import { Injectable, inject } from '@angular/core';
import { Tip, Topic } from '../models/models';
import { StorageService } from './storage.service';
import { MindService } from './mind.service';
import { AudioService } from './audio.service';

@Injectable({ providedIn: 'root' })
export class TipsService {
  private storage = inject(StorageService);
  private mind = inject(MindService);
  private audio = inject(AudioService);

  private currentTopic: Topic = 'seguridad';

  getHint(topic: Topic): string {
    switch (topic) {
      case 'seguridad': return 'Tip corto de ciberseguridad. Ideal para compartir.';
      case 'estudio': return 'Tip de estudio aplicable hoy. Rotación rápida.';
      case 'productividad': return 'Acción simple para mejorar enfoque y resultados.';
      default: return 'Higiene digital y descanso mental en pocos pasos.';
    }
  }

  getTopic(): Topic {
    return this.currentTopic;
  }

  setTopic(topic: Topic): void {
    this.currentTopic = topic;
    this.mind.ingest('TOPIC', topic, true, { topic });
    void this.audio.sfx('TOPIC_CHANGE');
    this.syncAudioFromMind();
  }

  /** ✅ Backend-first: registre aquí el tip que ya fue obtenido del backend y se va a mostrar */
  registerTipShown(topic: Topic, tip: Tip & { id?: string; _id?: string }) {
    const tipId = String((tip as any)?.id ?? (tip as any)?._id ?? '').trim();
    if (!tipId) return;

    this.currentTopic = topic;

    // Historial + stats (local)
    this.storage.pushTipHistoryId(tipId, 40);
    this.storage.bumpTipStat(tipId, 'seen');

    // Mind + audio (UX)
    this.mind.ingest('NEW_TIP', topic, true, { tipId, title: (tip as any)?.title ?? '' });
    void this.audio.sfx('NEW_TIP');
    this.syncAudioFromMind();
  }

  copyTip(tip: Tip, ok: boolean): void {
    if (ok) this.storage.bumpTipStat(tip.id, 'copied');
    this.mind.ingest('COPY_TIP', tip.topic, ok, { tipId: tip.id });
    void this.audio.sfx(ok ? 'COPY' : 'ERROR');
    this.syncAudioFromMind();
  }

  shareTip(tip: Tip, ok: boolean, channel?: string): void {
    if (ok) this.storage.bumpTipStat(tip.id, 'shared');
    this.mind.ingest('SHARE_TIP', tip.topic, ok, { tipId: tip.id, channel });
    void this.audio.sfx(ok ? 'SHARE' : 'ERROR');
    this.syncAudioFromMind();
  }

  sseDown(): void {
    this.mind.ingest('SSE_DOWN', this.currentTopic, false);
    void this.audio.sfx('SSE_DOWN', { strength: 0.9 });
    this.audio.setHint({ mode: 'REST', stressScore: 0.7, focusScore: 0.35, audioIntensity: 0.35 });
  }

  sseUp(): void {
    this.mind.ingest('SSE_UP', this.currentTopic, true);
    void this.audio.sfx('SSE_UP', { strength: 0.9 });
    this.syncAudioFromMind();
  }

  private syncAudioFromMind(): void {
    const s = this.mind.snapshot();
    const hint = this.mind.getAudioHint(s);

    const mode =
      s.mood === 'stressed' ? 'REST'
      : s.mood === 'tired' ? 'REDUCED'
      : s.mood === 'focused' ? 'FOCUS'
      : 'NORMAL';

    const audioIntensity =
      mode === 'FOCUS' ? 0.95 :
      mode === 'NORMAL' ? 0.85 :
      mode === 'REDUCED' ? 0.55 :
      0.45;

    this.audio.setHint({ mode, focusScore: hint.focusScore, stressScore: hint.stressScore, audioIntensity });
  }
}
