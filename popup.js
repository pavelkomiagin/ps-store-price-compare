const DEFAULT_SETTINGS = {
  selectedStoreIds: ["tr", "in", "pl"]
};

const form = document.getElementById("settings-form");
const storeCheckboxes = [...document.querySelectorAll('input[name="selectedStoreIds"]')];
const resetButton = document.getElementById("reset-defaults");
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
}

async function handleSubmit(event) {
  event.preventDefault();

  const selectedStoreIds = getSelectedStoreIds();
  if (selectedStoreIds.length === 0) {
    setStatus("Выберите хотя бы одну страну для сравнения.", true);
    return;
  }

  await chrome.storage.sync.set({ selectedStoreIds });
  applyValues({ selectedStoreIds });
  await refreshCacheStatus();
  setStatus("Настройки сохранены. Цены по картам считаются автоматически.");
}

async function handleReset() {
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  applyValues(DEFAULT_SETTINGS);
  await refreshCacheStatus();
  setStatus("Список стран возвращен к значениям по умолчанию.");
}

function applyValues(values) {
  const selectedStoreIds = normalizeSelectedStoreIds(values.selectedStoreIds);

  for (const checkbox of storeCheckboxes) {
    checkbox.checked = selectedStoreIds.includes(checkbox.value);
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
