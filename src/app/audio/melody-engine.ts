// src/app/audio/melody-engine.ts
export class MelodyEngine {
  private lastMidi = 60;
  private hold = 0;

  reset(seedLike?: number) {
    this.lastMidi = 60 + ((seedLike ?? 0) % 5);
    this.hold = 0;
  }

  pickNext(chordSet: number[], rand: () => number): number {
    // ✅ si hay "hold", mantiene la nota para que suene más fraseado
    if (this.hold > 0) {
      this.hold--;
      return this.lastMidi;
    }

    const base = chordSet;

    const cand = [
      ...base,
      ...base.map(m => m + 2),
      ...base.map(m => m - 2),
      // ✅ micro-variación de octava ocasional
      ...(rand() < 0.18 ? base.map(m => m + 12) : []),
      ...(rand() < 0.10 ? base.map(m => m - 12) : []),
    ].filter(m => m >= 60 && m <= 84);

    let best = cand[0] ?? this.lastMidi;
    let bestScore = -1e9;

    for (const m of cand) {
      const jump = Math.abs(m - this.lastMidi);

      // ✅ penaliza repetición directa, pero no la prohíbe
      const repeatPenalty = (m === this.lastMidi) ? 0.40 : 0;

      // ✅ penaliza saltos grandes
      const jumpPenalty = Math.max(0, (jump - 3) / 10) * 0.60;

      // ✅ premia notas del acorde (más “musical”)
      const chordBonus = chordSet.includes(m) ? 0.40 : 0.10;

      // ✅ menos ruido aleatorio para que la decisión pese más
      const score = chordBonus - repeatPenalty - jumpPenalty + (rand() - 0.5) * 0.10;

      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }

    this.lastMidi = best;

    // ✅ decide si “sostiene” la nota 1–2 pasos (fraseo)
    const holdChance = chordSet.includes(best) ? 0.35 : 0.18;
    if (rand() < holdChance) this.hold = (rand() < 0.65) ? 1 : 2;

    return best;
  }
}
