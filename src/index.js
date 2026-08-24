// Modonix Filters — standalone Worker. Separate app, separate database,
// separate GitHub repo from Prospect Finder on purpose: this is a product
// catalog taxonomy/classifier, a different job entirely.
//
// Uses one D1 database (binding: DB) with 3 tables — see schema.sql:
//   product_categories        — the closed taxonomy (attrs + Type vocabulary)
//   product_classifications   — classification cache, keyed by fingerprint
//   product_type_review_queue — new Type values pending human review

const PRODUCT_CACHE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (p === '/api/product-categories' && m === 'GET') return handleProductCategories(env);
    if (p === '/api/product-categories/upsert' && m === 'POST') return handleProductCategoryUpsert(request, env);
    if (p === '/api/product-categories/delete' && m === 'POST') return handleProductCategoryDelete(request, env);
    if (p === '/api/product-classify' && m === 'POST') return handleProductClassify(request, env);
    if (p === '/api/product-type-review-queue' && m === 'GET') return handleProductTypeReviewList(request, env);
    if (p === '/api/product-type-review-resolve' && m === 'POST') return handleProductTypeReviewResolve(request, env);
    if (p === '/api/product-extract-pdf-chunk' && m === 'POST') return handleProductExtractPdfChunk(request, env);
    if (p === '/api/product-suggest-attributes' && m === 'POST') return handleProductSuggestAttributes(request, env);
    return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function baseItemKey(itemNumber) {
  return String(itemNumber || '').trim().toUpperCase().replace(/-\d+$/, '');
}
function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function buildFingerprint(category, itemNumber, productName) {
  const cat = String(category || '').trim().toLowerCase();
  const idKey = itemNumber ? baseItemKey(itemNumber) : ('name:' + normalizeName(productName));
  return cat + '|' + idKey;
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch (e) {}
  const cleaned = str.replace(/,(\s*[\]}])/g, '$1').replace(/:\s*'([^']*)'/g, (m2, v) => ': "' + v.replace(/"/g, '\\"') + '"');
  try { return JSON.parse(cleaned); } catch (e) { return null; }
}

async function callClaudeWithRetry(env, { system, prompt, maxTokens }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Server is missing ANTHROPIC_API_KEY. Add it as a Worker secret.');
  const backoffMs = [1000, 2000, 4000, 8000];
  let lastErr = null;
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    try {
      const body = { model: 'claude-sonnet-5', max_tokens: maxTokens || 1000, messages: [{ role: 'user', content: prompt }] };
      if (system) body.system = system;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const errText = await r.text();
        const err = new Error('Anthropic API error (' + r.status + '): ' + errText.slice(0, 300));
        err.status = r.status;
        throw err;
      }
      const data = await r.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) {
        const stopReason = data.stop_reason || 'unknown';
        const blockTypes = (data.content || []).map(b => b.type);
        throw new Error('Empty response from Claude [diagnostic: stop_reason=' + stopReason + ', content block types=' + JSON.stringify(blockTypes) + ']');
      }
      return text.replace(/```json|```/g, '').trim();
    } catch (e) {
      lastErr = e;
      if (e.status && NON_RETRYABLE_STATUS.has(e.status)) throw e;
      if (attempt < backoffMs.length) { await new Promise(res => setTimeout(res, backoffMs[attempt])); continue; }
    }
  }
  throw lastErr;
}

async function handleProductCategories(env) {
  const db = env.DB;
  if (!db) return jsonResponse({ categories: {} }, 200);
  try {
    const rows = await db.prepare('SELECT category, attrs_json, types_json, rules_json, updated_at FROM product_categories ORDER BY category COLLATE NOCASE').all();
    const categories = {};
    for (const r of (rows.results || [])) {
      categories[r.category] = { attrs: tryParseJSON(r.attrs_json) || [], types: tryParseJSON(r.types_json) || [], rules: tryParseJSON(r.rules_json) || [], updatedAt: r.updated_at };
    }
    return jsonResponse({ categories }, 200);
  } catch (e) { console.error('Product categories fetch failed', e); return jsonResponse({ categories: {} }, 200); }
}

async function handleProductCategoryUpsert(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { category, attrs, types, rules } = body || {};
  if (!category || !category.trim()) return jsonResponse({ error: 'Missing "category"' }, 400);
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Server has no database connected' }, 500);
  const cat = category.trim();
  const now = Date.now();
  try {
    const existing = await db.prepare('SELECT attrs_json, types_json, rules_json FROM product_categories WHERE category = ?').bind(cat).first();
    const finalAttrs = Array.isArray(attrs) ? attrs : (existing ? tryParseJSON(existing.attrs_json) || [] : []);
    const finalTypes = Array.isArray(types) ? types : (existing ? tryParseJSON(existing.types_json) || [] : []);
    const finalRules = Array.isArray(rules) ? rules : (existing ? tryParseJSON(existing.rules_json) || [] : []);
    await db.prepare(
      'INSERT INTO product_categories (category, attrs_json, types_json, rules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(category) DO UPDATE SET attrs_json = excluded.attrs_json, types_json = excluded.types_json, rules_json = excluded.rules_json, updated_at = excluded.updated_at'
    ).bind(cat, JSON.stringify(finalAttrs), JSON.stringify(finalTypes), JSON.stringify(finalRules), now, now).run();
    return jsonResponse({ ok: true, category: cat }, 200);
  } catch (e) { console.error('Product category upsert failed', e); return jsonResponse({ error: 'Upsert failed: ' + e.message }, 500); }
}

