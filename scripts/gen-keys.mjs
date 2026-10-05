// PT-05: sinh cặp khoá RSA cho JWT RS256 và ghi vào .env (khoá riêng chỉ Aggregator dùng, khoá công khai cho các node).
//   node scripts/gen-keys.mjs
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keys = { JWT_PRIVATE_KEY_B64: privateKey, JWT_PUBLIC_KEY_B64: publicKey };
let env = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
for (const [k, pem] of Object.entries(keys)) {
  const line = `${k}=${Buffer.from(pem).toString('base64')}`;
  env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${env.trimEnd()}\n${line}\n`;
}
writeFileSync(file, env);
console.log('Đã ghi cặp khoá RS256 vào .env. Chạy lại: docker compose up -d');
