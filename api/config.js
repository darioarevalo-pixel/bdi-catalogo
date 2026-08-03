const { kvGet, kvSet } = require('./_kv');

// Sin respaldo a propósito. Antes había acá una contraseña por defecto escrita en
// el código: como el repo es público, estaba a la vista de cualquiera y entraba al
// panel de verdad (comprobado el 29-jul-2026 contra producción: devolvía 200 con
// toda la config — costos, cupones, códigos de la lista mejor). La contraseña vive
// SOLO en la variable de entorno de Vercel; el código nunca trae una.
//
// Ojo con "simplemente sacar el respaldo": si queda `process.env.ADMIN_PASSWORD`
// a secas y la variable no está cargada, vale `undefined`, y un pedido SIN el
// header también trae `undefined` → `undefined !== undefined` es false y entra
// sin contraseña. Por eso cae a '' y `passwordOk` exige que esté cargada.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Única puerta: sin ADMIN_PASSWORD cargada en Vercel, no entra nadie.
function passwordOk(req) {
  if (!ADMIN_PASSWORD) {
    console.error('[admin] falta la variable ADMIN_PASSWORD en Vercel: se rechaza todo.');
    return false;
  }
  return req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
};

const DEFAULT = { hiddenProducts: [], hiddenVariants: {}, categoryOrder: [], hideNoStock: false, minPurchase: 0, referencePrices: {} };

// ---------------------------------------------------------------------------
// CACHÉ
//
// Este endpoint atendía TODO sin caché: medido el 2-8-2026 contra producción,
// 5 de 5 llamadas dieron MISS a 0,39-0,43 s. Es lo más lento que queda al abrir
// el catálogo (el listado de productos sí se cachea, ver api/proxy.js).
//
// Pero el archivo atiende cuatro cosas distintas por la misma puerta y solo UNA
// se puede compartir entre visitantes:
//   · ?accion=cupon  → depende del subtotal y de la hora: no se cachea.
//   · ?accion=codigo → precios de UN cliente (descuentos, excepciones): jamás.
//   · ?verify=1      → la config entera para el admin, y se distingue por el
//                      header de contraseña, que el CDN NO mira. Jamás.
//   · GET pelado     → la config pública, igual para todos: esta sí.
//
// Por eso el default es `no-store` y el permiso se da SOLO en la rama buena, en
// vez de poner una cabecera arriba y confiar en que ninguna rama se escape.
const NO_CACHE = 'no-store, max-age=0';

