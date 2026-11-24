import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { findTeamQr } from "@/lib/team-qr";

/**
 * 팀 QR 스캔 화면 (SFR-113 · 159). 뒤 카메라를 켜고 화면을 계속 읽다가 우리 팀 QR 을 찾으면 토큰을 넘긴다.
 * - 카메라 권한은 이 화면을 열 때 묻는다
 * - 닫거나 찾으면 카메라를 바로 끈다 (배터리·개인정보)
 */
export function TeamQrScanner({ onFound, onClose }: { onFound: (token: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frameId = 0;
    let alive = true;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      if (!alive) return;
      const v = video.current;
      if (v && ctx && v.readyState >= 2 && v.videoWidth > 0) {
        // 큰 화면은 줄여서 읽는다 (QR 은 이 정도면 충분하고 폰이 덜 뜨거워진다)
        const scale = Math.min(1, 640 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const token = findTeamQr(frame);
        if (token) {
          alive = false;
          stream?.getTracks().forEach((t) => t.stop());
          onFound(token);
          return;
        }
      }
      frameId = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => {});
        }
        frameId = requestAnimationFrame(tick);
      } catch {
        setErr("카메라를 쓸 수 없어요. 카메라 권한을 허용하거나 4자리 코드를 입력해 주세요");
      }
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(frameId);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // onFound 는 처음 연 화면의 것을 쓴다 (다시 그려도 카메라를 다시 켜지 않게)
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div role="dialog" aria-label="QR 스캔" className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-base font-extrabold">팀원 화면의 QR을 비춰 주세요</p>
        <button aria-label="닫기" onClick={onClose} className="rounded-full bg-white/15 p-2"><X className="size-5" /></button>
      </div>
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <video ref={video} playsInline muted className="h-full w-full object-cover" />
        <div aria-hidden className="pointer-events-none absolute size-60 rounded-2xl border-4 border-white/80" />
      </div>
      {err && <p role="alert" className="bg-destructive px-4 py-3 text-sm font-bold">{err}</p>}
      <button onClick={onClose} className="py-4 text-sm font-semibold text-white/80">코드로 입력하기</button>
    </div>
  );
}
