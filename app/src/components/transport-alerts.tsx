import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, MessageSquareText, X } from "lucide-react";
import { BigButton } from "@/components/phone";
import { api } from "@/lib/api";
import { actions, type JournalDraft } from "@/lib/engine";
import { buzz, hospitalAlerts, unacceptableText, useHospitalAlerts } from "@/lib/hospital-alerts";
import { mergePatient } from "@/lib/journal";
import { emptyPatient, useTransport } from "@/lib/transport-store";

/**
 * 병원 경보 두 가지를 화면 어디에서나 띄운다
 * - 추가 메모(SFR-140): 위쪽 배너 + 진동. 누르면 이송 화면, 10초 뒤 저절로 닫힘
 * - 수용 불가(SFR-158): 화면 전체 빨간 경보 + 진동. '다시 요청하기'는 직전 환자 정보를 채워 환자 입력 화면으로
 *   (그 병원은 서버가 다음 요청에서 자동으로 뺀다)
 */
export function TransportAlerts() {
  const { memo, unacceptable } = useHospitalAlerts();
  const nav = useNavigate();
  const { setPatient } = useTransport();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!memo) return;
    buzz([200, 80, 200]);
    const t = setTimeout(() => hospitalAlerts.clearMemo(), 10_000);
    return () => clearTimeout(t);
  }, [memo]);

  useEffect(() => {
    if (unacceptable) buzz([400, 120, 400, 120, 400]);
  }, [unacceptable]);

  // 직전 이송의 환자 정보를 서버 일지 초안(도착 후 10분 동안 팀원이 볼 수 있음)으로 다시 채운다.
  // 이 폰에서 이미 '저장하고 홈으로'를 눌러 비웠어도 이어서 쓸 수 있게
  const reRequest = async () => {
    if (!unacceptable || busy) return;
    setBusy(true);
    try {
      const d = await api<JournalDraft>(
        "GET",
        `/transports/${unacceptable.transportId}/journal-draft`,
      );
      setPatient(mergePatient(emptyPatient, d));
    } catch {
      /* 초안을 못 받으면 이 폰에 남은 환자 정보로 */
    }
    actions.reset();
    actions.continueFrom(unacceptable.transportId);
    hospitalAlerts.clearUnacceptable();
    setBusy(false);
    nav({ to: "/patient" });
  };

  return (
    <>
      {memo && (
        <div className="push-in fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3">
          <div
            role="alert"
            className="elevate-lg flex w-full max-w-[420px] items-center gap-3 overflow-hidden rounded-2xl border border-warning/40 bg-card/95 py-3 pr-2 pl-3 backdrop-blur-md"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning">
              <MessageSquareText className="size-5" />
            </span>
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                hospitalAlerts.clearMemo();
                nav({ to: "/transport" });
              }}
            >
              <p className="text-[13px] font-extrabold">{memo.hospitalName} 추가 메모</p>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {memo.memo ?? "이송 화면에서 확인하세요"}
              </p>
            </button>
            <button
              aria-label="닫기"
              className="grid size-9 place-items-center rounded-lg text-muted-foreground"
              onClick={() => hospitalAlerts.clearMemo()}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}
      {unacceptable && (
        <div
          role="alertdialog"
          aria-label="수용 불가"
          className="fixed inset-0 z-[60] flex items-end justify-center bg-foreground/50 p-3 sm:items-center"
        >
          <div className="rise-in w-full max-w-[420px] overflow-hidden rounded-2xl bg-card">
            <div className="bg-[image:var(--gradient-accent)] px-5 py-5 text-primary-foreground">
              <p className="flex items-center gap-2 text-sm font-bold opacity-80">
                <AlertTriangle className="size-4" /> 도착 후 수용 불가
              </p>
              <p className="mt-1 text-2xl font-extrabold">{unacceptable.hospitalName}</p>
              <p className="mt-1 text-lg font-bold">{unacceptableText(unacceptable.reason)}</p>
            </div>
            <div className="space-y-2 p-5">
              <p className="text-sm text-muted-foreground">
                직전 환자 정보로 다시 요청해요. 이 병원은 요청 대상에서 빠져요.
              </p>
              <BigButton
                size="lg"
                variant="danger"
                disabled={busy}
                onClick={() => void reRequest()}
              >
                {busy ? "불러오는 중…" : "다시 요청하기"}
              </BigButton>
              <BigButton variant="outline" onClick={() => hospitalAlerts.clearUnacceptable()}>
                닫기
              </BigButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
