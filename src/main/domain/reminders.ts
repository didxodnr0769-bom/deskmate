/** 시간 입력을 한 번의 예약 시각으로 정합니다. 반복 예약은 생성하지 않습니다. */
export function nextReminderAt(time: string, now: number): number {
  if (typeof time !== 'string' || time.length !== 5 || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    throw new Error('알림 시간은 HH:mm 형식으로 입력해 주세요.');
  }
  if (!Number.isInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) {
    throw new Error('현재 시각이 올바르지 않습니다.');
  }

  const current = new Date(now);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3));
  const selectedMinute = hour * 60 + minute;
  const currentMinute = current.getHours() * 60 + current.getMinutes();
  if (selectedMinute === currentMinute) {
    // DST 종료로 같은 분이 두 번 와도 현재 분의 UTC 오프셋을 유지합니다.
    return now - current.getSeconds() * 1000 - current.getMilliseconds();
  }

  const scheduled = new Date(0);
  scheduled.setHours(0, 0, 0, 0);
  // setFullYear는 Date 생성자의 0~99년 특수 처리와 24시간 고정 가산을 피합니다.
  scheduled.setFullYear(current.getFullYear(), current.getMonth(), current.getDate() + Number(selectedMinute < currentMinute));
  scheduled.setHours(hour, minute, 0, 0);
  let result = scheduled.getTime();
  if (result < now && selectedMinute > currentMinute) {
    // 반복되는 시간대의 두 번째 구간에서는 아직 오지 않은 분을 과거로 잡지 않습니다.
    const repeated = new Date(result + (current.getTimezoneOffset() - scheduled.getTimezoneOffset()) * 60_000);
    if (repeated.getFullYear() === current.getFullYear() && repeated.getMonth() === current.getMonth()
      && repeated.getDate() === current.getDate() && repeated.getHours() === hour && repeated.getMinutes() === minute) {
      result = repeated.getTime();
    }
  }
  if (!Number.isFinite(result) || result < 0 || (selectedMinute > currentMinute && result < now)) {
    throw new Error('알림 시각을 계산할 수 없습니다.');
  }
  return result;
}
