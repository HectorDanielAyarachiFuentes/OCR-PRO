import browserAPI from './browser-api.js';
import { getNotes, saveNotes } from './storage-manager.js';

// Al hacer clic en el ícono de la extensión, lanzar el OCR directamente
browserAPI.action.onClicked.addListener((tab) => {
  handleBackgroundOCR(tab);
});

// Escuchar mensajes del módulo OCR
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // --- Eventos del Módulo OCR ---
  if (message.evt === '_bootStrapResources') {
    (async () => {
      try {
        const configRes = await fetch(browserAPI.runtime.getURL('OCR/config/config.json'));
        const config = await configRes.text();
        const htmlRes = await fetch(browserAPI.runtime.getURL('OCR/dialog.html'));
        const htmlStr = await htmlRes.text();
        sendResponse({ config, htmlStr });
      } catch (e) {
        console.error('Error in _bootStrapResources:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.evt === '_bootStrapMessageDialog') {
    (async () => {
      try {
        const htmlRes = await fetch(browserAPI.runtime.getURL('OCR/message-dialog.html'));
        const htmlStr = await htmlRes.text();
        sendResponse({ htmlStr });
      } catch (e) {
        console.error('Error in _bootStrapMessageDialog:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.evt === 'capture-screen') {
    browserAPI.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 }, (dataURL) => {
      if (browserAPI.runtime.lastError) {
        console.warn('Error en captureVisibleTab:', browserAPI.runtime.lastError.message);
        sendResponse({ error: browserAPI.runtime.lastError.message });
        return;
      }
      browserAPI.tabs.getZoom(sender.tab.id, (zf) => {
        if (browserAPI.runtime.lastError) {
          sendResponse({ dataURL, zf: 1 });
        } else {
          sendResponse({ dataURL, zf });
        }
      });
    });
    return true;
  }

  if (message.evt === 'ready' || message.evt === 'capture-done') {
    isProcessingOCR = false;
    sendResponse({ success: true });
    return true;
  }

  if (message.evt === 'get-best-server') {
    (async () => {
      try {
        const configRes = await fetch(browserAPI.runtime.getURL('OCR/config/config.json'));
        const config = await configRes.json();
        const server = config.ocr_api_list[0];
        sendResponse({ server: server });
      } catch (e) {
        console.error('Error en get-best-server:', e);
        sendResponse({ server: { id: "1" } });
      }
    })();
    return true;
  }

  if (message.evt === 'set-server-responsetime') {
    sendResponse({ success: true });
    return true;
  }

  if (message.evt === 'captureScreenLocalOcr') {
    (async () => {
      try {
        await setupOffscreenDocument();
        const opts = await browserAPI.storage.sync.get(['psmMode']);
        const psmMode = opts.psmMode || 'auto';

        const response = await browserAPI.runtime.sendMessage({
          evt: 'performLocalOCR',
          ocrLang: message.ocrLang,
          imagepath: message.imagepath,
          bestMode: message.bestMode,
          psmMode: psmMode
        });
        sendResponse(response);
      } catch (e) {
        console.error('Error forwarding to offscreen:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.evt === 'open-window') {
    browserAPI.tabs.create({ url: message.url });
    sendResponse({ success: true });
    return true;
  }

  if (message.evt === 'open-settings') {
    browserAPI.tabs.create({ url: browserAPI.runtime.getURL('popup.html?tab=settings') });
    sendResponse({ success: true });
    return true;
  }

  if (message.evt === 'open-app') {
    browserAPI.tabs.create({ url: browserAPI.runtime.getURL('popup.html') });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'autoSaveNote') {
    autoSaveNote(message.content, message.title, message.url);
    sendResponse({ success: true });
    return true;
  }

  if (message.evt === 'saveOCRText') {
    const title = sender.tab ? sender.tab.title : 'OCR';
    const url = sender.tab ? sender.tab.url : '';
    autoSaveNote(message.text, title, url);
    sendResponse({ success: true });
    return true;
  }

  if (message.evt === 'checkDesktopCaptureSoftware') {
    sendResponse({ installed: false });
    return true;
  }

  // Ignorar mensajes no manejados silenciosamente
  return false;
});

async function autoSaveNote(content, title, url) {
  if (!content) return;
  try {
    const notes = await getNotes();
    const now = Date.now();
    const newNote = {
      id: crypto.randomUUID(),
      title: title ? `Copiado: ${title}` : 'Recorte rápido',
      content: content + (url ? `\n\nFuente: ${url}` : ''),
      createdAt: now,
      updatedAt: now
    };
    notes.push(newNote);
    await saveNotes(notes);
    // Avisar al popup para que recargue la lista de notas
    browserAPI.runtime.sendMessage({ action: 'notesUpdated' }).catch(() => {});
  } catch (err) {
    console.error('Error in autoSaveNote:', err);
  }
}

// --- OCR Logic ---
let isProcessingOCR = false;

async function handleBackgroundOCR(tab) {
  if (isProcessingOCR) return { success: false, error: 'Ya hay un proceso en curso.' };
  isProcessingOCR = true;

  try {
    const tabId = tab.id;
    console.log(`[OCR] Iniciando para tab: ${tabId}`);

    // 1. Verificar si podemos inyectar
    try {
      await browserAPI.scripting.executeScript({
        target: { tabId },
        func: () => { console.log("[OCR] Heartbeat test"); return true; }
      });
    } catch (e) {
      isProcessingOCR = false;
      return { success: false, error: 'No se puede inyectar en esta página (restringida o protegida).' };
    }

    // 2. Verificar estado de inyección
    let alreadyInjected = false;
    try {
      const [check] = await browserAPI.scripting.executeScript({
        target: { tabId },
        func: () => typeof window.__ocrScriptsLoaded !== 'undefined'
      });
      alreadyInjected = check && check.result;
    } catch (e) {
      console.warn("[OCR] Error al verificar inyección:", e);
    }

    if (!alreadyInjected) {
      console.log("[OCR] Inyectando scripts...");
      await browserAPI.scripting.executeScript({
        target: { tabId },
        files: [
          'OCR/scripts/crossbrowser.js',
          'OCR/scripts/jquery.min.js',
          'OCR/scripts/tesseract.min.js',
          'OCR/scripts/overlay.js',
          'OCR/scripts/cs.js'
        ]
      });

      await browserAPI.scripting.insertCSS({
        target: { tabId },
        files: ['OCR/styles/cs.css']
      });

      await browserAPI.scripting.executeScript({
        target: { tabId },
        func: () => { window.__ocrScriptsLoaded = true; }
      });

      // Esperar a que el script se inicialice internamente
      await new Promise(r => setTimeout(r, 800));
    }

    // 3. Enviar mensaje con reintentos (Heartbeat)
    let success = false;
    for (let i = 0; i < 5; i++) {
      try {
        console.log(`[OCR] Intentando activar selección (intento ${i + 1})...`);
        const response = await browserAPI.tabs.sendMessage(tabId, { evt: 'enableselection' });
        if (response && response.farewell.includes('OK')) {
          success = true;
          break;
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (!success) {
      throw new Error('No se pudo establecer comunicación con el script de OCR. Por favor, recarga la página.');
    }

    // 4. Precarga silenciosa del motor local
    setupOffscreenDocument().then(() => {
      browserAPI.storage.sync.get(['visualCopyOCRLang', 'ocrEngine'], (opts) => {
        const lang = opts.visualCopyOCRLang || 'spa';
        const bestMode = opts.ocrEngine === 'OcrLocalBest';
        browserAPI.runtime.sendMessage({ evt: 'preloadLocalOCR', ocrLang: lang, bestMode }).catch(() => {});
      });
    }).catch(e => console.warn("[OCR] Precarga fallida:", e));

    setTimeout(() => { isProcessingOCR = false; }, 15000);
    return { success: true };

  } catch (error) {
    console.error("[OCR] Error fatal:", error);
    isProcessingOCR = false;
    return { success: false, error: error.message };
  }
}

let creating;
async function setupOffscreenDocument() {
  // En Firefox, usamos un iframe oculto en el background page como alternativa a offscreen
  if (!browserAPI.offscreen) {
    if (document.getElementById('ocr-bridge-iframe')) return;

    console.log('Firefox detected: Creating OCR bridge iframe...');
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.id = 'ocr-bridge-iframe';
      iframe.src = browserAPI.runtime.getURL('OCR/offscreen.html');
      iframe.style.display = 'none';
      iframe.onload = () => {
        console.log('OCR bridge iframe loaded.');
        resolve();
      };
      document.body.appendChild(iframe);
    });
  }

  const path = 'OCR/offscreen.html';
  const offscreen = browserAPI.offscreen;

  if (offscreen && typeof offscreen.hasDocument === 'function') {
    if (await offscreen.hasDocument()) return;
  }

  if (offscreen && typeof offscreen.createDocument === 'function') {
    if (creating) {
      await creating;
    } else {
      creating = offscreen.createDocument({
        url: path,
        reasons: ['DOM_PARSER'],
        justification: 'Realizar OCR local mediante Tesseract.js',
      });
      await creating;
      creating = null;
    }
  }
}
