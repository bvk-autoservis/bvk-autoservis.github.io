import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  BRANDS, ADDRESS,
  formatDateTime, formatDateLabel, parsePrice,
  BrandType, Service, Booking, BookingStatus, AppMode, ScheduleSettings, Client,
} from './types';
import { Car } from 'lucide-react';
import {
  supabase, DEFAULT_SCHEDULE,
  fetchServices,
  saveService as saveServiceToDb, deleteService as deleteServiceFromDb,
  fetchScheduleSettings, updateScheduleSettings,
  fetchClients, saveClient as saveClientToDb, deleteClient as deleteClientFromDb,
  fetchBookings, createBooking, createPublicBooking, updateBookingRecord, deleteBookingRecord,
  fetchBusySlots,
} from './lib/supabase';
import AuthModal from './components/AuthModal';
import PwaInstallBanner from './components/PwaInstallBanner';
import { bookingFromRow } from './lib/mappers';


// ===== Date helpers (timezone-safe) =====
function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}


// ===== localStorage helpers for client PWA profile & own bookings =====
const CLIENT_PROFILE_KEY = 'bvk_client_profile';
const CLIENT_OWN_BOOKINGS_KEY = 'bvk_my_bookings';

interface ClientProfile {
  name: string;
  phone: string;
  carMake: string;
  carModel: string;
}

function loadClientProfile(): ClientProfile | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLIENT_PROFILE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      name: parsed.name || '',
      phone: parsed.phone || '',
      carMake: parsed.carMake || '',
      carModel: parsed.carModel || '',
    };
  } catch {
    return null;
  }
}

function saveClientProfile(profile: ClientProfile): void {
  localStorage.setItem(CLIENT_PROFILE_KEY, JSON.stringify(profile));
}

function loadOwnBookings(): Booking[] {
  try {
    return JSON.parse(localStorage.getItem(CLIENT_OWN_BOOKINGS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveOwnBookings(bookings: Booking[]): void {
  localStorage.setItem(CLIENT_OWN_BOOKINGS_KEY, JSON.stringify(bookings, null, 2));
}

// ===== Working hours =====
function generateWorkingHours(start: string, end: string): string[] {
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startTotal = startH * 60 + startM;
  const endTotal = endH * 60 + endM;
  const hours: string[] = [];
  for (let t = startTotal; t < endTotal; t += 60) {
    const h = Math.floor(t / 60);
    const m = t % 60;
    hours.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
  }
  return hours;
}

// ===== Utility: format duration =====
function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h} ч. ${m} мин.` : `${h} ч.`;
  return `${m} мин.`;
}

// ===== Utility: get height for duration in grid (pixels per hour) =====
const HOUR_HEIGHT = 80; // px

function getBlockedHoursMap(bookings: Booking[], date: string, services: Service[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of bookings) {
    if (b.date !== date) continue;
    const durationMin = b.services.reduce((sum, id) => sum + (services.find(s => s.id === id)?.duration || 0), 0);
    const hours = durationMin === 0 ? 1 : Math.ceil(durationMin / 60);
    const [startH] = b.time.split(':').map(Number);
    for (let i = 0; i < hours; i++) {
      const h = startH + i;
      const slot = `${h.toString().padStart(2, '0')}:00`;
      if (!map.has(slot)) map.set(slot, b.brand);
    }
  }
  return map;
}

function getBookingsAtSlot(bookings: Booking[], date: string, time: string): Booking[] {
  return bookings.filter(b => b.date === date && b.time === time);
}

// ===== Time / duration helpers =====
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// Реальная длительность записи в минутах: явное поле duration → endTime → длительность услуг.
// Для личных событий без услуг по умолчанию 60 минут.
function getBookingDuration(b: Booking, services: Service[]): number {
  if (typeof b.duration === 'number' && b.duration > 0) return b.duration;
  if (b.endTime) {
    const diff = timeToMinutes(b.endTime) - timeToMinutes(b.time);
    if (diff > 0) return diff;
  }
  const min = b.services.reduce((sum, id) => sum + (services.find(s => s.id === id)?.duration || 0), 0);
  if (min > 0) return min;
  return 60;
}

function getBookingEndTime(b: Booking, services: Service[]): string {
  return minutesToTime(timeToMinutes(b.time) + getBookingDuration(b, services));
}

// Цвет карточки в сетке журнала: кастомный → зелёный для BVK → оранжевый для личных событий / ГБО.
function getBookingColor(b: Booking): string {
  if (b.color) return b.color;
  if (b.type === 'personal') return '#ea580c';
  return b.brand === 'bvk' ? '#16a34a' : '#ea580c';
}

// Раскладка пересекающихся по времени записей рядом по горизонтали (side-by-side, как Bumpix/Google Calendar).
// Возвращает для каждой записи: { colIndex, colCount } — долю ширины колонки дня.
function layoutDayItems(items: Booking[], services: Service[]): Map<string, { colIndex: number; colCount: number }> {
  const result = new Map<string, { colIndex: number; colCount: number }>();
  if (items.length === 0) return result;

  const enriched = items.map(b => {
    const start = timeToMinutes(b.time);
    return { b, start, end: Math.max(start + 1, start + getBookingDuration(b, services)) };
  }).sort((x, y) => (x.start - y.start) || (x.end - y.end));

  let cluster: typeof enriched = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    // colIndex — первая свободная дорожка; colCount — макс. число одновременных наложений в кластере
    const columns: number[] = [];
    let maxCol = 0;
    for (const item of cluster) {
      let placed = columns.findIndex(end => end <= item.start);
      if (placed === -1) {
        columns.push(item.end);
        placed = columns.length - 1;
      } else {
        columns[placed] = item.end;
      }
      maxCol = Math.max(maxCol, placed + 1);
      result.set(item.b.id, { colIndex: placed, colCount: 0 });
    }
    for (const item of cluster) {
      const info = result.get(item.b.id);
      if (info) info.colCount = maxCol;
    }
    cluster = [];
  };

  for (const item of enriched) {
    if (cluster.length > 0 && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();

  return result;
}

// ===== Header =====
const Header: React.FC<{
  activeBrand: BrandType;
  onBrandChange: (b: BrandType) => void;
  onLogoTap: () => void;
}> = ({ activeBrand, onBrandChange, onLogoTap }) => {
  const brand = BRANDS[activeBrand];

  return (
    <>
      {/* Purple header bar */}
      <div className="bg-purple-700 text-white py-2 px-4 text-center text-sm font-medium max-w-md mx-auto">
        {brand.name} · {brand.subtitle}
      </div>

      <header className="bg-white border-b border-gray-300 shadow-sm">
        <div className="max-w-md mx-auto px-4 py-3 space-y-3">
          {/* Brand capsule toggle */}
          <div className="flex justify-center">
            <div className="inline-flex items-center bg-gray-100 rounded border border-gray-300 p-0.5 text-sm font-medium">
              <button
                onClick={() => onBrandChange('bvk')}
                className={`px-3 py-1 transition-all ${activeBrand === 'bvk'
                  ? 'bg-green-600 text-white'
                  : 'text-gray-700 hover:bg-gray-200'
                  }`}
              >
                BVK-AUTOSERVIS
              </button>
              <button
                onClick={() => onBrandChange('gbo')}
                className={`px-3 py-1 transition-all ${activeBrand === 'gbo'
                  ? 'bg-red-600 text-white'
                  : 'text-gray-700 hover:bg-gray-200'
                  }`}
              >
                МирГбоСПб
              </button>
            </div>
          </div>

          {/* Contact card */}
          <div className="flex items-center gap-3">
            <img
              src={brand.logo}
              alt={brand.name}
              onClick={onLogoTap}
              className="w-12 h-12 object-contain flex-shrink-0 cursor-pointer select-none"
            />
            <div className="flex-1 min-w-0">
              <h2 className="font-bold text-gray-900 text-md truncate">{brand.name}</h2>
              <p className="text-sm text-gray-500 truncate">{brand.subtitle}</p>
              <p className="text-xs text-gray-500 truncate">{ADDRESS}</p>
            </div>
          </div>

        </div>
      </header>
    </>
  );
};

// ===== Nearest booking block =====
const NearestBooking: React.FC<{ booking: Booking; onCancel: () => void }> = ({ booking, onCancel }) => {
  const brand = BRANDS[booking.brand];
  return (
    <div className="mx-4 mt-4 p-3 bg-white rounded shadow border border-gray-300">
      <h3 className="font-medium text-gray-900 mb-1 text-sm">Ваша ближайшая запись</h3>
      <p className="text-xs text-gray-600">{formatDateTime(booking.date, booking.time)}</p>
      <p className="text-xs text-gray-600 mt-0.5">{booking.carMake} {booking.carModel} · {booking.serviceName}</p>
      <p className="text-xs text-gray-600 mt-0.5">Сумма: <span className="font-medium">{booking.totalPrice} ₽</span></p>
      <button
        onClick={onCancel}
        className="mt-1 text-xs text-red-600 hover:text-red-700 font-medium"
      >
        Отменить / Перенести
      </button>
    </div>
  );
};

// ===== Step 1: Services (Bumpix-style compact list) =====
const StepServices: React.FC<{
  brand: BrandType;
  selected: string[];
  onToggle: (id: string) => void;
  onOpenTimeSelection: () => void;
  services: Service[];
  isBookingSectionVisible: boolean;
}> = ({ brand, selected, onToggle, onOpenTimeSelection, services, isBookingSectionVisible }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [plateEntering, setPlateEntering] = useState(false);

  // Плавное появление плашки итогов при возврате к каталогу услуг
  useEffect(() => {
    if (selected.length === 0 || isBookingSectionVisible) {
      setPlateEntering(false);
      return;
    }
    const raf = requestAnimationFrame(() => setPlateEntering(true));
    return () => cancelAnimationFrame(raf);
  }, [selected.length, isBookingSectionVisible]);
  const brandServices = useMemo(() => {
    return services
      .filter(s => s.brand === brand)
      .filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [services, brand, searchQuery]);
  const brandServicesTotal = useMemo(
    () => services.filter(s => s.brand === brand).length,
    [services, brand]
  );
  const totalPrice = useMemo(
    () => selected.reduce((sum, id) => sum + parsePrice(services.find(s => s.id === id)?.price || '0'), 0),
    [selected, services]
  );
  const totalDuration = useMemo(
    () => selected.reduce((sum, id) => sum + (services.find(s => s.id === id)?.duration || 0), 0),
    [selected, services]
  );

  return (
    <div className="relative w-full px-4 pb-28">
      {/* Sticky search header */}
      <div className="sticky top-0 z-20 bg-gray-100 pt-2 pb-3">
        <h2 className="text-sm font-medium text-gray-700 mb-2">Выберите услугу</h2>
        <div className="relative">
          <input
            type="text"
            placeholder="Поиск услуг..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-9 py-2 bg-white border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          {searchQuery.trim().length > 0 && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 text-sm"
              aria-label="Очистить поиск"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded shadow border border-gray-300 overflow-hidden">
        {brandServices.map((svc, idx) => {
          const checked = selected.includes(svc.id);
          return (
            <div key={svc.id}>
              <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50 border-b border-gray-200"
                onClick={() => onToggle(svc.id)}
              >
                <div className="flex-1">
                  <h3 className="font-medium text-gray-900 text-sm">{svc.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {formatDuration(svc.duration)} · {svc.price}
                  </p>
                </div>
                <div className="ml-3 flex-shrink-0">
                  <div
                    className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${checked
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-300 text-gray-500'
                      }`}
                  >
                    {checked && (
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15.5l-4.142-4.142a1 1 0 011.414-1.414L8.414 13.75l7.879-7.879a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Search reset helpers — shown while the search filter is active */}
        {searchQuery.trim().length > 0 && (
          brandServices.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-gray-500 mb-3">
                Ничего не найдено по запросу «{searchQuery}»
              </p>
              <button
                onClick={() => setSearchQuery('')}
                className="bg-[#F07427] hover:bg-[#d9631b] text-white font-medium px-6 py-2.5 rounded shadow text-sm"
              >
                Показать все услуги
              </button>
            </div>
          ) : (
            <div className="p-3">
              <button
                onClick={() => setSearchQuery('')}
                className="w-full py-2 rounded bg-gray-100 hover:bg-gray-200 border border-gray-300 text-gray-700 text-sm font-medium transition"
              >
                ✕ Показать все услуги (всего {brandServicesTotal})
              </button>
            </div>
          )
        )}

      </div>

      {/* Единая плавающая плашка итогов — только в области каталога услуг */}
      {selected.length > 0 && (
        <div
          className={`fixed bottom-0 left-0 right-0 z-30 max-w-md mx-auto bg-white/95 backdrop-blur border-t border-gray-200 py-3 px-4 shadow-lg flex flex-col items-center gap-1.5 transition-all duration-300 ${isBookingSectionVisible
            ? 'hidden'
            : plateEntering
              ? 'translate-y-0 opacity-100'
              : 'translate-y-full opacity-0 pointer-events-none'
            }`}
        >
          <p className="text-center text-sm text-gray-700">
            Выбрано услуг: {selected.length} ({formatDuration(totalDuration)}, {totalPrice} руб.)
          </p>
          <button
            onClick={onOpenTimeSelection}
            className="w-full bg-[#F07427] hover:bg-[#d9631b] text-white font-medium px-6 py-2.5 rounded shadow"
          >
            Выбрать время
          </button>
        </div>
      )}
    </div>
  );
};

// ===== Step 2: Date & time (classic calendar) =====
const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_NAMES_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DAY_NAMES_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function buildCalendarDays(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const startDay = (firstDay.getDay() + 6) % 7; // 0=Monday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDaysInMonth = new Date(year, month, 0).getDate();
  const days: Date[] = [];
  for (let i = startDay - 1; i >= 0; i--) {
    days.push(new Date(year, month - 1, prevDaysInMonth - (startDay - 1 - i)));
  }
  for (let i = 1; i <= daysInMonth; i++) {
    days.push(new Date(year, month, i));
  }
  const totalCells = 42;
  while (days.length < totalCells) {
    days.push(new Date(year, month + 1, days.length - startDay - daysInMonth + 1));
  }
  return days;
}

function isDatePast(d: Date, today: Date): boolean {
  const normalized = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return normalized < today;
}

function isDateFullyBooked(d: Date, bookings: Booking[], services: Service[], workingHours: string[] = []): boolean {
  const dateStr = toLocalDateString(d);
  const blockedMap = getBlockedHoursMap(bookings, dateStr, services);

  // День полностью забронирован, если КАЖДЫЙ рабочий час присутствует в blockedMap
  return workingHours.length > 0 && workingHours.every(hour => blockedMap.has(hour));
}

