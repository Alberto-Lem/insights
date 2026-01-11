// src/app/service/tip-ranker.service.ts
import { Injectable } from '@angular/core';
import { Tip, Topic, TipContext, TipStatsMap } from '../models/models';

@Injectable({ providedIn: 'root' })
export class TipRankerService {

  buildContext(now = new Date()): TipContext {
    const hour = now.getHours();
    const day = now.getDay();
    const isWeekend = (day === 0 || day === 6);

    let bucket: TipContext['bucket'] = 'afternoon';
    if (hour >= 5 && hour <= 11) bucket = 'morning';
    else if (hour >= 12 && hour <= 16) bucket = 'afternoon';
    else if (hour >= 17 && hour <= 21) bucket = 'evening';
    else bucket = 'night';

    return { hour, day, isWeekend, bucket };
  }

  pickBest(topic: Topic, tips: Tip[], historyIds: string[], stats: TipStatsMap, ctx: TipContext): Tip {
    const pool = tips.filter(t => t.topic === topic);
    const candidates = pool.length ? pool : tips;

    // ventana de “no repetir”
    const recent = new Set(historyIds.slice(0, 25));

    // evaluar score
    let best: { tip: Tip; score: number } | null = null;

    for (const t of candidates) {
      const s = this.scoreTip(t, recent, stats, ctx);
      if (!best || s > best.score) best = { tip: t, score: s };
    }

    // fallback duro (no debería pasar)
    return best?.tip ?? candidates[Math.floor(Math.random() * candidates.length)];
  }

  private scoreTip(t: Tip, recent: Set<string>, stats: TipStatsMap, ctx: TipContext): number {
    const st = stats[t.id];
    const seen = st?.seen ?? 0;
    const copied = st?.copied ?? 0;
    const shared = st?.shared ?? 0;

    let score = 100;

    // 1) anti-repetición fuerte
    if (recent.has(t.id)) score -= 120;

    // 2) explorar vs explotar:
    // menos vistos => más score (explorar)
    score += Math.max(0, 30 - seen) * 2;

    // 3) si el usuario lo copia o comparte, súbalo (exploit)
    score += copied * 6;
    score += shared * 10;

    // 4) contexto simple por hora (opcional, pero ayuda)
    // noche: bienestar/seguridad suave; mañana: productividad/estudio
    if (ctx.bucket === 'morning') {
      if (t.topic === 'productividad' || t.topic === 'estudio') score += 18;
    }
    if (ctx.bucket === 'night') {
      if (t.topic === 'bienestar') score += 20;
      if (t.topic === 'seguridad') score += 8;
    }
    if (ctx.isWeekend) {
      if (t.topic === 'bienestar') score += 10;
    }

    // 5) pequeña aleatoriedad para que no se “pegue” understanding
    score += (Math.random() * 8);

    return score;
  }
}
