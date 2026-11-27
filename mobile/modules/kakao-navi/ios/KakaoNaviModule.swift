// 앱(자바스크립트) ↔ 카카오내비 길안내 화면 연결 (Expo Modules).
// 키는 자바스크립트에 두지 않고, 빌드할 때 Info.plist(KakaoNaviAppKey)에 들어간 값을 여기서 읽는다.
import ExpoModulesCore

struct StartOptions: Record {
  @Field var goalName: String = "병원"
  @Field var goalLat: Double = 0
  @Field var goalLng: Double = 0
  @Field var startLat: Double = 0
  @Field var startLng: Double = 0
  /// 대원 구분 값 (이름·전화번호 같은 개인정보는 넣지 않는다, SER-012)
  @Field var userKey: String = ""
}

public class KakaoNaviModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KakaoNavi")
    Events("onNaviEnded")

    /// 이 빌드에 내비 키가 들어 있는지
    Function("isReady") { () -> Bool in
      let key = Bundle.main.object(forInfoDictionaryKey: "KakaoNaviAppKey") as? String
      return !(key ?? "").isEmpty
    }

    /// 카카오내비 길안내를 전체 화면으로 연다. 화면이 뜨면 끝나고, 닫히면 onNaviEnded 이벤트
    AsyncFunction("start") { (opts: StartOptions, promise: Promise) in
      guard let key = Bundle.main.object(forInfoDictionaryKey: "KakaoNaviAppKey") as? String, !key.isEmpty else {
        promise.reject("NO_KEY", "카카오 네이티브 앱 키가 이 빌드에 없어요")
        return
      }
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
      SVKakaoNaviViewController.initializeSdk(withAppKey: key, clientVersion: version, userKey: opts.userKey) { error in
        if let error = error {
          promise.reject("INIT_FAILED", "카카오내비를 시작하지 못했어요: \(error)")
          return
        }
        guard let top = self.appContext?.utilities?.currentViewController() else {
          promise.reject("NO_SCREEN", "화면을 찾지 못했어요")
          return
        }
        let vc = SVKakaoNaviViewController(
          goalName: opts.goalName,
          goalLat: opts.goalLat,
          goalLng: opts.goalLng,
          startLat: opts.startLat,
          startLng: opts.startLng
        )
        vc.onEnded = { [weak self] reason in
          self?.sendEvent("onNaviEnded", ["reason": reason])
        }
        top.present(vc, animated: true) {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)
  }
}
