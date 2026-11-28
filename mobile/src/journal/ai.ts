/**
 * AI 일지 정리 (SFR-167, 제안만). 서버만 AI(OpenAI)를 부른다: 보내기 전에 식별정보(이름 칸 값·전화번호·주민번호·주소 모양)를
 * 지우고, 원문·응답을 저장하지 않는다 (SER-017). 앱은 제안을 보여 주고 대원이 '적용'을 눌러야 일지에 넣는다.
 * 기능 토글 journalAi 가 꺼져 있으면 화면에 안 보인다 (QUR-013).
 */
import { ApiError, api } from '../api/client';

export type AiSuggestions = {
  chiefComplaint?: string | null;
  history?: string | null;
  treatment?: string | null;
  medicalDirection?: string | null;
  other?: string | null;
};

export const AI_LABEL: Record<keyof AiSuggestions, string> = {
  chiefComplaint: '주 호소',
  history: '병력',
  treatment: '처치',
  medicalDirection: '의료지도',
  other: '기타 소견',
};

export async function organize(
  text: string,
  names: string[],
): Promise<{ suggestions: AiSuggestions; removed: number } | string> {
  if (!text.trim()) return '정리할 메모를 적어 주세요';
  try {
    const r = await api<{ suggestions: AiSuggestions; removedIdentifiers?: number }>(
      'POST',
      '/journal/ai-organize',
      {
        body: {
          text: text.trim().slice(0, 2000),
          ...(names.length ? { names: names.slice(0, 5) } : {}),
        },
        timeoutMs: 15_000,
      },
    );
    return { suggestions: r.suggestions ?? {}, removed: r.removedIdentifiers ?? 0 };
  } catch (e) {
    if (e instanceof ApiError && e.code === 'FEATURE_DISABLED') return 'AI 일지 정리가 꺼져 있어요';
    if (e instanceof ApiError && e.code === 'AI_UNAVAILABLE')
      return 'AI 정리를 지금 쓸 수 없어요. 직접 적어 주세요';
    return e instanceof Error ? e.message : 'AI 정리를 하지 못했어요';
  }
}
