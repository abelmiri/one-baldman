// Keep Vite's development server and hot reload outside the offline cache.
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const register = () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(error => {
      console.warn('Offline game registration failed:', error)
    })
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
