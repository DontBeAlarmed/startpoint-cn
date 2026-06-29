// native_hotpath.cjs
//
// BIT-EXACT mechanical transcription of AS3 physics hot-path functions into JS.
// Transcribed independently from the AS3 decompiled sources under
//   D:/gacha_analysis/reference/client-decompiled/
// to cross-check another JS port. Every arithmetic operation, operand order,
// and parenthesization is preserved exactly as in the AS3 source.
//
// Source files:
//   pinball/scene/battle/battle/enemy/Mamogepyz_cb1435e8.as  (silabar, vowe, ruzil)
//   gacha_physics/collision/narrowphase/CircleCircleDetector.as (detect, CCD)
//   gacha_physics/collision/narrowphase/CircleLineDetector.as   (detect, CCD)
//   gacha_physics/dynamics/constraint/contact/ContactPoint.as   (init, preSolve, solve, update)
//   gacha_physics/dynamics/Body.as                              (integrate)
//
// AS3 -> JS semantics notes:
//   AS3 Number       === JS number (IEEE754 double)
//   AS3 int(x)       === truncate toward zero  -> implemented as Math.trunc(x)
//   AS3 x & 3        === JS x & 3 (bitwise, int32)
//   AS3 x % y        === JS x % y
//
// 'use strict' is intentionally omitted; arithmetic is identical regardless.

'use strict';

// AS3 int(x): convert Number to int, truncating toward zero.
function int(x) {
  return Math.trunc(x);
}

// ===========================================================================
// Mamogepyz_cb1435e8.silabar  (sqrt)  — AS3 lines 323-345
// ===========================================================================
function silabar(param1) {
  if (param1 < 0) {
    return Number(NaN);
  }
  if (param1 === 0) {
    return 0;
  }
  var _loc2_ = param1 < 1 ? 1 : param1;
  var _loc3_ = 0;
  while (true) {
    _loc3_ = _loc2_;
    _loc2_ = (param1 / _loc2_ + _loc2_) / 2;
    if (_loc2_ >= _loc3_) {
      break;
    }
  }
  return _loc2_;
}

// ===========================================================================
// Mamogepyz_cb1435e8.vowe  (cos)  — AS3 lines 141-188
// ===========================================================================
function vowe(param1) {
  var _loc6_ = NaN;
  var _loc7_ = NaN;
  var _loc8_ = NaN;
  var _loc9_ = NaN;
  var _loc10_ = NaN;
  var _loc11_ = NaN;
  if (param1 < 0) {
    param1 = -param1;
  }
  var _loc2_ = (param1 + 0.7853981633974483) % 6.283185307179586 / 1.5707963267948966;
  var _loc3_ = _loc2_ < 0 ? int(_loc2_ - 1e-10) : int(_loc2_ + 1e-10);
  var _loc4_ = (_loc2_ - _loc3_) * 1.5707963267948966 - 0.7853981633974483;
  var _loc5_ = _loc3_ & 3;
  switch (_loc5_) {
    case 0:
      _loc6_ = _loc4_ < 0 ? -_loc4_ : _loc4_;
      _loc7_ = _loc4_ * _loc4_;
      _loc8_ = _loc7_ * (0.0416666666666666 + _loc7_ * (-0.001388888888887411 + _loc7_ * (0.00002480158728947673 + _loc7_ * (-2.7557314351390663e-7 + _loc7_ * (2.087572321298175e-9 + _loc7_ * -1.1359647557788195e-11)))));
      _loc9_ = _loc6_ > 0.78125 ? 0.28125 : _loc4_ / 4;
      _loc10_ = 0.5 * _loc7_ - _loc9_;
      _loc11_ = 1 - _loc9_;
      return _loc11_ - (_loc10_ - _loc7_ * _loc8_);
    case 1:
      _loc6_ = _loc4_ * _loc4_;
      _loc7_ = _loc6_ * _loc4_;
      _loc8_ = 0.00833333333332249 + _loc6_ * (-0.0001984126982985795 + _loc6_ * (0.0000027557313707070068 + _loc6_ * (-2.5050760253406863e-8 + _loc6_ * 1.58969099521155e-10)));
      return -(_loc4_ + _loc7_ * (-0.16666666666666632 + _loc6_ * _loc8_));
    case 2:
      _loc6_ = _loc4_ < 0 ? -_loc4_ : _loc4_;
      _loc7_ = _loc4_ * _loc4_;
      _loc8_ = _loc7_ * (0.0416666666666666 + _loc7_ * (-0.001388888888887411 + _loc7_ * (0.00002480158728947673 + _loc7_ * (-2.7557314351390663e-7 + _loc7_ * (2.087572321298175e-9 + _loc7_ * -1.1359647557788195e-11)))));
      _loc9_ = _loc6_ > 0.78125 ? 0.28125 : _loc4_ / 4;
      _loc10_ = 0.5 * _loc7_ - _loc9_;
      _loc11_ = 1 - _loc9_;
      return -(_loc11_ - (_loc10_ - _loc7_ * _loc8_));
    case 3:
      _loc6_ = _loc4_ * _loc4_;
      _loc7_ = _loc6_ * _loc4_;
      _loc8_ = 0.00833333333332249 + _loc6_ * (-0.0001984126982985795 + _loc6_ * (0.0000027557313707070068 + _loc6_ * (-2.5050760253406863e-8 + _loc6_ * 1.58969099521155e-10)));
      return _loc4_ + _loc7_ * (-0.16666666666666632 + _loc6_ * _loc8_);
    default:
      return Number(NaN);
  }
}

