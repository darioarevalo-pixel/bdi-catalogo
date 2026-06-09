// SONDA TEMPORAL: ver los barcodes de variantes en TiendaNube (Zattia) para JEAN SHIFT.
const STORE = process.env.TIENDANUBE_STORE_ID_ZATTIA;
const TOKEN = process.env.TIENDANUBE_TOKEN_ZATTIA;
function tnH(t) { return { 'Authentication': `bearer ${t}`, 'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)' }; }
const valEs = v => v?.es || (v && Object.values(v)[0]) || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = (req.query?.q || 'JEAN SHIFT').toLowerCase();
    let all = [], page = 1;
    while (page <= 30) {
      const r = await fetch(`https://api.tiendanube.com/v1/${STORE}/products?per_page=200&page=${page}&fields=id,name,variants`, { headers: tnH(TOKEN) });
      const d = await r.json();
      if (!Array.isArray(d) || !d.length) break;
      all.push(...d); if (d.length < 200) break; page++;
    }
    const hit = all.filter(p => valEs(p.name).toLowerCase().includes(q));
    const out = hit.map(p => ({
      name: valEs(p.name),
      variants: (p.variants || []).map(v => ({
        sku: v.sku, barcode: v.barcode,
        values: (v.values || []).map(valEs).join(' / '),
      })),
    }));
    res.status(200).json({ encontrados: out.length, productos: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
