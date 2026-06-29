// world.cjs
//
// BIT-EXACT mechanical transcription of the gacha physics ORCHESTRATION layer
// from decompiled ActionScript 3 into JS (CommonJS, Node).
//
// Transcribed faithfully from the AS3 sources under
//   D:/gacha_analysis/reference/client-decompiled/
// preserving every operation, operand order, parenthesization and SEQUENCE.
//
// Leaf hot-path functions (detectors, CCD, ContactPoint solver, bodyIntegrate,
// custom math) are REUSED from native_hotpath.cjs (already confirmed bit-exact).
//
// Source files transcribed here:
//   gacha_physics/dynamics/World.as                                  (step)
//   gacha_physics/dynamics/ContactManager.as                         (updateContacts, addNewPair, CCD, afterStep)
//   gacha_physics/dynamics/constraint/contact/Contact.as             (updateContactPoints, updateContactPoint, attach, detach, numOtherContacts)
//   gacha_physics/util/ContactEventManager.as                        (update, onBegin/EndBody/ShapeContact, isBodyContactCreated)
//   gacha_physics/collision/broadphase/selectivesweep/BroadPhaseSelectiveSweep.as (detectNewPairs, sort, addAABB, removeAABB)
//   gacha_physics/collision/broadphase/AABB.as + Gen_7576180c.as (edge) + Pair.as
//   gacha_physics/collision/broadphase/BroadPhase.as                 (addAABB, removeAABB, doesCollide)
//   gacha_physics/dynamics/Body.as                                   (addShape, updateMass, syncShapes(CCD), integrate)
//   gacha_physics/collision/shape/Shape.as + ShapeCircle/Line/Rect.as (shape structs, sync/syncCCD)
//   pinball/gacha/ballMovie/fallingField/FallingField.as + FixedFallingField.as (driver)
//   pinball/gacha/ballMovie/element/Amulet.as, element/Pin.as
//   pinball/scene/characterGet/ballMovie/displayElement/Gen_3f94e392.as (ball)
//   pinball/common/random/MersenneTwister.as
//
// NOTES / JUDGEMENT CALLS:
//  - No flippers exist in the gacha field, so all ShapeType.Flipper branches
//    in Contact.updateContactPoints / detach / afterStep are DEAD and omitted.
//    The sensor/disabled logic is preserved exactly:
//      disabled = shape1.sensor && shape2.sensor && (shape1.bounceBitMask & shape2.bounceBitMask)==0
//  - limitReflectionVelocity is false for every body here, so the reflection
//    adjustment blocks are dead and omitted.
//  - Bars are full-width (1080) axis-aligned static SENSOR rects of height 1.
//    Per task instructions the CircleRectDetector GJK is simplified to:
//      numContactInfo = 1  iff  |ball.y - bar.y| < ballRadius + halfHeight = 48.5
//    The ball x is always within the bar x-span. Bars are sensors so their
//    contact is disabled (no solver impulse) and they contribute nothing to CCD.
//  - AS3 int(x) == truncate toward zero == Math.trunc(x).

'use strict';

var H = require('./native_hotpath.cjs');
var silabar = H.silabar;
var vowe = H.vowe;
var ruzil = H.ruzil;
var circleCircleDetect = H.circleCircleDetect;
var circleCircleCCD = H.circleCircleCCD;
var circleLineDetect = H.circleLineDetect;
var circleLineCCD = H.circleLineCCD;
var ContactPoint = H.ContactPoint;
var bodyIntegrate = H.bodyIntegrate;

var PI = Math.PI;

// AS3 int(x)
function intTrunc(x) { return Math.trunc(x); }

// ===========================================================================
// ShapeType.index values (from ShapeType.as):
//   Circle=0, Line=1, Flipper=2, Rect=3, Sector=4
// BodyType.index values (from BodyType.as): Static=0, Dynamic=1, Kinematic=2
// ===========================================================================
var ST_CIRCLE = 0, ST_LINE = 1, ST_RECT = 3;
var BT_STATIC = 0, BT_DYNAMIC = 1;

// ===========================================================================
// Mersenne Twister  (pinball/common/random/MersenneTwister.as)
//   v = (Math.imul(1812433253, v ^ (v>>>30)) + i) | 0
// ===========================================================================
var N = 624;
var MAGIC = -1727483681; // 0x9908B0DF as signed int

function MersenneTwister(seed) {
  this.seed = seed | 0;
  this.index = 0;
  var v = seed | 0;
  this.mt = [v];
  for (var i = 1; i < N; i++) {
    v = (Math.imul(1812433253, v ^ (v >>> 30)) + i) | 0;
    this.mt[i] = v;
  }
  this.index = 0;
  for (var j = 0; j < N; j++) {
    this.randomUInt();
  }
}
MersenneTwister.prototype.randomUInt = function () {
  var i = this.index;
  var y = this.mt[i] | 0;
  this.index = (i + 1) % N;
  // (y & 0x80000000) | (mt[index] & 0x7FFFFFFF)
  var y2 = ((y & -2147483648) | (this.mt[this.index] & 0x7FFFFFFF)) | 0;
  // mt[(i+397)%N] ^ (y2>>>1) ^ ((y2 & 1) ? MAGIC : 0)
  this.mt[i] = ((this.mt[(i + 397) % N] | 0) ^ (y2 >>> 1) ^ ((y2 & 1) ? MAGIC : 0)) | 0;
  y ^= y >>> 11;
  y ^= (y << 7) & 0x9D2C5680;   // -1658038656
  y ^= (y << 15) & 0xEFC60000;  // -272236544
  y ^= y >>> 18;
  return y >>> 0;
};
MersenneTwister.prototype.zapokasu = function (u) { return u / 4294967296; };
MersenneTwister.prototype.nok = function (u, a, b) { return a + this.zapokasu(u) * (b - a); };
MersenneTwister.prototype.randomRangeFloat = function (a, b) { return this.nok(this.randomUInt(), a, b); };
MersenneTwister.prototype.randomRange = function (a, b) {
  // lylulo: int(Math.floor(nok(u,a,b+1) + 1e-10 + 1e-10))
  return intTrunc(Math.floor(this.nok(this.randomUInt(), a, b + 1) + 1e-10 + 1e-10));
};

// ===========================================================================
// contactInfo (flash.Gen_28cf7c38) struct
// ===========================================================================
function ContactInfo() {
  this.x = 0; this.y = 0; this.nx = 0; this.ny = 0; this.overlap = 0; this.id = 0;
}

// ===========================================================================
// AABB edge  (Gen_7576180c.as)
// ===========================================================================
function Edge(aabb, end, val) {
  this.aabb = aabb;
  this.end = end;
  this.val = val;
  this.index = 0;
  this.theOtherEdge = null;
}

// ===========================================================================
// AABB.as
// ===========================================================================
function AABB(x1, y1, x2, y2) {
  // AS3 ctor sig is (x1,x2,y1,y2). We never call it with args (created at 0).
  this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  this.tmp = 0;
  this.prev = null;
  this.next = null;
  this.parentBroadPhase = null;
  this.parent = null; // the Shape
  this.edgeX1 = new Edge(this, false, 0);
  this.edgeX2 = new Edge(this, true, 0);
  this.edgeY1 = new Edge(this, false, 0);
  this.edgeY2 = new Edge(this, true, 0);
  this.edgeX1.theOtherEdge = this.edgeX2; this.edgeX2.theOtherEdge = this.edgeX1;
  this.edgeY1.theOtherEdge = this.edgeY2; this.edgeY2.theOtherEdge = this.edgeY1;
}
AABB.prototype.jufu = function (x1, x2, y1, y2) {
  this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  this.edgeX1.val = x1 - 0.01;
  this.edgeX2.val = x2 + 0.01;
  this.edgeY1.val = y1 - 0.01;
  this.edgeY2.val = y2 + 0.01;
  // parentBroadPhase.moveAABB is a no-op in BroadPhase; skip.
};
AABB.prototype.get_x1 = function () { return this.x1; };
AABB.prototype.get_x2 = function () { return this.x2; };
AABB.prototype.get_y1 = function () { return this.y1; };
AABB.prototype.get_y2 = function () { return this.y2; };

// ===========================================================================
// Pair.as
// ===========================================================================
function Pair() {
  this.shape1 = null; this.shape2 = null; this.prevPair = null; this.nextPair = null;
}

// ===========================================================================
// ContactLink.as
// ===========================================================================
function ContactLink(contact) {
  this.contact = contact;
  this.theOtherShape = null;
  this.prev = null;
  this.next = null;
}
ContactLink.prototype.detach = function (shape) {
  if (this.prev != null) { this.prev.next = this.next; }
  if (this.next != null) { this.next.prev = this.prev; }
  if (this === shape.contactLink) { shape.contactLink = this.next; }
  this.prev = null;
  this.next = null;
};
ContactLink.prototype.attach = function (shape) {
  if (shape.contactLink == null) {
    shape.contactLink = this;
  } else {
    shape.contactLink.prev = this;
    this.next = shape.contactLink;
    shape.contactLink = this;
  }
};

// ===========================================================================
// Shape base + ShapeCircle / ShapeLine / ShapeRect
// ===========================================================================
function Shape(xLocal, yLocal, angleLocal) {
  this.aabb = new AABB();
  this.aabb.parent = this;
  this.xLocal = xLocal; this.yLocal = yLocal; this.angleLocal = angleLocal;
  this.x = 0; this.y = 0; this.angle = 0;
  this.mass = 0; this.inertia = 0;
  this.friction = 0.1; this.restitution = 0.3;
  this.surfaceVelocityNormal = 0; this.surfaceVelocityTangent = 0;
  this.collisionBitMask = 1; this.bounceBitMask = -1;
  this.type = -1; // ShapeType.Unknown
  this.added = false;
  this.disableSelfCollision = false;
  this.useCCD = false;
  this.sensor = false;
  this.contactCount = 0;
  this.contactLink = null;
  this.parent = null; // Body
  this.prevInWorld = null; this.nextInWorld = null;
  this.prevInBody = null; this.nextInBody = null;
}

