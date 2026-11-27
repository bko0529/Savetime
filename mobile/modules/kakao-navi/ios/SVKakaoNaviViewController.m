// 카카오모빌리티 공식 가이드(iOS 길찾기 UI SDK · 주행)의 순서를 그대로 따른다.
//  1) KNSDK 초기화 (네이티브 앱 키)
//  2) 위경도(WGS84) → 카텍(KATEC) 좌표로 바꿔 출발·목적지 POI 를 만든다
//  3) makeTrip 으로 경로를 만들고, KNNaviView 를 화면에 붙인다
//  4) KNGuidance 의 알림(델리게이트)을 모두 naviView 로 넘긴다 — 안 넘기면 주행 화면이 제대로 안 나온다(가이드 경고)
#import "SVKakaoNaviViewController.h"
#import <AVFoundation/AVFoundation.h>
#import <KNSDK/KNSDK.h>
#import <KNSDK/KNNaviView.h>

static BOOL svSdkReady = NO;

@interface SVKakaoNaviViewController () <KNGuidance_GuideStateDelegate,
                                         KNGuidance_RouteGuideDelegate,
                                         KNGuidance_VoiceGuideDelegate,
                                         KNGuidance_SafetyGuideDelegate,
                                         KNGuidance_LocationGuideDelegate,
                                         KNGuidance_CitsGuideDelegate,
                                         KNNaviView_GuideStateDelegate,
                                         KNNaviView_StateDelegate>
@property (nonatomic, strong, nullable) KNNaviView *naviView;
@property (nonatomic, copy) NSString *goalName;
@property (nonatomic) double goalLat, goalLng, startLat, startLng;
/// 길안내 엔진이 '안내 종료(목적지 도착)'를 알렸는지
@property (nonatomic) BOOL arrived;
@property (nonatomic) BOOL finished;
@end

@implementation SVKakaoNaviViewController

+ (void)initializeSdkWithAppKey:(NSString *)appKey
                  clientVersion:(NSString *)clientVersion
                        userKey:(NSString *)userKey
                     completion:(void (^)(NSString *_Nullable))completion {
  if (svSdkReady) {
    completion(nil);
    return;
  }
  [[KNSDK sharedInstance] initializeWithAppKey:appKey
                                 clientVersion:clientVersion
                                       userKey:userKey
                                    completion:^(KNError *aError) {
                                      dispatch_async(dispatch_get_main_queue(), ^{
                                        if (aError) {
                                          completion([NSString stringWithFormat:@"%@ %@", aError.code ?: @"", aError.msg ?: @""]);
                                        } else {
                                          svSdkReady = YES;
                                          completion(nil);
                                        }
                                      });
                                    }];
}

- (instancetype)initWithGoalName:(NSString *)goalName
                         goalLat:(double)goalLat
                         goalLng:(double)goalLng
                        startLat:(double)startLat
                        startLng:(double)startLng {
  if ((self = [super initWithNibName:nil bundle:nil])) {
    _goalName = [goalName copy];
    _goalLat = goalLat;
    _goalLng = goalLng;
    _startLat = startLat;
    _startLng = startLng;
    self.modalPresentationStyle = UIModalPresentationFullScreen;
  }
  return self;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;

  // 음성 안내가 끊기지 않게 (가이드 필수 설정): 다른 소리와 섞어서 재생
  AVAudioSession *audio = [AVAudioSession sharedInstance];
  [audio setCategory:AVAudioSessionCategoryPlayback withOptions:AVAudioSessionCategoryOptionMixWithOthers error:nil];
  [audio setActive:YES error:nil];

  KNSDK *sdk = [KNSDK sharedInstance];
  IntPoint s = [sdk convertWGS84ToKATECWithLongitude:self.startLng latitude:self.startLat];
  IntPoint g = [sdk convertWGS84ToKATECWithLongitude:self.goalLng latitude:self.goalLat];
  KNPOI *start = [[KNPOI alloc] initWithName:@"현재 위치" x:s.x y:s.y];
  KNPOI *goal = [[KNPOI alloc] initWithName:self.goalName x:g.x y:g.y];

  __weak typeof(self) weakSelf = self;
  [sdk makeTripWithStart:start
                    goal:goal
                    vias:nil
              completion:^(KNError *aError, KNTrip *aTrip) {
                dispatch_async(dispatch_get_main_queue(), ^{
                  if (aError || !aTrip) {
                    [weakSelf finishWith:[NSString stringWithFormat:@"error:%@", aError.code ?: @"no_trip"]];
                    return;
                  }
                  [weakSelf startGuideWithTrip:aTrip];
                });
              }];
}

- (void)startGuideWithTrip:(KNTrip *)trip {
  KNGuidance *guidance = [[KNSDK sharedInstance] sharedGuidance];
  guidance.guideStateDelegate = self;
  guidance.routeGuideDelegate = self;
  guidance.voiceGuideDelegate = self;
  guidance.safetyGuideDelegate = self;
  guidance.locationGuideDelegate = self;
  guidance.citsGuideDelegate = self;

  // 구급차: 추천 경로, 도로 통제·스쿨존 피하기 (가이드 예시 값)
  KNRoutePriority priority = KNRoutePriority_Recommand;
  KNRouteAvoidOption avoid = KNRouteAvoidOption_RoadEvent | KNRouteAvoidOption_SZone;
  KNNaviView *naviView = [[KNNaviView alloc] initWithGuidance:guidance
                                                         trip:trip
                                                  routeOption:priority
                                                  avoidOption:avoid];
  naviView.frame = self.view.bounds;
  naviView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  naviView.guideStateDelegate = self;
  naviView.stateDelegate = self;
  [naviView sndVolume:1.0];
  [self.view addSubview:naviView];
  self.naviView = naviView;
}

