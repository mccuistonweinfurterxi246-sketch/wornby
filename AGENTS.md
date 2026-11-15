# Навигация по коду проекта

В проекте установлен CLI `graphify`. Актуальный локальный индекс кода находится в `graphify-out/graph.json`, исходники инструмента для справки — в `.tools/graphify/`. Обе папки исключены из Git. Индекс охватывает `src/`, `server/`, `api/` и конфигурацию сборки; состав задаёт `.graphifyignore`.

Когда задача касается устройства кода или влияния правки, сначала используй граф для поиска нужных файлов и связей, затем проверяй найденное по исходникам. Имена символов и запросы к CLI формулируй на английском: русские запросы могут не находить узлы. Граф не заменяет проверку динамических HTTP-связей и фактического поведения.

Полезные команды из корня проекта:

```powershell
graphify god-nodes --top 15
graphify explain "RobloxService"
graphify query "player search groups" --budget 1200
graphify path "PlayerSearch()" "usePlayerHistory()"
graphify affected "RobloxApiClient" --depth 2
```

После изменений кода обновляй индекс командой `graphify update .`. Если набор файлов или правила `.graphifyignore` изменились, перестрой его командой `graphify extract . --code-only --max-workers 4 --force`, затем выполни `graphify cluster-only . --no-label --no-viz` для отчёта. Граф и отчёт лежат в `graphify-out/`.

# Бэкенд (Rust)

Все маршруты `/api/*` обслуживает одна Vercel-функция на Rust: `api/main.rs` → `rust/lib.rs` (маршрутизация, origin, лимиты), `rust/catalog.rs` (магазин, группы, правила цен), `rust/profile.rs` (профиль, SSE, поиск), `rust/outfits.rs`, `rust/upstream.rs` (запросы к Roblox: зеркало roproxy, хеджирование, один повтор, кэши). `vercel.json` переписывает `/api/(.*)` на `/api/main?__path=$1`.

- Локально: `npm run dev` (Vite + `cargo run --release --bin main` на порту 3001). На этой машине сборке нужен `vcvars64.bat` из VS 2022 BuildTools.
- Тесты: `npm test` (TS-тесты фронтенда + `cargo test`).
- Сравнение с прежним Node-бэкендом по всем эндпоинтам: `node scripts/compare-api.mjs` (см. комментарий в файле); проверка всего приложения в Chrome: `node scripts/e2e-smoke.mjs [url]`.
- Лимиты Roblox: пакетный `catalog/items/details` (POST) без входа даёт ~1 запрос в 30 с на IP, а `search/items/details` принимает только limit 10/28/30 — не возвращать эти вызовы в горячий путь.

# Архив образов (вкладка ARCHIVE)

Вкладка ARCHIVE (значение вкладки в URL осталось `fits`) объединяет сохранённые образы игрока, удалённые образы из Wayback Machine и историю надетых образов. Базы данных нет: сервер ничего не хранит, а архив каждого игрока лежит в IndexedDB браузера (`wornby-archive`) вместе со списком уже обработанных снимков, поэтому загрузка большого аккаунта продолжается с места остановки.

- Бэкенд: `rust/archive.rs` (приватность инвентаря + все страницы сохранённых образов), `rust/wayback.rs` (индекс снимков, загрузка, разбор JSON и старых HTML-профилей 2015–2020 с архивными рендерами). Маршруты: `GET /api/users/{id}/archive`, `GET /api/users/{id}/archive/index?kind=outfits|wearing|avatar|profile`, `GET /api/archive/snapshot`, `GET /api/outfits/{id}/archived`; `GET /api/outfits/{id}` отвечает 404 для удалённых образов.
- Фронтенд: `src/lib/outfitArchive.ts` (слияние без дублей и статусы, тесты в `tests/outfitArchive.test.ts`), `src/hooks/useOutfitArchive.ts` (порядок загрузки и IndexedDB), `src/components/OutfitArchive.tsx`, `src/components/OutfitPreviewDialog.tsx`.
- Приватность: если инвентарь игрока закрыт (правило Roblox с 2025-11-12), образы не показываются ни живые, ни архивные; архивные списки образов таких игроков сервер не ищет и не отдаёт. Показываются только надетые образы — Roblox показывает их всем.
- Wayback: поиск по префиксу (нужен для списков образов) идёт через `web/timemap/json` и занимает 10–60 с; остальные виды ищутся точным совпадением за 1–3 с. На инстанс не больше 3 одновременных запросов к Wayback. Снимки неизменны и кэшируются CDN на год, индекс — на сутки. Для `/api/archive/*` отдельный лимит 400 запросов в минуту на IP.

# Исследование игроков и групп

- Бэкенд `rust/explore.rs`: участники группы (`/api/group/{id}/members`; если Roblox скрывает список — `hidden: true` и владелец), места (`/api/{users|group}/{id}/experiences`), ассеты Creator Store только model/decal/mesh (`/assets?type=`, точные количества `/assets-summary`), созданные игроком вещи (`/api/users/{id}/creations`).
- Магазин группы делится на разделы CLOTHING / ACCESSORIES / HEADS & FACES / ANIMATIONS: каждый — своя категория каталога Roblox (3 / 11 / 18 / 12, только числами — неизвестное имя Roblox молча превращает во «все»), каждая строка проверяется по типу (`catalog::Section::accepts`). Точные количества — `/api/group/{id}/store-summary`. Категория 18 содержит и бандлы тел, и волосы, поэтому HEADS & FACES = только бандлы Dynamic Head.
- ID бандла — не ID ассета: карточка бандла копирует ID его Dynamic Head (`wearAssetId`) и ведёт на `/bundles/{id}`; картинки бандлов берутся из `thumbnails/v1/bundles`.
- Навигация: цепочка «крошек» хранится в `history.state` (`src/lib/exploreTrail.ts`), Back/Forward восстанавливают игрока, группу и вкладку (`?store=`, `?gtab=`).