// ===========================================================================
// Mamogepyz_cb1435e8.ruzil  (sin)  — AS3 lines 91-139
// Note: ruzil is identical to vowe EXCEPT for the extra leading subtraction
//   param1 -= 1.5707963267948966;
//   if(param1 < 0) param1 = -param1;
// (vowe only does the abs, no -PI/2 shift)
// ===========================================================================
function ruzil(param1) {
  var _loc6_ = NaN;
  var _loc7_ = NaN;
  var _loc8_ = NaN;
  var _loc9_ = NaN;
  var _loc10_ = NaN;
  var _loc11_ = NaN;
  param1 -= 1.5707963267948966;
  if (param1 < 0) {
    param1 = -param1;
  }
  var _loc2_ = (param1 + 0.7853981633974483) % 6.283185307179586 / 1.5707963267948966;
  var _loc3_ = _loc2_ < 0 ? int(_loc2_ - 1e-10) : int(_loc2_ + 1e-10);
  var _loc4_ = (_loc2_ - _loc3_) * 1.5707963267948966 - 0.7853981633974483;
  var _loc5_ = _loc3_ & 3;
  switch (_loc5_) {
    case 0:
      _loc6_ = _loc4_ < 0 ? -_loc4_ : _loc4_;
      _loc7_ = _loc4_ * _loc4_;
      _loc8_ = _loc7_ * (0.0416666666666666 + _loc7_ * (-0.001388888888887411 + _loc7_ * (0.00002480158728947673 + _loc7_ * (-2.7557314351390663e-7 + _loc7_ * (2.087572321298175e-9 + _loc7_ * -1.1359647557788195e-11)))));
      _loc9_ = _loc6_ > 0.78125 ? 0.28125 : _loc4_ / 4;
      _loc10_ = 0.5 * _loc7_ - _loc9_;
      _loc11_ = 1 - _loc9_;
      return _loc11_ - (_loc10_ - _loc7_ * _loc8_);
    case 1:
      _loc6_ = _loc4_ * _loc4_;
      _loc7_ = _loc6_ * _loc4_;
      _loc8_ = 0.00833333333332249 + _loc6_ * (-0.0001984126982985795 + _loc6_ * (0.0000027557313707070068 + _loc6_ * (-2.5050760253406863e-8 + _loc6_ * 1.58969099521155e-10)));
      return -(_loc4_ + _loc7_ * (-0.16666666666666632 + _loc6_ * _loc8_));
    case 2:
      _loc6_ = _loc4_ < 0 ? -_loc4_ : _loc4_;
      _loc7_ = _loc4_ * _loc4_;
      _loc8_ = _loc7_ * (0.0416666666666666 + _loc7_ * (-0.001388888888887411 + _loc7_ * (0.00002480158728947673 + _loc7_ * (-2.7557314351390663e-7 + _loc7_ * (2.087572321298175e-9 + _loc7_ * -1.1359647557788195e-11)))));
      _loc9_ = _loc6_ > 0.78125 ? 0.28125 : _loc4_ / 4;
      _loc10_ = 0.5 * _loc7_ - _loc9_;
      _loc11_ = 1 - _loc9_;
      return -(_loc11_ - (_loc10_ - _loc7_ * _loc8_));
    case 3:
      _loc6_ = _loc4_ * _loc4_;
      _loc7_ = _loc6_ * _loc4_;
      _loc8_ = 0.00833333333332249 + _loc6_ * (-0.0001984126982985795 + _loc6_ * (0.0000027557313707070068 + _loc6_ * (-2.5050760253406863e-8 + _loc6_ * 1.58969099521155e-10)));
      return _loc4_ + _loc7_ * (-0.16666666666666632 + _loc6_ * _loc8_);
    default:
      return Number(NaN);
  }
}

