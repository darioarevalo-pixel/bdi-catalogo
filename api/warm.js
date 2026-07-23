// Mantiene "caliente" la copia del catálogo en el CDN de Vercel.
// Un robot (GitHub Actions) llama a este endpoint cada pocos minutos: acá
// pedimos todas las páginas del catálogo a través de la MISMA URL pública que
// usa el navegador, de modo que el CDN guarde/renueve esas copias. Así, cuando
// llega un cliente real, encuentra el catálogo ya servido y abre al instante
// (nadie tiene que esperar el viaje lento a Gestión Nube).
//
// Detecta solo su propio dominio (req.headers.host), así no hay que hardcodear
// ninguna dirección: funciona igual en producción o en cualquier deploy.

// Debe coincidir EXACTO con lo que pide index.html (cargarProductos), porque la
// copia del CDN se identifica por la URL completa. Si cambia allá, cambiar acá.
const BASE_QS = 'per_page=100&include_stock=1&include_images=1&include_variants=1';
const PATH_ENC = encodeURIComponent('/productos/obtener');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); // la respuesta del robot no se cachea
  const t0 = Date.now();
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return res.status(500).json({ ok: false, error: 'sin host' });
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const base = `${proto}://${host}`;
    const urlPagina = (page) => `${base}/api/proxy?_path=${PATH_ENC}&${BASE_QS}&page=${page}`;

    // Página 1: además de calentar, nos dice cuántas páginas hay.
    const r1 = await fetch(urlPagina(1));
    const d1 = await r1.json().catch(() => ({}));
    let lastPage = d1.meta ? (d1.meta.last_page || d1.meta.total_pages || 1) : 1;
    if (lastPage > 20) lastPage = 20; // mismo tope que index.html

    // Páginas 2..N en paralelo.
    if (lastPage > 1) {
      await Promise.all(
        Array.from({ length: lastPage - 1 }, (_, i) =>
          fetch(urlPagina(i + 2)).catch(() => null)
        )
      );
    }

    return res.status(200).json({ ok: true, pages: lastPage, ms: Date.now() - t0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, ms: Date.now() - t0 });
  }
};