- (void)finishWith:(NSString *)reason {
  if (self.finished) return;
  self.finished = YES;
  KNGuidance *guidance = [[KNSDK sharedInstance] sharedGuidance];
  guidance.guideStateDelegate = nil;
  guidance.routeGuideDelegate = nil;
  guidance.voiceGuideDelegate = nil;
  guidance.safetyGuideDelegate = nil;
  guidance.locationGuideDelegate = nil;
  guidance.citsGuideDelegate = nil;
  [self.naviView releaseView];
  [self.naviView removeFromSuperview];
  self.naviView = nil;
  [[AVAudioSession sharedInstance] setActive:NO
                                 withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                       error:nil];
  void (^done)(NSString *) = self.onEnded;
  [self.presentingViewController dismissViewControllerAnimated:YES
                                                    completion:^{
                                                      if (done) done(reason);
                                                    }];
}

#pragma mark - KNGuidance_GuideStateDelegate → naviView

- (void)guidanceGuideStarted:(KNGuidance *)aGuidance { [self.naviView guidanceGuideStarted:aGuidance]; }
- (void)guidanceCheckingRouteChange:(KNGuidance *)aGuidance { [self.naviView guidanceCheckingRouteChange:aGuidance]; }
- (void)guidanceOutOfRoute:(KNGuidance *)aGuidance { [self.naviView guidanceOutOfRoute:aGuidance]; }
- (void)guidanceRouteUnchanged:(KNGuidance *)aGuidance { [self.naviView guidanceRouteUnchanged:aGuidance]; }
- (void)guidance:(KNGuidance *)aGuidance routeUnchangedWithError:(KNError *)aError {
  [self.naviView guidance:aGuidance routeUnchangedWithError:aError];
}
- (void)guidanceRouteChanged:(KNGuidance *)aGuidance { [self.naviView guidanceRouteChanged:aGuidance]; }
- (void)guidanceGuideEnded:(KNGuidance *)aGuidance {
  // 목적지 도착 · 안내 종료. 주행 결과 창은 띄우지 않고 바로 앱으로 돌아간다 (도착 처리는 앱 화면에서)
  self.arrived = YES;
  [self.naviView guidanceGuideEnded:aGuidance isShowDriveResultDialog:NO];
  [self finishWith:@"arrived"];
}
- (void)guidance:(KNGuidance *)aGuidance
    didUpdateRoutes:(NSArray<KNRoute *> *)aRoutes
     multiRouteInfo:(KNMultiRouteInfo *_Nullable)aMultiRouteInfo {
  [self.naviView guidance:aGuidance didUpdateRoutes:aRoutes multiRouteInfo:aMultiRouteInfo];
}

#pragma mark - 위치 · 경로 · 안전 · 음성 · C-ITS → naviView

- (void)guidance:(KNGuidance *)aGuidance didUpdateLocation:(KNGuide_Location *)aLocationGuide {
  [self.naviView guidance:aGuidance didUpdateLocation:aLocationGuide];
}
- (void)guidance:(KNGuidance *)aGuidance didUpdateRouteGuide:(KNGuide_Route *)aRouteGuide {
  [self.naviView guidance:aGuidance didUpdateRouteGuide:aRouteGuide];
}
- (void)guidance:(KNGuidance *)aGuidance didUpdateSafetyGuide:(KNGuide_Safety *)aSafetyGuide {
  [self.naviView guidance:aGuidance didUpdateSafetyGuide:aSafetyGuide];
}
- (void)guidance:(KNGuidance *)aGuidance didUpdateAroundSafeties:(NSArray<__kindof KNSafety *> *_Nullable)aSafeties {
  [self.naviView guidance:aGuidance didUpdateAroundSafeties:aSafeties];
}
- (BOOL)guidance:(KNGuidance *)aGuidance shouldPlayVoiceGuide:(KNGuide_Voice *)aVoiceGuide replaceSndData:(NSData **)aNewData {
  return [self.naviView guidance:aGuidance shouldPlayVoiceGuide:aVoiceGuide replaceSndData:aNewData];
}
- (void)guidance:(KNGuidance *)aGuidance willPlayVoiceGuide:(KNGuide_Voice *)aVoiceGuide {
  [self.naviView guidance:aGuidance willPlayVoiceGuide:aVoiceGuide];
}
- (void)guidance:(KNGuidance *)aGuidance didFinishPlayVoiceGuide:(KNGuide_Voice *)aVoiceGuide {
  [self.naviView guidance:aGuidance didFinishPlayVoiceGuide:aVoiceGuide];
}
- (void)guidance:(KNGuidance *)aGuidance didUpdateCitsGuide:(KNGuide_Cits *)aCitsGuide {
  [self.naviView guidance:aGuidance didUpdateCitsGuide:aCitsGuide];
}

#pragma mark - KNNaviView 알림

/// 대원이 길안내 종료(X)를 눌렀을 때
- (void)naviViewGuideEnded:(KNNaviView *)aNaviView {
  [self finishWith:self.arrived ? @"arrived" : @"closed"];
}
- (void)naviViewGuideState:(KNGuideState)aGuideState {}
- (void)naviViewDidUpdateSndVolume:(float)aVolume {}
- (void)naviViewDidUpdateUseDarkMode:(BOOL)aDarkMode {}
- (void)naviViewDidUpdateMapCameraMode:(MapViewCameraMode)aMapViewCameraMode {}
- (void)naviViewScreenState:(KNNaviViewState)aKNNaviViewState {}
- (void)naviViewPopupOpenCheck:(BOOL)aOpen {}
- (void)naviViewDidMenuItemWithId:(int)aId toggle:(BOOL)aToggle {}
- (void)naviViewIsArrival:(BOOL)aIsArrival {}

@end
