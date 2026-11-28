import React, { useEffect, useRef, useState } from 'react';

/**
 * Нижняя мобильная плашка «Установить приложение».
 *
 * Показывается только в мобильном браузере, только если приложение ещё не установлено
 * и пользователь не закрывал плашку в последние 3 дня.
 */
const PWA_BANNER_CLOSED_KEY = 'bvk_pwa_banner_closed';
const CLOSED_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SHOW_DELAY_MS = 1500;
const HIDE_ANIMATION_MS = 350;

const isMobileBrowser = (): boolean => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

const isInstalledApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const runsStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches;
  return runsStandalone || (navigator as any).standalone === true;
};

const wasClosedRecently = (): boolean => {
  try {
    const raw = localStorage.getItem(PWA_BANNER_CLOSED_KEY);
    if (!raw) return false;
    const closedAt = Number(raw);
    if (!Number.isFinite(closedAt)) return false;
    return Date.now() - closedAt < CLOSED_TTL_MS;
  } catch {
    return false;
  }
};

const rememberClosed = () => {
  try {
    localStorage.setItem(PWA_BANNER_CLOSED_KEY, String(Date.now()));
  } catch {
    // приватный режим/нет доступа к хранилищу — просто не запоминаем
  }
};

interface PwaInstallBannerProps {
  deferredPrompt: any;
  onInstalled: () => void;
  onManualInstall: () => void;
}

const PwaInstallBanner: React.FC<PwaInstallBannerProps> = ({
  deferredPrompt,
  onInstalled,
  onManualInstall,
}) => {
  const [mounted, setMounted] = useState(false);
  const [slidIn, setSlidIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  // Через 1.5 с после открытия страницы — плавный выезд снизу
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isMobileBrowser() || isInstalledApp() || wasClosedRecently()) return;
    const showTimer = window.setTimeout(() => {
      setMounted(true);
      const slideTimer = window.setTimeout(() => setSlidIn(true), 30);
      hideTimerRef.current = slideTimer;
    }, SHOW_DELAY_MS);
    return () => window.clearTimeout(showTimer);
  }, []);

  useEffect(
    () => () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    },
    []
  );

  const hide = (remember: boolean) => {
    if (remember) rememberClosed();
    setSlidIn(false);
    window.setTimeout(() => setMounted(false), HIDE_ANIMATION_MS);
  };

  const handleInstall = async () => {
    if (busy) return;
    if (deferredPrompt && typeof deferredPrompt.prompt === 'function') {
      setBusy(true);
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice?.outcome === 'accepted') {
          onInstalled();
          hide(false);
          return;
        }
        setBusy(false);
        return;
      } catch {
        // Браузер не отдал нативный диалог — показываем ручную инструкцию
        setBusy(false);
        onManualInstall();
        hide(false);
        return;
      }
    }
    // iOS Safari, Telegram/ВК и прочие встроенные браузеры: пошаговая инструкция
    onManualInstall();
    hide(false);
  };

  if (!mounted) return null;

  return (
    <div
      className={`fixed bottom-3 left-3 right-3 z-40 max-w-md mx-auto transition-all duration-300 ease-out ${
        slidIn ? 'translate-y-0 opacity-100' : 'translate-y-[150%] opacity-0'
      }`}
    >
      <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#1C1E24] p-3 shadow-2xl">
        <img src="/icon-192.png" alt="BVK-GBO" className="h-11 w-11 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-tight text-white">Установите приложение BVK-GBO</p>
          <p className="mt-0.5 text-[11px] leading-tight text-gray-400">
            Быстрая запись в 1 клик с главного экрана
          </p>
        </div>
        <button
          onClick={handleInstall}
          disabled={busy}
          className="shrink-0 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-60"
        >
          {busy ? '…' : 'Установить'}
        </button>
        <button
          onClick={() => hide(true)}
          aria-label="Закрыть"
          className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm text-gray-400 transition hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

export default PwaInstallBanner;
