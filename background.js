const CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_CACHE_TTL_MS = CACHE_TTL_MS;
const OFFERS_CACHE_TTL_MS = CACHE_TTL_MS;
const PS_STORE_REQUEST_CONCURRENCY = 2;
const PS_STORE_REQUEST_INTERVAL_MS = 700;
const PS_STORE_BACKOFF_MS = 2 * 60 * 1000;
const MAX_COMPARISON_CACHE_ENTRIES = 300;
const MAX_OFFERS_CACHE_ENTRIES = 12;

const STORAGE_KEYS = {
  cacheStatus: "pspcCacheStatus",
  comparisons: "pspcComparisonCache",
  giftCardOffers: "pspcGiftCardOffersCache"
};

const DEFAULT_SETTINGS = {
  selectedStoreIds: ["tr", "in", "pl"],
  manualRates: {}
};

const STORE_BY_ID = {
  tr: {
    id: "tr",
    label: "Турция",
    region: "Турция",
    currency: "TRY",
    currencyLocale: "tr-TR",
    locales: ["en-tr"]
  },
  in: {
    id: "in",
    label: "Индия",
    region: "Индия",
    currency: "INR",
    currencyLocale: "en-IN",
    locales: ["en-in"]
  },
  pl: {
    id: "pl",
    label: "Польша",
    region: "Польша",
    currency: "PLN",
    currencyLocale: "pl-PL",
    locales: ["pl-pl", "en-pl"]
  }
};

const localePriceCache = new Map();
const localePriceInFlight = new Map();
const comparisonCache = new Map();
const comparisonInFlight = new Map();
const offersCache = new Map();
const offersInFlight = new Map();
const conceptProductCache = new Map();
const conceptProductInFlight = new Map();
const psStoreRequestQueue = [];
let psStoreActiveRequests = 0;
let psStoreLastRequestStartedAt = 0;
let psStoreBackoffUntil = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const selectedStoreIds = normalizeSelectedStoreIds(stored.selectedStoreIds);

  if (selectedStoreIds.length === 0) {
    await chrome.storage.sync.set({
      selectedStoreIds: DEFAULT_SETTINGS.selectedStoreIds
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_PRICE_COMPARISON") {
    handlePriceComparison(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );

    return true;
  }

  if (message?.type === "PRELOAD_GIFT_CARD_OFFERS") {
    preloadGiftCardOffers()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );

    return true;
  }

  if (message?.type === "GET_CACHE_STATUS") {
    getCacheStatus()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );

    return true;
  }

  if (message?.type === "CLEAR_CACHE") {
    clearCache()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );

    return true;
  }

  return false;
});

async function handlePriceComparison(message) {
  const parsed = parseStoreUrl(message.productUrl);
  if (!parsed) {
    throw new Error("Unsupported PlayStation Store product URL");
  }

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const selectedStoreIds = normalizeSelectedStoreIds(settings.selectedStoreIds);
  const effectiveStoreIds =
    selectedStoreIds.length > 0 ? selectedStoreIds : DEFAULT_SETTINGS.selectedStoreIds;
  const manualRates = normalizeManualRates(settings.manualRates);
  const rateCacheKey = buildRateCacheKey(effectiveStoreIds, manualRates);
  const storeItemCacheKey = buildStoreItemCacheKey(parsed, effectiveStoreIds, rateCacheKey);
  const cachedStoreItemComparison = await readCacheEntry(
    STORAGE_KEYS.comparisons,
    comparisonCache,
    storeItemCacheKey,
    CACHE_TTL_MS
  );

  if (cachedStoreItemComparison) {
    return cachedStoreItemComparison;
  }

  const productId =
    parsed.type === "product"
      ? parsed.productId
      : await resolveConceptProductId(
          parsed.conceptId,
          parsed.locale,
          normalizeProductIdHints(message.productIdHints),
          message.conceptPriceHint
        );

  if (!productId) {
    throw new Error("Could not resolve PlayStation Store product");
  }

  const comparisonCacheKey = buildComparisonCacheKey(productId, effectiveStoreIds, rateCacheKey);
  const cachedComparison = await readCacheEntry(
    STORAGE_KEYS.comparisons,
    comparisonCache,
    comparisonCacheKey,
    CACHE_TTL_MS
  );

  if (cachedComparison) {
    comparisonCache.set(storeItemCacheKey, {
      timestamp: Date.now(),
      value: cachedComparison
    });
    return cachedComparison;
  }

  const pendingComparison =
    comparisonInFlight.get(storeItemCacheKey) || comparisonInFlight.get(comparisonCacheKey);
  if (pendingComparison) {
    return pendingComparison;
  }

  const request = (async () => {
    const result = await buildPriceComparison(productId, effectiveStoreIds, manualRates);
    await writeCacheEntry(
      STORAGE_KEYS.comparisons,
      comparisonCache,
      comparisonCacheKey,
      result,
      MAX_COMPARISON_CACHE_ENTRIES
    );
    await writeCacheEntry(
      STORAGE_KEYS.comparisons,
      comparisonCache,
      storeItemCacheKey,
      result,
      MAX_COMPARISON_CACHE_ENTRIES
    );
    await updateCacheStatus({ comparisonsUpdatedAt: result.updatedAt });
    return result;
  })();

  comparisonInFlight.set(storeItemCacheKey, request);
  comparisonInFlight.set(comparisonCacheKey, request);

  try {
    return await request;
  } finally {
    comparisonInFlight.delete(storeItemCacheKey);
    comparisonInFlight.delete(comparisonCacheKey);
  }
}

