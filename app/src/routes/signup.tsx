import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Camera, Check, ChevronLeft } from "lucide-react";
import { PhoneScreen, BigButton, Label, Notice, SectionTitle, IconTile } from "@/components/phone";
import { useAuth, currentAccount, RANKS, signupError, passwordOk } from "@/lib/auth-store";
import { signup } from "@/lib/auth-server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "가입 신청 · 골든타임즈" },
      { name: "description", content: "소속 소방서 코드 · 이름 · 계급 · 사번과 공무원증 사진으로 가입을 신청해요." },
      { property: "og:title", content: "가입 신청 · 골든타임즈" },
      { property: "og:description", content: "119 구급대원만 쓸 수 있게 공무원증으로 가입" },
    ],
  }),
  component: Signup,
});

/** SFR-017: 소속기관 코드 · 이름 · 계급 · 소속 안전센터 · 사번 · 공무원증 사진 + 사진 동의 → 관리자 승인 */
function Signup() {
  const a = useAuth();
  const [f, setF] = useState({ orgCode: "", name: "", rank: "소방교", center: "", employeeNo: "", loginId: "", pw: "", pw2: "" });
  const [file, setFile] = useState<File | null>(null);
  const photo = file?.name ?? null;
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  // 반려된 뒤 다시 신청: 같은 계정이라 아이디·비밀번호는 묻지 않는다
  const reapply = currentAccount(a)?.status === "rejected";

  const submit = async () => {
    const e = signupError({ ...f, photo, agree, ...(reapply ? { loginId: "reapply", pw: "reapply1" } : {}) });
    if (e) return setErr(e);
    if (!reapply && f.pw !== f.pw2) return setErr("비밀번호 확인이 달라요");
    if (!file || busy) return;
    // 소방서 코드가 맞는지·아이디가 겹치는지는 서버가 보고 문구를 돌려준다. 통과하면 '승인 대기' 화면으로
    setBusy(true);
    setErr((await signup({ ...f, photo: file })) ?? "");
    setBusy(false);
  };

  return (
    <PhoneScreen title="가입 신청" subtitle="관리자가 공무원증을 확인하고 승인해요" footer={<BigButton size="lg" onClick={() => void submit()} disabled={busy}>{busy ? "보내는 중…" : reapply ? "다시 신청" : "가입 신청"}</BigButton>}>
      <Link to="/login" className="-mt-1 mb-4 inline-flex items-center gap-0.5 text-sm font-semibold text-muted-foreground"><ChevronLeft className="size-4" /> 로그인으로</Link>

      <SectionTitle hint="소방서 단위 코드예요. 모르면 소속 관리자에게 물어보세요">
        <Step n={1}>소속 소방서</Step>
      </SectionTitle>
      <input className="field uppercase tabular-nums" value={f.orgCode} onChange={(e) => set("orgCode", e.target.value)} placeholder="CN-SB-019" />
      <div className="mt-3"><Label>소속 안전센터</Label><input className="field" value={f.center} onChange={(e) => set("center", e.target.value)} placeholder="서북119안전센터" /></div>

      <SectionTitle>
        <Step n={2}>내 정보</Step>
      </SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>이름</Label><input className="field" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="김도윤" /></div>
        <div><Label>계급</Label><select className="field" value={f.rank} onChange={(e) => set("rank", e.target.value)}>{RANKS.map((r) => <option key={r}>{r}</option>)}</select></div>
      </div>
      <div className="mt-3"><Label>사번</Label><input className="field tabular-nums" value={f.employeeNo} onChange={(e) => set("employeeNo", e.target.value)} placeholder="2019-1234" /></div>

      {!reapply && (<>
      <SectionTitle>
        <Step n={3}>로그인 정보</Step>
      </SectionTitle>
      <div><Label>아이디 (영문 소문자 · 숫자 4~20자)</Label><input className="field" value={f.loginId} onChange={(e) => set("loginId", e.target.value.toLowerCase())} placeholder="kimdoyun" autoCapitalize="none" /></div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div><Label>비밀번호</Label><input className="field" type="password" value={f.pw} onChange={(e) => set("pw", e.target.value)} /></div>
        <div><Label>비밀번호 확인</Label><input className="field" type="password" value={f.pw2} onChange={(e) => set("pw2", e.target.value)} /></div>
      </div>
      <p className={cn("mt-2 text-xs font-semibold", f.pw && passwordOk(f.pw) ? "text-success" : "text-muted-foreground")}>8자 이상, 영문과 숫자를 섞어 주세요</p>
      </>)}

      <SectionTitle hint="관리자만 볼 수 있고, 확인이 끝나면 삭제돼요">
        <Step n={4}>공무원증 사진</Step>
      </SectionTitle>
      <label className={cn("tile flex cursor-pointer items-center justify-center gap-2 border-dashed p-6 text-sm font-bold transition hover:bg-surface", photo && "border-success/50 bg-success-soft/40 text-success")}>
        {photo ? <><Check className="size-4" /> {photo}</> : <><Camera className="size-5 text-accent-deep" /> 촬영하기 · 앨범에서 선택</>}
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="mt-1.5 text-xs text-muted-foreground">카메라 권한은 이때 물어요</p>
      <label className="mt-4 flex items-start gap-2.5 rounded-xl bg-surface px-4 py-3.5 text-sm">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
        <span className="leading-relaxed">공무원증 사진 수집 · 이용에 동의합니다 <b className="text-accent-deep">(필수)</b></span>
      </label>
      {err && <div className="mt-4"><Notice tone="warn">{err}</Notice></div>}
    </PhoneScreen>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <IconTile tone="accent" className="size-5 rounded-md p-0 text-[11px] font-extrabold">{n}</IconTile>
      <span className="flex items-center gap-1.5">{children}</span>
    </span>
  );
}
