// 모든 웹 테스트가 먼저 읽는 설정 (vitest.config.ts setupFiles).
// 화면 요소를 기다리는 기본 시간(findBy·waitFor)은 1초인데, 테스트 전체를 한꺼번에 돌리면
// PC 가 바빠 1초를 넘기는 테스트가 그때그때 하나씩 실패했다 (Pause·RequestActions 등, 따로 돌리면 통과).
// 코드가 틀린 게 아니라 기다림이 짧았던 것이라 기다리는 시간만 늘린다. 실제로 기다리는 건 화면이 뜰 때까지라 빨라지면 바로 끝난다
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5000 });