async function buildPriceComparison(productId, effectiveStoreIds, manualRates = {}) {
  const rows = (
    await Promise.all(
      effectiveStoreIds.map(async (storeId) => {
        const storeMeta = STORE_BY_ID[storeId];
        if (!storeMeta) {
          return null;
        }

        const manualRate = manualRates[storeId] ?? null;
        const [price, offers] = await Promise.all([
          fetchPsStorePrice(productId, storeMeta),
          manualRate ? Promise.resolve([]) : fetchGiftCardOffers(storeMeta)
        ]);

        return buildStoreRow(storeMeta, price, offers, manualRate);
      })
    )
  ).filter(Boolean);

  const cheapestRow = rows
    .filter((row) => row.available && typeof row.currentRubAmount === "number")
    .sort((left, right) => left.currentRubAmount - right.currentRubAmount)[0];

  return {
    productId,
    rows: rows.map((row) => ({
      ...row,
      cheapest: cheapestRow ? cheapestRow.storeId === row.storeId : false
    })),
    updatedAt: new Date().toISOString()
  };
}

async function preloadGiftCardOffers() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const selectedStoreIds = normalizeSelectedStoreIds(settings.selectedStoreIds);
  const effectiveStoreIds =
    selectedStoreIds.length > 0 ? selectedStoreIds : DEFAULT_SETTINGS.selectedStoreIds;
  const manualRates = normalizeManualRates(settings.manualRates);

  await Promise.all(
    effectiveStoreIds.map(async (storeId) => {
      const storeMeta = STORE_BY_ID[storeId];
      if (!storeMeta || manualRates[storeId]) {
        return;
      }

      await fetchGiftCardOffers(storeMeta);
    })
  );
}

async function getCacheStatus() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cacheStatus);
  const status = stored[STORAGE_KEYS.cacheStatus] || {};
  const now = Date.now();

  return {
    ttlMs: CACHE_TTL_MS,
    comparisonsUpdatedAt: normalizeFreshIsoTimestamp(
      status.comparisonsUpdatedAt || getLatestMemoryCacheTimestamp(comparisonCache),
      now
    ),
    giftCardOffersUpdatedAt: normalizeFreshIsoTimestamp(
      status.giftCardOffersUpdatedAt || getLatestMemoryCacheTimestamp(offersCache),
      now
    )
  };
}

async function clearCache() {
  localePriceCache.clear();
  comparisonCache.clear();
  offersCache.clear();
  conceptProductCache.clear();

  await chrome.storage.local.remove(Object.values(STORAGE_KEYS));
}

function buildComparisonCacheKey(productId, storeIds, rateCacheKey) {
  return `${productId}:${[...storeIds].sort().join(",")}:${rateCacheKey}`;
}

function buildStoreItemCacheKey(parsedStoreUrl, storeIds, rateCacheKey) {
  const storesKey = [...storeIds].sort().join(",");
  const itemKey =
    parsedStoreUrl.type === "product"
      ? `product:${parsedStoreUrl.productId}`
      : `concept:${parsedStoreUrl.locale}:${parsedStoreUrl.conceptId}`;

  return `${itemKey}:${storesKey}:${rateCacheKey}`;
}

function buildRateCacheKey(storeIds, manualRates) {
  const parts = [...storeIds]
    .sort()
    .map((storeId) => {
      const rate = manualRates[storeId];
      return rate ? `${storeId}=${rate}` : `${storeId}=auto`;
    });

  return `rates:${parts.join(",")}`;
}

async function readCacheEntry(storageKey, memoryCache, cacheKey, ttlMs) {
  const memoryEntry = memoryCache.get(cacheKey);
  if (isFreshCacheEntry(memoryEntry, ttlMs)) {
    return memoryEntry.value;
  }

  if (memoryEntry) {
    memoryCache.delete(cacheKey);
  }

  const stored = await chrome.storage.local.get(storageKey);
  const storageEntry = stored[storageKey]?.[cacheKey];

  if (!isFreshCacheEntry(storageEntry, ttlMs)) {
    return null;
  }

  memoryCache.set(cacheKey, storageEntry);
  return storageEntry.value;
}