// ===========================================================================
// CircleCircleDetector.detect  — AS3 lines 21-54
//   circle a = param1 = {x, y, radius}
//   circle b = param2 = {x, y, radius}
//   contact  = param3 = {numContactInfo, contactInfo1:{x,y,nx,ny,overlap,id}}
// ===========================================================================
function circleCircleDetect(param1, param2, param3) {
  var _loc10_ = NaN;
  var _loc11_ = NaN;
  var _loc12_ = NaN;
  var _loc13_ = NaN;
  param3.numContactInfo = 0;
  var _loc4_ = param1;
  var _loc5_ = param2;
  var _loc6_ = _loc5_.x - _loc4_.x;
  var _loc7_ = _loc5_.y - _loc4_.y;
  var _loc8_ = _loc4_.radius + _loc5_.radius;
  var _loc9_ = _loc6_ * _loc6_ + _loc7_ * _loc7_;
  if (_loc9_ === 0) {
    _loc6_ = 0.000001;
    _loc7_ = 0;
    _loc9_ = 1e-12;
  }
  if (_loc9_ < _loc8_ * _loc8_ && _loc9_ > 0) {
    _loc10_ = silabar(_loc9_);
    _loc11_ = 1 / _loc10_;
    _loc12_ = _loc6_ * _loc11_;
    _loc13_ = _loc7_ * _loc11_;
    param3.numContactInfo = 1;
    param3.contactInfo1.x = (_loc4_.x + _loc12_ * _loc4_.radius + _loc5_.x - _loc12_ * _loc5_.radius) * 0.5;
    param3.contactInfo1.y = (_loc4_.y + _loc13_ * _loc4_.radius + _loc5_.y - _loc13_ * _loc5_.radius) * 0.5;
    param3.contactInfo1.overlap = _loc8_ - _loc10_;
    param3.contactInfo1.nx = _loc12_;
    param3.contactInfo1.ny = _loc13_;
    param3.contactInfo1.id = 0;
  }
}

// ===========================================================================
// CircleCircleDetector.CCD  — AS3 lines 56-97
//
// AS3 mutates shape.parent.maxStepRatio. Per instructions, this port instead
// RETURNS the candidate maxStepRatio value (_loc23_ = (_loc22_ + 2) / _loc16_)
// only when the AS3 would update maxStepRatio (i.e. when the inner `if` body is
// reached). Otherwise it returns Infinity (no collision / no update). The caller
// is responsible for taking the min against the body's current maxStepRatio.
//
// Signature per instructions:
//   circleCircleCCD(ballSweep, otherShape, ballRadius, otherRadius)
// where:
//   ballSweep   = _loc3_.sweep = {x1,y1,x2,y2}  (this/"3" shape's sweep)
//   otherShape  = _loc4_ with .sweep = {x1,y1,x2,y2}  (other/"4" shape)
//   ballRadius  = _loc3_.radius
//   otherRadius = _loc4_.radius
// ===========================================================================
function circleCircleCCD(ballSweep, otherShape, ballRadius, otherRadius) {
  var _loc23_ = NaN;
  // _loc3_ = param1 (this circle), _loc4_ = param2 (other circle)
  var _loc5_ = ballSweep.x1;          // _loc3_.sweep.x1
  var _loc6_ = ballSweep.y1;          // _loc3_.sweep.y1
  var _loc7_ = ballSweep.x2;          // _loc3_.sweep.x2
  var _loc8_ = ballSweep.y2;          // _loc3_.sweep.y2
  var _loc9_ = otherShape.sweep.x1;   // _loc4_.sweep.x1
  var _loc10_ = otherShape.sweep.y1;  // _loc4_.sweep.y1
  var _loc11_ = otherShape.sweep.x2;  // _loc4_.sweep.x2
  var _loc12_ = otherShape.sweep.y2;  // _loc4_.sweep.y2
  var _loc13_ = ballRadius + otherRadius;          // _loc3_.radius + _loc4_.radius
  var _loc14_ = _loc11_ - _loc9_ - (_loc7_ - _loc5_);
  var _loc15_ = _loc12_ - _loc10_ - (_loc8_ - _loc6_);
  var _loc16_ = silabar(_loc14_ * _loc14_ + _loc15_ * _loc15_);
  if (_loc16_ < 0.00001) {
    return Infinity;
  }
  var _loc17_ = 1 / _loc16_;
  _loc14_ *= _loc17_;
  _loc15_ *= _loc17_;
  var _loc18_ = _loc5_ - _loc9_;
  var _loc19_ = _loc6_ - _loc10_;
  var _loc20_ = _loc18_ * _loc14_ + _loc19_ * _loc15_;
  var _loc21_ = _loc20_ * _loc20_ - (_loc18_ * _loc18_ + _loc19_ * _loc19_) + _loc13_ * _loc13_;
  var _loc22_ = _loc21_ < 0 ? -1 : _loc20_ - silabar(_loc21_);
  if (_loc22_ > 0 && _loc22_ < _loc16_) {
    _loc23_ = (_loc22_ + 2) / _loc16_;
    return _loc23_;
  }
  return Infinity;
}