function ShapeCircle(radius, density) {
  Shape.call(this, 0, 0, 0);
  this.radius = 0;
  this.setRadius(radius, density === undefined ? 1 : density);
  this.type = ST_CIRCLE;
  this.sweep = { radius: 0, x1: 0, y1: 0, x2: 0, y2: 0 };
}
ShapeCircle.prototype = Object.create(Shape.prototype);
ShapeCircle.prototype.constructor = ShapeCircle;
ShapeCircle.prototype.setRadius = function (r, density) {
  if (r <= 0) throw new Error('radius must be positive');
  this.radius = r;
  this.mass = r * r * Math.PI * density;
  this.inertia = this.mass * r * r / 2;
};
ShapeCircle.prototype.sync = function (p1, p2, p3, p4, p5, p6) {
  this.aabb.jufu(this.x - this.radius, this.x + this.radius, this.y - this.radius, this.y + this.radius);
};
ShapeCircle.prototype.syncCCD = function (p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14) {
  var _loc15_ = this.x;
  var _loc16_ = this.y;
  var _loc17_ = p8 + this.xLocal * p11 + this.yLocal * p12;
  var _loc18_ = p9 + this.xLocal * p13 + this.yLocal * p14;
  this.aabb.jufu(
    (_loc15_ < _loc17_ ? _loc15_ : _loc17_) - this.radius,
    (_loc15_ > _loc17_ ? _loc15_ : _loc17_) + this.radius,
    (_loc16_ < _loc18_ ? _loc16_ : _loc18_) - this.radius,
    (_loc16_ > _loc18_ ? _loc16_ : _loc18_) + this.radius
  );
  this.sweep.radius = this.radius;
  this.sweep.x1 = _loc15_;
  this.sweep.y1 = _loc16_;
  this.sweep.x2 = _loc17_;
  this.sweep.y2 = _loc18_;
  // parent.type == Kinematic never true here.
};

function ShapeLine(x1, y1, x2, y2, oneSide) {
  Shape.call(this, 0, 0, 0);
  this.x1Local = 0; this.y1Local = 0; this.x2Local = 0; this.y2Local = 0;
  this.x1 = 0; this.y1 = 0; this.x2 = 0; this.y2 = 0;
  this.oneSide = 0;
  this.setLine(x1, y1, x2, y2, oneSide === undefined ? 0 : oneSide);
  this.type = ST_LINE;
}
ShapeLine.prototype = Object.create(Shape.prototype);
ShapeLine.prototype.constructor = ShapeLine;
ShapeLine.prototype.setLine = function (x1, y1, x2, y2, oneSide) {
  if (x1 === x2 && y1 === y2) throw new Error('degenerate line');
  this.x1 = this.x1Local = x1;
  this.y1 = this.y1Local = y1;
  this.x2 = this.x2Local = x2;
  this.y2 = this.y2Local = y2;
  this.oneSide = oneSide;
  this.mass = 0; this.inertia = 0;
};
ShapeLine.prototype.sync = function (p1, p2, p3, p4, p5, p6) {
  this.x1 = p1 + this.x1Local * p3 + this.y1Local * p4;
  this.y1 = p2 + this.x1Local * p5 + this.y1Local * p6;
  this.x2 = p1 + this.x2Local * p3 + this.y2Local * p4;
  this.y2 = p2 + this.x2Local * p5 + this.y2Local * p6;
  this.aabb.jufu(
    this.x1 < this.x2 ? this.x1 : this.x2,
    this.x1 > this.x2 ? this.x1 : this.x2,
    this.y1 < this.y2 ? this.y1 : this.y2,
    this.y1 > this.y2 ? this.y1 : this.y2
  );
};
ShapeLine.prototype.syncCCD = function () { /* empty in AS3 */ };

function ShapeRect(width, height, density) {
  Shape.call(this, 0, 0, 0);
  this.nx = 0; this.ny = 0;
  this.basis00 = 0; this.basis01 = 0; this.basis10 = 0; this.basis11 = 0;
  this.nbasis00 = 0; this.nbasis01 = 0; this.nbasis10 = 0; this.nbasis11 = 0;
  this.width = 0; this.height = 0; this.halfWidth = 0; this.halfHeight = 0;
  this.setSize(width, height, density === undefined ? 1 : density);
  this.type = ST_RECT;
}
ShapeRect.prototype = Object.create(Shape.prototype);
ShapeRect.prototype.constructor = ShapeRect;
ShapeRect.prototype.setSize = function (w, h, density) {
  if (w <= 0 || h <= 0) throw new Error('size must be positive');
  this.width = w; this.height = h;
  this.mass = w * h * density;
  this.inertia = this.mass * (w * w + h * h) / 12;
  this.halfWidth = w * 0.5;
  this.halfHeight = h * 0.5;
};
ShapeRect.prototype.sync = function (p1, p2, p3, p4, p5, p6) {
  this.basis00 = p3; this.basis01 = p4; this.basis10 = p5; this.basis11 = p6;
  var _loc7_ = this.basis00;
  var _loc8_ = this.basis01;
  var _loc9_ = this.halfWidth * (_loc7_ < 0 ? -_loc7_ : _loc7_) + this.halfHeight * (_loc8_ < 0 ? -_loc8_ : _loc8_);
  var _loc10_ = this.basis10;
  var _loc11_ = this.basis11;
  var _loc12_ = this.halfWidth * (_loc10_ < 0 ? -_loc10_ : _loc10_) + this.halfHeight * (_loc11_ < 0 ? -_loc11_ : _loc11_);
  this.aabb.jufu(this.x - _loc9_, this.x + _loc9_, this.y - _loc12_, this.y + _loc12_);
};
ShapeRect.prototype.syncCCD = function (p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14) {
  var _loc15_ = this.halfWidth * (p4 < 0 ? -p4 : p4) + this.halfHeight * (p5 < 0 ? -p5 : p5);
  var _loc16_ = this.halfWidth * (p6 < 0 ? -p6 : p6) + this.halfHeight * (p7 < 0 ? -p7 : p7);
  var _loc17_ = p8 + this.xLocal * p11 + this.yLocal * p12;
  var _loc18_ = p9 + this.xLocal * p13 + this.yLocal * p14;
  var _loc19_ = this.halfWidth * (p11 < 0 ? -p11 : p11) + this.halfHeight * (p12 < 0 ? -p12 : p12);
  var _loc20_ = this.halfWidth * (p13 < 0 ? -p13 : p13) + this.halfHeight * (p14 < 0 ? -p14 : p14);
  var _loc21_ = p1 - _loc15_;
  var _loc22_ = _loc17_ - _loc19_;
  var _loc23_ = p1 + _loc15_;
  var _loc24_ = _loc17_ + _loc19_;
  var _loc25_ = p2 - _loc16_;
  var _loc26_ = _loc18_ - _loc20_;
  var _loc27_ = p2 + _loc16_;
  var _loc28_ = _loc18_ + _loc20_;
  this.aabb.jufu(
    _loc21_ < _loc22_ ? _loc21_ : _loc22_,
    _loc23_ > _loc24_ ? _loc23_ : _loc24_,
    _loc25_ < _loc26_ ? _loc25_ : _loc26_,
    _loc27_ > _loc28_ ? _loc27_ : _loc28_
  );
  this.nx = p8; this.ny = p9;
  this.nbasis00 = p11; this.nbasis01 = p12; this.nbasis10 = p13; this.nbasis11 = p14;
};

// ===========================================================================
// Body.as
// ===========================================================================
function Body(x, y, shape, type) {
  this.x = x; this.y = y;
  this.angle = 0;
  this.linearVelocityX = 0; this.linearVelocityY = 0;
  this.angularVelocity = 0;
  this.previousAngularVelocity = 0;
  this.pseudoLinearVelocityX = 0; this.pseudoLinearVelocityY = 0; this.pseudoAngularVelocity = 0;
  this.limitMaxLinearVelocity = false;
  this.limitMaxAngularVelocity = false;
  this.maxLinearVelocity = 100;
  this.maxAngularVelocity = 1.570796326794895;
  this.limitReflectionVelocity = false;
  this.maxReflectionVelocity = 100;
  this.linearDamping = 0; this.angularDamping = 0;
  this.massFactor = 1; this.inertiaFactor = 1;
  this.mass = 0; this.invMass = 0; this.inertia = 0; this.invInertia = 0;
  this.hitByFlipper = false;
  this.rotMatrix00 = 0; this.rotMatrix01 = 0; this.rotMatrix10 = 0; this.rotMatrix11 = 0;
  this.disableGravity = false;
  this.usePreviousAngularVelocity = false;
  this.numShapes = 0;
  this.useCCD = false;
  this.r00 = 0; this.r01 = 0; this.r10 = 0; this.r11 = 0;
  this.nr00 = 0; this.nr01 = 0; this.nr10 = 0; this.nr11 = 0;
  this.na = 0;
  this.flipperHitPositionX = 0; this.flipperHitPositionY = 0;
  this.contactCount = 0;
  this.lastHitFlipper = null;
  this.type = (type === undefined || type === null) ? BT_DYNAMIC : type;
  this._shapeList = null;
  this.lastShape = null;
  this.prev = null; this.next = null;
  this.world = null;
  // AS3 marks isStatic for bodyIntegrate reuse:
  this.isStatic = (this.type === BT_STATIC);
  if (shape != null) { this.addShape(shape); }
  this.maxStepRatio = 1;
}
Body.prototype.updateRotationMatrix = function () {
  this.rotMatrix00 = vowe(this.angle);
  this.rotMatrix01 = -ruzil(this.angle);
  this.rotMatrix10 = ruzil(this.angle);
  this.rotMatrix11 = vowe(this.angle);
};
Body.prototype.updateMass = function () {
  var _loc1_, _loc2_, _loc3_;
  switch (this.type) {
    case BT_STATIC:
    case 2: // Kinematic
      this.mass = 0; this.inertia = 0; this.invMass = 0; this.invInertia = 0;
      break;
    case BT_DYNAMIC:
      _loc1_ = 0; _loc2_ = 0;
      _loc3_ = this._shapeList;
      while (_loc3_ != null) {
        _loc1_ += _loc3_.mass;
        _loc2_ += _loc3_.inertia + (_loc3_.xLocal * _loc3_.xLocal + _loc3_.yLocal * _loc3_.yLocal) * _loc3_.mass;
        _loc3_ = _loc3_.nextInBody;
      }
      this.mass = _loc1_ * this.massFactor;
      this.inertia = _loc2_ * this.inertiaFactor;
      this.invMass = this.mass > 0 ? 1 / this.mass : 0;
      this.invInertia = this.inertia > 0 ? 1 / this.inertia : 0;
      break;
  }
};
Body.prototype.syncShapesCCD = function () {
  this.r00 = vowe(this.angle);
  this.r10 = ruzil(this.angle);
  this.r01 = -this.r10;
  this.r11 = this.r00;
  this.nr00 = vowe(this.angle + this.angularVelocity);
  this.nr10 = ruzil(this.angle + this.angularVelocity);
  this.nr01 = -this.nr10;
  this.nr11 = this.nr00;
  this.na = this.angle + this.angularVelocity;
  var _loc1_ = this._shapeList;
  while (_loc1_ != null) {
    _loc1_.useCCD = true;
    _loc1_.x = this.x + _loc1_.xLocal * this.r00 + _loc1_.yLocal * this.r01;
    _loc1_.y = this.y + _loc1_.xLocal * this.r10 + _loc1_.yLocal * this.r11;
    _loc1_.angle = this.angle + _loc1_.angleLocal;
    _loc1_.syncCCD(this.x, this.y, _loc1_.angle, this.r00, this.r01, this.r10, this.r11,
      this.x + this.linearVelocityX, this.y + this.linearVelocityY, _loc1_.angle + this.angularVelocity,
      this.nr00, this.nr01, this.nr10, this.nr11);
    _loc1_ = _loc1_.nextInBody;
  }
  this.previousAngularVelocity = this.angularVelocity;
};
Body.prototype.integrate = function (param1) {
  // Reuse the bit-exact bodyIntegrate. isStatic flag drives the Static branch.
  bodyIntegrate(this, param1);
};
Body.prototype.addShape = function (param1) {
  if (this._shapeList == null) {
    this._shapeList = this.lastShape = param1;
  } else {
    this.lastShape.nextInBody = param1;
    param1.prevInBody = this.lastShape;
    this.lastShape = param1;
  }
  param1.parent = this;
  if (this.world != null) { this.world.addShape(param1); }
  param1.useCCD = false;
  param1.x = this.x + param1.xLocal * this.r00 + param1.yLocal * this.r01;
  param1.y = this.y + param1.xLocal * this.r10 + param1.yLocal * this.r11;
  param1.angle = this.angle + param1.angleLocal;
  param1.sync(this.x, this.y, this.r00, this.r01, this.r10, this.r11);
  this.updateMass();
};