function isDateAvailable(d: Date, today: Date, bookings: Booking[], services: Service[], workingHours: string[] = [], daysOff: number[] = []): boolean {
  if (isDatePast(d, today)) return false;
  if (daysOff.includes(d.getDay())) return false;
  if (isDateFullyBooked(d, bookings, services, workingHours)) return false;

  const dateStr = toLocalDateString(d);
  const todayStr = toLocalDateString(today);

  // Если это сегодняшний день, проверяем, есть ли хотя бы один будущий свободный слот
  if (dateStr === todayStr) {
    const blockedMap = getBlockedHoursMap(bookings, dateStr, services);
    const realNow = new Date();
    const currentHour = realNow.getHours();
    const currentMinute = realNow.getMinutes();

    const hasFutureFreeSlot = workingHours.some(t => {
      if (blockedMap.has(t)) return false;
      const [h, m] = t.split(':').map(Number);
      return h > currentHour || (h === currentHour && m > currentMinute);
    });
    if (!hasFutureFreeSlot) return false;
  }

  return true;
}

function formatDateHeaderShort(d: Date): string {
  const dayOfWeek = DAY_NAMES_SHORT[(d.getDay() + 6) % 7];
  const monthName = MONTH_NAMES[d.getMonth()];
  return `${dayOfWeek}, ${d.getDate()} ${monthName} ${d.getFullYear()} г.`;
}

