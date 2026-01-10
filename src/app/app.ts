// src/app/app.ts
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';

/* ===================== Services ===================== */
import { StorageService } from './service/storage.service';
import { TipsService } from './service/tips.service';
import { VisitsApiService } from './service/visits-api.service';
import { CanvasFxService } from './service/canvas-fx.service';
import { MindService } from './service/mind.service';

/* ✅ Audio Orquestador */
import { AudioService } from './service/audio.service';

/* ===================== Models / Utils ===================== */
import { Insights, Profile, Tip, Topic } from './models/models';
import { getRefFromUrl } from './utils/utils';
import { AudioProfile } from './audio/types-adio';
import type { AudioContextHint } from './audio/audio-engine';

type TipWithId = Tip & { id?: string };

type DecisionMode = 'NORMAL' | 'REDUCED' | 'REST' | 'FOCUS';

type VisitDecisionResponse = {
  mode: DecisionMode;
  maxTipsAllowed: number;
  allowShare: boolean;
  allowNewTip: boolean;
  systemMessage: string;
};

const DEFAULT_DECISION: VisitDecisionResponse = {
  mode: 'NORMAL',
  maxTipsAllowed: 999,
  allowShare: true,
  allowNewTip: true,
  systemMessage: 'Sistema listo.',
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('fxCanvas') fxCanvas?: ElementRef<HTMLCanvasElement>;

  private storage = inject(StorageService);
  private tipsSrv = inject(TipsService);
  private api = inject(VisitsApiService);
  private fx = inject(CanvasFxService);
  private mind = inject(MindService);

  private audio = inject(AudioService);

  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  private readonly PAGE_KEY = 'visits';

  topic: Topic = 'seguridad';
  hint = '';
  currentTip: TipWithId | null = null;

  profile: Profile = {};
  insights: Insights = { activeDaysLast7: 0, peakHoursLast7: [], actionCountsLast7: [] };
  historyCount = 0;

  toastMsg = '';
  toastVisible = false;

  // ✅ ahora lo maneja AudioService
  get musicState() { return this.audio.state; }
  get showAudioBanner() { return this.audio.showBanner; }

  progress = { x: 0, nextLevel: 2, nextGoal: 100, pct: 0, left: 100 };

  actionRows: { label: string; value: number }[] = [];
  hourRows: { key: string; value: number }[] = [];
  peakHourLabel = '—';
  topActionLabel = '—';
  healthHint = '—';

  headerKpis: Array<{ icon: string; label: string; value: string; kind?: 'online' }> = [];

  decision: VisitDecisionResponse = { ...DEFAULT_DECISION };

  onlineNow = 0;
  sseAlive = false;

  private es?: EventSource;
  private lastSseTs = 0;

  private visitorId = '';
  private ref = 'direct';

  private tTrack?: ReturnType<typeof setInterval>;
  private tInsights?: ReturnType<typeof setInterval>;
  private tOnline?: ReturnType<typeof setInterval>;
  private tSseWatch?: ReturnType<typeof setInterval>;

  private mindSub?: Subscription;

  get musicLabel(): string {
    return this.musicState === 'ON'
      ? '🔊 Audio: ON'
      : this.musicState === 'OFF'
      ? '🔇 Audio: OFF'
      : '🔊 Audio: AUTO';
  }

  get decisionLabel(): string {
    const m = this.decision?.mode ?? 'NORMAL';
    return m === 'FOCUS' ? 'FOCUS' : m === 'REST' ? 'REST' : m === 'REDUCED' ? 'REDUCED' : 'NORMAL';
  }

  get canNewTip(): boolean { return !!this.decision?.allowNewTip; }
  get canShare(): boolean { return !!this.decision?.allowShare; }

  get totalView(): string {
    const v = (this.profile as any)?.total;
    return v === null || v === undefined ? '—' : String(v);
  }
  get streakView(): string {
    const v = (this.profile as any)?.streak;
    return v === null || v === undefined ? '—' : String(v);
  }
  get levelView(): string {
    const v = (this.profile as any)?.level;
    return v === null || v === undefined ? '—' : String(v);
  }

  ngOnInit(): void {
    this.ref = getRefFromUrl(location.href);
    this.visitorId = this.storage.getVisitorId();

    const prefs = this.storage.getPrefs();
    this.topic = prefs.topic ?? 'seguridad';

    this.historyCount = this.storage.getTipHistoryIds().length;

    this.mindSub = this.mind.observe().subscribe((state) => {
      this.fx.setMode(this.mind.getFxMode(state.mood));
      this.hint = this.mind.getToneLine(state, this.topic);
      this.ui();
    });

    this.pickNewTip();
    this.ui();
  }

  ngAfterViewInit(): void {
    if (this.fxCanvas?.nativeElement) {
      this.fx.bind(this.fxCanvas.nativeElement);
      this.fx.start();
    }

    // ✅ Audio: init + autokick
    void this.audio.init();
    this.audio.installAutoKick(() => this.toAudioProfile(this.topic), () => this.audioHint());

    void this.loadMe();
    void this.track();
    void this.loadInsights(true);

    this.startRealtimeSse();

    this.tTrack = setInterval(() => void this.track(), 30_000);
    this.tInsights = setInterval(() => void this.loadInsights(false), 25_000);

    this.tSseWatch = setInterval(() => {
      if (!this.sseAlive) return;
      if (Date.now() - this.lastSseTs > 20_000) this.startRealtimeSse();
    }, 10_000);
  }

  ngOnDestroy(): void {
    this.fx.stop();
    this.es?.close();
    this.mindSub?.unsubscribe();

    this.tTrack && clearInterval(this.tTrack);
    this.tInsights && clearInterval(this.tInsights);
    this.tOnline && clearInterval(this.tOnline);
    this.tSseWatch && clearInterval(this.tSseWatch);

    void this.audio.destroy();
  }

  setTopic(t: Topic) {
    this.topic = t;
    this.persistPrefs();

    this.pickNewTip();
    this.mind.ingest('TOPIC', t);
    this.hint = this.mind.getToneLine(this.mind.snapshot(), t);

    // ✅ “color” + perfil (si ya suena, se ajusta; si no, no forza play)
    this.audio.tipChanged(`topic:${t}`);
    this.audio.setProfile(this.toAudioProfile(this.topic), this.audioHint());

    void this.sendEvent('TOPIC');
    this.ui();
  }

  onNewTip() {
    if (!this.canNewTip) {
      this.toast(this.decision?.systemMessage || 'Acción limitada por el sistema.');
      return;
    }
    this.pickNewTip();
    this.mind.ingest('NEW_TIP', this.topic);
    void this.sendEvent('NEW_TIP');
    this.ui();
  }

  async onCopy() {
    const text = this.currentTip ? this.tipsSrv.toText(this.currentTip) : '';
    const ok = await this.copyText(text);

    this.toast(ok ? '✅ Copiado al portapapeles' : '⚠️ No se pudo copiar');
    this.mind.ingest('COPY_TIP', this.topic, ok);

    if (ok && this.currentTip?.id) {
      this.storage.bumpTipStat(this.currentTip.id, 'copied');
      this.audio.signal({ type: 'SESSION_TICK', seconds: 20 });
      await this.sendEvent('COPY_TIP');
    }
  }

  async onShare() {
    if (!this.canShare) {
      this.toast(this.decision?.systemMessage || 'Compartir está limitado por el sistema.');
      return;
    }

    const text = this.currentTip ? this.tipsSrv.toText(this.currentTip) : '';
    if (this.currentTip?.id) this.storage.bumpTipStat(this.currentTip.id, 'shared');

    this.mind.ingest('SHARE_TIP', this.topic, true);
    this.audio.signal({ type: 'SESSION_TICK', seconds: 25 });
    await this.sendEvent('SHARE_TIP');

    const ok = await this.shareNative(text);
    if (!ok) window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  /* ===================== Audio ===================== */
  toggleMusic() {
    void this.audio.toggle(this.toAudioProfile(this.topic), this.audioHint());
    this.persistPrefs();
    this.ui();
  }

  async startMusic(meta?: { userIntent?: boolean }) {
    const ok = await this.audio.start(this.toAudioProfile(this.topic), this.audioHint(), meta);
    if (!ok) this.mind.ingest('AUDIO_BLOCKED', this.topic, false);
    this.persistPrefs();
    this.ui();
  }

  stopMusic() {
    this.audio.stop();
    this.persistPrefs();
    this.ui();
  }

  private toAudioProfile(t: Topic): AudioProfile {
    return t as AudioProfile;
  }

  private audioHint(): AudioContextHint {
    return { sseAlive: this.sseAlive, onlineNow: this.onlineNow, mode: this.decision?.mode ?? 'NORMAL' };
  }

  private syncAudioContext() {
    // ✅ siempre puede ajustar hint sin forzar play
    this.audio.setContextHint(this.audioHint());
  }

  /* ===================== Internals ===================== */
  private pickNewTip() {
    this.currentTip = this.tipsSrv.nextTip(this.topic) as TipWithId;
    this.historyCount = this.storage.getTipHistoryIds().length;
    navigator.vibrate?.(18);

    // ✅ aprendizaje del audio
    this.audio.signal({ type: 'TIP_VIEW', id: this.currentTip?.id });
  }

  private persistPrefs() {
    const prefs = this.storage.getPrefs();
    this.storage.setPrefs({ ...prefs, topic: this.topic, musicState: this.musicState });
  }

  private toast(msg: string) {
    this.toastMsg = msg;
    this.toastVisible = true;
    this.ui();

    setTimeout(() => {
      this.toastVisible = false;
      this.ui();
    }, 1400);
  }

  private computeProgress() {
    const level = Math.max(1, Number((this.profile as any).level ?? 1));
    const xp = Math.max(0, Number((this.profile as any).xp ?? 0));
    const base = (level - 1) * 100;
    const inLevel = Math.max(0, xp - base);

    this.progress = {
      x: xp,
      nextLevel: level + 1,
      nextGoal: level * 100,
      pct: Math.min(100, Math.round((inLevel / 100) * 100)),
      left: Math.max(0, level * 100 - xp),
    };
  }

  private decisionToEmotion(mode: DecisionMode) {
    const s = this.mind.snapshot();
    if (mode === 'REST') this.mind.ingest('REST_MODE', this.topic, true);
    if (mode === 'FOCUS') this.mind.ingest('FOCUS_MODE', this.topic, true);
    if (mode === 'REDUCED') this.mind.ingest('REDUCED_MODE', this.topic, true);
    return s.mood;
  }

  /* ===================== API ===================== */
  private endpoints() {
    return this.api.endpoints(this.PAGE_KEY, this.visitorId);
  }

  private async loadMe() {
    const { me } = this.endpoints();
    const data = await this.api.apiFetch<Profile>(me, this.visitorId);
    if (data) {
      this.profile = data;
      this.computeProgress();
      this.ui();
    }
  }

  private async track() {
    const { track } = this.endpoints();
    const data = await this.api.apiFetch<Profile>(track, this.visitorId);
    if (data) {
      this.profile = data;
      this.computeProgress();
      this.ui();
    }
  }

  private async sendEvent(type: string) {
    const { event } = this.endpoints();
    const payload = { page: this.PAGE_KEY, type, topic: this.topic, ref: this.ref };

    const res = await this.api.apiFetch<Profile>(event, this.visitorId, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (res) {
      this.profile = res;
      this.computeProgress();
    }

    await this.loadInsights(true);
    this.ui();
  }

  private async loadInsights(force: boolean) {
    const now = Date.now();
    const last = Number((this.insights as any)._ts || 0);
    if (!force && now - last < 15_000) return;

    const { insights } = this.endpoints();
    const ins = await this.api.apiFetch<Insights>(insights, this.visitorId);

    this.insights = ins ?? { activeDaysLast7: 0, peakHoursLast7: [], actionCountsLast7: [] };
    (this.insights as any)._ts = now;

    this.deriveInsightsUI();
    this.ui();
  }

  /* ===================== Timezone fix (UTC hour -> local hour) ===================== */
  private utcHourToLocalLabel(utcHour: number): string {
    // Fecha UTC ficticia: el navegador la convierte a hora local
    const d = new Date(Date.UTC(2024, 0, 1, utcHour, 0, 0));
    const localHour = d.getHours(); // ya es local del navegador
    return String(localHour).padStart(2, '0') + ':00';
  }

  private deriveInsightsUI() {
    const nice = (k: string) =>
      k === 'NEW_TIP' ? 'Nuevos tips'
      : k === 'COPY_TIP' ? 'Copias'
      : k === 'SHARE_TIP' ? 'Compartidos'
      : k === 'TOPIC' ? 'Cambios tema'
      : '—';

    this.actionRows = (this.insights.actionCountsLast7 ?? [])
      .slice(0, 5)
      .map((a) => ({ label: nice(a.key), value: Number(a.value || 0) }));

    // ✅ Aquí está la corrección: convertir hora UTC -> hora local
    this.hourRows = (this.insights.peakHoursLast7 ?? [])
      .slice(0, 5)
      .map((h) => ({
        key: this.utcHourToLocalLabel(Number(h.key)),
        value: Number(h.value || 0),
      }));

    this.peakHourLabel = this.hourRows[0]?.key ?? '—';
    this.topActionLabel = this.actionRows[0]?.label ?? '—';
    this.healthHint = this.actionRows.length ? 'Buen balance' : 'Inicie con 1 tip';
  }

  /* ===================== SSE ===================== */
  private startRealtimeSse() {
    const { stream, online } = this.endpoints();

    this.tOnline && clearInterval(this.tOnline);
    this.tOnline = undefined;

    this.ui(() => {
      this.sseAlive = false;
      this.lastSseTs = Date.now();
    });
    this.syncAudioContext();

    this.api.apiFetch<any>(online, this.visitorId)
      .then((o) => o?.online != null && this.ui(() => (this.onlineNow = Number(o.online))))
      .finally(() => this.syncAudioContext());

    this.es?.close();
    this.es = this.api.openSse(stream);

    const parse = (e: MessageEvent) => {
      try { return JSON.parse(String(e.data)); } catch { return null; }
    };

    const markAlive = () => {
      this.lastSseTs = Date.now();
      if (!this.sseAlive) this.sseAlive = true;
    };

    this.es.addEventListener('hello', (e: MessageEvent) => {
      const msg = parse(e);
      this.ui(() => {
        markAlive();
        this.mind.ingest('SSE_UP', this.topic, true);
        if (msg?.online != null) this.onlineNow = Number(msg.online);
      });
      this.syncAudioContext();
    });

    this.es.addEventListener('ping', () => {
      this.ui(() => markAlive());
      this.syncAudioContext();
    });

    this.es.addEventListener('online', (e: MessageEvent) => {
      const msg = parse(e);
      this.ui(() => {
        markAlive();
        if (msg?.online != null) this.onlineNow = Number(msg.online);
      });
      this.syncAudioContext();
    });

    this.es.addEventListener('profile', (e: MessageEvent) => {
      const p = parse(e);
      if (!p) return;
      this.ui(() => {
        markAlive();
        this.profile = p;
        this.computeProgress();
      });
    });

    this.es.addEventListener('insights', (e: MessageEvent) => {
      const i = parse(e);
      if (!i) return;
      this.ui(() => {
        markAlive();
        this.insights = i;
        this.deriveInsightsUI();
      });
    });

    this.es.addEventListener('decision', (e: MessageEvent) => {
      const d = parse(e) as VisitDecisionResponse | null;
      if (!d) return;

      this.ui(() => {
        markAlive();
        this.decision = {
          mode: (d.mode ?? 'NORMAL') as DecisionMode,
          maxTipsAllowed: Number(d.maxTipsAllowed ?? 999),
          allowShare: !!d.allowShare,
          allowNewTip: !!d.allowNewTip,
          systemMessage: String(d.systemMessage ?? 'Sistema listo.'),
        };

        const mood = this.decisionToEmotion(this.decision.mode);
        this.fx.setMode(this.mind.getFxMode(mood));
      });

      this.syncAudioContext();
    });

    this.es.onerror = () => {
      this.ui(() => {
        this.sseAlive = false;
        this.mind.ingest('SSE_DOWN', this.topic, false);
      });
      this.syncAudioContext();

      this.es?.close();
      this.es = undefined;

      this.tOnline = setInterval(async () => {
        const o = await this.api.apiFetch<any>(online, this.visitorId);
        if (o?.online != null) {
          this.ui(() => (this.onlineNow = Number(o.online)));
          this.syncAudioContext();
        }
      }, 12_000);

      setTimeout(() => this.startRealtimeSse(), 1500);
    };
  }

  private refreshHeaderKpis() {
    this.headerKpis = [
      { icon: '👁️', label: 'Visitas', value: this.totalView },
      { icon: '🟢', label: 'Online', value: String(this.onlineNow ?? 0), kind: 'online' },
      { icon: '🔥', label: 'Racha', value: this.streakView },
      { icon: '⭐', label: 'Nivel', value: this.levelView },
    ];
  }

  private async copyText(text: string) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { return false; }
  }

  private async shareNative(text: string) {
    try { await (navigator as any).share?.({ text }); return true; }
    catch { return false; }
  }

  private ui(fn?: () => void) {
    this.zone.run(() => {
      fn?.();
      this.refreshHeaderKpis();
      this.cdr.markForCheck();
    });
  }
}
