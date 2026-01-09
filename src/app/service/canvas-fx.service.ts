import { Injectable } from '@angular/core';

type Dot = { x:number; y:number; r:number; vy:number; vx:number; wob:number; woSpeed:number; a:number };

@Injectable({ providedIn: 'root' })
export class CanvasFxService {
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private raf: number | null = null;
  private dots: Dot[] = [];

  bind(canvas: HTMLCanvasElement){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
  }

  start(){
    this.resize();
    this.initDots();
    this.draw();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(){
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private getDpr(){ return Math.min(2, window.devicePixelRatio || 1); }

  private resize(){
    if (!this.canvas || !this.ctx) return;
    const dpr = this.getDpr();
    this.canvas.width = Math.floor(innerWidth * dpr);
    this.canvas.height = Math.floor(innerHeight * dpr);
    this.ctx.setTransform(1,0,0,1,0,0);
    this.ctx.scale(dpr, dpr);
  }

  private density(){
    const base = Math.floor(innerWidth / 10);
    return Math.max(70, Math.min(160, base));
  }

  private initDots(){
    const n = this.density();
    this.dots = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: 0.7 + Math.random() * 1.9,
      vy: 0.45 + Math.random() * 1.55,
      vx: -0.18 + Math.random() * 0.36,
      wob: Math.random() * Math.PI * 2,
      woSpeed: 0.004 + Math.random() * 0.010,
      a: 0.18 + Math.random() * 0.55,
    }));
  }

  private draw = () => {
    if (!this.ctx) return;
    this.ctx.clearRect(0,0, innerWidth, innerHeight);

    for (const d of this.dots){
      d.wob += d.woSpeed;
      d.x += d.vx + Math.sin(d.wob) * 0.28;
      d.y += d.vy;

      if (d.y > innerHeight + 10){ d.y = -10; d.x = Math.random() * innerWidth; }
      if (d.x < -10) d.x = innerWidth + 10;
      if (d.x > innerWidth + 10) d.x = -10;

      this.ctx.beginPath();
      this.ctx.fillStyle = `rgba(255,255,255,${d.a})`;
      this.ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.raf = requestAnimationFrame(this.draw);
  };

  private onResize = () => { this.resize(); this.initDots(); };

  private onVisibility = () => {
    if (document.hidden && this.raf){ cancelAnimationFrame(this.raf); this.raf = null; }
    if (!document.hidden && !this.raf) this.draw();
  };
}
