// Chequeo TEMPORAL: ¿el token de TiendaNube tiene permiso de escritura?
// Hace una escritura inofensiva (re-graba un producto con su propio valor) y reporta el resultado.
const STORES = {
  bdi:    { storeId: process.env.TIENDANUBE_STORE_ID,        token: process.env.TIENDANUBE_TOKEN },
  zattia: { storeId: process.env.TIENDANUBE_STORE_ID_ZATTIA, token: process.env.TIENDANUBE_TOKEN_ZATTIA },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = (req.query?.store || 'bdi').toLowerCase();
  const cfg = STORES[key];
  if (!cfg || !cfg.storeId || !cfg.token) return res.status(500).json({ error: 'TiendaNube no configurado para ' + key });
  const H = {
    'Authentication': `bearer ${cfg.token}`,
    'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)',
    'Content-Type': 'application/json',
  };
  try {
    // 1) Leer un producto
    const r1 = await fetch(`https://api.tiendanube.com/v1/${cfg.storeId}/products?per_page=1&fields=id,published,name`, { headers: H });
    const arr = await r1.json();
    if (!Array.isArray(arr) || !arr.length) return res.json({ paso: 'lectura', status: r1.status, body: arr });
    const p = arr[0];
    // 2) Escritura inofensiva: re-grabar 'published' con su valor actual (no cambia nada)
    const r2 = await fetch(`https://api.tiendanube.com/v1/${cfg.storeId}/products/${p.id}`, {
      method: 'PUT', headers: H, body: JSON.stringify({ published: p.published }),
    });
    const body = await r2.text();
    return res.json({
      store: key,
      producto_probado: p.id,
      escritura_status: r2.status,
      escritura_permitida: r2.ok,
      respuesta: body.slice(0, 400),
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