// ===========================================================================
// BroadPhase (base) + BroadPhaseSelectiveSweep
// ===========================================================================
function BroadPhaseSelectiveSweep(contactManager) {
  // base BroadPhase fields
  this.contactManager = contactManager;
  this.type = -1;
  this.numAABBs = 0;
  this.aabbs = null;
  this.lastAABB = null;
  // Gen_c51cb023 base supplies pairs/unusedPairs/lastPair/numPairs
  this.pairs = null;
  this.unusedPairs = null;
  this.lastPair = null;
  this.numPairs = 0;
  // selective sweep fields
  this.numEdges = 0;
  this.axisX = [];
  this.axisY = [];
  this.activeAABBs = [];
}
// --- base BroadPhase.addAABB ---
BroadPhaseSelectiveSweep.prototype.baseAddAABB = function (param1) {
  if (param1.parentBroadPhase != null) throw new Error('Internal Error');
  if (this.aabbs == null) {
    this.lastAABB = this.aabbs = param1;
  } else {
    this.lastAABB.next = param1;
    param1.prev = this.lastAABB;
    this.lastAABB = param1;
  }
  param1.parentBroadPhase = this;
  ++this.numAABBs;
};
// --- base BroadPhase.removeAABB ---
BroadPhaseSelectiveSweep.prototype.baseRemoveAABB = function (param1) {
  if (param1.parentBroadPhase == null) throw new Error('Internal Error');
  if (param1.prev != null) { param1.prev.next = param1.next; }
  if (param1.next != null) { param1.next.prev = param1.prev; }
  if (this.aabbs === param1) { this.aabbs = param1.next; }
  if (this.lastAABB === param1) { this.lastAABB = param1.prev; }
  param1.prev = null;
  param1.next = null;
  param1.parentBroadPhase = null;
  --this.numAABBs;
};
// --- doesCollide (no flippers; lastHitFlipper always null) ---
BroadPhaseSelectiveSweep.prototype.doesCollide = function (param1, param2) {
  if (param1.parent !== param2.parent
    && (param1.parent.type === BT_DYNAMIC || param2.parent.type === BT_DYNAMIC)
    && (param1.collisionBitMask & param2.collisionBitMask) !== 0
    && (!param1.disableSelfCollision || !param2.disableSelfCollision || param1.collisionBitMask !== param2.collisionBitMask)) {
    // flipper branches dead -> the trailing && (lastHitFlipper==null || ...) is always true
    return true;
  }
  return false;
};
BroadPhaseSelectiveSweep.prototype.sort = function (param1) {
  var _loc4_, _loc5_, _loc6_;
  var _loc2_ = this.numEdges;
  var _loc3_ = 1;
  while (_loc3_ < _loc2_) {
    _loc4_ = param1[_loc3_];
    _loc5_ = _loc4_.val;
    if (param1[_loc3_ - 1].val > _loc5_) {
      _loc6_ = _loc3_;
      while (true) {
        param1[_loc6_--] = param1[_loc6_];
        if (!(_loc6_ > 0 && param1[_loc6_ - 1].val > _loc5_)) {
          break;
        }
      }
      param1[_loc6_] = _loc4_;
    }
    _loc3_++;
  }
};
BroadPhaseSelectiveSweep.prototype.addAABB = function (param1) {
  // length pre-checks are JS array auto-grow no-ops; keep semantics identical.
  this.baseAddAABB(param1);
  (this.axisX[this.numEdges] = param1.edgeX1).index = this.numEdges;
  (this.axisY[this.numEdges] = param1.edgeY1).index = this.numEdges;
  ++this.numEdges;
  (this.axisX[this.numEdges] = param1.edgeX2).index = this.numEdges;
  (this.axisY[this.numEdges] = param1.edgeY2).index = this.numEdges;
  ++this.numEdges;
};
BroadPhaseSelectiveSweep.prototype.removeAABB = function (param1) {
  this.baseRemoveAABB(param1);
  --this.numEdges;
  (this.axisX[param1.edgeX1.index] = this.axisX[this.numEdges]).index = param1.edgeX1.index;
  this.axisX[this.numEdges] = null;
  (this.axisY[param1.edgeY1.index] = this.axisY[this.numEdges]).index = param1.edgeY1.index;
  this.axisY[this.numEdges] = null;
  --this.numEdges;
  (this.axisX[param1.edgeX2.index] = this.axisX[this.numEdges]).index = param1.edgeX2.index;
  this.axisX[this.numEdges] = null;
  (this.axisY[param1.edgeY2.index] = this.axisY[this.numEdges]).index = param1.edgeY2.index;
  this.axisY[this.numEdges] = null;
};
BroadPhaseSelectiveSweep.prototype.detectNewPairs = function () {
  var _loc1_, _loc2_, _loc10_, _loc11_, _loc12_, _loc13_, _loc14_;
  if (this.pairs != null) {
    _loc1_ = this.pairs;
    while (_loc1_ != null) {
      _loc1_.prevPair = null;
      _loc1_.shape1 = null;
      _loc1_.shape2 = null;
      _loc1_ = _loc1_.nextPair;
    }
    _loc2_ = this.pairs;
    _loc2_.nextPair = this.unusedPairs;
    this.unusedPairs = _loc2_;
    this.pairs = null;
    this.lastPair = null;
    this.numPairs = 0;
  }
  if (this.numAABBs < 2) {
    return;
  }
  this.sort(this.axisX);
  this.sort(this.axisY);
  var _loc3_ = 0;
  var _loc4_ = 0;
  var _loc5_ = 0;
  var _loc6_ = 0;
  var _loc7_ = 0;
  while (_loc7_ < this.numEdges) {
    this.axisX[_loc7_].index = _loc7_;
    this.axisY[_loc7_].index = _loc7_;
    if (this.axisX[_loc7_].end) {
      _loc3_--;
    } else {
      _loc5_ += _loc3_;
      _loc3_++;
    }
    if (this.axisY[_loc7_].end) {
      _loc4_--;
    } else {
      _loc6_ += _loc4_;
      _loc4_++;
    }
    _loc7_++;
  }
  var _loc8_ = _loc5_ < _loc6_ ? this.axisX : this.axisY;
  var _loc9_ = 1;
  (this.activeAABBs[0] = _loc8_[0].aabb).tmp = 0;
  _loc7_ = 1;
  while (_loc7_ < this.numEdges) {
    _loc10_ = _loc8_[_loc7_].aabb;
    if (_loc8_[_loc7_].end) {
      _loc9_--;
      (this.activeAABBs[_loc10_.tmp] = this.activeAABBs[_loc9_]).tmp = _loc10_.tmp;
      this.activeAABBs[_loc9_] = null;
    } else {
      _loc12_ = 0;
      while (_loc12_ < _loc9_) {
        _loc11_ = this.activeAABBs[_loc12_];
        _loc13_ = _loc10_.parent;
        _loc14_ = _loc11_.parent;
        if (this.doesCollide(_loc13_, _loc14_)
          && _loc10_.get_x1() < _loc11_.get_x2() && _loc10_.get_x2() > _loc11_.get_x1()
          && _loc10_.get_y1() < _loc11_.get_y2() && _loc10_.get_y2() > _loc11_.get_y1()) {
          if (this.unusedPairs != null) {
            _loc2_ = this.unusedPairs;
            this.unusedPairs = _loc2_.nextPair;
            _loc2_.nextPair = null;
            _loc1_ = _loc2_;
          } else {
            _loc1_ = new Pair();
          }
          _loc1_.shape1 = _loc13_;
          _loc1_.shape2 = _loc14_;
          this.contactManager.addNewPair(_loc1_);
          if (this.pairs == null) {
            this.lastPair = this.pairs = _loc1_;
          } else {
            this.lastPair.nextPair = _loc1_;
            _loc1_.prevPair = this.lastPair;
            this.lastPair = _loc1_;
          }
          ++this.numPairs;
        }
        _loc12_++;
      }
      (this.activeAABBs[_loc9_] = _loc10_).tmp = _loc9_;
      _loc9_++;
    }
    _loc7_++;
  }
};

