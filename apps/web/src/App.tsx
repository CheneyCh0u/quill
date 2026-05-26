import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Login } from './pages/Login'
import { Vault } from './pages/Vault'
import { Settings } from './pages/Settings'
import { isAuthenticated } from './lib/auth'
import { onUnauthorized } from './lib/auth-events'

type AuthState = 'unknown' | 'authed' | 'guest'

export function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>('unknown')
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    isAuthenticated().then((ok) => {
      if (cancelled) return
      setAuth(ok ? 'authed' : 'guest')
    })
    return () => {
      cancelled = true
    }
  }, [])

  // After login fires, re-check rather than trusting Login navigated — covers
  // the back/forward refresh case too.
  useEffect(() => {
    if (location.pathname === '/login' && auth === 'authed') {
      navigate('/', { replace: true })
    }
  }, [auth, location.pathname, navigate])

  // Global 401 handler — any vault/agent/providers call that hits 401
  // funnels through notifyUnauthorized() and lands here, so session
  // expiry kicks back to the login screen without a manual refresh.
  useEffect(() => {
    return onUnauthorized(() => {
      setAuth('guest')
      navigate('/login', { replace: true })
    })
  }, [navigate])

  if (auth === 'unknown') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center text-sm text-[var(--ink-faint)]">
        正在加载…
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={auth === 'authed' ? <Vault /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/settings"
        element={auth === 'authed' ? <Settings /> : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
