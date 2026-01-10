// src/app/service/canvas-fx.service.ts
import { Injectable } from '@angular/core';

type Dot = {
  x: number; y: number;
  r: number;
  vy: number; vx: number;
  wob: number; woSpeed: number;
  a: number;
};

export type FxMode = 'soft' | 'spark' | 'sharp' | 'low' | 'minimal' | 'confetti';

@Injectable({ providedIn: 'root' })
export class CanvasFxService {
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;

  private raf: number | null = null;
  private dots: Dot[] = [];

  // ✅ nuevo: “expresión” del canvas por estado
  private mode: FxMode = 'soft';

  bind(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
  }

  /** Cambia el modo y reconfigura partículas sin reiniciar toda la app */
  setMode(m: FxMode) {
    this.mode = m;
    this.initDots();
  }

  start() {
    this.resize();
    this.initDots();
    this.draw();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private getDpr() {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  private resize() {
    if (!this.canvas || !this.ctx) return;

    const dpr = this.getDpr();
    this.canvas.width = Math.floor(innerWidth * dpr);
    this.canvas.height = Math.floor(innerHeight * dpr);

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  /** Densidad según pantalla + modo (expresión) */
  private density() {
    const base = Math.floor(innerWidth / 10);

    if (this.mode === 'minimal') return Math.max(30, Math.min(60, Math.floor(base * 0.45)));
    if (this.mode === 'low') return Math.max(45, Math.min(85, Math.floor(base * 0.65)));
    if (this.mode === 'spark') return Math.max(90, Math.min(190, Math.floor(base * 1.15)));
    if (this.mode === 'sharp') return Math.max(80, Math.min(170, Math.floor(base * 1.0)));
    if (this.mode === 'confetti') return Math.max(120, Math.min(240, Math.floor(base * 1.35)));

    return Math.max(70, Math.min(160, base));
  }

  private initDots() {
    const n = this.density();

    const speedMul =
      this.mode === 'minimal' ? 0.55 :
      this.mode === 'low' ? 0.75 :
      this.mode === 'spark' ? 1.20 :
      this.mode === 'confetti' ? 1.35 :
      1.0;

    this.dots = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: 0.7 + Math.random() * 1.9,
      vy: (0.45 + Math.random() * 1.55) * speedMul,
      vx: (-0.18 + Math.random() * 0.36) * speedMul,
      wob: Math.random() * Math.PI * 2,
      woSpeed: (0.004 + Math.random() * 0.010) * speedMul,
      a: 0.18 + Math.random() * 0.55,
    }));
  }

  private draw = () => {
    if (!this.ctx) return;

    this.ctx.clearRect(0, 0, innerWidth, innerHeight);

    for (const d of this.dots) {
      d.wob += d.woSpeed;
      d.x += d.vx + Math.sin(d.wob) * 0.28;
      d.y += d.vy;

      if (d.y > innerHeight + 10) { d.y = -10; d.x = Math.random() * innerWidth; }
      if (d.x < -10) d.x = innerWidth + 10;
      if (d.x > innerWidth + 10) d.x = -10;

      this.ctx.beginPath();
      this.ctx.fillStyle = `rgba(255,255,255,${d.a})`;
      this.ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.raf = requestAnimationFrame(this.draw);
  };

  private onResize = () => {
    this.resize();
    this.initDots();
  };

  private onVisibility = () => {
    if (document.hidden && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (!document.hidden && !this.raf) this.draw();
  };
}
