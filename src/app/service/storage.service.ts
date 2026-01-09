// src/app/service/storage.service.ts
import { Injectable } from '@angular/core';
import { Topic, TipStatsMap, TipStat } from '../models/models';
import { randomId } from '../utils/utils';

export type Prefs = { topic?: Topic; musicState?: 'AUTO' | 'ON' | 'OFF' };

@Injectable({ providedIn: 'root' })
export class StorageService {
  readonly PREF_KEY = 'sb_visits_prefs_v1';
  readonly HISTORY_KEY = 'sb_tip_history_v2';   // ✅ cambie versión
  readonly VISITOR_KEY = 'sb_visitor_id_v1';
  readonly TIP_STATS_KEY = 'sb_tip_stats_v1';   // ✅ nuevo

  safeGet<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  safeSet(key: string, value: any): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  getPrefs(): Prefs {
    return this.safeGet<Prefs>(this.PREF_KEY) ?? { topic: 'seguridad', musicState: 'AUTO' };
  }

  setPrefs(p: Prefs): void {
    this.safeSet(this.PREF_KEY, p);
  }

  // ✅ historial de tips por ID para evitar repetición
  getTipHistoryIds(): string[] {
    return this.safeGet<string[]>(this.HISTORY_KEY) ?? [];
  }

  pushTipHistoryId(id: string, max = 40): string[] {
    const h = this.getTipHistoryIds();
    const next = [id, ...h.filter(x => x !== id)].slice(0, max);
    this.safeSet(this.HISTORY_KEY, next);
    return next;
  }

  // ✅ stats locales (aprendizaje)
  getTipStats(): TipStatsMap {
    return this.safeGet<TipStatsMap>(this.TIP_STATS_KEY) ?? {};
  }

  bumpTipStat(id: string, kind: 'seen' | 'copied' | 'shared'): void {
    const all = this.getTipStats();
    const cur: TipStat = all[id] ?? { seen: 0, copied: 0, shared: 0 };
    cur[kind] = (cur[kind] ?? 0) + 1;
    if (kind === 'seen') cur.lastSeen = Date.now();
    all[id] = cur;
    this.safeSet(this.TIP_STATS_KEY, all);
  }

  getVisitorId(): string {
    const stored = this.safeGet<string>(this.VISITOR_KEY);
    if (typeof stored === 'string' && stored.length >= 8) return stored;
    const v = `v_${randomId(22)}`;
    this.safeSet(this.VISITOR_KEY, v);
    return v;
  }
}
