import { Injectable } from '@angular/core';
import { Tip, Topic } from '../models/models';
import { pick } from '../utils/utils';
import { TIPS } from '../data/tips'; // <- viene de index.ts

@Injectable({ providedIn: 'root' })
export class TipsService {

  getHint(topic: Topic): string {
    if (topic === 'seguridad') return 'Tip corto de ciberseguridad. Ideal para compartir.';
    if (topic === 'estudio') return 'Tip de estudio aplicable hoy. Rotación rápida.';
    if (topic === 'productividad') return 'Acción simple para mejorar enfoque y resultados.';
    return 'Higiene digital y descanso mental en pocos pasos.';
  }

  getAllByTopic(topic: Topic): Tip[] {
    return TIPS.filter(t => t.topic === topic);
  }

  newTip(topic: Topic): Tip {
    const pool = this.getAllByTopic(topic);
    return pick(pool.length ? pool : TIPS);
  }

  toText(t: Tip): string {
    return [
      `✨ ${t.title}`,
      ...t.steps.map((s, i) => `${i + 1}) ${s}`),
      `— SystemBlacklem · Alberto Lem`,
    ].join('\n');
  }
}