async function writeCacheEntry(storageKey, memoryCache, cacheKey, value, maxEntries) {
  const timestamp = Date.now();
  const entry = { timestamp, value };
  memoryCache.set(cacheKey, entry);

  const stored = await chrome.storage.local.get(storageKey);
  const cache = stored[storageKey] && typeof stored[storageKey] === "object" ? stored[storageKey] : {};
  cache[cacheKey] = entry;

  prunePersistentCache(cache, maxEntries);

  await chrome.storage.local.set({
    [storageKey]: cache
  });
}

async function updateCacheStatus(partialStatus) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cacheStatus);
  const currentStatus =
    stored[STORAGE_KEYS.cacheStatus] && typeof stored[STORAGE_KEYS.cacheStatus] === "object"
      ? stored[STORAGE_KEYS.cacheStatus]
      : {};

  await chrome.storage.local.set({
    [STORAGE_KEYS.cacheStatus]: {
      ...currentStatus,
      ...partialStatus
    }
  });
}

function prunePersistentCache(cache, maxEntries) {
  const now = Date.now();

  for (const [key, entry] of Object.entries(cache)) {
    if (!isFreshCacheEntry(entry, CACHE_TTL_MS, now)) {
      delete cache[key];
    }
  }

  const entries = Object.entries(cache).sort(
    (left, right) => Number(right[1]?.timestamp || 0) - Number(left[1]?.timestamp || 0)
  );

  for (const [key] of entries.slice(maxEntries)) {
    delete cache[key];
  }
}

function isFreshCacheEntry(entry, ttlMs, now = Date.now()) {
  return Boolean(
    entry &&
      Number.isFinite(Number(entry.timestamp)) &&
      now - Number(entry.timestamp) < ttlMs &&
      Object.hasOwn(entry, "value")
  );
}

