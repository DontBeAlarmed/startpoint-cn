package pinball.ui.component.pixelArtCharacter
{
   import flash.Boot;
   import flash.geom.Matrix;
   import flatomo.animation.Animation;
   import flatomo.animation.AnimationSourceKind;
   import haxe.ds.Option;
   import jp.sipo.gipo.core.GearHolderImpl;
   import jp.sipo.gipo.core.handler.AddBehaviorPreset;
   import jp.sipo.gipo.core.handler.GearDispatcherHandler;
   import jp.sipo.gipo.core.handler.GenericGearDispatcher;
   import jp.sipo.util.SipoError;
   import pinball.asset.AssetGroupKind;
   import pinball.asset.view.ViewAssetContainer;
   import pinball.common.tools._FunctionTools.BindImpl1_0;
   import pinball.error.ClientError;
   import pinball.productionView.ProductionView;
   import pinball.ui.component.pixelArtCharacter._PixelArtCharacterView.PixelArtCharacterAnimationAssetProvider;
   import pinball.ui.component.rarity.RarityView;
   import pinball.ui.component.rarity.RarityViewBackgroundStyle;
   import pinball.ui.component.stackNumber.CharacterStackNumberView;
   import starling.display.Image;
   import starling.display.Sprite;
   import starling.textures.TextureSmoothing;
   import starling.utils.Align;
   
   public class PixelArtCharacterView extends GearHolderImpl
   {
      
      public static var __meta__:* = {"fields":{"view":{"absorb":["pinball.productionView.ProductionView"]}}};
      
      public var view:ProductionView;
      
      public var tempTransformation:Object;
      
      public var stackNumberView:Option;
      
      public var stackNumberLayer:Sprite;
      
      public var showsStack:Boolean;
      
      public var readyToShowDispatcher:GenericGearDispatcher;
      
      public var rarityView:Option;
      
      public var rarityLayer:Sprite;
      
      public var peek:PixelArtCharacterPeek;
      
      public var pedestalLevelUpEffectAnimation:Animation;
      
      public var pedestal:Image;
      
      public var matrixProvider:CharacterOnPedestalMatrixProvider;
      
      public var layer:Sprite;
      
      public var isSpriteSheetLoading:Boolean;
      
      public var currentPedestalSize:Option;
      
      public var characterShadow:Image;
      
      public var characterLayer:Sprite;
      
      public var characterId:Option;
      
      public var character:Option;
      
      public var assetGroupKind:Option;
      
      public var animationKind:PixelArtCharacterAnimationKind;
      
      public var animationEffectLayer:Sprite;
      
      public var _smoothing:String;
      
      public function PixelArtCharacterView(param1:PixelArtCharacterPeek = undefined)
      {
         if(Boot.skip_constructor)
         {
            return;
         }
         super();
         peek = param1;
         character = Option.None;
         characterId = param1.characterId;
         animationKind = param1.currentAnimationKind;
         currentPedestalSize = Option.None;
         assetGroupKind = Option.None;
         layer = new Sprite();
         characterLayer = new Sprite();
         rarityLayer = new Sprite();
         stackNumberLayer = new Sprite();
         animationEffectLayer = new Sprite();
         isSpriteSheetLoading = false;
         rarityView = Option.None;
         _smoothing = TextureSmoothing.NONE;
         showsStack = false;
         stackNumberView = Option.None;
         tempTransformation = {
            "alpha":1,
            "matrix":new Matrix(),
            "visible":true
         };
         var _loc2_:GenericGearDispatcher = new GenericGearDispatcher(AddBehaviorPreset.addTail,false,{
            "fileName":"pinball/ui/component/pixelArtCharacter/PixelArtCharacterView.hx",
            "lineNumber":173,
            "className":"pinball.ui.component.pixelArtCharacter.PixelArtCharacterView",
            "methodName":"new"
         });
         readyToShowDispatcher = _loc2_;
         gear.addRunHandler(run,{
            "fileName":"pinball/ui/component/pixelArtCharacter/PixelArtCharacterView.hx",
            "lineNumber":175,
            "className":"pinball.ui.component.pixelArtCharacter.PixelArtCharacterView",
            "methodName":"new"
         });
         gear.disposeTask(dispose,{
            "fileName":"pinball/ui/component/pixelArtCharacter/PixelArtCharacterView.hx",
            "lineNumber":176,
            "className":"pinball.ui.component.pixelArtCharacter.PixelArtCharacterView",
            "methodName":"new"
         });
      }
      
      public function spriteSheetLoadCompleted(param1:String) : void
      {
         var _loc2_:* = null as String;
         var _loc4_:Boolean = false;
         var _loc5_:* = null as ViewAssetContainer;
         var _loc6_:* = null as String;
         var _loc7_:* = null as Array;
         var _loc8_:* = null as String;
         var _loc9_:* = null as AnimationSourceKind;
         var _loc10_:* = null as Option;
         var _loc11_:* = null as AssetGroupKind;
         var _loc12_:* = null as Animation;
         var _loc13_:* = null as Option;
         var _loc14_:* = null as GenericGearDispatcher;
         isSpriteSheetLoading = false;
         var _loc3_:Option = peek.getAnimationPath();
         switch(_loc3_.index)
         {
            case 0:
               _loc2_ = _loc3_.params[0];
               break;
            case 1:
               _loc2_ = null;
         }
         if(gear.checkPhaseBeforeDispose() && _loc2_ == param1 && view.asset.hasAnimation(param1))
         {
            _loc5_ = view.asset;
            if(param1.lastIndexOf("character/",0) == 0)
            {
               _loc7_ = param1.split("/");
               if(_loc7_[int(_loc7_.length) - 1] == "special")
               {
                  _loc7_.pop();
                  _loc7_.push("special_sprite_sheet");
               }
               else
               {
                  _loc7_.pop();
                  _loc7_.push("sprite_sheet");
               }
               _loc6_ = _loc7_.join("/");
            }
            else if(param1.lastIndexOf("ability_node/",0) == 0)
            {
               _loc6_ = "ability_node/sprite_sheet";
            }
            else if(param1.lastIndexOf("scene/",0) == 0)
            {
               _loc7_ = param1.split("/");
               _loc7_ = _loc7_.slice(0,2);
               _loc7_.push("sprite_sheet");
               _loc6_ = _loc7_.join("/");
            }
            else if(param1.lastIndexOf("battle/common/layer0",0) == 0)
            {
               _loc6_ = "battle/common/layer0";
            }
            else if(param1.lastIndexOf("battle/common/layer1",0) == 0)
            {
               _loc6_ = "battle/common/layer1";
            }
            else if(param1.lastIndexOf("town/particle/",0) == 0)
            {
               _loc7_ = param1.split("/");
               _loc7_ = _loc7_.slice(0,int(_loc7_.length) - 1);
               _loc7_.push("sprite_sheet");
               _loc6_ = _loc7_.join("/");
            }
            else
            {
               _loc7_ = param1.split("/");
               _loc7_.pop();
               _loc8_ = _loc7_.pop();
               _loc7_.push(_loc8_);
               _loc7_.push(_loc8_);
               _loc6_ = _loc7_.join("/");
            }
            _loc4_ = _loc5_.hasSpriteSheet(_loc6_);
         }
         else
         {
            _loc4_ = false;
         }
         if(_loc4_)
         {
            _loc9_ = view.asset.getAnimationLayoutData(param1);
            _loc10_ = assetGroupKind;
            switch(_loc10_.index)
            {
               case 0:
                  _loc11_ = _loc10_.params[0];
                  break;
               case 1:
                  _loc11_ = AssetGroupKind.PixelArtCharacterAnimation;
            }
            _loc12_ = Animation.parse(_loc9_,new PixelArtCharacterAnimationAssetProvider(view.asset,_loc11_));
            _loc12_.touchable = false;
            _loc12_.scale = _loc12_.scale / 6;
            _loc12_.set_smoothing(_smoothing);
            _loc13_ = character;
            switch(_loc13_.index)
            {
               case 0:
                  _loc13_.params[0].removeFromParent(true);
                  break;
               default:
               case 1:
            }
            characterLayer.addChild(_loc12_);
            character = Option.Some(_loc12_);
            setCharacterShadowVisible(true);
            _loc13_ = currentPedestalSize;
            switch(_loc13_.index)
            {
               case 0:
                  drawCharacterAndPedestalAnimation(int(_loc13_.params[0]));
                  break;
               default:
               case 1:
            }
            _loc14_ = readyToShowDispatcher;
            if(_loc14_.get_executing())
            {
               Boot.lastError = new Error();
               throw new SipoError(1002,"イベントの実行が再帰しています",{
                  "fileName":"jp/sipo/gipo/core/handler/GenericGearDispatcher.hx",
                  "lineNumber":104,
                  "className":"jp.sipo.gipo.core.handler.GenericGearDispatcher",
                  "methodName":"beforeExecute"
               });
            }
            _loc14_.executingHandlers = _loc14_.handlers;
            _loc14_.executingIndex = 0;
            if(_loc14_.once)
            {
               _loc14_.clear();
            }
            if(_loc14_.executingHandlers != null)
            {
               while(_loc14_.executingIndex < int(_loc14_.executingHandlers.length))
               {
                  _loc14_.executingHandlers[_loc14_.executingIndex].func();
                  ++_loc14_.executingIndex;
               }
            }
            _loc14_.executingHandlers = null;
            _loc14_.executingIndex = -1;
         }
      }
      
      public function showStack() : void
      {
         showsStack = true;
         drawStack();
      }
      
      public function showRarity() : void
      {
         var _loc3_:int = 0;
         var _loc4_:* = null as RarityView;
         var _loc5_:int = 0;
         var _loc1_:Option = rarityView;
         var _loc2_:Option = peek.get_rarity();
         switch(_loc2_.index)
         {
            case 0:
               _loc3_ = int(_loc2_.params[0]);
               switch(_loc1_.index)
               {
                  case 0:
                     _loc4_ = _loc1_.params[0];
                     _loc4_.show();
                     _loc5_ = _loc3_;
                     if(_loc5_ < 1 || _loc5_ > 5)
                     {
                        Boot.lastError = new Error();
                        throw new ClientError(4204,"レアリティの星の数として有効な数値は" + 1 + "から" + 5 + "までです");
                     }
                     _loc4_.setRarity(_loc5_);
                     break;
                  case 1:
                     rarityLayer.x = 3;
                     rarityLayer.y = -51;
                     _loc4_ = new RarityView(rarityLayer,RarityViewBackgroundStyle.Plate);
                     gear.addChild(_loc4_,{
                        "fileName":"pinball/ui/component/pixelArtCharacter/PixelArtCharacterView.hx",
                        "lineNumber":484,
                        "className":"pinball.ui.component.pixelArtCharacter.PixelArtCharacterView",
                        "methodName":"showRarity"
                     });
                     _loc5_ = _loc3_;
                     if(_loc5_ < 1 || _loc5_ > 5)
                     {
                        Boot.lastError = new Error();
                        throw new ClientError(4204,"レアリティの星の数として有効な数値は" + 1 + "から" + 5 + "までです");
                     }
                     _loc4_.setRarity(_loc5_);
                     rarityView = Option.Some(_loc4_);
               }
               break;
            case 1:
               switch(_loc1_.index)
               {
                  case 0:
                     _loc1_.params[0].hide();
                     break;
                  case 1:
               }
         }
      }
      
      public function set_y(param1:Number) : Number
      {
         return layer.y = param1;
      }
      
      public function set_x(param1:Number) : Number
      {
         return layer.x = param1;
      }
      
      public function set_touchable(param1:Boolean) : Boolean
      {
         return layer.touchable = param1;
      }
      
      public function set_smoothing(param1:String) : String
      {
         var _loc2_:PixelArtCharacterView = this;
         if(param1 == _smoothing)
         {
            return _smoothing;
         }
         _smoothing = param1;
         var _loc3_:Option = character;
         switch(_loc3_.index)
         {
            case 0:
               _loc3_.params[0].set_smoothing(_loc2_._smoothing);
               break;
            default:
            case 1:
         }
         if(pedestal != null)
         {
            pedestal.textureSmoothing = _smoothing;
         }
         characterShadow.textureSmoothing = _smoothing;
         return _smoothing;
      }
      
      public function setStack(param1:int) : void
      {
         var _loc3_:* = null as CharacterStackNumberView;
         if(param1 == 0)
         {
            hideStack();
            return;
         }
         var _loc2_:Option = stackNumberView;
         switch(_loc2_.index)
         {
            case 0:
               _loc3_ = _loc2_.params[0];
               _loc3_.visible = true;
               _loc3_.set(param1);
               break;
            case 1:
               _loc3_ = new CharacterStackNumberView(view.asset,param1);
               _loc3_.x = -89;
               _loc3_.y = -133;
               stackNumberLayer.addChild(_loc3_);
               stackNumberView = Option.Some(_loc3_);
         }
      }
      
      public function setCharacterShadowVisible(param1:Boolean) : void
      {
         characterShadow.visible = param1 && !PixelArtCharacterAnimationKindTools.isSpecial(animationKind);
      }
      
      public function run() : void
      {
         matrixProvider = new CharacterOnPedestalMatrixProvider(view.asset);
         gear.addChild(matrixProvider,{
            "fileName":"pinball/ui/component/pixelArtCharacter/PixelArtCharacterView.hx",
            "lineNumber":187,
            "className":"pinball.ui.component.pixelArtCharacter.PixelArtCharacterView",
            "methodName":"run"
         });
         layer.addChild(characterLayer);
         layer.addChild(rarityLayer);
         layer.addChild(stackNumberLayer);
         layer.addChild(animationEffectLayer);
         characterShadow = view.asset.getImage("character_pedestal/common/pixel_art_character_shadow");
         characterShadow.textureSmoothing = _smoothing;
         characterShadow.visible = false;
         characterShadow.x = -4;
         characterShadow.y = -2;
         characterLayer.addChildAt(characterShadow,0);
         characterLayer.scale = 6;
         pedestalLevelUpEffectAnimation = view.asset.getAnimation("scene/general/animation/character_level_up_effect");
         animationEffectLayer.addChild(pedestalLevelUpEffectAnimation);
         resetCharacter();
      }
      
      public function resetCharacter() : void
      {
         var _loc2_:* = null as String;
         var _loc3_:* = null as Option;
         var _loc4_:* = null as AssetGroupKind;
         var _loc5_:* = null as GenericGearDispatcher;
         var _loc1_:Option = peek.getAnimationPath();
         switch(_loc1_.index)
         {
            case 0:
               _loc2_ = _loc1_.params[0];
               isSpriteSheetLoading = true;
               _loc3_ = assetGroupKind;
               switch(_loc3_.index)
               {
                  case 0:
                     _loc4_ = _loc3_.params[0];
                     break;
                  case 1:
                     _loc4_ = AssetGroupKind.PixelArtCharacterAnimation;
               }
               view.asset.setAnimationToSpecifiedGroup(_loc4_,_loc2_,new BindImpl1_0(animationLoadCompleted,_loc2_).execute);
               break;
            case 1:
               _loc5_ = readyToShowDispatcher;
               if(_loc5_.get_executing())
               {
                  Boot.lastError = new Error();
                  throw new SipoError(1002,"イベントの実行が再帰しています",{
                     "fileName":"jp/sipo/gipo/core/handler/GenericGearDispatcher.hx",
                     "lineNumber":104,
                     "className":"jp.sipo.gipo.core.handler.GenericGearDispatcher",
                     "methodName":"beforeExecute"
                  });
               }
               _loc5_.executingHandlers = _loc5_.handlers;
               _loc5_.executingIndex = 0;
               if(_loc5_.once)
               {
                  _loc5_.clear();
               }
               if(_loc5_.executingHandlers != null)
               {
                  while(_loc5_.executingIndex < int(_loc5_.executingHandlers.length))
                  {
                     _loc5_.executingHandlers[_loc5_.executingIndex].func();
                     ++_loc5_.executingIndex;
                  }
               }
               _loc5_.executingHandlers = null;
               _loc5_.executingIndex = -1;
               characterShadow.visible = false;
               _loc3_ = character;
               switch(_loc3_.index)
               {
                  case 0:
                     _loc3_.params[0].removeFromParent(true);
                     break;
                  default:
                  case 1:
               }
               character = Option.None;
         }
      }
      
      public function reset() : void
      {
         var _loc2_:* = null as RarityView;
         var _loc3_:* = null as Option;
         var _loc4_:int = 0;
         var _loc5_:int = 0;
         animationKind = peek.currentAnimationKind;
         characterId = peek.characterId;
         resetCharacter();
         var _loc1_:Option = currentPedestalSize;
         switch(_loc1_.index)
         {
            case 0:
               applyPedestal(int(_loc1_.params[0]));
               break;
            default:
            case 1:
         }
         _loc1_ = rarityView;
         switch(characterId.index)
         {
            case 0:
               if(_loc1_.index == 0)
               {
                  _loc2_ = _loc1_.params[0];
                  _loc2_.show();
                  _loc3_ = peek.get_rarity();
                  switch(_loc3_.index)
                  {
                     case 0:
                        _loc4_ = int(_loc3_.params[0]);
                        break;
                     case 1:
                        Boot.lastError = new Error();
                        throw new ClientError(7511,"キャラクターのレアリティが取得できませんでした");
                  }
                  _loc5_ = _loc4_;
                  if(_loc5_ < 1 || _loc5_ > 5)
                  {
                     Boot.lastError = new Error();
                     throw new ClientError(4204,"レアリティの星の数として有効な数値は" + 1 + "から" + 5 + "までです");
                  }
                  _loc2_.setRarity(_loc5_);
               }
               break;
            case 1:
               if(_loc1_.index == 0)
               {
                  _loc1_.params[0].hide();
               }
         }
      }
      
      public function needsReset() : Boolean
      {
         var _loc4_:Boolean = false;
         var _loc1_:PixelArtCharacterAnimationKind = peek.currentAnimationKind;
         var _loc2_:Boolean = PixelArtCharacterAnimationKindTools.isSpecial(_loc1_);
         var _loc3_:Boolean = PixelArtCharacterAnimationKindTools.isSpecial(animationKind);
         var _loc5_:Option = characterId;
         var _loc6_:Option = peek.characterId;
         switch(_loc6_.index)
         {
            case 0:
               _loc4_ = _loc5_.index == 0 ? (int(_loc6_.params[0]) == int(_loc5_.params[0]) ? false : true) : true;
               break;
            case 1:
               _loc4_ = _loc5_.index == 1 ? false : true;
               break;
            default:
               _loc4_ = true;
         }
         if(!_loc4_)
         {
            return _loc2_ != _loc3_;
         }
         return true;
      }
      
      public function hideStack() : void
      {
         var _loc1_:Option = stackNumberView;
         switch(_loc1_.index)
         {
            case 0:
               _loc1_.params[0].visible = false;
               break;
            default:
            case 1:
         }
      }
      
      public function get_y() : Number
      {
         return layer.y;
      }
      
      public function get_x() : Number
      {
         return layer.x;
      }
      
      public function get_touchable() : Boolean
      {
         return layer.touchable;
      }
      
      public function get_smoothing() : String
      {
         return _smoothing;
      }
      
      public function get_pedestalHeight() : Number
      {
         return 192;
      }
      
      public function drawStack() : void
      {
         if(!showsStack)
         {
            return;
         }
         var _loc1_:Option = peek.stack;
         switch(_loc1_.index)
         {
            case 0:
               setStack(int(_loc1_.params[0]));
               break;
            case 1:
               hideStack();
         }
      }
      
      public function drawCharacterAndPedestalAnimation(param1:int) : void
      {
         var _loc4_:* = null as Animation;
         var _loc2_:int = peek.getPedestalCurrentFrame(param1);
         var _loc3_:Option = character;
         switch(_loc3_.index)
         {
            case 0:
               _loc4_ = _loc3_.params[0];
               matrixProvider.getCharacterMatrix(param1,_loc2_,tempTransformation);
               _loc4_.transformationMatrix = tempTransformation.matrix;
               _loc4_.alpha = Number(tempTransformation.alpha);
               _loc4_.visible = Boolean(tempTransformation.visible);
               matrixProvider.getCharacterShadowMatrix(param1,_loc2_,tempTransformation);
               characterShadow.transformationMatrix = tempTransformation.matrix;
               characterShadow.alpha = Number(tempTransformation.alpha);
               setCharacterShadowVisible(Boolean(tempTransformation.visible));
               break;
            default:
            case 1:
         }
         switch(param1)
         {
            case 0:
            case 1:
               matrixProvider.getPedestalMatrix(param1,_loc2_,tempTransformation);
               pedestal.transformationMatrix = tempTransformation.matrix;
               pedestal.alpha = Number(tempTransformation.alpha);
               pedestal.visible = Boolean(tempTransformation.visible);
               break;
            default:
            case 2:
         }
         _loc3_ = rarityView;
         if(_loc3_.index == 0)
         {
            matrixProvider.getAccessoryMatrix(_loc2_,tempTransformation);
            rarityLayer.transformationMatrix = tempTransformation.matrix;
            _temp_1.x += 3;
            _temp_2.y += -51;
            rarityLayer.alpha = Number(tempTransformation.alpha);
            rarityLayer.visible = Boolean(tempTransformation.visible);
         }
      }
      
      public function draw(param1:int) : void
      {
         var _loc3_:* = null as Option;
         var _loc2_:PixelArtCharacterView = this;
         if(needsReset())
         {
            reset();
         }
         drawStack();
         _loc3_ = currentPedestalSize;
         switch(_loc3_.index)
         {
            case 0:
               drawCharacterAndPedestalAnimation(int(_loc3_.params[0]));
               break;
            default:
            case 1:
         }
         pedestalLevelUpEffectAnimation.gotoAndStop(peek.getLevelUpEffectCurrentFrame());
         if(!isSpriteSheetLoading)
         {
            _loc3_ = character;
            switch(_loc3_.index)
            {
               case 0:
                  _loc3_.params[0].gotoAndStop(_loc2_.peek.getCurrentFrame());
                  break;
               default:
               case 1:
            }
         }
      }
      
      public function dispose() : void
      {
         layer.removeFromParent(true);
      }
      
      public function applyPedestal(param1:int) : void
      {
         if(pedestal != null)
         {
            characterLayer.removeChild(pedestal,true);
         }
         currentPedestalSize = Option.Some(param1);
         switch(param1)
         {
            case 0:
            case 1:
               pedestal = view.asset.getImage(peek.getPedestalImagePath(param1));
               pedestal.touchable = false;
               pedestal.textureSmoothing = _smoothing;
               pedestal.alignPivot(Align.CENTER,Align.BOTTOM);
               characterLayer.addChildAt(pedestal,0);
               break;
            default:
            case 2:
         }
         drawCharacterAndPedestalAnimation(param1);
      }
      
      public function animationLoadCompleted(param1:String) : void
      {
         var _loc2_:* = null as ViewAssetContainer;
         var _loc3_:* = null as Option;
         var _loc4_:* = null as AssetGroupKind;
         var _loc5_:* = null as String;
         var _loc6_:* = null as Array;
         var _loc7_:* = null as String;
         if(gear.checkPhaseBeforeDispose() && view.asset.hasAnimation(param1))
         {
            _loc2_ = view.asset;
            _loc3_ = assetGroupKind;
            switch(_loc3_.index)
            {
               case 0:
                  _loc4_ = _loc3_.params[0];
                  break;
               case 1:
                  _loc4_ = AssetGroupKind.PixelArtCharacterAnimation;
            }
            if(param1.lastIndexOf("character/",0) == 0)
            {
               _loc6_ = param1.split("/");
               if(_loc6_[int(_loc6_.length) - 1] == "special")
               {
                  _loc6_.pop();
                  _loc6_.push("special_sprite_sheet");
               }
               else
               {
                  _loc6_.pop();
                  _loc6_.push("sprite_sheet");
               }
               _loc5_ = _loc6_.join("/");
            }
            else if(param1.lastIndexOf("ability_node/",0) == 0)
            {
               _loc5_ = "ability_node/sprite_sheet";
            }
            else if(param1.lastIndexOf("scene/",0) == 0)
            {
               _loc6_ = param1.split("/");
               _loc6_ = _loc6_.slice(0,2);
               _loc6_.push("sprite_sheet");
               _loc5_ = _loc6_.join("/");
            }
            else if(param1.lastIndexOf("battle/common/layer0",0) == 0)
            {
               _loc5_ = "battle/common/layer0";
            }
            else if(param1.lastIndexOf("battle/common/layer1",0) == 0)
            {
               _loc5_ = "battle/common/layer1";
            }
            else if(param1.lastIndexOf("town/particle/",0) == 0)
            {
               _loc6_ = param1.split("/");
               _loc6_ = _loc6_.slice(0,int(_loc6_.length) - 1);
               _loc6_.push("sprite_sheet");
               _loc5_ = _loc6_.join("/");
            }
            else
            {
               _loc6_ = param1.split("/");
               _loc6_.pop();
               _loc7_ = _loc6_.pop();
               _loc6_.push(_loc7_);
               _loc6_.push(_loc7_);
               _loc5_ = _loc6_.join("/");
            }
            _loc2_.setSpriteSheetToSpecifiedGroup(_loc4_,_loc5_,new BindImpl1_0(spriteSheetLoadCompleted,param1).execute);
         }
      }
   }
}

