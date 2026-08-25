# AI Memory & Changelog
*Бесконечная память проекта — здесь я фиксирую все изменения, идеи и исправленные баги, чтобы ничего не забыть. Этот файл — памятка для ИИ, чтобы при следующей сессии не сломать логику. Читай его ПЕРВЫМ перед любыми правками.*

## Текущий фокус проекта
- **Стиль:** Минимализм, Richard Sancho Aesthetic, Dark Mode, High-end UI. Не добавлять неоновые градиенты/карточки-в-карточках.
- **Главный экран (Stage1Hero):** Максимально чистый интерфейс, интерактивный фон `Balatro` (ogl WebGL, `React.memo`, `dpr≤2`).
- **Брендинг:** Проект официально переименован в **Syntax3**. Логотип `>:#3`.
- **Стек:** Vite 6 + React 18 + Express + Discord.js v14 (`server/discordBot.ts`) + Roblox API proxy (`server/robloxService.ts`), Vercel deploy (`api/index.ts`), LRUCache + ETag + SSE Streaming Valuation.
- **Статус Live-теста (2026-08-24 17:24 UTC):** ✅ Подтверждено: вещь `Birds` группы `#1087404693` снята с продажи (`была 5 R$`) → бот прислал `⛔ Birds — снята с продажи` в DM `1249714387426476094`. Осталось проверить `BACK_ON_SALE` и `NEW ITEM` — код уже готов, ждет следующего дропа/ре-листа.
- **Режим работы:** Локально `http://localhost:5173` + `http://localhost:3001` (сервер + бот), `CHECK_INTERVAL_MS=60000` для теста (прод `7*60*1000`). Бот стартует только `!process.env.VERCEL && DISCORD_BOT_TOKEN`.

## Инварианты для ИИ — НЕ ЛОМАТЬ (зачем так)
1. **`trust proxy` + `getClientIp()=req.ip`** `server/index.ts:26` — защита от spoof `X-Forwarded-For` и обхода rate-limit. Не возвращать `req.headers['x-forwarded-for']`.
2. **CORS allowlist `ALLOWED_ORIGINS` deny-by-default в проде** `server/index.ts:38` — в проде без `ALLOWED_ORIGINS` кросс-домен блокируется. Не делать `allow *`.
3. **`AbortController` в `App.tsx` + `signal` во всех методах `robloxService.ts`** — отмена каскада Roblox запросов при быстром втором поиске / `req.close`. Не убирать `signal` из `axios`.
4. **`p-limit(5)` для Economy API + чанки по 5** `robloxService.ts:583` и `discordBot.ts:20` — без этого мгновенный `429 Too Many Requests` и бан IP. Не делать `Promise.all(120)`.
5. **Единый `lib/fallbacks.ts` + `ARCHIVED_PREFIX='__ARCHIVED__:'` `robloxService.ts:55`** — не использовать магию `[Archived` (имя вещи может так начинаться).
6. **`server/data/folderSync.json` + `folderStore.ts` структура** — `links/reverseLinks/tracked/subscriptions/groupRoblox`. Не менять ключи, не писать туда вебхуки, фильтр `/^\d{17,20}$/` обязателен.
7. **`!process.env.VERCEL` для бота** `server/index.ts:429` — в Vercel serverless бот не стартует, только API. Не запускать бота в serverless.
8. **DOM: `button` внутри `button` запрещено** `src/components/CopiedGroupsFolder.tsx:86` — внешний контейнер теперь `div role="button"` (было `<button>` с вложенными `<button>Change</button>` → React `validateDOMNesting` ворнинг). Не возвращать `<button>` как обертку для тултипов/кнопок.
9. **Паскаль vs camel в Economy API** `robloxService.ts:589` — `getEconomyAssetDetails` возвращает нормализованные `price/isForSale` (но raw API отдает `PriceInRobux/IsForSale`). Читать `price/isForSale` с fallback на `PriceInRobux/IsForSale`, иначе снова `price=null` и бот слепнет.
10. **`folderStore.flush()` + `SIGINT/SIGTERM` + `setItemStates` после каждого тика** `folderStore.ts:61` `discordBot.ts:88` — без немедленного flush рестарт теряет `itemStates` и спамит повторно. Не оставлять только дебаунс `300ms`.

