import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const AuthModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setError(null);
      setIsLoading(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Введите email и пароль');
      return;
    }
    setIsLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setIsLoading(false);
    if (signInError) {
      setError('Не удалось войти: неверный email или пароль');
      return;
    }
    setEmail('');
    setPassword('');
    onClose();
  };

  const inputCls =
    'w-full px-3 py-2 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-purple-500';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
          aria-label="Закрыть"
        >
          ✕
        </button>

        <h2 className="text-lg font-bold text-gray-900">Вход для мастера</h2>
        <p className="text-xs text-gray-500 mt-1 mb-4">Журнал мастера доступен только по паролю</p>

        <label className="block text-xs text-gray-600 mb-1">Email</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className={`${inputCls} mb-3`}
          placeholder="master@example.com"
        />

        <label className="block text-xs text-gray-600 mb-1">Пароль</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className={inputCls}
          placeholder="••••••••"
        />

        {error && <p className="text-xs text-red-600 mt-3">{error}</p>}

        <button
          type="submit"
          disabled={isLoading}
          className={`w-full mt-5 py-2.5 rounded-lg font-medium text-sm text-white transition ${isLoading ? 'bg-purple-400 cursor-default' : 'bg-purple-700 hover:opacity-90'
            }`}
        >
          {isLoading ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </div>
  );
};

export default AuthModal;
