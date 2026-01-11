// src/app/ui/card-visuals.ts

export type CardTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'NEBULA';
export type CardState = 'IDLE' | 'LISTEN' | 'THINK' | 'SPEAK';

export type CardVisuals = {
  tier: CardTier;
  skinClass: string;   // tier-bronze, tier-silver...
  sigil: string;       // ○ ◎ ⧉ ⟟ ✧ ✦ ⟁ etc
  glow: number;        // 10..100
};

export type BumpKind = 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC' | 'SSE';

export function computeTier(level: number): CardTier {
  const lv = Math.max(1, Number(level || 1));
  return lv >= 13 ? 'NEBULA' : lv >= 8 ? 'GOLD' : lv >= 4 ? 'SILVER' : 'BRONZE';
}

export function computeGlow(pct: number): number {
  const v = Math.max(0, Math.min(100, Number(pct || 0)));
  return Math.max(10, v);
}

/**
 * Sigil “siempre cambiante” (PRO):
 * - Si hay badges, tienen prioridad (compatibilidad).
 * - Si NO hay badges, usa racha + nivel + progreso del nivel.
 */
export function computeSigil(params: {
  tier: CardTier;
  badgesRaw?: unknown;
  streak?: number;
  level?: number;
  progressPct?: number;
}): string {
  const { tier, badgesRaw, streak = 0, level = 1, progressPct = 0 } = params;

  // 1) Compatibilidad: badges si existen
  const list = Array.isArray(badgesRaw) ? badgesRaw : [];
  const badges = new Set<string>(list.map(String));

  if (badges.has('STREAK_14')) return '✦';
  if (badges.has('STREAK_7')) return '✧';
  if (badges.has('SHARE_10')) return '⟟';
  if (badges.has('COPY_10')) return '⧉';

  // 2) Sin badges: reglas por métricas reales
  const s = Math.max(0, Number(streak || 0));
  const lv = Math.max(1, Number(level || 1));
  const pct = Math.max(0, Math.min(100, Number(progressPct || 0)));

  // Racha manda (logro “humano”)
  if (s >= 14) return '✦';
  if (s >= 7) return '✧';

  // Nivel manda (rango)
  if (lv >= 13) return '⟁';
  if (lv >= 8) return '⟟';

  // Progreso dentro del nivel (sensación de avance)
  if (pct >= 85) return '⧉';
  if (pct >= 50) return '◎';

  // Base por tier
  return tier === 'NEBULA' ? '⟁' : '○';
}

export function computeCardVisuals(profile: any, progressPct: number): CardVisuals {
  const level = Number(profile?.level ?? 1);
  const tier = computeTier(level);

  const sigil = computeSigil({
    tier,
    badgesRaw: profile?.badges,
    streak: Number(profile?.streak ?? 0),
    level,
    progressPct,
  });

  const glow = computeGlow(progressPct);

  return {
    tier,
    skinClass: `tier-${tier.toLowerCase()}`,
    sigil,
    glow,
  };
}

export function bumpToState(kind: BumpKind): CardState {
  if (kind === 'COPY_TIP') return 'THINK';
  if (kind === 'SHARE_TIP') return 'SPEAK';
  return 'LISTEN';
}