// ===========================================================================
// CircleLineDetector.detect  — AS3 lines 25-84
//
// `flipped` controls a swap of param1/param2. For the gacha cross-check we
// expose it as a parameter (default false). When flipped, param1 and param2
// are swapped (so the circle/line roles swap) exactly as AS3 does, and the
// normal is negated on output.
//
//   param1 = circle {x, y, radius}   (when !flipped)
//   param2 = line   {x1,y1,x2,y2, oneSide}
//   param3 = contact {numContactInfo, contactInfo1:{...}}
// ===========================================================================
function circleLineDetect(param1, param2, param3, flipped) {
  if (flipped === undefined) flipped = false;
  var _loc4_ = null;
  var _loc22_ = NaN;
  var _loc23_ = NaN;
  var _loc24_ = NaN;
  var _loc25_ = NaN;
  param3.numContactInfo = 0;
  if (flipped) {
    _loc4_ = param1;
    param1 = param2;
    param2 = _loc4_;
  }
  var _loc5_ = param1;     // ShapeCircle
  var _loc6_ = param2;     // ShapeLine
  var _loc7_ = _loc6_.x1;
  var _loc8_ = _loc6_.y1;
  var _loc9_ = _loc6_.x2;
  var _loc10_ = _loc6_.y2;
  var _loc11_ = _loc5_.x;
  var _loc12_ = _loc5_.y;
  var _loc13_ = _loc5_.radius;
  var _loc14_ = _loc11_ - _loc7_;
  var _loc15_ = _loc12_ - _loc8_;
  var _loc16_ = _loc9_ - _loc7_;
  var _loc17_ = _loc10_ - _loc8_;
  if ((_loc16_ * _loc15_ - _loc17_ * _loc14_) * _loc6_.oneSide > 0) {
    return;
  }
  var _loc18_ = (_loc14_ * _loc16_ + _loc15_ * _loc17_) / (_loc16_ * _loc16_ + _loc17_ * _loc17_);
  if (_loc18_ < 0) {
    _loc18_ = 0;
  } else if (_loc18_ > 1) {
    _loc18_ = 1;
  }
  var _loc19_ = _loc7_ + _loc18_ * _loc16_;
  var _loc20_ = _loc8_ + _loc18_ * _loc17_;
  _loc16_ = _loc19_ - _loc11_;
  _loc17_ = _loc20_ - _loc12_;
  var _loc21_ = _loc16_ * _loc16_ + _loc17_ * _loc17_;
  if (_loc21_ < _loc13_ * _loc13_) {
    _loc22_ = silabar(_loc21_);
    _loc23_ = 1 / _loc22_;
    _loc24_ = _loc16_ * _loc23_;
    _loc25_ = _loc17_ * _loc23_;
    param3.numContactInfo = 1;
    param3.contactInfo1.x = _loc19_;
    param3.contactInfo1.y = _loc20_;
    param3.contactInfo1.nx = flipped ? -_loc24_ : _loc24_;
    param3.contactInfo1.ny = flipped ? -_loc25_ : _loc25_;
    param3.contactInfo1.overlap = _loc13_ - _loc22_;
    param3.contactInfo1.id = 0;
  }
}

