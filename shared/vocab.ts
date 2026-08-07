// The facets the tagger answers inside, and the order they appear in the UI.
// The values themselves live in Postgres (0002_tag_vocabulary.sql) so they can
// be edited without a deploy; this file only fixes the axes and their labels.

export const FACETS = [
  { key: 'colour_family', label: 'Colour' },
  { key: 'finish', label: 'Finish' },
  { key: 'material_look', label: 'Look' },
  { key: 'format', label: 'Format' },
  { key: 'application', label: 'Use' },
  { key: 'shot_type', label: 'Shot' },
] as const

export type Facet = (typeof FACETS)[number]['key']

// Anything the tagger files here never reaches search. It is the reject gate
// for signature logos, spec-sheet renders and stray photos.
export const NOT_A_TILE = 'not a tile'