## Руководство для следующего ИИ — как думать и куда улучшать
**Почему такие решения:**
- Двухэтапный `getAllGroupItems`: сначала `catalog.roblox.com/v1/search/items` (каталог, дешевый), потом `economy.roblox.com/v2/assets/details` чанками по 5. Прямой опрос `search/items/details` на 2000 вещей = мгновенный бан.
- Двойная проверка `isForSale` через свежий `bypassCache:true` перед DM — защита от ложного `OFF_SALE` при `429/timeout`. При `null`/`429` — тихо ждем следующий тик, не спамим.
- Тихая миграция `heal silent` `discordBot.ts:62` — первый тик после фикса `price:null/isForSale:null` не шлет 120 уведомлений, а чинит базу. Без этого — спам на всю папку.
- `isBackfill` `prevCount < length-30` — защита при расширении лимита `10→120`. Без этого старые вещи прилетают как `NEW`.
- `div role="button"` вместо `<button>` — единственный способ иметь тултипы/кнопки внутри кликабельного хедера без нарушения HTML-спеки.
- `7 минут` баланс: чаще = 429, реже = юзер не успеет перекупить. Для теста можно `CHECK_INTERVAL_MS=60000`, но на 4+ группах уже `429`, см. лог `12:19:28 429`.
- **VPN FAST** `robloxService.ts:68` — `HEDGED 400ms vs 1200ms`, `SPECULATIVE 380ms vs 900ms`, `ECONOMY_TIMEOUT 9500ms`, `ETag off` — без этого на VPN `VALUING 11/21 (7 priced)` застревает, с ним `21/21` за 2-3с. Зачем: VPN добавляет 400-800ms хвост, hedged спасает.
- **HttpOnly cookie vs URL token** `server/index.ts:341` — `signUserId` теперь `timingSafeEqual` + `HttpOnly SameSite Lax Secure` `wornby_auth`; в URL токен светился в `history/referer/log` и `localStorage` доступен XSS. Зачем: `localStorage` XSS крадет навсегда, `HttpOnly` нет.

**Как не сломать при следующих правках:**
- Перед коммитом: `npx tsc --noEmit` + `npm run build` должны быть 0 ошибок (проверено 834kb).
- Меняешь `discordBot.ts` → проверь 4 перехода unit-тестом: `true→false=OFF_SALE`, `false→true=BACK_ON_SALE`, `100→150=PRICE_CHANGE`, `null→true=HEAL_SILENT` (см. `discordBot.ts` тест в истории).
- Меняешь `CopiedGroupsFolder.tsx` → открой `http://localhost:5173`, консоль не должна иметь `validateDOMNesting`, `localStorage wornby_discord_token` должен быть пуст после миграции в куку.
- Добавляешь новую группу → проверь `POST /api/folder/sync` с `credentials:include` (кука) + `folderStore.track` прогревает 120 вещей в фоне, а не только `lastItemId`.
- Меняешь `CORS` → `credentials:true` обязателен для куки; `origin` должен быть точный, не `*`.

**Куда улучшать дальше:**
- Экспоненциальный backoff при `429` вместо фиксированных `1200ms` между батчами.
- `GET /api/debug/check?groupId=...` для ручного форса тика без ожидания интервала.
- Кэшировать `groupInfo` на 60с чтобы не дергать `groups.roblox.com` каждый тик.
- Сжать `vite` чанк `834kb` via `manualChunks` (сейчас ворнинг `>500kb`).
- Ротация утекших секретов: `DISCORD_BOT_TOKEN/CLIENT_SECRET` были в `.env.example` — уже заменены на `PUT_YOUR_*`, но реальный токен `MTU0MTM0...WeupnQ` надо пересоздать в Discord Developer Portal и `SESSION_SECRET` сменить на `crypto.randomBytes(32).toString('hex')`.

## История изменений