// ===========================================================================
// CircleLineDetector.CCD  — AS3 lines 86-182
//
// AS3 mutates _loc4_.parent.maxStepRatio (only the circle's body). Per
// instructions this port RETURNS the candidate maxStepRatio (_loc31_) only when
// AS3 would update it (i.e. when _loc30_ < _loc17_); otherwise returns Infinity.
//
// Signature per instructions:
//   circleLineCCD(ballSweep, lineShape, ballRadius)
//   ballSweep = _loc4_.sweep = {x1,y1,x2,y2}
//   lineShape = _loc5_ = {x1,y1,x2,y2, oneSide}
//   ballRadius = _loc4_.radius
//
// NOTE: AS3 also has the `flipped` swap at the top of CCD. With flipped=false
// (the default), param1 is the circle (= _loc4_) and param2 is the line
// (= _loc5_). The given signature already passes the circle's sweep and the
// line directly, matching the !flipped case. A `flipped` parameter is exposed
// for completeness, but it does NOT change which sweep is the ball's here —
// the caller is expected to pass the correct ball sweep and line shape.
// (Transcribed: the swap only reassigns which AS3 object is circle/line; the
// fields read below are exactly the !flipped reads.)
// ===========================================================================
function circleLineCCD(ballSweep, lineShape, ballRadius) {
  var _loc17_ = NaN;
  var _loc26_ = NaN;
  var _loc27_ = NaN;
  var _loc28_ = NaN;
  var _loc31_ = NaN;
  // _loc4_ = circle, _loc5_ = line
  var _loc6_ = ballSweep.x1;     // _loc4_.sweep.x1
  var _loc7_ = ballSweep.y1;     // _loc4_.sweep.y1
  var _loc8_ = ballSweep.x2;     // _loc4_.sweep.x2
  var _loc9_ = ballSweep.y2;     // _loc4_.sweep.y2
  var _loc10_ = ballRadius;      // _loc4_.radius
  var _loc11_ = _loc8_ - _loc6_;
  var _loc12_ = _loc9_ - _loc7_;
  var _loc13_ = lineShape.x1;    // _loc5_.x1
  var _loc14_ = lineShape.y1;    // _loc5_.y1
  var _loc15_ = lineShape.x2;    // _loc5_.x2
  var _loc16_ = lineShape.y2;    // _loc5_.y2
  if (lineShape.oneSide === -1) {
    _loc17_ = _loc13_;
    _loc13_ = _loc15_;
    _loc15_ = _loc17_;
    _loc17_ = _loc14_;
    _loc14_ = _loc16_;
    _loc16_ = _loc17_;
  }
  _loc17_ = silabar(_loc11_ * _loc11_ + _loc12_ * _loc12_);
  if (_loc17_ < 0.00001) {
    return Infinity;
  }
  var _loc18_ = 1 / _loc17_;
  _loc11_ *= _loc18_;
  _loc12_ *= _loc18_;
  var _loc19_ = -(_loc16_ - _loc14_);
  var _loc20_ = _loc15_ - _loc13_;
  var _loc21_ = _loc13_ - _loc6_;
  var _loc22_ = _loc14_ - _loc7_;
  var _loc23_ = _loc11_ * _loc19_ + _loc12_ * _loc20_;
  if (_loc23_ < 0 && lineShape.oneSide === 0) {
    _loc19_ = -_loc19_;
    _loc20_ = -_loc20_;
    _loc23_ = -_loc23_;
  }
  var _loc24_ = _loc21_ * _loc19_ + _loc22_ * _loc20_;
  var _loc25_ = _loc23_ < 0.00001 ? -1 : (_loc24_ - _loc10_ * silabar(_loc19_ * _loc19_ + _loc20_ * _loc20_)) / _loc23_;
  if (_loc25_ > 0) {
    _loc26_ = _loc15_ - _loc13_;
    _loc27_ = _loc16_ - _loc14_;
    _loc28_ = (_loc6_ + _loc25_ * _loc11_ - _loc13_) * _loc26_ + (_loc7_ + _loc25_ * _loc12_ - _loc14_) * _loc27_;
    if (_loc28_ < 0 || _loc28_ > _loc26_ * _loc26_ + _loc27_ * _loc27_) {
      _loc25_ = -1;
    }
  }
  _loc26_ = _loc21_ * _loc11_ + _loc22_ * _loc12_;
  _loc27_ = _loc26_ * _loc26_ - (_loc21_ * _loc21_ + _loc22_ * _loc22_) + _loc10_ * _loc10_;
  _loc28_ = _loc27_ < 0 ? -1 : _loc26_ - silabar(_loc27_);
  _loc21_ = _loc15_ - _loc6_;
  _loc22_ = _loc16_ - _loc7_;
  _loc26_ = _loc21_ * _loc11_ + _loc22_ * _loc12_;
  _loc27_ = _loc26_ * _loc26_ - (_loc21_ * _loc21_ + _loc22_ * _loc22_) + _loc10_ * _loc10_;
  var _loc29_ = _loc27_ < 0 ? -1 : _loc26_ - silabar(_loc27_);
  var _loc30_ = _loc17_;
  if (_loc25_ > 0 && _loc25_ < _loc17_) {
    _loc30_ = _loc25_;
  }
  if (_loc28_ > 0 && _loc28_ < _loc30_) {
    _loc30_ = _loc28_;
  }
  if (_loc29_ > 0 && _loc29_ < _loc30_) {
    _loc30_ = _loc29_;
  }
  if (_loc30_ < _loc17_) {
    _loc31_ = (_loc30_ + 2) / _loc17_;
    return _loc31_;
  }
  return Infinity;
}

// ===========================================================================
// ContactPoint  — AS3 lines 11-376 (subset: init, preSolve, solve, update)
//
// Body fields: linearVelocityX, linearVelocityY, angularVelocity,
//   pseudoLinearVelocityX, pseudoLinearVelocityY, pseudoAngularVelocity,
//   invMass, invInertia, x, y.
// Shape fields: restitution, friction, surfaceVelocityNormal,
//   surfaceVelocityTangent, parent (the body).
//
// Per instructions (no flippers):
//   usePreviousAngularVelocity is false, s1.flipper/rotationState never taken,
//   so in preSolve the term `_loc3_ = (_loc1_||_loc2_)?0:-1` simplifies to -1.
//   The comparison `if(rvn > _loc3_) rvn = 0` is transcribed faithfully as
//   `if (rvn > -1) rvn = 0`.
//   cacheAngularVelocities() is a no-op (empty) here.
// ===========================================================================
function ContactPoint() {
  // Field initialization mirroring the AS3 constructor (lines 120-166).
  this.nx = 0;
  this.ny = 0;
  this.tx = 0;
  this.ty = 0;
  this.x = 0;
  this.y = 0;
  this.rp1x = 0;
  this.rp1y = 0;
  this.rp2x = 0;
  this.rp2y = 0;
  this.rvan1 = 0;
  this.rvan2 = 0;
  this.rvat1 = 0;
  this.rvat2 = 0;
  this.uv1nx = 0;
  this.uv1ny = 0;
  this.uv1na = 0;
  this.uv2nx = 0;
  this.uv2ny = 0;
  this.uv2na = 0;
  this.uv1tx = 0;
  this.uv1ty = 0;
  this.uv1ta = 0;
  this.uv2tx = 0;
  this.uv2ty = 0;
  this.uv2ta = 0;
  this.denomn = 0;
  this.denomt = 0;
  this.overlap = 0;
  this.target = 0;
  this.targetPseudoVelocity = 0;
  this.impulseN = 0;
  this.impulseT = 0;
  this.impulseP = 0;
  this.friction = 0;
  this.restitution = 0;
  this.rvn = 0;
  this.rvnBias = 0;
  this.rvtBias = 0;
  this.angularVelocityCache1 = 0;
  this.angularVelocityCache2 = 0;
  this.cachedAngularVelocity1 = false;
  this.cachedAngularVelocity2 = false;
  this.warmStarting = false;
  this.id = 0;
  this.disabled = false;
  this.s1 = null;
  this.s2 = null;
  this.b1 = null;
  this.b2 = null;
}