function getLatestMemoryCacheTimestamp(memoryCache) {
  const latestTimestamp = [...memoryCache.values()].reduce((latest, entry) => {
    const timestamp = Number(entry?.timestamp);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);

  return latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : null;
}

function normalizeFreshIsoTimestamp(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || now - timestamp >= CACHE_TTL_MS) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function buildStoreRow(storeMeta, price, offers, manualRate = null) {
  if (!price) {
    return {
      storeId: storeMeta.id,
      label: storeMeta.label,
      available: false,
      currency: storeMeta.currency
    };
  }

  const originalAmount = roundCurrency(
    Number.isFinite(price.originalAmount) ? price.originalAmount : price.currentAmount
  );
  const currentAmount = roundCurrency(
    Number.isFinite(price.currentAmount) ? price.currentAmount : originalAmount
  );
  const hasDiscount = currentAmount < originalAmount;
  const originalRubQuote = buildRubQuote(originalAmount, offers, storeMeta, manualRate);
  const currentRubQuote =
    hasDiscount || !originalRubQuote
      ? buildRubQuote(currentAmount, offers, storeMeta, manualRate)
      : originalRubQuote;

  return {
    storeId: storeMeta.id,
    locale: price.locale,
    label: storeMeta.label,
    available: true,
    currency: storeMeta.currency,
    originalAmount,
    currentAmount,
    originalText: formatCurrency(originalAmount, storeMeta.currency, storeMeta.currencyLocale),
    currentText: formatCurrency(currentAmount, storeMeta.currency, storeMeta.currencyLocale),
    originalRubAmount: originalRubQuote?.rubAmount ?? null,
    currentRubAmount: currentRubQuote?.rubAmount ?? null,
    originalRubText: originalRubQuote?.rubText ?? "Нет данных курса",
    currentRubText: currentRubQuote?.rubText ?? "Нет данных курса",
    originalRubQuote,
    currentRubQuote,
    hasDiscount
  };
}

function buildRubQuote(targetAmount, offers, storeMeta, manualRate = null) {
  if (Number.isFinite(manualRate) && manualRate > 0) {
    return buildManualRubQuote(targetAmount, manualRate, storeMeta);
  }

  if (!Array.isArray(offers) || offers.length === 0) {
    return null;
  }

  const basket = findOptimalBasket(targetAmount, offers);
  if (!basket) {
    return null;
  }

  return {
    rubAmount: basket.totalRubAmount,
    rubText: formatCurrency(basket.totalRubAmount, "RUB", "ru-RU"),
    targetAmount: roundCurrency(targetAmount),
    coveredAmount: basket.coveredAmount,
    leftoverAmount: basket.leftoverAmount,
    effectiveBasketRate: basket.totalRubAmount / basket.coveredAmount,
    effectiveGameRate: basket.totalRubAmount / targetAmount,
    combinationLabel: basket.cards.map((card) => `${card.count}x${card.valueString}`).join(" + "),
    cards: basket.cards.map((card) => ({
      count: card.count,
      value: card.value,
      valueString: card.valueString,
      rubAmount: card.rubAmount,
      rubText: formatCurrency(card.rubAmount, "RUB", "ru-RU")
    })),
    currency: storeMeta.currency,
    currencyLocale: storeMeta.currencyLocale
  };
}

function buildManualRubQuote(targetAmount, manualRate, storeMeta) {
  const rubAmount = roundCurrency(targetAmount * manualRate);

  return {
    source: "manual",
    rate: manualRate,
    rubAmount,
    rubText: formatCurrency(rubAmount, "RUB", "ru-RU"),
    targetAmount: roundCurrency(targetAmount),
    effectiveBasketRate: manualRate,
    effectiveGameRate: manualRate,
    cards: [],
    currency: storeMeta.currency,
    currencyLocale: storeMeta.currencyLocale
  };
}

function findOptimalBasket(targetAmount, offers) {
  const targetUnits = Math.max(0, Math.ceil(targetAmount - 1e-9));
  if (targetUnits === 0) {
    return {
      totalRubAmount: 0,
      coveredAmount: 0,
      leftoverAmount: 0,
      cards: []
    };
  }

  const normalizedOffers = offers
    .map((offer) => ({
      ...offer,
      valueUnits: Math.round(Number(offer.value)),
      priceKopecks: Math.round(Number(offer.priceKopecks))
    }))
    .filter(
      (offer) =>
        Number.isFinite(offer.valueUnits) &&
        offer.valueUnits > 0 &&
        Number.isFinite(offer.priceKopecks) &&
        offer.priceKopecks > 0
    )
    .sort((left, right) => left.valueUnits - right.valueUnits);

  if (normalizedOffers.length === 0) {
    return null;
  }

  const maxValueUnits = Math.max(...normalizedOffers.map((offer) => offer.valueUnits));
  const limit = targetUnits + maxValueUnits;

  const bestCost = new Array(limit + 1).fill(Infinity);
  const bestCardCount = new Array(limit + 1).fill(Infinity);
  const previousAmount = new Array(limit + 1).fill(-1);
  const previousOfferIndex = new Array(limit + 1).fill(-1);

  bestCost[0] = 0;
  bestCardCount[0] = 0;

  for (let amount = 1; amount <= limit; amount += 1) {
    for (let index = 0; index < normalizedOffers.length; index += 1) {
      const offer = normalizedOffers[index];
      const nextFrom = amount - offer.valueUnits;

      if (nextFrom < 0 || !Number.isFinite(bestCost[nextFrom])) {
        continue;
      }

      const candidateCost = bestCost[nextFrom] + offer.priceKopecks;
      const candidateCardCount = bestCardCount[nextFrom] + 1;

      if (
        candidateCost < bestCost[amount] ||
        (candidateCost === bestCost[amount] && candidateCardCount < bestCardCount[amount])
      ) {
        bestCost[amount] = candidateCost;
        bestCardCount[amount] = candidateCardCount;
        previousAmount[amount] = nextFrom;
        previousOfferIndex[amount] = index;
      }
    }
  }

  let bestAmount = -1;

  for (let amount = targetUnits; amount <= limit; amount += 1) {
    if (!Number.isFinite(bestCost[amount])) {
      continue;
    }

    if (bestAmount === -1) {
      bestAmount = amount;
      continue;
    }

    const candidateOvershoot = amount - targetUnits;
    const currentOvershoot = bestAmount - targetUnits;

    if (
      bestCost[amount] < bestCost[bestAmount] ||
      (bestCost[amount] === bestCost[bestAmount] && candidateOvershoot < currentOvershoot) ||
      (bestCost[amount] === bestCost[bestAmount] &&
        candidateOvershoot === currentOvershoot &&
        bestCardCount[amount] < bestCardCount[bestAmount])
    ) {
      bestAmount = amount;
    }
  }

  if (bestAmount === -1) {
    return null;
  }

  const counts = new Map();
  let cursor = bestAmount;

  while (cursor > 0) {
    const offerIndex = previousOfferIndex[cursor];
    if (offerIndex < 0) {
      return null;
    }

    counts.set(offerIndex, (counts.get(offerIndex) ?? 0) + 1);
    cursor = previousAmount[cursor];
  }

  const cards = [...counts.entries()]
    .sort((left, right) => normalizedOffers[right[0]].valueUnits - normalizedOffers[left[0]].valueUnits)
    .map(([offerIndex, count]) => {
      const offer = normalizedOffers[offerIndex];
      return {
        count,
        value: offer.valueUnits,
        valueString: offer.valueString,
        rubAmount: roundCurrency((offer.priceKopecks * count) / 100)
      };
    });

  const coveredAmount = bestAmount;
  const totalRubAmount = roundCurrency(bestCost[bestAmount] / 100);

  return {
    totalRubAmount,
    coveredAmount,
    leftoverAmount: roundCurrency(coveredAmount - targetAmount),
    cards
  };
}

function parseStoreUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, "https://store.playstation.com");
    const match = url.pathname.match(/^\/([a-z]{2}-[a-z]{2})\/(product|concept)\/([^/?#]+)/i);

    if (!match) {
      return null;
    }

    const type = match[2].toLowerCase();
    const id = match[3];

    return type === "product"
      ? {
          type,
          locale: match[1].toLowerCase(),
          productId: id
        }
      : {
          type,
          locale: match[1].toLowerCase(),
          conceptId: id
        };
  } catch {
    return null;
  }
}

async function resolveConceptProductId(conceptId, locale, productIdHints = [], conceptPriceHint = null) {
  const hintedProductId = await chooseHintedProductId(productIdHints, locale, conceptPriceHint);
  if (hintedProductId) {
    return hintedProductId;
  }

  const cacheKey = `${locale}:${conceptId}`;
  const cached = conceptProductCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL_MS) {
    return cached.value;
  }

  const pending = conceptProductInFlight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    const response = await fetchPsStoreDocument(
      `https://store.playstation.com/${locale}/concept/${conceptId}`
    );

    if (!response.ok) {
      conceptProductCache.set(cacheKey, { timestamp: Date.now(), value: null });
      return null;
    }

    const html = await response.text();
    const productId = parseProductIdFromConceptHtml(html, conceptId, locale);
    conceptProductCache.set(cacheKey, { timestamp: Date.now(), value: productId });
    return productId;
  })();

  conceptProductInFlight.set(cacheKey, request);

  try {
    return await request;
  } finally {
    conceptProductInFlight.delete(cacheKey);
  }
}