// ===========================================================================
// ContactEventManager.as  (only the body/shape-pair machinery we need)
// ===========================================================================
function ContactEventManager() {
  this.bodyPairs = [];
  this.shapePairs = [];
  this.newBodyPairs = [];
  this.newShapePairs = [];
  this.oldBodyPairs = [];
  this.oldShapePairs = [];
  this.numBodyPairs = 0;
  this.numShapePairs = 0;
  this.numNewBodyPairs = 0;
  this.numNewShapePairs = 0;
  this.numOldBodyPairs = 0;
  this.numOldShapePairs = 0;
}
// Each pair slot is a 2-length array; we lazily grow.
function _slot(vec, i) {
  if (vec[i] === undefined) vec[i] = [null, null];
  return vec[i];
}
ContactEventManager.prototype.update = function () {
  while (this.numNewBodyPairs > 0) {
    --this.numNewBodyPairs;
    var a = _slot(this.newBodyPairs, this.numNewBodyPairs); a[0] = null; a[1] = null;
  }
  while (this.numNewShapePairs > 0) {
    --this.numNewShapePairs;
    var b = _slot(this.newShapePairs, this.numNewShapePairs); b[0] = null; b[1] = null;
  }
  while (this.numOldBodyPairs > 0) {
    --this.numOldBodyPairs;
    var c = _slot(this.oldBodyPairs, this.numOldBodyPairs); c[0] = null; c[1] = null;
  }
  while (this.numOldShapePairs > 0) {
    --this.numOldShapePairs;
    var d = _slot(this.oldShapePairs, this.numOldShapePairs); d[0] = null; d[1] = null;
  }
};
ContactEventManager.prototype.removeShapePair = function (vec, idx, num) {
  var _loc4_ = _slot(vec, idx);
  vec[idx] = _slot(vec, num - 1);
  vec[num - 1] = _loc4_;
  _loc4_[0] = null; _loc4_[1] = null;
};
ContactEventManager.prototype.removeBodyPair = function (vec, idx, num) {
  var _loc4_ = _slot(vec, idx);
  vec[idx] = _slot(vec, num - 1);
  vec[num - 1] = _loc4_;
  _loc4_[0] = null; _loc4_[1] = null;
};
ContactEventManager.prototype.onEndShapeContact = function (param1, param2) {
  var _loc6_, _loc3_ = -1, _loc4_ = 0, _loc5_ = this.numShapePairs;
  while (_loc4_ < _loc5_) {
    _loc6_ = _loc4_++;
    var s = _slot(this.shapePairs, _loc6_);
    if ((s[0] === param1 && s[1] === param2) || (s[0] === param2 && s[1] === param1)) {
      _loc3_ = _loc6_;
      break;
    }
  }
  this.removeShapePair(this.shapePairs, _loc3_, this.numShapePairs);
  --this.numShapePairs;
  var o = _slot(this.oldShapePairs, this.numOldShapePairs);
  o[0] = param1; o[1] = param2;
  ++this.numOldShapePairs;
};
ContactEventManager.prototype.onEndBodyContact = function (param1, param2) {
  var _loc6_, _loc3_ = -1, _loc4_ = 0, _loc5_ = this.numBodyPairs;
  while (_loc4_ < _loc5_) {
    _loc6_ = _loc4_++;
    var s = _slot(this.bodyPairs, _loc6_);
    if ((s[0] === param1 && s[1] === param2) || (s[0] === param2 && s[1] === param1)) {
      _loc3_ = _loc6_;
      break;
    }
  }
  this.removeBodyPair(this.bodyPairs, _loc3_, this.numBodyPairs);
  --this.numBodyPairs;
  var o = _slot(this.oldBodyPairs, this.numOldBodyPairs);
  o[0] = param1; o[1] = param2;
  ++this.numOldBodyPairs;
};
ContactEventManager.prototype.onBeginShapeContact = function (param1, param2) {
  var s = _slot(this.shapePairs, this.numShapePairs);
  s[0] = param1; s[1] = param2;
  ++this.numShapePairs;
  var n = _slot(this.newShapePairs, this.numNewShapePairs);
  n[0] = param1; n[1] = param2;
  ++this.numNewShapePairs;
};
ContactEventManager.prototype.onBeginBodyContact = function (param1, param2) {
  var b = _slot(this.bodyPairs, this.numBodyPairs);
  var n = _slot(this.newBodyPairs, this.numNewBodyPairs);
  b[0] = param1; b[1] = param2;
  n[0] = param1; n[1] = param2;
  ++this.numBodyPairs;
  ++this.numNewBodyPairs;
};
ContactEventManager.prototype.containsBodyPair = function (vec, num, p3, p4) {
  var _loc6_, _loc5_ = 0;
  while (_loc5_ < num) {
    _loc6_ = _loc5_++;
    var s = _slot(vec, _loc6_);
    if ((s[0] === p3 && s[1] === p4) || (s[0] === p4 && s[1] === p3)) {
      return true;
    }
  }
  return false;
};
ContactEventManager.prototype.containsBody = function (vec, num, p3) {
  var _loc5_, _loc4_ = 0;
  while (_loc4_ < num) {
    _loc5_ = _loc4_++;
    var s = _slot(vec, _loc5_);
    if (s[0] === p3 || s[1] === p3) { return true; }
  }
  return false;
};
ContactEventManager.prototype.isBodyContactCreated = function (param1, param2) {
  if (param2 == null) {
    return this.containsBody(this.newBodyPairs, this.numNewBodyPairs, param1);
  }
  return this.containsBodyPair(this.newBodyPairs, this.numNewBodyPairs, param1, param2);
};

// ===========================================================================
// Contact.as
// ===========================================================================
function Contact() {
  this.contactPoint1 = new ContactPoint();
  this.contactPoint2 = new ContactPoint();
  this.contactInfo1 = new ContactInfo();
  this.contactInfo2 = new ContactInfo();
  this.link1 = new ContactLink(this);
  this.link2 = new ContactLink(this);
  this.numContactInfo = 0;
  this.numContactPoints = 0;
  this.newContact = false;
  this.useCCD = false;
  this.hitByFlipper = false;
  this.touching = false;
  this.requestAdjustment = false;
  this.requestReflectionAdjustment = false;
  this.shape1 = null;
  this.shape2 = null;
  this.prev = null;
  this.next = null;
  // constraint-list link (Constraint.nextConstraint)
  this.nextConstraint = null;
}
Contact.prototype.isAvailable = function () {
  if (this.shape1.parent != null) {
    return this.shape2.parent != null;
  }
  return false;
};
Contact.prototype.attach = function () {
  this.useCCD = this.shape1.useCCD || this.shape2.useCCD;
  this.link1.theOtherShape = this.shape2;
  this.link2.theOtherShape = this.shape1;
  this.link1.attach(this.shape1);
  this.link2.attach(this.shape2);
};
Contact.prototype.dispose = function () {
  this.prev = null;
  this.next = null;
  this.contactPoint1.b1 = null;
  this.contactPoint1.b2 = null;
  this.contactPoint2.b1 = null;
  this.contactPoint2.b2 = null;
  this.numContactPoints = 0;
  this.numContactInfo = 0;
  this.shape1 = null;
  this.shape2 = null;
};
Contact.prototype.numOtherContacts = function () {
  var _loc6_, _loc1_ = 0;
  var _loc2_ = this.shape1.parent;
  var _loc3_ = this.shape2.parent;
  var _loc4_ = _loc2_._shapeList;
  var _loc5_ = _loc3_._shapeList;
  while (_loc4_ != null) {
    _loc6_ = _loc4_.contactLink;
    while (_loc6_ != null) {
      if (_loc6_.theOtherShape.parent === _loc3_ && _loc6_.contact.numContactPoints > 0 && _loc6_.contact !== this) {
        _loc1_++;
      }
      _loc6_ = _loc6_.next;
    }
    _loc4_ = _loc4_.nextInBody;
  }
  while (_loc5_ != null) {
    _loc6_ = _loc5_.contactLink;
    while (_loc6_ != null) {
      if (_loc6_.theOtherShape.parent === _loc2_ && _loc6_.contact.numContactPoints > 0 && _loc6_.contact !== this) {
        _loc1_++;
      }
      _loc6_ = _loc6_.next;
    }
    _loc5_ = _loc5_.nextInBody;
  }
  return _loc1_;
};
Contact.prototype.detach = function (param1) {
  // No flippers; limitReflectionVelocity always false -> reflection block dead.
  if (this.numContactPoints > 0) {
    --this.shape1.contactCount;
    --this.shape2.contactCount;
    --this.shape1.parent.contactCount;
    --this.shape2.parent.contactCount;
    param1.onEndShapeContact(this.shape1, this.shape2);
    if (this.numOtherContacts() === 0) {
      param1.onEndBodyContact(this.shape1.parent, this.shape2.parent);
    }
    // hitByFlipper always false here; requestReflectionAdjustment always false.
  }
  this.link1.detach(this.shape1);
  this.link2.detach(this.shape2);
  this.link1.theOtherShape = null;
  this.link2.theOtherShape = null;
};
Contact.prototype.updateContactPoint = function (param1) {
  if (this.numContactPoints > 0) {
    if (this.contactPoint1.id === param1.id) {
      this.contactPoint1.update(param1.x, param1.y, param1.nx, param1.ny, param1.overlap, false);
      param1.id = -1;
      return 1;
    }
    if (this.numContactPoints === 2 && this.contactPoint2.id === param1.id) {
      this.contactPoint2.update(param1.x, param1.y, param1.nx, param1.ny, param1.overlap, false);
      param1.id = -1;
      return 2;
    }
  }
  return 0;
};
Contact.prototype.updateContactPoints = function (param1) {
  var _loc2_ = 0;
  // _loc3_ = disabled. No flippers, so the flipper-derived branches are dead.
  var _loc3_ = this.shape1.sensor && this.shape2.sensor && (this.shape1.bounceBitMask & this.shape2.bounceBitMask) === 0;
  if (this.numContactInfo > 0) {
    if (!_loc3_) {
      _loc2_ = 0 | this.updateContactPoint(this.contactInfo1);
      if (this.numContactInfo === 2) {
        _loc2_ |= this.updateContactPoint(this.contactInfo2);
      }
    }
    if (this.contactInfo1.id !== -1) {
      if ((_loc2_ & 1) === 0) {
        this.contactPoint1.init(this.shape1, this.shape2, this.contactInfo1.x, this.contactInfo1.y, this.contactInfo1.nx, this.contactInfo1.ny, this.contactInfo1.overlap, _loc3_);
        _loc2_ |= 1;
      } else if ((_loc2_ & 2) === 0) {
        this.contactPoint2.init(this.shape1, this.shape2, this.contactInfo1.x, this.contactInfo1.y, this.contactInfo1.nx, this.contactInfo1.ny, this.contactInfo1.overlap, _loc3_);
        _loc2_ |= 2;
      }
    }
    if (this.numContactInfo === 2 && this.contactInfo2.id !== -1) {
      if ((_loc2_ & 1) === 0) {
        this.contactPoint1.init(this.shape1, this.shape2, this.contactInfo2.x, this.contactInfo2.y, this.contactInfo2.nx, this.contactInfo2.ny, this.contactInfo2.overlap, _loc3_);
        _loc2_ |= 1;
      } else if ((_loc2_ & 2) === 0) {
        this.contactPoint2.init(this.shape1, this.shape2, this.contactInfo2.x, this.contactInfo2.y, this.contactInfo2.nx, this.contactInfo2.ny, this.contactInfo2.overlap, _loc3_);
        _loc2_ |= 2;
      }
    }
    // flipper hit block dead; requestReflectionAdjustment block dead.
  }
  var _loc15_ = this.numContactPoints;
  this.numContactPoints = this.numContactInfo;
  if (_loc15_ === 0 && this.numContactPoints > 0) {
    ++this.shape1.contactCount;
    ++this.shape2.contactCount;
    ++this.shape1.parent.contactCount;
    ++this.shape2.parent.contactCount;
    param1.onBeginShapeContact(this.shape1, this.shape2);
    if (this.numOtherContacts() === 0) {
      param1.onBeginBodyContact(this.shape1.parent, this.shape2.parent);
    }
  }
  if (_loc15_ > 0 && this.numContactPoints === 0) {
    --this.shape1.contactCount;
    --this.shape2.contactCount;
    --this.shape1.parent.contactCount;
    --this.shape2.parent.contactCount;
    param1.onEndShapeContact(this.shape1, this.shape2);
    if (this.numOtherContacts() === 0) {
      param1.onEndBodyContact(this.shape1.parent, this.shape2.parent);
    }
    // flipper/reflection blocks dead.
  }
};
Contact.prototype.afterStep = function () {
  // requestAdjustment always false (no flippers).
};
// preSolve / solve / postSolve delegate to the ContactPoint constraints; in the
// World step constraint list we call them directly on contactPoint objects.
ContactPoint.prototype.postSolve = function () { /* no-op for contacts here */ };

