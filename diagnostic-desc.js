(() => {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const SEL = '[data-testid="expandable-text-box"], [data-testid="inline-show-more-text"], [data-testid="expanded-text-below"], .jobs-description__content, .show-more-less-html__markup, .jobs-box__html-content';
  const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const roots = [...document.querySelectorAll(SEL)]
    .map(r => ({ r, len: norm(r.textContent).length }))
    .filter(x => x.len > 60).sort((a, b) => b.len - a.len);

  console.log('=== roots ===');
  roots.forEach((x, i) => console.log(`root#${i}`, x.r.tagName,
    String(x.r.className).split(' ').slice(0, 2).join('.'), 'len=' + x.len, 'visible=' + vis(x.r)));
  if (!roots.length) return;

  const main = roots[0].r;
  console.log('=== mainRoot children ===');
  [...main.children].slice(0, 12).forEach((c, i) =>
    console.log(`child#${i}`, c.tagName, String(c.className).split(' ').slice(0, 2).join('.'),
      'disp=' + getComputedStyle(c).display, 'len=' + norm(c.textContent).length,
      '→', norm(c.textContent).slice(0, 40)));

  console.log('=== prose blocks (extension logic) ===');
  const blocks = new Map();
  const w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      const p = n.parentElement;
      if (!p || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (p.closest('[data-lingoflow="true"], .lingoflow-ui')) return NodeFilter.FILTER_REJECT;
      const rg = document.createRange(); rg.selectNodeContents(n);
      return rg.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let n;
  while ((n = w.nextNode())) {
    let el = n.parentElement, depth = 0, blk = null;
    while (el && el !== document.body && depth < 14) {
      const d = getComputedStyle(el).display;
      if (/^(block|list-item|flow-root|table)/.test(d) || d.startsWith('flex') || d.startsWith('grid') || d === '-webkit-box') {
        blk = el; break;
      }
      el = el.parentElement; depth++;
    }
    if (!blk) { console.log('NO-BLOCK:', norm(n.nodeValue).slice(0, 40)); continue; }
    const cur = blocks.get(blk) || {
      tag: blk.tagName, cls: String(blk.className).split(' ').slice(0, 2).join('.'),
      disp: getComputedStyle(blk).display, len: 0, first: norm(blk.textContent).slice(0, 45)
    };
    cur.len += norm(n.nodeValue).length;
    blocks.set(blk, cur);
  }
  let i = 0;
  for (const info of blocks.values())
    console.log(`block#${i++}`, info.tag, info.cls, 'disp=' + info.disp, 'len=' + info.len, '→', info.first);

  console.log('=== rendered panels ===');
  document.querySelectorAll('.lingoflow-inline-translation').forEach(b => {
    const r = b.getBoundingClientRect();
    const p = b.previousElementSibling;
    console.log((b.getAttribute('data-lingoflow-desc-panel') ? 'DESC-PANEL' : 'inline'),
      Math.round(r.width) + 'x' + Math.round(r.height),
      'prev=', p ? p.tagName + '.' + String(p.className).split(' ').slice(0, 2).join('.') : 'null',
      '→', norm(b.textContent).slice(0, 40));
  });
})()