const StepDateTime: React.FC<{
  selectedDate: string;
  selectedTime: string | null;
  onDateChange: (d: string) => void;
  onTimeChange: (t: string | null) => void;
  blockedMap: Map<string, string>;
  bookings: Booking[];
  services: Service[];
  workingHours: string[];
  daysOff: number[];
}> = ({ selectedDate, selectedTime, onDateChange, onTimeChange, blockedMap, bookings, services, workingHours, daysOff }) => {
  const today = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = selectedDate ? parseLocalDate(selectedDate) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const calendarDays = useMemo(() => {
    const cm = calendarMonth;
    return buildCalendarDays(cm.getFullYear(), cm.getMonth());
  }, [calendarMonth]);

  const handlePrevMonth = () => {
    setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1));
  };

  const isCurrentMonth = (d: Date): boolean => d.getMonth() === calendarMonth.getMonth();

  return (
    <div className="px-4 pb-32">
      <h2 className="text-sm font-medium text-gray-700 mb-2">Выберите дату и время</h2>

      {/* Calendar header */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={handlePrevMonth} className="px-2 py-1 text-gray-600 font-medium hover:text-gray-900">
          «
        </button>
        <h3 className="text-sm font-medium text-gray-900">
          {MONTH_NAMES_NOM[calendarMonth.getMonth()]} {calendarMonth.getFullYear()}
        </h3>
        <button onClick={handleNextMonth} className="px-2 py-1 text-gray-600 font-medium hover:text-gray-900">
          »
        </button>
      </div>

      {/* Day names */}
      <div className="grid grid-cols-7 text-center text-xs text-gray-500 mb-1">
        {DAY_NAMES_SHORT.map(d => (
          <div key={d} className="font-medium">{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 text-center text-sm">
        {calendarDays.map((d, idx) => {
          const dateStr = toLocalDateString(d);
          const inMonth = isCurrentMonth(d);
          const isPast = isDatePast(d, today);
          const isBooked = isDateFullyBooked(d, bookings, services, workingHours);
          const isAvailable = isDateAvailable(d, today, bookings, services, workingHours, daysOff);
          const isSelected = selectedDate === dateStr;

          let textClass = 'text-gray-700';
          let bgClass = '';

          if (isSelected) {
            bgClass = 'bg-[#1E4E79] text-white';
            textClass = 'font-bold';
          } else if (isPast || isBooked) {
            if (!inMonth) {
              textClass = 'text-gray-300 opacity-60';
            } else {
              textClass = (isPast ? 'text-red-500' : 'text-gray-400');
            }
          } else if (inMonth) {
            textClass = 'text-green-700 font-semibold';
          }

          return (
            <button
              key={idx}
              onClick={() => {
                if (isAvailable && inMonth) {
                  onDateChange(dateStr);
                  onTimeChange('');
                }
              }}
              disabled={!isAvailable || !inMonth}
              className={`py-2 rounded transition relative cursor-pointer ${isSelected ? bgClass : (inMonth && isAvailable ? 'hover:bg-gray-100' : '')
                } ${textClass}`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {/* Time slots - shown only after clicking an available (green) date */}
      {selectedDate && (() => {
        const selD = parseLocalDate(selectedDate);
        const selAvailable = isDateAvailable(selD, today, bookings, services, workingHours, daysOff);
        if (!selAvailable) return null;
        let availableSlots = workingHours.filter(t => !blockedMap.has(t));
        const realNow = new Date();
        const todayDateStr = toLocalDateString(realNow);
        if (selectedDate === todayDateStr) {
          const currentHour = realNow.getHours();
          const currentMinute = realNow.getMinutes();
          availableSlots = availableSlots.filter(t => {
            const [h, m] = t.split(':').map(Number);
            return h > currentHour || (h === currentHour && m > currentMinute);
          });
        }
        return (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-[#1E4E79] text-center mb-2">Доступное время</h3>
            {availableSlots.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">На этот день нет свободного времени</p>
            ) : (
              <div className="flex flex-wrap gap-2 justify-center">
                {availableSlots.map((t) => {
                  const sel = selectedTime === t;
                  const cls = sel
                    ? 'bg-[#7E22CE] text-white border-[#7E22CE]'
                    : 'border border-gray-300 text-gray-700 hover:bg-gray-50';
                  return (
                    <button
                      key={t}
                      onClick={() => onTimeChange(selectedTime === t ? null : t)}
                      className={`px-3 py-1.5 rounded border text-sm transition ${cls}`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
};

// ===== Step 3: Contact form =====
const StepContact: React.FC<{
  formData: Partial<Booking>;
  onChange: (field: keyof Booking, value: string) => void;
  selectedDate: string;
  selectedTime: string | null;
  onBook: () => void;
  canBook: boolean;
  validationError: string | null;
  innerRef: React.RefObject<HTMLDivElement | null>;
}> = ({ formData, onChange, selectedDate, selectedTime, onBook, canBook, validationError, innerRef }) => {
  const inputCls = "w-full pl-10 pr-3 py-2 bg-white border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500";

  return (
    <div ref={innerRef} className="px-4 pb-24">
      <div className="bg-white rounded shadow border border-gray-300 p-4 space-y-3">
        {selectedDate && selectedTime && (
          <p className="text-sm font-medium text-[#7E22CE]">
            {formatDateHeaderShort(parseLocalDate(selectedDate))} {selectedTime}
          </p>
        )}

        <p className="text-sm text-gray-500 mb-2">Укажите ваши данные и автомобиль</p>

        <div className="relative">
          <input type="text" placeholder="Ваше имя" value={formData.name || ''}
            onChange={e => onChange('name', e.target.value.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s-]/g, ''))} className={inputCls} />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lg pointer-events-none">👤</span>
        </div>

        <div className="relative">
          <input type="tel" placeholder="+7..." value={formData.phone || ''}
            onChange={e => onChange('phone', e.target.value)} className={inputCls} />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lg pointer-events-none">📞</span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="relative">
            <input type="text" placeholder="Марка (напр. Kia)" value={formData.carMake || ''}
              onChange={e => onChange('carMake', e.target.value)} className={inputCls} />
            <Car className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" />
          </div>
          <div className="relative">
            <input type="text" placeholder="Модель (напр. Rio)" value={formData.carModel || ''}
              onChange={e => onChange('carModel', e.target.value)} className={inputCls} />
            <Car className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" />
          </div>
        </div>

        <div className="relative">
          <textarea
            placeholder="Комментарий к заказу (необязательно)"
            value={formData.comment || ''}
            onChange={e => onChange('comment', e.target.value)}
            rows={2}
            className="w-full pl-10 pr-3 py-2 bg-white border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none"
          />
          <span className="absolute left-3 top-3 text-lg pointer-events-none">💬</span>
        </div>

        {validationError && (
          <div className="bg-red-100 text-red-600 text-xs p-2 rounded">
            Ошибка! Не заполнено поле {validationError}
          </div>
        )}

        <div className="flex justify-center pt-1">
          <button
            onClick={onBook}
            disabled={!canBook}
            className={`px-8 py-2.5 rounded font-medium text-sm transition ${canBook
              ? 'bg-[#7E22CE] hover:bg-purple-800 text-white'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
          >
            Записаться
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== Confirmation (modal) =====
const Confirmation: React.FC<{ booking: Booking; onNew: () => void; onClose?: () => void }> = ({ booking, onNew, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-sm bg-white rounded overflow-hidden shadow-xl">
        <div className="bg-purple-800 text-white py-4 px-4 text-center">
          <h2 className="text-lg font-bold">Запись подтверждена</h2>
        </div>
        <p className="text-sm text-gray-600 text-center py-2 px-4">
          Ждём вас в автосервисе в назначенное время!
        </p>
        <div className="mx-4 mb-4 rounded border border-gray-200 bg-gray-50 px-4 py-3 text-center">
          <p className="font-semibold text-gray-800">{formatDateTime(booking.date, booking.time)}</p>
          <div className="mt-1 space-y-0.5">
            {booking.serviceName.split('; ').filter(Boolean).map((s, i) => (
              <p key={i} className="text-sm text-gray-600">{s}</p>
            ))}
          </div>
          <p className="text-lg font-bold text-gray-900 mt-2">{booking.totalPrice} ₽</p>
        </div>
        <div className="flex justify-center pb-4">
          <button
            onClick={onNew}
            className="px-6 py-2 rounded bg-orange-500 text-white font-bold text-sm transition hover:opacity-90"
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
};
// ===== PWA Install Guide Modal =====
const InstallGuideModal: React.FC<{
  onClose: () => void;
  deferredPrompt: any;
  onDirectInstall: () => void;
}> = ({ onClose, deferredPrompt, onDirectInstall }) => {
  const [activeTab, setActiveTab] = useState<'android' | 'ios'>(() => {
    if (typeof navigator === 'undefined') return 'android';
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      return 'ios';
    }
    return 'android';
  });
  const [copied, setCopied] = useState(false);

  // Detect current browser on Android to highlight the relevant card.
  const browser = useMemo<'samsung' | 'yandex' | 'opera' | 'firefox' | 'chrome'>(() => {
    if (typeof navigator === 'undefined') return 'chrome';
    const ua = navigator.userAgent || '';
    if (/SamsungBrowser/i.test(ua)) return 'samsung';
    if (/YaBrowser/i.test(ua)) return 'yandex';
    if (/OPR\/|Opera/i.test(ua)) return 'opera';
    if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
    return 'chrome';
  }, []);

  const handleCopyLink = async () => {
    const url = window.location.origin + window.location.pathname + '?install=qr';
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  // Android browser cards, ready browser highlighted first.
  const androidCards = [
    {
      key: 'samsung' as const,
      title: 'Samsung Internet',
      icon: '🌐',
      text: (
        <>
          В полном браузере нажмите меню <strong>≡ (три полоски в правом нижнем углу)</strong> →{' '}
          <strong>«Добавить страницу в»</strong> → <strong>«Главный экран»</strong> (или значок{' '}
          <strong>«+»</strong> в адресной строке).
        </>
      ),
    },
    {
      key: 'yandex' as const,
      title: 'Яндекс Браузер',
      icon: '🟡',
      text: (
        <>
          Нажмите меню <strong>⋮ (три точки внизу справа)</strong> → выберите{' '}
          <strong>«Добавить ярлык на телефон»</strong> или <strong>«Установить приложение»</strong>.
        </>
      ),
    },
    {
      key: 'firefox' as const,
      title: 'Mozilla Firefox',
      icon: '🦊',
      text: (
        <>
          Нажмите меню <strong>⋮ (три точки)</strong> → выберите пункт <strong>«Установить»</strong> (или
          «Добавить на домашний экран»).
        </>
      ),
    },
    {
      key: 'chrome' as const,
      title: 'Google Chrome / Opera / Edge / Mi / Huawei Browser',
      icon: '🧭',
      text: (
        <>
          Нажмите кнопку <strong>«Установить приложение»</strong> на странице ИЛИ нажмите меню{' '}
          <strong>⋮</strong> в углу браузера → <strong>«Установить приложение»</strong> (или «Добавить на
          главный экран»).
        </>
      ),
    },
  ].sort((a, b) => (a.key === browser ? -1 : b.key === browser ? 1 : 0));

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-sm bg-white rounded-lg overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        <div className="bg-purple-800 text-white py-3 px-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-base">
            <span>📱</span>
            <span>Установка приложения</span>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white text-xl leading-none p-1"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        {/* OS Selector Tabs */}
        <div className="flex border-b border-gray-200 bg-gray-50 text-xs font-medium">
          <button
            onClick={() => setActiveTab('android')}
            className={`flex-1 py-2.5 text-center border-b-2 transition ${activeTab === 'android'
              ? 'border-purple-600 text-purple-700 font-bold bg-white'
              : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
          >
            📱 Android (Все браузеры)
          </button>
          <button
            onClick={() => setActiveTab('ios')}
            className={`flex-1 py-2.5 text-center border-b-2 transition ${activeTab === 'ios'
              ? 'border-purple-600 text-purple-700 font-bold bg-white'
              : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
          >
            🍏 iPhone / iPad (iOS)
          </button>
        </div>

        <div className="p-4 text-sm text-gray-700 overflow-y-auto space-y-3">
          {activeTab === 'android' && (
            <>
              {/* BLOCK A: direct install available */}
              {deferredPrompt && (
                <div className="rounded-lg border-2 border-green-400 bg-green-50 p-3 space-y-2">
                  <button
                    onClick={onDirectInstall}
                    className="w-full bg-green-600 hover:bg-green-700 text-white py-3 px-4 rounded font-bold text-base shadow transition"
                  >
                    📲 Установить приложение в 1 клик
                  </button>
                  <p className="text-xs text-green-800 text-center">
                    Нажмите кнопку выше и подтвердите установку в появившемся системном окне.
                  </p>
                </div>
              )}

              {/* BLOCK B: opened inside a messenger / custom tab */}
              {!deferredPrompt && (
                <div className="rounded-lg border-2 border-orange-400 bg-orange-50 p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-bold text-orange-900 text-sm">
                      ⚠️ Шаг 1. Перейдите из мессенджера в браузер
                    </p>
                    <span className="text-2xl leading-none text-orange-600">↗</span>
                  </div>
                  <p className="text-xs text-orange-900 whitespace-pre-line">
                    Если вы открыли ссылку из Telegram, WhatsApp или VK (вверху слева есть крестик{' '}
                    <strong>✕</strong>):{'\n'}
                    Нажмите на <strong>⋮ (три точки в самом правом верхнем углу экрана ↗)</strong> и выберите{' '}
                    <strong>„Открыть в браузере“</strong> (или „Открыть в интернет-браузере“).
                  </p>
                  <button
                    onClick={handleCopyLink}
                    className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 px-4 rounded font-semibold text-sm shadow transition"
                  >
                    {copied ? '✅ Ссылка скопирована! Вставьте её в браузер' : '📋 Или скопировать ссылку для браузера'}
                  </button>
                </div>
              )}

              {/* BLOCK C: universal instructions for all Android browsers */}
              <div className="space-y-2">
                <p className="font-bold text-gray-800 text-sm">Шаг 2. Как установить в вашем браузере:</p>
                {androidCards.map((card) => {
                  const isActive = card.key === browser;
                  return (
                    <div
                      key={card.key}
                      className={`rounded-lg border p-2.5 transition ${isActive
                        ? 'border-purple-500 bg-purple-50 shadow-sm'
                        : 'border-gray-200 bg-white'
                        }`}
                    >
                      <p className={`text-xs font-bold mb-1 ${isActive ? 'text-purple-800' : 'text-gray-700'}`}>
                        {card.icon} {card.title}
                        {isActive && <span className="ml-1 text-purple-600">← ваш браузер</span>}
                      </p>
                      <p className="text-xs text-gray-600">{card.text}</p>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {activeTab === 'ios' && (
            <>
              <div className="rounded-lg border-2 border-orange-400 bg-orange-50 p-3 space-y-1.5">
                <p className="font-bold text-orange-900 text-sm">Шаг 1. Откройте ссылку в Safari</p>
                <p className="text-xs text-orange-900">
                  Если ссылка открыта внутри Telegram или WhatsApp — нажмите значок <strong>компаса 🧭</strong>{' '}
                  (или <strong>⋯</strong> в правом углу) и выберите <strong>«Открыть в Safari»</strong>.
                </p>
              </div>

              <div className="space-y-2">
                <p className="font-bold text-gray-800 text-sm">Шаг 2. Как установить в Safari:</p>
                <div className="flex items-start gap-2.5 bg-purple-50 p-2.5 rounded border border-purple-100">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-xs">
                    1
                  </span>
                  <span className="text-xs">
                    В нижней панели <strong>Safari</strong> нажмите кнопку <strong>«Поделиться»</strong>{' '}
                    (квадрат со стрелкой вверх <strong>[↑]</strong>).
                  </span>
                </div>
                <div className="flex items-start gap-2.5 bg-purple-50 p-2.5 rounded border border-purple-100">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-xs">
                    2
                  </span>
                  <span className="text-xs">
                    Прокрутите список вниз и выберите <strong>«На экран Домой»</strong> (значок <strong>➕</strong>).
                  </span>
                </div>
                <div className="flex items-start gap-2.5 bg-purple-50 p-2.5 rounded border border-purple-100">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-xs">
                    3
                  </span>
                  <span className="text-xs">
                    Нажмите <strong>«Добавить»</strong> в правом верхнем углу.
                  </span>
                </div>
              </div>

              <button
                onClick={handleCopyLink}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white py-2.5 px-4 rounded font-semibold text-sm shadow transition"
              >
                {copied ? '✅ Ссылка скопирована! Вставьте её в Safari' : '📋 Скопировать ссылку для Safari'}
              </button>
            </>
          )}
        </div>

        <div className="p-3 bg-gray-50 border-t border-gray-200">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 rounded bg-purple-600 hover:bg-purple-700 text-white font-medium text-sm transition"
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== Status badge =====
function StatusBadge({ status }: { status: BookingStatus }) {
  const labels: Record<BookingStatus, string> = {
    pending: 'Ожидается',
    in_progress: 'В работе',
    ready: 'Готово',
  };
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
      {labels[status]}
    </span>
  );
}

// ===== Manual add modal (wizard) =====
const ManualAddModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (booking: Booking) => void;
  prefillTime?: string;
  prefillBrand?: BrandType;
  prefillDate?: string;
  clients: Client[];
  services: Service[];
  onSaveClient: (client: Client) => void;
}> = ({ isOpen, onClose, onSave, prefillTime = '', prefillBrand = 'bvk', prefillDate, clients, services, onSaveClient }) => {
  const [step, setStep] = useState<'client' | 'services' | 'new_client'>('client');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);

  // New client form
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCarMake, setNewCarMake] = useState('');
  const [newCarModel, setNewCarModel] = useState('');

  // Поиск по услугам на шаге выбора услуг
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      setStep('client');
      setSelectedClient(null);
      setSelectedServiceIds([]);
      setNewName('');
      setNewPhone('');
      setNewCarMake('');
      setNewCarModel('');
      setSearchQuery('');
    }
  }, [isOpen]);

  const brandServices = useMemo(() => services.filter(s => s.brand === prefillBrand), [services, prefillBrand]);

  const filteredServices = useMemo(
    () => brandServices.filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [brandServices, searchQuery]
  );

  const totalPrice = useMemo(
    () => selectedServiceIds.reduce((sum, id) => sum + parsePrice(services.find(s => s.id === id)?.price || '0'), 0),
    [selectedServiceIds, services]
  );

  const toggleService = (id: string) => {
    setSelectedServiceIds(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]);
  };

  const handleCreateClient = () => {
    if (!newName || !newPhone) return;
    const client: Client = {
      id: Date.now().toString(),
      name: newName,
      phone: newPhone,
      carMake: newCarMake || undefined,
      carModel: newCarModel || undefined,
    };
    onSaveClient(client);
    setSelectedClient(client);
    setStep('services');
  };

  const handleSave = () => {
    if (!selectedClient || !prefillTime) return;
    const selectedServiceObjs = selectedServiceIds
      .map(id => services.find(s => s.id === id))
      .filter(Boolean) as Service[];
    const serviceName = selectedServiceObjs.map(s => s.name).join('; ') || 'Вручную (звонок)';
    const dateStr = prefillDate || toLocalDateString(new Date());
    const durationMin = selectedServiceObjs.reduce((sum, s) => sum + (s.duration || 0), 0) || 60;
    const startMin = timeToMinutes(prefillTime);
    const newBooking: Booking = {
      id: Date.now().toString(),
      brand: prefillBrand,
      services: selectedServiceIds,
      serviceName,
      totalPrice,
      carMake: selectedClient.carMake || '',
      carModel: selectedClient.carModel || '',
      date: dateStr,
      time: prefillTime,
      endTime: minutesToTime(startMin + durationMin),
      duration: durationMin,
      name: selectedClient.name,
      phone: selectedClient.phone,
      comment: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      type: 'client',
    };
    onSave(newBooking);
  };

  if (!isOpen) return null;

  const inputCls = "w-full px-3 py-2 bg-white border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 mb-2";
  const clientTitle = selectedClient ? (selectedClient.name || selectedClient.phone) : '';

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-sm flex flex-col shadow-xl rounded max-h-[90vh]">
        <div className="bg-purple-800 text-white py-3 px-4 flex items-center justify-between">
          <span className="font-medium text-sm">
            {step === 'client' && 'Выберите клиента'}
            {step === 'new_client' && 'Новый клиент'}
            {step === 'services' && clientTitle}
          </span>
          <button onClick={() => { setSearchQuery(''); onClose(); }} className="text-white/80 hover:text-white text-lg leading-none">×</button>
        </div>

        {step === 'client' && (
          <div className="flex-1 overflow-y-auto p-4">
            <button
              onClick={() => setStep('new_client')}
              className="w-full py-2 mb-3 rounded bg-purple-700 text-white font-medium text-sm hover:opacity-90 transition"
            >
              + Новый клиент
            </button>
            <div className="border border-gray-200 rounded overflow-hidden">
              {clients.length === 0 && (
                <div className="p-6 text-center text-gray-500 text-sm">Нет клиентов</div>
              )}
              {clients.map(c => (
                <button
                  key={c.id}
                  onClick={() => { setSelectedClient(c); setStep('services'); }}
                  className="w-full border-b border-gray-200 p-3 text-left hover:bg-gray-50 last:border-b-0"
                >
                  <p className="font-medium text-gray-900 text-sm">{c.name || 'Без имени'}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {c.phone}
                    {(c.carMake || c.carModel) && ` · ${c.carMake || ''} ${c.carModel || ''}`.trimEnd()}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'new_client' && (
          <div className="flex-1 overflow-y-auto p-4">
            <input type="text" placeholder="Имя" value={newName} onChange={e => setNewName(e.target.value)} className={inputCls} />
            <input type="tel" placeholder="Телефон" value={newPhone} onChange={e => setNewPhone(e.target.value)} className={inputCls} />
            <input type="text" placeholder="Марка авто" value={newCarMake} onChange={e => setNewCarMake(e.target.value)} className={inputCls} />
            <input type="text" placeholder="Модель авто" value={newCarModel} onChange={e => setNewCarModel(e.target.value)} className={inputCls} />
          </div>
        )}

        {step === 'services' && (
          <div className="flex-1 overflow-y-auto">
            {/* Прилипающий блок поиска услуг */}
            <div className="sticky top-0 z-10 bg-white p-4 border-b border-gray-100">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <input
                  type="text"
                  placeholder="Поиск услуг..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-10 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 transition-all text-[15px]"
                />
                {searchQuery !== '' && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 text-base"
                    aria-label="Очистить поиск"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {filteredServices.map(svc => {
              const checked = selectedServiceIds.includes(svc.id);
              return (
                <div
                  key={svc.id}
                  onClick={() => toggleService(svc.id)}
                  className="flex items-center justify-between p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50"
                >
                  <div className="flex-1">
                    <p className="font-medium text-gray-900 text-sm">{svc.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{formatDuration(svc.duration)} · {svc.price}</p>
                  </div>
                  <div className={`ml-3 w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${checked ? 'bg-purple-600 text-white' : 'bg-gray-300 text-gray-500'}`}>
                    {checked && (
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15.5l-4.142-4.142a1 1 0 011.414-1.414L8.414 13.75l7.879-7.879a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredServices.length === 0 && (
              <div className="text-gray-500 py-8 text-center">Услуги не найдены</div>
            )}
          </div>
        )}

        <div className="p-3 border-t border-gray-300 shrink-0">
          {step === 'client' && (
            <button onClick={() => { setSearchQuery(''); onClose(); }} className="w-full py-2.5 rounded bg-gray-100 text-gray-700 font-medium text-sm hover:bg-gray-200 transition">
              Отмена
            </button>
          )}
          {step === 'new_client' && (
            <div className="flex gap-2">
              <button onClick={() => { setSearchQuery(''); setStep('client'); }} className="flex-1 py-2.5 rounded bg-gray-100 text-gray-700 font-medium text-sm hover:bg-gray-200 transition">
                Назад
              </button>
              <button
                onClick={handleCreateClient}
                disabled={!newName || !newPhone}
                className={`flex-1 py-2.5 rounded font-medium text-sm transition ${(!newName || !newPhone) ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-purple-700 text-white hover:opacity-90'}`}
              >
                Далее
              </button>
            </div>
          )}
          {step === 'services' && (
            <>
              <p className="text-center text-sm text-gray-700 mb-2">
                Выбрано: {selectedServiceIds.length}. Сумма: {totalPrice} руб.
              </p>
              <div className="flex gap-2">
                <button onClick={() => { setSearchQuery(''); setStep('client'); }} className="flex-1 py-2.5 rounded bg-gray-100 text-gray-700 font-medium text-sm hover:bg-gray-200 transition">
                  Назад
                </button>
                <button onClick={handleSave} className="flex-1 py-2.5 rounded bg-purple-700 text-white font-medium text-sm hover:opacity-90 transition">
                  СОХРАНИТЬ
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ===== Booking Details Modal (полноценная форма редактирования, как в Bumpix) =====
const BookingDetailsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  booking: Booking;
  onUpdate: (booking: Booking) => void;
  onDelete: (id: string) => void;
  services: Service[];
}> = ({ isOpen, onClose, booking, onUpdate, onDelete, services }) => {
  const isPersonal = booking.type === 'personal';

  const [date, setDate] = useState(booking.date);
  const [time, setTime] = useState(booking.time);
  const [endTime, setEndTime] = useState(getBookingEndTime(booking, services));
  const [name, setName] = useState(booking.name);
  const [phone, setPhone] = useState(booking.phone);
  const [carMake, setCarMake] = useState(booking.carMake);
  const [carModel, setCarModel] = useState(booking.carModel);
  const [serviceName, setServiceName] = useState(booking.serviceName);
  const [priceStr, setPriceStr] = useState(String(booking.totalPrice));
  const [status, setStatus] = useState<BookingStatus>(booking.status);
  const [comment, setComment] = useState(booking.comment);
  const [color, setColor] = useState(getBookingColor(booking));

  useEffect(() => {
    setDate(booking.date);
    setTime(booking.time);
    setEndTime(getBookingEndTime(booking, services));
    setName(booking.name);
    setPhone(booking.phone);
    setCarMake(booking.carMake);
    setCarModel(booking.carModel);
    setServiceName(booking.serviceName);
    setPriceStr(String(booking.totalPrice));
    setStatus(booking.status);
    setComment(booking.comment);
    setColor(getBookingColor(booking));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.id]);

  const WEEK_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  if (!isOpen) return null;

  const d = parseLocalDate(date);
  const dateLabel = `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()} г. (${WEEK_SHORT[d.getDay()]})`;

  const phoneClean = phone.replace(/\D/g, '');

  const PALETTE = ['#16a34a', '#ea580c', '#2563eb', '#dc2626', '#7c3aed', '#0891b2'];

  const inputCls = "w-full px-3 py-2 bg-white border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500";

  const handleSave = () => {
    // Конец должен быть строго позже начала: иначе нормализуем интервал (минимум 1 минута),
    // чтобы сохранённые endTime/duration не расходились с высотой карточки на сетке.
    const startMin = timeToMinutes(time);
    const rawEnd = timeToMinutes(endTime);
    const duration = Math.max(1, rawEnd - startMin);
    const normalizedEndTime = rawEnd > startMin ? endTime : minutesToTime(startMin + 1);
    onUpdate({
      ...booking,
      date,
      time,
      endTime: normalizedEndTime,
      duration,
      name: isPersonal ? booking.name : name,
      phone: isPersonal ? '' : phone,
      carMake: isPersonal ? '' : carMake,
      carModel: isPersonal ? '' : carModel,
      serviceName,
      totalPrice: isPersonal ? 0 : (parseInt(priceStr, 10) || 0),
      status,
      comment,
      color,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-gray-100 z-50 flex flex-col">
      {/* Шапка: назад — заголовок — корзина */}
      <div className="bg-purple-800 text-white py-3 px-4 flex justify-between items-center">
        <button onClick={onClose} className="text-xl leading-none w-8 text-left" aria-label="Назад">
          ←
        </button>
        <h3 className="font-medium">{isPersonal ? 'Событие' : 'Запись клиента'}</h3>
        <button
          onClick={() => { onDelete(booking.id); onClose(); }}
          className="text-lg leading-none w-8 text-right hover:text-red-200"
          aria-label="Удалить"
        >
          🗑️
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Дата и время */}
        <div className="bg-white p-4 border-b border-gray-200">
          <p className="text-gray-900 font-medium mb-3">{dateLabel}</p>
          <label className="block text-xs text-gray-500 mb-1">Дата</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className={`${inputCls} mb-3`}
          />
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">с</label>
              <input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value)}
                className={inputCls}
              />
            </div>
            <span className="text-gray-400 mt-5">—</span>
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">до</label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>
        </div>

        {isPersonal ? (
          <>
            {/* Личное событие: название + комментарий */}
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Название события</label>
              <input
                type="text"
                value={serviceName}
                onChange={e => setServiceName(e.target.value)}
                className={inputCls}
                placeholder="Название события"
              />
            </div>
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Комментарий</label>
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                className={`${inputCls} resize-none`}
                rows={3}
                placeholder="Комментарий"
              />
            </div>
          </>
        ) : (
          <>
            {/* Клиент и контакты */}
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Имя клиента</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className={`${inputCls} mb-3`}
                placeholder="Имя клиента"
              />
              <label className="block text-xs text-gray-500 mb-1">Телефон</label>
              <div className="flex gap-2">
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  className={inputCls}
                  placeholder="+7..."
                />
                {phoneClean && (
                  <a
                    href={`tel:${phoneClean}`}
                    className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition flex-shrink-0"
                    aria-label="Позвонить"
                  >
                    📞
                  </a>
                )}
              </div>
            </div>

            {/* Автомобиль */}
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Автомобиль (марка / модель)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={carMake}
                  onChange={e => setCarMake(e.target.value)}
                  className={inputCls}
                  placeholder="Марка"
                />
                <input
                  type="text"
                  value={carModel}
                  onChange={e => setCarModel(e.target.value)}
                  className={inputCls}
                  placeholder="Модель"
                />
              </div>
            </div>

            {/* Услуги */}
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Услуги</label>
              <textarea
                value={serviceName}
                onChange={e => setServiceName(e.target.value)}
                className={`${inputCls} resize-none`}
                rows={3}
                placeholder="Список услуг"
              />
            </div>

            {/* Доход и статус */}
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Доход / Сумма (₽)</label>
              <input
                type="number"
                value={priceStr}
                onChange={e => setPriceStr(e.target.value)}
                className={`${inputCls} mb-3`}
                placeholder="0"
              />
              <label className="block text-xs text-gray-500 mb-1">Статус</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value as BookingStatus)}
                className={inputCls}
              >
                <option value="pending">Ожидается</option>
                <option value="in_progress">В работе</option>
                <option value="ready">Готово</option>
              </select>
            </div>

            {/* Комментарий */}
            <div className="bg-white p-4 border-b border-gray-200">
              <label className="block text-xs text-gray-500 mb-1">Комментарий</label>
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                className={`${inputCls} resize-none`}
                rows={3}
                placeholder="Комментарий"
              />
            </div>
          </>
        )}

        {/* Цвет карточки */}
        <div className="bg-white p-4 border-b border-gray-200">
          <label className="block text-xs text-gray-500 mb-2">Цвет в журнале</label>
          <div className="flex gap-3">
            {PALETTE.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-gray-400' : ''}`}
                style={{ backgroundColor: c }}
                aria-label={`Цвет ${c}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Плавающая кнопка сохранения */}
      <button
        onClick={handleSave}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-purple-700 text-white text-2xl shadow-lg hover:opacity-90 transition flex items-center justify-center"
        aria-label="Сохранить"
      >
        ✓
      </button>
    </div>
  );
};

// ===== Service Modal (fullscreen) =====
interface ServiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (service: Service) => Promise<void> | void;
  onDelete: (id: string) => void;
  service: Service | null;
  services: Service[];
}

const ServiceModal: React.FC<ServiceModalProps> = ({ isOpen, onClose, onSave, onDelete, service, services }) => {
  const [name, setName] = useState('');
  const [durationStr, setDurationStr] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [priceFrom, setPriceFrom] = useState(false);
  const [brand, setBrand] = useState<BrandType>('bvk');

  useEffect(() => {
    if (service) {
      setName(service.name);
      setDurationStr(String(service.duration));
      setPriceInput(parsePrice(service.price).toString());
      // «от 1500 ₽» → чекбокс включён, в поле только цифры
      setPriceFrom(/^\s*от(\s|$)/i.test(service.price || ''));
      setBrand(service.brand);
    } else {
      setName('');
      setDurationStr('60');
      setPriceInput('');
      setPriceFrom(false);
      setBrand('bvk');
    }
  }, [service]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!name || !priceInput) return;
    const duration = parseInt(durationStr) || 0;
    const priceStr = String(parseInt(priceInput) || 0);
    const newService: Service = {
      id: service ? service.id : `svc-${Date.now()}`,
      name,
      price: priceFrom ? `от ${priceStr} ₽` : `${priceStr} ₽`,
      duration,
      brand,
    };
    try {
      // Ждём реального ответа Supabase: при ошибке форма остаётся открытой
      await onSave(newService);
      onClose();
    } catch {
      // Ошибка уже залогирована вызывающей стороной
    }
  };

  const handleDelete = () => {
    if (service && window.confirm('Удалить услугу?')) {
      onDelete(service.id);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-sm flex flex-col shadow-xl rounded max-h-[90vh]">
        <div className="bg-red-900 text-white py-3 px-4 text-center font-bold text-lg">
          Услуга
        </div>
        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Название услуги</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              placeholder="Введите название"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Продолжительность (минут)</label>
            <input
              type="number"
              value={durationStr}
              onChange={e => setDurationStr(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Цена (₽)</label>
            <input
              type="number"
              value={priceInput}
              onChange={e => setPriceInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              placeholder="Введите цену"
            />
            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={priceFrom}
                onChange={e => setPriceFrom(e.target.checked)}
                className="w-4 h-4 accent-purple-700"
              />
              <span className="text-xs text-gray-700">Цена «от» (например: от 1500 ₽)</span>
            </label>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Бренд</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="brand"
                  checked={brand === 'bvk'}
                  onChange={() => setBrand('bvk')}
                />
                <span className="text-sm">BVK Авто</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="brand"
                  checked={brand === 'gbo'}
                  onChange={() => setBrand('gbo')}
                />
                <span className="text-sm">ГБО</span>
              </label>
            </div>
          </div>
        </div>
        <div className="p-3 border-t border-gray-300 flex gap-2 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded bg-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-300 transition"
          >
            ОТМЕНА
          </button>
          {service && (
            <button
              onClick={handleDelete}
              className="flex-1 py-2.5 rounded bg-red-100 text-red-700 font-medium text-sm hover:bg-red-200 transition border border-red-300"
            >
              Удалить
            </button>
          )}
          <button
            onClick={handleSave}
            className="flex-1 py-2.5 rounded bg-purple-700 text-white font-medium text-sm hover:opacity-90 transition"
          >
            СОХРАНИТЬ
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== Client Modal =====
const ClientModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (client: Client) => void;
  onDelete: (id: string) => void;
  client: Client | null;
}> = ({ isOpen, onClose, onSave, onDelete, client }) => {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [carMake, setCarMake] = useState('');
  const [carModel, setCarModel] = useState('');

  useEffect(() => {
    if (client) {
      setName(client.name || '');
      setPhone(client.phone || '');
      setCarMake(client.carMake || '');
      setCarModel(client.carModel || '');
    } else {
      setName('');
      setPhone('');
      setCarMake('');
      setCarModel('');
    }
  }, [client]);

  if (!isOpen) return null;

  const handleSave = () => {
    if (!name || !phone) return;
    const newClient: Client = {
      id: client ? client.id : Date.now().toString(),
      name,
      phone,
      carMake: carMake || undefined,
      carModel: carModel || undefined,
    };
    onSave(newClient);
    onClose();
  };

  const handleDelete = () => {
    if (client) {
      onDelete(client.id);
      onClose();
    }
  };

  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded text-sm";

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-sm flex flex-col shadow-xl rounded max-h-[90vh]">
        <div className="bg-purple-800 text-white py-3 px-4 text-center font-bold text-lg">
          {client ? 'Редактировать клиента' : 'Новый клиент'}
        </div>
        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Имя</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="Введите имя" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Телефон</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} placeholder="+7..." />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Марка авто</label>
            <input type="text" value={carMake} onChange={e => setCarMake(e.target.value)} className={inputCls} placeholder="Kia" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Модель авто</label>
            <input type="text" value={carModel} onChange={e => setCarModel(e.target.value)} className={inputCls} placeholder="Rio" />
          </div>
        </div>
        <div className="p-3 border-t border-gray-300 flex gap-2 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded bg-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-300 transition"
          >
            ОТМЕНА
          </button>
          {client && (
            <button
              onClick={handleDelete}
              className="flex-1 py-2.5 rounded bg-red-100 text-red-700 font-medium text-sm hover:bg-red-200 transition border border-red-300"
            >
              Удалить
            </button>
          )}
          <button
            onClick={handleSave}
            className="flex-1 py-2.5 rounded bg-purple-700 text-white font-medium text-sm hover:opacity-90 transition"
          >
            СОХРАНИТЬ
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== Action Bottom Sheet =====
const ActionBottomSheet: React.FC<{
  isOpen: boolean;
  time: string;
  dateLabel?: string;
  existingBooking?: Booking | null;
  onClose: () => void;
  onEditExisting?: () => void;
  onBookClient: () => void;
  onCreatePersonal: () => void;
}> = ({ isOpen, time, dateLabel = '', existingBooking, onClose, onEditExisting, onBookClient, onCreatePersonal }) => {
  if (!isOpen) return null;

  const existingLabel = existingBooking
    ? (existingBooking.type === 'personal'
      ? (existingBooking.serviceName || existingBooking.name)
      : (existingBooking.name || existingBooking.serviceName))
    : '';

  return (
    <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose}>
      <div
        className="absolute bottom-0 w-full bg-white rounded-t-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-purple-800 text-white p-4 font-medium">Выберите действие</div>

        {/* Редактирование уже существующей записи в этом слоте */}
        {existingBooking && (
          <button
            onClick={onEditExisting}
            className="w-full border-b border-gray-200 p-4 text-left bg-purple-50 hover:bg-purple-100"
          >
            <span className="block text-purple-800 font-medium truncate">✏️ Открыть / изменить: {existingLabel}</span>
            {dateLabel && <span className="block text-xs text-gray-500 mt-0.5">{dateLabel}</span>}
          </button>
        )}

        <button
          onClick={onBookClient}
          className="w-full border-b border-gray-200 p-4 text-left hover:bg-gray-50"
        >
          <span className="block text-gray-800 font-medium">➕ Записать клиента на {time}</span>
          {dateLabel && <span className="block text-xs text-gray-500 mt-0.5">{dateLabel}</span>}
        </button>
        <button
          onClick={onCreatePersonal}
          className="w-full border-b border-gray-200 p-4 text-left hover:bg-gray-50"
        >
          <span className="block text-gray-800 font-medium">➕ Создать личное событие на {time}</span>
          {dateLabel && <span className="block text-xs text-gray-500 mt-0.5">{dateLabel}</span>}
        </button>
        <button
          onClick={onClose}
          className="w-full p-4 text-center text-purple-700 font-medium hover:bg-gray-50"
        >
          ОТМЕНА
        </button>
      </div>
    </div>
  );
};

// ===== Personal Event Modal =====
const PersonalEventModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (booking: Booking) => void;
  prefillTime?: string;
  prefillBrand?: BrandType;
  prefillDate?: string;
}> = ({ isOpen, onClose, onSave, prefillTime = '', prefillBrand = 'bvk', prefillDate }) => {
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState(prefillTime);
  const [endTime, setEndTime] = useState('');
  const [comment, setComment] = useState('');
  const [color, setColor] = useState('#ea580c');

  const EVENT_COLORS = ['#16a34a', '#ea580c', '#2563eb', '#dc2626', '#7c3aed', '#0891b2'];

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setStartTime(prefillTime);
      setEndTime('');
      setComment('');
      setColor('#ea580c');
    }
  }, [isOpen, prefillTime]);

  const handleSave = () => {
    if (!title || !startTime) return;
    const dateStr = prefillDate || toLocalDateString(new Date());
    const startMin = timeToMinutes(startTime);
    // Если время окончания не задано — событие длится 1 час.
    const endMin = endTime && timeToMinutes(endTime) > startMin
      ? timeToMinutes(endTime)
      : startMin + 60;
    const newBooking: Booking = {
      id: Date.now().toString(),
      brand: prefillBrand,
      services: [],
      serviceName: title,
      totalPrice: 0,
      carMake: '',
      carModel: '',
      date: dateStr,
      time: startTime,
      endTime: minutesToTime(endMin),
      duration: endMin - startMin,
      name: 'Личное событие',
      phone: '',
      comment,
      color,
      status: 'pending',
      createdAt: new Date().toISOString(),
      type: 'personal',
    };
    onSave(newBooking);
  };

  if (!isOpen) return null;

  const inputCls = "w-full px-3 py-2 bg-white border border-gray-300 rounded text-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 mb-2";

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded shadow-lg w-full max-w-sm overflow-hidden">
        <div className="bg-orange-500 text-white p-4 font-bold text-lg">Событие</div>
        <div className="p-4">
          <input
            type="text"
            placeholder="Название события"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className={inputCls}
          />
          <label className="block text-xs text-gray-600 mb-1">Время начала</label>
          <input
            type="time"
            value={startTime}
            onChange={e => setStartTime(e.target.value)}
            className={inputCls}
          />
          <label className="block text-xs text-gray-600 mb-1">Время окончания</label>
          <input
            type="time"
            value={endTime}
            onChange={e => setEndTime(e.target.value)}
            className={inputCls}
          />
          <label className="block text-xs text-gray-600 mb-1">Комментарий</label>
          <textarea
            placeholder="Комментарий..."
            value={comment}
            onChange={e => setComment(e.target.value)}
            className={`${inputCls} resize-none`}
            rows={3}
          />
          <label className="block text-xs text-gray-600 mb-2">Цвет в журнале</label>
          <div className="flex gap-3">
            {EVENT_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-gray-400' : ''}`}
                style={{ backgroundColor: c }}
                aria-label={`Цвет ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="p-3 border-t border-gray-300 flex gap-2 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded bg-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-300 transition"
          >
            ОТМЕНА
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-2.5 rounded bg-purple-700 text-white font-medium text-sm hover:opacity-90 transition flex items-center justify-center gap-1"
          >
            ✓ Сохранить
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== Journal Mode (Bumpix Grid) =====
const JournalMode: React.FC<{
  bookings: Booking[];
  onAddManual: (time?: string, brand?: BrandType) => void;
  onCellAction: (date: string, time: string, existingBooking?: Booking) => void;
  onDetailsOpen: (booking: Booking) => void;
  selectedJournalDate: string;
  onJournalDateChange: (d: string) => void;
  filterBrand: BrandType | 'all';
  onFilterChange: (f: BrandType | 'all') => void;
  onUpdateBooking: (booking: Booking) => void;
  onDeleteBooking: (id: string) => void;
  services: Service[];
  onSaveService: (service: Service) => Promise<Service | null>;
  onDeleteService: (id: string) => Promise<void>;
  scheduleSettings: ScheduleSettings;
  onUpdateSchedule: (settings: ScheduleSettings) => void;
  clients: Client[];
  onSaveClient: (c: Client) => void;
  onDeleteClient: (id: string) => void;
  onClientMode: () => void;
  onSignOut: () => void;
}> = ({
  bookings, onAddManual, onCellAction, onDetailsOpen, selectedJournalDate, onJournalDateChange,
  filterBrand, onFilterChange, onUpdateBooking, onDeleteBooking, services,
  scheduleSettings, onUpdateSchedule, clients, onSaveClient, onDeleteClient, onClientMode, onSignOut,
  onSaveService, onDeleteService,
}) => {
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [activeAdminScreen, setActiveAdminScreen] = useState<'calendar' | 'clients' | 'services' | 'settings'>('calendar');

    // QR-код для клиентов: модалка + состояние «ссылка скопирована»
    const [isQrModalOpen, setIsQrModalOpen] = useState(false);
    const [isQrLinkCopied, setIsQrLinkCopied] = useState(false);

    const handleCopyQrLink = async () => {
      const url = 'https://bvk-autoservis.github.io/';
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setIsQrLinkCopied(true);
      window.setTimeout(() => setIsQrLinkCopied(false), 2000);
    };

    const today = useMemo(() => new Date(), []);
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    const monthNamesFull = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

    // Непрерывный таймлайн: 60 дней назад и ~2 года вперёд от today.
    // Генерируется ОДИН РАЗ и никогда не пересчитывается при смене выбранной даты.
    const JOURNAL_DAYS_BACK = 60;
    const JOURNAL_DAYS_FORWARD = 730;
    const COLUMN_WIDTH = 48; // ширина одной дневной колонки, px
    const TIME_COLUMN_WIDTH = 56; // 3.5rem — ширина колонки часов

    const timelineDays = useMemo(() => {
      const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const days = [];
      for (let offset = -JOURNAL_DAYS_BACK; offset <= JOURNAL_DAYS_FORWARD; offset++) {
        const d = new Date(anchor);
        d.setDate(anchor.getDate() + offset);
        days.push(d);
      }
      return days;
      // selectedDate намеренно не входит в зависимости — иначе лента будет скакать
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const weekDays = useMemo(() => {
      return timelineDays.map((d, i) => ({
        date: toLocalDateString(d),
        dayName: dayNames[d.getDay()].toUpperCase(),
        dayNum: d.getDate(),
        month: months[d.getMonth()],
        monthKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        // Показываем месяц при первом дне и на первом дне нового месяца
        showMonth: i === 0 || d.getMonth() !== timelineDays[i - 1].getMonth(),
        isToday: toLocalDateString(d) === toLocalDateString(today),
        isWeekend: scheduleSettings.daysOff.includes(d.getDay()),
      }));
    }, [timelineDays, today, scheduleSettings.daysOff]);

    const filteredBookings = useMemo(() => {
      if (filterBrand === 'all') return bookings;
      return bookings.filter(b => b.brand === filterBrand);
    }, [bookings, filterBrand]);

    const dayBookings = useMemo(() => {
      return filteredBookings.filter(b => b.date === selectedJournalDate);
    }, [filteredBookings, selectedJournalDate]);

    const totalPrice = useMemo(
      () => dayBookings.filter(b => b.status !== 'ready').reduce((sum, b) => sum + b.totalPrice, 0),
      [dayBookings]
    );

    // Сетка часов журнала всегда в расширенном диапазоне 07:00–22:00,
    // независимо от клиентского расписания (scheduleSettings), чтобы мастер
    // мог записывать события утром и вечером.
    const JOURNAL_START_HOUR = 7;
    const JOURNAL_END_HOUR = 22;
    const timeRows = useMemo(() => {
      const rows: string[] = [];
      for (let h = JOURNAL_START_HOUR; h <= JOURNAL_END_HOUR; h++) {
        rows.push(`${h.toString().padStart(2, '0')}:00`);
      }
      return rows;
    }, []);

    // Контейнер сетки: только свободный ручной скролл
    const gridContainerRef = useRef<HTMLDivElement>(null);

    // Последняя позиция скролла сетки — восстанавливается при возврате в журнал
    const savedScrollRef = useRef<{ left: number; top: number } | null>(null);

    // Строго однократное центрирование сегодняшнего дня при входе в журнал
    const todayColumnRef = useRef<HTMLDivElement>(null);

    const scrollToToday = (behavior: ScrollBehavior = 'smooth') => {
      todayColumnRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
    };

    const handleToday = () => {
      onJournalDateChange(toLocalDateString(new Date()));
      scrollToToday('smooth');
    };

    // Надёжный стартовый скролл: ждём, пока браузер отрисует ширину контейнера
    useEffect(() => {
      const scrollToTodayOnce = () => {
        if (todayColumnRef.current) {
          todayColumnRef.current.scrollIntoView({
            inline: 'center',
            block: 'nearest',
            behavior: 'auto' // при первом открытии мгновенно
          });
        }
      };

      // Двойной вызов с таймером гарантирует, что браузер уже отрисовал ширину контейнера
      const raf = requestAnimationFrame(() => {
        setTimeout(scrollToTodayOnce, 100);
      });
      return () => cancelAnimationFrame(raf);
    }, []); // Пустой массив зависимостей — только один раз при монтировании

    // Синхронизация месяца в тулбаре с центральной видимой колонкой при скролле
    const [toolbarMonthKey, setToolbarMonthKey] = useState('');

    // Стрелки < > в тулбаре: листание ровно на одну неделю (7 дней)
    const scrollByWeek = (direction: number) => {
      gridContainerRef.current?.scrollBy({
        left: direction * 7 * COLUMN_WIDTH,
        behavior: 'smooth',
      });
    };

    const handleGridScroll = () => {
      const container = gridContainerRef.current;
      if (!container) return;
      // Запоминаем позицию, чтобы вернуть её при повторном входе в журнал
      savedScrollRef.current = { left: container.scrollLeft, top: container.scrollTop };
      // Центральная видимая колонка: вычитаем ширину колонки часов
      const centerPx = container.scrollLeft + container.clientWidth / 2 - TIME_COLUMN_WIDTH;
      let idx = Math.floor(centerPx / COLUMN_WIDTH);
      if (idx < 0) idx = 0;
      if (idx > weekDays.length - 1) idx = weekDays.length - 1;
      const key = weekDays[idx]?.monthKey || '';
      setToolbarMonthKey(prev => (prev === key ? prev : key));
    };

    // При возврате в журнал восстанавливаем сохранённую позицию скролла
    // (или прокручиваем к выбранной дате при первом показе), без скачка в начало.
    useEffect(() => {
      // Экран журнала в этом компоненте называется 'calendar'
      if (activeAdminScreen !== 'calendar') return;
      const raf = requestAnimationFrame(() => {
        const container = gridContainerRef.current;
        if (!container) return;
        const saved = savedScrollRef.current;
        if (saved) {
          container.scrollLeft = saved.left;
          container.scrollTop = saved.top;
        } else {
          const idx = weekDays.findIndex(wd => wd.date === selectedJournalDate);
          // Если дата ещё не выбрана (первый рендер до инициализации),
          // не сохраняем нулевую позицию — дождёмся появления даты.
          if (idx < 0) return;
          container.scrollLeft = Math.max(
            0,
            TIME_COLUMN_WIDTH + idx * COLUMN_WIDTH + COLUMN_WIDTH / 2 - container.clientWidth / 2
          );
          savedScrollRef.current = { left: container.scrollLeft, top: container.scrollTop };
        }
        const centerPx = container.scrollLeft + container.clientWidth / 2 - TIME_COLUMN_WIDTH;
        let ci = Math.floor(centerPx / COLUMN_WIDTH);
        if (ci < 0) ci = 0;
        if (ci > weekDays.length - 1) ci = weekDays.length - 1;
        setToolbarMonthKey(weekDays[ci]?.monthKey || '');
      });
      return () => cancelAnimationFrame(raf);
    }, [activeAdminScreen, weekDays, selectedJournalDate]);

    const topBarMonthDate = parseLocalDate(
      toolbarMonthKey ? `${toolbarMonthKey}-01` : (selectedJournalDate || toLocalDateString(today))
    );
    const currentMonthName = monthNamesFull[topBarMonthDate.getMonth()];
    const currentYear = topBarMonthDate.getFullYear();

    const handleNavClick = (screen: 'calendar' | 'clients' | 'services' | 'settings') => {
      setActiveAdminScreen(screen);
      if (screen === 'settings') {
        // При открытии настроек показываем актуальное сохранённое расписание
        // и состояние кнопки «СОХРАНЕНО».
        setLocalSchedule({
          startTime: scheduleSettings.startTime,
          endTime: scheduleSettings.endTime,
          daysOff: [...scheduleSettings.daysOff],
        });
        setIsScheduleSaved(true);
      }
      setIsDrawerOpen(false);
    };

    const [serviceFilterBrand, setServiceFilterBrand] = useState<BrandType | 'all'>('all');
    const [isServiceModalOpen, setIsServiceModalOpen] = useState(false);
    const [editingService, setEditingService] = useState<Service | null>(null);

    const [isClientModalOpen, setIsClientModalOpen] = useState(false);
    const [editingClient, setEditingClient] = useState<Client | null>(null);

    const [localSchedule, setLocalSchedule] = useState({
      startTime: scheduleSettings.startTime,
      endTime: scheduleSettings.endTime,
      daysOff: [...scheduleSettings.daysOff],
    });

    // Флаг «расписание сохранено»: при открытии экрана — true (кнопка «СОХРАНЕНО»).
    // Сбрасывается в false при любом изменении формы времени/выходных дней.
    const [isScheduleSaved, setIsScheduleSaved] = useState(true);

    const handleScheduleChange = (field: 'startTime' | 'endTime', value: string) => {
      setLocalSchedule(prev => ({ ...prev, [field]: value }));
      setIsScheduleSaved(false);
    };

    const handleDayOffToggle = (day: number) => {
      setLocalSchedule(prev => ({
        ...prev,
        daysOff: prev.daysOff.includes(day)
          ? prev.daysOff.filter(d => d !== day)
          : [...prev.daysOff, day].sort((a, b) => a - b),
      }));
      setIsScheduleSaved(false);
    };

    const handleSaveSchedule = () => {
      onUpdateSchedule({
        startTime: localSchedule.startTime,
        endTime: localSchedule.endTime,
        daysOff: localSchedule.daysOff,
      });
      setIsScheduleSaved(true);
      setIsDrawerOpen(false);
    };

    const handleSaveService = async (updated: Service) => {
      const saved = await onSaveService(updated);
      if (!saved) throw new Error('Услуга не сохранена');
      // Сразу показываем услугу: фильтр переключаем на её бренд
      setServiceFilterBrand(saved.brand);
    };

    const handleDeleteService = async (id: string) => {
      await onDeleteService(id);
    };

    const openServiceModal = (service: Service | null) => {
      setEditingService(service);
      setIsServiceModalOpen(true);
    };

    const openClientModal = (c: Client | null) => {
      setEditingClient(c);
      setIsClientModalOpen(true);
    };

    const sortedClients = useMemo(
      () => [...clients].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      [clients]
    );

    const filteredServices = useMemo(() => {
      if (serviceFilterBrand === 'all') return services;
      return services.filter(s => s.brand === serviceFilterBrand);
    }, [services, serviceFilterBrand]);

    const formatDurationDisplay = (min: number): string => {
      const h = Math.floor(min / 60);
      const m = min % 60;
      if (h > 0) return m > 0 ? `${h} ч. ${m} мин.` : `${h} ч.`;
      return `${m} мин.`;
    };

    // Раскладка накладывающихся записей рядом по горизонтали (side-by-side).
    const positionedBookings = useMemo(() => {
      const visible = filteredBookings.filter(b => weekDays.some(wd => wd.date === b.date));
      const byDate = new Map<string, Booking[]>();
      for (const b of visible) {
        const arr = byDate.get(b.date);
        if (arr) arr.push(b);
        else byDate.set(b.date, [b]);
      }
      const positions = new Map<string, { colIndex: number; colCount: number }>();
      for (const arr of byDate.values()) {
        for (const [id, pos] of layoutDayItems(arr, services)) positions.set(id, pos);
      }
      return visible.map(b => ({
        b,
        pos: positions.get(b.id) || { colIndex: 0, colCount: 1 },
      }));
    }, [filteredBookings, weekDays, services]);

    return (
      <div className="h-[100dvh] flex flex-col overflow-hidden">
        {/* Drawer overlay & menu */}
        {isDrawerOpen && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-40"
              onClick={() => setIsDrawerOpen(false)}
            />
            <div className="fixed top-0 left-0 w-72 h-full bg-white z-50 shadow-xl flex flex-col">
              <div className="bg-purple-800 p-4 text-white">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">👤</span>
                  <div>
                    <p className="font-bold">Владимир</p>
                    <p className="text-sm opacity-80">Журнал мастера</p>
                  </div>
                </div>
              </div>
              <nav className="flex-1 overflow-y-auto">
                <button onClick={() => handleNavClick('calendar')} className="w-full p-4 border-b border-gray-100 text-left text-gray-700 hover:bg-gray-50 text-sm">📅 Журнал</button>
                <button onClick={() => handleNavClick('clients')} className="w-full p-4 border-b border-gray-100 text-left text-gray-700 hover:bg-gray-50 text-sm">👥 Клиенты</button>
                <button onClick={() => handleNavClick('services')} className="w-full p-4 border-b border-gray-100 text-left text-gray-700 hover:bg-gray-50 text-sm">🛠 Услуги</button>
                <button onClick={() => handleNavClick('settings')} className="w-full p-4 border-b border-gray-100 text-left text-gray-700 hover:bg-gray-50 text-sm">⚙️ Настройки</button>
                <button
                  onClick={() => { setIsDrawerOpen(false); onClientMode(); }}
                  className="w-full p-4 border-b border-gray-100 text-left text-gray-700 hover:bg-gray-50 text-sm"
                >
                  📱 Экран клиента
                </button>
                <button
                  onClick={() => { setIsDrawerOpen(false); onSignOut(); }}
                  className="w-full p-4 border-b border-gray-100 text-left text-red-600 hover:bg-red-50 text-sm"
                >
                  🚪 Выйти
                </button>
              </nav>
            </div>
          </>
        )}

        {/* Top Bar */}
        <div className="bg-purple-800 text-white flex items-center justify-between p-3 shadow-md shrink-0">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsDrawerOpen(true)}
              className="text-xl leading-none hover:opacity-80"
              aria-label="Открыть меню"
            >
              ☰
            </button>
            <div className="flex items-center gap-3">
              <button onClick={() => scrollByWeek(-1)} className="text-lg font-bold px-2 hover:opacity-80" aria-label="Неделя назад">&lt;</button>
              <span className="font-medium text-lg capitalize">{currentMonthName} {currentYear}</span>
              <button onClick={() => scrollByWeek(1)} className="text-lg font-bold px-2 hover:opacity-80" aria-label="Неделя вперёд">&gt;</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsQrModalOpen(true)}
              className="w-9 h-9 bg-black hover:bg-neutral-800 active:scale-95 text-white rounded-lg flex items-center justify-center transition shadow-sm"
              aria-label="QR-код для клиентов"
              title="QR-код для клиентов"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm11.5-2H17v2.5h-1.5V18H13v-2.5h2.5V14h1v1.5H18V14h1v2h-1v1h-1.5v-1.5z" />
                <path d="M18 18h1.5v1.5H18zM15 20h2v1h-2zM20.5 20H22v1h-1.5zM15.5 15.5H17V17h-1.5z" />
              </svg>
            </button>
            <button
              onClick={handleToday}
              className="text-xl leading-none hover:opacity-80"
              aria-label="Сегодня"
              title="Сегодня"
            >
              📅
            </button>
          </div>
        </div>

        {/* Журнал всегда в DOM (скрыт классом hidden), чтобы браузер нативно
            сохранял scrollLeft/scrollTop при переходе в другие экраны */}
        <div className={`flex-1 min-h-0 flex flex-col overflow-hidden bg-gray-100 w-full ${activeAdminScreen === 'calendar' ? '' : 'hidden'}`}>
            <div className="max-w-md mx-auto px-2 sm:px-4 mb-3 flex gap-2">
              <button onClick={() => onFilterChange('all')} className={`px-3 py-1 rounded text-xs font-medium border ${filterBrand === 'all' ? 'bg-gray-900 text-white' : 'bg-white'}`}>Все посты</button>
              <button onClick={() => onFilterChange('bvk')} className={`px-3 py-1 rounded text-xs font-medium border ${filterBrand === 'bvk' ? 'bg-green-600 text-white' : 'bg-white'}`}>BVK Авто</button>
              <button onClick={() => onFilterChange('gbo')} className={`px-3 py-1 rounded text-xs font-medium border ${filterBrand === 'gbo' ? 'bg-red-600 text-white' : 'bg-white'}`}>ГБО</button>
            </div>

            <div className="max-w-md mx-auto px-2 sm:px-4 mb-3">
              <div className="bg-white rounded shadow border border-gray-300 p-2.5 flex justify-between text-xs">
                <span className="text-gray-600">Записей: <span className="font-medium text-gray-900">{dayBookings.length}</span></span>
                <span className="text-gray-600">Сумма: <span className="font-medium text-gray-900">{totalPrice} ₽</span></span>
              </div>
            </div>

            <div
              ref={gridContainerRef}
              onScroll={handleGridScroll}
              className="mx-1 sm:mx-4 overflow-x-auto overflow-y-auto flex-1 min-h-0 relative"
            >
              <div className="bg-white rounded border border-gray-300 w-max">
                <div
                  className="grid w-max gap-0"
                  style={{
                    gridTemplateColumns: `3.5rem repeat(${weekDays.length}, 48px)`,
                    gridAutoRows: '3.5rem',
                  }}
                >
                  {/* Левый верхний угол над шкалой времени — sticky по обеим осям */}
                  <div
                    className="sticky left-0 top-0 z-40 bg-white w-14 min-w-[3.5rem] border-r border-b border-gray-300"
                    style={{ gridColumn: 1, gridRow: 1 }}
                  ></div>

                  {/* Шапка с днями — sticky сверху; плашка месяца / число / день недели */}
                  {weekDays.map((d, dayIdx) => (
                    <div
                      key={`header-${d.date}`}
                      data-date={d.date}
                      data-month={d.showMonth ? d.monthKey : undefined}
                      data-active={d.date === selectedJournalDate ? 'true' : undefined}
                      ref={d.isToday ? todayColumnRef : undefined}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onJournalDateChange(d.date)}
                      className={`sticky top-0 z-30 w-12 min-w-[48px] border-r border-b border-gray-300 shadow-sm flex flex-col items-center justify-center cursor-pointer transition ${d.date === selectedJournalDate ? 'bg-purple-100' : d.isWeekend ? 'bg-slate-50' : 'bg-white'
                        }`}
                      style={{ gridColumn: dayIdx + 2, gridRow: 1 }}
                    >
                      <span className="text-[9px] font-medium uppercase leading-none text-gray-400">{d.month}</span>
                      <span
                        className={`text-sm font-bold leading-none mt-0.5 ${d.isToday
                          ? 'bg-purple-600 text-white rounded-full min-w-[1.375rem] h-[1.375rem] flex items-center justify-center px-1'
                          : d.date === selectedJournalDate
                            ? 'text-purple-700'
                            : 'text-gray-800'
                          }`}
                      >
                        {d.dayNum}
                      </span>
                      <span
                        className={`text-[9px] font-medium leading-none mt-0.5 ${d.isToday ? 'text-purple-600' : 'text-gray-500'
                          }`}
                      >
                        {d.dayName}
                      </span>
                    </div>
                  ))}

                  {timeRows.map((hour, hourIdx) => (
                    <React.Fragment key={`row-${hour}`}>
                      {/* Колонка времени — sticky слева, всегда прижата к левому краю */}
                      <div
                        className="sticky left-0 z-20 w-14 min-w-[3.5rem] h-14 bg-white border-r border-b border-gray-300 select-none text-xs text-gray-500 font-medium text-center flex items-start justify-center pt-1"
                        style={{ gridColumn: 1, gridRow: hourIdx + 2 }}
                      >
                        <span className="leading-none">{hour}</span>
                      </div>
                      {weekDays.map((d, dayIdx) => {
                        // Нерабочее время (до/после рабочих часов) и выходные — светло-серый фон,
                        // но остаются кликабельными для создания записей и личных событий.
                        const h = parseInt(hour.split(':')[0], 10);
                        const startH = parseInt(scheduleSettings.startTime.split(':')[0], 10);
                        const endH = parseInt(scheduleSettings.endTime.split(':')[0], 10);
                        const nonWorking = h < startH || h >= endH;
                        const gray = d.isWeekend || nonWorking;
                        const isSelected = d.date === selectedJournalDate;
                        return (
                          <div
                            key={`cell-${d.date}-${hour}`}
                            data-active={isSelected ? 'true' : undefined}
                            className={`w-12 min-w-[48px] h-14 border-r border-b border-gray-200 cursor-pointer transition-colors ${gray
                              ? isSelected
                                ? 'bg-gray-200/90 hover:bg-gray-300'
                                : 'bg-gray-100/80 hover:bg-gray-200'
                              : isSelected
                                ? 'bg-purple-50'
                                : 'bg-white hover:bg-gray-100'
                              }`}
                            style={{ gridColumn: dayIdx + 2, gridRow: hourIdx + 2 }}
                            onClick={() => onCellAction(d.date, hour)}
                          ></div>
                        );
                      })}
                    </React.Fragment>
                  ))}

                  {positionedBookings.map(({ b, pos }) => {
                    const dayIdx = weekDays.findIndex(wd => wd.date === b.date);
                    if (dayIdx === -1) return null;

                    const startMin = timeToMinutes(b.time);
                    const endMin = timeToMinutes(getBookingEndTime(b, services));
                    const startIdx = startMin / 60 - JOURNAL_START_HOUR;
                    const endIdx = endMin / 60 - JOURNAL_START_HOUR;
                    const clampedStart = Math.max(startIdx, 0);
                    const rowStart = Math.max(0, Math.floor(startIdx));
                    const rowEnd = Math.min(timeRows.length, Math.ceil(endIdx));
                    const span = Math.max(1, rowEnd - rowStart);
                    const topOffset = (clampedStart - rowStart) * 56;
                    const height = Math.max(20, (Math.min(endIdx, timeRows.length) - clampedStart) * 56 - 2);

                    const endLabel = getBookingEndTime(b, services);
                    const cardColor = getBookingColor(b);
                    const width = 100 / pos.colCount;

                    // Клик по карточке: вычисляем час сетки по Y-координате клика
                    // относительно ВЕРХА КАРТОЧКИ, прибавляя базовый час начала записи
                    // (иначе смещение считалось от 07:00 и давало неверный час слота).
                    const ROW_HEIGHT = 56;
                    const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
                      const startHour = Math.floor(timeToMinutes(b.time) / 60);
                      const rect = e.currentTarget.getBoundingClientRect();
                      const offsetY = Math.max(0, e.clientY - rect.top);
                      const hourOffset = Math.floor(offsetY / ROW_HEIGHT);
                      const clickedHour = Math.min(
                        JOURNAL_END_HOUR,
                        Math.max(JOURNAL_START_HOUR, startHour + hourOffset)
                      );
                      const clickedTime = `${String(clickedHour).padStart(2, '0')}:00`;
                      onCellAction(b.date, clickedTime, b);
                    };

                    // Строки текста на карточке: без дублирования name/serviceName.
                    const isPersonal = b.type === 'personal';
                    const primaryText = isPersonal
                      ? (b.serviceName || b.name)
                      : (b.name || b.carMake || b.serviceName);
                    const secondaryText = isPersonal
                      ? (b.comment || '')
                      : (b.serviceName && b.serviceName !== primaryText ? b.serviceName : (b.comment || ''));

                    return (
                      <div
                        key={b.id}
                        onClick={handleCardClick}
                        className={`text-white overflow-hidden cursor-pointer z-10 flex flex-col leading-tight rounded-sm shadow-sm ${b.status === 'ready' ? 'opacity-60' : ''}`}
                        style={{
                          gridColumn: dayIdx + 2,
                          gridRow: `${rowStart + 2} / span ${span}`,
                          marginTop: `${topOffset}px`,
                          height: `${height}px`,
                          marginLeft: `calc(${pos.colIndex * width}% + 1px)`,
                          width: `calc(${width}% - 2px)`,
                          backgroundColor: cardColor,
                        }}
                      >
                        <span className="text-[10px] font-semibold leading-tight whitespace-nowrap overflow-hidden px-1 pt-0.5">{b.time}–{endLabel}</span>
                        <span className="text-[8px] sm:text-[9px] font-medium leading-none px-1 mt-0.5" style={{ wordBreak: 'break-word', whiteSpace: 'normal' }}>
                          {primaryText}
                        </span>
                        {secondaryText && (
                          <span className="text-[8px] opacity-90 leading-none px-1 mt-0.5 truncate">{secondaryText}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
        </div>
        {activeAdminScreen === 'clients' && (
          <div className="flex-1 min-h-0 overflow-y-auto pb-20 bg-gray-100 w-full">
            <div className="max-w-md mx-auto">
              <div className="bg-white rounded-none sm:rounded border-b sm:border border-gray-300 overflow-hidden">
                {sortedClients.map(c => (
                  <button
                    key={c.id}
                    onClick={() => openClientModal(c)}
                    className="w-full flex items-center gap-3 p-3 border-b border-gray-200 last:border-b-0 text-left hover:bg-gray-50 transition"
                  >
                    <div className="w-10 h-10 rounded-full bg-orange-400 text-white flex items-center justify-center font-bold text-lg flex-shrink-0">
                      {(c.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">{c.name || 'Без имени'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{c.phone}</p>
                    </div>
                  </button>
                ))}
                {sortedClients.length === 0 && (
                  <div className="p-6 text-center text-gray-500 text-sm">Нет клиентов</div>
                )}
              </div>
            </div>

            {/* Floating add button */}
            <button
              onClick={() => openClientModal(null)}
              className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-purple-700 text-white text-2xl shadow-lg hover:opacity-90 transition flex items-center justify-center"
              aria-label="Добавить клиента"
            >
              +
            </button>
          </div>
        )}
        {activeAdminScreen === 'services' && (
          <div className="flex-1 min-h-0 overflow-y-auto pb-20 bg-gray-100 w-full">
            <div className="max-w-md mx-auto px-2 sm:px-4 py-3">
              {/* Brand filter tabs */}
              <div className="flex gap-2 mb-3">
                <button onClick={() => setServiceFilterBrand('all')} className={`px-3 py-1 rounded text-xs font-medium border ${serviceFilterBrand === 'all' ? 'bg-gray-900 text-white' : 'bg-white'}`}>Все</button>
                <button onClick={() => setServiceFilterBrand('bvk')} className={`px-3 py-1 rounded text-xs font-medium border ${serviceFilterBrand === 'bvk' ? 'bg-green-600 text-white' : 'bg-white'}`}>BVK Авто</button>
                <button onClick={() => setServiceFilterBrand('gbo')} className={`px-3 py-1 rounded text-xs font-medium border ${serviceFilterBrand === 'gbo' ? 'bg-red-600 text-white' : 'bg-white'}`}>ГБО</button>
              </div>

              {/* Services list */}
              <div className="bg-white rounded border border-gray-300 overflow-hidden">
                {filteredServices.map((svc) => (
                  <div key={svc.id} className="p-3 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900 text-sm">{svc.name}</p>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-600">
                        <span>🕒 {formatDurationDisplay(svc.duration)}</span>
                        <span>💰 {svc.price}</span>
                      </div>
                    </div>
                    <div className="flex gap-2 ml-3">
                      <button
                        onClick={() => openServiceModal(svc)}
                        className="text-gray-600 hover:text-gray-900 text-sm"
                        aria-label="Редактировать"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => handleDeleteService(svc.id)}
                        className="text-gray-600 hover:text-red-600 text-sm"
                        aria-label="Удалить"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
                {filteredServices.length === 0 && (
                  <div className="p-6 text-center text-gray-500 text-sm">Нет услуг</div>
                )}
              </div>
            </div>

            {/* Floating add button */}
            <button
              onClick={() => openServiceModal(null)}
              className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-purple-700 text-white text-2xl shadow-lg hover:opacity-90 transition flex items-center justify-center"
              aria-label="Добавить услугу"
            >
              +
            </button>
          </div>
        )}
        {activeAdminScreen === 'settings' && (
          <div className="flex-1 min-h-0 overflow-y-auto pb-20 bg-gray-100 w-full">
            <div className="max-w-md mx-auto px-2 sm:px-4 py-4">
              <div className="bg-white rounded shadow border border-gray-300 p-4 mb-4">
                <h2 className="text-xl font-bold text-gray-900 mb-4">Расписание</h2>

                {/* Время работы */}
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Время работы</h3>
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-1">От</label>
                      <input
                        type="time"
                        value={localSchedule.startTime}
                        onChange={e => handleScheduleChange('startTime', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      />
                    </div>
                    <span className="text-gray-400 mt-5">—</span>
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-1">До</label>
                      <input
                        type="time"
                        value={localSchedule.endTime}
                        onChange={e => handleScheduleChange('endTime', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      />
                    </div>
                  </div>
                </div>

                {/* Выходные дни */}
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Выходные дни</h3>
                  <div className="space-y-1 border border-gray-200 rounded bg-gray-50 p-2">
                    {[
                      { name: 'Понедельник', value: 1 },
                      { name: 'Вторник', value: 2 },
                      { name: 'Среда', value: 3 },
                      { name: 'Четверг', value: 4 },
                      { name: 'Пятница', value: 5 },
                      { name: 'Суббота', value: 6 },
                      { name: 'Воскресенье', value: 0 },
                    ].map((day) => (
                      <label key={day.value} className="flex items-center justify-between py-1.5 cursor-pointer">
                        <span className="text-sm text-gray-700">{day.name}</span>
                        <input
                          type="checkbox"
                          checked={localSchedule.daysOff.includes(day.value)}
                          onChange={() => handleDayOffToggle(day.value)}
                          className="w-4 h-4 text-purple-600 border-gray-300 rounded"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* Save button */}
              <button
                onClick={handleSaveSchedule}
                disabled={isScheduleSaved}
                className={`w-full py-3 rounded font-medium text-sm transition ${isScheduleSaved
                  ? 'bg-purple-300 text-white/80 cursor-default'
                  : 'bg-purple-700 text-white hover:opacity-90'
                  }`}
              >
                {isScheduleSaved ? 'СОХРАНЕНО' : 'СОХРАНИТЬ'}
              </button>
            </div>
          </div>
        )}

        {/* Service Modal */}
        <ServiceModal
          isOpen={isServiceModalOpen}
          onClose={() => setIsServiceModalOpen(false)}
          onSave={handleSaveService}
          onDelete={handleDeleteService}
          service={editingService}
          services={services}
        />

        <ClientModal
          isOpen={isClientModalOpen}
          onClose={() => setIsClientModalOpen(false)}
          onSave={onSaveClient}
          onDelete={onDeleteClient}
          client={editingClient}
        />

        {/* QR-код для клиентов */}
        {isQrModalOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
            onClick={() => setIsQrModalOpen(false)}
          >
            <div
              className="bg-white rounded-2xl p-6 max-w-xs w-full text-center shadow-2xl relative animate-in fade-in zoom-in-95"
              onClick={e => e.stopPropagation()}
            >
              <button
                onClick={() => setIsQrModalOpen(false)}
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                aria-label="Закрыть"
              >
                ✕
              </button>

              <h3 className="font-bold text-gray-900 text-lg">Запись для клиентов</h3>
              <p className="text-xs text-gray-500 mt-1 mb-4">
                Покажите QR-код клиенту для быстрой онлайн-записи
              </p>

              <img
                src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=https://bvk-autoservis.github.io/"
                alt="QR-код записи"
                className="w-48 h-48 mx-auto rounded-lg border border-gray-100 p-2 shadow-inner"
              />

              <div className="mt-4 bg-gray-100 rounded-lg px-3 py-2 text-xs text-gray-600 break-all">
                bvk-autoservis.github.io
              </div>

              <button
                onClick={handleCopyQrLink}
                className={`mt-3 w-full py-2.5 rounded-lg font-medium text-sm transition ${isQrLinkCopied
                  ? 'bg-green-600 text-white'
                  : 'bg-purple-700 text-white hover:opacity-90'
                  }`}
              >
                {isQrLinkCopied ? '✓ Ссылка скопирована!' : 'Скопировать ссылку'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };
// Флаг режима мастера: только на текущую вкладку (sessionStorage),
// поэтому чистая ссылка "/" без параметров всегда открывает экран клиента
const MASTER_MODE_KEY = 'bvk_master_mode';

const isMasterModeSaved = () => {
  try {
    return sessionStorage.getItem(MASTER_MODE_KEY) === '1';
  } catch {
    return false;
  }
};

const setMasterModeSaved = (enabled: boolean) => {
  try {
    if (enabled) sessionStorage.setItem(MASTER_MODE_KEY, '1');
    else sessionStorage.removeItem(MASTER_MODE_KEY);
  } catch {
    // sessionStorage недоступен — просто работаем без сохранения режима
  }
};

// Скрытый вход ?admin=1 или #admin
const hasAdminUrl = () =>
  new URLSearchParams(window.location.search).get('admin') === '1' ||
  window.location.hash.replace(/^#/, '').toLowerCase() === 'admin';

// Закрепляет режим журнала в адресе: F5 и ярлык на экране «Домой» откроют журнал
const setAdminHash = () => {
  try {
    window.history.replaceState(null, '', '#admin');
  } catch {
    // history API недоступен — молча пропускаем
  }
};

// Убирает #admin из адреса, возвращая чистую клиентскую ссылку
const removeAdminHash = () => {
  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch {
    // history API недоступен — молча пропускаем
  }
};

// ===== Main App =====
const App: React.FC = () => {
  const [activeBrand, setActiveBrand] = useState<BrandType>('bvk');
  const [mode, setMode] = useState<AppMode>('client');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [adminRequested, setAdminRequested] = useState(false);
  const logoTapsRef = useRef<number[]>([]);
  // Сессия уже проверена Supabase Auth (форма входа не должна мигать раньше времени)
  const [isSessionReady, setIsSessionReady] = useState(false);

  // Открывает журнал мастера и запоминает режим до следующей загрузки страницы
  const openJournal = () => {
    setMasterModeSaved(true);
    setAdminHash();
    setMode('journal');
  };
  // Занятые слоты для анонимного клиента (RPC get_busy_slots)
  const [publicBlockedMap, setPublicBlockedMap] = useState<Map<string, string>>(new Map());

  // Booking form state
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<Partial<Booking>>({ name: '', phone: '', carMake: '', carModel: '', comment: '' });
  const [ownBookings, setOwnBookings] = useState<Booking[]>([]);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [currentBooking, setCurrentBooking] = useState<Booking | null>(null);
  const [isTimeSelectionOpen, setIsTimeSelectionOpen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const calendarSectionRef = useRef<HTMLDivElement | null>(null);
  const bookingFormRef = useRef<HTMLDivElement | null>(null);
  const [isBookingSectionVisible, setIsBookingSectionVisible] = useState(false);

  // Плашка «Выбрать время» жёстко скрывается, как только верхняя граница
  // секции календаря или формы записи достигает нижней границы экрана
  useEffect(() => {
    const els = [calendarSectionRef.current, bookingFormRef.current].filter(Boolean) as HTMLElement[];
    if (els.length === 0) {
      setIsBookingSectionVisible(false);
      return;
    }
    const visibility = new Map<Element, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visibility.set(entry.target, entry.isIntersecting);
        setIsBookingSectionVisible(Array.from(visibility.values()).some(Boolean));
      },
      { threshold: 0 }
    );
    els.forEach(el => {
      visibility.set(el, false);
      observer.observe(el);
    });
    return () => observer.disconnect();
  }, [isTimeSelectionOpen, selectedServices.length, selectedDate, selectedTime]);

  // Форма контактов плавно раскрывается после выбора слота и плавно сворачивается при сбросе времени
  const wantBookingForm = !!(selectedServices.length > 0 && selectedDate && selectedTime);
  const [isFormMounted, setIsFormMounted] = useState(false);
  const [isFormExpanded, setIsFormExpanded] = useState(false);

  useEffect(() => {
    if (wantBookingForm) {
      setIsFormMounted(true);
      const raf = requestAnimationFrame(() => setIsFormExpanded(true));
      return () => cancelAnimationFrame(raf);
    }
    setIsFormExpanded(false);
    const t = setTimeout(() => setIsFormMounted(false), 320);
    return () => clearTimeout(t);
  }, [wantBookingForm]);

  // Journal state
  const [filterBrand, setFilterBrand] = useState<BrandType | 'all'>('all');
  const [selectedJournalDate, setSelectedJournalDate] = useState<string>('');
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [prefillTime, setPrefillTime] = useState<string>('');
  const [prefillBrand, setPrefillBrand] = useState<BrandType>('bvk');
  const [prefillDate, setPrefillDate] = useState<string>('');
  const [detailsBooking, setDetailsBooking] = useState<Booking | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [scheduleSettings, setScheduleSettings] = useState<ScheduleSettings>(DEFAULT_SCHEDULE);
  const [actionSheetData, setActionSheetData] = useState<{ date: string; time: string; existingBooking?: Booking } | null>(null);
  const [isPersonalEventOpen, setIsPersonalEventOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Услуги и расписание доступны анонимно (SELECT по RLS)
    (async () => {
      try {
        const loadedServices = await fetchServices();
        if (!cancelled) setServices(loadedServices);
      } catch (e) {
        console.error('Не удалось загрузить услуги из Supabase', e);
      }
      try {
        const loadedSchedule = await fetchScheduleSettings();
        if (!cancelled) setScheduleSettings(loadedSchedule);
      } catch (e) {
        console.error('Не удалось загрузить расписание из Supabase', e);
      }
    })();

    // Скрытый вход в журнал: ?admin=1 или #admin
    const adminInQuery = new URLSearchParams(window.location.search).get('admin') === '1';
    const adminInHash = window.location.hash.replace(/^#/, '').toLowerCase() === 'admin';
    if (adminInQuery || adminInHash) {
      setAdminRequested(true);
    }

    // Восстанавливаем запомненный профиль клиента и его собственные записи (PWA, без регистрации)
    const savedProfile = loadClientProfile();
    if (savedProfile) {
      setContactForm(prev => ({
        ...prev,
        name: savedProfile.name || prev.name || '',
        phone: savedProfile.phone || prev.phone || '',
        carMake: savedProfile.carMake || prev.carMake || '',
        carModel: savedProfile.carModel || prev.carModel || '',
      }));
    }
    setOwnBookings(loadOwnBookings());

    const todayStr = toLocalDateString(new Date());
    setSelectedDate(todayStr);
    setSelectedJournalDate(todayStr);

    const checkMobile = () => {
      if (typeof window === 'undefined') return false;
      const ua = navigator.userAgent || '';
      return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua) || window.innerWidth <= 768;
    };
    setIsMobile(checkMobile());
    setIsStandalone(
      window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true
    );

    return () => {
      cancelled = true;
    };
  }, []);

  // Сессия мастера (Supabase Auth) с постоянным сохранением
  useEffect(() => {
    let active = true;
    supabase.auth.getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session);
        setIsSessionReady(true);
        // После F5: сессия жива и режим мастера запоминался (или открыт ?admin=1 / #admin)
        if (data.session && (isMasterModeSaved() || hasAdminUrl())) {
          // Восстанавливаем журнал и заново закрепляем #admin, чтобы режим пережил F5
          openJournal();
          setIsAuthModalOpen(false);
          clearAdminUrl();
        }
      })
      .catch(() => {
        if (active) setIsSessionReady(true);
      });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setIsSessionReady(true);
      if (event === 'SIGNED_IN' && nextSession) {
        setIsAuthModalOpen(false);
        // Запоминаем режим мастера, чтобы после обновления страницы журнал открылся сразу
        openJournal();
        // Убираем скрытый вход из адресной строки после успешного входа
        clearAdminUrl();
      }
      if (event === 'SIGNED_OUT') {
        setMasterModeSaved(false);
        removeAdminHash();
        setIsAuthModalOpen(false);
        setMode('client');
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // ?admin=1: ждём восстановления сессии и открываем журнал либо форму входа
  useEffect(() => {
    // Ждём результата getSession(), иначе форма входа мелькнёт поверх активной сессии
    if (!adminRequested || !isSessionReady) return;
    if (session) {
      openJournal();
      clearAdminUrl();
    } else {
      setIsAuthModalOpen(true);
    }
    setAdminRequested(false);
  }, [adminRequested, session, isSessionReady]);

  // Полные данные журнала доступны только авторизованному мастеру (RLS)
  useEffect(() => {
    if (!session) {
      setBookings([]);
      setClients([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [loadedBookings, loadedClients] = await Promise.all([fetchBookings(), fetchClients()]);
        if (!cancelled) {
          setBookings(loadedBookings);
          setClients(loadedClients);
        }
        // Повторная загрузка услуг: пустую таблицу мастер заполняет стартовым каталогом
        try {
          const loadedServices = await fetchServices();
          if (!cancelled) setServices(loadedServices);
        } catch (e) {
          console.error('Не удалось обновить услуги после входа', e);
        }
      } catch (e) {
        console.error('Не удалось загрузить данные журнала из Supabase', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Realtime: новые заявки с сайта и изменения появляются в журнале без F5
  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel('bookings-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings' },
        (payload: any) => {
          if (payload.eventType === 'DELETE') {
            const removedId = payload.old?.id;
            if (!removedId) return;
            setBookings(prev => prev.filter(b => b.id !== String(removedId)));
            return;
          }
          if (!payload.new || payload.new.id == null) return;
          const incoming = bookingFromRow(payload.new);
          // Обновляем по id без дубликатов, новые записи добавляем в конец
          setBookings(prev => (prev.some(b => b.id === incoming.id)
            ? prev.map(b => (b.id === incoming.id ? incoming : b))
            : [...prev, incoming]));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  // Занятые слоты для клиента — обезличенная RPC get_busy_slots
  useEffect(() => {
    if (mode === 'journal' || !selectedDate) {
      setPublicBlockedMap(new Map());
      return;
    }
    let cancelled = false;
    fetchBusySlots(selectedDate)
      .then(slots => {
        if (!cancelled) setPublicBlockedMap(slots);
      })
      .catch(e => {
        console.error('Не удалось получить занятые слоты', e);
        if (!cancelled) setPublicBlockedMap(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [mode, selectedDate]);

  // Скрытый вход: 5 быстрых тапов по логотипу за 3 секунды
  const handleLogoTap = async () => {
    const now = Date.now();
    const taps = [...logoTapsRef.current, now].filter(t => now - t <= 3000);
    logoTapsRef.current = taps;
    if (taps.length < 5) return;
    logoTapsRef.current = [];
    // Сначала проверяем активную сессию: мастеру не нужно вводить пароль заново
    let currentSession = session;
    if (!currentSession) {
      try {
        const { data } = await supabase.auth.getSession();
        currentSession = data.session ?? null;
        if (currentSession) setSession(currentSession);
      } catch {
        currentSession = null;
      }
    }
    if (currentSession) {
      openJournal();
    } else {
      setIsAuthModalOpen(true);
    }
  };

  // Убирает скрытый вход ?admin=1 из URL, оставляя #admin для восстановления после F5
  const clearAdminUrl = () => {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('admin')) return;
      url.searchParams.delete('admin');
      window.history.replaceState({}, '', url.toString());
    } catch {
      // history API недоступен — молча пропускаем
    }
  };

  // Возврат к экрану клиента без выхода из аккаунта: сессия остаётся живой
  const handleSwitchToClient = () => {
    setMasterModeSaved(false);
    removeAdminHash();
    setMode('client');
  };

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error('Не удалось выйти из аккаунта', e);
    }
    // Полный сброс: забываем сессию, режим мастера и возвращаемся к клиентскому экрану
    setMasterModeSaved(false);
    removeAdminHash();
    setSession(null);
    setIsAuthModalOpen(false);
    setMode('client');
  };

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    // Событие могло прийти до монтирования React (перехвачено в main.tsx)
    const earlyPrompt = (window as any).__deferredPrompt;
    if (earlyPrompt) setDeferredPrompt(earlyPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleDirectInstall = async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setDeferredPrompt(null);
        setShowInstallHelp(false);
      }
    } catch (e) {
      // keep modal open so the manual instructions remain available
    }
  };

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          setDeferredPrompt(null);
        }
      } catch (e) {
        setShowInstallHelp(true);
      }
    } else {
      setShowInstallHelp(true);
    }
  };

  const handleServiceToggle = (id: string) => {
    const next = selectedServices.includes(id)
      ? selectedServices.filter(s => s !== id)
      : [...selectedServices, id];
    setSelectedServices(next);
    if (next.length === 0) setIsTimeSelectionOpen(false);
  };

  const handleContactChange = (field: keyof Booking, value: string) => {
    setContactForm(prev => ({ ...prev, [field]: value }));
  };

  const handleBook = async () => {
    setValidationError(null);
    const phoneDigits = (contactForm.phone || '').replace(/\D/g, '');
    let missingField: string | null = null;
    if (!contactForm.name || contactForm.name.trim().length < 2) {
      missingField = 'Имя (минимум 2 символа)';
    } else if (phoneDigits.length < 10) {
      missingField = 'Корректный номер телефона';
    }
    if (missingField) {
      setValidationError(missingField);
      return;
    }

    if (!selectedDate || !selectedTime || selectedServices.length === 0) return;

    const selectedServiceObjs = selectedServices
      .map(id => services.find(s => s.id === id))
      .filter(Boolean) as Service[];
    const serviceName = selectedServiceObjs.map(s => s.name).join('; ');
    const totalPrice = selectedServiceObjs.reduce((sum, s) => sum + parsePrice(s.price), 0);
    const totalDuration = selectedServiceObjs.reduce((sum, s) => sum + (s.duration || 0), 0) || 60;

    const clientName = (contactForm.name || '').trim();
    const clientPhone = (contactForm.phone || '').trim();
    const clientCarMake = (contactForm.carMake || '').trim();
    const clientCarModel = (contactForm.carModel || '').trim();

    const newBooking: Booking = {
      id: crypto.randomUUID(),
      brand: activeBrand,
      services: selectedServices,
      serviceName,
      totalPrice,
      carMake: clientCarMake,
      carModel: clientCarModel,
      date: selectedDate,
      time: selectedTime,
      endTime: minutesToTime(timeToMinutes(selectedTime) + totalDuration),
      duration: totalDuration,
      name: clientName,
      phone: clientPhone,
      comment: contactForm.comment || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // Анонимный клиент пишет запись через INSERT (SELECT закрыт RLS), поэтому без .select()
    try {
      await createPublicBooking(newBooking);
    } catch (e) {
      console.error('Не удалось отправить заявку в Supabase', e);
      setValidationError('Не удалось отправить заявку. Проверьте подключение и попробуйте ещё раз.');
      return;
    }

    // Обновляем занятые слоты после успешной записи
    fetchBusySlots(selectedDate)
      .then(slots => setPublicBlockedMap(slots))
      .catch(() => {});

    // Запоминаем профиль клиента, чтобы при повторном визите не вводить данные заново
    saveClientProfile({ name: clientName, phone: clientPhone, carMake: clientCarMake, carModel: clientCarModel });

    // Сохраняем собственную запись клиента для блока «Ваша ближайшая запись»
    const ownNext = [...loadOwnBookings(), newBooking];
    saveOwnBookings(ownNext);
    setOwnBookings(ownNext);

    // Автоматически добавляем/обновляем клиента в базе Журнала мастера (только для мастера)
    const phoneDigitsKey = clientPhone.replace(/\D/g, '');
    if (session && phoneDigitsKey.length >= 10) {
      const existingClient = clients.find(c => (c.phone || '').replace(/\D/g, '') === phoneDigitsKey);
      if (existingClient) {
        handleSaveClient({
          ...existingClient,
          name: clientName || existingClient.name,
          carMake: clientCarMake || existingClient.carMake,
          carModel: clientCarModel || existingClient.carModel,
        });
      } else {
        handleSaveClient({
          id: Date.now().toString(),
          name: clientName,
          phone: clientPhone,
          carMake: clientCarMake,
          carModel: clientCarModel,
        });
      }
    }

    setCurrentBooking(newBooking);
    setIsSubmitted(true);

    setSelectedServices([]);
    setSelectedTime(null);
    setSelectedDate('');
    // Очищаем только комментарий — имя, телефон и авто остаются запомненными
    setContactForm(prev => ({ ...prev, comment: '' }));
    setIsTimeSelectionOpen(false);
  };

  const handleCancelNearest = () => {
    const earliest = [...ownBookings]
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    if (!earliest) return;

    const ownUpdated = ownBookings.filter(b => b.id !== earliest.id);
    saveOwnBookings(ownUpdated);
    setOwnBookings(ownUpdated);
  };

  const handleNewBooking = () => {
    setIsSubmitted(false);
    setCurrentBooking(null);
  };

  const handleSaveManual = async (booking: Booking) => {
    setIsManualOpen(false);
    setIsPersonalEventOpen(false);
    try {
      const saved = await createBooking(booking);
      setBookings(prev => [...prev, saved]);
      if (mode === 'journal') {
        setSelectedJournalDate(saved.date);
      }
    } catch (e) {
      console.error('Не удалось сохранить запись в Supabase', e);
    }
  };

  const handleUpdateBooking = async (updated: Booking) => {
    try {
      const saved = await updateBookingRecord(updated);
      setBookings(prev => prev.map(b => (b.id === saved.id ? saved : b)));
      setDetailsBooking(prev => (prev && prev.id === saved.id ? saved : prev));
    } catch (e) {
      console.error('Не удалось обновить запись в Supabase', e);
    }
  };

  const handleDeleteBooking = async (id: string) => {
    if (!window.confirm('Удалить запись?')) return;
    try {
      await deleteBookingRecord(id);
      setBookings(prev => prev.filter(b => b.id !== id));
    } catch (e) {
      console.error('Не удалось удалить запись из Supabase', e);
    }
  };

  const handleSaveService = async (service: Service): Promise<Service | null> => {
    // Услуги меняет только мастер (RLS services_write)
    if (!session) return null;
    try {
      const saved = await saveServiceToDb(service);
      // В state кладём строку, которую вернул Supabase, а не локальную копию
      setServices(prev => (prev.some(s => s.id === saved.id)
        ? prev.map(s => (s.id === saved.id ? saved : s))
        : [...prev, saved]));
      return saved;
    } catch (e) {
      console.error('Не удалось сохранить услугу в Supabase', e);
      return null;
    }
  };

  const handleDeleteService = async (id: string) => {
    try {
      await deleteServiceFromDb(id);
      setServices(prev => prev.filter(s => s.id !== id));
    } catch (e) {
      console.error('Не удалось удалить услугу из Supabase', e);
    }
  };

  const handleSaveClient = async (c: Client) => {
    // Справочник клиентов доступен только авторизованному мастеру
    if (!session) return;
    try {
      const saved = await saveClientToDb(c);
      setClients(prev => (prev.some(x => x.id === saved.id)
        ? prev.map(x => (x.id === saved.id ? saved : x))
        : [...prev, saved]));
    } catch (e) {
      console.error('Не удалось сохранить клиента в Supabase', e);
    }
  };

  const handleDeleteClient = async (id: string) => {
    if (!window.confirm('Удалить клиента из базы?')) return;
    try {
      await deleteClientFromDb(id);
      setClients(prev => prev.filter(c => c.id !== id));
    } catch (e) {
      console.error('Не удалось удалить клиента из Supabase', e);
    }
  };

  const openManualAdd = (time?: string, brand?: BrandType) => {
    setPrefillTime(time || '');
    setPrefillBrand(brand || 'bvk');
    setPrefillDate(selectedJournalDate || toLocalDateString(new Date()));
    setIsManualOpen(true);
  };

  const handleCellAction = (date: string, time: string, existingBooking?: Booking) => {
    // На прошедшее время запись создавать нельзя (но существующую запись открыть можно)
    if (!existingBooking) {
      const [hourStr, minuteStr] = time.split(':');
      const slot = parseLocalDate(date);
      slot.setHours(parseInt(hourStr, 10) || 0, parseInt(minuteStr, 10) || 0, 0, 0);
      if (slot.getTime() < Date.now()) {
        return; // слот в прошлом — не открываем меню создания записи
      }
    }
    setActionSheetData({ date, time, existingBooking });
  };

  const handleActionSheetEditExisting = () => {
    if (actionSheetData?.existingBooking) {
      setDetailsBooking(actionSheetData.existingBooking);
    }
    setActionSheetData(null);
  };

  const handleActionSheetBookClient = () => {
    if (actionSheetData) {
      setPrefillTime(actionSheetData.time);
      setPrefillBrand(filterBrand === 'all' ? 'bvk' : filterBrand);
      setPrefillDate(actionSheetData.date);
    }
    setIsManualOpen(true);
    setActionSheetData(null);
  };

  const handleActionSheetCreatePersonal = () => {
    if (actionSheetData) {
      setPrefillTime(actionSheetData.time);
      setPrefillBrand(filterBrand === 'all' ? 'bvk' : filterBrand);
      setPrefillDate(actionSheetData.date);
    }
    setIsPersonalEventOpen(true);
    setActionSheetData(null);
  };

  const openDetails = (booking: Booking) => {
    setDetailsBooking(booking);
  };

  const handleOpenTimeSelection = () => {
    setIsTimeSelectionOpen(true);
    setTimeout(() => {
      calendarSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  useEffect(() => {
    if (!selectedTime) return;
    const t = setTimeout(() => {
      bookingFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 350);
    return () => clearTimeout(t);
  }, [selectedTime]);

  const handleDateChangeClient = (d: string) => {
    setSelectedDate(d);
    setSelectedTime(null);
    setValidationError(null);
  };

  const handleTimeChangeClient = (t: string | null) => {
    setSelectedTime(t);
    setValidationError(null);
  };

  // Клиент видит только обезличенные слоты из RPC, мастер — по полным данным
  const blockedMap = useMemo(
    () => (mode === 'journal' ? getBlockedHoursMap(bookings, selectedDate, services) : publicBlockedMap),
    [mode, bookings, selectedDate, services, publicBlockedMap]
  );

  const workingHours = useMemo(
    () => generateWorkingHours(scheduleSettings.startTime, scheduleSettings.endTime),
    [scheduleSettings.startTime, scheduleSettings.endTime]
  );

  const handleUpdateSchedule = async (settings: ScheduleSettings) => {
    setScheduleSettings(settings);
    try {
      await updateScheduleSettings(settings);
    } catch (e) {
      console.error('Не удалось сохранить расписание в Supabase', e);
    }
  };

  const nearestUserBooking = useMemo(() => {
    if (ownBookings.length === 0) return null;
    return [...ownBookings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
  }, [ownBookings]);

  const canBook = !!(selectedDate && selectedTime && selectedServices.length > 0 && contactForm.name && contactForm.phone);

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans">
      <div className="w-full bg-gray-100 min-h-screen">
        {/* В режиме мастера клиентская шапка не рендерится: панель журнала идёт от верхнего края */}
        {mode !== 'journal' && (
          <Header
            activeBrand={activeBrand}
            onBrandChange={setActiveBrand}
            onLogoTap={handleLogoTap}
          />
        )}

        {mode !== 'journal' && (
          <PwaInstallBanner
            deferredPrompt={deferredPrompt}
            onInstalled={() => setDeferredPrompt(null)}
            onManualInstall={() => setShowInstallHelp(true)}
          />
        )}

        {showInstallHelp && (
          <InstallGuideModal
            onClose={() => setShowInstallHelp(false)}
            deferredPrompt={deferredPrompt}
            onDirectInstall={handleDirectInstall}
          />
        )}

        <main className={mode === 'journal' ? '' : 'pb-20'}>
          {mode === 'journal' ? (
            <JournalMode
              bookings={bookings}
              onAddManual={openManualAdd}
              onCellAction={handleCellAction}
              onDetailsOpen={openDetails}
              selectedJournalDate={selectedJournalDate}
              onJournalDateChange={setSelectedJournalDate}
              filterBrand={filterBrand}
              onFilterChange={setFilterBrand}
              onUpdateBooking={handleUpdateBooking}
              onDeleteBooking={handleDeleteBooking}
              services={services}
              onSaveService={handleSaveService}
              onDeleteService={handleDeleteService}
              scheduleSettings={scheduleSettings}
              onUpdateSchedule={handleUpdateSchedule}
              clients={clients}
              onSaveClient={handleSaveClient}
              onDeleteClient={handleDeleteClient}
              onClientMode={handleSwitchToClient}
              onSignOut={handleSignOut}
            />
          ) : isSubmitted && currentBooking ? (
            <Confirmation booking={currentBooking} onNew={handleNewBooking} />
          ) : (
            <div>
              {nearestUserBooking && (
                <NearestBooking booking={nearestUserBooking} onCancel={handleCancelNearest} />
              )}

              <StepServices
                brand={activeBrand}
                selected={selectedServices}
                onToggle={handleServiceToggle}
                onOpenTimeSelection={handleOpenTimeSelection}
                services={services}
                isBookingSectionVisible={isBookingSectionVisible}
              />

              {selectedServices.length > 0 && isTimeSelectionOpen && (
                <div ref={calendarSectionRef} className="scroll-mt-24">
                  <StepDateTime
                    selectedDate={selectedDate}
                    selectedTime={selectedTime}
                    onDateChange={handleDateChangeClient}
                    onTimeChange={handleTimeChangeClient}
                    blockedMap={blockedMap}
                    bookings={bookings}
                    services={services}
                    workingHours={workingHours}
                    daysOff={scheduleSettings.daysOff}
                  />
                </div>
              )}

              {isFormMounted && (
                <div
                  className={`transition-all duration-300 overflow-hidden ${isFormExpanded ? 'max-h-[900px] opacity-100' : 'max-h-0 opacity-0 pointer-events-none'
                    }`}
                >
                  <StepContact
                    formData={contactForm}
                    onChange={handleContactChange}
                    selectedDate={selectedDate}
                    selectedTime={selectedTime}
                    onBook={handleBook}
                    canBook={!!canBook}
                    validationError={validationError}
                    innerRef={bookingFormRef}
                  />
                </div>
              )}
            </div>
          )}
        </main>

        <AuthModal
          isOpen={isAuthModalOpen}
          onClose={() => setIsAuthModalOpen(false)}
        />

        <ManualAddModal
          isOpen={isManualOpen}
          onClose={() => setIsManualOpen(false)}
          onSave={handleSaveManual}
          prefillTime={prefillTime}
          prefillBrand={prefillBrand}
          prefillDate={prefillDate}
          clients={clients}
          services={services}
          onSaveClient={handleSaveClient}
        />

        <PersonalEventModal
          isOpen={isPersonalEventOpen}
          onClose={() => setIsPersonalEventOpen(false)}
          onSave={handleSaveManual}
          prefillTime={prefillTime}
          prefillBrand={prefillBrand}
          prefillDate={prefillDate}
        />

        <ActionBottomSheet
          isOpen={!!actionSheetData}
          time={actionSheetData?.time || ''}
          dateLabel={actionSheetData ? formatDateLabel(actionSheetData.date) : ''}
          existingBooking={actionSheetData?.existingBooking || null}
          onClose={() => setActionSheetData(null)}
          onEditExisting={handleActionSheetEditExisting}
          onBookClient={handleActionSheetBookClient}
          onCreatePersonal={handleActionSheetCreatePersonal}
        />

        {detailsBooking && (
          <BookingDetailsModal
            isOpen={!!detailsBooking}
            onClose={() => setDetailsBooking(null)}
            booking={detailsBooking}
            onUpdate={handleUpdateBooking}
            onDelete={handleDeleteBooking}
            services={services}
          />
        )}
      </div>
    </div>
  );
};

export default App;

