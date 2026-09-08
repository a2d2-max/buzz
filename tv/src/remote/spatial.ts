// norigin-spatial-navigation 초기화와 재노출.
// 화면 컴포넌트는 여기서만 import 해서 초기화 순서를 한 곳에 묶는다.

import { init } from "@noriginmedia/norigin-spatial-navigation";

export {
  FocusContext,
  useFocusable,
  setFocus,
  pause as pauseSpatialNavigation,
  resume as resumeSpatialNavigation,
} from "@noriginmedia/norigin-spatial-navigation";

let initialized = false;

export function initSpatialNavigation(): void {
  if (initialized) return;
  initialized = true;
  init({
    // TV SoC 가 느려서 키 반복 입력을 살짝 눌러 준다.
    throttle: 60,
    throttleKeypresses: true,
  });
}
