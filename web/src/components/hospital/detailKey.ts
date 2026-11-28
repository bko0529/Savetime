// 요청 상세 캐시 이름. 요청 상세와 도착 예정 펼침이 같이 써서, 한쪽에서 받은 걸 다른 쪽이 다시 받지 않는다
export const detailKey = (id: number) => ['hw', 'requests', 'detail', id] as const;
