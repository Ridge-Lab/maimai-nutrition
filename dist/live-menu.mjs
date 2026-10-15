import { coverageSummary, nutrientCoverage } from './coverage.mjs';
import {officialNutritionFor,officialGapFor} from './official-nutrition.mjs';
export { coverageSummary, mergeResolvedMenu } from './coverage.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nameKey = (name) => typeof name === 'string' ? name.normalize('NFKC').replace(/\s+/g, '').trim() : '';

function businessData(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('官方响应结构无法识别');
  if (payload.success === false || payload.isError === true) throw new Error('官方接口返回失败');
  if (own(payload, 'data') && (own(payload, 'success') || own(payload, 'message'))) {
    if (own(payload, 'code') && ![0, 200, '0', '200'].includes(payload.code)) throw new Error('官方接口返回失败');
    return payload.data;
  }
  return payload;
}

function jsonInText(text) {
  try { return JSON.parse(text); } catch { /* Tool text may contain documentation before JSON. */ }
  let fallback;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        if (stack.pop() !== (character === '}' ? '{' : '[')) break;
        if (!stack.length) {
          try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && (own(parsed, 'success') || own(parsed, 'data'))) return parsed;
            fallback ??= parsed;
            start = end;
          } catch { /* Continue past prose placeholders such as {code}. */ }
          break;
        }
      }
    }
  }
  if (fallback !== undefined) return fallback;
  throw new Error('官方响应没有可读取的 JSON 数据');
}

/** Return the business data, preferring structuredContent over explanatory text. */
export function unwrapResult(result) {
  if (result?.isError === true) throw new Error('官方接口返回失败');
  if (result?.structuredContent !== undefined) return businessData(result.structuredContent);
  if (Array.isArray(result?.content)) {
    const text = result.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
    return businessData(jsonInText(text));
  }
  return businessData(typeof result === 'string' ? jsonInText(result) : result);
}

export function parseStores(result) {
  const rows = unwrapResult(result);
  if (!Array.isArray(rows)) throw new Error('门店响应缺少列表');
  const seen = new Set();
  return rows.filter((row) => row && row.storeCode != null && typeof row.storeName === 'string').flatMap((row) => {
    const code = String(row.storeCode);
    if (!code || seen.has(code)) return [];
    seen.add(code);
    return [{ code, name: row.storeName, address: typeof row.address === 'string' ? row.address : '' }];
  });
}

// Only equivalent names which retain an explicit serving size are allowed here.
const ALIASES = new Map([
  ['中杯可乐', '可乐中杯'], ['大杯可乐', '可乐大杯'], ['小杯可乐', '可乐小杯'],
  ['中杯无糖可口可乐', '无糖可口可乐中杯'], ['大杯无糖可口可乐', '无糖可口可乐大杯'], ['小杯无糖可口可乐', '无糖可口可乐小杯'],
  ['中杯雪碧', '雪碧中杯'], ['大杯雪碧', '雪碧大杯'], ['小杯雪碧', '雪碧小杯'],
  ['薯条(小份)', '小薯条'], ['薯条(中份)', '中薯条'], ['薯条(大份)', '大薯条'],
  ['玉米杯(小杯)', '小杯玉米杯'], ['玉米杯(大杯)', '大杯玉米杯'],
  ['麦乐鸡(5块)', '麦乐鸡5块'], ['麦乐鸡(4块)', '麦乐鸡4块'],
  ['麦乐鸡-5块', '麦乐鸡5块'], ['麦乐鸡-4块', '麦乐鸡4块'],
  ['5块麦乐鸡', '麦乐鸡5块'], ['4块麦乐鸡', '麦乐鸡4块'],
  ['麦辣鸡翅2块', '麦辣鸡翅-2块'], ['麦辣鸡翅(2块)', '麦辣鸡翅-2块'],
].map(([from, to]) => [nameKey(from), nameKey(to)]));

const NUTRIENTS = ['energyKj', 'energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium'];

