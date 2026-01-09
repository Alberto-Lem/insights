// src/app/service/tips.service.ts
import { Injectable, inject } from '@angular/core';
import { Tip, Topic } from '../models/models';
import { TIPS } from '../data/tips';
import { StorageService } from './storage.service';
import { TipRankerService } from './tip-ranker.service';

@Injectable({ providedIn: 'root' })
export class TipsService {
  private storage = inject(StorageService);
  private ranker = inject(TipRankerService);

  getHint(topic: Topic): string {
    if (topic === 'seguridad') return 'Tip corto de ciberseguridad. Ideal para compartir.';
    if (topic === 'estudio') return 'Tip de estudio aplicable hoy. Rotación rápida.';
    if (topic === 'productividad') return 'Acción simple para mejorar enfoque y resultados.';
    return 'Higiene digital y descanso mental en pocos pasos.';
  }

  /**
   * Devuelve un tip “inteligente” (evita repetición, pondera aprendizaje local, etc.)
   * y registra "seen" + historial por ID.
   */
  nextTip(topic: Topic): Tip {
    const history = this.storage.getTipHistoryIds();
    const stats = this.storage.getTipStats();
    const ctx = this.ranker.buildContext();

    const tip = this.ranker.pickBest(topic, TIPS, history, stats, ctx);

    // registrar “seen” una sola vez (aquí)
    this.storage.pushTipHistoryId(tip.id, 40);
    this.storage.bumpTipStat(tip.id, 'seen');

    return tip;
  }

  toText(t: Tip): string {
    return [
      `✨ ${t.title}`,
      ...t.steps.map((s, i) => `${i + 1}) ${s}`),
      `— SystemBlacklem · Alberto Lem`,
    ].join('\n');
  }
}