// ===========================================================================
// ContactManager.as
// ===========================================================================
function ContactManager() {
  this.contactEventManager = new ContactEventManager();
  this.numContacts = 0;
  this.contacts = null;
  this.lastContact = null;
  this.unusedContacts = null;
}
ContactManager.prototype.updateContacts = function (param1, param2) {
  var _loc4_, _loc5_, _loc6_;
  this.contactEventManager.update();
  var _loc3_ = this.contacts;
  while (_loc3_ != null) {
    _loc4_ = _loc3_.next;
    _loc5_ = _loc3_.shape1.aabb;
    _loc6_ = _loc3_.shape2.aabb;
    if (!_loc3_.isAvailable()) {
      throw new Error('Internal Error');
    }
    if (!_loc3_.newContact && (
      !(_loc5_.get_x1() < _loc6_.get_x2() && _loc5_.get_x2() > _loc6_.get_x1()
        && _loc5_.get_y1() < _loc6_.get_y2() && _loc5_.get_y2() > _loc6_.get_y1())
      || !param1.doesCollide(_loc3_.shape1, _loc3_.shape2))) {
      _loc3_.detach(this.contactEventManager);
      if (_loc3_.prev != null) { _loc3_.prev.next = _loc3_.next; }
      if (_loc3_.next != null) { _loc3_.next.prev = _loc3_.prev; }
      if (this.contacts === _loc3_) { this.contacts = _loc3_.next; }
      if (this.lastContact === _loc3_) { this.lastContact = _loc3_.prev; }
      _loc3_.dispose();
      _loc3_.next = this.unusedContacts;
      this.unusedContacts = _loc3_;
      --this.numContacts;
    } else {
      param2.detect(_loc3_);
      _loc3_.updateContactPoints(this.contactEventManager);
    }
    _loc3_.newContact = false;
    _loc3_ = _loc4_;
  }
};
ContactManager.prototype.afterStep = function () {
  var _loc1_ = this.contacts;
  while (_loc1_ != null) {
    _loc1_.afterStep();
    _loc1_ = _loc1_.next;
  }
};
ContactManager.prototype.addNewPair = function (param1) {
  var _loc3_, _loc4_;
  var _loc2_ = param1.shape1.contactLink;
  while (_loc2_ != null) {
    if (_loc2_.theOtherShape === param1.shape2) {
      return;
    }
    _loc2_ = _loc2_.next;
  }
  if (this.unusedContacts != null) {
    _loc4_ = this.unusedContacts;
    this.unusedContacts = _loc4_.next;
    _loc4_.next = null;
    _loc4_.prev = null;
    _loc3_ = _loc4_;
  } else {
    _loc3_ = new Contact();
  }
  _loc3_.newContact = true;
  _loc3_.shape1 = param1.shape1;
  _loc3_.shape2 = param1.shape2;
  _loc3_.attach();
  if (this.contacts == null) {
    this.lastContact = this.contacts = _loc3_;
  } else {
    this.lastContact.next = _loc3_;
    _loc3_.prev = this.lastContact;
    this.lastContact = _loc3_;
  }
  ++this.numContacts;
};
ContactManager.prototype.CCD = function (param1) {
  var _loc2_ = this.contacts;
  while (_loc2_ != null) {
    if (_loc2_.useCCD && (_loc2_.newContact || _loc2_.numContactPoints === 0)) {
      param1.CCD(_loc2_);
    }
    _loc2_.newContact = false;
    _loc2_ = _loc2_.next;
  }
};

// ===========================================================================
// NarrowPhase.as  (detect / CCD dispatch)
//   Detectors reused from native_hotpath; bar (Rect) detector simplified.
// ===========================================================================
function NarrowPhase() {}
// chooseDetector returns a small token telling detect/CCD what to run.
// Encodes (shape1.type, shape2.type) per AS3 chooseDetector switch.
NarrowPhase.prototype.chooseDetector = function (s1, s2) {
  var t1 = s1.type, t2 = s2.type;
  if (t1 === ST_CIRCLE) {
    if (t2 === ST_CIRCLE) return 'cc';
    if (t2 === ST_LINE) return 'cl';
    if (t2 === ST_RECT) return 'cr';
    return null;
  }
  if (t1 === ST_LINE) { if (t2 === ST_CIRCLE) return 'lc'; return null; }
  if (t1 === ST_RECT) { if (t2 === ST_CIRCLE) return 'rc'; return null; }
  return null;
};
NarrowPhase.prototype.detect = function (contact) {
  var d = this.chooseDetector(contact.shape1, contact.shape2);
  if (d == null) return;
  var s1 = contact.shape1, s2 = contact.shape2;
  switch (d) {
    case 'cc':
      circleCircleDetect(s1, s2, contact);
      break;
    case 'cl':
      circleLineDetect(s1, s2, contact, false);
      break;
    case 'lc':
      // CircleLineDetector(flipped=true): swap so circle=param2(s2), line=param1(s1)
      circleLineDetect(s1, s2, contact, true);
      break;
    case 'cr':
      // circle = s1, rect = s2, flipped=false
      barDetect(s1, s2, contact, false);
      break;
    case 'rc':
      // rect = s1, circle = s2, flipped=true
      barDetect(s2, s1, contact, true);
      break;
  }
};
NarrowPhase.prototype.CCD = function (contact) {
  var d = this.chooseDetector(contact.shape1, contact.shape2);
  if (d == null) return;
  var s1 = contact.shape1, s2 = contact.shape2;
  var r;
  switch (d) {
    case 'cc': {
      // circleCircleCCD(ballSweep=s1.sweep, otherShape=s2, ballRadius=s1.radius, otherRadius=s2.radius)
      r = circleCircleCCD(s1.sweep, s2, s1.radius, s2.radius);
      if (r !== Infinity) {
        if (s1.parent.maxStepRatio > r) { s1.parent.maxStepRatio = r; }
        if (s2.parent.maxStepRatio > r) { s2.parent.maxStepRatio = r; }
      }
      break;
    }
    case 'cl': {
      // flipped=false: circle=s1, line=s2 -> only circle (s1) body updated
      r = circleLineCCD(s1.sweep, s2, s1.radius);
      if (r !== Infinity) {
        if (s1.parent.maxStepRatio > r) { s1.parent.maxStepRatio = r; }
      }
      break;
    }
    case 'lc': {
      // flipped=true: circle=s2, line=s1 -> only circle (s2) body updated
      r = circleLineCCD(s2.sweep, s1, s2.radius);
      if (r !== Infinity) {
        if (s2.parent.maxStepRatio > r) { s2.parent.maxStepRatio = r; }
      }
      break;
    }
    case 'cr':
    case 'rc':
      // Bars are sensors -> no solver/CCD stop contribution. CircleRectDetector.CCD
      // would update maxStepRatio, but the only rects here are static sensor bars
      // and the ball never reflects off them; per task simplification CCD = no-op.
      break;
  }
};

// barDetect: simplified CircleRectDetector for full-width axis-aligned bars.
//   numContactInfo = 1 iff |circle.y - rect.y| < circle.radius + rect.halfHeight
//   (circle.x always within rect x-span). Normal points from rect toward circle
//   along y. flipped negates the normal as the real detector does.
function barDetect(circle, rect, contact, flipped) {
  contact.numContactInfo = 0;
  var dy = circle.y - rect.y;
  var ady = dy < 0 ? -dy : dy;
  var limit = circle.radius + rect.halfHeight;
  if (ady < limit) {
    var ny = dy < 0 ? -1 : 1; // unit normal from rect to circle along y
    contact.numContactInfo = 1;
    contact.contactInfo1.x = circle.x;
    contact.contactInfo1.y = rect.y + ny * rect.halfHeight;
    contact.contactInfo1.nx = 0;
    contact.contactInfo1.ny = flipped ? -ny : ny;
    contact.contactInfo1.overlap = circle.radius + (rect.halfHeight - ady);
    contact.contactInfo1.id = 0;
  }
  // Bars are sensors so disabled=true; the overlap/normal are never used by the
  // solver, only the numContactInfo>0 -> onBeginBodyContact rarity trigger matters.
}

