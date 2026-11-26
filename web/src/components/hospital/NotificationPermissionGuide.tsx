// 브라우저 알림 권한이 없을 때 화면 위에 계속 보여 주는 안내 (SFR-136).
// 권한이 없어도 알림음 반복과 탭 제목으로는 알리지만, 다른 창을 보고 있으면 놓치기 쉬워서 허용 방법을 알려 준다.
// 닫기 버튼은 두지 않는다: 허용할 때까지 계속 보여야 한다 (요구사항 '계속 표시')
export function NotificationPermissionGuide({ reason }: { reason: 'denied' | 'unsupported' }) {
  return (
    <div
      role="status"
      aria-label="브라우저 알림 안내"
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-foreground"
    >
      <p className="text-xl font-extrabold">
        ⚠ 브라우저 알림을 허용해야 다른 창을 볼 때도 알 수 있어요
      </p>
      {reason === 'denied' ? (
        <ol className="list-decimal pl-6 text-lg">
          <li>주소창 왼쪽의 사이트 정보(자물쇠) 아이콘을 눌러요</li>
          <li>&apos;알림&apos;을 &apos;허용&apos;으로 바꿔요</li>
          <li>이 화면으로 돌아와 &apos;알림 켜기&apos;를 다시 눌러요</li>
        </ol>
      ) : (
        <p className="text-lg">
          이 브라우저는 알림을 지원하지 않아요. 크롬이나 엣지 최신 버전을 써 주세요.
        </p>
      )}
      <p className="text-base">그동안에도 새 요청은 알림음 반복과 탭 제목(🔴)으로 알려요.</p>
    </div>
  );
}
