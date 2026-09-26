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
