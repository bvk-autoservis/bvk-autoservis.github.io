# Технический аудит перед подключением Supabase
### `src/App.tsx` (2990 строк) · `src/types.ts` (147 строк)

> Статус: только аудит. Код не изменялся, сборка не запускалась.
> Источник: чтение файлов репозитория `bvk-gbo-app` + grep по кодовой базе.

---

## Контекст и ключевые риски

Стек: React 19 + TypeScript + Vite + Tailwind CSS, `base: './'` (деплой на GitHub Pages через `gh-pages`).
Supabase **ещё не подключён**: в `package.json` нет `@supabase/supabase-js`, файла `src/lib/supabase.ts` нет, `.env*` отсутствует, `.gitignore` не игнорирует `.env`.
Легаси-файлы `src/pages/*` (`Home`, `Price`, `Booking`, `ReviewsChat`) и `src/components/*` (`BottomBar`, `BrandGearLogo`, `Header`) **нигде не импортируются** — мёртвые заготовки.

| # | Риск | Где | Последствие для Supabase |
|---|------|-----|--------------------------|
| R1 | `id = Date.now().toString()` | `App.tsx` 1105, 1124, 1441, 1576, 1710, 2653 | Ненадёжный PK → нужен `uuid` на стороне БД |
| R2 | Демо определяются по `id.startsWith('demo')` | 2685, 2832 | При переходе на UUID логика ломается → нужен флаг `is_demo` |
| R3 | `services: string[]` внутри `Booking` | `types.ts:30` | В Postgres — `text[]` (100% совпадение с типом TS) |
| R4 | Анониму нужны занятые слоты (`getBlockedHoursMap`) | 181–195, 2816 | Конфликт с RLS: открытый `SELECT` ведёт к утечке ПДн клиентов |
| R5 | Кнопка «Журнал мастера» открыта всем | `Header` 254–279 | Админка без авторизации |
| R6 | Хардкод URL/имени («Владимир», QR-URL, URL репо) | 1812, 2059, 2447, 2453 | Вынести в конфиг/env |
| R7 | `Booking` camelCase ↔ PostgREST snake_case | `types.ts` | Нужны явные мапперы row ↔ Booking |
| R8 | Мёртвый код/дубли | `HOUR_HEIGHT` 179, `getBookingsAtSlot` 197 не используются; `formatDuration` 171 дублирует `formatDurationDisplay` 2038 | Почистить при рефакторинге |

---

## 1. Инвентаризация состояния и моков

### 1.1. localStorage: ключи и helper-функции (→ Supabase)

| Сущность | Ключ | Функции (строки) | Таблица |
|----------|------|------------------|---------|
| Записи | `bumpix_bookings` (24) | `loadBookings` 26–32, `saveBookings` 34–36 | `bookings` |
| Услуги | `bumpix_services` (39) | `loadServices` 66–74, `saveServices` 76–78 | `services` |
| Клиенты | `bumpix_clients` (81) | `loadClients` 83–89, `saveClients` 91–93 | `clients` |
| Расписание | `bumpix_schedule` (96) | `loadScheduleSettings` 103–111, `saveScheduleSettings` 113–115 | `schedule_settings` |

Пары `setX(...) + saveX(...)` в `App` (например `handleBook` 2669–2671, `handleSaveManual` 2700–2702, `handleUpdateServices` 2728–2731, `handleSaveClient` 2733–2738) заменяются на вызовы репозитория Supabase.

### 1.2. Захардкоженные массивы и константы

| Что | Переменная | Строки | Судьба |
|-----|-----------|--------|--------|
| Каталог 20 услуг (13 BVK + 7 GBO) | `INITIAL_SERVICES` | 41–64 | Seed таблицы `services` |
| Демо-записи | `seedIfNeeded` + `demo-1..4` | 132–168 | Удалить; опциональный seed с `is_demo = true` |
| Дефолтное расписание | `DEFAULT_SCHEDULE` | 97–101 | `DEFAULT` + начальная строка в `schedule_settings` |
| Месяцы/дни (кириллица) | `MONTH_NAMES`, `MONTH_NAMES_NOM`, `DAY_NAMES_SHORT` | 459–461 | В `src/lib/date.ts` |
| Месяцы журнала | `months`, `monthNamesFull`, `dayNames` | 1830–1832 | В `src/lib/date.ts` |
| Дни недели в модалке | `WEEK_SHORT` | 1283 | В `src/lib/date.ts` |
| Список выходных | inline-массив настроек | 2367–2374 | Оставить в UI-компоненте |
| URL репо/QR | строки | 1812, 2447, 2453 | В env / `src/lib/config.ts` |
| Бренды | `BRANDS` | `types.ts` 68–91 | Статичный справочник (2 записи) |
| Марки авто | `CAR_MAKES` | `types.ts` 107–112 | Не используется — перенести в UI или удалить |