// cacheAngularVelocities() — no-op per instructions (no flippers).
ContactPoint.prototype.cacheAngularVelocities = function () {
  // intentionally empty
};

// init  — AS3 lines 324-355
ContactPoint.prototype.init = function (param1, param2, param3, param4, param5, param6, param7, param8) {
  this.s1 = param1;
  this.s2 = param2;
  this.x = param3;
  this.y = param4;
  this.nx = param5;
  this.ny = param6;
  this.overlap = param7;
  this.disabled = param8;
  this.targetPseudoVelocity = param7;
  this.tx = -param6;
  this.ty = param5;
  this.b1 = param1.parent;
  this.b2 = param2.parent;
  this.rp1x = param3 - this.b1.x;
  this.rp1y = param4 - this.b1.y;
  this.rp2x = param3 - this.b2.x;
  this.rp2y = param4 - this.b2.y;
  this.rvan1 = this.rp1x * param6 - this.rp1y * param5;
  this.rvan2 = this.rp2x * param6 - this.rp2y * param5;
  this.rvat1 = this.rp1x * this.ty - this.rp1y * this.tx;
  this.rvat2 = this.rp2x * this.ty - this.rp2y * this.tx;
  this.impulseN = 0;
  this.impulseT = 0;
  this.impulseP = 0;
  this.rvnBias = -(param1.surfaceVelocityNormal + param2.surfaceVelocityNormal);
  this.rvtBias = param1.surfaceVelocityTangent + param2.surfaceVelocityTangent;
  this.cacheAngularVelocities();
  this.rvn = param5 * (this.b2.linearVelocityX - this.b1.linearVelocityX) + param6 * (this.b2.linearVelocityY - this.b1.linearVelocityY) + (this.rvan2 * this.b2.angularVelocity - this.rvan1 * this.b1.angularVelocity) + this.rvnBias;
  this.warmStarting = false;
};

// update  — AS3 lines 169-193
ContactPoint.prototype.update = function (param1, param2, param3, param4, param5, param6) {
  this.x = param1;
  this.y = param2;
  this.nx = param3;
  this.ny = param4;
  this.overlap = param5;
  this.disabled = param6;
  this.targetPseudoVelocity = param5;
  this.tx = -param4;
  this.ty = param3;
  this.rp1x = param1 - this.b1.x;
  this.rp1y = param2 - this.b1.y;
  this.rp2x = param1 - this.b2.x;
  this.rp2y = param2 - this.b2.y;
  this.rvan1 = this.rp1x * param4 - this.rp1y * param3;
  this.rvan2 = this.rp2x * param4 - this.rp2y * param3;
  this.rvat1 = this.rp1x * this.ty - this.rp1y * this.tx;
  this.rvat2 = this.rp2x * this.ty - this.rp2y * this.tx;
  this.rvnBias = -(this.s1.surfaceVelocityNormal + this.s2.surfaceVelocityNormal);
  this.rvtBias = this.s1.surfaceVelocityTangent + this.s2.surfaceVelocityTangent;
  this.cacheAngularVelocities();
  this.rvn = param3 * (this.b2.linearVelocityX - this.b1.linearVelocityX) + param4 * (this.b2.linearVelocityY - this.b1.linearVelocityY) + (this.rvan2 * this.b2.angularVelocity - this.rvan1 * this.b1.angularVelocity) + this.rvnBias;
  this.warmStarting = true;
};

