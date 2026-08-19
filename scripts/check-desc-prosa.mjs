/**
 * El arnés de `api/_desc-prosa.js` — las tres preguntas que se hacen antes de pisar la
 * descripción de un producto. `node scripts/check-desc-prosa.mjs`, sin credenciales.
 *
 * Sale con código distinto de 0 si algo falla: el oráculo es `echo $?`, no la última línea.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hashDesc, conservaLaTabla, idiomaDe } = require('../api/_desc-prosa.js');
const { armarDescripcion } = require('../api/_desc-talles.js');

const PROSA =
  '<!--AREBEN-PROSA-INI--><div style="max-width:680px;"><p>Camisa de gasa liviana.</p></div><!--AREBEN-PROSA-FIN-->';
const TABLA = '<div style="max-width:680px"><h3>Tabla</h3><table><tr><td>S</td></tr></table></div>';

let fallas = 0;
const caso = (nombre, fn) => {
  try { fn(); console.log('  ok  ' + nombre); }
  catch (e) { fallas++; console.log('FALLA  ' + nombre + '\n       ' + e.message.split('\n')[0]); }
};

caso('el hash distingue dos textos que difieren en un carácter', () => {
  assert.notEqual(hashDesc('<p>hola</p>'), hashDesc('<p>hola.</p>'));
  assert.equal(hashDesc('<p>hola</p>'), hashDesc('<p>hola</p>'));
});

caso('null, undefined y vacío hashean IGUAL: los tres son «no hay descripción»', () => {
  // 41 publicados de Zattia están así. Si el vacío hasheara distinto del null, el
  // compare-and-swap fallaría justo en los que más falta hacen.
  assert.equal(hashDesc(null), hashDesc(''));
  assert.equal(hashDesc(undefined), hashDesc(''));
});

caso('el bloque de talles FIRMADO tiene que viajar byte a byte', () => {
  const actual = armarDescripcion('<h5>Top de red.</h5>', TABLA).nuevo;
  const bien = armarDescripcion(actual, TABLA).nuevo; // idempotente: la conserva
  assert.equal(conservaLaTabla(actual, bien), true);
  assert.equal(conservaLaTabla(actual, PROSA), false, 'tirar la tabla tiene que dar false');
  // Una tabla PARECIDA pero no la misma tampoco pasa: es byte a byte a propósito.
  const otra = armarDescripcion('', TABLA.replace('<td>S</td>', '<td>M</td>')).nuevo;
  assert.equal(conservaLaTabla(actual, otra), false);
});

caso('una <table> legacy sin firma: alcanza con que siga habiendo una', () => {
  const legacy = '<div dir="ltr"><table border="1pt"><tr><td>TALLE</td></tr></table></div>';
  assert.equal(conservaLaTabla(legacy, PROSA + legacy), true);
  assert.equal(conservaLaTabla(legacy, PROSA), false);
});

caso('sin tabla anterior no hay nada que conservar', () => {
  assert.equal(conservaLaTabla('', PROSA), true);
  assert.equal(conservaLaTabla('<h5>Top de red.</h5>', PROSA), true);
});

caso('el idioma es el que YA tiene el producto, no siempre «es»', () => {
  assert.equal(idiomaDe({ es: 'hola', pt: 'oi' }), 'es');
  assert.equal(idiomaDe({ pt: 'oi' }), 'pt');
  assert.equal(idiomaDe({}), 'es');
  assert.equal(idiomaDe(null), 'es');
  // ⚠️ `es: ''` es un idioma que existe y está vacío — es el caso de los 41 mudos.
  assert.equal(idiomaDe({ es: '', pt: 'oi' }), 'es');
});

console.log(fallas ? `\n${fallas} FALLA(S)` : '\ntodo en pie');
process.exit(fallas ? 1 : 0);
