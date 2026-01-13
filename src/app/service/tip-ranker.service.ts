// src/app/service/tip-ranker.service.ts
import { Injectable } from '@angular/core';
import { Tip, Topic, TipContext, TipStatsMap } from '../models/models';

/**
 * TipRankerService (mejorado):
 * - Mantiene la misma API pública (buildContext / pickBest).
 * - Score determinístico con “seed” (evita Math.random() que rompe depuración).
 * - Penalización de repetición configurable.
 * - Peso de copied/shared configurable.
 */
@Injectable({ providedIn: 'root' })
export class TipRankerService {
  buildContext(now = new Date()): TipContext {
    const hour = now.getHours();
    const day = now.getDay();
    const isWeekend = day === 0 || day === 6;

    let bucket: TipContext['bucket'] = 'afternoon';
    if (hour >= 5 && hour <= 11) bucket = 'morning';
    else if (hour >= 12 && hour <= 16) bucket = 'afternoon';
    else if (hour >= 17 && hour <= 21) bucket = 'evening';
    else bucket = 'night';

    return { hour, day, isWeekend, bucket };
  }

  /**
   * pickBest:
   * - visitorSeed: si lo pasas, hace “shuffle” determinístico por visitante/día.
   *   Si no lo pasas, queda determinístico por día únicamente.
   */
  pickBest(
    topic: Topic,
    tips: Tip[],
    historyIds: string[],
    stats: TipStatsMap,
    ctx: TipContext,
    visitorSeed?: string
  ): Tip {
    const pool = tips.filter((t) => t.topic === topic);
    const candidates = pool.length ? pool : tips;

    // ventana de “no repetir”
    const recent = new Set(historyIds.slice(0, 25));

    // seed por día (y opcionalmente por visitor)
    const dayKey = this.todayKey();
    const seed = `${dayKey}::${visitorSeed || 'anon'}::${topic}`;

    let bestTip: Tip | null = null;
    let bestScore = -Infinity;

    for (const t of candidates) {
      const s = this.scoreTip(t, recent, stats, ctx, seed);
      if (s > bestScore) {
        bestScore = s;
        bestTip = t;
      }
    }

    return bestTip ?? candidates[Math.floor(this.hash01(seed) * candidates.length)];
  }

  private scoreTip(
    t: Tip,
    recent: Set<string>,
    stats: TipStatsMap,
    ctx: TipContext,
    seed: string
  ): number {
    const st = stats[t.id];
    const seen = st?.seen ?? 0;
    const copied = st?.copied ?? 0;
    const shared = st?.shared ?? 0;

    // base
    let score = 100;

    // 1) anti-repetición fuerte
    if (recent.has(t.id)) score -= 120;

    // 2) explorar vs explotar
    score += Math.max(0, 30 - seen) * 2;

    // 3) señales fuertes
    score += copied * 6;
    score += shared * 10;

    // 4) contexto por hora
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

    // 5) “ruido” determinístico (0..8) para no pegarse siempre al mismo
    // se basa en seed + tipId
    score += this.hash01(`${seed}::${t.id}`) * 8;

    return score;
  }

  /**
   * hash01: retorna un float estable 0..1 para una string.
   * No criptográfico; solo para ranking determinístico.
   */
  private hash01(input: string): number {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // >>> 0 => uint32
    const u = h >>> 0;
    return u / 0xffffffff;
  }

  private todayKey(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}
