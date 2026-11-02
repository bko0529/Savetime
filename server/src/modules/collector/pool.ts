// 일을 정해진 수만큼만 동시에 돌린다. 한 곳이 끝나면 바로 다음 일을 시작하고, 남은 일 수를 돌려준다.
export async function runPool<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<number> {
  const pending = [...items];
  const worker = async (): Promise<void> => {
    while (!shouldStop() && pending.length > 0) {
      await work(pending.shift() as T);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return pending.length;
}
