import { contextBridge, ipcRenderer } from 'electron';
import type { IabOverlayCommand, IabOverlayState } from '../../src/types/desktop/iab';

contextBridge.exposeInMainWorld('iabOverlay', Object.freeze({
  getState: (): Promise<IabOverlayState> => ipcRenderer.invoke('iab:overlay:getState'),
  onState: (callback: (state: IabOverlayState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: IabOverlayState): void => callback(state);
    ipcRenderer.on('iab:overlay:state', listener);
    return () => { ipcRenderer.removeListener('iab:overlay:state', listener); };
  },
  command: (command: IabOverlayCommand): Promise<void> => ipcRenderer.invoke('iab:overlay:command', command),
}));
