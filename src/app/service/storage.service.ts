// src/app/service/storage.service.ts
import { Injectable } from '@angular/core';
import type { Topic, TipStatsMap, TipStat } from '../models/models';
import { randomId } from '../utils/utils';
import type { MemoryEvent, MindState } from '../core/mind.types';

export type Prefs = { topic?: Topic; musicState?: 'AUTO' | 'ON' | 'OFF' };

export type ClientMeta = {
  tz?: string;         // IANA: "America/Guatemala", "America/New_York", etc.
  tzOffsetMin?: number; // new Date().getTimezoneOffset()
  lang?: string;       // navigator.language
};

@Injectable({ providedIn: 'root' })
export class StorageService {
  readonly PREF_KEY = 'sb_visits_prefs_v1';
  readonly HISTORY_KEY = 'sb_tip_history_v2';
  readonly VISITOR_KEY = 'sb_visitor_id_v1';
  readonly TIP_STATS_KEY = 'sb_tip_stats_v1';

  readonly MIND_STATE_KEY = 'sb_mind_state_v1';
  readonly MIND_EVENTS_KEY = 'sb_mind_events_v1';

  // ✅ nuevo
  readonly CLIENT_META_KEY = 'sb_client_meta_v1';

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
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  getPrefs(): Prefs {
    return this.safeGet<Prefs>(this.PREF_KEY) ?? { topic: 'seguridad', musicState: 'AUTO' };
  }

  setPrefs(p: Prefs): void {
    this.safeSet(this.PREF_KEY, p);
  }

  getTipHistoryIds(): string[] {
    return this.safeGet<string[]>(this.HISTORY_KEY) ?? [];
  }

  pushTipHistoryId(id: string, max = 40): string[] {
    const h = this.getTipHistoryIds();
    const next = [id, ...h.filter((x) => x !== id)].slice(0, max);
    this.safeSet(this.HISTORY_KEY, next);
    return next;
  }

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

  setVisitorId(v: string): void {
    const next = String(v ?? '').trim();
    if (!next) return;
    this.safeSet(this.VISITOR_KEY, next);
  }

  // ✅ nuevo: meta del cliente
  getClientMeta(): ClientMeta {
    const cached = this.safeGet<ClientMeta>(this.CLIENT_META_KEY);
    if (cached?.tz) return cached;

    const tz =
      (Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone as string | undefined) ||
      undefined;

    const meta: ClientMeta = {
      tz,
      tzOffsetMin: new Date().getTimezoneOffset(),
      lang: (navigator?.language || 'es') as string,
    };

    this.safeSet(this.CLIENT_META_KEY, meta);
    return meta;
  }

  setClientMeta(m: ClientMeta): void {
    this.safeSet(this.CLIENT_META_KEY, m);
  }

  getMindState(): MindState | null {
    return this.safeGet<MindState>(this.MIND_STATE_KEY);
  }

  setMindState(s: MindState): void {
    this.safeSet(this.MIND_STATE_KEY, s);
  }

  getMindEvents(): MemoryEvent[] {
    return this.safeGet<MemoryEvent[]>(this.MIND_EVENTS_KEY) ?? [];
  }

  pushMindEvent(ev: MemoryEvent, max = 80): MemoryEvent[] {
    const all = this.getMindEvents();
    const next = [ev, ...all].slice(0, max);
    this.safeSet(this.MIND_EVENTS_KEY, next);
    return next;
  }
}
