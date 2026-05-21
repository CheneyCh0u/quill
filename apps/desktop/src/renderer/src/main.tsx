import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SettingsApp from './settings/SettingsApp'
import './index.css'

// The same renderer bundle hosts both the main editor and the settings
// window — main differentiates by appending `?settings=1` when launching the
// settings BrowserWindow. Single-bundle / single-entry keeps build config
// simple; the settings UI only mounts the providers it actually needs.
const isSettings = new URLSearchParams(window.location.search).has('settings')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isSettings ? <SettingsApp /> : <App />}</React.StrictMode>
)