// preSolve  — AS3 lines 253-306
ContactPoint.prototype.preSolve = function () {
  if (this.disabled) {
    return;
  }
  this.restitution = silabar(this.s1.restitution * this.s2.restitution);
  this.friction = silabar(this.s1.friction * this.s2.friction);
  this.denomn = this.b1.invMass + this.b2.invMass;
  this.denomn += this.rvan1 * this.rvan1 * this.b1.invInertia;
  this.denomn += this.rvan2 * this.rvan2 * this.b2.invInertia;
  this.denomn = 1 / this.denomn;
  this.denomt = this.b1.invMass + this.b2.invMass;
  this.denomt += this.rvat1 * this.rvat1 * this.b1.invInertia;
  this.denomt += this.rvat2 * this.rvat2 * this.b2.invInertia;
  this.denomt = 1 / this.denomt;
  // No flippers: _loc1_ and _loc2_ are false, so _loc3_ = -1.
  var _loc3_ = -1;
  if (this.rvn > _loc3_) {
    this.rvn = 0;
  }
  var _loc4_ = this.overlap < 0.5 ? 0 : (this.overlap - 0.5) * 0.2;
  this.target = -this.rvn * this.restitution;
  this.targetPseudoVelocity = _loc4_;
  this.uv1nx = this.nx * this.b1.invMass;
  this.uv1ny = this.ny * this.b1.invMass;
  this.uv1na = (this.rp1x * this.ny - this.rp1y * this.nx) * this.b1.invInertia;
  this.uv2nx = this.nx * this.b2.invMass;
  this.uv2ny = this.ny * this.b2.invMass;
  this.uv2na = (this.rp2x * this.ny - this.rp2y * this.nx) * this.b2.invInertia;
  this.uv1tx = this.tx * this.b1.invMass;
  this.uv1ty = this.ty * this.b1.invMass;
  this.uv1ta = (this.rp1x * this.ty - this.rp1y * this.tx) * this.b1.invInertia;
  this.uv2tx = this.tx * this.b2.invMass;
  this.uv2ty = this.ty * this.b2.invMass;
  this.uv2ta = (this.rp2x * this.ty - this.rp2y * this.tx) * this.b2.invInertia;
  if (this.warmStarting) {
    this.b1.linearVelocityX += this.uv1nx * this.impulseN + this.uv1tx * this.impulseT;
    this.b1.linearVelocityY += this.uv1ny * this.impulseN + this.uv1ty * this.impulseT;
    this.b1.angularVelocity += this.uv1na * this.impulseN + this.uv1ta * this.impulseT;
    this.b2.linearVelocityX -= this.uv2nx * this.impulseN + this.uv2tx * this.impulseT;
    this.b2.linearVelocityY -= this.uv2ny * this.impulseN + this.uv2ty * this.impulseT;
    this.b2.angularVelocity -= this.uv2na * this.impulseN + this.uv2ta * this.impulseT;
  } else {
    this.impulseN = 0;
    this.impulseT = 0;
  }
  this.impulseP = 0;
};

// solve  — AS3 lines 195-251
ContactPoint.prototype.solve = function () {
  if (this.disabled) {
    return;
  }
  var _loc1_ = this.nx * (this.b2.linearVelocityX - this.b1.linearVelocityX) + this.ny * (this.b2.linearVelocityY - this.b1.linearVelocityY) + (this.rvan2 * this.b2.angularVelocity - this.rvan1 * this.b1.angularVelocity) + this.rvnBias;
  var _loc2_ = (_loc1_ - this.target) * this.denomn;
  var _loc3_ = this.impulseN;
  this.impulseN += _loc2_;
  if (this.impulseN > 0) {
    this.impulseN = 0;
  }
  _loc2_ = this.impulseN - _loc3_;
  this.b1.linearVelocityX += this.uv1nx * _loc2_;
  this.b1.linearVelocityY += this.uv1ny * _loc2_;
  this.b1.angularVelocity += this.uv1na * _loc2_;
  this.b2.linearVelocityX -= this.uv2nx * _loc2_;
  this.b2.linearVelocityY -= this.uv2ny * _loc2_;
  this.b2.angularVelocity -= this.uv2na * _loc2_;
  var _loc4_ = this.tx * (this.b2.linearVelocityX - this.b1.linearVelocityX) + this.ty * (this.b2.linearVelocityY - this.b1.linearVelocityY) + (this.rvat2 * this.b2.angularVelocity - this.rvat1 * this.b1.angularVelocity) + this.rvtBias;
  var _loc5_ = _loc4_ * this.denomt;
  var _loc6_ = this.impulseT;
  this.impulseT += _loc5_;
  var _loc7_ = -this.impulseN * this.friction;
  if (this.impulseT > _loc7_) {
    this.impulseT = _loc7_;
  } else if (this.impulseT < -_loc7_) {
    this.impulseT = -_loc7_;
  }
  _loc5_ = this.impulseT - _loc6_;
  this.b1.linearVelocityX += this.uv1tx * _loc5_;
  this.b1.linearVelocityY += this.uv1ty * _loc5_;
  this.b1.angularVelocity += this.uv1ta * _loc5_;
  this.b2.linearVelocityX -= this.uv2tx * _loc5_;
  this.b2.linearVelocityY -= this.uv2ty * _loc5_;
  this.b2.angularVelocity -= this.uv2ta * _loc5_;
  var _loc8_ = this.nx * (this.b2.pseudoLinearVelocityX - this.b1.pseudoLinearVelocityX) + this.ny * (this.b2.pseudoLinearVelocityY - this.b1.pseudoLinearVelocityY) + (this.rvan2 * this.b2.pseudoAngularVelocity - this.rvan1 * this.b1.pseudoAngularVelocity);
  var _loc9_ = (_loc8_ - this.targetPseudoVelocity) * this.denomn;
  var _loc10_ = this.impulseP;
  this.impulseP += _loc9_;
  if (this.impulseP > 0) {
    this.impulseP = 0;
  }
  _loc9_ = this.impulseP - _loc10_;
  this.b1.pseudoLinearVelocityX += this.uv1nx * _loc9_;
  this.b1.pseudoLinearVelocityY += this.uv1ny * _loc9_;
  this.b1.pseudoAngularVelocity += this.uv1na * _loc9_;
  this.b2.pseudoLinearVelocityX -= this.uv2nx * _loc9_;
  this.b2.pseudoLinearVelocityY -= this.uv2ny * _loc9_;
  this.b2.pseudoAngularVelocity -= this.uv2na * _loc9_;
};

