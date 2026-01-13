// src/app/utils/utils.ts

export function pick<T>(arr: T[]): T {
  if (!arr || arr.length === 0) {
    throw new Error('pick(): array vacío');
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomId(len = 20): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const n = Math.max(6, Math.min(120, Math.floor(len || 20)));

  // ✅ Preferido: crypto seguro y uniforme
  const cryptoObj: Crypto | undefined = (globalThis as any)?.crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(n);
    cryptoObj.getRandomValues(bytes);

    let out = '';
    for (let i = 0; i < n; i++) {
      out += chars[bytes[i] % chars.length];
    }
    return out;
  }

  // ✅ Fallback (compat): Math.random
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function getRefFromUrl(href: string): string {
  try {
    const url = new URL(href);
    const ref = (url.searchParams.get('ref') || '').trim().toLowerCase();
    if (ref) return ref.replaceAll(/[^a-z0-9\-_.]/g, '').slice(0, 32) || 'direct';
  } catch {}
  return 'direct';
}
