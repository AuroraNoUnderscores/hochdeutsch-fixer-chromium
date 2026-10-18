// pdf.js comes from the newest Firefox (sync.sh) and uses what that Firefox
// has, some of which Chrome gained only lately or not yet: without these, a
// Chrome from before them shows no PDF at all. Loaded before pdf.js, on the
// page and in its worker (pdfplugin.mjs); each only where Chrome lacks it.
const define = (obj, name, fn) => {
  if (!(name in obj)) Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
};
for (const M of [Map, WeakMap]) {
  define(M.prototype, 'getOrInsert', function (key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define(M.prototype, 'getOrInsertComputed', function (key, make) {
    if (!this.has(key)) this.set(key, make(key));
    return this.get(key);
  });
}
define(Promise, 'try', function (fn, ...args) { return new this(resolve => resolve(fn(...args))); });
define(Promise, 'withResolvers', function () {
  let resolve, reject;
  const promise = new this((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
});
// a plain sum: pdf.js adds up lengths and widths, where it makes no difference
define(Math, 'sumPrecise', items => { let s = 0; for (const x of items) s += x; return s; });
define(Uint8Array.prototype, 'toHex', function () {
  let s = '';
  for (const b of this) s += b.toString(16).padStart(2, '0');
  return s;
});
define(Uint8Array.prototype, 'toBase64', function () {
  let s = '';
  for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode(...this.subarray(i, i + 0x8000));
  return btoa(s);
});
define(Uint8Array, 'fromBase64', s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
define(Set.prototype, 'intersection', function (other) {
  const out = new Set();
  for (const x of this) if (other.has(x)) out.add(x);
  return out;
});
// path coordinates kept as halves where Chrome has them, else as singles
if (typeof Float16Array === 'undefined') globalThis.Float16Array = Float32Array;