async function chooseHintedProductId(productIdHints, locale, conceptPriceHint) {
  if (productIdHints.length === 0) {
    return null;
  }

  const storeMeta = getStoreMetaByLocale(locale);
  const priceHintAmount = parseAmountFromFormatted(conceptPriceHint);

  if (!storeMeta || !Number.isFinite(priceHintAmount)) {
    return productIdHints[0];
  }

  const candidates = await Promise.all(
    productIdHints.map(async (productId) => {
      const price = await fetchPsStorePrice(productId, storeMeta);
      if (!price) {
        return null;
      }

      const currentDelta = Math.abs(price.currentAmount - priceHintAmount);
      const originalDelta = Math.abs(price.originalAmount - priceHintAmount);
      return {
        productId,
        delta: Math.min(currentDelta, originalDelta)
      };
    })
  );

  const best = candidates
    .filter(Boolean)
    .sort((left, right) => left.delta - right.delta)[0];

  return best?.delta <= 0.02 ? best.productId : productIdHints[0];
}

function getStoreMetaByLocale(locale) {
  return Object.values(STORE_BY_ID).find((storeMeta) => storeMeta.locales.includes(locale)) || null;
}

async function fetchPsStorePrice(productId, storeMeta) {
  for (const locale of storeMeta.locales) {
    const cacheKey = `${locale}:${productId}`;
    const cached = localePriceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL_MS) {
      if (cached.value) {
        return cached.value;
      }
      continue;
    }

    const pending = localePriceInFlight.get(cacheKey);
    if (pending) {
      const value = await pending;
      if (value) {
        return value;
      }
      continue;
    }

    const request = (async () => {
      const response = await fetchPsStoreDocument(
        `https://store.playstation.com/${locale}/product/${productId}`
      );

      if (!response.ok) {
        localePriceCache.set(cacheKey, { timestamp: Date.now(), value: null });
        return null;
      }

      const html = await response.text();
      const price = parsePsStorePriceFromHtml(html, storeMeta.currency, productId);
      const value = price ? { ...price, locale } : null;

      localePriceCache.set(cacheKey, { timestamp: Date.now(), value });
      return value;
    })();

    localePriceInFlight.set(cacheKey, request);

    try {
      const value = await request;
      if (value) {
        return value;
      }
    } finally {
      localePriceInFlight.delete(cacheKey);
    }
  }

  return null;
}

async function fetchPsStoreDocument(url) {
  const now = Date.now();

  if (now < psStoreBackoffUntil) {
    throw new Error("PlayStation Store временно отклоняет запросы. Попробуйте обновить страницу позже.");
  }

  const response = await enqueuePsStoreRequest(url);

  if (response.status === 403 || response.status === 429) {
    psStoreBackoffUntil = Date.now() + PS_STORE_BACKOFF_MS;
    throw new Error("PlayStation Store временно ограничил доступ. Расширение сделало паузу перед новыми запросами.");
  }

  return response;
}

function enqueuePsStoreRequest(url) {
  return new Promise((resolve, reject) => {
    psStoreRequestQueue.push({ url, resolve, reject });
    drainPsStoreRequestQueue();
  });
}

