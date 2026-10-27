import { materializeIconAssets } from "./icons";

export type PrepareOptions = {
  root: HTMLElement;
  signal?: AbortSignal;
  onProgress?: (message: string, percent: number) => void;
};

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Capture cancelled", "AbortError");
  }
}

async function wait(ms: number) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function absolutize(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

function extractBackgroundUrls(backgroundImage: string): string[] {
  if (!backgroundImage || backgroundImage === "none") return [];
  const urls: string[] = [];
  const re = /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(backgroundImage))) {
    const raw = match[2]?.trim();
    // Include data:image/svg — many icon systems ship as inline SVG backgrounds.
    if (raw) urls.push(raw);
  }
  return urls;
}

function mapObjectFitFromBackground(el: HTMLElement): string {
  const size = getComputedStyle(el).backgroundSize.trim();
  if (size === "cover") return "cover";
  if (size === "contain") return "contain";
  return "fill";
}

/** Figit only reads `<img src>` — promote srcset/currentSrc and lazy attrs. */
function normalizeImgSources(root: HTMLElement) {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    if (img.loading === "lazy") img.loading = "eager";
    if (img.getAttribute("decoding") === "async") img.decoding = "sync";

    const dataSrc =
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-original");
    if (dataSrc) img.src = absolutize(dataSrc);

    const srcset =
      img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
    if (srcset && !img.srcset) img.srcset = srcset;

    const best = img.currentSrc || img.src;
    if (best) {
      try {
        img.src = absolutize(best);
      } catch {
        // keep as-is
      }
    }
  }

  // <picture><source> — ensure img has a concrete src
  for (const picture of Array.from(root.querySelectorAll("picture"))) {
    const img = picture.querySelector("img");
    if (!img) continue;
    const best = img.currentSrc || img.src;
    if (best) img.src = absolutize(best);
  }
}

/**
 * Figit ignores CSS `background-image: url(...)`. Materialize them as real
 * <img> children so the image pipeline can load them.
 *
 * Stacking note: figit sorts positioned z-index≥0 nodes AFTER in-flow content,
 * so a covering `position:absolute; z-index:0` image ends up on top in Figma.
 * Keep bg images at z-index:0 and lift other siblings to z-index≥1 so content
 * stays above the background in the paste.
 */
function materializeBackgroundImages(root: HTMLElement) {
  const elements = Array.from(root.querySelectorAll<HTMLElement>("*"));
  if (root instanceof HTMLElement) elements.unshift(root);

  for (const el of elements) {
    if (el.dataset.html2figmaBgDone === "1") continue;
    if (el.closest("[data-html2figma-hud], #html2figma-hud-host")) continue;

    const cs = getComputedStyle(el);
    const urls = extractBackgroundUrls(cs.backgroundImage);
    if (urls.length === 0) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const position = cs.position;
    if (position === "static") {
      el.style.position = "relative";
    }
    // Contain bg z-index within this element.
    if (cs.isolation === "auto") {
      el.style.isolation = "isolate";
    }

    const withoutUrls = cs.backgroundImage
      .replace(/url\(\s*(['"]?)[^"')]+\1\s*\)\s*,?/gi, "")
      .replace(/^,\s*|,\s*$/g, "")
      .trim();
    el.style.backgroundImage =
      withoutUrls && withoutUrls !== "," ? withoutUrls : "none";

    urls.forEach((url, index) => {
      const img = document.createElement("img");
      img.src = url.startsWith("data:") ? url : absolutize(url);
      img.alt = "";
      img.decoding = "sync";
      img.loading = "eager";
      img.dataset.html2figmaBg = "1";
      img.setAttribute(
        "style",
        [
          "position:absolute",
          "inset:0",
          "width:100%",
          "height:100%",
          `object-fit:${mapObjectFitFromBackground(el)}`,
          "pointer-events:none",
          // Stay behind content (see stacking note above).
          `z-index:${index}`,
          "margin:0",
          "padding:0",
          "border:0",
          "max-width:none",
        ].join(";"),
      );
      el.insertBefore(img, el.firstChild);
    });

    // Lift existing content above the injected background image(s).
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.html2figmaBg === "1") continue;
      const childStyle = getComputedStyle(child);
      if (childStyle.position === "static") {
        child.style.position = "relative";
      }
      if (childStyle.zIndex === "auto") {
        child.style.zIndex = "1";
      }
    }

    el.dataset.html2figmaBgDone = "1";
  }
}

/** Capture video posters / current frames as <img> replacements. */
async function materializeVideos(root: HTMLElement, signal?: AbortSignal) {
  const videos = Array.from(root.querySelectorAll("video"));
  for (const video of videos) {
    assertNotAborted(signal);
    const rect = video.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    let dataUrl = "";
    try {
      if (video.poster) {
        // Prefer poster via img so loader/proxy can fetch it.
        const img = document.createElement("img");
        img.src = absolutize(video.poster);
        img.alt = video.getAttribute("aria-label") || "Video";
        img.width = Math.round(rect.width);
        img.height = Math.round(rect.height);
        img.setAttribute(
          "style",
          `width:${rect.width}px;height:${rect.height}px;object-fit:cover;display:block;`,
        );
        img.dataset.html2figmaVideo = "1";
        video.replaceWith(img);
        continue;
      }

      if (video.readyState < 2) {
        try {
          video.muted = true;
          await Promise.race([
            video.play().then(() => undefined).catch(() => undefined),
            wait(500),
          ]);
          video.pause();
        } catch {
          // ignore
        }
      }

      const w = video.videoWidth || Math.round(rect.width);
      const h = video.videoHeight || Math.round(rect.height);
      if (w > 0 && h > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        }
      }
    } catch {
      // cross-origin video taint etc.
    }

    if (!dataUrl) continue;
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = video.getAttribute("aria-label") || "Video frame";
    img.dataset.html2figmaVideo = "1";
    img.setAttribute(
      "style",
      `width:${rect.width}px;height:${rect.height}px;object-fit:cover;display:block;`,
    );
    video.replaceWith(img);
  }
}