### [2026-08-25 — Критический аудит: лазейки и утечка токена в URL]
- **Утечка `discord_token` в URL (критично, зачем фиксили):** `server/index.ts:379` делал `redirect ${frontend}/?discord_token=${signUserId(id)}` → токен попадал в `browser history, referer, server log [HTTP] sanitizeLog(originalUrl), screen share, localStorage wornby_discord_token` (XSS крадет навсегда). Хотя токен — `HMAC(userId)` не `OAuth access_token`, его утечка = вечная имперсонализация: атакующий вызывает `POST /folder/sync {discordToken}` от твоего имени. **Как фиксили:**
  - `server/index.ts:10-35` `verifyUserId` теперь `timingSafeEqual` (защита от side-channel) + `SESSION_SECRET` варнинг если ephemeral.
  - `server/index.ts:18-35` новый `getAuthTokenFromRequest` — читает `HttpOnly cookie wornby_auth` (приоритет) → `Bearer` → legacy query.
  - `server/index.ts:341-383` callback ставит `Set-Cookie: wornby_auth=...; HttpOnly; SameSite=Lax; Secure; Max-Age=30d; Path=/` и чистит `oauth_csrf`, редирект `?linked=1&roblox=` **БЕЗ токена** в URL. Добавлен `POST /auth/discord/logout`.
  - `server/index.ts:38` `CORS credentials:true` — кука улетает с `fetch credentials:include` (раньше `false` — кука не шла).
  - `server/index.ts:290-322` `POST /folder/sync|unsync` принимают и cookie и legacy body, + CSRF защита `isAllowedOrigin` — если кука и `Origin` не в `ALLOWED_ORIGINS` → `403 CSRF`.
  - `src/components/CopiedGroupsFolder.tsx:32-72` теперь `useEffect fetch /api/auth/discord/me {credentials:include}` вместо `URLSearchParams discord_token`, чистит `?discord_token`/`?linked` из history, стирает `localStorage wornby_discord_token` после успешной куки (миграция), тултип больше не показывает `slice(0,6)` токена.
  - `src/hooks/useCopiedGroupsFolder.ts:54-127` все `fetch /folder/*` теперь `credentials:include` и не кладут `discordToken` в body (утечка в логах), legacy токен шлется только fallback.
  - **Верификация:** `curl -i /api/auth/discord/me` → `200` с `Access-Control-Allow-Credentials:true`, `curl health` OK, `tsc 0`, `vite build 834kb`, `Set-Cookie HttpOnly` виден в `cmd` логе, `localStorage` пуст, URL после OAuth `?linked=1`.
- **Утечка секретов в репо (критично):** `.env.example:6-8` содержал реальные `DISCORD_BOT_TOKEN=MTU0MTM0...`, `CLIENT_ID`, `CLIENT_SECRET` — `git history` уже утек. **Фикс:** заменены на `PUT_YOUR_*` + коммент `СРОЧНО пересоздай в Discord Developer Portal` + `SESSION_SECRET=change_me__generate_random_64_hex`. **Действие юзеру:** пересоздать Bot Token и Client Secret, сгенерить `SESSION_SECRET` (`node -e "console.log(crypto.randomBytes(32).toString('hex'))"`), старые токены отозвать.
- **Остальные лазейки (средне):**
  - `folderStore.ts:61` теперь `chmod 0o600` после `writeFileSync` — раньше `644 world-readable`, Discord ID + группы читал любой юзер на хостинге.
  - `discordBot.ts:99-136` санитайз `groupInfo.name/description` — `replace(/[@`]/g,'·')` — без этого `@everyone/@here` в описании группы пингует весь сервер через Embed.
  - `server/index.ts:290` CSRF для cookie-auth — `SameSite Lax` не защищает `fetch POST` cross-site, добавили `isAllowedOrigin` проверку.
  - `Referrer-Policy strict-origin-when-cross-origin` уже был `server/index.ts:33` — теперь без токена в URL риск еще ниже.
  - `sanitizeLog` теперь не логирует токен, т.к. токен не в `originalUrl`.
  - **Что осталось (не критично, в бэклог):** `rateMap` по `req.ip` с `trust proxy 1` ок, но за VPN IP один на всех — можно добавить per-discordId лимит; `SSE /api/user/:query/stream` без auth — можно абузить для DDoS Roblox, добавить `fresh` лимит уже есть; `folderSync.json` не шифруется — на Vercel KV лучше.

### [2026-08-24 17:30 — Live-верификация + фикс DOM nesting]
- **Live-пруф (зачем):** Юзер снял `Birds` в группе `#1087404693` → через ~2 мин бот прислал в DM `Group #1087404693 ⛔ Birds — снята с продажи · Вещь больше не продаётся (была 5 R$) · Off Sale · Not for sale` — скрин `WornBy Drops BOT 17:24` сохранен. Это доказывает, что фикс `robloxService.ts:589` (PascalCase) и `discordBot.ts:136 OFF_SALE` работают end-to-end, а не только в unit-тесте.
- **Что осталось проверить (зачем):** `NEW` и `BACK_ON_SALE` — код уже готов (`NEW #8B5CF6` `BACK_ON_SALE #10B981`), нужно: 1) вернуть `Birds` с ценой 10 R$ → ждем `✅ Снова в продаже за 10 R$ (было 5 R$)`, 2) выпустить новую вещь → `🆕 NEW`.
- **Фикс `validateDOMNesting: <button> cannot appear as descendant of <button>` (зачем):** `CopiedGroupsFolder.tsx:86` внешний `<button>` содержал `<Tooltip><button>Change</button></Tooltip>` → невалидный HTML, React ворнинг в `Stage2Inspector`. **Как:** заменили внешний `<button>` на `<div role="button" tabIndex=0 aria-expanded onKeyDown Enter/Space>` + `cursor-pointer select-none`. Внутренние `Change/Copy/Trash` остались `<button>` внутри `div` — валидно. **Зачем так:** только `div` может содержать интерактивные элементы, `button` внутри `button` запрещен спекой.
- **Нагрузочный инсайт (зачем):** После `POST /api/folder/sync` стало 4 группы → тик `3 groups interval 1m` начал сыпать `429` (`server.log 12:19:28 getAllGroupItems error 429`). **Вывод:** интервал `60000` для теста ок на 1 группе, на 4+ — уже бан. **Рекомендация ИИ:** для 4+ групп держать `7*60*1000` или перейти на backoff по `429`.

