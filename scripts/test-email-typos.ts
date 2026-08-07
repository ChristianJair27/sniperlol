// scripts/test-email-typos.ts — prueba rápida del corrector de typos de email.
// Uso: npx tsx scripts/test-email-typos.ts
import { fixCommonEmailTypos as f } from '../src/services/mail.service.js';

const cases: Array<[string, string, boolean]> = [
  ['aramperez9@icloud.con', 'aramperez9@icloud.com', true],
  ['Juan@GMAIL.CON ', 'juan@gmail.com', true],
  ['pepe@gmial.com', 'pepe@gmail.com', true],
  ['ana@hotmial.com', 'ana@hotmail.com', true],
  ['luis@gmail.co', 'luis@gmail.com', true],
  ['x@outlok.com', 'x@outlook.com', true],
  ['y@yahho.com', 'y@yahoo.com', true],
  ['z@icloud.cmo', 'z@icloud.com', true],
  // NO deben tocarse (TLDs reales / dominios legítimos):
  ['legit@empresa.co', 'legit@empresa.co', false],
  ['ceo@startup.cm', 'ceo@startup.cm', false],
  ['normal@gmail.com', 'normal@gmail.com', false],
  ['uni@itesm.mx', 'uni@itesm.mx', false],
  ['contact@convergencia.com', 'contact@convergencia.com', false],
  ['sin-arroba', 'sin-arroba', false],
];

let ok = 0;
for (const [input, expected, expectFixed] of cases) {
  const r = f(input);
  const pass = r.email === expected && r.fixed === expectFixed;
  console.log(pass ? 'OK  ' : 'FAIL', JSON.stringify(input), '→', r.email, r.fixed ? '(corregido)' : '');
  if (pass) ok++;
}
console.log(`${ok}/${cases.length} casos`);
process.exit(ok === cases.length ? 0 : 1);
