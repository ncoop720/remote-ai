// Runs in the dashboard window before the page (sandboxed, bundled to CommonJS). Gives the page
// what only the desktop app can do, as window.remoteAI.
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/types.js';

const bridge: DesktopBridge = {
  desktop: true,
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('remote-ai:pick-folder') as Promise<string | null>,
};

contextBridge.exposeInMainWorld('remoteAI', bridge);
