// webOS TV 리모컨 키코드.
// 출처: https://webostv.developer.lge.com/develop/guides/back-button
// 방향키·OK 는 norigin-spatial-navigation 이 처리하고, 여기서는 뒤로가기만 본다.

export const KEY_BACK_WEBOS = 461;
/** 개발 환경(PC 브라우저·Playwright)에는 461 키가 없어 Escape 를 뒤로가기로 겸용한다. */
export const KEY_ESCAPE = 27;
export const KEY_ENTER = 13;

export function isBackKey(
  event: Pick<KeyboardEvent, "keyCode" | "key">,
): boolean {
  return (
    event.keyCode === KEY_BACK_WEBOS ||
    event.keyCode === KEY_ESCAPE ||
    event.key === "Escape" ||
    event.key === "GoBack"
  );
}
