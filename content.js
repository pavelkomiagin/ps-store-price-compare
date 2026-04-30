const PANEL_CLASS = "pspc-panel";
const PRODUCT_ID_FLAG = "data-pspc-product-id";
const HOST_CLASS = "pspc-host";
const PRODUCT_PAGE_HOST_ID = "pspc-product-page-host";
const PANEL_LOAD_ROOT_MARGIN = "900px 0px";
const STORE_LOCALE_BY_ID = {
  tr: "en-tr",
  in: "en-in",
  pl: "pl-pl"
};

const observer = new MutationObserver(() => {
  scheduleScan();
});
const panelLoadObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(handlePanelVisibility, {
        rootMargin: PANEL_LOAD_ROOT_MARGIN
      })
    : null;

let scanScheduled = false;
let extensionContextInvalidated = false;
let giftCardOffersPreloaded = false;

bootstrap();

function bootstrap() {
  if (extensionContextInvalidated) {
    return;
  }

  preloadGiftCardOffersForPage();
  scanPage();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    if (!changes.selectedStoreIds) {
      return;
    }

    giftCardOffersPreloaded = false;
    preloadGiftCardOffersForPage();
    refreshPanels();
  });
}

function scheduleScan() {
  if (scanScheduled || extensionContextInvalidated) {
    return;
  }

  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanPage();
  });
}

function scanPage() {
  if (extensionContextInvalidated) {
    return;
  }

  scanProductPage();
  scanProductTiles();
}

function scanProductTiles() {
  const anchors = document.querySelectorAll('a[href*="/product/"], a[href*="/concept/"]');

  for (const anchor of anchors) {
    if (anchor.closest(`.${PANEL_CLASS}`)) {
      continue;
    }

    const productUrl = anchor.href;
    const storeItem = extractStoreItem(productUrl);

    if (!productUrl || !storeItem) {
      continue;
    }

    const card = findCardContainer(anchor);
    if (!card) {
      continue;
    }

    const existingPanel = card.querySelector(`:scope > .${PANEL_CLASS}`);
    if (existingPanel && card.getAttribute(PRODUCT_ID_FLAG) === storeItem.key) {
      continue;
    }

    if (existingPanel) {
      existingPanel.remove();
    }

    card.setAttribute(PRODUCT_ID_FLAG, storeItem.key);
    mountPanel(card, productUrl, storeItem.key, getStoreItemHints(storeItem));
  }
}

function scanProductPage() {
  const storeItem = extractStoreItem(window.location.href);
  if (!storeItem) {
    return;
  }

  const main = document.querySelector("main");
  if (!main) {
    return;
  }

  const mountTarget = findProductPageMountTarget(main);
  if (!mountTarget) {
    return;
  }

  const existingHost = document.getElementById(PRODUCT_PAGE_HOST_ID);
  if (existingHost?.getAttribute(PRODUCT_ID_FLAG) === storeItem.key && existingHost.isConnected) {
    return;
  }

  existingHost?.remove();

  const host = document.createElement("div");
  host.id = PRODUCT_PAGE_HOST_ID;
  host.className = `${HOST_CLASS} pspc-product-page-host`;
  host.setAttribute(PRODUCT_ID_FLAG, storeItem.key);
  mountTarget.insertAdjacentElement("afterend", host);
  mountPanel(host, window.location.href, storeItem.key, getStoreItemHints(storeItem));
}

function findProductPageMountTarget(main) {
  const selectors = [
    '[data-qa*="mfe-game-title#name"]',
    '[data-qa*="mfe-game-title"]',
    '[data-qa*="game-title"]',
    "h1"
  ];

  for (const selector of selectors) {
    const element = main.querySelector(selector);
    if (!element) {
      continue;
    }

    return (
      element.closest("section") ||
      element.closest("article") ||
      element.closest("div") ||
      element
    );
  }

  return main.querySelector("section") || main.firstElementChild;
}

function findCardContainer(anchor) {
  const tile =
    anchor.closest('[data-qa*="product-tile"]') ||
    anchor.closest('[data-qa*="search#productTile"]');
  const listItem = tile?.closest("li") || anchor.closest("li");

  return (
    listItem ||
    tile ||
    anchor.closest("article") ||
    anchor.closest("section") ||
    anchor.parentElement
  );
}

