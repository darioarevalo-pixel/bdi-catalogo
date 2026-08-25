// ---------------------------------------------------------------------------
// DE DÓNDE SALE LA FOTO DE UN PRODUCTO
//
// Esta es la MISMA regla que usa la grilla del catálogo en index.html
// (`getImagenes`), traída acá para que el link del pedido muestre las mismas
// fotos que el cliente vio al comprar:
//
//     primero TIENDA NUBE, y solo si ahí no hay, GESTIÓN NUBE.
//
// El orden importa y no es un detalle: las fotos de Gestión Nube son las de
// carga interna y muchas están mal o desactualizadas; las de Tienda Nube son
// las que se publicaron. Cuando el pedido resolvía primero por Gestión Nube
// (25-ago-2026) aparecían fotos equivocadas en los renglones agregados a mano.
//
// ⚠️ ESTA REGLA ESTÁ ESCRITA DOS VECES: acá y en index.html. No se pudo
// compartir un solo archivo porque index.html lleva todo su JavaScript adentro
// y las funciones de /api no se sirven al navegador. Si se toca el cruce de un
// lado, hay que tocarlo del otro. Lo que NO puede pasar es que difieran en el
// ORDEN (TN antes que GN): ahí el pedido mostraría una foto distinta a la que
// el cliente vio en el catálogo.
// ---------------------------------------------------------------------------

/** Palabras de un texto, sin acentos ni puntuación. Igual que en index.html. */
function normWords(s) {
  return (s == null ? '' : String(s))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Un color normalizado, para cruzar GN contra Tienda Nube. */
function normColor(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** La foto que tiene cargada Gestión Nube, mire donde mire la API. */
function imagenDeProductoGN(p) {
  if (!p) return '';
  const directa = p.image_url || p.imagen_url || p.imagen || p.image || p.photo || p.foto;
  if (typeof directa === 'string' && directa) return directa;
  for (const lista of [p.images, p.imagenes, p.fotos]) {
    if (!Array.isArray(lista) || !lista.length) continue;
    const f = lista[0];
    const url = typeof f === 'string' ? f : (f && (f.url || f.src || f.path || f.ruta));
    if (url) return String(url);
  }
  return '';
}

/**
 * `/api/tiendanube` manda las fichas una sola vez y aparte a qué clave apunta
 * cada una (`{v:2, fichas, claves}`), porque repetirlas pesaba 2 MB. Acá se
 * vuelve a armar el objeto plano `clave -> ficha`. Acepta el formato viejo.
 */
function armarMapaTN(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.v !== 2 || !Array.isArray(data.fichas) || !data.claves) return data;
  const out = {};
  for (const k in data.claves) {
    const ficha = data.fichas[data.claves[k]];
    if (ficha) out[k] = ficha;
  }
  return out;
}

/**
 * Le encuentra a un producto de Gestión Nube su ficha de Tienda Nube.
 *
 * Tres caminos, gana el primero que TRAIGA FOTOS:
 *   1. El código del producto.
 *   2. El código de barras de sus variantes ← el bueno, es el mismo dato en los
 *      dos sistemas. Se vota: un código mal cargado no arrastra la foto
 *      equivocada a todo el producto, tiene que ganarle a los demás.
 *   3. El nombre, exigiendo que el de Tienda Nube sea el comienzo exacto del de
 *      Gestión Nube. Así una variante con sufijo toma la foto del producto base,
 *      pero un producto distinto con "de" en el medio no se la roba.
 */
function crearBuscadorTN(mapaTN) {
  const indice = Object.keys(mapaTN).map(k => ({ key: k, words: normWords(k) }));
  const cache = new Map();

  function buscarSinCache(p) {
    const candidatos = [];

    const cod = (p.code || p.sku || p.codigo || '').trim().toLowerCase();
    if (cod && mapaTN[cod]) candidatos.push(mapaTN[cod]);

    const votos = new Map();
    for (const v of (p.variantes || [])) {
      const cb = v && v.barcode != null ? String(v.barcode).trim().toLowerCase() : '';
      const e = cb && mapaTN[cb];
      if (!e) continue;
      votos.set(e, (votos.get(e) || 0) + 1);
    }
    if (votos.size) {
      let mejor = null, mejorN = 0;
      for (const [entry, n] of votos) if (n > mejorN) { mejor = entry; mejorN = n; }
      if (mejor) candidatos.push(mejor);
    }

    const gnWords = normWords(p.name || p.nombre || p.product_name || '');
    if (gnWords.length) {
      let best = null, bestLen = 0;
      for (const e of indice) {
        const tw = e.words;
        if (tw.length && tw.length <= gnWords.length && tw.length > bestLen &&
            tw.every((w, i) => w === gnWords[i])) { best = e.key; bestLen = tw.length; }
      }
      if (best) candidatos.push(mapaTN[best]);
    }

    // Gana el primero que tenga fotos: si cruza por código contra una ficha sin
    // fotos, perdería la que sí consigue por nombre.
    return candidatos.find(c => c && c.imgs && c.imgs.length) || candidatos[0] || null;
  }

  return function buscar(p) {
    const id = p && (p.id != null ? p.id : p.product_id);
    if (cache.has(id)) return cache.get(id);
    const r = buscarSinCache(p);
    cache.set(id, r);
    return r;
  };
}

/**
 * La foto de un renglón: Tienda Nube primero, Gestión Nube de respaldo.
 * `variante` es el nombre de la variante en GN (a veces es un color, y ahí
 * Tienda Nube puede tener una foto propia para ese color).
 * Devuelve `{ url, de }`, donde `de` es 'tn' o 'gn' — sirve para saber después
 * de dónde salió cada foto sin tener que adivinarlo por el dominio.
 */
function fotoDeProducto(prodGN, variante, buscarTN) {
  const ficha = buscarTN ? buscarTN(prodGN) : null;
  if (ficha) {
    const c = normColor(variante);
    if (c && ficha.varImgByColor && ficha.varImgByColor[c]) {
      return { url: ficha.varImgByColor[c], de: 'tn' };
    }
    if (ficha.imgs && ficha.imgs.length) return { url: ficha.imgs[0], de: 'tn' };
  }
  const gn = imagenDeProductoGN(prodGN);
  return gn ? { url: gn, de: 'gn' } : { url: '', de: '' };
}

module.exports = {
  normWords, normColor, imagenDeProductoGN,
  armarMapaTN, crearBuscadorTN, fotoDeProducto,
};