/**
 * Figit's stacking sort puts positioned nodes (incl. z-index:auto/0) AFTER
 * in-flow content — so absolute cover images paint on top in Figma even when
 * they were backgrounds on the web. Detect full-bleed absolute images and lift
 * their siblings above them.
 */
function fixImageStacking(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll("img"));
  for (const img of images) {
    if (!(img instanceof HTMLImageElement)) continue;
    const parent = img.parentElement;
    if (!parent || parent === root && parent.children.length <= 1) continue;

    const cs = getComputedStyle(img);
    const position = cs.position;
    if (
      position !== "absolute" &&
      position !== "fixed" &&
      position !== "sticky"
    ) {
      continue;
    }

    const parentRect = parent.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    if (parentRect.width < 2 || parentRect.height < 2) continue;

    const coversParent =
      imgRect.width >= parentRect.width * 0.85 &&
      imgRect.height >= parentRect.height * 0.85;

    const looksLikeFill =
      coversParent ||
      img.dataset.html2figmaBg === "1" ||
      (cs.inset !== "auto" && cs.objectFit === "cover") ||
      (cs.top === "0px" &&
        cs.left === "0px" &&
        (cs.width === "100%" || imgRect.width >= parentRect.width * 0.9));

    if (!looksLikeFill) continue;

    const parentCs = getComputedStyle(parent);
    if (parentCs.position === "static") {
      parent.style.position = "relative";
    }
    if (parentCs.isolation === "auto") {
      parent.style.isolation = "isolate";
    }

    // Background layer
    const currentZ = cs.zIndex === "auto" ? NaN : Number.parseInt(cs.zIndex, 10);
    if (!Number.isFinite(currentZ) || currentZ > 0) {
      img.style.zIndex = "0";
    } else if (cs.zIndex === "auto") {
      img.style.zIndex = "0";
    }

    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement) || child === img) continue;
      if (child.dataset.html2figmaBg === "1") continue;
      // Don't lift other full-bleed images above each other incorrectly —
      // only lift non-image content and non-bg images that aren't fills.
      const childCs = getComputedStyle(child);
      if (childCs.position === "static") {
        child.style.position = "relative";
      }
      if (childCs.zIndex === "auto") {
        child.style.zIndex = "1";
      }
    }
  }
}

/** Force lazy images under root to load and wait for fonts/images. */
export async function prepareDom(options: PrepareOptions): Promise<void> {
  const { root, signal, onProgress } = options;
  assertNotAborted(signal);
  onProgress?.("Preparing page…", 3);

  assertNotAborted(signal);
  onProgress?.("Materializing icons…", 6);
  await materializeIconAssets(root, signal);

  assertNotAborted(signal);
  onProgress?.("Materializing backgrounds…", 8);
  materializeBackgroundImages(root);

  assertNotAborted(signal);
  onProgress?.("Capturing video frames…", 10);
  await materializeVideos(root, signal);

  normalizeImgSources(root);

  assertNotAborted(signal);
  onProgress?.("Loading lazy media…", 11);

  const images = Array.from(root.querySelectorAll("img"));

  // Nudge intersection observers / lazy loaders with a capped scroll pass.
  const maxScroll = Math.min(
    Math.max(document.documentElement.scrollHeight, root.scrollHeight),
    12_000,
  );
  const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
  const startY = window.scrollY;
  for (let y = 0; y <= maxScroll; y += step) {
    assertNotAborted(signal);
    window.scrollTo(0, y);
    await wait(40);
  }
  window.scrollTo(0, startY);
  await wait(80);

  // Re-normalize after lazy loaders may have filled currentSrc.
  normalizeImgSources(root);

  assertNotAborted(signal);
  onProgress?.("Waiting for fonts…", 14);
  try {
    await Promise.race([document.fonts.ready, wait(2500)]);
  } catch {
    // ignore
  }

  assertNotAborted(signal);
  onProgress?.("Decoding images…", 17);
  await Promise.all(
    images.slice(0, 250).map(async (img) => {
      try {
        if (!img.src && img.currentSrc) img.src = img.currentSrc;
        if (typeof img.decode === "function") {
          await Promise.race([img.decode(), wait(2500)]);
        }
      } catch {
        // ignore decode failures
      }
    }),
  );

  // Inline same-origin SVG <img> references when cheap.
  onProgress?.("Inlining SVGs…", 19);
  for (const img of Array.from(root.querySelectorAll("img")).slice(0, 40)) {
    assertNotAborted(signal);
    if (!/\.svg(\?|$)/i.test(img.currentSrc || img.src)) continue;
    // Don't inline our rasterized icon/bg placeholders.
    if (img.dataset.html2figmaIcon === "1" || img.dataset.html2figmaBg === "1") {
      continue;
    }
    try {
      const response = await fetch(img.currentSrc || img.src, {
        credentials: "include",
      });
      if (!response.ok) continue;
      const text = await response.text();
      if (!text.includes("<svg") || text.length > 200_000) continue;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = text.trim();
      const svg = wrapper.querySelector("svg");
      if (!svg) continue;
      svg.setAttribute("width", String(img.width || img.naturalWidth || 24));
      svg.setAttribute("height", String(img.height || img.naturalHeight || 24));
      img.replaceWith(svg);
    } catch {
      // cross-origin / blocked
    }
  }

  onProgress?.("Fixing image stacking…", 20);
  fixImageStacking(root);

  onProgress?.("Ready to convert…", 21);
}
