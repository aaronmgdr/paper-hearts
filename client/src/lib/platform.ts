/** iOS Safari / Home Screen web app detection. */

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ desktop UA
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
}

/** True when launched from the Home Screen icon (standalone display). */
export function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false
  const nav = navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches
  )
}
