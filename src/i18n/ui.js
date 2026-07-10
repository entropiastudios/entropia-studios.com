export const locales = ['en', 'es'];
export const defaultLocale = 'en';

export const localeNames = { en: 'EN', es: 'ES' };
export const htmlLang = { en: 'en', es: 'es' };

export const ui = {
  en: {
    'meta.home.desc':
      'Entropía Studios is a Madrid-based production company developing and producing feature films, documentaries, series and docuseries with a clear international vocation.',
    'nav.work': 'Work',
    'nav.about': 'About',
    'nav.contact': 'Contact',
    'about.tagline': 'Different lives, different voices, different ways of telling them.',
    'contact.title': 'Contact',
    'country.Spain': 'Spain',
    'country.Switzerland': 'Switzerland',
    'country.Netherlands': 'Netherlands',
    'country.Italy': 'Italy',
    'footer.getInTouch': 'Get in touch',
    'footer.privacy': 'Privacy Policy',
    'cookie.text':
      'We use analytics cookies to understand how the site is used. You choose whether to allow them.',
    'cookie.accept': 'Accept',
    'cookie.decline': 'Decline',
    'cookie.settings': 'Cookie settings',
    'project.back': 'All work',
    'project.next': 'Next project',
    'cat.Series': 'Series',
    'cat.Doc': 'Doc',
    'cat.Film': 'Film',
    'cat.Short': 'Short',
    'cat.TV': 'TV',
    'status.production': 'Production',
    'status.preproduction': 'Pre-production',
    'status.development': 'Development',
    'status.financing': 'Financing',
    'credit.producedBy': 'Produced by',
    'credit.executiveProducers': 'Executive Producers',
    'credit.producers': 'Producers',
    'credit.serviceProduction': 'Service Production',
    'credit.distribution': 'Distribution',
    'credit.starring': 'Starring',
    'credit.writtenBy': 'Written by',
    'credit.directedBy': 'Directed by',
    'credit.releaseDate': 'Release Date',
    'credit.runtime': 'Runtime',
  },
  es: {
    'meta.home.desc':
      'Entropía Studios es una productora con sede en Madrid que desarrolla y produce largometrajes, documentales, series y docuseries con una clara vocación internacional.',
    'nav.work': 'Proyectos',
    'nav.about': 'Nosotros',
    'nav.contact': 'Contacto',
    'about.tagline': 'Vidas distintas, voces distintas, distintas maneras de contarlas.',
    'contact.title': 'Contacto',
    'country.Spain': 'España',
    'country.Switzerland': 'Suiza',
    'country.Netherlands': 'Países Bajos',
    'country.Italy': 'Italia',
    'footer.getInTouch': 'Escríbenos',
    'footer.privacy': 'Política de privacidad',
    'cookie.text':
      'Usamos cookies de analítica para entender cómo se usa el sitio. Tú eliges si permitirlas.',
    'cookie.accept': 'Aceptar',
    'cookie.decline': 'Rechazar',
    'cookie.settings': 'Preferencias de cookies',
    'project.back': 'Todos los proyectos',
    'project.next': 'Siguiente proyecto',
    'cat.Series': 'Serie',
    'cat.Doc': 'Doc',
    'cat.Film': 'Película',
    'cat.Short': 'Corto',
    'cat.TV': 'TV',
    'status.production': 'En producción',
    'status.preproduction': 'En preproducción',
    'status.development': 'En desarrollo',
    'status.financing': 'En financiación',
    'credit.producedBy': 'Producido por',
    'credit.executiveProducers': 'Productores ejecutivos',
    'credit.producers': 'Productores',
    'credit.serviceProduction': 'Producción de servicios',
    'credit.distribution': 'Distribución',
    'credit.starring': 'Reparto',
    'credit.writtenBy': 'Guion',
    'credit.directedBy': 'Dirección',
    'credit.releaseDate': 'Estreno',
    'credit.runtime': 'Duración',
  },
};

export function useTranslations(locale) {
  const dict = ui[locale] || ui[defaultLocale];
  return function t(key) {
    return dict[key] ?? ui[defaultLocale][key] ?? key;
  };
}

export function localizedPath(locale, path = '') {
  const clean = path.replace(/^\/+/, '');
  return `/${locale}${clean ? '/' + clean : '/'}`;
}
