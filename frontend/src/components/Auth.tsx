import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { User } from '../types';
import { safeFetch } from '../utils';

interface AuthProps {
  onLoginSuccess: (user: User) => void;
}

export const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authError, setAuthError] = useState('');

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = isLogin 
      ? { email, password } 
      : { email, password, displayName };

    try {
      const res = await safeFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Authentication failed');
      }

      const data: User = await res.json();
      localStorage.setItem('manga_user', JSON.stringify(data));
      onLoginSuccess(data);
      navigate('/');
      setEmail('');
      setPassword('');
      setDisplayName('');
    } catch (err: unknown) { // Fixed: Specify correct type catch(err: unknown) to avoid strict 'any' lint warning
      const message = err instanceof Error ? err.message : String(err);
      setAuthError(message || 'Something went wrong');
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass">
        <div className="auth-header">
          <h2>{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
          <p>{isLogin ? 'Access your translation workspace' : 'Get started by creating a local user'}</p>
        </div>
        <form onSubmit={handleAuthSubmit}>
          {!isLogin && (
            <div className="form-group">
              <label className="form-label">Display Name</label>
              <input 
                type="text" 
                className="form-input" 
                value={displayName} 
                onChange={e => setDisplayName(e.target.value)} 
                placeholder="John Doe" 
                required 
              />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input 
              type="email" 
              className="form-input" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              placeholder="admin@manga.local" 
              required 
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input 
              type="password" 
              className="form-input" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              placeholder="••••••••" 
              required 
            />
          </div>

          {authError && <div style={{ color: 'var(--error)', fontSize: '13px', marginBottom: '16px' }}>{authError}</div>}

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginBottom: '16px' }}>
            {isLogin ? 'Sign In' : 'Sign Up'}
          </button>
          
          <button type="button" className="btn btn-text" onClick={() => setIsLogin(!isLogin)} style={{ width: '100%' }}>
            {isLogin ? "Don't have an account? Sign Up" : "Already have an account? Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
};
