# ETF Tracking

한국 상장 액티브 ETF 3종의 TOP 10 편입 종목과 비중 변화를 추적하는 정적 웹 대시보드입니다.

배포 URL: `https://sonchanggi.github.io/etf-tracking/`

## 추적 대상

- TIME 미국나스닥100액티브 — `426030`
- TIME 글로벌AI인공지능액티브 — `456600`
- KoAct 미국나스닥성장기업액티브 — `2ETFQ1`

## 기능

- ETF별 TOP10 종목과 투자 비중 히스토리 표/그래프
- 편입·편출, 비중 급변, 가격 수익률로 설명되지 않는 잔차 신호 표시
- 전일 종가 기반의 가격 기여분과 ETF 매수/매도 가능성 분해
- 공급자 데이터 지연/누락과 종가 누락을 명시적으로 표시하는 상태 파일
- GitHub Actions로 매일 08:05 KST 이후 자동 업데이트 및 09:30/11:00/13:00 KST 재시도
- 예약 자동화는 일시적 공급자/종가 지연을 실패 종료하지 않고 `data/automation-status.json`에 기록
- GitHub Pages는 `main` 브랜치 루트의 정적 파일을 배포

## 로컬 실행

```bash
python3 scripts/update_data.py --output-dir data --backfill-days 10 --soft-fail
python3 -m http.server 8080
# http://localhost:8080
```

초기 전체 기간 백필이 필요하면 수동 워크플로 또는 아래 명령을 사용합니다.

```bash
python3 scripts/update_data.py --output-dir data --backfill-all
```

## 검증

```bash
npm test
```

검증은 Python/Node 내장 기능만 사용합니다. 새 런타임 의존성을 추가하지 않습니다.

## 데이터/해석 주의

- ETF 공급자 페이지와 공개 API에서 읽은 공개 정보만 사용합니다.
- 가격 수익률 분해는 TOP10 비중과 Yahoo Finance 종가를 이용한 추정입니다. 환율, 장중 체결, 전체 포트폴리오, 현금/선물/비상장 종목, AP 설정·환매 효과를 완전히 복원하지 않습니다.
- `likely_buy`/`likely_sell`은 실제 운용사 주문 확정이 아니라 가격 변화로 설명되지 않는 비중 잔차 신호입니다.
- 본 페이지는 개인 리서치 도구이며 투자, 세무, 법률 또는 매매 조언이 아닙니다.

## 자동화 운영 정책

- 예약 workflow는 GitHub의 `run failed` 메일을 유발하지 않도록 예상 가능한 데이터 지연/공급자 오류를 soft-fail로 기록합니다.
- 업데이트 결과는 `data/status.json`과 `data/automation-status.json`에 남깁니다.
- `npm test`까지 통과하고 `automation-status.json`이 `soft_failed`가 아닐 때만 새 데이터를 커밋합니다.
- 디버깅이 필요할 때는 수동 workflow 실행에서 `strict_validation=true`를 선택하면 일반 CI처럼 실패 종료합니다.

## 프로젝트 경계

이 저장소는 ETF Tracking 전용입니다. 통합 허브 연결을 위해서만 별도 `quant-dashboard` 작업트리의 허용된 파일을 수정하며, 다른 프로젝트의 코드나 산출물은 수정하지 않습니다.
