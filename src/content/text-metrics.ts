/** Bake normal line heights only while converting; never freeze responsive CSS. */
export function bakeLineHeights(root: HTMLElement): () => void {
  const snapshots: Array<{
    element: HTMLElement;
    height: number;
    value: string;
    priority: string;
  }> = [];
  const doc = root.ownerDocument;
  const view = doc.defaultView!;

  // Read all computed styles before writing: a parent's pixel line height must
  // not replace a child's inherited `normal` (especially mixed-size headings).
  for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (!(element instanceof view.HTMLElement)) continue;
    if (!element.textContent?.trim()) continue;
    if (element.closest("[data-html2figma-hud], #html2figma-hud-host")) continue;
    const cs = view.getComputedStyle(element);
    if (cs.lineHeight !== "normal" || cs.display === "none" || cs.visibility === "hidden") continue;

    // An absolute inline span measures glyph bounds, not the used line box.
    // Two block lines give the browser's actual normal line-height. Keep the
    // probe outside the element (also works for selected roots/void elements).
    const probe = doc.createElement("div");
    probe.style.cssText = "all:initial!important;position:fixed!important;visibility:hidden!important;pointer-events:none!important;display:block!important;width:max-content!important;height:auto!important;padding:0!important;margin:0!important;border:0!important;white-space:pre!important;line-height:normal!important;";
    for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variation-settings", "font-feature-settings", "font-optical-sizing"]) {
      probe.style.setProperty(property, cs.getPropertyValue(property), "important");
    }
    probe.textContent = "Mg\nMg";
    doc.documentElement.appendChild(probe);
    let height: number;
    try {
      height = probe.getBoundingClientRect().height / 2;
    } finally {
      probe.remove();
    }
    if (!Number.isFinite(height) || height <= 0) continue;
    snapshots.push({
      element, height,
      value: element.style.getPropertyValue("line-height"),
      priority: element.style.getPropertyPriority("line-height"),
    });
  }

  for (const { element, height } of snapshots) {
    element.style.setProperty("line-height", `${height}px`, "important");
  }
  return () => {
    for (const { element, value, priority } of snapshots) {
      if (value) element.style.setProperty("line-height", value, priority);
      else element.style.removeProperty("line-height");
    }
  };
}
