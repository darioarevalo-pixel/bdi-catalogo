// Escribir la PROSA de un producto en TiendaNube: las tres preguntas que se hacen antes de
// pisar el campo `description`, hechas funciones puras.
//
// Está afuera del handler por el mismo motivo que `_desc-talles.js`: adentro sólo se puede
// ejercer con token de TiendaNube y escribiendo en una tienda viva. Acá se corre con
// `node scripts/check-desc-prosa.mjs`, sin credenciales.
//
// 🔴 TiendaNube no tiene historial. Cuando se pisa una descripción, la anterior NO EXISTE en
// ningún lado. De ahí salen las tres preguntas:
//
//   1. `hashDesc` — ¿lo que voy a pisar es lo mismo que el monitor leyó y respaldó? Entre que
//      la pantalla compuso el texto y llega este PUT pueden pasar minutos: alguien pegó una
//      tabla de talles, el local editó a mano, corrió otra pestaña. Si el hash no coincide se
//      muere en 409 y NO se escribe. El respaldo de la fila es de otra versión, así que
//      escribir igual dejaría el único respaldo apuntando a un texto que ya no era.
//   2. `conservaLaTabla` — ¿esto se comió la tabla de talles? Es la pregunta BURDA a propósito:
//      la composición fina la hace `lib/tn-desc/bloques.ts` del monitor, que es donde están los
//      tests. Repetirla acá sería media regla en cada lado. Lo que se chequea de este lado es
//      la consecuencia: si había tabla, tiene que seguir estando.
//   3. `verificado` — ¿la escritura pasó DE VERDAD? Un 200 del PUT no lo prueba. Se relee el
//      producto y se compara con lo que se mandó.

const crypto = require('crypto');
const { RE_BLOQUE } = require('./_desc-talles');

/** La huella de una descripción. Sirve para el compare-and-swap, no para seguridad. */
function hashDesc(html) {
  return crypto.createHash('sha256').update(String(html == null ? '' : html), 'utf8').digest('hex');
}

/**
 * ¿El texto nuevo conserva la tabla de talles que tenía el anterior?
 *
 * Dos niveles, y el primero es el que vale:
 *  - si el anterior tenía el bloque FIRMADO, el nuevo tiene que traerlo byte a byte;
 *  - si tenía una `<table>` sin firma (149 en Zattia), alcanza con que siga habiendo una.
 *
 * ⛔ No dice nada de los `<img>` sueltos: descartar el residuo es una decisión de quien
 * revisa, que la toma en pantalla y viaja en el texto compuesto. Acá no se adivina.
 */
function conservaLaTabla(actual, nuevo) {
  const a = String(actual || ''), n = String(nuevo || '');
  const m = RE_BLOQUE.exec(a);
  if (m) return n.includes(m[0]);
  if (/<table\b/i.test(a)) return /<table\b/i.test(n);
  return true;
}

/**
 * El idioma del campo `description` de TiendaNube, que es un objeto por idioma.
 * Se respeta el que ya tiene el producto: escribir siempre en `es` le crearía una clave
 * nueva a una tienda que hoy guarda en otra.
 */
function idiomaDe(descObj) {
  const o = descObj && typeof descObj === 'object' ? descObj : {};
  return o.es != null ? 'es' : (Object.keys(o)[0] || 'es');
}

module.exports = { hashDesc, conservaLaTabla, idiomaDe };
