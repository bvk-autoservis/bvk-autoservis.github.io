# План правок UI/логики — `src/App.tsx` (+ 1 строка в `src/types.ts`)

Стек: React 19 + TypeScript + Tailwind + Vite. PWA, деплой через `gh-pages`.

## Правила работы с файлом
- Файл `src/App.tsx` — UTF-8, ~2686 строк. **Не переписывать целиком.**
- Только точечные Search/Replace правки по приведённым ниже блокам.
- Перед правками желательно `git status` — в дереве уже есть незакоммиченный `src/types.ts`.

## Уточнения к ТЗ (согласовано / выявлено при разборе)
1. **Кнопка «QR-код приложения» отсутствует** в репозитории (поиск по `QR`, `qr`, `код`, `штрих`, `Скачать`, `Поделиться` в `src/` пуст). По решению пользователя: **пункт не выполнять**, кнопку «📱 Установить приложение на телефон» оставить как есть.
2. **Время 09:00–21:00** встречается:
   - UI: `src/types.ts:93` — `export const ADDRESS = 'СПб, Шафировский 28к1 (09:00-21:00)';` (используется в шапке `App.tsx:250`).
   - Логика сетки, которую **менять нельзя**: `src/App.tsx:97-101` (`DEFAULT_SCHEDULE`), `src/types.ts:94` (`WORKING_HOURS`).
   - Правим только отображаемую строку адреса (`ADDRESS`). `WORKING_HOURS` не трогаем (экспорт, но нигде не используется).
3. **«Блокировка прошедшего времени»** — реализуем через ранний `return` в `handleCellAction` (`App.tsx:2462`). Именно этот обработчик открывает `ActionBottomSheet` «Выберите действие / Записать клиента / Создать личное событие».

---

## Задача 1. Шапка: убрать время из адреса

**Файл:** `src/types.ts` (строка 93)

**Search:**
```ts
export const ADDRESS = 'СПб, Шафировский 28к1 (09:00-21:00)';
```
**Replace:**
```ts
export const ADDRESS = 'СПб, Шафировский 28к1';
```

`App.tsx:250` (`<p ...>{ADDRESS}</p>`) менять не нужно — новый текст подхватится автоматически.

---

## Задача 2. Кнопка QR-кода — НЕ ВЫПОЛНЯТЬ (элемента нет). Пропустить.

---

## Задача 3. Журнал мастера: удалить кнопку «+ Добавить запись (по звонку)»

**Файл:** `src/App.tsx` (строки 1931-1935)

**Search:**
```tsx
            <div className="max-w-md mx-auto px-2 sm:px-4 mb-3">
              <button onClick={() => onAddManual()} className="w-full py-2 rounded bg-gray-900 text-white font-medium text-xs">
                + Добавить запись (по звонку)
              </button>
            </div>
```
**Replace:**
```tsx
```

Примечание: prop `onAddManual` и функция `openManualAdd` остаются (используются через `ActionBottomSheet`). Их не удаляем — только кнопку. После правки Tailwind/TS-ошибок не будет (prop по-прежнему передаётся, просто не вызывается из этой кнопки).

---

## Задача 4. Контрастнее сетка расписания + подсветка столбцов

**Файл:** `src/App.tsx`

### 4a. Пустые ячейки: усилить границы и добавить подсветку столбца (строки 1968-1975)

**Search:**
```tsx
                      {weekDays.map((d, dayIdx) => (
                        <div
                          key={`cell-${d.date}-${hour}`}
                          className={`border-r border-b border-gray-100 cursor-pointer ${d.isWeekend ? 'bg-gray-50' : 'bg-white'}`}
                          style={{ gridColumn: dayIdx + 2, gridRow: hourIdx + 2 }}
                          onClick={() => onCellAction(d.date, hour)}
                        ></div>
                      ))}
```
**Replace:**
```tsx
                      {weekDays.map((d, dayIdx) => (
                        <div
                          key={`cell-${d.date}-${hour}`}
                          className={`border-r border-b border-gray-300 cursor-pointer transition-colors ${
                            d.date === selectedJournalDate
                              ? 'bg-purple-50'
                              : d.isWeekend
                                ? 'bg-gray-100'
                                : 'bg-white hover:bg-gray-100'
                          }`}
                          style={{ gridColumn: dayIdx + 2, gridRow: hourIdx + 2 }}
                          onClick={() => onCellAction(d.date, hour)}
                        ></div>
                      ))}
```
Результат: границы `border-gray-300` (вместо почти невидимого `border-gray-100`), столбец выбранной даты подсвечен `bg-purple-50`, выходные `bg-gray-100`, наведение `hover:bg-gray-100` — мастеру проще вести строку/столбец.

