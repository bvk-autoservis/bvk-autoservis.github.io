import type { Booking, BookingStatus, BrandType, Client, ScheduleSettings, Service } from '../types';

// Строка из PostgREST (snake_case) без сгенерированных типов БД.
type Row = Record<string, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return !!value && UUID_RE.test(value);
}

function toBrand(value: unknown): BrandType {
  return value === 'gbo' ? 'gbo' : 'bvk';
}

// ===== Service =====

export interface ServiceRow {
  id: string;
  name: string;
  price: string;
  duration: number;
  brand: BrandType;
  sort_order: number;
  is_active: boolean;
}

export function serviceFromRow(row: Row): Service {
  return {
    id: String(row.id),
    name: row.name ?? '',
    price: row.price ?? '',
    duration: Number(row.duration) || 0,
    brand: toBrand(row.brand),
  };
}

export function serviceToRow(service: Service, sortOrder: number): ServiceRow {
  return {
    id: service.id,
    name: service.name,
    price: service.price,
    duration: service.duration,
    brand: service.brand,
    sort_order: sortOrder,
    is_active: true,
  };
}

// ===== Booking =====

export interface BookingRow {
  id?: string;
  brand: BrandType;
  services: string[];
  service_name: string;
  total_price: number;
  car_make: string;
  car_model: string;
  date: string;
  time: string;
  name: string;
  phone: string;
  comment: string;
  status: BookingStatus;
  type: 'client' | 'personal';
  end_time: string | null;
  duration: number | null;
  color: string | null;
  is_demo: boolean;
}

export function bookingFromRow(row: Row): Booking {
  return {
    id: String(row.id),
    brand: toBrand(row.brand),
    services: Array.isArray(row.services) ? (row.services as string[]) : [],
    serviceName: row.service_name ?? '',
    totalPrice: Number(row.total_price) || 0,
    carMake: row.car_make ?? '',
    carModel: row.car_model ?? '',
    date: String(row.date ?? ''),
    time: row.time ?? '',
    name: row.name ?? '',
    phone: row.phone ?? '',
    comment: row.comment ?? '',
    status: (row.status ?? 'pending') as BookingStatus,
    createdAt: row.created_at ?? '',
    type: row.type === 'personal' ? 'personal' : 'client',
    endTime: row.end_time || undefined,
    duration: typeof row.duration === 'number' ? row.duration : undefined,
    color: row.color || undefined,
  };
}

export function bookingToRow(booking: Booking): BookingRow {
  return {
    // Локальные id вида Date.now() не являются uuid — в этом случае PK генерирует БД.
    ...(isUuid(booking.id) ? { id: booking.id } : {}),
    brand: booking.brand,
    services: booking.services ?? [],
    service_name: booking.serviceName ?? '',
    total_price: booking.totalPrice ?? 0,
    car_make: booking.carMake ?? '',
    car_model: booking.carModel ?? '',
    date: booking.date,
    time: booking.time,
    name: booking.name ?? '',
    phone: booking.phone ?? '',
    comment: booking.comment ?? '',
    status: booking.status,
    type: booking.type === 'personal' ? 'personal' : 'client',
    end_time: booking.endTime ?? null,
    duration: typeof booking.duration === 'number' ? booking.duration : null,
    color: booking.color ?? null,
    is_demo: false,
  };
}

// Для UPDATE: id, created_at и is_demo не перезаписываем.
export function bookingUpdateRow(booking: Booking) {
  const { id: _id, is_demo: _isDemo, ...row } = bookingToRow(booking);
  return row;
}

// ===== Client =====

export interface ClientRow {
  id?: string;
  name: string;
  phone: string;
  car_make: string | null;
  car_model: string | null;
}

export function clientFromRow(row: Row): Client {
  return {
    id: String(row.id),
    name: row.name ?? '',
    phone: row.phone ?? '',
    carMake: row.car_make || undefined,
    carModel: row.car_model || undefined,
  };
}

export function clientToRow(client: Client): ClientRow {
  return {
    ...(isUuid(client.id) ? { id: client.id } : {}),
    name: client.name ?? '',
    phone: client.phone ?? '',
    car_make: client.carMake ?? null,
    car_model: client.carModel ?? null,
  };
}

// ===== ScheduleSettings =====

export interface ScheduleSettingsRow {
  id: 1;
  start_time: string;
  end_time: string;
  days_off: number[];
}

export function scheduleFromRow(row: Row): ScheduleSettings {
  return {
    startTime: row.start_time ?? '09:00',
    endTime: row.end_time ?? '21:00',
    daysOff: Array.isArray(row.days_off) ? (row.days_off as number[]) : [0, 6],
  };
}

export function scheduleToRow(settings: ScheduleSettings): ScheduleSettingsRow {
  return {
    id: 1,
    start_time: settings.startTime,
    end_time: settings.endTime,
    days_off: settings.daysOff,
  };
}