function mountPanel(card, productUrl, productId, hints = null) {
  card.classList.add(HOST_CLASS);
  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;
  panel.dataset.productId = productId;
  panel.dataset.productUrl = productUrl;
  if (hints) {
    panel.dataset.productHints = JSON.stringify(hints);
  }
  panel.innerHTML = `
    <div class="pspc-header">Сравнение магазинов</div>
    <div class="pspc-status">Загружаю цены и скидки...</div>
  `;

  card.appendChild(panel);
  requestPanelLoad(panel, productUrl, hints);
}

function requestPanelLoad(panel, productUrl, hints = readPanelHints(panel)) {
  panel.dataset.productUrl = productUrl;
  if (hints) {
    panel.dataset.productHints = JSON.stringify(hints);
  }

  if (!panelLoadObserver) {
    void loadPanelData(panel, productUrl, hints);
    return;
  }

  delete panel.dataset.pspcLoaded;
  panelLoadObserver.observe(panel);
}

function handlePanelVisibility(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const panel = entry.target;
    panelLoadObserver.unobserve(panel);

    if (panel.dataset.pspcLoaded === "true") {
      continue;
    }

    panel.dataset.pspcLoaded = "true";
    void loadPanelData(panel, panel.dataset.productUrl, readPanelHints(panel));
  }
}

async function loadPanelData(panel, productUrl, hints = readPanelHints(panel)) {
  try {
    if (extensionContextInvalidated) {
      renderExtensionReloadRequired(panel);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "GET_PRICE_COMPARISON",
      productUrl,
      productIdHints: hints?.productIdHints,
      conceptPriceHint: hints?.conceptPriceHint
    });

    if (!response?.ok) {
      renderLoadError(panel, response?.error || "Failed to load price comparison");
      return;
    }

    renderPanel(panel, response.result);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      handleInvalidatedContext(panel);
      return;
    }

    renderLoadError(panel, error);
  }
}

function getStoreItemHints(storeItem) {
  if (storeItem?.type !== "concept") {
    return null;
  }

  const nextData = parseNextDataFromDocument();
  const apolloState = nextData?.props?.apolloState;
  if (!apolloState || typeof apolloState !== "object") {
    return null;
  }

  const concept = Object.entries(apolloState).find(
    ([key, value]) => key.startsWith(`Concept:${storeItem.id}:`) && value && typeof value === "object"
  )?.[1];

  if (!concept) {
    return null;
  }

  const productIdHints = Array.isArray(concept.products)
    ? concept.products
        .map((productRef) => {
          const ref = productRef?.__ref;
          if (typeof ref !== "string") {
            return null;
          }

          const product = apolloState[ref];
          if (typeof product?.id === "string" && product.id) {
            return product.id;
          }

          return ref.match(/^Product:([^:]+):/)?.[1] || null;
        })
        .filter(Boolean)
    : [];

  const conceptPriceHint =
    typeof concept.price?.discountedPrice === "string"
      ? concept.price.discountedPrice
      : concept.price?.basePrice;

  if (productIdHints.length === 0 && !conceptPriceHint) {
    return null;
  }

  return {
    productIdHints: [...new Set(productIdHints)],
    conceptPriceHint
  };
}

function parseNextDataFromDocument() {
  const script = document.getElementById("__NEXT_DATA__");
  if (!script?.textContent) {
    return null;
  }

  try {
    return JSON.parse(script.textContent);
  } catch {
    return null;
  }
}

function readPanelHints(panel) {
  if (!panel.dataset.productHints) {
    return null;
  }

  try {
    return JSON.parse(panel.dataset.productHints);
  } catch {
    return null;
  }
}

function preloadGiftCardOffersForPage() {
  if (extensionContextInvalidated || giftCardOffersPreloaded) {
    return;
  }

  giftCardOffersPreloaded = true;
  void chrome.runtime
    .sendMessage({
      type: "PRELOAD_GIFT_CARD_OFFERS"
    })
    .catch((error) => {
      giftCardOffersPreloaded = false;

      if (isExtensionContextInvalidated(error)) {
        extensionContextInvalidated = true;
        observer.disconnect();
        panelLoadObserver?.disconnect();
        return;
      }
    });
}

