import { contextBridge, ipcRenderer } from 'electron';
import type { CompanionApi, CompanionState } from '../shared/contracts';
const send = (channel: string, value?: unknown) => ipcRenderer.send(channel, value);
const api: CompanionApi = {
  getState: () => ipcRenderer.invoke('companion:state'),
  checkAgentConnection: () => ipcRenderer.invoke('companion:agent-check'),
  newConversation: () => ipcRenderer.invoke('companion:chat-new'),
  openChat: () => send('companion:chat-open'),
  closeChat: () => send('companion:chat-close'),
  setChatShortcut: (value) => ipcRenderer.invoke('companion:chat-shortcut', value),
  onChatFocus: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('companion:chat-focus', handler);
    return () => ipcRenderer.removeListener('companion:chat-focus', handler);
  },
  askQuestion: (question) => ipcRenderer.invoke('companion:chat-ask', question),
  cancelQuestion: (requestId) => ipcRenderer.invoke('companion:chat-cancel', requestId),
  onState: (listener) => {
    const handler = (_: unknown, state: CompanionState) => listener(state);
    ipcRenderer.on('companion:state', handler);
    return () => ipcRenderer.removeListener('companion:state', handler);
  },
  setHitRegions: (v) => send('companion:hit-regions', v),
  beginPointer: (v) => send('companion:pointer-begin', v),
  movePointer: (v) => send('companion:pointer-move', v),
  endPointer: (v) => send('companion:pointer-end', v),
  cancelPointer: () => send('companion:pointer-cancel'),
  openPanel: (tab) => send('companion:panel-open', tab),
  showContextMenu: () => send('companion:context-menu'),
  activateBubble: (id) => send('companion:bubble-activate', id),
  closePanel: () => send('companion:panel-close'),
  toggleVisibility: () => send('companion:visibility'),
  setWalking: (v) => send('companion:walking', v),
  setAppearance: (v) => ipcRenderer.invoke('companion:appearance', v),
  setWorkSchedule: (v) => ipcRenderer.invoke('companion:work-schedule', v),
  addMemo: (draft) => ipcRenderer.invoke('companion:memo-add', draft),
  updateMemo: (id, draft) => ipcRenderer.invoke('companion:memo-update', { id, draft }),
  setMemoCompleted: (id, completed) => ipcRenderer.invoke('companion:memo-complete', { id, completed }),
  deleteMemo: (id) => ipcRenderer.invoke('companion:memo-delete', id),
  dismissBubble: (id) => ipcRenderer.invoke('companion:bubble-dismiss', id),
  setShortcut: (v) => ipcRenderer.invoke('companion:shortcut', v),
  quit: () => send('companion:quit'),
};
contextBridge.exposeInMainWorld('companion', api);
