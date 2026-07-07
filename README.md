# Entropía Studios — sitio web

Sitio web de **Entropía Studios** (Producciones Entropia, S.L.), productora
audiovisual independiente de cine, documental y series.

## Características

- **Sin build ni dependencias** — HTML, CSS y JavaScript puro (vanilla). Carga
  instantánea y desplegable en cualquier hosting estático.
- **Rápido** — sin frameworks, sin fuentes externas (stack de fuentes del
  sistema), imágenes generadas por CSS/SVG. Cero peticiones a terceros.
- **Accesible** — HTML semántico, `skip link`, foco visible, `aria` en la
  navegación y respeto por `prefers-reduced-motion`.
- **Responsive** — de móvil a escritorio, con menú lateral en pantallas
  pequeñas.
- **SEO** — metadatos Open Graph, `canonical`, `sitemap.xml`, `robots.txt` y
  datos estructurados JSON-LD (`Organization`).

## Estructura

```
.
├── index.html      Página principal (una sola página)
├── styles.css      Estilos y sistema de diseño
├── main.js         Interacciones (nav móvil, reveal, filtros, contadores)
├── assets/
│   └── favicon.svg
├── robots.txt
└── sitemap.xml
```

## Desarrollo local

No requiere instalación. Basta con servir la carpeta con cualquier servidor
estático, por ejemplo:

```bash
python3 -m http.server 8000
# o
npx serve .
```

Y abrir <http://localhost:8000>.

## Despliegue

Al ser estático, se puede desplegar tal cual en Netlify, Vercel, Cloudflare
Pages, GitHub Pages o cualquier CDN/hosting estático. No hay paso de
compilación.

## Contenido

El texto y la selección de proyectos (*slate en desarrollo*) son un punto de
partida editable en `index.html`. No se publica información sensible
(presupuestos, contactos ni estados internos de negociación).
