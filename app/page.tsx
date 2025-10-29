'use client';

import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Settings = {
  weightKg: number;
  dailyGoalMl: number;
  useRecommendedGoal: boolean;
  intervalMinutes: number;
  wakeTime: string;
  sleepTime: string;
  portionMl: number;
  smartSchedule: boolean;
};

type IntakeEntry = {
  id: string;
  amountMl: number;
  timestamp: number;
};

type HydrationState = {
  dateKey: string;
  intakeEntries: IntakeEntry[];
  remindersTriggered: number;
  manualLogs: number;
};

type ReminderState = {
  isRunning: boolean;
  nextReminderTs: number | null;
  lastTriggeredAt: number | null;
  startedAt: number | null;
};

type NotificationStatus = NotificationPermission | 'unsupported';

const STORAGE_KEYS = {
  settings: 'hydramate:settings',
  hydration: 'hydramate:hydration-state',
  reminder: 'hydramate:reminder-state'
} as const;

const DEFAULT_SETTINGS: Settings = {
  weightKg: 60,
  dailyGoalMl: 2100,
  useRecommendedGoal: true,
  intervalMinutes: 60,
  wakeTime: '06:30',
  sleepTime: '22:30',
  portionMl: 250,
  smartSchedule: true
};

const DEFAULT_HYDRATION_STATE: HydrationState = {
  dateKey: getTodayKey(),
  intakeEntries: [],
  remindersTriggered: 0,
  manualLogs: 0
};

const DEFAULT_REMINDER_STATE: ReminderState = {
  isRunning: false,
  nextReminderTs: null,
  lastTriggeredAt: null,
  startedAt: null
};

function usePersistentState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>, boolean] {
  const [state, setState] = useState<T>(defaultValue);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        setState(parsed);
      }
    } catch (error) {
      console.warn('Gagal membaca data lokal', error);
      setState(defaultValue);
    } finally {
      setReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!ready || typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.warn('Gagal menyimpan data lokal', error);
    }
  }, [key, ready, state]);

  return [state, setState, ready];
}

function getTodayKey(): string {
  return new Date().toISOString().split('T')[0];
}

function formatShortTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatRelative(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) {
    return 'baru saja';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} menit lalu`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} jam lalu`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} hari lalu`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) {
    return '00:00';
  }
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((part) => part.toString().padStart(2, '0')).join(':');
  }
  return [minutes, seconds].map((part) => part.toString().padStart(2, '0')).join(':');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function timeStringToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map((part) => parseInt(part, 10));
  return hours * 60 + minutes;
}

function isWithinTimeWindow(minutes: number, wakeMinutes: number, sleepMinutes: number): boolean {
  if (wakeMinutes === sleepMinutes) {
    return true;
  }
  if (wakeMinutes < sleepMinutes) {
    return minutes >= wakeMinutes && minutes <= sleepMinutes;
  }
  // window melewati tengah malam
  return minutes >= wakeMinutes || minutes <= sleepMinutes;
}

function ensureWithinActiveWindow(timestamp: number, wakeTime: string, sleepTime: string): number {
  const wakeMinutes = timeStringToMinutes(wakeTime);
  const sleepMinutes = timeStringToMinutes(sleepTime);
  const result = new Date(timestamp);

  const alignToWake = () => {
    const dayShift = result.getHours() * 60 + result.getMinutes() > wakeMinutes ? 1 : 0;
    result.setDate(result.getDate() + dayShift);
    result.setHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
  };

  const minutes = result.getHours() * 60 + result.getMinutes();
  if (isWithinTimeWindow(minutes, wakeMinutes, sleepMinutes)) {
    result.setSeconds(0, 0);
    if (result.getTime() < Date.now()) {
      result.setMinutes(result.getMinutes() + 1);
    }
    return result.getTime();
  }

  if (wakeMinutes < sleepMinutes) {
    if (minutes < wakeMinutes) {
      result.setHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
    } else {
      result.setDate(result.getDate() + 1);
      result.setHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
    }
  } else {
    // jendela melewati tengah malam (misal 22:00 - 06:00)
    if (minutes > sleepMinutes && minutes < wakeMinutes) {
      alignToWake();
    }
  }
  result.setSeconds(0, 0);
  return result.getTime();
}

export default function Home() {
  const todayKey = getTodayKey();
  const [settings, setSettings, settingsReady] = usePersistentState<Settings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  const [hydrationState, setHydrationState, hydrationReady] = usePersistentState<HydrationState>(
    STORAGE_KEYS.hydration,
    DEFAULT_HYDRATION_STATE
  );
  const [reminderState, setReminderState, reminderReady] = usePersistentState<ReminderState>(
    STORAGE_KEYS.reminder,
    DEFAULT_REMINDER_STATE
  );
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('default');
  const [toast, setToast] = useState<{ message: string; timestamp: number } | null>(null);
  const [countdown, setCountdown] = useState('--:--');
  const audioContextRef = useRef<AudioContext | null>(null);
  const reminderGateRef = useRef(false);

  const isReady = settingsReady && hydrationReady && reminderReady;

  useEffect(() => {
    if (!hydrationReady) {
      return;
    }
    setHydrationState((prev) => {
      if (prev.dateKey === todayKey) {
        return prev;
      }
      return {
        dateKey: todayKey,
        intakeEntries: [],
        remindersTriggered: 0,
        manualLogs: 0
      };
    });
  }, [hydrationReady, setHydrationState, todayKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!('Notification' in window)) {
      setNotificationStatus('unsupported');
      return;
    }
    setNotificationStatus(Notification.permission);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const register = async () => {
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch (error) {
        console.warn('Gagal mendaftarkan service worker', error);
      }
    };
    register();
  }, []);

  const requestNotificationAccess = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationStatus(permission);
      if (permission === 'denied') {
        setToast({
          message: 'Izin notifikasi ditolak. Pengingat tetap aktif melalui layar.',
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.warn('Tidak dapat meminta izin notifikasi', error);
    }
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const recommendedGoalMl = useMemo(() => Math.round(settings.weightKg * 35), [settings.weightKg]);
  const activeGoalMl = settings.useRecommendedGoal ? recommendedGoalMl : settings.dailyGoalMl;
  const consumedMl = useMemo(
    () => hydrationState.intakeEntries.reduce((total, entry) => total + entry.amountMl, 0),
    [hydrationState.intakeEntries]
  );
  const progressPct = activeGoalMl > 0 ? Math.min(100, Math.round((consumedMl / activeGoalMl) * 100)) : 0;

  const ensureAudioContext = useCallback(async () => {
    if (typeof window === 'undefined') {
      return null;
    }
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const context = audioContextRef.current;
    if (context.state === 'suspended') {
      await context.resume();
    }
    return context;
  }, []);

  const playReminderSound = useCallback(async () => {
    const context = await ensureAudioContext();
    if (!context) {
      return;
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    const now = context.currentTime;
    oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.exponentialRampToValueAtTime(440, now + 0.4);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.65);
  }, [ensureAudioContext]);

  const computeNextReminder = useCallback(
    (fromTs: number): number | null => {
      const sanitizedInterval = clamp(Math.round(settings.intervalMinutes), 15, 360) * 60000;
      if (sanitizedInterval <= 0) {
        return null;
      }
      const smartStartingPoint = settings.smartSchedule
        ? ensureWithinActiveWindow(fromTs + sanitizedInterval, settings.wakeTime, settings.sleepTime)
        : fromTs + sanitizedInterval;
      return smartStartingPoint;
    },
    [settings.intervalMinutes, settings.smartSchedule, settings.sleepTime, settings.wakeTime]
  );

  const triggerReminder = useCallback(async () => {
    const now = Date.now();
    reminderGateRef.current = true;
    setReminderState((prev) => {
      if (!prev.isRunning) {
        return { ...prev, nextReminderTs: null };
      }
      const nextTs = computeNextReminder(now);
      return {
        ...prev,
        nextReminderTs: nextTs,
        lastTriggeredAt: now,
        startedAt: prev.startedAt ?? now
      };
    });
    setHydrationState((prev) => ({
      ...prev,
      remindersTriggered: prev.remindersTriggered + 1
    }));
    setToast({ message: 'Saatnya minum segelas air 💧', timestamp: now });
    if (typeof window !== 'undefined') {
      navigator.vibrate?.([120, 80, 120]);
    }
    await playReminderSound();
    if (typeof window !== 'undefined' && 'Notification' in window && notificationStatus === 'granted') {
      try {
        new Notification('Saatnya Minum Air 💧', {
          body: 'Tetap terhidrasi itu penting! Ambil gelasmu sekarang juga.',
          icon: '/icon-192.png'
        });
      } catch (error) {
        console.warn('Gagal menampilkan notifikasi', error);
      }
    }
  }, [computeNextReminder, notificationStatus, playReminderSound, setHydrationState, setReminderState]);

  useEffect(() => {
    if (!reminderReady) {
      return;
    }
    if (!reminderState.isRunning || !reminderState.nextReminderTs) {
      setCountdown('--:--');
      reminderGateRef.current = false;
      return;
    }

    const updateCountdown = () => {
      const diff = reminderState.nextReminderTs! - Date.now();
      if (diff <= 0) {
        if (!reminderGateRef.current) {
          void triggerReminder();
        }
      } else {
        reminderGateRef.current = false;
        setCountdown(formatDuration(diff));
      }
    };

    updateCountdown();
    const intervalId = window.setInterval(updateCountdown, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [reminderReady, reminderState.isRunning, reminderState.nextReminderTs, triggerReminder]);

  useEffect(() => {
    if (!reminderReady) {
      return;
    }
    if (!reminderState.isRunning) {
      return;
    }
    setReminderState((prev) => {
      if (!prev.isRunning) {
        return prev;
      }
      const nextTs = computeNextReminder(Date.now());
      if (!nextTs || nextTs === prev.nextReminderTs) {
        return prev;
      }
      return {
        ...prev,
        nextReminderTs: nextTs
      };
    });
  }, [computeNextReminder, reminderReady, reminderState.isRunning, setReminderState]);

  const startReminders = useCallback(() => {
    const now = Date.now();
    const nextTs = computeNextReminder(now);
    setReminderState({
      isRunning: true,
      nextReminderTs: nextTs,
      lastTriggeredAt: null,
      startedAt: now
    });
    setToast({ message: 'Pengingat minum aktif 🎯', timestamp: now });
  }, [computeNextReminder, setReminderState]);

  const pauseReminders = useCallback(() => {
    setReminderState((prev) => ({
      ...prev,
      isRunning: false,
      nextReminderTs: null
    }));
    setToast({ message: 'Pengingat dijeda sementara ⏸️', timestamp: Date.now() });
  }, [setReminderState]);

  const skipReminder = useCallback(() => {
    setReminderState((prev) => {
      if (!prev.isRunning) {
        return prev;
      }
      const nextTs = computeNextReminder(Date.now());
      if (!nextTs) {
        return prev;
      }
      return {
        ...prev,
        nextReminderTs: nextTs
      };
    });
    setToast({ message: 'Pengingat berikutnya dijadwalkan ulang 🔁', timestamp: Date.now() });
  }, [computeNextReminder, setReminderState]);

  const logWaterIntake = useCallback(
    (amountMl: number) => {
      const clamped = clamp(Math.round(amountMl), 50, 1000);
      const entry: IntakeEntry = {
        id: `${Date.now()}`,
        amountMl: clamped,
        timestamp: Date.now()
      };
      setHydrationState((prev) => ({
        ...prev,
        intakeEntries: [entry, ...prev.intakeEntries].slice(0, 50),
        manualLogs: prev.manualLogs + 1
      }));
      setToast({ message: `Catatan minum ${clamped} ml tersimpan ✅`, timestamp: Date.now() });
    },
    [setHydrationState]
  );

  const handleSettingsChange = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((prev) => ({
        ...prev,
        [key]: value
      }));
    },
    [setSettings]
  );

  return (
    <main>
      <header className="app-header">
        <div className="chip">
          <DropletIcon className="icon" />
          HydraMate
        </div>
        <h1>Pengingat Minum Air Pintar</h1>
        <p className="subtitle">
          Tetap terhidrasi dengan pengingat adaptif, target harian personal, dan catatan konsumsi air yang tersinkron otomatis.
        </p>
      </header>

      {toast && (
        <div className="notification-banner" role="status">
          <span>{toast.message}</span>
        </div>
      )}

      {notificationStatus !== 'granted' && (
        <div className={clsx('notification-banner', notificationStatus === 'denied' && 'warning')}>
          <span>
            {notificationStatus === 'unsupported'
              ? 'Perangkat ini belum mendukung notifikasi push, namun pengingat dalam aplikasi tetap berjalan.'
              : 'Aktifkan notifikasi agar pengingat muncul walau aplikasi diminimalkan.'}
          </span>
          {notificationStatus === 'default' && (
            <button className="secondary-button" onClick={requestNotificationAccess}>
              Aktifkan
            </button>
          )}
        </div>
      )}

      <section className="cards-grid">
        <article className="card">
          <div className="card-header">
            <TargetIcon />
            <h2>Progres Hidrasi Hari Ini</h2>
          </div>
          <div className="progress-wrapper">
            <div className="progress">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="stats">
              <div className="stat">
                <span className="stat-title">Total diminum</span>
                <span className="stat-value">{consumedMl} ml</span>
              </div>
              <div className="stat">
                <span className="stat-title">Target harian</span>
                <span className="stat-value">{activeGoalMl} ml</span>
              </div>
              <div className="stat">
                <span className="stat-title">Reminder terkirim</span>
                <span className="stat-value">{hydrationState.remindersTriggered}</span>
              </div>
              <div className="stat">
                <span className="stat-title">Catatan manual</span>
                <span className="stat-value">{hydrationState.manualLogs}</span>
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <SettingsIcon />
            <h2>Preferensi Hidrasi</h2>
          </div>
          <form>
            <label>
              Berat badan (kg)
              <input
                type="number"
                inputMode="decimal"
                min={30}
                max={200}
                step={0.1}
                value={settings.weightKg}
                onChange={(event) =>
                  handleSettingsChange('weightKg', clamp(Number(event.target.value) || 0, 30, 200))
                }
              />
            </label>

            <div className="toggle">
              <span>Gunakan rekomendasi otomatis</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.useRecommendedGoal}
                  onChange={(event) => handleSettingsChange('useRecommendedGoal', event.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>

            <label>
              Target harian (ml)
              <input
                type="number"
                min={1000}
                max={6000}
                step={100}
                disabled={settings.useRecommendedGoal}
                value={settings.useRecommendedGoal ? recommendedGoalMl : settings.dailyGoalMl}
                onChange={(event) =>
                  handleSettingsChange('dailyGoalMl', clamp(Number(event.target.value) || 0, 1000, 6000))
                }
              />
              {settings.useRecommendedGoal && (
                <span className="stat-title">Rekomendasi berdasarkan berat badan: {recommendedGoalMl} ml</span>
              )}
            </label>

            <label>
              Porsi sekali minum (ml)
              <input
                type="number"
                min={100}
                max={1000}
                step={50}
                value={settings.portionMl}
                onChange={(event) =>
                  handleSettingsChange('portionMl', clamp(Number(event.target.value) || 0, 100, 1000))
                }
              />
            </label>

            <label>
              Interval pengingat (menit)
              <input
                type="number"
                min={15}
                max={360}
                step={5}
                value={settings.intervalMinutes}
                onChange={(event) =>
                  handleSettingsChange('intervalMinutes', clamp(Number(event.target.value) || 0, 15, 360))
                }
              />
            </label>

            <div className="toggle">
              <span>Sesuaikan dengan jam aktif</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.smartSchedule}
                  onChange={(event) => handleSettingsChange('smartSchedule', event.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>

            {settings.smartSchedule && (
              <div className="stats">
                <label>
                  Jam mulai hari
                  <input
                    type="time"
                    value={settings.wakeTime}
                    onChange={(event) => handleSettingsChange('wakeTime', event.target.value)}
                  />
                </label>
                <label>
                  Jam tidur
                  <input
                    type="time"
                    value={settings.sleepTime}
                    onChange={(event) => handleSettingsChange('sleepTime', event.target.value)}
                  />
                </label>
              </div>
            )}
          </form>
        </article>

        <article className="card">
          <div className="card-header">
            <ClockIcon />
            <h2>Status Pengingat</h2>
          </div>
          <div className="stats">
            <div className="stat">
              <span className="stat-title">Pengingat berikutnya</span>
              <span className="countdown">{reminderState.isRunning && reminderState.nextReminderTs ? countdown : '--:--'}</span>
            </div>
            <div className="stat">
              <span className="stat-title">Terakhir</span>
              <span className="stat-value">
                {reminderState.lastTriggeredAt ? formatRelative(reminderState.lastTriggeredAt) : 'Belum ada' }
              </span>
            </div>
          </div>
          <div className="actions">
            {reminderState.isRunning ? (
              <>
                <button className="primary-button" onClick={pauseReminders}>
                  Jeda Pengingat
                </button>
                <button className="secondary-button" onClick={skipReminder}>
                  Lewati & Jadwalkan Ulang
                </button>
              </>
            ) : (
              <button className="primary-button" onClick={startReminders}>
                Mulai Pengingat
              </button>
            )}
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <GlassIcon />
            <h2>Catatan Minum</h2>
          </div>
          <div className="actions">
            <button className="primary-button" onClick={() => logWaterIntake(settings.portionMl)}>
              Saya minum {settings.portionMl} ml
            </button>
            <button className="secondary-button" onClick={() => logWaterIntake(settings.portionMl / 2)}>
              Setengah gelas ({Math.round(settings.portionMl / 2)} ml)
            </button>
          </div>
          <div className="log-list">
            {hydrationState.intakeEntries.length === 0 ? (
              <div className="empty-state">Belum ada catatan hari ini. Tekan tombol di atas setelah minum air.</div>
            ) : (
              hydrationState.intakeEntries.map((entry) => (
                <div className="log-entry" key={entry.id}>
                  <div>
                    <strong>{entry.amountMl} ml</strong>
                    <div className="log-entry-time">{formatShortTime(entry.timestamp)}</div>
                  </div>
                  <span className="badge">{formatRelative(entry.timestamp)}</span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </main>
  );
}

function DropletIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12.53 2.22a.75.75 0 0 0-1.06 0c-1.8 1.8-7.22 7.63-7.22 12.03a7.75 7.75 0 0 0 15.5 0c0-4.4-5.42-10.23-7.22-12.03Z"
        fill="url(#paint0_linear)"
      />
      <defs>
        <linearGradient id="paint0_linear" x1="5" y1="5" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38bdf8" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 5.25a6.75 6.75 0 1 0 6.75 6.75"
        stroke="#60a5fa"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M12 8.25a3.75 3.75 0 1 0 3.75 3.75" stroke="#93c5fd" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M12 11.25a.75.75 0 1 0 .75.75"
        stroke="#bfdbfe"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="m19.5 3.75-5.25 5.25" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16.5 3h3v3" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
        stroke="#bae6fd"
        strokeWidth="1.5"
      />
      <path
        d="M4.5 12a7.5 7.5 0 0 1 13.258-4.639l2.742-.861-.861 2.742A7.5 7.5 0 0 1 12 19.5m0 0V22"
        stroke="#60a5fa"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 6v6h4.5"
        stroke="#bfdbfe"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M4.75 12a7.25 7.25 0 1 1 14.5 0 7.25 7.25 0 0 1-14.5 0Z"
        stroke="#60a5fa"
        strokeWidth="1.5"
      />
      <path d="M12 2v2" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 4.5 6.5 6" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GlassIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6.75 3.75h10.5l-1.2 14.278a2.25 2.25 0 0 1-2.242 2.022H10.2a2.25 2.25 0 0 1-2.242-2.022L6.75 3.75Z"
        stroke="#93c5fd"
        strokeWidth="1.5"
      />
      <path
        d="M17.25 8.25H6.75l.375 4.469c.555-.208 1.142-.319 1.75-.319 1.694 0 3.284.72 4.516 1.952 1.232-1.232 2.822-1.952 4.516-1.952.608 0 1.195.11 1.75.319l-.407-4.469Z"
        fill="rgba(59,130,246,0.35)"
        stroke="rgba(59,130,246,0.65)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
