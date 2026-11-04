'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';

type RegisterOp = ApiPaths['/hw/pc/register']['post'];
type RegisterBody = RegisterOp['requestBody']['content']['application/json'];
type RegisterResult = RegisterOp['responses'][201]['content']['application/json'];

// PC_LIMIT_REACHED 의 details.pcs. 명세에 모양이 적혀 있지 않아 관리자 PC 목록(GET /admin/hospitals/{id}/pcs)과 맞췄다
export type RegisteredPc = { id: number; name: string; lastUsedAt: string | null };

export const PC_NAME_MAX = 40;

function formatLastUsed(iso: string | null): string {
  if (!iso) return '사용 기록 없음';
  const at = new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
  return `마지막 사용 ${at}`;
}

// 병원 PC 등록 (SFR-116, H-01). 아이디·비밀번호·가입 메뉴 없이 라이선스 키 + PC 이름만 받는다.
export function RegisterForm() {
  const router = useRouter();
  const [licenseKey, setLicenseKey] = useState('');
  const [pcName, setPcName] = useState('');
  // 3대가 꽉 찼을 때 서버가 준 기존 PC 목록과, 그중 바꿀 PC
  const [fullPcs, setFullPcs] = useState<RegisteredPc[] | null>(null);
  const [replacePcId, setReplacePcId] = useState<number | null>(null);

  const register = useMutation({
    mutationFn: (body: RegisterBody) =>
      apiFetch<RegisterResult>('/hw/pc/register', { method: 'POST', body: JSON.stringify(body) }),
    // 성공하면 서버가 st_pc 쿠키를 심어 주므로, 이후에는 키 입력 없이 근무 시작 화면으로 간다
    onSuccess: () => router.replace('/hospital'),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'PC_LIMIT_REACHED') {
        setFullPcs((error.details?.pcs as RegisteredPc[] | undefined) ?? []);
        setReplacePcId(null);
      }
    },
  });

  const choosingReplacement = fullPcs !== null;
  const canSubmit =
    licenseKey.trim() !== '' &&
    pcName.trim() !== '' &&
    (!choosingReplacement || replacePcId !== null) &&
    !register.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    register.mutate({
      licenseKey: licenseKey.trim(),
      pcName: pcName.trim(),
      replacePcId: choosingReplacement ? replacePcId : null,
    });
  }

  const showError =
    register.isError &&
    !(register.error instanceof ApiError && register.error.code === 'PC_LIMIT_REACHED');

  return (
    <form onSubmit={submit} className="flex w-full max-w-xl flex-col gap-6" noValidate>
      <label className="flex flex-col gap-2">
        <span className="text-xl font-bold">라이선스 키</span>
        <input
          className="h-14 rounded-lg border-2 border-input px-4 text-xl outline-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/40"
          value={licenseKey}
          onChange={(e) => setLicenseKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <span className="text-base text-muted-foreground">관리자에게 받은 병원 키를 입력해요.</span>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-xl font-bold">PC 이름</span>
        <input
          className="h-14 rounded-lg border-2 border-input px-4 text-xl outline-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/40"
          value={pcName}
          onChange={(e) => setPcName(e.target.value)}
          maxLength={PC_NAME_MAX}
          placeholder="예: 응급실 접수대"
        />
      </label>

      {choosingReplacement && (
        <fieldset className="flex flex-col gap-3 rounded-lg border-2 border-destructive p-4">
          <legend className="px-2 text-xl font-bold text-destructive">
            이 병원은 PC 3대가 모두 등록돼 있어요. 바꿀 PC를 골라 주세요.
          </legend>
          {fullPcs.map((pc) => (
            <label key={pc.id} className="flex items-center gap-3 text-lg">
              <input
                type="radio"
                name="replacePc"
                className="size-5"
                checked={replacePcId === pc.id}
                onChange={() => setReplacePcId(pc.id)}
              />
              <span className="font-bold">{pc.name}</span>
              <span className="text-muted-foreground">{formatLastUsed(pc.lastUsedAt)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {showError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(register.error)}
        </p>
      )}

      <Button type="submit" size="lg" disabled={!canSubmit}>
        {register.isPending ? '등록 중…' : choosingReplacement ? '이 PC로 바꿔 등록' : '이 PC 등록'}
      </Button>
    </form>
  );
}
