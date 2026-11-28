// 앱(자바스크립트) ↔ 카카오내비 길안내 화면 칸 연결 (Expo Modules).
// '길 안내' 페이지가 <KakaoNaviView trip={...} /> 로 쓴다. 다른 앱으로 넘어가지 않는다.
// 키는 자바스크립트에 두지 않고, 빌드할 때 Info.plist(KakaoNaviAppKey)에 들어간 값을 여기서 읽는다.
import ExpoModulesCore

private func naviAppKey() -> String? {
  let key = Bundle.main.object(forInfoDictionaryKey: "KakaoNaviAppKey") as? String
  return (key ?? "").isEmpty ? nil : key
}

public class KakaoNaviModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KakaoNavi")

    /// 이 빌드에 내비 키가 들어 있는지
    Function("isReady") { () -> Bool in naviAppKey() != nil }

    View(KakaoNaviExpoView.self) {
      Events("onReady", "onEnded", "onError")
      /// 목적지·출발지·사용자 구분 값. 한 번 시작하면 바뀌어도 다시 시작하지 않는다 (다시 하려면 화면을 새로 만든다)
      Prop("trip") { (view: KakaoNaviExpoView, trip: [String: Any]) in
        view.start(trip)
      }
    }
  }
}

public class KakaoNaviExpoView: ExpoView {
  let host = SVKakaoNaviHostView(frame: .zero)
  let onReady = EventDispatcher()
  let onEnded = EventDispatcher()
  let onError = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    addSubview(host)
    host.onReady = { [weak self] in self?.onReady([:]) }
    host.onEnded = { [weak self] reason in self?.onEnded(["reason": reason]) }
    host.onError = { [weak self] stage, code, message in
      self?.onError(["stage": stage, "code": code, "message": message])
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    host.frame = bounds
  }

  func start(_ trip: [String: Any]) {
    guard let key = naviAppKey() else {
      onError(["stage": "init", "code": "NO_KEY", "message": "카카오 네이티브 앱 키가 이 빌드에 없어요"])
      return
    }
    let num = { (k: String) -> Double in (trip[k] as? NSNumber)?.doubleValue ?? 0 }
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    host.start(
      withAppKey: key,
      clientVersion: version,
      userKey: trip["userKey"] as? String ?? "",
      goalName: trip["goalName"] as? String ?? "병원",
      goalLat: num("goalLat"),
      goalLng: num("goalLng"),
      startLat: num("startLat"),
      startLng: num("startLng")
    )
  }
}
