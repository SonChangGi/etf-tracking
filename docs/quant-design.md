# 공통 웹 디자인

기준 문서: [Quant 웹 디자인 지침 2.7.0](https://github.com/SonChangGi/quant-dashboard/blob/main/docs/web-design.md).

이 사이트는 UI 0.6.0, startup 1.1.0, QuantRange 1.2.0을 사용한다. 사이트 고유 CSS 뒤, `head` 끝에서 프로젝트 CSS와 blocking `start.js`를 순서대로 읽는다. 공통 runtime과 차트 엔진은 startup이 준비하며 기존 nav 연결은 fallback으로 유지한다.

차트의 실제 점 선택은 해당 시점 값을 표시하고, 구간 선택 중 계열을 바꾸면 같은 구간의 변화를 표시한다. 빈 차트 영역을 누르면 선택을 해제한다. 표의 숫자 정렬·정렬 상태·모바일 스크롤은 공통 규칙을 따른다.

UI 변경은 데이터·계산·수집 일정과 분리하며, 배포 전 프로젝트 검사와 실제 화면을 확인한다.
