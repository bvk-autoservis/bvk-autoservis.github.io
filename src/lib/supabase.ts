import { createClient } from '@supabase/supabase-js';
import type { Booking, Client, ScheduleSettings, Service } from '../types';
import {
  bookingFromRow,
  bookingToRow,
  bookingUpdateRow,
  clientFromRow,
  clientToRow,
  isUuid,
  scheduleFromRow,
  scheduleToRow,
  serviceFromRow,
  serviceToRow,
} from './mappers';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Приложение продолжит собираться, но запросы к БД будут падать —
  // значения задаются в .env (см. .env.example).
  console.error('Supabase: не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env');
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'bvk_master_session',
    },
  }
);

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  startTime: '09:00',
  endTime: '21:00',
  daysOff: [0, 6],
};

// ===== Стартовый каталог услуг =====

export const INITIAL_SERVICES: Service[] = [
  // BVK-AUTOSERVIS — слесарный ремонт
  { id: 'oil', name: 'Замена масла и фильтров', price: '1200 ₽', duration: 60, brand: 'bvk' },
  { id: 'brake', name: 'Замена передних тормозных колодок', price: '1200 ₽', duration: 60, brand: 'bvk' },
  { id: 'brake-disc', name: 'Замена тормозных дисков', price: 'от 2500 ₽', duration: 120, brand: 'bvk' },
  { id: 'susp', name: 'Диагностика подвески', price: '1000 ₽', duration: 60, brand: 'bvk' },
  { id: 'grm', name: 'Замена ГРМ', price: 'от 6500 ₽', duration: 240, brand: 'bvk' },
  { id: 'steering', name: 'Ремонт рулевой рейки', price: 'от 4000 ₽', duration: 180, brand: 'bvk' },
  { id: 'diag', name: 'Компьютерная диагностика двигателя', price: '1000 ₽', duration: 60, brand: 'bvk' },
  { id: 'spark', name: 'Замена свечей зажигания', price: '1200 ₽', duration: 60, brand: 'bvk' },
  { id: 'clutch', name: 'Замена сцепления', price: 'от 6000 ₽', duration: 240, brand: 'bvk' },
  { id: 'alignment', name: 'Регулировка сход-развала', price: '2000 ₽', duration: 60, brand: 'bvk' },
  { id: 'radiator', name: 'Промывка радиаторов', price: '2500 ₽', duration: 120, brand: 'bvk' },
  { id: 'antifreeze', name: 'Замена антифриза', price: '1500 ₽', duration: 60, brand: 'bvk' },
  { id: 'ac-refill', name: 'Заправка автокондиционера', price: '2500 ₽', duration: 90, brand: 'bvk' },
  // МирГбоСПб — газобаллонное оборудование
  { id: 'gbo-diag', name: 'Компьютерная настройка ГБО', price: '1000 ₽', duration: 60, brand: 'gbo' },
  { id: 'gbo-to', name: 'Замена газовых фильтров (ТО ГБО)', price: '1800 ₽', duration: 60, brand: 'gbo' },
  { id: 'gbo-install', name: 'Установка ГБО 4 поколения', price: 'от 38 000 ₽', duration: 360, brand: 'gbo' },
  { id: 'gbo-injectors', name: 'Диагностика и чистка газовых форсунок', price: 'от 2500 ₽', duration: 120, brand: 'gbo' },
  { id: 'gbo-repair', name: 'Замена редуктора ГБО', price: 'от 3500 ₽', duration: 120, brand: 'gbo' },
  { id: 'gbo-inspection', name: 'Опрессовка и освидетельствование баллона', price: '2500 ₽', duration: 60, brand: 'gbo' },
  { id: 'gbo-valves', name: 'Регулировка клапанов под ГБО', price: 'от 3000 ₽', duration: 120, brand: 'gbo' },
];

// ===== Services =====

/**
 * Активные услуги из таблицы `services`.
 * Если таблица пустая — заливаем стартовый каталог (upsert).
 * У анонимного клиента нет прав на INSERT: ошибка заливки не критична,
 * каталог в этом случае отдаётся из константы.
 */
