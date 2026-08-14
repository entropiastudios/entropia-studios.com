// Synopsis per project, per locale.
// The text lives in src/data/synopses.json so the /admin panel can edit it
// without touching code. Shape: { slug: { en, es } }.
import data from '../data/synopses.json';

export const synopses = data;
