# ETF Tracking

한국 상장 액티브 ETF 3종의 TOP 10 편입 종목과 비중 변화를 추적하는 정적 웹 대시보드입니다.

배포 URL: `https://sonchanggi.github.io/etf-tracking/`

## 추적 대상

- TIME 미국나스닥100액티브 — `426030`
- TIME 글로벌AI인공지능액티브 — `456600`
- KoAct 미국나스닥성장기업액티브 — `2ETFQ1`

## 기능

- ETF별 TOP10 종목과 투자 비중 히스토리 표/그래프
- 커밋된 히스토리 시작일과 백필 정책을 화면에 표시
- 편입·편출, 비중 급변, 가격 수익률로 설명되지 않는 잔차 신호 표시
- 전체 보유종목 기준의 전일 종가/평가단가·환율 기여분과 ETF 매수/매도 가능성 분해
- 공급자 데이터 지연/누락과 종가 누락을 명시적으로 표시하는 상태 파일
- GitHub Actions로 매일 08:05 KST 이후 자동 업데이트 및 09:30/11:00/13:00 KST 재시도
- 예약 자동화는 일시적 공급자/종가 지연을 실패 종료하지 않고 `data/automation-status.json`에 기록
- 이미 저장된 usable 스냅샷은 재요청하지 않고 없는 날짜만 채우는 missing-only 업데이트
- 공개 페이지의 수동 업데이트 버튼으로 GitHub Actions `workflow_dispatch` 실행 화면 연결
- GitHub Pages는 `main` 브랜치 루트의 정적 파일을 배포

## 로컬 실행

```bash
python3 scripts/update_data.py --output-dir data --backfill-days 10 --soft-fail
python3 -m http.server 8080
# http://localhost:8080
```

초기/추가 과거 백필이 필요하면 수동 워크플로에서 `backfill_start_date`를 입력하거나 아래 명령을 사용합니다.

```bash
python3 scripts/update_data.py --output-dir data --backfill-start-date 2026-05-01 --soft-fail
```

기본 동작은 missing-only입니다. 이미 `data/dashboard.json`에 usable TOP10 스냅샷이 있는 날짜는 건너뛰고, 누락된 날짜만 공급자에 요청합니다. 같은 날짜를 강제로 다시 수집해야 할 때만 `--refresh-existing`을 추가합니다.

```bash
python3 scripts/update_data.py --output-dir data --backfill-days 10 --soft-fail --refresh-existing
```

상장일 이후 전체 기간 백필이 필요하면 다음 명령을 사용합니다. 단, 정적 JSON 용량과 공급자 요청 제한이 커질 수 있어 기본 예약 자동화에는 적용하지 않습니다.

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
- 이력에는 공급자가 제공한 전체 보유종목을 보존하고, TOP10은 화면용 파생 뷰로 사용합니다. TOP10 밖(11위 이하)으로 내려간 종목도 전체 보유목록에 남아 있으면 실제 비중/순위로 표시합니다.
- 가격 수익률 분해는 보유종목의 no-trade 예상비중 공식(`전일 비중 × (1+KRW 기준 종목수익률)/(1+가격확보분 벤치마크 수익률)`)을 사용합니다.
- ETF 비중은 KRW NAV 비중이므로 가격 효과는 우선 ETF PDF의 `평가금액/수량` KRW 평가단가 수익률을 사용합니다. 해당 값이 없을 때만 로컬 fixture → Yahoo Chart(query1/query2) → Stooq CSV → 선택적 FinanceDataReader 공개 종가 체인을 사용합니다.
- 외부 USD/JPY/HKD 종가를 사용할 때는 Yahoo Chart FX(`KRW=X` 등)와 Stooq FX CSV 보조 소스를 통해 환율을 직접 가져와 `현지통화 종가수익률 × 환율수익률`로 KRW 기준 수익률을 계산합니다. FX 데이터가 없으면 현지통화 수익률을 표시하되 `fxApplied=false`와 낮은 신뢰도 문구로 표기합니다. Google Finance는 안정적인 공개 historical HTTP API가 없어 자동화 소스로 사용하지 않고 수동 교차확인 대상으로만 봅니다.
- 전체 보유종목 또는 일부 종목 가격이 없으면 `returnCoverageUniverse`가 `priced_subset_of_full_holdings`, `top10_fallback` 등으로 낮아지고 화면에 가격확보 비중/미가격 비중이 표시됩니다.
- 환율 보정에도 불구하고 장중 체결, 현금/선물/비상장 종목, AP 설정·환매 효과를 완전히 복원하지는 못합니다.
- `likely_buy`/`likely_sell`은 실제 운용사 주문 확정이 아니라 가격 변화로 설명되지 않는 비중 잔차 신호입니다.
- 본 페이지는 개인 리서치 도구이며 투자, 세무, 법률 또는 매매 조언이 아닙니다.

## 자동화 운영 정책

- 예약 workflow는 GitHub의 `run failed` 메일을 유발하지 않도록 예상 가능한 데이터 지연/공급자 오류를 soft-fail로 기록합니다.
- 예약 workflow는 최신 기준일을 먼저 확인한 뒤 최근 10일 구간에서 저장되지 않은 날짜만 보강합니다. 더 오래된 분석은 수동 `backfill_start_date` 또는 `backfill_all`로 확장합니다.
- 웹페이지의 수동 업데이트 버튼은 공개 정적 페이지에 토큰을 저장하지 않고 GitHub의 인증된 Actions 실행 화면으로 이동합니다.
- CLI로 수동 실행하려면 `gh workflow run update-data.yml --repo SonChangGi/etf-tracking --ref main -f backfill_all=false -f backfill_start_date= -f refresh_existing=false -f strict_validation=false`를 사용합니다.
- 업데이트 결과는 `data/status.json`과 `data/automation-status.json`에 남깁니다.
- `npm test`까지 통과하고 `automation-status.json`의 `runStatus`가 정확히 `ok`일 때만 새 데이터를 커밋합니다. `waiting_for_data`나 `degraded`는 실패 메일을 만들지는 않지만 데이터 커밋은 차단합니다.
- 디버깅이 필요할 때는 수동 workflow 실행에서 `strict_validation=true`를 선택하면 일반 CI처럼 실패 종료합니다.

## 프로젝트 경계

이 저장소는 ETF Tracking 전용입니다. 통합 허브 연결을 위해서만 별도 `quant-dashboard` 작업트리의 허용된 파일을 수정하며, 다른 프로젝트의 코드나 산출물은 수정하지 않습니다.
