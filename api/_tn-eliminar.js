// Eliminar productos de TiendaNube — la acción `eliminar` de `tn-categorias.js`.
//
// La usa la sección «Productos caducados» del monitor: lo que no tiene stock y no se vende hace
// más de 30 días (el plazo máximo de cambio). Vive en un `_` aparte para poder correr las
// reglas sin token ni tienda: `node scripts/check-tn-eliminar.mjs`.
//
// 🔴 ELIMINAR EN TIENDANUBE NO TIENE VUELTA ATRÁS, y TN no guarda historial. Por eso cada
// producto pasa por cuatro frenos ANTES del DELETE, todos de este lado (el monitor puede ir un
// deploy adelante o atrás, y lo que decide es lo que está en la tienda AHORA, no lo que vio la
// pantalla hace diez minutos):
//   1. Quién: sólo Darío y Bruno (pedido de Darío, 5-oct-2026). No alcanza `admin`: en el
//      padrón también es admin la cuenta técnica «CRM».
//   2. El nombre de la tienda tiene que ser el que vio la pantalla: el id de TN es un número, y un
//      número equivocado elimina otra prenda sin que nadie lo note.
//   3. Sin stock EN LA TIENDA (sumado en vivo). Stock `null` en TN es «infinito» → no se toca.
//   4. El respaldo se guarda en el KV PRIMERO. Si el KV falla, no se elimina.

const PUEDEN_ELIMINAR = ['bruno arevalo', 'dario arevalo'];

const normNombre = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const nombreDe = (p) => {
  const n = p && p.name;
  if (!n) return '';
  return typeof n === 'string' ? n : n.es || Object.values(n)[0] || '';
};

/** ¿Este usuario del padrón puede eliminar en la tienda? */
function puedeEliminar(u) {
  if (!u || !u.admin || u._modoAviso) return false;
  const n = normNombre(u.name).toLowerCase();
  return PUEDEN_ELIMINAR.includes(n);
}

/** Stock total en TN; `null` si alguna variante no lleva control de stock (infinito). */
function stockTotal(p) {
  let t = 0;
  for (const v of (p && p.variants) || []) {
    if (v.stock === null || v.stock === undefined) return null;
    t += Number(v.stock) || 0;
  }
  return t;
}

/** ¿Se puede eliminar este producto, tal como está AHORA en la tienda? */
function decidir(producto, esperado) {
  if (!producto) return { ok: false, motivo: 'no-esta' };
  if (normNombre(nombreDe(producto)) !== normNombre(esperado)) {
    return { ok: false, motivo: 'nombre-distinto', nombre: nombreDe(producto) };
  }
  const st = stockTotal(producto);
  if (st === null) return { ok: false, motivo: 'stock-infinito' };
  if (st > 0) return { ok: false, motivo: 'tiene-stock', stock: st };
  return { ok: true };
}

const claveRespaldo = (store, id) => `tn-eliminado:${store}:${id}`;
const claveRegistro = (store) => `tn-eliminados:${store}`;

/**
 * Elimina uno. `deps` = { tnFetch(path, init), kv(cmd) } — inyectado para poder probarlo.
 * Devuelve { id, resultado: 'eliminado'|'salteado'|'ya-no-estaba'|'error', motivo?, nombre }.
 */
async function eliminarUno({ store, id, esperado, quien, ahora }, deps) {
  const base = { id: String(id), nombre: esperado };
  const g = await deps.tnFetch(`/products/${id}`, { method: 'GET' });
  if (g.status === 404) return { ...base, resultado: 'ya-no-estaba' };
  if (!g.ok) return { ...base, resultado: 'error', motivo: `TN ${g.status} al leer` };
  const producto = await g.json();

  const d = decidir(producto, esperado);
  if (!d.ok) return { ...base, resultado: 'salteado', motivo: d.motivo, detalle: d.nombre ?? d.stock };

  const cuando = ahora || new Date().toISOString();
  try {
    const r = await deps.kv(['SET', claveRespaldo(store, id), JSON.stringify({ quien, cuando, producto })]);
    if (r !== 'OK') throw new Error('respuesta ' + JSON.stringify(r));
  } catch (e) {
    return { ...base, resultado: 'error', motivo: 'no se pudo guardar el respaldo: ' + e.message };
  }

  const del = await deps.tnFetch(`/products/${id}`, { method: 'DELETE' });
  if (!del.ok && del.status !== 404) return { ...base, resultado: 'error', motivo: `TN ${del.status} al eliminar` };

  try {
    await deps.kv(['LPUSH', claveRegistro(store), JSON.stringify({ id: String(id), nombre: nombreDe(producto), quien, cuando })]);
  } catch (e) {
    console.error('[tn-eliminar] no se pudo anotar en el registro', id, e && e.message);
  }
  return { ...base, resultado: 'eliminado' };
}

/** Tope por pedido: cada producto son 2 llamadas a TN y el handler no tiene `maxDuration` propio. */
const MAX_POR_PEDIDO = 10;

module.exports = { puedeEliminar, stockTotal, decidir, eliminarUno, claveRespaldo, claveRegistro, MAX_POR_PEDIDO, normNombre };
