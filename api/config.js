const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bdi2024';
const CONFIG_KEY = process.env.CONFIG_KEY || 'catalog-config';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
};

const DEFAULT = { hiddenProducts: [], hiddenVariants: {}, categoryOrder: [], hideNoStock: false, minPurchase: 0, referencePrices: {} };

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${CONFIG_KEY}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

async function kvSet(value) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV no configurado');
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', CONFIG_KEY, JSON.stringify(value)])
  });
  return r.json();
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
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
      return res.json({
        ok: true,
        cliente: c.cliente || '',
        descuentoBase: (typeof cfg.descuentoBase === 'number') ? cfg.descuentoBase : 15,
        excepciones: cfg.excepciones || {},
      });
    }
    // Con ?verify=1 valida la contraseña y devuelve la config (para el login del admin)
    if (req.query.verify) {
      if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    try {
      const config = { ...DEFAULT, ...(await kvGet() || {}) };
      // Datos sensibles que NO se exponen al público (solo el admin con verify, o
      // se validan on-demand): cupones (?accion=cupon) y las reglas de la "lista
      // mejor" + códigos de acceso (?accion=codigo). 'apagados' sí es público
      // (solo oculta productos, no filtra precios).
      if (!req.query.verify) {
        delete config.cupones;
        delete config.codigosAcceso;
        delete config.descuentoBase;
        delete config.excepciones;
      }
      return res.json(config);
    } catch (e) {
      return res.json({ ...DEFAULT });
    }
  }

  if (req.method === 'POST') {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    try {
      await kvSet(req.body);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
};
