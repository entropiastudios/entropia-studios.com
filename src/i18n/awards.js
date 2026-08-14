// Awards / festival recognitions per project, per locale.
// The text lives in src/data/awards.json so the /admin panel can edit it
// without touching code. Shape: { slug: { en, es } }.
import data from '../data/awards.json';

export const awards = data;
