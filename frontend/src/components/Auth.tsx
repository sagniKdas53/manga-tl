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
  const [role, setRole] = useState('translator');
  const [isSetupRequired, setIsSetupRequired] = useState(false);
  const [authError, setAuthError] = useState('');

  React.useEffect(() => {
    if (!isLogin) {
      safeFetch('/api/auth/setup-required')
        .then(res => {
          if (res.ok) return res.json();
          throw new Error('Failed to check setup');
        })
        .then(data => {
          if (data.setupRequired) {
            setIsSetupRequired(true);
            setRole('admin');
          } else {
            setIsSetupRequired(false);
            setRole('translator');
          }
        })
        .catch(err => {
          console.error('Error checking setup:', err);
          setIsSetupRequired(false);
          setRole('translator');
        });
    }
  }, [isLogin]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = isLogin 
      ? { email, password } 
      : { email, password, displayName, role };

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
            <>
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
              <div className="form-group">
                <label className="form-label">Account Role</label>
                {isSetupRequired ? (
                  <div className="form-info-box" style={{ padding: '10px 12px', background: 'rgba(235,130,20,0.1)', border: '1px solid rgba(235,130,20,0.3)', borderRadius: '6px', fontSize: '13px', color: '#ffb020' }}>
                    <strong>Administrator</strong> (First user registration forces Admin privileges)
                  </div>
                ) : (
                  <select 
                    className="form-input" 
                    value={role} 
                    onChange={e => setRole(e.target.value)}
                    style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-main)', border: '1px solid var(--border)' }}
                  >
                    <option value="translator" style={{ background: '#222', color: '#fff' }}>Translator</option>
                    <option value="viewer" style={{ background: '#222', color: '#fff' }}>Viewer</option>
                  </select>
                )}
              </div>
            </>
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

export default Auth;
