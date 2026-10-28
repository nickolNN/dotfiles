#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$PWD}"
REPO="$(cd "$REPO" && pwd)"

if [ ! -f "$REPO/package.json" ]; then
  echo "✗ $REPO — не похоже на репозиторий (нет package.json)" >&2
  exit 2
fi

probe() {
  ( cd "$REPO" && node -e '
    const { createRequire } = require("module");
    const req = createRequire(process.cwd() + "/");
    let pw;
    try { pw = req("playwright"); } catch { pw = req("@playwright/test"); }
    pw.chromium.launch()
      .then(async (b) => { await b.close(); })
      .catch((e) => {
        console.error(String(e.message || e).split("\n")[0]);
        process.exit(1);
      });
  ' )
}

version() {
  ( cd "$REPO" && node -e '
    const { createRequire } = require("module");
    const req = createRequire(process.cwd() + "/");
    for (const p of ["playwright", "@playwright/test"]) {
      try { console.log(req(p + "/package.json").version); process.exit(0); } catch {}
    }
    console.log("?");
  ' )
}

PW_VERSION="$(version)"
if [ "$PW_VERSION" = "?" ]; then
  echo "✗ в $REPO нет playwright / @playwright/test — нечего проверять" >&2
  exit 2
fi

if probe >/dev/null 2>&1; then
  echo "✅ playwright $PW_VERSION — браузер запускается, ничего не менял."
  exit 0
fi

echo "  → playwright $PW_VERSION: браузера нет в $PLAYWRIGHT_BROWSERS_PATH, ставлю…"
if ! ( cd "$REPO" && npx --no-install playwright install chromium ); then
  echo "  ⚠ 'playwright install chromium' не сработал, пробую полную установку…" >&2
  ( cd "$REPO" && npx --no-install playwright install ) || true
fi

if probe; then
  echo "✅ playwright $PW_VERSION — браузер доставлен, запуск проходит."
  exit 0
fi

echo "✗ playwright $PW_VERSION — браузер так и не запустился (см. ошибку выше)." >&2
exit 1