// ===========================================================================
// World.as
// ===========================================================================
function World(gravityX, gravityY, numIterations) {
  this.gravityX = gravityX;
  this.gravityY = gravityY;
  this.numIterations = (numIterations === undefined) ? 10 : numIterations;
  this.numBodies = 0;
  this.numShapes = 0;
  this.contactManager = new ContactManager();
  this.narrowPhase = new NarrowPhase();
  this.broadPhase = new BroadPhaseSelectiveSweep(this.contactManager);
  this.constraintList = null;
  this._shapeList = null;
  this.lastShape = null;
  this._bodyList = null;
  this.lastBody = null;
  this._jointList = null;
}
World.prototype.addShape = function (param1) {
  if (param1.added) throw new Error('Internal Error');
  if (this._shapeList == null) {
    this._shapeList = this.lastShape = param1;
  } else {
    this.lastShape.nextInWorld = param1;
    param1.prevInWorld = this.lastShape;
    this.lastShape = param1;
  }
  param1.added = true;
  this.broadPhase.addAABB(param1.aabb);
  ++this.numShapes;
};
World.prototype.removeShape = function (param1) {
  if (!param1.added) throw new Error('Internal Error');
  this.contactManager.onShapeRemoved(param1);
  this.broadPhase.removeAABB(param1.aabb);
  if (param1.prevInWorld != null) { param1.prevInWorld.nextInWorld = param1.nextInWorld; }
  if (param1.nextInWorld != null) { param1.nextInWorld.prevInWorld = param1.prevInWorld; }
  if (param1 === this._shapeList) { this._shapeList = param1.nextInWorld; }
  if (param1 === this.lastShape) { this.lastShape = param1.prevInWorld; }
  param1.prevInWorld = null;
  param1.nextInWorld = null;
  param1.added = false;
  --this.numShapes;
};
// onShapeRemoved (ContactManager) — needed by removeShape / _removeBody.
ContactManager.prototype.onShapeRemoved = function (param1) {
  var _loc3_, _loc4_;
  var _loc2_ = param1.contactLink;
  while (_loc2_ != null) {
    _loc3_ = _loc2_.next;
    _loc4_ = _loc2_.contact;
    _loc4_.detach(this.contactEventManager);
    if (_loc4_.prev != null) { _loc4_.prev.next = _loc4_.next; }
    if (_loc4_.next != null) { _loc4_.next.prev = _loc4_.prev; }
    if (this.contacts === _loc4_) { this.contacts = _loc4_.next; }
    if (this.lastContact === _loc4_) { this.lastContact = _loc4_.prev; }
    _loc4_.dispose();
    _loc4_.next = this.unusedContacts;
    this.unusedContacts = _loc4_;
    --this.numContacts;
    _loc2_ = _loc3_;
  }
};
World.prototype._addBody = function (param1) {
  if (param1.world != null) throw new Error('body added twice');
  if (this._bodyList == null) {
    this._bodyList = this.lastBody = param1;
  } else {
    this.lastBody.next = param1;
    param1.prev = this.lastBody;
    this.lastBody = param1;
  }
  param1.r00 = vowe(param1.angle);
  param1.r10 = ruzil(param1.angle);
  param1.r01 = -param1.r10;
  param1.r11 = param1.r00;
  var _loc3_ = param1._shapeList;
  while (_loc3_ != null) {
    _loc3_.useCCD = false;
    _loc3_.x = param1.x + _loc3_.xLocal * param1.r00 + _loc3_.yLocal * param1.r01;
    _loc3_.y = param1.y + _loc3_.xLocal * param1.r10 + _loc3_.yLocal * param1.r11;
    _loc3_.angle = param1.angle + _loc3_.angleLocal;
    _loc3_.sync(param1.x, param1.y, param1.r00, param1.r01, param1.r10, param1.r11);
    _loc3_ = _loc3_.nextInBody;
  }
  _loc3_ = param1._shapeList;
  while (_loc3_ != null) {
    this.addShape(_loc3_);
    _loc3_ = _loc3_.nextInBody;
  }
  param1.world = this;
  ++this.numBodies;
};
World.prototype._removeBody = function (param1) {
  if (param1.world == null) throw new Error('body not added');
  var _loc2_ = param1._shapeList;
  while (_loc2_ != null) {
    this.removeShape(_loc2_);
    _loc2_ = _loc2_.nextInBody;
  }
  if (param1.prev != null) { param1.prev.next = param1.next; }
  if (param1.next != null) { param1.next.prev = param1.prev; }
  if (param1 === this._bodyList) { this._bodyList = param1.next; }
  if (param1 === this.lastBody) { this.lastBody = param1.prev; }
  param1.prev = null;
  param1.next = null;
  param1.world = null;
  --this.numBodies;
};
World.prototype.step = function () {
  var _loc2_, _loc6_;
  this.broadPhase.detectNewPairs();
  var _loc1_ = this._bodyList;
  while (_loc1_ != null) {
    _loc1_.hitByFlipper = false;
    _loc1_ = _loc1_.next;
  }
  this.contactManager.updateContacts(this.broadPhase, this.narrowPhase);
  _loc1_ = this._bodyList;
  while (_loc1_ != null) {
    if (_loc1_.type === BT_DYNAMIC && !_loc1_.disableGravity) {
      _loc1_.linearVelocityX += this.gravityX;
      _loc1_.linearVelocityY += this.gravityY;
    }
    _loc1_ = _loc1_.next;
  }
  // clear constraint list
  while (this.constraintList != null) {
    _loc2_ = this.constraintList.nextConstraint;
    this.constraintList.nextConstraint = null;
    this.constraintList = _loc2_;
  }
  _loc1_ = this._bodyList;
  while (_loc1_ != null) {
    _loc1_.updateRotationMatrix();
    _loc1_ = _loc1_.next;
  }
  // jointList is empty (no joints) — skip the prepend loop.
  var _loc4_ = this.contactManager.contacts;
  while (_loc4_ != null) {
    if (_loc4_.numContactPoints > 0) {
      _loc2_ = _loc4_.contactPoint1;
      _loc2_.nextConstraint = this.constraintList;
      this.constraintList = _loc2_;
      if (_loc4_.numContactPoints === 2) {
        _loc2_ = _loc4_.contactPoint2;
        _loc2_.nextConstraint = this.constraintList;
        this.constraintList = _loc2_;
      }
    }
    _loc4_ = _loc4_.next;
  }
  _loc2_ = this.constraintList;
  while (_loc2_ != null) {
    _loc2_.preSolve();
    _loc2_ = _loc2_.nextConstraint;
  }
  var _loc5_ = 0;
  while (_loc5_ < this.numIterations) {
    _loc2_ = this.constraintList;
    while (_loc2_ != null) {
      _loc2_.solve();
      _loc2_ = _loc2_.nextConstraint;
    }
    _loc5_++;
  }
  _loc2_ = this.constraintList;
  while (_loc2_ != null) {
    _loc2_.postSolve();
    _loc2_ = _loc2_.nextConstraint;
  }
  this.contactManager.afterStep();
  // Pass 1: integrate non-CCD bodies, sync shapes.
  _loc1_ = this._bodyList;
  while (_loc1_ != null) {
    if (_loc1_.useCCD) {
      _loc1_ = _loc1_.next;
    } else {
      _loc1_.integrate(_loc1_.type === BT_DYNAMIC ? _loc1_.maxStepRatio : 1);
      _loc1_.r00 = vowe(_loc1_.angle);
      _loc1_.r10 = ruzil(_loc1_.angle);
      _loc1_.r01 = -_loc1_.r10;
      _loc1_.r11 = _loc1_.r00;
      _loc6_ = _loc1_._shapeList;
      while (_loc6_ != null) {
        _loc6_.useCCD = false;
        _loc6_.x = _loc1_.x + _loc6_.xLocal * _loc1_.r00 + _loc6_.yLocal * _loc1_.r01;
        _loc6_.y = _loc1_.y + _loc6_.xLocal * _loc1_.r10 + _loc6_.yLocal * _loc1_.r11;
        _loc6_.angle = _loc1_.angle + _loc6_.angleLocal;
        _loc6_.sync(_loc1_.x, _loc1_.y, _loc1_.r00, _loc1_.r01, _loc1_.r10, _loc1_.r11);
        _loc6_ = _loc6_.nextInBody;
      }
      _loc1_.maxStepRatio = 1;
      _loc1_ = _loc1_.next;
    }
  }
  // syncShapesCCD for all bodies
  _loc1_ = this._bodyList;
  while (_loc1_ != null) {
    _loc1_.syncShapesCCD();
    _loc1_ = _loc1_.next;
  }
  this.broadPhase.detectNewPairs();
  this.contactManager.CCD(this.narrowPhase);
  // Pass 2: integrate CCD bodies, sync shapes.
  _loc1_ = this._bodyList;
  while (_loc1_ != null) {
    if (!_loc1_.useCCD) {
      _loc1_ = _loc1_.next;
    } else {
      _loc1_.integrate(_loc1_.type === BT_DYNAMIC ? _loc1_.maxStepRatio : 1);
      _loc1_.r00 = vowe(_loc1_.angle);
      _loc1_.r10 = ruzil(_loc1_.angle);
      _loc1_.r01 = -_loc1_.r10;
      _loc1_.r11 = _loc1_.r00;
      _loc6_ = _loc1_._shapeList;
      while (_loc6_ != null) {
        _loc6_.useCCD = false;
        _loc6_.x = _loc1_.x + _loc6_.xLocal * _loc1_.r00 + _loc6_.yLocal * _loc1_.r01;
        _loc6_.y = _loc1_.y + _loc6_.xLocal * _loc1_.r10 + _loc6_.yLocal * _loc1_.r11;
        _loc6_.angle = _loc1_.angle + _loc6_.angleLocal;
        _loc6_.sync(_loc1_.x, _loc1_.y, _loc1_.r00, _loc1_.r01, _loc1_.r10, _loc1_.r11);
        _loc6_ = _loc6_.nextInBody;
      }
      _loc1_.maxStepRatio = 1;
      _loc1_ = _loc1_.next;
    }
  }
};
World.prototype.isBodyContactCreated = function (b1, b2) {
  return this.contactManager.contactEventManager.isBodyContactCreated(b1, b2);
};

