/**
 * El arnés de `api/_desc-talles.js`. `node scripts/check-desc-talles.mjs` — sin dependencias,
 * sin token de TiendaNube y sin escribir en ninguna tienda.
 *
 * Este repo no tiene runner de tests: por eso el chequeo es un archivo que se corre a mano y
 * **sale con código distinto de 0 si algo falla**. Mirar la última línea no alcanza (un
 * proceso que no ejerció nada también imprime lindo): el oráculo es `echo $?`.
 *
 * 🔴 El caso que motivó todo esto es el ÚLTIMO: pegar la tabla de talles a un producto que ya
 * tenía la prosa publicada le borraba la prosa entera, y TiendaNube no tiene historial.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { armarDescripcion } = require('../api/_desc-talles.js');

const TABLA = '<div style="font-family:Arial;max-width:680px;margin:0 auto;"><h3>Tabla de talles</h3><table><tr><td>S</td></tr></table></div>';
const TABLA2 = '<div style="font-family:Arial;max-width:680px;margin:0 auto;"><h3>Tabla de talles</h3><table><tr><td>M</td></tr></table></div>';
/** La salida REAL de `generarHtml` del monitor. El `max-width:680px` es la firma que se pisaba. */
const PROSA =
  '<!--AREBEN-PROSA-INI--><div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#222;">' +
  '<p style="font-size:15px;line-height:1.6;margin:0 0 12px;">Camisa de gasa liviana que cae sola.</p>' +
  '<ul style="font-size:14px;"><li><b>Tela:</b> gasa liviana</li></ul></div><!--AREBEN-PROSA-FIN-->';

let fallas = 0;
const caso = (nombre, fn) => {
  try { fn(); console.log('  ok  ' + nombre); }
  catch (e) { fallas++; console.log('FALLA  ' + nombre + '\n       ' + e.message.split('\n')[0]); }
};

caso('una descripción vacía queda con la tabla sola', () => {
  const { nuevo, reemplazo } = armarDescripcion('', TABLA);
  assert.equal(reemplazo, false);
  assert.ok(nuevo.startsWith('<!--AREBEN-TALLES-INI-->'));
});

caso('la prosa vieja sin marcar se conserva, y la tabla va abajo', () => {
  const { nuevo } = armarDescripcion('<h5>Top de red.</h5>', TABLA);
  assert.ok(nuevo.includes('<h5>Top de red.</h5>'));
  assert.ok(nuevo.indexOf('Top de red') < nuevo.indexOf('AREBEN-TALLES-INI'));
});

caso('una tabla firmada anterior se REEMPLAZA, no se duplica', () => {
  const uno = armarDescripcion('<h5>Top de red.</h5>', TABLA).nuevo;
  const dos = armarDescripcion(uno, TABLA2);
  assert.equal(dos.reemplazo, true);
  assert.equal(dos.nuevo.match(/AREBEN-TALLES-INI/g).length, 1);
  assert.ok(dos.nuevo.includes('<td>M</td>'));
  assert.ok(!dos.nuevo.includes('<td>S</td>'));
});

caso('una <table> legacy suelta (149 en Zattia) se reemplaza también', () => {
  const legacy = '<div dir="ltr"><table border="1pt"><tbody><tr><td>TALLE</td></tr></tbody></table></div>';
  const { nuevo, reemplazo } = armarDescripcion(legacy, TABLA);
  assert.equal(reemplazo, true);
  assert.ok(!nuevo.includes('TALLE</td>'));
});

caso('un <img> suelto (19 de los 369 publicados) NO se pierde', () => {
  const { nuevo } = armarDescripcion('<img src="https://x/foto.jpg">', TABLA);
  assert.ok(nuevo.includes('<img src="https://x/foto.jpg">'));
});

// 🔴 El caso que motivó el arreglo.
caso('EL BLOQUE DE PROSA SOBREVIVE a que le peguen la tabla de talles', () => {
  const { nuevo } = armarDescripcion(PROSA, TABLA);
  assert.ok(nuevo.includes('Camisa de gasa liviana que cae sola.'), 'se comió la prosa');
  assert.ok(nuevo.includes('<b>Tela:</b> gasa liviana'), 'se comió los bullets');
  assert.ok(nuevo.indexOf('AREBEN-PROSA-INI') < nuevo.indexOf('AREBEN-TALLES-INI'), 'la prosa va arriba');
});

caso('y sobrevive también cuando ya había una tabla puesta', () => {
  const conTabla = armarDescripcion(PROSA, TABLA).nuevo;
  const { nuevo, reemplazo } = armarDescripcion(conTabla, TABLA2);
  assert.equal(reemplazo, true);
  assert.ok(nuevo.includes('Camisa de gasa liviana que cae sola.'));
  assert.equal(nuevo.match(/AREBEN-PROSA-INI/g).length, 1);
  assert.equal(nuevo.match(/AREBEN-TALLES-INI/g).length, 1);
  assert.ok(nuevo.includes('<td>M</td>'));
});

caso('es idempotente: pegar dos veces la misma tabla da lo mismo', () => {
  const uno = armarDescripcion(PROSA + '<h5>Top de red.</h5>', TABLA).nuevo;
  const dos = armarDescripcion(uno, TABLA).nuevo;
  assert.equal(dos, uno);
});

console.log(fallas ? `\n${fallas} FALLA(S)` : '\ntodo en pie');
process.exit(fallas ? 1 : 0);