// Used only to identify that a serving must be selected, never to assign values.
function servingFamily(name) {
  return nameKey(name).replace(/^可口可乐$/, '可乐')
    .replace(/^(?:小|中|大)杯/, '').replace(/^(?:迷你|小|中|大)(?=薯条)/, '')
    .replace(/(?:小|中|大)杯$/, '').replace(/[45]块$/, '');
}

function nutritionIndex(records) {
  const result = new Map();
  for (const row of records) {
    if (!row || !nameKey(row.productName)) continue;
    const key = nameKey(row.productName);
    const signature = JSON.stringify(NUTRIENTS.map((field) => known(row[field]) ? row[field] : null));
    const old = result.get(key);
    if (!old) result.set(key, { row, signature, ambiguous: false });
    else if (old.signature !== signature) old.ambiguous = true;
  }
  return result;
}

function nutritionLookup(name, nutrients, code) {
  const key = nameKey(name);
  const supplement=officialNutritionFor(name,code);
  let match = nutrients.get(key);
  let nutritionMatch = match ? 'exact' : 'unmatched';
  if (!match) {
    // The official menu adds the McCafé brand to the same fully specified
    // drink. Keep every temperature, flavour and cup-size token unchanged.
    const unbranded = key.replace(/^麦咖啡(?:TM)?/, '');
    const alias = ALIASES.get(key) ?? (unbranded !== key ? unbranded : null);
    if (alias) match = nutrients.get(alias);
    if (match) nutritionMatch = 'alias';
  }
  if(!match&&supplement?.matchMode==='code-and-name'){
    match=nutrients.get(nameKey(supplement.nutrition.officialName));
    if(match)nutritionMatch='verified-code';
  }
  if (match) {
    if(match.ambiguous)return {row:null,nutritionName:match.row.productName,nutritionMatch:'ambiguous',nutritionNote:null};
    const row={...match.row},added=[],conflicts=[];
    if(supplement)for(const field of NUTRIENTS){
      const value=supplement.nutrition[field==='energyKcal'?'kcal':field];
      if(!known(row[field])&&known(value)){row[field]=value;added.push(field);}
      else if(known(value)&&known(row[field])&&row[field]!==value)conflicts.push(field);
    }
    return {row,nutritionName:match.row.productName,nutritionMatch,
      nutritionSource:added.length?'official-mcp-and-product-page':'official-mcp-nutrition',
      sourceUrl:supplement?.nutrition.url,
      nutritionNote:supplement?[(nutritionMatch==='verified-code'?'官方商品编码 '+code+' 的独立详情确认“'+supplement.nutrition.officialName+'”。':''),
        added.length?'缺失字段以官网 '+supplement.nutrition.nutritionDate+' 标准份补充。':'',
        conflicts.length?'本次MCP与官网参考存在数值差异，保留本次MCP值。':'',
        '官网资料 '+supplement.nutrition.nutritionDate+'；核对 '+supplement.nutrition.checkedAt+'。'].filter(Boolean).join(' '):null};
  }
  if(supplement){
    const official=supplement.nutrition;
    return {row:{...official,productName:official.officialName,energyKcal:official.kcal},nutritionName:official.officialName,
      nutritionMatch:'official-page',nutritionSource:'official-product-page',sourceUrl:official.url,
      nutritionNote:'官网 '+official.nutritionDate+' 标准份（'+official.portionLabel+'）；kcal=round('+official.energyKj+' kJ÷4.184)。核对 '+official.checkedAt+'。'+(supplement.matchMode==='code-and-name'?'同一商品编码 '+code+' 的官方详情确认盒装规格。':'完整品名及风味与官网一致。')};
  }
  // This is an explicit count of the identical food, not an estimate from
  // another flavour or a different cup size. Never rescale rounded nugget
  // records: the official table already has separate 4- and 5-piece rows.
  if (key === '麦辣鸡翅4块' || key === '麦辣鸡翅(4块)') {
    const basis = nutrients.get(nameKey('麦辣鸡翅-2块'));
    if (basis?.ambiguous) return { row: null, nutritionName: basis.row.productName, nutritionMatch: 'ambiguous', nutritionNote: null };
    if (basis) {
      const row = { ...basis.row };
      for (const field of NUTRIENTS) row[field] = known(row[field]) && Number.isFinite(row[field] * 2) ? row[field] * 2 : null;
      return { row, nutritionName: basis.row.productName, nutritionMatch: 'portion-scaled',
        nutritionNote: '按官方「麦辣鸡翅-2块」每份 × 2 计算（共 4 块）' };
    }
  }
  const gap=officialGapFor(name,code);
  return { row: null, nutritionName: null, nutritionMatch: 'unmatched', nutritionNote: gap?'官网已核查（'+gap.checkedAt+'）：'+gap.reason:null,
    sourceUrl:gap?.reviewedUrls[0] };
}