// ===========================================================================
// CONFIG (BASE + MOVIES) — copied verbatim from full_engine.cjs
// ===========================================================================
var BASE = {
  field: { width: 1080, height: 3840, gravityX: 0, gravityY: 0.9, wallRestitution: 1 },
  ball: { initialXMin: 100, initialXMax: 880, initialY: 200, ejectionVelocity: 15, ejectionAngleMin: 40, ejectionAngleMax: 140, radius: 48, maxSpeed: 35 },
  pin: { countPerLine: 4, lineCount: 12, firstLineY: 1070, evenLineOffsetRatio: 0.25, oddLineOffsetRatio: -0.25, distanceHorizontal: 290, lineDistance: 165, verticalRestitution: 0.7, horizontalRestitution: 0.7, totalCountMin: 30, totalCountMax: 35, radius: 24 },
  amulet: { countPerLine: 3, lineCount: 14, firstLineY: 1630, evenLineOffsetRatio: -0.25, oddLineOffsetRatio: 0.25, distanceHorizontal: 290, lineDistance: 165, radius: 40, totalCount: 5, limitTotalCount: false, decideTwoUpWhenAppear: false },
  // barAmulet values from the REAL client config (gacha/*.amf3, all movies identical):
  // {lineCount:5, height:40, totalCount:1}. Earlier values (lc40/h1/tc5) were wrong and
  // mis-aligned the RNG stream (bar chooseNumbers + per-bar probability draws consumed
  // before playProbability), causing systematic mis-rating. Decoded via x87_test/amf3_decode.cjs.
  barAmulet: { totalCount: 1, lineCount: 5, firstLineY: 3025, lineDistance: 165, height: 40 }
};
var MOVIES = {
  normal: { threshold: { ballStar4: 0.7582740783691406, amuletTwoUp: 0.8148193359375, amulets: [0, 0, 0, 0, 0, 0.9022216796875], playMovie: 0.8995208740234375 } },
  normal_guarantee: { amulet: { totalCount: 5 }, threshold: { amulets: [0, 0, 0, 0, 0.18988037109375, 1], ballStar4: 3.814697265625e-05, amuletTwoUp: 0.5, playMovie: 0.9299392700195312 } },
  fes: { amulet: { totalCount: 7 }, threshold: { amulets: [0, 0, 0, 0, 0, 0, 0, 0.7190780639648438], ballStar4: 0.7429313659667969, amuletTwoUp: 0.475677490234375, playMovie: 0.8994979858398438 } },
  fes_guarantee: { amulet: { totalCount: 7 }, threshold: { amulets: [0, 0, 0, 0, 0, 0.6259765625, 0.999114990234375, 1], ballStar4: 3.814697265625e-05, amuletTwoUp: 0.5, playMovie: 0.8994979858398438 } },
  rarity_5_guarantee: { amulet: { totalCount: 5 }, threshold: { amulets: [0, 0, 0, 0, 0, 0], ballStar4: 0, amuletTwoUp: 0, playMovie: 0, isRarity5: true } }
};
function cfgFor(m) {
  var o = MOVIES[m] || MOVIES.normal;
  var c = JSON.parse(JSON.stringify(BASE));
  if (o.amulet) { for (var k in o.amulet) c.amulet[k] = o.amulet[k]; }
  c.threshold = o.threshold;
  return c;
}

// AmuletPlaceId.index: Circle=0, Bar=1
var PLACE_CIRCLE = 0, PLACE_BAR = 1;

// ===========================================================================
// Driver: FallingField + FixedFallingField  (transcribed)
// ===========================================================================
function initField(seed, movie) {
  var config = cfgFor(movie);
  var threshold = config.threshold;
  var sim = {};
  sim.config = config;
  sim.threshold = threshold;
  sim.pinHorizontalRestitutionRatio = config.pin.horizontalRestitution / config.pin.verticalRestitution;
  sim.random = new MersenneTwister(seed);
  sim.playProbability = 0;
  sim.frameCount = 0;
  sim.finished = false;
  sim.pendingFinish = 0;

  // ----- initField() -----
  var world = new World(config.field.gravityX, config.field.gravityY);
  sim.world = world;

  // initBall -> createBall
  sim.ball = createBall(sim);
  // initPins
  initPins(sim);
  // initAmulets
  initAmulets(sim);
  // initWall
  initWall(sim);
  // playProbability
  sim.playProbability = sim.random.randomRangeFloat(0, 1);
  // add bodies: ball, pins, amulets, wall (exact order)
  world._addBody(sim.ball.body);
  for (var i = 0; i < sim.pins.length; i++) { world._addBody(sim.pins[i].body); }
  for (var j = 0; j < sim.amulets.length; j++) { world._addBody(sim.amulets[j].body); }
  world._addBody(sim.wall);
  sim.frameCount = 0;
  sim.finished = false;
  sim.pendingFinish = -1;

  // ----- FixedFallingField constructor tail -----
  // initBallRarity
  sim.ball.rarity = sim.ball.probability > threshold.ballStar4 ? 1 : 0;
  // initAmuletRarity
  initAmuletRarity(sim);
  // moviePlayable
  sim.moviePlayable = sim.playProbability >= threshold.playMovie;
  if (threshold.isRarity5 != null && Boolean(threshold.isRarity5)) {
    sim.ball.rarity = 2;
    sim.moviePlayable = false;
  }
  return sim;
}

function createBall(sim) {
  var config = sim.config;
  var _loc1_ = sim.random.randomRangeFloat(config.ball.initialXMin, config.ball.initialXMax);
  var _loc2_ = config.ball.initialY;
  var _loc3_ = sim.random.randomRangeFloat(config.ball.ejectionAngleMin, config.ball.ejectionAngleMax) / 180 * Math.PI;
  var _loc4_ = config.ball.ejectionVelocity * vowe(_loc3_);
  var _loc5_ = config.ball.ejectionVelocity * ruzil(_loc3_);
  var _loc6_ = config.ball.maxSpeed;
  var _loc7_ = sim.random.randomRangeFloat(0, 1);
  // Gen_3f94e392 ctor
  var ball = { probability: _loc7_, radius: config.ball.radius, amuletContactCount: 0, rarity: 0 };
  var shape = new ShapeCircle(config.ball.radius);
  shape.sensor = true;
  var body = new Body(_loc1_, _loc2_, shape, BT_DYNAMIC);
  body.linearVelocityX = _loc4_;
  body.linearVelocityY = _loc5_;
  body.limitMaxLinearVelocity = true;
  body.maxLinearVelocity = _loc6_;
  ball.body = body;
  ball.shape = shape;
  return ball;
}

function initPins(sim) {
  var config = sim.config;
  var _loc1_ = config.pin.countPerLine * config.pin.lineCount - 1;
  var _loc2_ = sim.random.randomRange(config.pin.totalCountMin, config.pin.totalCountMax);
  var _loc3_ = chooseNumbers(sim, 0, _loc1_, _loc2_);
  var _loc5_ = [];
  var _loc6_ = 0;
  while (_loc6_ < _loc3_.length) {
    var id = intTrunc(_loc3_[_loc6_]);
    _loc6_++;
    _loc5_.push(createPin(sim, id));
  }
  sim.pins = _loc5_;
}

function createPin(sim, param1) {
  var config = sim.config;
  var _loc2_ = intTrunc(param1 % config.pin.countPerLine);
  var _loc3_ = param1 / config.pin.countPerLine;
  var _loc4_ = _loc3_ < 0 ? intTrunc(_loc3_ - 1e-10) : intTrunc(_loc3_ + 1e-10);
  var _loc5_ = intTrunc(_loc4_ % 2) === 0 ? config.pin.evenLineOffsetRatio : config.pin.oddLineOffsetRatio;
  var _loc6_ = (config.field.width - (config.pin.countPerLine - 1) * config.pin.distanceHorizontal) / 2 + _loc5_ * config.pin.distanceHorizontal;
  var _loc7_ = config.pin.firstLineY;
  var _loc8_ = _loc6_ + _loc2_ * config.pin.distanceHorizontal;
  var _loc9_ = _loc7_ + _loc4_ * config.pin.lineDistance;
  // Pin ctor
  var shape = new ShapeCircle(config.pin.radius);
  shape.restitution = config.pin.verticalRestitution;
  var body = new Body(_loc8_, _loc9_, shape, BT_STATIC);
  return { placeId: param1, radius: config.pin.radius, contacted: false, body: body, shape: shape };
}

function initAmulets(sim) {
  var config = sim.config;
  var _loc1_ = config.amulet.countPerLine * config.amulet.lineCount - 1;
  var _loc2_ = config.amulet.totalCount;
  var _loc3_ = chooseNumbers(sim, 0, _loc1_, _loc2_);
  var _loc5_ = [];
  var _loc6_ = 0;
  while (_loc6_ < _loc3_.length) {
    var id = intTrunc(_loc3_[_loc6_]);
    _loc6_++;
    _loc5_.push(createAmulet(sim, id));
  }
  _loc6_ = config.barAmulet.lineCount - 1;
  var _loc7_ = config.barAmulet.totalCount;
  var _loc8_ = chooseNumbers(sim, 0, _loc6_, _loc7_);
  var _loc10_ = [];
  var _loc11_ = 0;
  while (_loc11_ < _loc8_.length) {
    var bid = intTrunc(_loc8_[_loc11_]);
    _loc11_++;
    _loc10_.push(createBarAmulet(sim, bid));
  }
  sim.amulets = _loc5_.concat(_loc10_);
}

