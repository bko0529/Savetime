// 카카오내비 길안내 화면을 전체 화면으로 띄우는 뷰 컨트롤러 (KNSDK-UI 의 KNNaviView 를 그대로 씀).
// KNSDK 는 Objective-C 전용이라 이 부분만 Objective-C 로 쓰고, 앱(자바스크립트) 연결은 Swift 모듈이 한다.
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface SVKakaoNaviViewController : UIViewController

/// 길안내가 끝나 화면이 닫힐 때. reason: "arrived"(목적지 도착) · "closed"(대원이 닫음) · "error:<코드>"
@property (nonatomic, copy, nullable) void (^onEnded)(NSString *reason);

- (instancetype)initWithGoalName:(NSString *)goalName
                         goalLat:(double)goalLat
                         goalLng:(double)goalLng
                        startLat:(double)startLat
                        startLng:(double)startLng;

/// SDK 초기화 (앱에서 한 번). 실패하면 completion 에 오류 문구, 성공하면 nil
+ (void)initializeSdkWithAppKey:(NSString *)appKey
                  clientVersion:(NSString *)clientVersion
                        userKey:(NSString *)userKey
                     completion:(void (^)(NSString *_Nullable error))completion;

@end

NS_ASSUME_NONNULL_END