### 4b. (опционально) Контрастнее подписи часов (строка 1966)

**Search:**
```tsx
                        <span className="text-[9px] sm:text-[10px] text-gray-500 leading-none">{hour}</span>
```
**Replace:**
```tsx
                        <span className="text-[9px] sm:text-[10px] font-medium text-gray-600 leading-none">{hour}</span>
```

---

## Задача 5. Горизонтальный скролл сетки + месяц при смене месяца

**Файл:** `src/App.tsx`

### 5a. Обернуть сетку в `overflow-x-auto` и задать min-width

Контейнер сетки — строки 1937-1938, сама сетка — 1939-1945.

**Search (открывающие теги):**
```tsx
            <div className="w-full px-1 sm:px-4">
              <div className="bg-white rounded border border-gray-300 overflow-hidden">
                <div
                  className="grid w-full"
                  style={{
                    gridTemplateColumns: '40px repeat(7, minmax(0, 1fr))',
                    gridAutoRows: '60px',
                  }}
                >
```
**Replace:**
```tsx
            <div className="w-full px-1 sm:px-4 overflow-x-auto">
              <div className="bg-white rounded border border-gray-300 overflow-hidden min-w-[488px]">
                <div
                  className="grid w-full min-w-[488px] border-b border-gray-300"
                  style={{
                    gridTemplateColumns: '40px repeat(7, minmax(0, 1fr))',
                    gridAutoRows: '60px',
                  }}
                >
```
`min-w-[488px]` = 40px (колонка времени) + 7×64px (дни). На узких экранах таблица скроллится влево-вправо; `border-b` на сетке закрывает нижнюю границу последнего ряда. Колонки, заголовки и карточки записей используют один и тот же grid-контейнер из 8 колонок, поэтому остаются выровненными.

### 5b. Показывать месяц в ячейке даты при смене месяца

**Файл:** `src/App.tsx` — мемо `weekDays` (строки 1739-1748)

**Search:**
```tsx
    const weekDays = useMemo(() => {
      return weekRange.map(d => ({
        date: toLocalDateString(d),
        dayName: dayNames[d.getDay()],
        dayNum: d.getDate(),
        month: months[d.getMonth()],
        isToday: toLocalDateString(d) === toLocalDateString(today),
        isWeekend: scheduleSettings.daysOff.includes(d.getDay()),
      }));
    }, [weekRange, today, scheduleSettings.daysOff]);
```
**Replace:**
```tsx
    const weekDays = useMemo(() => {
      return weekRange.map((d, i) => ({
        date: toLocalDateString(d),
        dayName: dayNames[d.getDay()],
        dayNum: d.getDate(),
        month: months[d.getMonth()],
        // показываем месяц при смене месяца: первый день недели или день, где месяц отличается от предыдущего
        showMonth: i === 0 || d.getMonth() !== weekRange[i - 1].getMonth(),
        isToday: toLocalDateString(d) === toLocalDateString(today),
        isWeekend: scheduleSettings.daysOff.includes(d.getDay()),
      }));
    }, [weekRange, today, scheduleSettings.daysOff]);
```

**Файл:** `src/App.tsx` — рендер заголовка дня (строки 1948-1958)

**Search:**
```tsx
                  {weekDays.map((d, dayIdx) => (
                    <div
                      key={`header-${d.date}`}
                      onClick={() => onJournalDateChange(d.date)}
                      className={`border-r border-b border-gray-300 flex flex-col items-center justify-center py-1 cursor-pointer transition ${d.date === selectedJournalDate ? 'bg-purple-100' : d.isWeekend ? 'bg-gray-50' : 'bg-white'}`}
                      style={{ gridColumn: dayIdx + 2, gridRow: 1 }}
                    >
                      <span className={`text-[10px] sm:text-xs font-medium leading-none ${d.date === selectedJournalDate ? 'text-purple-700' : ''}`}>{d.dayName}</span>
                      <span className={`text-[10px] sm:text-xs mt-1 leading-none ${d.date === selectedJournalDate ? 'text-purple-700 font-bold' : 'text-gray-600'}`}>{d.dayNum}</span>
                    </div>
                  ))}
```
**Replace:**
```tsx
                  {weekDays.map((d, dayIdx) => (
                    <div
                      key={`header-${d.date}`}
                      onClick={() => onJournalDateChange(d.date)}
                      className={`border-r border-b border-gray-300 flex flex-col items-center justify-center py-1 cursor-pointer transition ${d.date === selectedJournalDate ? 'bg-purple-100' : d.isWeekend ? 'bg-gray-50' : 'bg-white'}`}
                      style={{ gridColumn: dayIdx + 2, gridRow: 1 }}
                    >
                      <span className={`text-[10px] sm:text-xs font-medium leading-none ${d.date === selectedJournalDate ? 'text-purple-700' : ''}`}>{d.dayName}</span>
                      <span className={`text-[10px] sm:text-xs mt-1 leading-none ${d.date === selectedJournalDate ? 'text-purple-700 font-bold' : 'text-gray-600'}`}>
                        {d.dayNum}
                        {d.showMonth && <span className="ml-0.5 text-[9px] text-gray-400">{d.month}</span>}
                      </span>
                    </div>
                  ))}
```
Итог: у первого дня недели и у дня, с которого начинается новый месяц, рядом с числом появляется краткое название месяца, например `1 нояб`, `1 дек`.