async function handleProductCategoryDelete(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { category } = body || {};
  const db = env.DB;
  if (!db || !category) return jsonResponse({ error: 'Missing category or no database' }, 400);
  try { await db.prepare('DELETE FROM product_categories WHERE category = ?').bind(category).run(); return jsonResponse({ ok: true }, 200); }
  catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleProductClassify(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { category, itemNumber, productName, extraInfo, brand } = body || {};
  if (!category || !productName) return jsonResponse({ error: 'Missing "category" or "productName"' }, 400);
  const db = env.DB;
  const fingerprint = buildFingerprint(category, itemNumber, productName);

  if (db) {
    try {
      const cached = await db.prepare('SELECT attributes_json, confidence, reasoning, classified_at FROM product_classifications WHERE fingerprint = ?').bind(fingerprint).first();
      if (cached && (Date.now() - cached.classified_at) < PRODUCT_CACHE_DAYS * DAY_MS) {
        return jsonResponse({ attributes: tryParseJSON(cached.attributes_json) || {}, confidence: cached.confidence, reasoning: cached.reasoning, cached: true }, 200);
      }
    } catch (e) { console.error('Classification cache read failed', e); }
  }

  let attrs = [], types = [], rules = [];
  if (db) {
    try {
      const catRow = await db.prepare('SELECT attrs_json, types_json, rules_json FROM product_categories WHERE category = ?').bind(category).first();
      if (catRow) { attrs = tryParseJSON(catRow.attrs_json) || []; types = tryParseJSON(catRow.types_json) || []; rules = tryParseJSON(catRow.rules_json) || []; }
    } catch (e) { console.error('Category lookup failed', e); }
  }
  if (!attrs.length) return jsonResponse({ error: 'Category "' + category + '" has no saved attributes yet — add it on the Product Categories tab first.' }, 400);

  const typesSection = types.length
    ? '\n\nVALID "Type" VALUES FOR THIS CATEGORY — CHOOSE FROM THIS LIST WHEN POSSIBLE:\n' + types.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\nIf none genuinely fit, propose a new, short, specific Type instead of forcing a poor fit — it will be reviewed by a person before being added.'
    : '\n\nNo Type vocabulary saved yet — propose a specific, short Type value; it will be reviewed by a person before being added.';
  const rulesSection = rules.length ? '\n\nCORRECTION RULES — THESE OVERRIDE EVERYTHING ELSE:\n' + rules.map((r, i) => (i + 1) + '. ' + r).join('\n') : '';

  const system = 'You are a product attribute extraction engine for e-commerce catalog management. ' +
    'Extract ONLY attributes clearly determinable from the input — return null for anything unclear, never guess. ' +
    'Required attributes: ' + attrs.join(', ') + typesSection + rulesSection +
    '\n\nReturn ONLY valid JSON, no markdown fences, no explanation outside the JSON:\n' +
    '{"confidence": "high|medium|low", "reasoning": "one sentence", "attributes": {' + attrs.map(a => '"' + a + '": null').join(',') + '}}';
  const prompt = 'Item Number: ' + (itemNumber || 'n/a') + (brand ? '\nBrand: ' + brand : '') + '\nProduct: ' + productName + (extraInfo ? '\nAdditional info: ' + extraInfo : '');

  let parsed;
  try {
    const raw = await callClaudeWithRetry(env, { system, prompt, maxTokens: 900 });
    parsed = tryParseJSON(raw);
    if (!parsed) throw new Error('Could not parse model response as JSON');
  } catch (e) { return jsonResponse({ error: 'Classification failed: ' + e.message }, 500); }

  const resultAttrs = parsed.attributes || {};
  const proposedType = resultAttrs['Type'] || resultAttrs['type'];
  const typeNeedsReview = !!(proposedType && types.length && !types.some(t => t.toLowerCase() === String(proposedType).toLowerCase()));

  if (db && typeNeedsReview) {
    try {
      const already = await db.prepare("SELECT id FROM product_type_review_queue WHERE category = ? AND LOWER(proposed_type) = LOWER(?) AND status = 'pending'").bind(category, proposedType).first();
      if (!already) await db.prepare("INSERT INTO product_type_review_queue (category, proposed_type, sample_item, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(category, proposedType, productName, Date.now()).run();
    } catch (e) { console.error('Type review queue insert failed', e); }
  }

  if (db) {
    try {
      await db.prepare(
        'INSERT INTO product_classifications (fingerprint, category, item_number, product_name, attributes_json, confidence, reasoning, classified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(fingerprint) DO UPDATE SET attributes_json = excluded.attributes_json, confidence = excluded.confidence, reasoning = excluded.reasoning, classified_at = excluded.classified_at'
      ).bind(fingerprint, category, itemNumber || '', productName, JSON.stringify(resultAttrs), parsed.confidence || 'medium', parsed.reasoning || '', Date.now()).run();
    } catch (e) { console.error('Classification cache write failed', e); }
  }

  return jsonResponse({ attributes: resultAttrs, confidence: parsed.confidence || 'medium', reasoning: parsed.reasoning || '', cached: false, typeNeedsReview }, 200);
}

async function handleProductTypeReviewList(request, env) {
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const db = env.DB;
  if (!db) return jsonResponse({ items: [] }, 200);
  try {
    const q = category
      ? db.prepare("SELECT id, category, proposed_type, sample_item, created_at FROM product_type_review_queue WHERE status = 'pending' AND category = ? ORDER BY created_at").bind(category)
      : db.prepare("SELECT id, category, proposed_type, sample_item, created_at FROM product_type_review_queue WHERE status = 'pending' ORDER BY category, created_at");
    const rows = await q.all();
    return jsonResponse({ items: rows.results || [] }, 200);
  } catch (e) { console.error('Type review list failed', e); return jsonResponse({ items: [] }, 200); }
}

async function handleProductTypeReviewResolve(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { id, decision, mergeInto } = body || {};
  const db = env.DB;
  if (!db || !id || !decision) return jsonResponse({ error: 'Missing id/decision or no database' }, 400);
  try {
    const item = await db.prepare('SELECT category, proposed_type FROM product_type_review_queue WHERE id = ?').bind(id).first();
    if (!item) return jsonResponse({ error: 'Review item not found' }, 404);
    if (decision === 'approve' || decision === 'merge') {
      const finalType = decision === 'merge' && mergeInto ? mergeInto : item.proposed_type;
      const catRow = await db.prepare('SELECT types_json, attrs_json, rules_json FROM product_categories WHERE category = ?').bind(item.category).first();
      const types = catRow ? (tryParseJSON(catRow.types_json) || []) : [];
      if (!types.some(t => t.toLowerCase() === finalType.toLowerCase())) {
        types.push(finalType);
        const now = Date.now();
        await db.prepare(
          'INSERT INTO product_categories (category, attrs_json, types_json, rules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(category) DO UPDATE SET types_json = excluded.types_json, updated_at = excluded.updated_at'
        ).bind(item.category, catRow ? catRow.attrs_json : '[]', JSON.stringify(types), catRow ? catRow.rules_json : '[]', now, now).run();
      }
    }
    await db.prepare('UPDATE product_type_review_queue SET status = ?, merged_into = ?, resolved_at = ? WHERE id = ?')
      .bind(decision === 'reject' ? 'rejected' : decision, decision === 'merge' ? mergeInto : null, Date.now(), id).run();
    return jsonResponse({ ok: true }, 200);
  } catch (e) { console.error('Type review resolve failed', e); return jsonResponse({ error: e.message }, 500); }
}

async function handleProductExtractPdfChunk(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { text, category } = body || {};
  if (!text || !text.trim()) return jsonResponse({ items: [] }, 200);
  const system = 'You are a product catalog extraction engine. The text below has already been reconstructed into visual reading order (rows top-to-bottom, columns left-to-right within each row) from a PDF catalog page' +
    (category ? ' for the category "' + category + '"' : '') + '. Extract every distinct product row you can find. Read any column headers first. ' +
    'Strip brand names from product_name. Return ONLY a JSON array, no markdown fences: [{"item_number":"...","product_name":"...","extra_info":"..."}]. ' +
    'Shared family-level description text should be included in extra_info for every item it applies to, not dropped. If nothing extractable is found, return [].';
  try {
    const raw = await callClaudeWithRetry(env, { system, prompt: text.slice(0, 12000), maxTokens: 4000 });
    const parsed = tryParseJSON(raw);
    return jsonResponse({ items: Array.isArray(parsed) ? parsed : [] }, 200);
  } catch (e) { return jsonResponse({ error: 'Extraction failed: ' + e.message, items: [] }, 500); }
}

// ---- POST /api/product-suggest-attributes ----
// Given just a category name (and optionally a sample product or two),
// proposes a starting attribute list and, where obvious, a starting Type
// vocabulary. This is a SUGGESTION only — the person reviews and edits it
// in the Product Categories form before Save actually writes anything, so
// a bad or generic suggestion never silently becomes the taxonomy.
async function handleProductSuggestAttributes(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { category, sampleText } = body || {};
  if (!category || !category.trim()) return jsonResponse({ error: 'Missing "category"' }, 400);

  const system = 'You are a product taxonomy expert for e-commerce and industrial distribution. ' +
    'Given a product category name and optional sample product text, propose the filter attributes buyers would use to narrow down this product type. ' +
    'Rules: return 6-14 attributes, ordered from most to least commonly used as a filter. ALWAYS include "Type" first if the category plausibly has meaningful sub-types (most categories do). ' +
    'Where the category has a small number of genuinely standard values for Type (e.g. a narrow, well-known product family), also propose a short starting "types" list of 3-8 specific values — leave it empty if you are not confident, since a wrong guess here is worse than an empty list a person fills in from real data. ' +
    'Return ONLY valid JSON, no markdown fences, no explanation: {"attrs": ["Type","..."], "types": []}';
  const prompt = 'Category: ' + category.trim() + (sampleText ? '\nSample products:\n' + sampleText.slice(0, 2000) : '');

  try {
    const raw = await callClaudeWithRetry(env, { system, prompt, maxTokens: 700 });
    const parsed = tryParseJSON(raw);
    if (!parsed) throw new Error('Could not parse model response as JSON');
    return jsonResponse({ attrs: Array.isArray(parsed.attrs) ? parsed.attrs : [], types: Array.isArray(parsed.types) ? parsed.types : [] }, 200);
  } catch (e) {
    return jsonResponse({ error: 'Suggestion failed: ' + e.message }, 500);
  }
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Modonix Filters</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
:root{--paper:#F4F5F2;--ink:#1A2129;--steel:#8A959E;--line:#D8DCD9;--seam:#D9581E;--seam-soft:#FBEAE0;--ok:#2E7D4F;--err:#B3341E;--card:#FFFFFF}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font-family:system-ui,sans-serif;line-height:1.5;min-height:100vh;padding:0 20px 80px}
.wrap{max-width:960px;margin:0 auto}
header{padding:44px 0 24px;border-bottom:3px solid var(--ink)}
.brand{font-size:12px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--steel)}
h1{font-weight:800;font-size:clamp(30px,5vw,46px);margin-top:8px}
h1 span{color:var(--seam)}
.tagline{margin-top:10px;font-size:15px;color:var(--steel);max-width:60ch}
.tabs{display:flex;border-bottom:none}
.tab{font-weight:700;font-size:13px;letter-spacing:.05em;text-transform:uppercase;padding:15px 22px;border:1px solid var(--line);border-bottom:none;background:var(--paper);color:var(--steel);cursor:pointer}
.tab+.tab{border-left:none}
.tab.active{background:var(--card);color:var(--ink);border-top:3px solid var(--seam);padding-top:13px}
.tabpanel{display:none}
.tabpanel.active{display:block}
.panel{background:var(--card);border:1px solid var(--line);border-top:none;padding:28px}
.field{margin-bottom:20px}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px}
.opt{color:var(--steel);font-weight:500;text-transform:none;letter-spacing:0}
input[type=text],input[type=number],select,textarea{width:100%;padding:11px 12px;font-size:14px;border:1px solid var(--line);background:var(--paper);color:var(--ink)}
input[type=file]{margin-bottom:8px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
button{font-weight:700;font-size:13px;letter-spacing:.04em;text-transform:uppercase;padding:12px 22px;border:none;cursor:pointer}
.btn-mine{background:var(--ink);color:#fff}
.btn-mine:hover{background:var(--seam)}
.btn-mine:disabled{background:var(--steel);cursor:not-allowed}
.btn-secondary{background:var(--paper);color:var(--ink);border:1px solid var(--ink)}
.btn-secondary:hover{background:var(--ink);color:#fff}
.btn-copy{background:var(--paper);color:var(--ink);border:1px solid var(--ink);font-size:11px;padding:8px 14px}
.status{margin-top:18px;padding:12px 14px;font-size:13px;border-left:4px solid var(--steel);background:var(--card);display:none}
.status.on{display:block}
.status.working{border-left-color:var(--seam)}
.status.error{border-left-color:var(--err);color:var(--err)}
.status.done{border-left-color:var(--ok);color:var(--ok)}
.hint{font-size:12.5px;color:var(--steel);margin-top:6px}
.saved-panel{margin-top:20px;border-top:2px solid var(--line);padding-top:16px}
.saved-item{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px dashed var(--line);font-size:13.5px}
.meta{color:var(--steel);font-size:12px}
.empty-note{color:var(--steel);font-size:13px;font-style:italic}
.cat-tag{display:inline-block;font-size:11px;background:var(--seam-soft);border-left:2px solid var(--seam);padding:2px 6px}
.progress-bar{margin-top:14px;height:6px;background:var(--line);display:none}
.progress-bar.on{display:block}
.progress-fill{height:100%;background:var(--seam);width:0%}
.cost-note{margin-top:14px;padding:12px 14px;font-size:12.5px;background:var(--seam-soft);border-left:3px solid var(--seam)}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--steel);padding:8px 10px;border-bottom:2px solid var(--ink)}
td{padding:9px 10px;border-bottom:1px dashed var(--line)}
.table-wrap{overflow-x:auto;max-height:520px;overflow-y:auto}
details{border-bottom:1px dashed var(--line);padding:8px 0}
summary{cursor:pointer;font-weight:700;list-style:none;display:flex;justify-content:space-between}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">Modonix &middot; Filters</div>
    <h1>Product <span>Filters</span></h1>
    <p class="tagline">Build a shared, consistent product taxonomy and classify catalog items against it — a closed attribute/Type vocabulary, a classification cache so the same item never comes back worded two different ways, and a review step before any new Type value is trusted.</p>
  </header>

  <div class="tabs">
    <button class="tab active" id="tab-categories" onclick="showTab('categories')">Product Categories</button>
    <button class="tab" id="tab-classify" onclick="showTab('classify')">Product Classifier</button>
  </div>

  <div class="tabpanel active" id="panel-categories">
    <div class="panel">
      <p class="tagline" style="margin:0 0 22px">A category's attribute list and its closed "Type" vocabulary live here, shared by everyone who uses this app. Nothing gets classified against a category that doesn't exist here yet.</p>
      <div class="row" style="align-items:flex-end;margin-bottom:20px">
        <div class="field" style="margin-bottom:0;flex:1;min-width:200px"><label>Category</label><input type="text" id="pc_newCategory" placeholder="e.g. Gloves, Drill Bits"></div>
        <div class="field" style="margin-bottom:0;flex:2;min-width:260px"><label>Attributes <span class="opt">(comma separated)</span></label><input type="text" id="pc_newAttrs" placeholder="e.g. Type, Cut Level, Coating, Color"></div>
        <button class="btn-secondary" id="pc_suggestBtn" onclick="pcSuggestAttrs()">Suggest via AI</button>
        <button class="btn-mine" onclick="pcSaveCategory()">Save</button>
      </div>
      <p class="hint" style="margin-top:-14px;margin-bottom:20px">"Suggest via AI" proposes a starting attribute list (and Type list, where obvious) from the category name alone — nothing is saved until you review it and click Save.</p>
      <div class="field"><label>Starting "Type" list <span class="opt">(optional — leave blank to build it up via review as you classify)</span></label><input type="text" id="pc_newTypes" placeholder="e.g. Welding Glove, Cut-Resistant Glove"></div>
      <div class="status" id="pc_status"></div>
      <div class="saved-panel"><label>Type Review Queue <span class="opt">(new Type values proposed while classifying)</span></label><div id="pc_reviewQueue"></div></div>
      <div class="saved-panel"><label>Saved Categories</label><div id="pc_categoryList"></div></div>
    </div>
  </div>

  <div class="tabpanel" id="panel-classify">
    <div class="panel">
      <p class="tagline" style="margin:0 0 22px">Every item is checked against the shared classification cache first — an item (or a pack-size sibling of it, e.g. "40610-5" / "40610-50") is only ever classified once.</p>
      <div class="row" style="margin-bottom:20px;align-items:flex-end">
        <div class="field" style="margin-bottom:0;flex:1;min-width:220px"><label>Category</label><select id="pcl_category" onchange="pclOnCategoryChange()"><option value="">-- Choose a category --</option></select></div>
        <div class="field" style="margin-bottom:0"><label>Brand override <span class="opt">(optional)</span></label><input type="text" id="pcl_brand" style="width:180px"></div>
      </div>
      <div class="field"><label>Upload <span class="opt">(.csv, .xlsx, .xls, or .pdf)</span></label><input type="file" id="pcl_fileInput" accept=".csv,.xlsx,.xls,.pdf"><p class="hint">CSV/XLSX needs a column with "item" or "part" and one with "name", "description", or "product".</p></div>
      <div id="pcl_pdfRangeBox" style="display:none;background:var(--card);border:1px solid var(--seam);padding:16px;margin-bottom:20px">
        <div class="row" style="margin-bottom:10px"><span style="font-size:11px;color:var(--seam);text-transform:uppercase">PDF loaded — <span id="pcl_pageCount"></span></span></div>
        <div class="row"><div class="field" style="margin:0"><label>From page</label><input type="number" id="pcl_pageFrom" min="1" value="1"></div><div class="field" style="margin:0"><label>To page</label><input type="number" id="pcl_pageTo" min="1" value="1"></div><button class="btn-secondary" onclick="pclExtractPdfRange()">Extract this range</button></div>
      </div>
      <div class="row"><button class="btn-mine" id="pcl_runBtn" onclick="pclRunClassify()" disabled>Classify</button><button class="btn-secondary" onclick="pclExportXlsx()">Download Excel</button></div>
      <div class="status" id="pcl_status"></div>
      <div class="progress-bar" id="pcl_progressBar"><div class="progress-fill" id="pcl_progressFill"></div></div>
      <div class="cost-note">New "Type" values are queued for review rather than silently added, so a run's Type wording stays consistent even for categories still being built out.</div>
      <div style="margin-top:28px"><div class="table-wrap"><table><thead><tr><th>Item #</th><th>Product Name</th><th>Status</th></tr></thead><tbody id="pcl_tbody"></tbody></table></div></div>
    </div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function setStatus(id,kind,msg){ const s=document.getElementById(id); s.className='status on '+kind; s.innerHTML=msg; }
function showTab(name){
  ['categories','classify'].forEach(t=>{
    document.getElementById('tab-'+t).classList.toggle('active', t===name);
    document.getElementById('panel-'+t).classList.toggle('active', t===name);
  });
  if(name==='categories'){ pcLoadCategories(); pcLoadReviewQueue(); }
  if(name==='classify') pclLoadCategoryOptions();
}

let pcCategories = {};
async function pcLoadCategories(){
  const resp = await fetch('/api/product-categories'); const data = await resp.json();
  pcCategories = data.categories || {}; pcRenderCategoryList();
}
function pcRenderCategoryList(){
  const el = document.getElementById('pc_categoryList');
  const names = Object.keys(pcCategories).sort((a,b)=>a.localeCompare(b));
  if(!names.length){ el.innerHTML='<p class="empty-note">No categories yet. Add one above.</p>'; return; }
  el.innerHTML = names.map(name=>{
    const c = pcCategories[name];
    return '<details><summary><span>'+esc(name)+'</span><span class="meta">'+c.attrs.length+' attrs &middot; '+c.types.length+' types</span></summary>'+
      '<div style="padding:10px 0 0 14px">'+
        '<div style="margin-bottom:8px"><strong style="font-size:11px;color:var(--steel)">ATTRIBUTES</strong><br>'+c.attrs.map(a=>'<span class="cat-tag" style="margin:2px 4px 2px 0">'+esc(a)+'</span>').join('')+'</div>'+
        (c.types.length?'<div style="margin-bottom:8px"><strong style="font-size:11px;color:var(--steel)">TYPES</strong><br>'+c.types.map(t=>'<span class="cat-tag" style="margin:2px 4px 2px 0">'+esc(t)+'</span>').join('')+'</div>':'')+
        '<button class="btn-copy" onclick="pcDeleteCategory(\\''+name.replace(/'/g,"\\\\'")+'\\')">Delete</button>'+
      '</div></details>';
  }).join('');
}
async function pcSuggestAttrs(){
  const category = document.getElementById('pc_newCategory').value.trim();
  if(!category){ setStatus('pc_status','error','Type a category name first, then click Suggest.'); return; }
  const btn = document.getElementById('pc_suggestBtn');
  btn.disabled = true; const origText = btn.textContent; btn.textContent = 'Thinking...';
  setStatus('pc_status','working','Asking Claude for a starting attribute list for "'+category+'".');
  try{
    const resp = await fetch('/api/product-suggest-attributes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category})});
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error||'Suggestion failed');
    document.getElementById('pc_newAttrs').value = (data.attrs||[]).join(', ');
    document.getElementById('pc_newTypes').value = (data.types||[]).join(', ');
    setStatus('pc_status','done','Suggested '+(data.attrs||[]).length+' attributes'+((data.types||[]).length?' and '+data.types.length+' starting Types':'')+' — review and edit before clicking Save.');
  }catch(e){ setStatus('pc_status','error','Could not suggest: '+e.message); }
  finally{ btn.disabled=false; btn.textContent=origText; }
}
async function pcSaveCategory(){
  const category = document.getElementById('pc_newCategory').value.trim();
  const attrs = document.getElementById('pc_newAttrs').value.split(',').map(s=>s.trim()).filter(Boolean);
  const types = document.getElementById('pc_newTypes').value.split(',').map(s=>s.trim()).filter(Boolean);
  if(!category||!attrs.length){ setStatus('pc_status','error','Enter a category name and at least one attribute.'); return; }
  const resp = await fetch('/api/product-categories/upsert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category,attrs,types})});
  const data = await resp.json();
  if(!resp.ok){ setStatus('pc_status','error','Could not save: '+data.error); return; }
  setStatus('pc_status','done','Saved "'+category+'".');
  document.getElementById('pc_newCategory').value=''; document.getElementById('pc_newAttrs').value=''; document.getElementById('pc_newTypes').value='';
  pcLoadCategories();
}
async function pcDeleteCategory(category){
  if(!confirm('Delete "'+category+'"?')) return;
  await fetch('/api/product-categories/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category})});
  pcLoadCategories();
}
async function pcLoadReviewQueue(){
  const resp = await fetch('/api/product-type-review-queue'); const data = await resp.json();
  pcRenderReviewQueue(data.items||[]);
}
function pcRenderReviewQueue(items){
  const el = document.getElementById('pc_reviewQueue');
  if(!items.length){ el.innerHTML='<p class="empty-note">Nothing pending.</p>'; return; }
  el.innerHTML = items.map(it=>{
    const existingTypes = (pcCategories[it.category]&&pcCategories[it.category].types)||[];
    return '<div class="saved-item"><div><strong>'+esc(it.proposed_type)+'</strong> <span class="meta">for '+esc(it.category)+'</span><br><span class="meta">seen on: '+esc(it.sample_item||'')+'</span></div>'+
      '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
        '<button class="btn-copy" onclick="pcResolveType('+it.id+',\\'approve\\')">Approve</button>'+
        (existingTypes.length?'<select id="pc_mergeSel_'+it.id+'" style="font-size:11px">'+existingTypes.map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join('')+'</select><button class="btn-copy" onclick="pcMergeType('+it.id+')">Merge</button>':'')+
        '<button class="btn-copy" onclick="pcResolveType('+it.id+',\\'reject\\')">Reject</button>'+
      '</div></div>';
  }).join('');
}
async function pcResolveType(id,decision){
  await fetch('/api/product-type-review-resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,decision})});
  pcLoadCategories(); pcLoadReviewQueue();
}
async function pcMergeType(id){
  const sel = document.getElementById('pc_mergeSel_'+id); const mergeInto = sel?sel.value:'';
  await fetch('/api/product-type-review-resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,decision:'merge',mergeInto})});
  pcLoadCategories(); pcLoadReviewQueue();
}

let pclCategoriesCache={}, pclRows=[], pclResults=[], pclPdfDoc=null;
async function pclLoadCategoryOptions(){
  const resp = await fetch('/api/product-categories'); const data = await resp.json();
  pclCategoriesCache = data.categories||{};
  const sel = document.getElementById('pcl_category'); const current = sel.value;
  sel.innerHTML = '<option value="">-- Choose a category --</option>'+Object.keys(pclCategoriesCache).sort((a,b)=>a.localeCompare(b)).map(c=>'<option value="'+esc(c)+'"'+(c===current?' selected':'')+'>'+esc(c)+'</option>').join('');
}
function pclOnCategoryChange(){ document.getElementById('pcl_runBtn').disabled = !(document.getElementById('pcl_category').value && pclRows.length); }
document.addEventListener('DOMContentLoaded', function(){
  document.getElementById('pcl_fileInput').addEventListener('change', function(){ pclHandleFile(this.files[0]); });
  pcLoadCategories(); pcLoadReviewQueue();
});

function pclHandleFile(file){
  if(!file) return;
  document.getElementById('pcl_pdfRangeBox').style.display='none';
  pclRows=[]; pclResults=[]; document.getElementById('pcl_tbody').innerHTML='';
  if(file.name.toLowerCase().endsWith('.pdf')){ pclLoadPdf(file); return; }
  const reader = new FileReader();
  reader.onload = function(e){
    let rows=[];
    if(file.name.toLowerCase().endsWith('.csv')){
      const lines = e.target.result.split('\\n').filter(l=>l.trim());
      const headers = lines[0].split(',').map(h=>h.trim().replace(/"/g,'').toLowerCase());
      const itemIdx = headers.findIndex(h=>h.includes('item')||h.includes('part'));
      const nameIdx = headers.findIndex(h=>h.includes('name')||h.includes('description')||h.includes('product'));
      for(let i=1;i<lines.length;i++){
        const vals = lines[i].split(',').map(v=>v.trim().replace(/"/g,''));
        const productName = nameIdx>=0?vals[nameIdx]:'';
        if(!productName) continue;
        rows.push({itemNumber:itemIdx>=0?vals[itemIdx]:'', productName, extraInfo:''});
      }
    } else {
      const wb = XLSX.read(e.target.result,{type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      const headers = (data[0]||[]).map(h=>String(h||'').toLowerCase());
      const itemIdx = headers.findIndex(h=>h.includes('item')||h.includes('part'));
      const nameIdx = headers.findIndex(h=>h.includes('name')||h.includes('description')||h.includes('product'));
      for(let i=1;i<data.length;i++){
        const row = data[i]; const productName = nameIdx>=0?String(row[nameIdx]||'').trim():'';
        if(!productName) continue;
        rows.push({itemNumber:itemIdx>=0?String(row[itemIdx]||'').trim():'', productName, extraInfo:''});
      }
    }
    pclRows = rows; pclRenderRows(); setStatus('pcl_status','done',rows.length+' rows loaded.'); pclOnCategoryChange();
  };
  if(file.name.toLowerCase().endsWith('.csv')) reader.readAsText(file); else reader.readAsArrayBuffer(file);
}

if(typeof pdfjsLib!=='undefined'){ pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; }

async function pclLoadPdf(file){
  try{
    setStatus('pcl_status','working','Reading PDF.');
    const buf = await new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsArrayBuffer(file);});
    pclPdfDoc = await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
    document.getElementById('pcl_pageCount').textContent = pclPdfDoc.numPages+' pages total';
    document.getElementById('pcl_pageTo').value = Math.min(2,pclPdfDoc.numPages);
    document.getElementById('pcl_pageTo').max = pclPdfDoc.numPages;
    document.getElementById('pcl_pageFrom').max = pclPdfDoc.numPages;
    document.getElementById('pcl_pdfRangeBox').style.display='block';
    setStatus('pcl_status','done','PDF loaded — pick a page range and click Extract.');
  }catch(e){ setStatus('pcl_status','error','Could not load PDF: '+e.message); }
}

async function layoutPageText(page){
  const content = await page.getTextContent();
  const rows = []; const Y_TOLERANCE = 2;
  for(const item of content.items){
    const y = item.transform[5];
    let row = rows.find(r=>Math.abs(r.y-y)<=Y_TOLERANCE);
    if(!row){ row={y,items:[]}; rows.push(row); }
    row.items.push({x:item.transform[4], str:item.str});
  }
  rows.sort((a,b)=>b.y-a.y);
  return rows.map(r=>r.items.sort((a,b)=>a.x-b.x).map(i=>i.str).join(' ')).join('\\n');
}

async function pclExtractPdfRange(){
  if(!pclPdfDoc) return;
  const from = Math.max(1,parseInt(document.getElementById('pcl_pageFrom').value)||1);
  const to = Math.min(pclPdfDoc.numPages,parseInt(document.getElementById('pcl_pageTo').value)||from);
  const category = document.getElementById('pcl_category').value;
  setStatus('pcl_status','working','Reading pages '+from+'-'+to+'.');
  try{
    let allText='';
    for(let p=from;p<=to;p++){ const page=await pclPdfDoc.getPage(p); allText += await layoutPageText(page)+'\\n\\n'; }
    setStatus('pcl_status','working','Extracting product rows.');
    const resp = await fetch('/api/product-extract-pdf-chunk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:allText,category})});
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error||'Extraction failed');
    const newRows = (data.items||[]).map(it=>({itemNumber:it.item_number||'',productName:it.product_name||'',extraInfo:it.extra_info||''})).filter(r=>r.productName);
    pclRows = pclRows.concat(newRows); pclRenderRows();
    setStatus('pcl_status','done',newRows.length+' rows found ('+pclRows.length+' total loaded).'); pclOnCategoryChange();
  }catch(e){ setStatus('pcl_status','error','Extraction failed: '+e.message); }
}

function pclRenderRows(){
  document.getElementById('pcl_tbody').innerHTML = pclRows.map((r,i)=>'<tr id="pclrow-'+i+'"><td>'+esc(r.itemNumber||'\\u2014')+'</td><td>'+esc(r.productName)+'</td><td><span class="meta">pending</span></td></tr>').join('');
}

async function pclRunClassify(){
  const category = document.getElementById('pcl_category').value;
  const brand = document.getElementById('pcl_brand').value.trim();
  if(!category||!pclRows.length) return;
  document.getElementById('pcl_runBtn').disabled=true;
  document.getElementById('pcl_progressBar').classList.add('on');
  pclResults = new Array(pclRows.length).fill(null);
  let done=0, cachedCount=0, newCount=0, errCount=0;
  for(let i=0;i<pclRows.length;i++){
    const row = pclRows[i];
    document.getElementById('pcl_progressFill').style.width = ((i/pclRows.length)*100).toFixed(1)+'%';
    setStatus('pcl_status','working','Classifying '+(i+1)+' of '+pclRows.length+'.');
    try{
      const resp = await fetch('/api/product-classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category,itemNumber:row.itemNumber,productName:row.productName,extraInfo:row.extraInfo,brand})});
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error||'Classification failed');
      pclResults[i] = {status:'done',attributes:data.attributes,confidence:data.confidence,cached:data.cached,typeNeedsReview:data.typeNeedsReview};
      if(data.cached) cachedCount++; else newCount++;
      done++;
    }catch(e){ pclResults[i] = {status:'error',error:e.message}; errCount++; }
    const tr = document.getElementById('pclrow-'+i);
    if(tr){
      const cell = pclResults[i].status==='done'
        ? '<span style="color:var(--ok)">done'+(pclResults[i].cached?' <span class="meta">(cached)</span>':'')+(pclResults[i].typeNeedsReview?' <span class="meta" style="color:var(--seam)">Type needs review</span>':'')+'</span>'
        : '<span style="color:var(--err)">error</span>';
      tr.children[2].innerHTML = cell;
    }
  }
  document.getElementById('pcl_progressFill').style.width='100%';
  document.getElementById('pcl_runBtn').disabled=false;
  setStatus('pcl_status','done',done+' classified ('+newCount+' new, '+cachedCount+' from cache), '+errCount+' error(s). Check Product Categories if any rows say "Type needs review."');
}

function pclBuildPipeString(itemNumber, productName, attrs, attrValues, brand){
  const pairs = [];
  if(brand) pairs.push('Brand:'+brand);
  attrs.forEach(attr=>{
    if(attr.toLowerCase()==='brand') return;
    const val = attrValues[attr];
    if(val!==null && val!==undefined && String(val).trim()!=='') pairs.push(attr+':'+String(val).trim());
  });
  return pairs.join('|');
}

function pclExportXlsx(){
  if(!pclResults.length || !pclResults.some(r=>r&&r.status==='done')){ setStatus('pcl_status','error','Nothing classified yet.'); return; }
  const category = document.getElementById('pcl_category').value;
  const brand = document.getElementById('pcl_brand').value.trim();
  const attrs = (pclCategoriesCache[category]&&pclCategoriesCache[category].attrs)||[];
  const rows = pclRows.map((r,i)=>{
    const res = pclResults[i]; const a = (res&&res.attributes)||{};
    const base = {'Item Number':r.itemNumber,'Product Name':r.productName};
    attrs.forEach(attr=>{ base[attr]=a[attr]||''; });
    base['Confidence'] = res?res.confidence||'':'';
    base['Status'] = res?res.status:'not run';
    base['Pipe Format'] = res&&res.status==='done' ? pclBuildPipeString(r.itemNumber,r.productName,attrs,a,brand) : '';
    return base;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Classified');
  XLSX.writeFile(wb, 'product_classifier_'+(category||'export')+'.xlsx');
}
</script>
</body>
</html>`;