### 1.3. `useState` в `App` (2472–2987)

**Переносятся в Supabase-хуки:**
- `bookings` / `setBookings` — 2475 → `useBookings()`
- `services` / `setServices` — 2537 → `useServices()`
- `clients` / `setClients` — 2538 → `useClients()`
- `scheduleSettings` / `setScheduleSettings` — 2539 → `useSchedule()`

**Остаются локальным UI-стейтом:**
`activeBrand` 2473, `mode` 2474, `selectedServices` 2478, `selectedDate` 2479, `selectedTime` 2480, `contactForm` 2481, `isSubmitted` 2482, `currentBooking` 2483, `isTimeSelectionOpen` 2484, `validationError` 2485, `isBookingSectionVisible` 2488, `isFormMounted` 2515, `isFormExpanded` 2516, `filterBrand` 2530, `selectedJournalDate` 2531, `isManualOpen` 2532, `prefillTime` 2533, `prefillBrand` 2534, `prefillDate` 2535, `detailsBooking` 2536, `actionSheetData` 2540, `isPersonalEventOpen` 2541, `deferredPrompt` 2542, `showInstallHelp` 2543, `isMobile` 2544, `isStandalone` 2545.
Refs: `calendarSectionRef` 2486, `bookingFormRef` 2487.

### 1.4. Локальный `useState` под-компонентов (в БД не идут)

| Компонент | Переменные (строки) |
|-----------|---------------------|
| `StepServices` | `searchQuery` 314, `plateEntering` 315 |
| `InstallGuideModal` | `activeTab` 787, `copied` 795 |
| `StepDateTime` | `calendarMonth` 543 |
| `ManualAddModal` | `step` 1069, `selectedClient` 1070, `selectedServiceIds` 1071, `newName` 1074, `newPhone` 1075, `newCarMake` 1076, `newCarModel` 1077 |
| `BookingDetailsModal` | `localStatus` 1275 |
| `ServiceModal` | `name` 1415, `durationStr` 1416, `priceInput` 1417, `brand` 1418 |
| `ClientModal` | `name` 1552, `phone` 1553, `carMake` 1554, `carModel` 1555 |
| `PersonalEventModal` | `title` 1694, `startTime` 1695, `endTime` 1696 |
| `JournalMode` | `isDrawerOpen` 1804, `activeAdminScreen` 1805, `isQrModalOpen` 1808, `isQrLinkCopied` 1809, `toolbarMonthKey` 1922, `serviceFilterBrand` 1965, `isServiceModalOpen` 1966, `editingService` 1967, `isClientModalOpen` 1969, `editingClient` 1970, `localSchedule` 1972, `isScheduleSaved` 1980 |

### 1.5. Точка инициализации

`seedIfNeeded()` 132–168 вызывается один раз в `useEffect` 2547–2571 вместе с загрузкой сущностей. Это единственное место bootstrap — заменяется на загрузку из Supabase.

---

## 2. Проектирование схемы БД Supabase (PostgreSQL)

Принцип: типы 1:1 соответствуют TS-интерфейсам. Используем `snake_case` в БД + мапперы в `src/lib/mappers.ts`. Поля `price`, `time`, `date` сохраняются строками, чтобы не ломать существующую логику форматирования (`parsePrice`, `formatDateTime`).

### 2.1. DDL (таблицы, типы, связи)

