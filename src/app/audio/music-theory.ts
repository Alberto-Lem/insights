// src/app/audio/music-theory.ts

export function hzToMidi(hz: number): number {
  // 69 = A4 (440Hz)
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function clampMidi(m: number): number {
  // MIDI estándar 0..127
  return Math.max(0, Math.min(127, m));
}

/**
 * Construye una triada (3 notas) en MIDI a partir de:
 * - rootHz: frecuencia raíz
 * - scale: semitonos relativos (ej: mayor [0,2,4,5,7,9,11])
 * - degree: grado dentro de la escala
 *
 * Devuelve MIDI ENTERO (crítico para que MelodyEngine "haga caso").
 */
export function buildTriadMidi(rootHz: number, scale: number[], degree: number): number[] {
  const len = Math.max(1, scale.length);
  const deg = ((degree % len) + len) % len;

  const i0 = deg;
  const i1 = (deg + 2) % len;
  const i2 = (deg + 4) % len;

  let s0 = scale[i0] ?? 0;
  let s1 = scale[i1] ?? 0;
  let s2 = scale[i2] ?? 0;

  // Ordena a 3ra y 5ta por encima
  while (s1 < s0) s1 += 12;
  while (s2 < s1) s2 += 12;

  const hzA = rootHz * Math.pow(2, s0 / 12);
  const hzB = rootHz * Math.pow(2, s1 / 12);
  const hzC = rootHz * Math.pow(2, s2 / 12);

  // ✅ IMPORTANTE: MIDI entero para que chordSet.includes() funcione
  const midis = [hzToMidi(hzA), hzToMidi(hzB), hzToMidi(hzC)]
    .map(m => clampMidi(Math.round(m)));

  // Sube/baja a rango melódico agradable (C4..C6 aprox)
  return midis.map(m => {
    let x = m;
    while (x < 60) x += 12;
    while (x > 84) x -= 12;
    return clampMidi(x);
  });
}
