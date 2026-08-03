const STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TOKEN = process.env.TIENDANUBE_TOKEN;
const API_BASE = `https://api.tiendanube.com/v1/${STORE_ID}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!STORE_ID || !TOKEN) return res.status(500).json({ error: 'Tienda Nube no configurado' });

  try {
    // Traer todos los productos con paginación
    let all = [];
    let page = 1;
    while (true) {
      const r = await fetch(`${API_BASE}/products?per_page=200&page=${page}&fields=id,name,description,variants,images`, {
        headers: {
          'Authentication': `bearer ${TOKEN}`,
          'User-Agent': `BDI Catalogo (darioarevalo@arebensrl.com)`,
        }
      });
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) break;
      all = all.concat(data);
      if (data.length < 200) break;
      page++;
    }

    // Color de una variante = value que NO es modelo de iPhone ni talle.
    const TALLES = new Set(['s', 'm', 'l', 'xl', 'xxl', 'xs', 'xxs', 'xxxl', 'xxxxl', 'u', 'unico', 'único']);
    const esTalle = t => { const x = String(t || '').toLowerCase().trim(); return TALLES.has(x) || /^\d{1,3}$/.test(x) || x.startsWith('talle'); };
    const valEs = v => v?.es || v?.pt || (v && Object.values(v)[0]) || '';
    const colorDeVariante = v => ((v.values || []).map(valEs).filter(t => t && !/iphone/i.test(t) && !esTalle(t))[0]) || '';
    const normColor = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    // ── El formato de la respuesta ──────────────────────────────────────────
    //
    // Antes esto era un objeto plano `clave -> ficha`, y como cada producto se
    // indexa por su nombre y por el código de cada variante, **la ficha entera
    // (todas las fotos + la descripción) se repetía una vez por clave**. Medido:
    // 235 productos de TiendaNube ocupaban 2,04 MB en 1.766 claves. Al sumar los
    // códigos de barras habría saltado a 5,30 MB — más del doble, y esto lo baja
    // el navegador de cada cliente.
    //
    // Ahora las fichas van UNA sola vez en `fichas`, y `claves` guarda a qué
    // posición apunta cada clave. Agregar claves nuevas pasa a costar unos bytes
    // en vez de una copia entera.
    //
    // `v: 2` lo usan las páginas para distinguir el formato: la copia guardada en
    // el CDN dura hasta 24 h, así que después de publicar esto todavía va a haber
    // navegadores recibiendo el formato viejo un rato. Los dos tienen que andar.
    const fichas = [];
    const claves = {};
    /**
     * Apunta una clave a una ficha.
     *
     * `pisar` mantiene el comportamiento que ya tenía el catálogo: con nombres y
     * SKU repetidos ganaba el ÚLTIMO producto. No es que sea mejor —con nombres
     * duplicados cualquiera de los dos es arbitrario— pero cambiarlo movería la
     * foto de productos que hoy se ven bien (comprobado: pasaba con "iconic case",
     * "f-0136" y "f-0134"), y este cambio no vino a mover fotos.
     *
     * Los códigos de barras SÍ van sin pisar: cuando dos productos comparten un
     * código genérico (0000000000875 y parecidos), se queda el primero en vez de
     * que el último se lleve la foto de todos.
     */
    const apuntar = (clave, pos, pisar) => {
      const k = String(clave == null ? '' : clave).trim().toLowerCase();
      if (!k) return;
      if (pisar || claves[k] === undefined) claves[k] = pos;
    };

    for (const p of all) {
      const imgs = (p.images || []).map(i => i.src).filter(Boolean);
      const nombre = (p.name?.es || p.name?.pt || Object.values(p.name || {})[0] || '').trim().toLowerCase();
      const rawDesc = p.description?.es || p.description?.pt || Object.values(p.description || {})[0] || '';
      // Limpiar HTML de la descripción
      const desc = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      // Foto propia por color: image_id de la variante -> src de la imagen del producto.
      const imgById = {};
      (p.images || []).forEach(i => { if (i.id != null && i.src) imgById[i.id] = i.src; });
      const varImgByColor = {};
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) {
          if (v.image_id == null) continue;
          const src = imgById[v.image_id];
          const c = normColor(colorDeVariante(v));
          if (src && c && !varImgByColor[c]) varImgByColor[c] = src;
        }
      }
      const entry = { imgs, desc };
      if (Object.keys(varImgByColor).length) entry.varImgByColor = varImgByColor;
      const pos = fichas.push(entry) - 1;
      if (nombre) apuntar(nombre, pos, true);
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) {
          if (v.sku) apuntar(v.sku, pos, true);
          // ── El código de barras ──────────────────────────────────────────
          // Es el ÚNICO dato que identifica al mismo producto en los dos
          // sistemas. Medido el 1-8-2026: 2.474 variantes tienen el mismo
          // código de barras en Gestión Nube y en TiendaNube (F019815 =
          // F019815), y cubren 180 de los 185 productos publicados.
          //
          // El `sku` de acá arriba NO sirve para eso: en esta tienda es otro
          // código (f-0002-11) que Gestión Nube no conoce. Por eso el catálogo
          // venía emparejando todo por NOMBRE, y una palabra de más rompía la
          // foto. Con el código de barras indexado, el nombre pasa a ser el
          // camino de respaldo y no el único.
          //
          // No se pisa una clave ya cargada: si dos productos comparten código
          // de barras (pasa con códigos genéricos tipo 0000000000875), se queda
          // el primero en vez de que el último se lleve la foto de todos.
          if (v.barcode != null) apuntar(v.barcode, pos);
        }
      }
    }

    // Las imágenes/descripciones de Tienda Nube cambian rara vez y esto es LENTO de
    // regenerar (pagina toda la API de TN). Por eso se cachea fuerte en el CDN de
    // Vercel: la copia se sirve al instante y se refresca por detrás (24 h de
    // stale-while-revalidate). Así, mientras alguien entre al menos una vez por
    // día, nunca se enfría del todo y las visitas lo reciben casi instantáneo.
    //
    // La ventana "fresca" era de 1 h y el 3-8-2026 se bajó a 10 min. El motivo:
    // al cargar 19 fundas nuevas en TiendaNube, las fotos NO aparecían en el
    // catálogo y no había forma de apurarlo (el proyecto vive en otra cuenta de
    // Vercel, así que ni siquiera se puede purgar a mano). Medido ese día: la
    // regeneración completa tarda ~3 s y son 2 páginas de la API de TN, o sea
    // que refrescar cada 10 min en vez de cada hora no le mueve la aguja a nadie
    // —el cliente sigue recibiendo la copia guardada al instante, la regeneración
    // pasa por detrás— y a cambio las fotos nuevas se ven el mismo rato en que se
    // cargan en vez de hasta una hora después.
    //
    // El navegador además la guarda 1 min (max-age) para recargas seguidas. Antes
    // eran 5 min, que era la otra mitad de la espera: aunque el servidor ya
    // tuviera la foto nueva, la pestaña seguía mostrando la vieja.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400');
    res.json({ v: 2, fichas, claves });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
