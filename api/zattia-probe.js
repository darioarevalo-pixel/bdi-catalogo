// Probe TEMPORAL: estructura de variantes de Zattia + test de escritura.
const SID = process.env.TIENDANUBE_STORE_ID_ZATTIA;
const TOKEN = process.env.TIENDANUBE_TOKEN_ZATTIA;
const H = { 'Authentication': `bearer ${TOKEN}`, 'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)', 'Content-Type': 'application/json' };
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!SID || !TOKEN) return res.status(500).json({ error: 'falta config zattia' });
  try {
    const arr = await (await fetch(`https://api.tiendanube.com/v1/${SID}/products?per_page=5&fields=id,name,variants,images`, { headers: H })).json();
    if (!Array.isArray(arr)) return res.json({ paso: 'lectura', body: arr });
    const p = arr.find(x => (x.variants || []).length > 1) || arr[0];
    const variantes = (p.variants || []).slice(0, 8).map(v => ({ values: v.values, image_id: v.image_id, stock: v.stock }));
    const imgs = (p.images || []).slice(0, 5).map(i => ({ id: i.id, alt: i.alt }));
    // test escritura (no-op)
    const pj = await (await fetch(`https://api.tiendanube.com/v1/${SID}/products/${p.id}?fields=id,published`, { headers: H })).json();
    const w = await fetch(`https://api.tiendanube.com/v1/${SID}/products/${p.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ published: pj.published }) });
    const wb = await w.text();
    return res.json({ producto: p.name, total_variantes: (p.variants || []).length, variantes, imgs, escritura_status: w.status, escritura_ok: w.ok, wresp: wb.slice(0, 200) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