function nutrientFields(row) {
  return {
    kcal: row && known(row.energyKcal) ? row.energyKcal : null,
    ...Object.fromEntries(NUTRIENTS.filter((field) => field !== 'energyKcal').map((field) => [field, row && known(row[field]) ? row[field] : null])),
  };
}

/** Match an official fully specified component, without menu category heuristics. */
export function matchNutrition(name, nutritionRecords, {code}={}) {
  const records = Array.isArray(nutritionRecords) ? nutritionRecords : nutritionRecords?.foods;
  if (!Array.isArray(records)) throw new TypeError('营养目录必须是数组');
  const match = nutritionLookup(name, nutritionIndex(records),code);
  return { ...nutrientFields(match.row), nutritionMatch: match.nutritionMatch,
    nutritionName: match.nutritionName, nutritionNote: match.nutritionNote,
    nutritionSource: match.row ? match.nutritionSource||'official-mcp-nutrition' : null,
    sourceUrl: match.sourceUrl||'https://open.mcd.cn/mcp/doc' };
}

function money(value) {
  if (known(value)) return value;
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return known(parsed) ? parsed : null;
}

function nonFood(name) {
  if (/水手帽|徽章|玩具|公仔|钥匙扣|购物袋|保温杯|马克杯|周边|盲盒|积木|贴纸|手办/.test(name)) return true;
  return /麦金卡|早餐卡|会员卡|礼品卡|储值卡/.test(name) && !/汉堡|套餐|薯条|麦乐鸡|饮料|咖啡|牛奶/.test(name);
}

function mealFlag(name, categories, entry) {
  return /套餐|件套|随心配|随心拼|随心选|分享餐|开心乐园餐|双全盒|小食盘|拼盘|组合|双拼/.test(name)
    || categories.some((category) => /单人餐|多人餐|大卡套餐|开心乐园|随心配/.test(category))
    || (Array.isArray(entry.rounds) && entry.rounds.length > 0);
}

/** Category/icon heuristics affect presentation only, never nutrition matching. */
function displayCategory(name, categories, isMeal) {
  if (isMeal) return ['main', 'burger'];
  if (categories.some((category) => /饮品|饮料|咖啡/.test(category))) return ['drink', 'cola'];
  if (categories.some((category) => /小食|甜品|其他/.test(category))) {
    if (/冰淇淋|圆筒|新地|麦旋风|派|拉明顿|雪糕/.test(name)) return ['dessert', 'icecream'];
    return ['side', /玉米/.test(name) ? 'corn' : /薯/.test(name) ? 'fries' : 'nuggets'];
  }
  if (categories.some((category) => /炸鸡|蘸酱/.test(category))) return ['side', 'nuggets'];
  if (categories.some((category) => /汉堡|肉堡|牛鱼|卷/.test(category))) return ['main', 'burger'];
  if (/冰淇淋|圆筒|新地|麦旋风|派|拉明顿/.test(name)) return ['dessert', 'icecream'];
  if (/可乐|雪碧|咖啡|奶铁|牛奶|奶昔|红茶|果汁|纯悦|怡泉/.test(name)) return ['drink', 'cola'];
  if (/薯|玉米|鸡翅|鸡块|鸡排|酱|苹果片/.test(name)) return ['side', /玉米/.test(name) ? 'corn' : /薯/.test(name) ? 'fries' : 'nuggets'];
  return ['main', 'burger'];
}

