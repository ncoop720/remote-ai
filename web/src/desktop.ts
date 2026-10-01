import type { DesktopBridge } from '../../shared/types';

declare global {
  interface Window {
    remoteAI?: DesktopBridge;
  }
}

/** The desktop app's additions when the page runs in its window; null in a browser. */
export const desktopApp: DesktopBridge | null = window.remoteAI?.desktop ? window.remoteAI : null;