// 60 s de vida + 5 min de "serví lo viejo mientras buscás lo nuevo". Costo de
// hacerlo: un cambio guardado en el panel puede tardar hasta ~1 minuto en verse
// en el catálogo. El admin no lo sufre (entra por ?verify=1, sin caché).
const CACHE_PUBLICA = 'public, s-maxage=60, stale-while-revalidate=300';

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', NO_CACHE); // se afloja solo en la config pública
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    // Validación de cupón (acción pública). No expone la lista completa: solo
    // valida el código tipeado y devuelve ese cupón + el descuento.
    // (Va dentro de config.js para no superar el límite de 12 funciones en Hobby.)
    if (req.query.accion === 'cupon') {
      const codigo = (req.query.codigo || '').trim().toUpperCase();
      const subtotal = parseFloat(req.query.subtotal) || 0;
      if (!codigo) return res.status(400).json({ error: 'Ingresá un código' });
      let cfg = null;
      try { cfg = await kvGet(); } catch (e) { /* sin config */ }
      const cupones = (cfg && cfg.cupones) || [];
      const c = cupones.find(x => (x.codigo || '').trim().toUpperCase() === codigo);
      if (!c) return res.status(404).json({ error: 'El cupón no existe' });
      if (c.activo === false) return res.status(400).json({ error: 'Este cupón no está disponible' });
      if (c.vence) {
        const fin = new Date(c.vence + 'T23:59:59');
        if (!isNaN(fin.getTime()) && fin < new Date()) return res.status(400).json({ error: 'El cupón venció' });
      }
      const minimo = parseFloat(c.minimo) || 0;
      if (minimo > 0 && subtotal < minimo) return res.status(400).json({ error: 'Requiere una compra mínima de $' + Math.round(minimo).toLocaleString('es-AR') });
      let descuento = 0;
      if (c.tipo === 'porcentaje') descuento = Math.round(subtotal * (parseFloat(c.valor) || 0) / 100);
      else if (c.tipo === 'monto') descuento = Math.min(subtotal, parseFloat(c.valor) || 0);
      return res.json({ ok: true, descuento, cupon: { codigo: c.codigo, tipo: c.tipo, valor: c.valor, detalle: c.detalle || '', minimo: c.minimo || '', vence: c.vence || '' } });
    }
    // Validación de código de acceso a la "lista mejor" (acción pública). No expone
    // la lista de códigos: valida el tipeado y, si es válido, devuelve las reglas de
    // precio (descuento base + excepciones) para que el catálogo recalcule.
    if (req.query.accion === 'codigo') {
      const codigo = (req.query.codigo || '').trim().toUpperCase();
      if (!codigo) return res.status(400).json({ error: 'Ingresá tu código' });
      let cfg = null;
      try { cfg = await kvGet(); } catch (e) { /* sin config */ }
      const codigos = (cfg && cfg.codigosAcceso) || [];
      const c = codigos.find(x => (x.codigo || '').trim().toUpperCase() === codigo);
      if (!c) return res.status(404).json({ error: 'El código no existe' });
      if (c.activo === false) return res.status(400).json({ error: 'Este código no está activo' });
      if (c.vence) {
        const fin = new Date(c.vence + 'T23:59:59');
        if (!isNaN(fin.getTime()) && fin < new Date()) return res.status(400).json({ error: 'El código venció' });
      }
      // Descuento: el propio del código si lo tiene; si no, el % base general.
      const descCodigo = parseFloat(c.descuento);
      const descGlobal = (typeof cfg.descuentoBase === 'number') ? cfg.descuentoBase : 15;
      const descuentoBase = (c.descuento !== '' && c.descuento != null && !isNaN(descCodigo)) ? descCodigo : descGlobal;
      return res.json({
        ok: true,
        cliente: c.cliente || '',
        descuentoBase,
        excepciones: cfg.excepciones || {},
        // Tope de descuento por producto: hay productos de margen chico donde el %
        // de la lista mejor se come la rentabilidad. Viaja solo acá (no en la
        // config pública) porque es información de precios, igual que el resto.
        descuentoMax: cfg.descuentoMax || {},
        descuentoMaxNota: cfg.descuentoMaxNota || '',
      });
    }
    // Con ?verify=1 valida la contraseña y devuelve la config (para el login del admin)
    if (req.query.verify) {
      if (!passwordOk(req))
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    try {
      const guardada = await kvGet();
      const config = { ...DEFAULT, ...(guardada || {}) };
      // Datos sensibles que NO se exponen al público (solo el admin con verify, o
      // se validan on-demand): cupones (?accion=cupon) y las reglas de la "lista
      // mejor" + códigos de acceso (?accion=codigo). 'apagados' sí es público
      // (solo oculta productos, no filtra precios).
      if (!req.query.verify) {
        delete config.cupones;
        delete config.codigosAcceso;
        delete config.descuentoBase;
        delete config.excepciones;
        delete config.descuentoMax;
        delete config.descuentoMaxNota;
        // Solo se comparte la respuesta BUENA. Si el KV no contestó, esto es una
        // config de emergencia (catálogo vacío, sin precios especiales): guardarla
        // 60 s la repartiría a todos los que entren en ese minuto.
        if (guardada) res.setHeader('Cache-Control', CACHE_PUBLICA);
      }
      return res.json(config);
    } catch (e) {
      return res.json({ ...DEFAULT }); // queda con el no-store de arriba
    }
  }

  if (req.method === 'POST') {
    if (!passwordOk(req))
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    try {
      const incoming = req.body || {};
      // Control de concurrencia optimista (repo/admin compartido): el cliente
      // manda en el header el updatedAt que vio al cargar. Si la config guardada
      // cambió desde entonces, otra sesión guardó en el medio → NO pisamos.
      const clientBase = req.headers['x-base-updated-at'] || '';
      const current = await kvGet();
      const currentUpdatedAt = (current && current.updatedAt) || '';
      if (clientBase && currentUpdatedAt && clientBase !== currentUpdatedAt) {
        return res.status(409).json({ error: 'conflict', updatedAt: currentUpdatedAt });
      }
      // Sellar un nuevo updatedAt y guardar.
      incoming.updatedAt = new Date().toISOString();
      await kvSet(incoming);
      return res.json({ ok: true, updatedAt: incoming.updatedAt });
    } catch (e) {
      // Antes una falla del KV no llegaba hasta acá: `kvSet` devolvía el error de
      // Upstash como si fuera un dato bueno y el panel mostraba "✓ Guardado" sin
      // haber guardado nada. Ahora revienta, y el cartel dice la verdad.
      console.error('[config] no se pudo guardar:', (e && e.message) || e);
      return res.status(500).json({
        error: `No se guardó nada. ${e.message}. Probá de nuevo en un minuto.`,
      });
    }
  }

  return res.status(405).end();
};