function createAmulet(sim, param1) {
  var config = sim.config;
  var _loc2_ = intTrunc(param1 % config.amulet.countPerLine);
  var _loc3_ = param1 / config.amulet.countPerLine;
  var _loc4_ = _loc3_ < 0 ? intTrunc(_loc3_ - 1e-10) : intTrunc(_loc3_ + 1e-10);
  var _loc5_ = intTrunc(_loc4_ % 2) === 0 ? config.amulet.evenLineOffsetRatio : config.amulet.oddLineOffsetRatio;
  var _loc6_ = (config.field.width - (config.amulet.countPerLine - 1) * config.amulet.distanceHorizontal) / 2 + _loc5_ * config.amulet.distanceHorizontal;
  var _loc7_ = config.amulet.firstLineY;
  var _loc8_ = _loc6_ + _loc2_ * config.amulet.distanceHorizontal;
  var _loc9_ = _loc7_ + _loc4_ * config.amulet.lineDistance;
  var _loc10_ = sim.random.randomRangeFloat(0, 1); // probability
  var _loc11_ = sim.random.randomRangeFloat(0, 1); // twoUpProbability
  // Amulet.zydoj
  var shape = new ShapeCircle(config.amulet.radius);
  shape.sensor = true;
  shape.bounceBitMask = 0;
  var body = new Body(_loc8_, _loc9_, shape, BT_STATIC);
  return makeAmulet(PLACE_CIRCLE, param1, _loc10_, _loc8_, _loc9_, _loc11_, body, shape);
}

function createBarAmulet(sim, param1) {
  var config = sim.config;
  var _loc2_ = config.field.width / 2;
  var _loc3_ = config.barAmulet.firstLineY + param1 * config.barAmulet.lineDistance;
  var _loc4_ = sim.random.randomRangeFloat(0, 1); // probability
  // Amulet.kapuw: ShapeRect(width=field.width, height=barAmulet.height)
  var shape = new ShapeRect(config.field.width, config.barAmulet.height);
  shape.sensor = true;
  shape.bounceBitMask = 0;
  var body = new Body(_loc2_, _loc3_, shape, BT_STATIC);
  // twoUpProbability param7 = 0
  return makeAmulet(PLACE_BAR, param1, _loc4_, _loc2_, _loc3_, 0, body, shape);
}

function makeAmulet(placeId, id, probability, x, y, twoUpProbability, body, shape) {
  return {
    placeId: placeId,
    placeIndex: placeId, // index used in switch (Circle=0, Bar=1)
    id: id,
    probability: probability,
    twoUpProbability: twoUpProbability,
    rarity: 1, // AS3 ctor sets rarity=1 then initAmuletRarity overwrites
    ballDistance2: 0,
    ballNearestDistance2: Infinity,
    ballNearestFrame: -1,
    forceContacted: false,
    body: body,
    shape: shape,
    x: x,
    y: y
  };
}
function amuletContacted(a) { return a.ballNearestDistance2 === 0; }

function chooseNumbers(sim, param1, param2, param3) {
  var _loc4_ = [];
  while (_loc4_.length < param3) {
    var _loc5_ = sim.random.randomRange(param1, param2);
    if (_loc4_.indexOf(_loc5_) < 0) {
      _loc4_.push(_loc5_);
    }
  }
  return _loc4_;
}

function initWall(sim) {
  var config = sim.config;
  var body = new Body(0, 0, null, BT_DYNAMIC); // AS3 makes Body(0,0) then sets type Static
  body.type = BT_STATIC;
  body.isStatic = true;
  var shapes = [
    new ShapeLine(0, 0, 0, config.field.height),
    new ShapeLine(config.field.width, 0, config.field.width, config.field.height)
  ];
  var _loc3_ = 0;
  while (_loc3_ < shapes.length) {
    var _loc4_ = shapes[_loc3_];
    _loc3_++;
    _loc4_.restitution = config.field.wallRestitution;
    body.addShape(_loc4_);
  }
  sim.wall = body;
}

function initAmuletRarity(sim) {
  var config = sim.config, threshold = sim.threshold;
  var _loc1_ = 0;
  var _loc2_ = 0;
  var _loc3_ = sim.amulets.length;
  while (_loc2_ < _loc3_) {
    var _loc4_ = _loc2_++;
    var _loc5_ = sim.amulets[_loc4_];
    var _loc6_ = 0, _loc7_, _loc8_, _loc9_;
    switch (_loc5_.placeIndex) {
      case PLACE_CIRCLE:
        _loc7_ = _loc5_.twoUpProbability > threshold.amuletTwoUp ? 2 : 1;
        if (_loc5_.probability > threshold.amulets[_loc4_]) {
          if (Boolean(config.amulet.limitTotalCount)) {
            if (Boolean(config.amulet.decideTwoUpWhenAppear)) {
              _loc8_ = Math.max(0, 2 - sim.ball.rarity - _loc1_);
              _loc9_ = Math.min(_loc8_, _loc7_);
              _loc6_ = _loc9_ < 0 ? intTrunc(_loc9_ - 1e-10) : intTrunc(_loc9_ + 1e-10);
            } else {
              _loc6_ = _loc4_ < 2 - sim.ball.rarity ? _loc7_ : 0;
            }
          } else {
            _loc6_ = _loc7_;
          }
        } else {
          _loc6_ = 0;
        }
        break;
      case PLACE_BAR:
        _loc6_ = sim.ball.rarity === 0 ? (_loc5_.probability > threshold.amulets[_loc4_] ? 1 : 0) : 0;
        break;
    }
    _loc5_.rarity = _loc6_;
    _loc1_ += _loc6_;
  }
}

// ----- performAmuletContacted (FixedFallingField) -----
function performAmuletContacted(sim, param1) {
  var a = sim.amulets[param1];
  if (a.rarity === 0) {
    return;
  }
  var _loc2_ = sim.ball.rarity;
  sim.ball.rarity += a.rarity;
  if (sim.ball.rarity > 2) {
    sim.ball.rarity = 2;
  }
  if (_loc2_ < 2 && sim.ball.rarity === 2) {
    performAllAmuletAndPinContacted(sim);
  }
}

function performAllAmuletAndPinContacted(sim) {
  var _loc1_ = 0, _loc2_ = sim.pins.length, _loc3_;
  while (_loc1_ < _loc2_) {
    _loc3_ = _loc1_++;
    var p = sim.pins[_loc3_];
    if (!p.contacted) {
      performPinContacted(sim, _loc3_);
    }
  }
  _loc1_ = 0;
  _loc2_ = sim.amulets.length;
  while (_loc1_ < _loc2_) {
    _loc3_ = _loc1_++;
    var a = sim.amulets[_loc3_];
    if (!amuletContacted(a) && !a.forceContacted) {
      a.forceContacted = true;
      // super.performAmuletContacted (FallingField.performAmuletContacted) is a
      // dispatcher no-op for the simulation; rarity already accounted for. We do
      // NOT re-add a.rarity here because FixedFallingField.performAmuletContacted
      // (which adds rarity) is overridden — performAllAmuletAndPinContacted calls
      // the SUPER (base) version which only dispatches handlers.
    }
  }
}

function performPinContacted(sim, param1) {
  var p = sim.pins[param1];
  sim.world._removeBody(p.body);
  p.contacted = true;
}

// ===========================================================================
// worldStep + update()  (FallingField.update transcribed)
// ===========================================================================
function worldStep(sim) {
  var config = sim.config;
  var cem = sim.world.contactManager.contactEventManager;
  sim.world.step();
  sim.frameCount += 1;
  // pins
  var _loc1_ = 0, _loc2_ = sim.pins.length, _loc3_;
  while (_loc1_ < _loc2_) {
    _loc3_ = _loc1_++;
    var _loc4_ = sim.pins[_loc3_];
    if (!_loc4_.contacted && cem.isBodyContactCreated(_loc4_.body, sim.ball.body)) {
      sim.ball.body.linearVelocityX *= sim.pinHorizontalRestitutionRatio;
      performPinContacted(sim, _loc3_);
    }
  }
  // amulets
  _loc1_ = 0;
  _loc2_ = sim.amulets.length;
  while (_loc1_ < _loc2_) {
    _loc3_ = _loc1_++;
    var _loc5_ = sim.amulets[_loc3_];
    if (!amuletContacted(_loc5_) && !_loc5_.forceContacted) {
      if (cem.isBodyContactCreated(_loc5_.body, sim.ball.body)) {
        sim.world._removeBody(_loc5_.body);
        sim.ball.amuletContactCount += 1;
        _loc5_.ballNearestDistance2 = 0;
        _loc5_.ballNearestFrame = sim.frameCount;
        performAmuletContacted(sim, _loc3_);
      } else {
        var _loc6_;
        switch (_loc5_.placeIndex) {
          case PLACE_CIRCLE:
            _loc6_ = sim.ball.body.x - _loc5_.body.x;
            break;
          case PLACE_BAR:
            _loc6_ = 0;
            break;
        }
        var _loc7_ = sim.ball.body.y - _loc5_.body.y;
        _loc5_.ballDistance2 = _loc6_ * _loc6_ + _loc7_ * _loc7_;
        if (_loc5_.ballDistance2 < _loc5_.ballNearestDistance2) {
          _loc5_.ballNearestDistance2 = _loc5_.ballDistance2;
          _loc5_.ballNearestFrame = sim.frameCount;
        }
      }
    }
  }
  if (sim.ball.body.y > config.field.height + sim.ball.radius) {
    if (sim.pendingFinish < 0) {
      sim.pendingFinish = 5;
    } else {
      sim.pendingFinish -= 1;
      if (sim.pendingFinish === 0) {
        sim.finished = true;
      }
    }
  }
  // expose ball position for inspection
  sim.ball.x = sim.ball.body.x;
  sim.ball.y = sim.ball.body.y;
}

// ===========================================================================
// simulate
// ===========================================================================
function simulate(seed, movie) {
  var sim = initField(seed, movie);
  if (!sim.moviePlayable) {
    return sim.ball.rarity;
  }
  var guard = 0;
  while (!sim.finished && guard < 20000) {
    worldStep(sim);
    guard++;
  }
  return sim.ball.rarity;
}

// Run full physics regardless of moviePlayable (per task metric).
function simulateFull(seed, movie) {
  var sim = initField(seed, movie);
  var guard = 0;
  while (!sim.finished && guard < 20000) {
    worldStep(sim);
    guard++;
  }
  return sim.ball.rarity;
}

module.exports = { simulate: simulate, simulateFull: simulateFull, initField: initField, worldStep: worldStep };