### [2026-08-24 — Идеальный фикс: снятие/возврат в продажу с указанием цены]
- **Критичный баг PascalCase регрессия (зачем):** В `robloxService.ts:591` код снова проверял `details.Name / PriceInRobux / IsForSale` (сырой PascalCase), хотя `getEconomyAssetDetails` возвращает нормализованные `name/price/isForSale`. Из-за этого `item.price` всегда `null`, `folderSync.json` забивался `null`, бот НИКОГДА не детектил `true→false`/`false→true`. **Как фиксили:** `robloxService.ts:589-605` теперь `const rawName = d['name'] ?? d['Name']`, `if (typeof d['price'] !== 'undefined') item.price = d['price']` с fallback на `PriceInRobux` и `lowestPrice`, `isForSale` с fallback на `IsForSale/isOffSale`. **Зачем так:** поддержка и нормализованного кэша и прямого raw, чтобы не регрессировать при смене слоя. Проверка: `oldLogic({price:150}) → null`, `newLogic → 150`.
- **Идеальная детекция Discord `discordBot.ts` (как/зачем):**
  - `CHECK_INTERVAL_MS = env || 7*60*1000` — 7м баланс актуальность vs 429, переопределяем для теста. Зачем не 1м в проде: см. живую 429 выше.
  - 4 типа событий с разными цветами: `NEW #8B5CF6 🆕`, `BACK_ON_SALE #10B981 ✅ — автор снова указал цену`, `OFF_SALE #EF4444 ⛔ — снята (было X R$)`, `PRICE_CHANGE #F59E0B 💰 X→Y`. Зачем разные цвета: юзер мгновенно видит тип без чтения текста.
  - Двойная проверка `bypassCache:true` перед `OFF/BACK` — зачем: защита от ложного срабатывания при `429/timeout`. При `null` — откатываем `item.isForSale = prev` и ждем следующий тик.
  - Миграция `heal silent` — зачем: первый тик после фикса тихо чинит 120 `null` без спама. Без этого — DM-спам на всю папку.
  - `isBackfill` порог `prevCount < length-30` + лог — зачем: расширение лимита `10→120` не должно слать старые вещи как `NEW`.
  - `flush()` сразу на диск + `SIGINT/SIGTERM/beforeExit` `folderStore.ts:61` — зачем: рестарт не теряет `itemStates`, иначе повторные уведомления.
  - `/track` прогревает 120 вещей в фоне — зачем: первый тик не считается бэкфиллом.
  - `notifyDiscordUser(event, prevPrice)` — строит разные `title/description/fields/footer` (`было X R$`, `Free/OffSale`).
- **Верификация (как):** `tsc --noEmit` 0, `vite build` 833kb, unit `OFF/BACK/PRICE/HEAL` PASS, live `Birds 5R$` OFF_SALE подтвержден.

### [Текущая сессия — Debug Discord Bot & API Rate Limits]
- **429:** Лимит `checkAllGroups` `2000→120` вещей. Зачем: `2000` = бан IP.
- **Двухэтапный `getAllGroupItems`:** Каталог `search/items` + `getEconomyAssetDetails` по 5. Зачем: решить 429.
- **Casing Economy:** Фикс `isForSale` vs `IsForSale` — первый раз когда нашли, что кэш `null`. Зачем: без этого бот слеп.
- **Синхронизация:** Кэш `true/false` корректно, дифф находит `OFF/BACK` на след. тике.

### [2026-08-24 — Discord Bot, OAuth, Copied Groups Folder и SSE Streaming] — ВАЖНО ДЛЯ ИИ
#### 1. Discord Bot `server/discordBot.ts`
- Стек `discord.js` v14 `Guilds,DirectMessages` + `Partials`.
- Слэш-команды: `/help` двуязычный гайд, `/link <roblox_username>` валидация `^[A-Za-z][A-Za-z0-9_]{2,19}$`, `/unlink`, `/folder` Rich Embed с участниками, `/track|/untrack <group_id>`.
- Cron `7*60*1000` чанки по 3 группы, пауза `1200ms`, 4 события `itemStates`, DM Embed с `library/{id}/redirect?size=420`, `catalog/{id}`, ценой, группой.
- `notifyNewItemForGroup` для ручной проверки с сайта. Бот только `!VERCEL`.

