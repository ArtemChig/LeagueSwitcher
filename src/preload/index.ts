/**
 * P3.1 — the contextBridge.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so this file is the only surface the
 * renderer can reach the main process through. It deliberately exposes a fixed list of channels
 * rather than a generic `invoke(channel, ...args)`: a generic bridge lets any renderer code
 * (or anything injected into it) call any handler, which throws away most of the benefit of
 * having a bridge at all.
 */
import { contextBridge, ipcRenderer } from "electron";
import { SWITCH_PROGRESS_CHANNEL, type IpcApi, type SwitchProgressEvent } from "../shared/ipc.js";

const invoke =
  <C extends keyof IpcApi>(channel: C) =>
  (...args: Parameters<IpcApi[C]>): ReturnType<IpcApi[C]> =>
    ipcRenderer.invoke(channel, ...args) as ReturnType<IpcApi[C]>;

const api = {
  listAccounts: invoke("accounts:list"),
  getStatus: invoke("accounts:status"),
  refresh: invoke("accounts:refresh"),
  collect: invoke("accounts:collect"),
  updateAccount: invoke("accounts:update"),
  removeAccount: invoke("accounts:remove"),

  preflight: invoke("switch:preflight"),
  startSwitch: invoke("switch:start"),

  capture: invoke("enrol:capture"),
  assistedEnrol: invoke("enrol:assisted"),

  getCredentials: invoke("credentials:get"),
  saveCredentials: invoke("credentials:save"),

  getApiKeyState: invoke("settings:getApiKey"),
  setApiKey: invoke("settings:setApiKey"),
  openExternal: invoke("settings:openExternal"),
  openDataFolder: invoke("settings:openDataFolder"),
  panicRestore: invoke("settings:panicRestore"),
  takeBaseline: invoke("settings:takeBaseline"),

  getCrest: invoke("assets:crest"),
  getIcon: invoke("assets:icon"),

  /** Subscribe to switch progress. Returns an unsubscribe function. */
  onSwitchProgress(handler: (event: SwitchProgressEvent) => void): () => void {
    const listener = (_e: unknown, payload: SwitchProgressEvent) => handler(payload);
    ipcRenderer.on(SWITCH_PROGRESS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SWITCH_PROGRESS_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

export type PreloadApi = typeof api;