function drainPsStoreRequestQueue() {
  if (psStoreActiveRequests >= PS_STORE_REQUEST_CONCURRENCY) {
    return;
  }

  const next = psStoreRequestQueue.shift();
  if (!next) {
    return;
  }

  const scheduledAt = Math.max(
    Date.now(),
    psStoreLastRequestStartedAt + PS_STORE_REQUEST_INTERVAL_MS
  );
  const delay = Math.max(0, scheduledAt - Date.now());
  psStoreLastRequestStartedAt = scheduledAt;
  psStoreActiveRequests += 1;

  setTimeout(async () => {
    try {
      const response = await fetch(next.url, {
        credentials: "omit"
      });
      next.resolve(response);
    } catch (error) {
      next.reject(error);
    } finally {
      psStoreActiveRequests -= 1;
      drainPsStoreRequestQueue();
    }
  }, delay);
}

async function fetchGiftCardOffers(storeMeta) {
  const cacheKey = storeMeta.id;
  const cached = await readCacheEntry(
    STORAGE_KEYS.giftCardOffers,
    offersCache,
    cacheKey,
    OFFERS_CACHE_TTL_MS
  );

  if (cached) {
    return cached;
  }

  const pending = offersInFlight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    const url =
      "https://gw.cg.yandex.ru/api/v1/store/products/5/offers?" +
      new URLSearchParams({
        deliveryType: "EMAIL",
        region: storeMeta.region,
        valueCurrency: storeMeta.currency
      }).toString();

    const response = await fetch(url, {
      credentials: "omit"
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const offers = normalizeOffers(payload, storeMeta.currency);
    const updatedAt = new Date().toISOString();
    await writeCacheEntry(
      STORAGE_KEYS.giftCardOffers,
      offersCache,
      cacheKey,
      offers,
      MAX_OFFERS_CACHE_ENTRIES
    );
    await updateCacheStatus({ giftCardOffersUpdatedAt: updatedAt });
    return offers;
  })();

  offersInFlight.set(cacheKey, request);

  try {
    return await request;
  } finally {
    offersInFlight.delete(cacheKey);
  }
}

function normalizeOffers(payload, expectedCurrency) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter(
      (item) =>
        item &&
        item.inStock !== false &&
        item.valueCurrency === expectedCurrency &&
        Number.isFinite(Number(item.value)) &&
        Number.isFinite(Number(item.price))
    )
    .map((item) => ({
      value: Number(item.value),
      valueString: item.valueString || `${item.value} ${expectedCurrency}`,
      priceKopecks: Number(item.price)
    }))
    .sort((left, right) => left.value - right.value);
}

function normalizeProductIdHints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((item) => String(item).trim())
        .filter((item) => /^[A-Z]{2}\d{4}-[A-Z0-9_]+$/i.test(item))
    )
  ];
}

function parsePsStorePriceFromHtml(html, expectedCurrency, productId) {
  const exactPrice = parsePriceFromProductCtaEnv(html, productId, expectedCurrency);
  if (exactPrice) {
    return exactPrice;
  }

  const richPrice = parsePriceFromEnvScripts(html, expectedCurrency);
  if (richPrice) {
    return richPrice;
  }

  return parsePriceFromJsonLd(html, expectedCurrency);
}

