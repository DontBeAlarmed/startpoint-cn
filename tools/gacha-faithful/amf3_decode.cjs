// Minimal but faithful AMF3 decoder for the gacha config objects.
// Supports: undefined/null/false/true, integer(U29), double, string(with ref table),
// array(dense+assoc, ref), object(dynamic anonymous + traits ref). Enough for these configs.
'use strict';
const fs = require('fs');

function Reader(buf) { this.b = buf; this.p = 0; this.strs = []; this.objs = []; this.traits = []; }
Reader.prototype.u8 = function () { return this.b[this.p++]; };
Reader.prototype.u29 = function () {
  let v = 0, n = 0, byte;
  while (n < 3) { byte = this.b[this.p++]; v = (v << 7) | (byte & 0x7f); if (!(byte & 0x80)) return v; n++; }
  byte = this.b[this.p++]; v = (v << 8) | byte; return v;
};
Reader.prototype.dbl = function () { const d = this.b.readDoubleBE(this.p); this.p += 8; return d; };
Reader.prototype.str = function () {
  const h = this.u29();
  if ((h & 1) === 0) { return this.strs[h >> 1]; } // reference
  const len = h >> 1;
  const s = this.b.toString('utf8', this.p, this.p + len); this.p += len;
  if (len > 0) this.strs.push(s);
  return s;
};
Reader.prototype.value = function () {
  const marker = this.u8();
  switch (marker) {
    case 0x00: return undefined;
    case 0x01: return null;
    case 0x02: return false;
    case 0x03: return true;
    case 0x04: return this.u29();               // integer
    case 0x05: return this.dbl();               // double
    case 0x06: return this.str();               // string
    case 0x09: return this.array();             // array
    case 0x0a: return this.object();            // object
    default: throw new Error('AMF3 marker 0x' + marker.toString(16) + ' @ ' + (this.p - 1));
  }
};
Reader.prototype.array = function () {
  const h = this.u29();
  if ((h & 1) === 0) return this.objs[h >> 1];
  const dense = h >> 1;
  const arr = []; this.objs.push(arr);
  // associative part until empty-string key
  while (true) { const k = this.str(); if (k === '') break; arr[k] = this.value(); }
  for (let i = 0; i < dense; i++) arr.push(this.value());
  return arr;
};
Reader.prototype.object = function () {
  const h = this.u29();
  if ((h & 1) === 0) return this.objs[h >> 1]; // object reference
  const traitsRef = (h >> 1);
  let traits;
  if ((traitsRef & 1) === 0) { traits = this.traits[traitsRef >> 1]; }
  else {
    const externalizable = (traitsRef & 2) !== 0;
    const dynamic = (traitsRef & 4) !== 0;
    const count = traitsRef >> 3;
    const className = this.str();
    const props = [];
    for (let i = 0; i < count; i++) props.push(this.str());
    traits = { externalizable, dynamic, count, className, props };
    this.traits.push(traits);
  }
  const obj = {}; this.objs.push(obj);
  for (let i = 0; i < traits.count; i++) obj[traits.props[i]] = this.value();
  if (traits.dynamic) { while (true) { const k = this.str(); if (k === '') break; obj[k] = this.value(); } }
  return obj;
};

function decodeFile(path) {
  const buf = fs.readFileSync(path);
  const r = new Reader(buf);
  return r.value();
}

if (require.main === module) {
  const dir = 'D:/gacha_analysis/reference/configs/gacha_movie_configs';
  const which = process.argv[2] || 'fes';
  const obj = decodeFile(dir + '/' + which + '.amf3');
  console.log(JSON.stringify(obj, null, 1));
}
module.exports = { decodeFile };
