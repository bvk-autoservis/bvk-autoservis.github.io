-- Стартовый каталог услуг: 13 позиций BVK-AUTOSERVIS + 7 позиций МирГбоСПб.
-- Идемпотентно: повторный запуск обновляет существующие строки.
insert into public.services (id, name, price, duration, brand, sort_order, is_active)
values
  ('oil',             'Замена масла и фильтров',                  '1200 ₽',      60,  'bvk', 1,  true),
  ('brake',           'Замена передних тормозных колодок',         '1200 ₽',      60,  'bvk', 2,  true),
  ('brake-disc',      'Замена тормозных дисков',                   'от 2500 ₽',   120, 'bvk', 3,  true),
  ('susp',            'Диагностика подвески',                      '1000 ₽',      60,  'bvk', 4,  true),
  ('grm',             'Замена ГРМ',                                'от 6500 ₽',   240, 'bvk', 5,  true),
  ('steering',        'Ремонт рулевой рейки',                      'от 4000 ₽',   180, 'bvk', 6,  true),
  ('diag',            'Компьютерная диагностика двигателя',        '1000 ₽',      60,  'bvk', 7,  true),
  ('spark',           'Замена свечей зажигания',                   '1200 ₽',      60,  'bvk', 8,  true),
  ('clutch',          'Замена сцепления',                          'от 6000 ₽',   240, 'bvk', 9,  true),
  ('alignment',       'Регулировка сход-развала',                  '2000 ₽',      60,  'bvk', 10, true),
  ('radiator',        'Промывка радиаторов',                       '2500 ₽',      120, 'bvk', 11, true),
  ('antifreeze',      'Замена антифриза',                          '1500 ₽',      60,  'bvk', 12, true),
  ('ac-refill',       'Заправка автокондиционера',                 '2500 ₽',      90,  'bvk', 13, true),
  ('gbo-diag',        'Компьютерная настройка ГБО',                '1000 ₽',      60,  'gbo', 14, true),
  ('gbo-to',          'Замена газовых фильтров (ТО ГБО)',          '1800 ₽',      60,  'gbo', 15, true),
  ('gbo-install',     'Установка ГБО 4 поколения',                 'от 38 000 ₽', 360, 'gbo', 16, true),
  ('gbo-injectors',   'Диагностика и чистка газовых форсунок',     'от 2500 ₽',   120, 'gbo', 17, true),
  ('gbo-repair',      'Замена редуктора ГБО',                      'от 3500 ₽',   120, 'gbo', 18, true),
  ('gbo-inspection',  'Опрессовка и освидетельствование баллона',  '2500 ₽',      60,  'gbo', 19, true),
  ('gbo-valves',      'Регулировка клапанов под ГБО',              'от 3000 ₽',   120, 'gbo', 20, true)
on conflict (id) do update set
  name       = excluded.name,
  price      = excluded.price,
  duration   = excluded.duration,
  brand      = excluded.brand,
  sort_order = excluded.sort_order,
  is_active  = true;
