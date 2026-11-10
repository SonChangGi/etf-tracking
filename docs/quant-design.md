# 공통 웹 디자인

기준 문서: [Quant 웹 디자인 지침 2.10.0](https://github.com/SonChangGi/quant-dashboard/blob/main/docs/web-design.md).

이 사이트는 UI 0.7.0, startup 1.2.0, QuantRange 1.3.0을 사용한다. 사이트 고유 CSS 뒤에서 프로젝트 CSS와 blocking `start.js`를 읽고, 그 뒤에 앱 진입점과 nav를 순서대로 둔다. 공통 runtime과 차트 엔진은 startup이 준비하며 nav는 공통 탐색과 native fallback을 담당하며 구형 UI를 다시 읽지 않는다.

차트의 실제 점 선택은 해당 시점 값을 표시하고, 구간 선택 중 계열을 바꾸면 같은 구간의 변화를 표시한다. 빈 차트 영역을 누르면 선택을 해제한다. 표의 숫자 정렬·정렬 상태·모바일 스크롤은 공통 규칙을 따른다.

UI 변경은 데이터·계산·수집 일정과 분리하며, 배포 전 프로젝트 검사와 실제 화면을 확인한다.

숫자는 표시 단위 기준 소수 최대 2자리로 표시하고 끝의 0은 생략한다. 0보다 크고 0.01보다 작은 절댓값은 유효숫자 최대 2자리로 표시하며, 날짜·ID·계산·원자료는 변경하지 않는다. 공통 숫자 formatter는 startup에서 앱보다 먼저 준비한다. 카드·표 간격과 모바일 표의 좌우 스크롤 음영은 공통 UI를 따른다.

디자인 계약 1.0.0은 생성된 HTML과 Pages 업로드 직전 artifact를 검사한다. startup 누락·구버전·중복, 앱보다 늦은 초기화, 최종 공통 CSS 뒤의 스타일, 직접 runtime/engine 로딩은 배포를 차단한다. 검증은 저장소에 고정한 공통 계약을 사용하며 원자료·수집 정책은 바꾸지 않는다.

## 생성 경로

운영 화면은 `scripts/build-static.mjs`의 `dist/` 출력만 배포한다. `shared-platform/dist/`는 현재 페이지의 필수 런타임이므로 소스와의 일치 검증을 유지한다.

## 공통 환경설정

`shared/preferences/1.0.0/preferences.js`를 head에서 startup보다 먼저 동기 로드한다. 기존 즐겨찾기·사이드바 접힘·보기 밀도 키를 유지하면서 같은 도메인의 탭에는 변경을 즉시 반영하고, 다른 프로젝트 도메인으로 이동할 때 UI 설정을 전달한다. 기존 startup 1.2.0과 데이터·계산 계약은 유지한다.