#### 2. Хранилище `folderStore.ts & folderSync.json` — зачем такая структура
- Легковесный файл `300ms` дебаунс → `flush` немедленно. `links/reverseLinks` двунаправленно, `tracked {lastItemId,lastChecked,itemStates}`, `subscriptions groupId→discordIds`, `groupRoblox` последний автор. Ретроактивная привязка при `link` — зачем: группы скопированные до `Connect Discord` тоже привязываются.

#### 3. Discord OAuth & API `server/index.ts`
- `GET /api/auth/discord` 1-клик OAuth `identify` с `state=base64url{roblox,csrf,ts}` + `oauth_csrf` HttpOnly cookie, `GET /callback` обмен code→token→`@me`→`folderStore.link`→редирект на `FRONTEND_URL`.
- `GET /auth/discord/me`, `GET /discord/status`, `POST /folder/sync|unsync`, `GET /group/:id`, `GET /group/:id/new-items` с кэшем `60-120s`.

#### 4. Фронтенд `CopiedGroupsFolder.tsx, useCopiedGroupsFolder.ts`
- Хук: `localStorage wornby_copied_groups_folder_v1`, `storage` sync, `POST /folder/sync`, `checkForUpdates` пул 4 воркера `memberDelta/hasNewItem`.
- UI: Glassmorphism, `NEW ITEM Sparkles`, `Connect Discord`, `timeAgo`, `memberDelta`, `roleName`, EN/RU. **Инвариант DOM:** внешний контейнер `div role="button"`, не `<button>`.

#### 5. SSE Streaming & Сеть `robloxService.ts`
- `GET /api/user/:query?stream=true` + `fetchUserProfileStream` TTFB ~180ms, бейдж `VALUING X/Y`.
- Multi-Shard Egress `(id*2654435761>>>0)%EGRESS_COUNT`, `EGRESS_COUNT=3`, `EGRESS_PROXIES` опционально.
- ETag `If-None-Match` 304 для аватаров/иконок — экономия 80% трафика.
- Resilient Pricing: `lowestPrice` когда `price 0 OffSale`, `DELETED` только при `404`, не при timeout.

### [2026-08-23 — Сессия Muse Spark: полный аудит и фикс 40+ багов] — Читать перед правками
#### 1. Build/Deploy
- `tsconfig.json:19` `api,vite.config.ts` в `include`, `api/index.ts` `../server/index` без `.js`, `vercel.json` rewrites `/api/index` `maxDuration:25`, `server/index.ts:172` `if(!VERCEL) listen`, удаление `three/@radix-dialog` 600kb.

#### 2. Безопасность
- `trust proxy + getClientIp`, CORS deny-by-default, `sanitizeLog`, скрыть `err.message`, `mcp.json` `./`, `.gitignore`.

#### 3. API/Rate-limit/Валидация
- `rateMap 60/min` + `fresh 5/min` раздельно, `express.json 50kb`, `query` валидация numeric/username, `batch-assets` 100 dedup, `ARCHIVED_PREFIX`.

#### 4. Roblox Service
- `signal` во все методы, `getCatalogDetails` чанки 50 + `pLimit5`, `getUserGroups` иконки по 50, `getFullProfile` 1 ключ кэша, `getEquippedAssets` лог.

#### 5. Фронт race/UX
- `App.tsx` `searchSeqRef+abortRef`, `popstate`, `Stage2Inspector` SSR-safe, `Stage1Hero` aria, `api.ts` `VITE_API_URL`.

#### 6. Производительность WebGL
- `TiltCard` rAF throttling, `Balatro` dpr≤2 webglcontextlost, `AssetCard/GroupCard` reduced-motion, `AudioHaptics` cleanup.

#### 7. DRY/A11y
- `fallbacks.ts`, `useClipboard.ts`, `ErrorBoundary`.

### [Текущая сессия — до аудита]
- Поле ввода overlap фикс, SearchButton `useMotionValue`, `layout` Framer, Glassmorphism `backdrop-blur-md`, Balatro шейдер `ogl`, `translate3d` will-change, Phyllotaxis лупы.

### [Ранее]
- `shadcn/ui` токены, убрана `RAW PAYLOAD`, фикс float vs Framer, лупа вместо курсора.
