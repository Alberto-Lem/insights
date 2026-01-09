import { Injectable } from '@angular/core';
import { Topic } from '../models/models';
import { randomId } from '../utils/utils';

export type Prefs = { topic?: Topic; musicState?: 'AUTO' | 'ON' | 'OFF' };

@Injectable({ providedIn: 'root' })
export class StorageService {
  readonly PREF_KEY = 'sb_visits_prefs_v1';
  readonly HISTORY_KEY = 'sb_tip_history_v1';
  readonly VISITOR_KEY = 'sb_visitor_id_v1';

  safeGet<T>(key: string): T | null {
    try{
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    }catch{
      return null;
    }
  }

  safeSet(key: string, value: any): void {
    try{ localStorage.setItem(key, JSON.stringify(value)); }catch{}
  }

  getPrefs(): Prefs {
    return this.safeGet<Prefs>(this.PREF_KEY) ?? { topic: 'seguridad', musicState: 'AUTO' };
  }

  setPrefs(p: Prefs): void {
    this.safeSet(this.PREF_KEY, p);
  }

  getHistory(): string[] {
    return this.safeGet<string[]>(this.HISTORY_KEY) ?? [];
  }

  pushHistory(text: string, max = 7): string[] {
    const h = this.getHistory();
    const next = [text, ...h.filter(x => x !== text)].slice(0, max);
    this.safeSet(this.HISTORY_KEY, next);
    return next;
  }

  getVisitorId(): string {
    const stored = this.safeGet<string>(this.VISITOR_KEY);
    if (typeof stored === 'string' && stored.length >= 8) return stored;
    const v = `v_${randomId(22)}`;
    this.safeSet(this.VISITOR_KEY, v);
    return v;
  }
}
