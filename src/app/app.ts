import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { StorageService } from './service/storage.service';
import { TipsService } from './service/tips.service';
import { VisitsApiService } from './service/visits-api.service';
import { CanvasFxService } from './service/canvas-fx.service';
import { AudioService } from './service/audio.service';
import { Insights, Profile, Tip, Topic } from './models/models';
import { CommonModule } from '@angular/common';
import { getRefFromUrl } from './utils/utils';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('fxCanvas') fxCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('bgMusic') bgMusic?: ElementRef<HTMLAudioElement>;

  private storage = inject(StorageService);
  private tipsSrv = inject(TipsService);
  private api = inject(VisitsApiService);
  private fx = inject(CanvasFxService);
  private audioSrv = inject(AudioService);

  private readonly PAGE_KEY = 'visits';

  topic: Topic = 'seguridad';
  hint = '';
  currentTip: Tip | null = null;

  profile: Profile = {};
  insights: Insights = {};
  historyCount = 0;

  toastMsg = '';
  toastVisible = false;

  musicState: 'AUTO' | 'ON' | 'OFF' = 'AUTO';
  showAudioBanner = false;

  progress = { x: 0, nextLevel: 2, nextGoal: 100, pct: 0, left: 100 };

  actionRows: { label: string; value: number }[] = [];
  hourRows: { key: string; value: number }[] = [];
  peakHourLabel = '—';
  topActionLabel = '—';
  healthHint = '—';

  private visitorId = '';
  private ref = 'direct';
  private tTrack: any = null;
  private tInsights: any = null;

  get musicLabel() {
    return this.musicState === 'ON'
      ? '🔊 Música: ON'
      : this.musicState === 'OFF'
      ? '🔇 Música: OFF'
      : '🔊 Música: AUTO';
  }

  ngOnInit(): void {
    this.ref = getRefFromUrl(location.href);
    this.visitorId = this.storage.getVisitorId();

    const prefs = this.storage.getPrefs();
    this.topic = prefs.topic ?? 'seguridad';
    this.musicState = prefs.musicState ?? 'AUTO';

    this.hint = this.tipsSrv.getHint(this.topic);
    this.historyCount = this.storage.getHistory().length;

    this.newTip();
  }

  ngAfterViewInit(): void {
    if (this.fxCanvas?.nativeElement) {
      this.fx.bind(this.fxCanvas.nativeElement);
      this.fx.start();
    }

    if (this.bgMusic?.nativeElement) {
      this.audioSrv.bind(this.bgMusic.nativeElement);
      this.audioSrv.installAutoKick(() => {
        if (this.musicState === 'AUTO') void this.startMusic();
      });
    }

    void this.loadMe();
    void this.track();
    void this.loadInsights(true);

    this.tTrack = setInterval(() => void this.track(), 30_000);
    this.tInsights = setInterval(() => void this.loadInsights(false), 45_000);
  }

  ngOnDestroy(): void {
    this.fx.stop();
    if (this.tTrack) clearInterval(this.tTrack);
    if (this.tInsights) clearInterval(this.tInsights);
  }

  // ===== UI =====
  setTopic(t: Topic) {
    this.topic = t;
    this.hint = this.tipsSrv.getHint(t);
    this.persistPrefs();
    this.newTip();
  }

  onNewTip() {
    this.newTip();
    void this.sendEvent('NEW_TIP');
    void this.loadInsights(true);
  }

  async onCopy() {
    const text = this.currentTip ? this.tipsSrv.toText(this.currentTip) : '';
    const ok = await this.copyText(text);
    this.toast(ok ? '✅ Copiado al portapapeles' : '⚠️ No se pudo copiar');
    if (ok) await this.sendEvent('COPY_TIP');
    await this.loadInsights(true);
  }

  async onShare() {
    const text = this.currentTip ? this.tipsSrv.toText(this.currentTip) : '';
    const ok = await this.shareNative(text);
    if (!ok) {
      await this.sendEvent('SHARE_TIP', 'whatsapp');
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    } else {
      await this.sendEvent('SHARE_TIP');
    }
    await this.loadInsights(true);
  }

  refreshInsights() {
    void this.loadInsights(true);
    this.toast('📊 Estadísticas actualizadas');
  }

  toggleMusic() {
    this.musicState === 'ON' ? this.stopMusic() : void this.startMusic();
  }

  async startMusic() {
    const ok = await this.audioSrv.start();
    if (ok) {
      this.musicState = 'ON';
      this.showAudioBanner = false;
    } else {
      this.musicState = 'AUTO';
      this.showAudioBanner = true;
    }
    this.persistPrefs();
  }

  stopMusic() {
    this.audioSrv.stop();
    this.musicState = 'OFF';
    this.showAudioBanner = false;
    this.persistPrefs();
  }

  // ===== internals =====
  private newTip() {
    this.currentTip = this.tipsSrv.newTip(this.topic);
    const text = this.tipsSrv.toText(this.currentTip);
    const h = this.storage.pushHistory(text, 7);
    this.historyCount = h.length;
    if (navigator.vibrate) navigator.vibrate(18);
  }

  private persistPrefs() {
    this.storage.setPrefs({ topic: this.topic, musicState: this.musicState });
  }

  private toast(msg: string) {
    this.toastMsg = msg;
    this.toastVisible = true;
    setTimeout(() => (this.toastVisible = false), 1400);
  }

  private computeProgress() {
    const level = Math.max(1, Number(this.profile.level ?? 1));
    const xp = Math.max(0, Number(this.profile.xp ?? 0));
    const nextGoal = level * 100;
    const base = (level - 1) * 100;
    const inLevel = Math.max(0, xp - base);
    const pct = Math.max(0, Math.min(100, Math.round((inLevel / 100) * 100)));
    const left = Math.max(0, nextGoal - xp);

    this.progress = { x: xp, nextLevel: level + 1, nextGoal, pct, left };
  }

  private endpoints() {
    return this.api.endpoints(this.PAGE_KEY);
  }

  private async loadMe() {
    try {
      const { me } = this.endpoints();
      const data = await this.api.apiFetch<any>(me, this.visitorId, { method: 'GET' });
      if (data) {
        this.profile = data;
        this.computeProgress();
      }
    } catch {}
  }

  private async track() {
    try {
      const { track } = this.endpoints();
      const data = await this.api.apiFetch<any>(track, this.visitorId, { method: 'GET' });
      if (data) {
        this.profile = data;
        this.computeProgress();
      }
    } catch {}
  }

  private async sendEvent(type: string, refOverride?: string) {
    const { event } = this.endpoints();
    const payload = {
      page: this.PAGE_KEY,
      type,
      topic: this.topic,
      ref: refOverride || this.ref || 'direct',
    };
    try {
      const res = await this.api.apiFetch<any>(event, this.visitorId, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res) {
        this.profile = res;
        this.computeProgress();
      }
    } catch {}
  }

  private async loadInsights(force: boolean) {
    const now = Date.now();
    if (!force && this.insights?._ts && now - this.insights._ts < 15_000) return;

    try {
      const { insights } = this.endpoints();
      const ins = await this.api.apiFetch<any>(insights, this.visitorId, { method: 'GET' });
      if (ins) {
        ins._ts = now;
        this.insights = ins;
      }
      this.deriveInsightsUI();
    } catch {}
  }

  private deriveInsightsUI() {
    const actions = (this.insights.actionCountsLast7 ?? []).slice(0, 5);
    const hours = (this.insights.peakHoursLast7 ?? []).slice(0, 5);

    const nice = (k: string) => {
      const key = String(k || '').toUpperCase();
      if (key === 'NEW_TIP') return 'Nuevos tips';
      if (key === 'COPY_TIP') return 'Copias';
      if (key === 'SHARE_TIP') return 'Compartidos';
      return key || '—';
    };

    const calcBalance = () => {
      const counts: Record<string, number> = {};
      for (const p of this.insights.actionCountsLast7 ?? []) counts[p.key] = Number(p.value || 0);
      const nt = Number(counts['NEW_TIP'] || 0);
      const cp = Number(counts['COPY_TIP'] || 0);
      const sh = Number(counts['SHARE_TIP'] || 0);
      if (sh >= 12 && nt + cp <= 6) return 'Aumente aprendizaje';
      if (nt + cp >= 10 && sh <= 2) return 'Comparta 1 tip';
      if (nt + cp + sh === 0) return 'Inicie con 1 tip';
      return 'Buen balance';
    };

    this.actionRows = actions.map((a) => ({ label: nice(a.key), value: Number(a.value || 0) }));
    this.hourRows = hours.map((h) => ({
      key: String(h.key).padStart(2, '0') + ':00',
      value: Number(h.value || 0),
    }));

    this.peakHourLabel = hours[0] ? String(hours[0].key).padStart(2, '0') + ':00' : '—';
    this.topActionLabel = actions[0] ? nice(actions[0].key) : '—';
    this.healthHint = calcBalance();
  }

  private async copyText(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  private async shareNative(text: string) {
    if ((navigator as any).share) {
      try {
        await (navigator as any).share({ text });
        return true;
      } catch {}
    }
    return false;
  }
}
