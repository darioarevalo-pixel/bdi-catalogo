// Cómo queda el campo `description` de un producto de TiendaNube cuando se le pega la
// TABLA DE TALLES, sin comerse nada de lo que ya había.
//
// Está afuera de `tn-categorias.js` por una sola razón: **para poder ejercerlo**. Adentro
// del handler esta regla sólo se puede probar con token de TiendaNube y escribiendo en una
// tienda viva; acá se corre con `node scripts/check-desc-talles.mjs`, sin credenciales y sin
// tocar nada. Es un archivo `_`: Vercel no lo toma como ruta y no cuenta contra el límite de
// 12 funciones del plan.
//
// 🔴 EL ORDEN ES LA REGLA, y hay TRES cosas apelmazadas en ese único campo:
//   1. el bloque de PROSA firmado, que escribe Redacción (`monitor-areben`),
//   2. la tabla de talles, que escribe esto,
//   3. el residuo: la prosa vieja sin marcar y los `<img>` sueltos (19 de los 369
//      publicados de Zattia tienen uno, medido el 19-ago-2026).
//
// 🔴 El bloque de PROSA sale del camino ANTES de tocar los wrappers, y vuelve después. El
// motivo es concreto: `generarHtml` del monitor envuelve la prosa en un
// `<div style="…max-width:680px…">`, que es LA MISMA FIRMA con la que `removeWrappers`
// reconoce el envoltorio del generador viejo de talles. Sin sacarlo primero, pegar una
// tabla de talles a un producto ya redactado dejaba `<!--PROSA-INI--><!--PROSA-FIN-->`
// vacío y **borraba la prosa entera** — y TiendaNube no tiene historial, así que ese texto
// no está en ningún otro lado. Verificado con el código exacto de antes del arreglo.
//
// 🔑 El orden de salida (prosa → residuo → tabla) es el mismo que compone
// `lib/tn-desc/bloques.ts` del monitor: la clienta lee primero lo que vende.

const MARK_INI = '<!--AREBEN-TALLES-INI-->', MARK_FIN = '<!--AREBEN-TALLES-FIN-->';
const RE_BLOQUE = /<!--AREBEN-TALLES-INI-->[\s\S]*?<!--AREBEN-TALLES-FIN-->/;
/** La firma de la prosa. Espejo de `PROSA_INI/FIN` de `monitor-areben/lib/tn-desc/formato.core.js`. */
const RE_PROSA = /<!--AREBEN-PROSA-INI-->[\s\S]*?<!--AREBEN-PROSA-FIN-->/;
const RE_TABLA = /<table[\s\S]*?<\/table>/i;

// Saca un wrapper del generador (div con max-width:680px) contando el balance de <div>.
function removeOneWrapper(html) {
  const m = /<div[^>]*max-width:\s*680px[^>]*>/i.exec(html);
  if (!m) return html;
  let depth = 1; const re = /<\/?div\b[^>]*>/gi; re.lastIndex = m.index + m[0].length;
  let mm;
  while ((mm = re.exec(html))) {
    if (mm[0].slice(0, 2).toLowerCase() === '</') depth--; else depth++;
    if (depth === 0) return html.slice(0, m.index) + html.slice(mm.index + mm[0].length);
  }
  return html; // sin cierre balanceado → no tocar
}
function removeWrappers(html) { let out = html, prev; do { prev = out; out = removeOneWrapper(out); } while (out !== prev); return out; }

/**
 * La descripción nueva, con la tabla puesta y la anterior sacada.
 * Devuelve `{ nuevo, reemplazo }` — `reemplazo` es si había una tabla antes (para el mensaje).
 */
function armarDescripcion(actual, tablaHtml) {
  const act = String(actual || '');
  const tabla = String(tablaHtml || '');

  // 1. La prosa firmada se guarda aparte y no pasa por NADA de lo de abajo.
  const mProsa = RE_PROSA.exec(act);
  const prosa = mProsa ? mProsa[0] : '';
  const sinProsa = mProsa ? act.slice(0, mProsa.index) + act.slice(mProsa.index + mProsa[0].length) : act;

  const yaMarcado = tabla.match(RE_BLOQUE);
  const bloque = yaMarcado ? yaMarcado[0] : (MARK_INI + tabla.trim() + MARK_FIN);

  // 2. Sacar la tabla anterior: bloque marcado → wrapper(s) del generador → <table> suelta.
  let base = sinProsa.replace(RE_BLOQUE, '');
  const sinWrap = removeWrappers(base);
  let reemplazo = RE_BLOQUE.test(sinProsa) || sinWrap !== base;
  base = sinWrap;
  if (!reemplazo && RE_TABLA.test(base)) { base = base.replace(RE_TABLA, ''); reemplazo = true; }
  base = base.trim();

  // 3. Prosa arriba, residuo en el medio, tabla abajo.
  const cuerpo = base ? base + '\n' + bloque : bloque;
  return { nuevo: prosa ? prosa + '\n' + cuerpo : cuerpo, reemplazo };
}

module.exports = { armarDescripcion, MARK_INI, MARK_FIN, RE_BLOQUE, RE_PROSA };
