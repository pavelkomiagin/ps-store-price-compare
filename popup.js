const DEFAULT_SETTINGS = {
  selectedStoreIds: ["tr", "in", "pl"],
  manualRates: {}
};

const form = document.getElementById("settings-form");
const storeCheckboxes = [...document.querySelectorAll('input[name="selectedStoreIds"]')];
const manualRateInputs = [...document.querySelectorAll('input[name="manualRates"]')];
const resetButton = document.getElementById("reset-defaults");
const clearCacheButton = document.getElementById("clear-cache");
const statusNode = document.getElementById("status");
const comparisonCacheTimeNode = document.getElementById("comparison-cache-time");
const offersCacheTimeNode = document.getElementById("offers-cache-time");

void initialize();

async function initialize() {
  const storedSettings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  applyValues(storedSettings);
  await refreshCacheStatus();

  form.addEventListener("submit", handleSubmit);
  resetButton.addEventListener("click", handleReset);
  clearCacheButton.addEventListener("click", handleClearCache);
}

async function handleSubmit(event) {
  event.preventDefault();

  const selectedStoreIds = getSelectedStoreIds();
  const manualRatesResult = getManualRates();

  if (selectedStoreIds.length === 0) {
    setStatus("Выберите хотя бы одну страну для сравнения.", true);
    return;
  }

  if (!manualRatesResult.ok) {
    setStatus(manualRatesResult.error, true);
    return;
  }

  const settings = {
    selectedStoreIds,
    manualRates: manualRatesResult.value
  };

  await chrome.storage.sync.set(settings);
  applyValues(settings);
  await refreshCacheStatus();
  setStatus("Настройки сохранены.");
}

async function handleReset() {
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  applyValues(DEFAULT_SETTINGS);
  await refreshCacheStatus();
  setStatus("Страны возвращены к значениям по умолчанию, ручной курс очищен.");
}

async function handleClearCache() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CLEAR_CACHE"
    });

    if (!response?.ok) {
      setStatus("Не удалось очистить кеш.", true);
      return;
    }

    await refreshCacheStatus();
    setStatus("Кеш цен и карт очищен.");
  } catch {
    setStatus("Не удалось очистить кеш.", true);
  }
}

function applyValues(values) {
  const selectedStoreIds = normalizeSelectedStoreIds(values.selectedStoreIds);
  const manualRates = normalizeManualRates(values.manualRates);

  for (const checkbox of storeCheckboxes) {
    checkbox.checked = selectedStoreIds.includes(checkbox.value);
  }

  for (const input of manualRateInputs) {
    input.value = formatManualRateInput(manualRates[input.dataset.storeId]);
  }
}

function getSelectedStoreIds() {
  return normalizeSelectedStoreIds(
    storeCheckboxes.filter((input) => input.checked).map((input) => input.value)
  );
}

function normalizeSelectedStoreIds(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_SETTINGS.selectedStoreIds;
  }

  const normalized = value
    .map((item) => String(item).toLowerCase())
    .filter((item) => ["tr", "in", "pl"].includes(item));

  return normalized.length > 0 ? [...new Set(normalized)] : DEFAULT_SETTINGS.selectedStoreIds;
}

function getManualRates() {
  const manualRates = {};

  for (const input of manualRateInputs) {
    const rawValue = input.value.trim();
    if (!rawValue) {
      continue;
    }

    const rate = parseManualRate(rawValue);
    if (!rate) {
      return {
        ok: false,
        error: "Введите ручной курс положительным числом или оставьте поле пустым."
      };
    }

    manualRates[input.dataset.storeId] = rate;
  }

  return {
    ok: true,
    value: manualRates
  };
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
      ["tr", "in", "pl"].includes(normalizedStoreId) &&
      Number.isFinite(roundedRate) &&
      roundedRate > 0
    ) {
      rates[normalizedStoreId] = roundedRate;
    }

    return rates;
  }, {});
}

function parseManualRate(value) {
  const parsed = normalizeManualRateValue(value);
  const rounded = roundRate(parsed);

  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

function normalizeManualRateValue(value) {
  const normalized = String(value).replace(/\s+/g, "").replace(",", ".");
  return Number(normalized);
}

function roundRate(value) {
  return Number(Number(value).toFixed(4));
}

function formatManualRateInput(value) {
  return Number.isFinite(value) && value > 0 ? String(value).replace(".", ",") : "";
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#ff9d9d" : "#9de7aa";
}

async function refreshCacheStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_CACHE_STATUS"
    });

    if (!response?.ok) {
      renderCacheStatus(null);
      return;
    }

    renderCacheStatus(response.result);
  } catch {
    renderCacheStatus(null);
  }
}

function renderCacheStatus(status) {
  comparisonCacheTimeNode.textContent = formatCacheTime(status?.comparisonsUpdatedAt);
  offersCacheTimeNode.textContent = formatCacheTime(status?.giftCardOffersUpdatedAt);
}

function formatCacheTime(value) {
  if (!value) {
    return "еще не загружались";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "еще не загружались";
  }

  const formatted = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);

  return `актуально на ${formatted}`;
}