```sql
-- services <-> Service { id, name, price, duration, brand }
create table public.services (
  id          text primary key,                   -- 'oil', 'gbo-diag'
  name        text not null,
  price       text not null,                      -- "1200 ₽" / "от 6500 ₽"
  duration    integer not null default 60,        -- минуты
  brand       text not null check (brand in ('bvk','gbo')),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- bookings <-> Booking
create table public.bookings (
  id           uuid primary key default gen_random_uuid(),
  brand        text not null check (brand in ('bvk','gbo')),
  services     text[] not null default '{}',      -- массив service.id (TS string[])
  service_name text not null default '',
  total_price  integer not null default 0,
  car_make     text not null default '',
  car_model    text not null default '',
  date         date not null,
  time         text not null,                     -- 'HH:MM'
  name         text not null default '',
  phone        text not null default '',
  comment      text not null default '',
  status       text not null default 'pending'
               check (status in ('pending','in_progress','ready')),
  type         text not null default 'client'
               check (type in ('client','personal')),
  is_demo      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index bookings_date_idx on public.bookings (date);
create index bookings_slot_idx on public.bookings (date, time);

-- clients <-> Client
create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  phone      text not null default '',
  car_make   text,
  car_model  text,
  created_at timestamptz not null default now()
);
create index clients_phone_idx on public.clients (phone);

-- schedule_settings <-> ScheduleSettings (синглтон)
create table public.schedule_settings (
  id         integer primary key default 1 check (id = 1),
  start_time text not null default '09:00',
  end_time   text not null default '21:00',
  days_off   integer[] not null default '{0,6}',  -- 0=Вс ... 6=Сб
  updated_at timestamptz not null default now()
);
insert into public.schedule_settings (id) values (1) on conflict (id) do nothing;
```

**Связи и особенности:**
- `bookings.services`: массив `text[]` без FK-ограничения для полного сохранения контракта интерфейса `string[]`.
- `bookings` ↔ `clients`: прямой внешний ключ (FK) не используется, чтобы анонимный клиент мог оформлять запись без прав на чтение/запись таблицы `clients`.
- `schedule_settings`: строгий синглтон (`check (id = 1)`).

### 2.2. RLS-политики (Row Level Security)

```sql
alter table public.services          enable row level security;
alter table public.bookings          enable row level security;
alter table public.clients           enable row level security;
alter table public.schedule_settings enable row level security;

-- services
create policy services_read  on public.services for select to anon, authenticated using (is_active);
create policy services_write on public.services for all    to authenticated using (true) with check (true);

-- schedule_settings
create policy schedule_read  on public.schedule_settings for select to anon, authenticated using (true);
create policy schedule_write on public.schedule_settings for all    to authenticated using (true) with check (true);

-- bookings
create policy bookings_insert_anon on public.bookings for insert to anon
  with check (status = 'pending' and type = 'client' and is_demo = false);

create policy bookings_all_auth on public.bookings for all to authenticated
  using (true) with check (true);

-- clients
create policy clients_all_auth on public.clients for all to authenticated
  using (true) with check (true);
```

| Таблица | `anon` (клиент) | `authenticated` (мастер) |
|---------|-----------------|--------------------------|
| `services` | SELECT (только активные) | SELECT / INSERT / UPDATE / DELETE |
| `schedule_settings` | SELECT | SELECT / UPDATE |
| `bookings` | INSERT (pending/client, не demo) + RPC `get_busy_slots` | Полный CRUD |
| `clients` | Доступ запрещён | Полный CRUD |

### 2.3. Решение риска R4: занятые слоты без утечки данных

Клиенту необходимы часы занятости для календаря (`getBlockedHoursMap`), но доступ к таблице `bookings` анониму закрыт. Решение — безопасная SQL-функция `SECURITY DEFINER`, возвращающая только слот времени и бренд:

```sql
create or replace function public.get_busy_slots(p_date date)
returns table (hour text, brand text)
language sql
security definer
set search_path = public
as $$
  select distinct to_char(b.time::time, 'HH24') || ':00', b.brand
  from public.bookings b
  where b.date = p_date;
$$;

grant execute on function public.get_busy_slots(date) to anon, authenticated;
```

---

## 3. План безопасной декомпозиции `src/App.tsx`

### 3.1. Целевая структура модулей

