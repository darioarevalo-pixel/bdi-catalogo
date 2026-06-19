const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const CONFIG_KEY = process.env.CONFIG_KEY || 'catalog-config';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${CONFIG_KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

const fmt = n => '$' + Math.round(n).toLocaleString('es-AR');

// Valida un único código de cupón en el servidor. El catálogo solo manda el
// código tipeado por el cliente; nunca se expone la lista completa de cupones.
module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const codigo = (req.query.codigo || '').trim().toUpperCase();
  const subtotal = parseFloat(req.query.subtotal) || 0;
  if (!codigo) return res.status(400).json({ error: 'Ingresá un código' });

  let config = null;
  try { config = await kvGet(); } catch (e) { /* sin config */ }
  const cupones = (config && config.cupones) || [];
  const c = cupones.find(x => (x.codigo || '').trim().toUpperCase() === codigo);

  if (!c) return res.status(404).json({ error: 'El cupón no existe' });
  if (c.activo === false) return res.status(400).json({ error: 'Este cupón no está disponible' });
  if (c.vence) {
    const fin = new Date(c.vence + 'T23:59:59');
    if (!isNaN(fin.getTime()) && fin < new Date()) return res.status(400).json({ error: 'El cupón venció' });
  }
  const minimo = parseFloat(c.minimo) || 0;
  if (minimo > 0 && subtotal < minimo) return res.status(400).json({ error: 'Requiere una compra mínima de ' + fmt(minimo) });

  let descuento = 0;
  if (c.tipo === 'porcentaje') descuento = Math.round(subtotal * (parseFloat(c.valor) || 0) / 100);
  else if (c.tipo === 'monto') descuento = Math.min(subtotal, parseFloat(c.valor) || 0);

  return res.json({
    ok: true,
    descuento,
    cupon: { codigo: c.codigo, tipo: c.tipo, valor: c.valor, detalle: c.detalle || '', minimo: c.minimo || '', vence: c.vence || '' },
  });
};
