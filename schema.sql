-- Modonix Filters — database schema. Run this once against a NEW, empty D1
-- database (not prospect-finder-db — this is a separate app with its own
-- database, on purpose).

-- The master taxonomy. One row per Category (e.g. "Gloves", "Drill Bits").
-- attrs_json is the ordered list of filter attributes for that category.
-- types_json is a CLOSED vocabulary for the "Type" attribute specifically —
-- once populated, classification is only allowed to use a Type already in
-- this list; anything new gets queued for review instead of silently
-- expanding the taxonomy. rules_json holds free-text correction rules.
CREATE TABLE IF NOT EXISTS product_categories (
  category    TEXT PRIMARY KEY,
  attrs_json  TEXT NOT NULL DEFAULT '[]',
  types_json  TEXT NOT NULL DEFAULT '[]',
  rules_json  TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Classification cache, keyed by a fingerprint so the SAME item (or a
-- pack-size sibling of it, e.g. "40610-5" / "40610-50") is never
-- reclassified independently and never comes back worded differently.
CREATE TABLE IF NOT EXISTS product_classifications (
  fingerprint     TEXT PRIMARY KEY,
  category        TEXT NOT NULL,
  item_number     TEXT,
  product_name    TEXT,
  attributes_json TEXT NOT NULL,
  confidence      TEXT,
  reasoning       TEXT,
  classified_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_classifications_category
  ON product_classifications(category);

-- Every distinct new "Type" value the model has proposed for a category,
-- pending a human decision (approve as new, merge into an existing Type,
-- or reject). Built once per distinct proposed value, not once per row.
CREATE TABLE IF NOT EXISTS product_type_review_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category      TEXT NOT NULL,
  proposed_type TEXT NOT NULL,
  sample_item   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  merged_into   TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_type_review_status
  ON product_type_review_queue(category, status);
