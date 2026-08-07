-- The controlled vocabulary the vision tagger must answer inside.
--
-- Deliberately small. A short list the model picks from beats a long list it
-- guesses at, and every term here is one a salesperson would actually type
-- into the search box. Add terms as real searches miss; do not pre-empt.

insert into tags (facet, value) values
  ('colour_family', 'white'),
  ('colour_family', 'cream / beige'),
  ('colour_family', 'grey'),
  ('colour_family', 'charcoal / black'),
  ('colour_family', 'brown'),
  ('colour_family', 'terracotta'),
  ('colour_family', 'blue'),
  ('colour_family', 'green'),
  ('colour_family', 'multi-colour'),

  ('finish', 'matt'),
  ('finish', 'polished'),
  ('finish', 'satin'),
  ('finish', 'lappato'),
  ('finish', 'textured'),
  ('finish', 'anti-slip'),
  ('finish', 'rustic'),

  ('material_look', 'marble'),
  ('material_look', 'stone'),
  ('material_look', 'concrete'),
  ('material_look', 'wood'),
  ('material_look', 'terrazzo'),
  ('material_look', 'metallic'),
  ('material_look', 'plain'),
  ('material_look', 'patterned'),

  ('format', 'large format'),
  ('format', 'plank'),
  ('format', 'square'),
  ('format', 'subway'),
  ('format', 'mosaic'),
  ('format', 'hexagon'),
  ('format', 'herringbone'),

  ('application', 'floor'),
  ('application', 'wall'),
  ('application', 'bathroom'),
  ('application', 'kitchen'),
  ('application', 'splashback'),
  ('application', 'outdoor'),
  ('application', 'pool'),

  -- shot_type is what makes "show me a room, not a swatch" work, and it is
  -- also the reject gate: anything the model calls 'not a tile' never reaches
  -- search.
  ('shot_type', 'product flat'),
  ('shot_type', 'room scene'),
  ('shot_type', 'installed job'),
  ('shot_type', 'sample board'),
  ('shot_type', 'spec sheet'),
  ('shot_type', 'not a tile')
on conflict (facet, value) do nothing;
