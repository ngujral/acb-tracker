// Encrypted backup: PBKDF2-SHA256 -> AES-256-GCM, using the browser's Web Crypto API.
const ITERATIONS = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  // chunked base64 to avoid call-stack limits on large backups
  const bytes = new Uint8Array(ct);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return JSON.stringify({ app: 'acb-tracker', v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: btoa(s) });
}

export async function decryptBackup(text, passphrase) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('This is not a backup file.'); }
  if (file.app !== 'acb-tracker') throw new Error('This is not a backup from this app.');
  const key = await keyFrom(passphrase, unb64(file.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, key, unb64(file.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged.');
  }
}
