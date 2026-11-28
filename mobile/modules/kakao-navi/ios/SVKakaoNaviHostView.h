// 카카오내비 길안내 화면(KNSDK-UI 의 KNNaviView)을 담는 화면 칸.
// 앱의 '길 안내' 페이지 안에 들어간다 (다른 앱으로 넘어가지 않음).
// KNSDK 는 Objective-C 전용이라 이 부분만 Objective-C 로 쓰고, 앱(자바스크립트) 연결은 Swift 가 한다.
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface SVKakaoNaviHostView : UIView

/// 경로를 받아 길안내 화면이 뜸
@property (nonatomic, copy, nullable) void (^onReady)(void);
/// 길안내가 끝남. reason: "arrived"(목적지 도착) · "closed"(대원이 종료를 누름)
@property (nonatomic, copy, nullable) void (^onEnded)(NSString *reason);
/// 시작하지 못함. stage: "init"(SDK 인증) · "route"(경로 받기), code·message 는 카카오 오류 그대로
@property (nonatomic, copy, nullable) void (^onError)(NSString *stage, NSString *code, NSString *message);

- (void)startWithAppKey:(NSString *)appKey
          clientVersion:(NSString *)clientVersion
                userKey:(NSString *)userKey
               goalName:(NSString *)goalName
                goalLat:(double)goalLat
                goalLng:(double)goalLng
               startLat:(double)startLat
               startLng:(double)startLng;

/// 길안내를 멈추고 화면을 비운다 (페이지를 나갈 때)
- (void)stop;

@end

NS_ASSUME_NONNULL_END