// ===========================================================================
// Body.integrate  — AS3 lines 311-362
//
// `body` carries: type (compared to BodyType.Static), linearVelocityX/Y,
//   angularVelocity, limitMaxLinearVelocity, maxLinearVelocity,
//   limitMaxAngularVelocity, maxAngularVelocity, linearDamping, angularDamping,
//   x, y, angle, pseudoLinearVelocityX/Y, pseudoAngularVelocity.
//
// AS3 compares `type == BodyType.Static`. Here we treat the body as static iff
// body.isStatic === true (caller sets this). For gacha the ball is Dynamic, so
// the else branch runs. param1 is the timestep.
// ===========================================================================
function bodyIntegrate(body, param1) {
  var _loc2_ = NaN;
  var _loc3_ = NaN;
  var _loc4_ = NaN;
  if (body.isStatic === true) {   // AS3: type == BodyType.Static
    body.linearVelocityX = 0;
    body.linearVelocityY = 0;
    body.angularVelocity = 0;
  } else {
    _loc2_ = body.linearVelocityX * body.linearVelocityX + body.linearVelocityY * body.linearVelocityY;
    if (body.limitMaxLinearVelocity && _loc2_ > body.maxLinearVelocity * body.maxLinearVelocity) {
      _loc3_ = body.maxLinearVelocity / silabar(_loc2_);
      body.linearVelocityX *= _loc3_;
      body.linearVelocityY *= _loc3_;
    }
    if (body.limitMaxAngularVelocity) {
      if (body.angularVelocity < -body.maxAngularVelocity) {
        body.angularVelocity = -body.maxAngularVelocity;
      } else if (body.angularVelocity > body.maxAngularVelocity) {
        body.angularVelocity = body.maxAngularVelocity;
      }
    }
    if (body.linearDamping > 0) {
      _loc3_ = body.linearDamping * param1;
      _loc4_ = 1 / (1 + _loc3_ * (1 + _loc3_ * (0.5 + _loc3_ * 0.16666666666666666)));
      body.linearVelocityX *= _loc4_;
      body.linearVelocityY *= _loc4_;
    }
    if (body.angularDamping > 0) {
      _loc3_ = body.angularDamping * param1;
      _loc4_ = 1 / (1 + _loc3_ * (1 + _loc3_ * (0.5 + _loc3_ * 0.16666666666666666)));
      body.angularVelocity *= _loc4_;
    }
    body.x += body.linearVelocityX * param1 + body.pseudoLinearVelocityX;
    body.y += body.linearVelocityY * param1 + body.pseudoLinearVelocityY;
    body.angle += body.angularVelocity * param1 + body.pseudoAngularVelocity;
  }
  body.pseudoLinearVelocityX = 0;
  body.pseudoLinearVelocityY = 0;
  body.pseudoAngularVelocity = 0;
}

module.exports = {
  silabar: silabar,
  vowe: vowe,
  ruzil: ruzil,
  circleCircleDetect: circleCircleDetect,
  circleCircleCCD: circleCircleCCD,
  circleLineDetect: circleLineDetect,
  circleLineCCD: circleLineCCD,
  ContactPoint: ContactPoint,
  bodyIntegrate: bodyIntegrate,
};

if (require.main === module) {
  console.log('silabar(2)      =', silabar(2));        // sqrt(2) ~ 1.4142135623730951
  console.log('vowe(0)         =', vowe(0));            // cos(0)  ~ 1
  console.log('ruzil(Math.PI/2)=', ruzil(Math.PI / 2)); // sin(pi/2) ~ 1
}
