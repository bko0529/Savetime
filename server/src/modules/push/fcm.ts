// FCM 발송 (firebase-admin, 기술정의서 푸시 · COR-009). iOS도 FCM이 APNs로 넘겨준다.
// 서비스 계정 키는 server/.env의 FIREBASE_SERVICE_ACCOUNT_BASE64에만 둔다 (절대 규칙 1).
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { PushSender } from './dispatch.js';

// FCM이 '이 토큰은 더 이상 쓸 수 없다'고 알려 주는 코드. 이 토큰들은 DB에서 지운다
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
// 한 번에 보낼 수 있는 토큰 수 (FCM 제한)
const MULTICAST_LIMIT = 500;

export function createFcmSender(serviceAccountBase64: string): PushSender {
  const credentials = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  // 같은 프로세스에서 여러 번 불려도(테스트 등) 앱 이름이 겹치지 않게 한다
  const app = initializeApp({ credential: cert(credentials) }, `savetime-${Date.now()}`);
  const messaging = getMessaging(app);

  return async (tokens, message) => {
    const invalidTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += MULTICAST_LIMIT) {
      const batch = tokens.slice(i, i + MULTICAST_LIMIT);
      const result = await messaging.sendEachForMulticast({
        tokens: batch,
        // notification 메시지: 앱이 꺼져 있어도 OS가 바로 띄운다 (실시간 설계 5장)
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          priority: 'high',
          notification: { channelId: 'urgent', defaultVibrateTimings: true, defaultSound: true },
        },
        // iPhone 무음 모드면 소리 없이 진동만 (폰 설정을 따름). '중요 알림'(critical)은 쓰지 않는다
        apns: { payload: { aps: { sound: 'default' } } },
      });
      result.responses.forEach((r, j) => {
        if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code))
          invalidTokens.push(batch[j]);
      });
    }
    return { invalidTokens };
  };
}