function parseProductIdFromConceptHtml(html, conceptId, locale) {
  const nextData = parseNextData(html);
  if (!nextData) {
    return null;
  }

  const apolloState = nextData?.props?.apolloState;
  if (!isPlainObject(apolloState)) {
    return null;
  }

  const concept =
    apolloState[`Concept:${conceptId}:${locale}`] ||
    Object.entries(apolloState).find(
      ([key, value]) => key.startsWith(`Concept:${conceptId}:`) && isPlainObject(value)
    )?.[1];

  if (!isPlainObject(concept) || !Array.isArray(concept.products)) {
    return null;
  }

  for (const productRef of concept.products) {
    const ref = productRef?.__ref;
    if (typeof ref !== "string") {
      continue;
    }

    const product = apolloState[ref];
    if (typeof product?.id === "string" && product.id) {
      return product.id;
    }

    const match = ref.match(/^Product:([^:]+):/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function parseNextData(html) {
  const scriptMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i
  );

  if (!scriptMatch) {
    return null;
  }

  try {
    return JSON.parse(scriptMatch[1]);
  } catch {
    return null;
  }
}

function parsePriceFromProductCtaEnv(html, productId, expectedCurrency) {
  if (!productId) {
    return null;
  }

  const envScripts = extractEnvScriptPayloads(html);

  for (const payload of envScripts) {
    const argsProductId = payload?.args?.productId;
    const cache = isPlainObject(payload?.cache) ? payload.cache : null;

    if (argsProductId !== productId || !cache) {
      continue;
    }

    const product = cache[`Product:${productId}`];
    if (!product || !Array.isArray(product.webctas)) {
      continue;
    }

    const candidates = product.webctas
      .map((entry) => {
        const ref = entry?.__ref;
        return typeof ref === "string" ? cache[ref] : null;
      })
      .map((cta) => extractPriceCandidateFromCta(cta, expectedCurrency))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);

    if (candidates.length > 0) {
      const best = candidates[0];
      return {
        currency: best.currency,
        originalAmount: best.originalAmount,
        currentAmount: best.currentAmount
      };
    }
  }

  return null;
}

function parsePriceFromEnvScripts(html, expectedCurrency) {
  const candidates = [];

  for (const parsed of extractEnvScriptPayloads(html)) {
    walkJson(parsed, (node) => {
      const candidate = extractPriceCandidate(node, expectedCurrency);
      if (candidate) {
        candidates.push(candidate);
      }
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.currentAmount - right.currentAmount;
  });

  const best = candidates[0];
  return {
    currency: best.currency,
    originalAmount: best.originalAmount,
    currentAmount: best.currentAmount
  };
}

function extractPriceCandidateFromCta(cta, expectedCurrency) {
  if (!isPlainObject(cta)) {
    return null;
  }

  const local = isPlainObject(cta.local) ? cta.local : null;
  const price = isPlainObject(cta.price) ? cta.price : null;
  if (!price) {
    return null;
  }

  const currency = firstNonEmptyString(price.currencyCode, expectedCurrency);
  if (!currency || (expectedCurrency && currency !== expectedCurrency)) {
    return null;
  }

  const originalFormatted = firstNonEmptyString(price.basePrice, local?.originalPrice);
  const currentFormatted = firstNonEmptyString(price.discountedPrice, local?.priceOrText);
  const originalFormattedAmount = parseAmountFromFormatted(originalFormatted);
  const currentFormattedAmount = parseAmountFromFormatted(currentFormatted);

  let originalAmount = resolveAmountFromRawValue(price.basePriceValue, originalFormattedAmount);
  let currentAmount = resolveAmountFromRawValue(price.discountedValue, currentFormattedAmount);

  if (!Number.isFinite(originalAmount)) {
    originalAmount = originalFormattedAmount;
  }

  if (!Number.isFinite(currentAmount)) {
    currentAmount = currentFormattedAmount;
  }

  if (!Number.isFinite(originalAmount) || !Number.isFinite(currentAmount)) {
    return null;
  }

  if (price.isFree || looksLikeIncluded(currentFormatted)) {
    return null;
  }

  let score = 0;

  if (cta.type === "ADD_TO_CART") {
    score += 3;
  }

  if (local?.ctaType === "purchase") {
    score += 3;
  }

  if (Number.isFinite(price.basePriceValue)) {
    score += 3;
  }

  if (Number.isFinite(price.discountedValue)) {
    score += 3;
  }

  if (currentAmount < originalAmount) {
    score += 2;
  }

  if (local?.offerLabel) {
    score += 1;
  }

  return {
    currency,
    originalAmount: roundCurrency(originalAmount),
    currentAmount: roundCurrency(currentAmount),
    score
  };
}

function extractPriceCandidate(node, expectedCurrency) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }

  const local = isPlainObject(node.local) ? node.local : null;
  const price = isPlainObject(node.price) ? node.price : null;

  const currency = firstNonEmptyString(
    node.priceCurrencyCode,
    node.currencyCode,
    price?.currencyCode
  );

  if (expectedCurrency && currency && currency !== expectedCurrency) {
    return null;
  }

  const originalFormatted = firstNonEmptyString(
    node.originalPriceFormatted,
    local?.originalPrice,
    price?.basePrice
  );
  const currentFormatted = firstNonEmptyString(
    node.discountPriceFormatted,
    local?.priceOrText,
    price?.discountedPrice,
    price?.discountText
  );

  const originalFormattedAmount = parseAmountFromFormatted(originalFormatted);
  const currentFormattedAmount = parseAmountFromFormatted(currentFormatted);

  let originalAmount = resolveAmountFromRawValue(
    node.originalPriceValue,
    originalFormattedAmount
  );
  let currentAmount = resolveAmountFromRawValue(
    node.discountPriceValue,
    currentFormattedAmount
  );

  if (!Number.isFinite(originalAmount)) {
    originalAmount = originalFormattedAmount;
  }

  if (!Number.isFinite(currentAmount)) {
    currentAmount = currentFormattedAmount;
  }

  if (!Number.isFinite(originalAmount) && Number.isFinite(currentAmount)) {
    originalAmount = currentAmount;
  }

  if (!Number.isFinite(currentAmount) && Number.isFinite(originalAmount)) {
    currentAmount = originalAmount;
  }

  if (!Number.isFinite(originalAmount) || !Number.isFinite(currentAmount)) {
    return null;
  }

  if (looksLikeIncluded(currentFormatted) && currentAmount === 0) {
    return null;
  }

  const resolvedCurrency = currency || expectedCurrency;
  if (!resolvedCurrency) {
    return null;
  }

  let score = 0;

  if (Number.isFinite(node.originalPriceValue)) {
    score += 4;
  }

  if (Number.isFinite(node.discountPriceValue)) {
    score += 3;
  }

  if (originalFormatted) {
    score += 2;
  }

  if (currentFormatted) {
    score += 2;
  }

  if (local) {
    score += 1;
  }

  if (price) {
    score += 1;
  }

  if (currentAmount < originalAmount) {
    score += 1;
  }

  return {
    currency: resolvedCurrency,
    originalAmount: roundCurrency(originalAmount),
    currentAmount: roundCurrency(currentAmount),
    score
  };
}