/** Normalize the observed query-meals map without inventing variants or prices. */
export function normalizeMenu(result, nutritionRecords) {
  const menu = unwrapResult(result);
  if (!menu || !Array.isArray(menu.categories) || !menu.meals || typeof menu.meals !== 'object' || Array.isArray(menu.meals)) throw new Error('菜单响应结构无法识别');
  const records = Array.isArray(nutritionRecords) ? nutritionRecords : nutritionRecords?.foods;
  if (!Array.isArray(records)) throw new TypeError('营养目录必须是数组');
  const nutrients = nutritionIndex(records);
  const categoriesByCode = new Map();
  const order = [];
  const seen = new Set();
  for (const category of menu.categories) {
    if (!category || !Array.isArray(category.meals)) continue;
    for (const reference of category.meals) {
      if (reference?.code == null) continue;
      const code = String(reference.code);
      if (!categoriesByCode.has(code)) categoriesByCode.set(code, []);
      if (typeof category.name === 'string') categoriesByCode.get(code).push(category.name);
      if (!seen.has(code)) { order.push(code); seen.add(code); }
    }
  }
  for (const code of Object.keys(menu.meals)) if (!seen.has(code)) order.push(code);
  const foods = [];
  const stats = { total: Object.keys(menu.meals).length, displayed: 0, matched: 0, unknown: 0, ambiguous: 0, meals: 0, conditionalPrices: 0, filteredNonFood: 0 };
  for (const code of order) {
    const entry = menu.meals[code];
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const name = entry.name;
    if (nonFood(name)) { stats.filteredNonFood++; continue; }
    const officialCategories = categoriesByCode.get(code) ?? [];
    const isMeal = mealFlag(name, officialCategories, entry);
    const key = nameKey(name);
    const match = nutritionLookup(name, nutrients,code);
    const nutritionMatch = isMeal ? 'unexpanded-meal' : match.nutritionMatch;
    const row = isMeal ? null : match.row;
    const conditional = entry.canWithOrder === true || entry.withOrder != null || (typeof entry.discountType === 'string' && /会员|麦金卡|早餐卡|随单购|购卡|专享/.test(entry.discountType));
    const parsedPrice = money(entry.currentPrice);
    const [category, icon] = displayCategory(name, officialCategories, isMeal);
    const food = {
      id: `menu-${code}`, productCode: code, name, image: typeof entry.image === 'string' ? entry.image : null,
      category, icon, officialCategories: [...officialCategories], isMeal,
      spec: isMeal ? '套餐搭配待展开' : row ? '标准版 · 官方每份营养参考' : '规格与营养待核实',
      ...nutrientFields(row),
      price: conditional ? null : parsedPrice, priceMode: 'menu-reference', conditionalPrice: conditional ? parsedPrice : null,
      priceNote: conditional ? '此展示价含会员或附购条件，尚未核价' : parsedPrice === null ? '菜单未返回有效现价' : '门店菜单参考价，最终金额需官方核价',
      discountType: typeof entry.discountType === 'string' ? entry.discountType : null,
      canWithOrder: entry.canWithOrder === true,
      referenceSource: 'official-mcp-menu', nutritionSource: row ? match.nutritionSource||'official-mcp-nutrition' : null,
      nutritionMatch, nutritionName: row ? match.nutritionName : null, nutritionNote: isMeal?null:match.nutritionNote,
      nutritionStatus: isMeal ? 'needs-selection' : match.nutritionMatch === 'ambiguous' ? 'ambiguous' : row ? 'matched'
        : records.some((record) => nameKey(record?.productName) !== key && servingFamily(record?.productName) === servingFamily(name)) ? 'needs-selection' : 'unmatched',
      sourceUrl: match.sourceUrl||'https://open.mcd.cn/mcp/doc',
    };
    food.nutrientCoverage = nutrientCoverage(food);
    if (menu.storeCode != null) food.storeCode = String(menu.storeCode);
    foods.push(food);
    if (food.kcal === null) stats.unknown++; else stats.matched++;
    if (nutritionMatch === 'ambiguous') stats.ambiguous++;
    if (isMeal) stats.meals++;
    if (conditional) stats.conditionalPrices++;
  }
  stats.displayed = foods.length;
  return { foods, stats, coverage: coverageSummary(foods) };
}
