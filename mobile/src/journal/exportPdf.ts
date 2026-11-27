/**
 * 제출용 서식 PDF 를 휴대폰 안에서 만들어 공유·인쇄한다 (expo-print + expo-sharing, SFR-165).
 * 환자 성명은 이 PDF 에만 들어가고 서버·저장소에는 남지 않는다.
 */
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { LogData } from './form';
import { buildSheetHtml } from './sheetHtml';

/** PDF 파일을 만들어 공유 창(메일·메신저·파일 저장 등)을 연다 */
export async function sharePdf(f: LogData, patientName?: string) {
  const { uri } = await Print.printToFileAsync({
    html: buildSheetHtml(f, { patientName }),
    width: 595,
    height: 842,
  });
  if (!(await Sharing.isAvailableAsync())) throw new Error('이 휴대폰에서는 공유할 수 없어요');
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: '구급활동일지 PDF',
  });
}

/** 바로 인쇄 (프린터 선택 창) */
export async function printSheet(f: LogData, patientName?: string) {
  await Print.printAsync({ html: buildSheetHtml(f, { patientName }) });
}
