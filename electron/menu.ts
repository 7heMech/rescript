import { app, Menu, type MenuItemConstructorOptions } from "electron";

const isMac = process.platform === "darwin";

/** Mirror of the renderer's ProjectMeta, trimmed to what the menu draws. */
export interface RecentProject {
  id: string;
  name: string;
}

/** Anything the menu asks the renderer to do. Mirrored in types/rescript-desktop.d.ts. */
export type MenuCommand =
  | { type: "open-file" }
  | { type: "open-project"; id: string }
  | { type: "clear-recents" }
  /** Leave the editor for the upload screen (a close request, intercepted). */
  | { type: "close-project" };

/** The renderer owns the project list (it lives in IndexedDB); this is the last
 *  snapshot it pushed, kept so the menu can be rebuilt without asking again. */
let recents: RecentProject[] = [];

/** How many entries the "Recent Projects" submenu shows before it gets unwieldy. */
const MAX_RECENT_ITEMS = 10;

/** Set by main.ts — routes a command to a window, opening one if none is left
 *  (the menu stays alive on macOS after the last window closes). */
let dispatch: (command: MenuCommand) => void = () => {};

function send(command: MenuCommand): void {
  dispatch(command);
}

function fileMenu(): MenuItemConstructorOptions {
  const [last] = recents;
  return {
    label: "File",
    submenu: [
      {
        label: "Open Project…",
        accelerator: "CmdOrCtrl+O",
        click: () => send({ type: "open-file" }),
      },
      {
        label: "Reopen Last Project",
        accelerator: "Shift+CmdOrCtrl+O",
        enabled: last !== undefined,
        click: () => {
          if (last) send({ type: "open-project", id: last.id });
        },
      },
      {
        label: "Recent Projects",
        submenu:
          recents.length === 0
            ? [{ label: "No Recent Projects", enabled: false }]
            : [
                ...recents.slice(0, MAX_RECENT_ITEMS).map((p) => ({
                  label: p.name,
                  click: () => send({ type: "open-project", id: p.id }),
                })),
                { type: "separator" as const },
                {
                  label: "Clear Recent Projects",
                  click: () => send({ type: "clear-recents" }),
                },
              ],
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  };
}

/** Full application menu. Everything outside File is the Electron default —
 *  replacing the menu drops the built-in one wholesale, so it has to be restated. */
function template(): MenuItemConstructorOptions[] {
  return [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    fileMenu(),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: "delete" },
              { type: "separator" },
              { role: "selectAll" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ] satisfies MenuItemConstructorOptions[])
          : ([{ role: "close" }] satisfies MenuItemConstructorOptions[])),
      ],
    },
  ];
}

export function buildAppMenu(
  commandDispatcher?: (command: MenuCommand) => void
): void {
  if (commandDispatcher) dispatch = commandDispatcher;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}

/** Replace the recent list and redraw the menu. Called whenever the renderer's
 *  IndexedDB project list changes (open, autosave, delete). */
export function setRecentProjects(next: RecentProject[]): void {
  recents = next;
  buildAppMenu();
}
