// Just enough DOM for sk.js to boot inside a Node VM, so its connection layer can be tested
// against a real server with fetch intercepted. DOM behaviour itself (scenes, lifecycle, stage) is
// tested in a real browser (browser.test.js), not here.
class FakeElement {
  constructor(name) {
    this.nodeName = name.toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.style = { cssText: '' };
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, ref) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  getAnimations() { return []; }
}

export function fakeDom(metaContent) {
  const html = new FakeElement('html');
  const head = html.appendChild(new FakeElement('head'));
  const body = html.appendChild(new FakeElement('body'));
  const document = {
    documentElement: html,
    head,
    body,
    readyState: 'complete',
    querySelector: (sel) => (sel === 'meta[name="skp"]' ? { getAttribute: () => metaContent } : null),
    querySelectorAll: () => [],
    createElement: (name) => new FakeElement(name),
    addEventListener() {},
  };
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({
      getPropertyValue: () => '',
      animationName: 'none',
      animationDuration: '0s',
      animationDelay: '0s',
      animationIterationCount: '1',
      transitionDuration: '0s',
      transitionDelay: '0s',
    }),
  };
  window.self = window;
  window.top = window;
  return { document, window };
}