export async function fetchServices(): Promise<Service[]> {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  if (data && data.length > 0) return data.map(serviceFromRow);

  // Заливка стартового каталога доступна только мастеру: у анонимного
  // клиента RLS запрещает INSERT, поэтому не шлём заведомо 401-запрос.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return INITIAL_SERVICES;

  const rows = INITIAL_SERVICES.map((service, index) => serviceToRow(service, index + 1));
  const { error: seedError } = await supabase.from('services').upsert(rows, { onConflict: 'id' });
  if (seedError) {
    console.warn('Supabase: не удалось залить стартовые услуги', seedError);
    return INITIAL_SERVICES;
  }
  return INITIAL_SERVICES;
}

/**
 * Создание или изменение одной услуги (мастер).
 * Возвращает реальную строку из БД (`.select().single()`), а не локальную копию.
 * sort_order создаётся/берётся из БД, is_active всегда true — иначе политика
 * services_read (using is_active) скрывает услугу и у клиента, и у мастера.
 */
export async function saveService(service: Service): Promise<Service> {
  const { data: current, error: currentError } = await supabase
    .from('services')
    .select('sort_order')
    .eq('id', service.id)
    .maybeSingle();
  if (currentError) throw currentError;

  let sortOrder = current?.sort_order;
  if (typeof sortOrder !== 'number') {
    const { data: last, error: lastError } = await supabase
      .from('services')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;
    sortOrder = (typeof last?.sort_order === 'number' ? last.sort_order : 0) + 1;
  }

  const { data, error } = await supabase
    .from('services')
    .upsert(serviceToRow(service, sortOrder), { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return serviceFromRow(data);
}

/** Удаление одной услуги (мастер) — без полной перезаписи каталога. */
export async function deleteService(id: string): Promise<void> {
  const { error } = await supabase.from('services').delete().eq('id', id);
  if (error) throw error;
}

// ===== Schedule settings (синглтон id = 1) =====

export async function fetchScheduleSettings(): Promise<ScheduleSettings> {
  const { data, error } = await supabase
    .from('schedule_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return DEFAULT_SCHEDULE;
  return scheduleFromRow(data);
}

export async function updateScheduleSettings(settings: ScheduleSettings): Promise<void> {
  const { error } = await supabase
    .from('schedule_settings')
    .update(scheduleToRow(settings))
    .eq('id', 1);
  if (error) throw error;
}

// ===== Clients (только авторизованный мастер) =====

export async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(clientFromRow);
}

export async function saveClient(client: Client): Promise<Client> {
  if (isUuid(client.id)) {
    const { data, error } = await supabase
      .from('clients')
      .update(clientToRow(client))
      .eq('id', client.id)
      .select()
      .single();
    if (error) throw error;
    return clientFromRow(data);
  }

  const { data, error } = await supabase
    .from('clients')
    .insert(clientToRow(client))
    .select()
    .single();
  if (error) throw error;
  return clientFromRow(data);
}

export async function deleteClient(id: string): Promise<void> {
  const { error } = await supabase.from('clients').delete().eq('id', id);
  if (error) throw error;
}

// ===== Bookings =====

/** Полная загрузка записей — доступна только мастеру (RLS). */
export async function fetchBookings(): Promise<Booking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('date', { ascending: true })
    .order('time', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(bookingFromRow);
}

/** Создание записи клиентом: SELECT закрыт RLS, поэтому insert без .select(). */
export async function createPublicBooking(booking: Booking): Promise<void> {
  const { error } = await supabase.from('bookings').insert(bookingToRow(booking));
  if (error) throw error;
}

/** Создание записи мастером: возвращаем строку с id, сгенерированным БД. */
export async function createBooking(booking: Booking): Promise<Booking> {
  const { data, error } = await supabase
    .from('bookings')
    .insert(bookingToRow(booking))
    .select()
    .single();
  if (error) throw error;
  return bookingFromRow(data);
}

export async function updateBookingRecord(booking: Booking): Promise<Booking> {
  const { data, error } = await supabase
    .from('bookings')
    .update(bookingUpdateRow(booking))
    .eq('id', booking.id)
    .select()
    .single();
  if (error) throw error;
  return bookingFromRow(data);
}

export async function deleteBookingRecord(id: string): Promise<void> {
  const { error } = await supabase.from('bookings').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Занятые слоты для анонимного клиента: обезличенная RPC-функция
 * get_busy_slots(p_date) возвращает только час и бренд (без ПДн).
 */
export async function fetchBusySlots(date: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.rpc('get_busy_slots', { p_date: date });
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ hour: string; brand: string }>) {
    if (row?.hour) map.set(row.hour, row.brand);
  }
  return map;
}
