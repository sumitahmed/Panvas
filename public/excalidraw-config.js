// Excalidraw's split chunks and fonts are packaged with Panvas so the local
// workspace starts deterministically without a network request.
// Anchor to this packaged script, not the current SPA route when a canvas opens.
window.EXCALIDRAW_ASSET_PATH = new URL('./', document.currentScript.src).href;