Альтернатива (если хочется строго как в ТЗ — «Нояб» с заглавной): заменить `{d.month}` на `{d.month.charAt(0).toUpperCase() + d.month.slice(1)}`. Рекомендуется строчный вариант (`нояб`, `дек`) — он аккуратнее смотрится рядом с числом и не ломает вёрстку.

---

## Задача 6. Блокировка прошедшего времени (Журнал мастера)

**Файл:** `src/App.tsx` — `handleCellAction` (строки 2462-2464)

**Search:**
```tsx
  const handleCellAction = (date: string, time: string) => {
    setActionSheetData({ date, time });
  };
```
**Replace:**
```tsx
  const handleCellAction = (date: string, time: string) => {
    // На прошедшее время запись создавать нельзя
    const [hourStr, minuteStr] = time.split(':');
    const slot = parseLocalDate(date);
    slot.setHours(parseInt(hourStr, 10) || 0, parseInt(minuteStr, 10) || 0, 0, 0);
    if (slot.getTime() < Date.now()) {
      return; // слот в прошлом — не открываем меню создания записи
    }
    setActionSheetData({ date, time });
  };
```
Поведение: клик по пустой ячейке, чьи дата+время меньше `new Date()`, теперь игнорируется (меню «Записать клиента / Создать личное событие» не открывается). Будущие дни и будущие часы сегодняшнего дня работают как раньше. `parseLocalDate` уже определён в `App.tsx:17`.

---

## Задача 7. Деплой на GitHub Pages (предоставить пользователю ПОСЛЕ подтверждения работы)

В `package.json` уже есть скрипт `"deploy": "vite build && gh-pages -d dist"`, `gh-pages` в devDependencies, `base: './'` в `vite.config.ts`.

Последовательность команд (PowerShell, запускать в корне проекта):
```powershell
npm run build
npx gh-pages -d dist
```
Либо одной командой:
```powershell
npm run deploy
```
Проверка перед деплоем:
- `git status` — убедиться, что изменения в `src/App.tsx` и `src/types.ts` на месте.
- Убедиться, что репозиторий связан с remote: `git remote -v` (в текущем чекауте remote-вывод не подтверждён — команда `git remote -v` не была видна в выводе; проверьте вручную перед `gh-pages`).
- При первом деплое `gh-pages` создаст/обновит ветку `gh-pages` и запушит в `origin`.
Если нужно закоммитить исходники (не обязательно для `gh-pages`, который пушит только `dist`):
```powershell
git add src/App.tsx src/types.ts
git commit -m "feat(ui): journal grid contrast, horizontal scroll, month labels, block past slots"
```

---

## Валидация после правок
1. `npm run dev` — открыть приложение.
2. **Режим «Запись клиента»**: в шапке отображается только `СПб, Шафировский 28к1` без времени.
3. **Режим «Журнал мастера»**: кнопки «+ Добавить запись (по звонку)» нет; сетка с более тёмными границами, подсветкой выбранного столбца/строк и горизонтальным скроллом на узком экране.
4. Переключение недель (`<` / `>` и 📅): на первом дне недели и при переходе в новый месяц у числа виден короткий месяц.
5. Клик по прошедшей ячейке (вчера/прошлый час сегодня) — меню не открывается; по будущей — открывается.
6. `npm run build` — сборка без ошибок TypeScript.
7. Только после успешной проверки — команды деплоя из Задачи 7.

## Затронутые файлы
- `src/App.tsx` — задачи 3, 4a, 4b, 5a, 5b, 6.
- `src/types.ts` — задача 1 (одна строка, `ADDRESS`).

## Открытые вопросы
- Нет. Пункт QR закрыт по решению пользователя (пропустить).

## Out of scope
- Кнопка QR-кода (в коде отсутствует).
- Кнопка «Установить приложение» и `InstallGuideModal`.
- Логика рабочих часов (`DEFAULT_SCHEDULE`, `WORKING_HOURS`) — не изменяется.