function renderPanel(panel, data) {
  const rows = data.rows.map((row) => renderRow(row, data.productId)).join("");
  const cheapest = data.rows.find((row) => row.cheapest && row.available);
  const verdict = cheapest
    ? `Выгоднее: ${escapeHtml(cheapest.label)}`
    : "Выгоднее: недостаточно данных";

  panel.innerHTML = `
    <div class="pspc-header">Сравнение магазинов</div>
    <div class="pspc-list">
      ${rows}
    </div>
    <div class="pspc-footer">${verdict}</div>
  `;
}

function renderRow(row, productId) {
  const rowClass = row.cheapest ? "pspc-store-card pspc-store-card-cheapest" : "pspc-store-card";
  const storeLink = buildStoreLink(row, productId);
  const storeAction = storeLink
    ? `
      <a
        class="pspc-store-link"
        href="${escapeHtml(storeLink)}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Открыть игру в магазине ${escapeHtml(row.label)}"
        title="Открыть игру в магазине ${escapeHtml(row.label)}"
      >
        <span aria-hidden="true">↗</span>
      </a>
    `
    : "";

  if (!row.available) {
    return `
      <div class="${rowClass}">
        <div class="pspc-store-top">
          <div class="pspc-store-meta">
            <span class="pspc-store-name">${escapeHtml(row.label)}</span>
            ${storeAction}
          </div>
          <div class="pspc-store-top-actions">
            <span class="pspc-pill pspc-pill-muted">нет цены</span>
          </div>
        </div>
        <div class="pspc-line-value pspc-line-value-only">Недоступно</div>
        <div class="pspc-line-value pspc-line-value-only">-</div>
      </div>
    `;
  }

  const stateBadge = row.hasDiscount
    ? '<span class="pspc-pill">скидка</span>'
    : '<span class="pspc-pill pspc-pill-muted">без скидки</span>';

  const bestBadge = row.cheapest ? '<span class="pspc-best">выгоднее</span>' : "";

  const localPrice = row.hasDiscount
    ? `
      <span class="pspc-price-pair">
        <span class="pspc-price-old">${escapeHtml(row.originalText)}</span>
        <span class="pspc-price-now">${escapeHtml(row.currentText)}</span>
      </span>
    `
    : `
      <span class="pspc-price-pair">
        <span class="pspc-price-now">${escapeHtml(row.currentText)}</span>
      </span>
    `;

  const rubPrice = row.hasDiscount
    ? `
      <span class="pspc-price-pair">
        <span class="pspc-price-old">${escapeHtml(row.originalRubText)}</span>
        <span class="pspc-price-now">${escapeHtml(row.currentRubText)}</span>
      </span>
    `
    : `
      <span class="pspc-price-pair">
        <span class="pspc-price-now">${escapeHtml(row.currentRubText)}</span>
      </span>
    `;

  const rubTooltip = renderRubTooltip(row);

  return `
    <div class="${rowClass}">
      <div class="pspc-store-top">
        <div class="pspc-store-meta">
          <span class="pspc-store-name">${escapeHtml(row.label)}</span>
          ${storeAction}
          ${stateBadge}
        </div>
        <div class="pspc-store-top-actions">
          ${bestBadge}
        </div>
      </div>
      <div class="pspc-line-value pspc-line-value-only">${localPrice}</div>
      <div class="pspc-line-value pspc-line-value-only">
        ${rubPrice}
        ${rubTooltip}
      </div>
    </div>
  `;
}

function buildStoreLink(row, productId) {
  if (!productId) {
    return null;
  }

  const locale = row.locale || STORE_LOCALE_BY_ID[row.storeId];
  if (!locale) {
    return null;
  }

  return `https://store.playstation.com/${locale}/product/${productId}`;
}

function renderRubTooltip(row) {
  const blocks = [];

  if (row.hasDiscount && row.originalRubQuote) {
    blocks.push(renderRubTooltipBlock("Полная цена", row.originalRubQuote));
  }

  if (row.currentRubQuote) {
    blocks.push(
      renderRubTooltipBlock(row.hasDiscount ? "Текущая цена" : "Цена", row.currentRubQuote)
    );
  }

  if (blocks.length === 0) {
    return "";
  }

  return `
    <span class="pspc-tooltip-wrap">
      <button class="pspc-help" type="button" aria-label="Как считается рублевая цена">?</button>
      <span class="pspc-tooltip">${blocks.join("")}</span>
    </span>
  `;
}

