import { FIELD_LABEL, fieldText, type Assessment } from '@/lib/assessment/labels';
import { cn } from '@/lib/utils';

// 환자 평가 한 칸의 값. '확인 불가'로 보낸 칸은 회색 X 로 한눈에 보이게 하고,
// 정상 범위 밖 값은 빨간 글자 + ⚠ (색만으로 구분하지 않게). 위급도 판정은 하지 않는다 (D-38)
export function AssessmentValue({ text, abnormal }: { text: string | null; abnormal?: boolean }) {
  // 대원이 비워 둔 칸 (선택 항목 등). 빠뜨린 게 아니라 '입력 안 함'이라는 걸 보여 준다
  if (text === null) {
    return (
      <span className="text-[15px] font-normal text-muted-foreground" data-empty>
        입력 안 함
      </span>
    );
  }
  if (text === '확인 불가') {
    return (
      <span className="inline-flex items-center gap-1.5" data-unknown>
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-[6px] border-2 border-muted-foreground/60 text-[15px] leading-none font-extrabold text-muted-foreground"
        >
          X
        </span>
        <span className="text-[15px] font-semibold text-muted-foreground">확인 불가</span>
      </span>
    );
  }
  return (
    <span
      className={cn(abnormal && 'font-extrabold text-destructive')}
      data-abnormal={abnormal || undefined}
    >
      {abnormal ? `⚠ ${text}` : text}
    </span>
  );
}

type Row = { field: keyof typeof FIELD_LABEL; text: string | null };

// 앱이 받는 항목을 모두 보여 준다(비어 있으면 '입력 안 함'). 그래야 과거력·KTAS 같은
// 선택 항목이 있는지 없는지 병원이 한눈에 안다. skip: 제목 등에 이미 있는 칸.
// 외상 원인은 외상이 '있음'이거나 값이 있을 때만
export function assessmentRows(a: Assessment, skip: readonly string[] = []): Row[] {
  return (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).flatMap((field) => {
    if (skip.includes(field)) return [];
    const text = fieldText(a, field);
    if (field === 'traumaCause' && text === null && a.trauma !== 'yes') return [];
    return [{ field, text }];
  });
}

// 환자 평가 표 (요청 상세 카드·도착 예정 펼침이 같이 쓴다)
export function AssessmentRows({
  assessment,
  abnormalFields,
  skip,
  className,
  rowClassName,
}: {
  assessment: Assessment;
  abnormalFields?: readonly string[] | null;
  skip?: readonly string[];
  className?: string;
  rowClassName?: string;
}) {
  const abnormal = new Set(abnormalFields ?? []);
  return (
    <dl className={cn('flex flex-col', className)}>
      {assessmentRows(assessment, skip).map(({ field, text }) => (
        <div
          key={field}
          className={cn(
            'flex items-center justify-between gap-4 border-b border-line-soft py-2.5 last:border-b-0',
            rowClassName,
          )}
        >
          <dt className="shrink-0 text-[16px] text-muted-foreground">{FIELD_LABEL[field]}</dt>
          <dd className="text-right text-[17px] font-bold break-words">
            <AssessmentValue text={text} abnormal={text !== null && abnormal.has(field)} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
