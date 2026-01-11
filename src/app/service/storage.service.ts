// src/app/service/storage.service.ts
import { Injectable } from '@angular/core';
import type { Topic, TipStatsMap, TipStat } from '../models/models';
import { randomId } from '../utils/utils';
import type { MemoryEvent, MindState } from '../core/mind.types';

export type Prefs = { topic?: Topic; musicState?: 'AUTO' | 'ON' | 'OFF' };

export type ClientMeta = {
  tz?: string;          // IANA: "America/Guatemala", "America/New_York", etc.
  tzOffsetMin?: number; // new Date().getTimezoneOffset()
  lang?: string;        // navigator.language
};

@Injectable({ providedIn: 'root' })
export class StorageService {
  readonly PREF_KEY = 'sb_visits_prefs_v1';
  readonly HISTORY_KEY = 'sb_tip_history_v2';
  readonly VISITOR_KEY = 'sb_visitor_id_v1';
  readonly TIP_STATS_KEY = 'sb_tip_stats_v1';

  readonly MIND_STATE_KEY = 'sb_mind_state_v1';
  readonly MIND_EVENTS_KEY = 'sb_mind_events_v1';

  readonly CLIENT_META_KEY = 'sb_client_meta_v1';

  // ✅ cache en memoria para evitar JSON.parse repetido
  private mem = new Map<string, any>();

  // ✅ throttle de escrituras (para no “martillar” localStorage)
  private writeTimers = new Map<string, any>();
  private pendingWrites = new Map<string, string>();

  safeGet<T>(key: string): T | null {
    try {
      if (this.mem.has(key)) return this.mem.get(key) as T;

      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as T;
      this.mem.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Escritura inmediata (la suya original) */
  safeSet(key: string, value: any): void {
    try {
      const raw = JSON.stringify(value);
      localStorage.setItem(key, raw);
      this.mem.set(key, value);
    } catch {}
  }

  /**
   * ✅ Escritura “suave” (throttle).
   * Útil para stats/eventos que pueden dispararse muchas veces por minuto.
   */
  safeSetThrottled(key: string, value: any, delayMs = 350): void {
    try {
      const raw = JSON.stringify(value);
      this.mem.set(key, value);
      this.pendingWrites.set(key, raw);

      if (this.writeTimers.has(key)) return;

      const t = setTimeout(() => {
        this.writeTimers.delete(key);
        const pending = this.pendingWrites.get(key);
        if (!pending) return;
        this.pendingWrites.delete(key);
        try { localStorage.setItem(key, pending); } catch {}
      }, Math.max(80, delayMs));

      this.writeTimers.set(key, t);
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

    // ✅ throttle para no escribir a disco cada interacción
    this.safeSetThrottled(this.TIP_STATS_KEY, all, 500);
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

  getClientMeta(): ClientMeta {
    const cached = this.safeGet<ClientMeta>(this.CLIENT_META_KEY);
    if (cached && (cached.tz || cached.lang || typeof cached.tzOffsetMin === 'number')) return cached;

    const tz =
      (Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone as string | undefined) ||
      undefined;

    const meta: ClientMeta = {
      tz,
      tzOffsetMin: new Date().getTimezoneOffset(),
      lang: (navigator?.language || 'es') as string,
    };

    // ✅ guardar siempre (aunque tz sea undefined) para evitar recalcular
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
    this.safeSetThrottled(this.MIND_STATE_KEY, s, 450);
  }

  getMindEvents(): MemoryEvent[] {
    return this.safeGet<MemoryEvent[]>(this.MIND_EVENTS_KEY) ?? [];
  }

  pushMindEvent(ev: MemoryEvent, max = 80): MemoryEvent[] {
    const all = this.getMindEvents();
    const next = [ev, ...all].slice(0, max);

    // ✅ throttle para evitar writes frecuentes
    this.safeSetThrottled(this.MIND_EVENTS_KEY, next, 650);
    return next;
  }

  /** Opcional: si desea limpiar cache http local (si usted lo implementa) */
  tryRemoveCache(prefix = 'sb_http_cache::'): void {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) localStorage.removeItem(k);
      }
    } catch {}
  }
}