function parsePriceFromJsonLd(html, expectedCurrency) {
  const scriptMatch = html.match(
    /<script id="mfe-jsonld-tags" type="application\/ld\+json">([\s\S]*?)<\/script>/i
  );

  if (!scriptMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(scriptMatch[1]);
    const offer = parsed?.offers;
    const amount = Number(offer?.price);
    const currency = offer?.priceCurrency || expectedCurrency;

    if (!Number.isFinite(amount) || !currency) {
      return null;
    }

    return {
      currency,
      originalAmount: roundCurrency(amount),
      currentAmount: roundCurrency(amount)
    };
  } catch {
    return null;
  }
}

function walkJson(value, visitor) {
  visitor(value);

  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, visitor);
    }
    return;
  }

  for (const nested of Object.values(value)) {
    walkJson(nested, visitor);
  }
}

function extractEnvScriptPayloads(html) {
  const scriptPattern =
    /<script[^>]*id="env:[^"]+"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  const payloads = [];

  for (const match of html.matchAll(scriptPattern)) {
    try {
      payloads.push(JSON.parse(match[1]));
    } catch {
      continue;
    }
  }

  return payloads;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function resolveAmountFromRawValue(rawValue, formattedAmount) {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if (Number.isFinite(formattedAmount)) {
    const asMajorUnits = numericValue;
    const asMinorUnits = numericValue / 100;

    const directDelta = Math.abs(asMajorUnits - formattedAmount);
    const minorDelta = Math.abs(asMinorUnits - formattedAmount);

    return directDelta <= minorDelta ? asMajorUnits : asMinorUnits;
  }

  return numericValue / 100;
}

function parseAmountFromFormatted(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s/g, "");
  const matches = normalized.match(/(\d[\d.,]*)/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const numericChunk = matches[matches.length - 1];
  const lastComma = numericChunk.lastIndexOf(",");
  const lastDot = numericChunk.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);

  if (decimalIndex === -1) {
    const integerValue = Number(numericChunk.replace(/[^\d]/g, ""));
    return Number.isFinite(integerValue) ? integerValue : null;
  }

  const decimalPartRaw = numericChunk.slice(decimalIndex + 1).replace(/[^\d]/g, "");
  const integerPartRaw = numericChunk.slice(0, decimalIndex).replace(/[^\d]/g, "");

  if (
    decimalPartRaw.length === 3 &&
    integerPartRaw.length >= 1 &&
    numericChunk.indexOf(",") === numericChunk.lastIndexOf(",") &&
    numericChunk.indexOf(".") === numericChunk.lastIndexOf(".")
  ) {
    const groupedInteger = Number((integerPartRaw + decimalPartRaw).replace(/[^\d]/g, ""));
    return Number.isFinite(groupedInteger) ? groupedInteger : null;
  }

  const normalizedNumber = `${integerPartRaw || "0"}.${decimalPartRaw}`;
  const parsed = Number(normalizedNumber);

  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeIncluded(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "included" || normalized === "free";
}

function normalizeSelectedStoreIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((item) => String(item).toLowerCase())
    .filter((item) => Object.hasOwn(STORE_BY_ID, item));

  return [...new Set(normalized)];
}

function normalizeManualRates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((rates, [storeId, rate]) => {
    const normalizedStoreId = String(storeId).toLowerCase();
    const normalizedRate = normalizeManualRateValue(rate);
    const roundedRate = roundRate(normalizedRate);

    if (
      Object.hasOwn(STORE_BY_ID, normalizedStoreId) &&
      Number.isFinite(roundedRate) &&
      roundedRate > 0
    ) {
      rates[normalizedStoreId] = roundedRate;
    }

    return rates;
  }, {});
}

function normalizeManualRateValue(value) {
  const normalized = String(value).replace(/\s+/g, "").replace(",", ".");
  return Number(normalized);
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function roundRate(value) {
  return Number(Number(value).toFixed(4));
}

function formatCurrency(amount, currency, locale) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(roundCurrency(amount));
}
