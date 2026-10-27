import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundle = await build({ entryPoints: ['src/content/text-metrics.ts'], bundle: true, write: false, format: 'iife', globalName: 'textMetrics' });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.setContent(`<style>
    h1 {font: 80px/normal Arial; width:420px; margin:0}
    h1 span {font-size:32px}
    h2 {font:72px/1.05 Arial}
    @media(max-width:600px){h1{font-size:40px}h2{font-size:36px}}
  </style><h1 id="root">A large title wrapping over several lines <span>small text</span></h1><h2>Explicit spacing</h2>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const check = () => page.evaluate(() => {
    const root = document.querySelector('#root');
    const span = root.querySelector('span');
    const explicit = document.querySelector('h2');
    const before = {height:root.offsetHeight, child:span.getBoundingClientRect().height, explicit:getComputedStyle(explicit).lineHeight};
    const restore = textMetrics.bakeLineHeights(document.body);
    const result = { root:getComputedStyle(root).lineHeight, small:getComputedStyle(span).lineHeight,
      height:root.offsetHeight, explicit:getComputedStyle(explicit).lineHeight, before };
    restore();
    result.restored = root.style.lineHeight === '' && span.style.lineHeight === '' && getComputedStyle(root).lineHeight === 'normal';
    // Selected heading itself must be included, and inline !important restored.
    root.style.setProperty('line-height','normal','important');
    const restoreSelected = textMetrics.bakeLineHeights(root);
    result.selected = getComputedStyle(root).lineHeight !== 'normal';
    restoreSelected();
    result.priorityRestored = root.style.lineHeight === 'normal' && root.style.getPropertyPriority('line-height') === 'important';
    root.style.removeProperty('line-height');
    return result;
  });
  const desktop = await check();
  await page.setViewportSize({width:500,height:800});
  const mobile = await check();
  for (const sample of [desktop,mobile]) {
    assert.equal(sample.height,sample.before.height,'baking must preserve browser layout');
    assert.equal(sample.explicit,sample.before.explicit,'explicit line height preserved');
    assert.equal(sample.restored,true);
    assert.equal(sample.selected,true);
    assert.equal(sample.priorityRestored,true);
    assert.ok(parseFloat(sample.root)>parseFloat(sample.small),'mixed-size children use own metrics');
  }
  assert.ok(parseFloat(desktop.root)>parseFloat(mobile.root),'responsive metrics recalculated');
  console.log('PASS: multiline headings, mixed font sizes, explicit spacing, selected root, restoration and responsive recapture');
} finally {await browser.close();}
