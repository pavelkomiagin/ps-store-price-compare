# Privacy Policy

PS Store Выгодомер is a local Chrome extension. It does not use a separate server and does not send user data to the developer.

## What the extension stores

- Selected comparison countries are stored in `chrome.storage.sync`.
- Cached PS Store prices and gift card offers are stored in `chrome.storage.local`.
- Cache entries are used to reduce repeated requests and are refreshed automatically after about 1 hour.

## What the extension requests

The extension sends requests directly from the user's browser to:

- `https://store.playstation.com/*` to read public PS Store product and concept pages.
- `https://gw.cg.yandex.ru/*` to read public gift card offer data used for ruble price estimates.

The extension uses `credentials: "omit"` for these requests and does not intentionally send cookies, account data, payment data, passwords, tokens, or other credentials.

## What the developer receives

The developer does not receive browsing history, page contents, cache contents, settings, prices, identifiers, or any other data from the extension.

## Data sharing and sale

The extension does not sell, rent, transfer, or share user data with third parties.

## Clearing data

Users can clear the cached price and gift card data from the extension popup. Users can also remove all extension data by uninstalling the extension or clearing extension storage in Chrome.

## Unofficial status

This project is unofficial and is not affiliated with, endorsed by, approved by, or supported by Sony Interactive Entertainment.