```
src/
  lib/
    supabase.ts        // инициализация клиента Supabase
    mappers.ts         // snake_case (БД) <-> camelCase (TS)
    date.ts            // чистые утилиты и константы дат
    schedule.ts        // расчет рабочих часов и занятых слотов
    config.ts          // APP_URL, QR_URL, телефоны и метаданные
  hooks/
    useBookings.ts     // CRUD записей + RPC get_busy_slots
    useServices.ts     // чтение и обновление каталога услуг
    useClients.ts      // справочник клиентов (только мастер)
    useSchedule.ts     // график работы автосервиса
    useAuth.ts         // отслеживание сессии Supabase Auth
  components/
    Header.tsx         // шапка с брендами (клиентская часть)
    StatusBadge.tsx    // бейдж статуса заявки
    client/
      StepServices.tsx
      StepDateTime.tsx
      StepContact.tsx
      Confirmation.tsx
      NearestBooking.tsx
    journal/
      JournalMode.tsx
      ServiceModal.tsx
      ClientModal.tsx
      BookingDetailsModal.tsx
      ManualAddModal.tsx
      PersonalEventModal.tsx
      ActionBottomSheet.tsx
    pwa/
      InstallGuideModal.tsx
  App.tsx              // точка входа и роутер режимов (< 250 строк)
```

### 3.2. Поэтапный регламент рефакторинга

* **Шаг 0. Инфраструктура БД (без изменения кода приложения):**
  1. Установка зависимости: `npm i @supabase/supabase-js`.
  2. Создание `src/lib/supabase.ts` с инициализацией через `.env`.
  3. Создание `.env.example`, добавление `.env` в `.gitignore`.
  4. Подготовка файлов `src/lib/mappers.ts` и `src/lib/config.ts`.
  *Проверка:* `npm run build` успешен.

* **Шаг 1. Вынос утилит без состояния (нулевой риск):**
  1. Вынос функций дат и названий месяцев/дней в `src/lib/date.ts`.
  2. Вынос расчёта слотов и проверки доступности в `src/lib/schedule.ts`.
  3. Удаление мёртвого кода (`HOUR_HEIGHT`, `getBookingsAtSlot`).
  *Проверка:* `npm run build` успешен.

* **Шаг 2. Вынос модальных окон и компонентов журнала:**
  1. Перенос модалок журнала в `src/components/journal/`.
  2. Перенос компонентов клиентской записи в `src/components/client/`.
  3. Очистка неиспользуемых файлов из `src/pages/` и старых заготовок `src/components/`.
  *Проверка:* `npm run build` успешен.

* **Шаг 3. Подключение хуков данных вместо localStorage:**
  1. Реализация хуков в порядке: `useServices` → `useSchedule` → `useClients` → `useBookings`.
  2. Подключение RPC `get_busy_slots` в логику выбора времени.
  3. Удаление функций `load*` и `save*` из `App.tsx`.
  *Проверка:* `npm run build` успешен, данные читаются и сохраняются в Supabase.

* **Шаг 4. Сборка облегчённого `App.tsx`:**
  1. `App.tsx` отвечает только за связывание хуков, глобальный режим (`mode`) и контекст сессии.
  2. Финальный объём файла: менее 250 строк.

---

## 4. Скрытие «Журнала мастера» и Supabase Auth

### 4.1. Архитектура доступа
1. Кнопка «Журнал мастера» удаляется из открытой клиентской шапки.
2. **Точки вызова экрана авторизации:**
   - Скрытый триггер: 5 быстрых тапов по логотипу или адресу за 3 секунды.
   - URL-параметр: запуск с `?admin=1`.
3. При открытии вызывается форма авторизации `AuthModal` (Email / Пароль).

### 4.2. Сохранение сессии мастера
В `src/lib/supabase.ts` настраивается постоянная сессия:
```typescript
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'bvk_master_session',
    },
  }
);
```

Мастер входит в систему один раз. При всех повторных запусках PWA на его телефоне активная сессия подхватывается автоматически, и приложение сразу открывает «Журнал мастера». Для выхода в настройки журнала добавляется кнопка «Выйти из аккаунта» (`supabase.auth.signOut()`).

---

## Итоговая сводка ключевых решений

1. **Типизация:** `services` сохраняется как `text[]` внутри `bookings`, что устраняет необходимость сложной связующей таблицы на этапе MVP.
2. **Безопасность:** Персональные данные защищены на уровне СУБД; клиент получает только обезличенные занятые слоты через SQL-функцию `get_busy_slots`.
3. **Надёжность:** Первичные ключи переводятся на системный `uuid`, а демо-записи изолируются флагом `is_demo`.