import {
  createFigmaConverter,
  type ConvertResult,
} from "@figit/dom-to-figma";
import type {
  CaptureMode,
  CaptureResponse,
  CaptureSettings,
  ResizeWindowResponse,
} from "../shared/messages";
import { resolveViewportWidths } from "../shared/settings";
import { html2figmaClassify, looksLikeTailwind } from "./classify";
import { createHud } from "./hud";
import { createExtensionImageLoader } from "./image-loader";
import { pickElement, removePickerOverlay } from "./picker";
import { prepareDom } from "./prepare-dom";
import { bakeLineHeights } from "./text-metrics";
import {
  applyLayerNames,
  clipboardFromNamedDocument,
  mergeCaptureDocuments,
} from "./rename-merge";

let activeAbort: AbortController | null = null;

function pageRoot(): HTMLElement {
  return document.body ?? document.documentElement;
}

async function writeClipboard(item: ClipboardItem) {
  try {
    await navigator.clipboard.write([item]);
    return;
  } catch {
    // fallback below
  }

  const html = await item.getType("text/html").then((blob) => blob.text());
  await new Promise<void>((resolve, reject) => {
    const onCopy = (event: ClipboardEvent) => {
      event.preventDefault();
      event.clipboardData?.setData("text/html", html);
      event.clipboardData?.setData("text/plain", "Free HTML to Figma capture");
      resolve();
    };
    document.addEventListener("copy", onCopy, { once: true });
    if (!document.execCommand("copy")) {
      document.removeEventListener("copy", onCopy);
      reject(new Error("Clipboard write was blocked by the page."));
    }
  });
}

async function resizeWindow(width: number | null): Promise<number | undefined> {
  const response = (await chrome.runtime.sendMessage({
    type: "HTML2FIGMA_RESIZE_WINDOW",
    width,
  })) as ResizeWindowResponse | undefined;

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to resize window.");
  }
  return response.previousWidth;
}

async function settleViewport(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Capture cancelled", "AbortError");
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  await new Promise((r) => window.setTimeout(r, 280));
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise((r) => window.setTimeout(r, 1000)),
    ]);
  } catch {
    // ignore
  }
}

function measure(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(
      1,
      Math.round(Math.max(rect.width, element.scrollWidth, element.clientWidth)),
    ),
    height: Math.max(
      1,
      Math.round(
        Math.max(rect.height, element.scrollHeight, element.clientHeight),
      ),
    ),
  };
}

async function convertRoot(
  element: HTMLElement,
  name: string,
  settings: CaptureSettings,
  signal: AbortSignal,
  onAssetProgress: (done: number, total: number) => void,
): Promise<ConvertResult> {
  const size = measure(element);
  const converter = createFigmaConverter({
    layout: settings.layout,
    classify: html2figmaClassify,
    trace: true,
    imageLoader: createExtensionImageLoader({
      signal,
      onProgress: onAssetProgress,
    }),
  });

  // Measure after fonts have settled, separately for every viewport.
  const restoreLineHeights = bakeLineHeights(element);
  try {
    return await converter.convert({
      element,
      width: size.width,
      height: size.height,
      name,
    });
  } finally {
    restoreLineHeights();
  }
}

export function cancelActiveCapture() {
  activeAbort?.abort();
  removePickerOverlay();
}

export async function runCapture(
  mode: CaptureMode,
  settings: CaptureSettings,
): Promise<CaptureResponse> {
  activeAbort?.abort();
  const abort = new AbortController();
  activeAbort = abort;
  const signal = abort.signal;

  const hud = createHud();
  hud.show();
  hud.onCancel(() => {
    abort.abort();
    hud.setError("Cancelled.");
  });

  let restoredWidth: number | null = null;

  try {
    const viewports =
      mode === "multi"
        ? resolveViewportWidths(settings)
        : resolveViewportWidths({
            ...settings,
            viewportPresets: settings.viewportPresets.slice(0, 1),
          });

    // Element pick happens once at current viewport.
    let element: HTMLElement;
    if (mode === "element") {
      hud.setProgress({
        stage: "prepare",
        message: "Click an element on the page…",
        percent: 2,
      });
      element = await pickElement(signal);
    } else {
      element = pageRoot();
    }

    const captures: Array<{
      document: ReturnType<typeof applyLayerNames>;
      x: number;
      name: string;
    }> = [];

    let x = 0;
    const gap = 80;

    for (let i = 0; i < viewports.length; i += 1) {
      if (signal.aborted) {
        throw new DOMException("Capture cancelled", "AbortError");
      }

      const vp = viewports[i];
      const basePercent = 5 + (i / viewports.length) * 80;

      hud.setProgress({
        stage: "prepare",
        message: `Viewport: ${vp.label}`,
        percent: basePercent,
      });

      if (vp.width != null) {
        const previous = await resizeWindow(vp.width);
        if (restoredWidth == null && previous != null) {
          restoredWidth = previous;
        }
        await settleViewport(signal);
      }

      await prepareDom({
        root: element,
        signal,
        onProgress: (message, percent) => {
          hud.setProgress({
            stage: "prepare",
            message: `${vp.label}: ${message}`,
            percent: basePercent + percent * 0.15,
          });
        },
      });

      if (signal.aborted) {
        throw new DOMException("Capture cancelled", "AbortError");
      }

      hud.setProgress({
        stage: "assets",
        message: `${vp.label}: loading images & fonts…`,
        percent: basePercent + 20,
      });

      const tw = looksLikeTailwind(element) ? "TW · " : "";
      const frameName = `${tw}${vp.label} · ${document.title || location.hostname || "Page"}`.slice(
        0,
        80,
      );

      const result = await convertRoot(
        element,
        frameName,
        settings,
        signal,
        (done, total) => {
          hud.setProgress({
            stage: "assets",
            message: `${vp.label}: assets ${done}/${total}`,
            percent: basePercent + 20 + Math.min(25, (done / Math.max(total, 1)) * 25),
            current: done,
            total,
          });
        },
      );

      hud.setProgress({
        stage: "convert",
        message: `${vp.label}: naming layers…`,
        percent: basePercent + 50,
      });

      const named = applyLayerNames(result, element);
      captures.push({ document: named, x, name: frameName });
      x += measure(element).width + gap;
    }

    hud.setProgress({
      stage: "clipboard",
      message: "Writing Figma clipboard…",
      percent: 92,
    });

    const item =
      captures.length === 1
        ? clipboardFromNamedDocument(captures[0].document)
        : mergeCaptureDocuments(captures);

    await writeClipboard(item);

    const message =
      captures.length > 1
        ? `Copied ${captures.length} viewports. Paste in Figma with ⌘V / Ctrl+V.`
        : "Copied. Paste in Figma with ⌘V / Ctrl+V.";

    hud.setDone(message);
    return { ok: true, message };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Capture failed.";
    if (message !== "Cancelled." && !(error instanceof DOMException && error.name === "AbortError")) {
      hud.setError(message);
    } else {
      hud.setError("Cancelled.");
    }
    return { ok: false, message };
  } finally {
    if (restoredWidth != null) {
      try {
        await resizeWindow(restoredWidth);
      } catch {
        // ignore restore failures
      }
    }
    if (activeAbort === abort) activeAbort = null;
  }
}