function renderRubTooltipBlock(title, quote) {
  const cards = quote.cards
    .map(
      (card) =>
        `<li>${escapeHtml(`${card.count}x ${card.valueString}`)} = ${escapeHtml(card.rubText)}</li>`
    )
    .join("");

  const targetAmount = formatTooltipCurrency(quote.targetAmount, quote.currency, quote.currencyLocale);
  const coveredAmount = formatTooltipCurrency(
    quote.coveredAmount,
    quote.currency,
    quote.currencyLocale
  );
  const leftoverAmount = formatTooltipCurrency(
    quote.leftoverAmount,
    quote.currency,
    quote.currencyLocale
  );

  return `
    <span class="pspc-tooltip-block">
      <span class="pspc-tooltip-title">${escapeHtml(title)}</span>
      <span>Нужно: ${escapeHtml(targetAmount)}</span>
      <span>Карты: ${escapeHtml(quote.combinationLabel)}</span>
      <span>Номинал: ${escapeHtml(coveredAmount)} за ${escapeHtml(quote.rubText)}</span>
      <span>Остаток: ${escapeHtml(leftoverAmount)}</span>
      <span>Курс корзины: ${escapeHtml(formatRate(quote.effectiveBasketRate, quote.currency))}</span>
      <span>Курс покупки: ${escapeHtml(formatRate(quote.effectiveGameRate, quote.currency))}</span>
      <ul class="pspc-tooltip-list">${cards}</ul>
    </span>
  `;
}

function extractStoreItem(productUrl) {
  try {
    const url = new URL(productUrl, window.location.origin);
    const match = url.pathname.match(/\/(product|concept)\/([^/?#]+)/i);
    if (!match) {
      return null;
    }

    return {
      type: match[1].toLowerCase(),
      id: match[2],
      key: `${match[1].toLowerCase()}:${match[2]}`
    };
  } catch {
    return null;
  }
}

function refreshPanels() {
  if (extensionContextInvalidated) {
    return;
  }

  const panels = document.querySelectorAll(`.${PANEL_CLASS}`);

  for (const panel of panels) {
    const productUrl = panel.dataset.productUrl;
    if (!productUrl) {
      continue;
    }

    panel.innerHTML = `
      <div class="pspc-header">Сравнение магазинов</div>
      <div class="pspc-status">Обновляю курсы...</div>
    `;
    requestPanelLoad(panel, productUrl);
  }
}

function handleInvalidatedContext(panel) {
  extensionContextInvalidated = true;
  observer.disconnect();
  panelLoadObserver?.disconnect();
  renderExtensionReloadRequired(panel);

  for (const stalePanel of document.querySelectorAll(`.${PANEL_CLASS}`)) {
    if (stalePanel !== panel) {
      renderExtensionReloadRequired(stalePanel);
    }
  }
}

function renderLoadError(panel, error) {
  const message = normalizeLoadErrorMessage(error);
  const details = message ? `<div class="pspc-status-detail">${escapeHtml(message)}</div>` : "";

  panel.innerHTML = `
    <div class="pspc-header">Сравнение магазинов</div>
    <div class="pspc-status">Не удалось загрузить цены</div>
    ${details}
  `;
}

function normalizeLoadErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();

  if (
    normalized.includes("message channel closed") ||
    normalized.includes("receiving end does not exist") ||
    normalized.includes("could not establish connection")
  ) {
    return "Фоновый процесс расширения перезапустился. Обновите страницу, если цены не появились.";
  }

  if (normalized.includes("could not resolve playstation store product")) {
    return "Не удалось сопоставить карточку с конкретной страницей игры в PS Store.";
  }

  return message;
}

function renderExtensionReloadRequired(panel) {
  panel.innerHTML = `
    <div class="pspc-header">Сравнение магазинов</div>
    <div class="pspc-status">Расширение обновилось, обновите страницу</div>
  `;
}

function isExtensionContextInvalidated(error) {
  const message = String(error?.message || error || "");
  return message.toLowerCase().includes("extension context invalidated");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTooltipCurrency(amount, currency, locale) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(Number(amount));
}

function formatRate(amount, currency) {
  return `${Number(amount).toFixed(2)} ₽/${currency}`;
}
