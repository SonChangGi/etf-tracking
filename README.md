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
- 정기 수집·계산은 Quant2Alpha 소유 Windows 배치로 이관했으며 이 저장소의 중복 예약 수집은 퇴역
- 이미 저장된 usable 스냅샷은 재요청하지 않고 없는 날짜만 채우는 missing-only 업데이트
- 원래 공개 페이지·자료와 과거 판본의 자동화 출처 메타데이터를 그대로 보존
- GitHub Pages의 수동 UI 배포는 `deploy-ui.yml`의 검증된 `dist` artifact 사용
- 공통 플랫폼 `0.1.0` 호환 경계에서 9개 메뉴·디자인 토큰·표시 제어 계약을 검증
- 공개 화면은 같은 출처의 검증된 정적 JSON만 `GET`하며 분석 실행 API를 호출하지 않음

## 로컬 실행

```bash
python3 -m pip install -r requirements.txt
python3 scripts/refresh_etf_pipeline.py --diagnostics-dir /tmp/etf-diagnostics --backfill-days 10
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

상장일 이후 전체 기간 백필이 필요하면 다음 명령을 사용합니다. 단, 정적 JSON 용량과 공급자 요청 제한이 커질 수 있어 기본 수동 갱신에는 적용하지 않습니다.

```bash
python3 scripts/update_data.py --output-dir data --backfill-all
```

## 검증

```bash
npm test
```

검증은 Python/Node 내장 기능만 사용합니다. 새 런타임 의존성을 추가하지
않습니다. Python 47개 테스트, UI/계약 테스트, 공통 플랫폼 snapshot
fingerprint, 독립 정적 빌드, 모든 JSON의 source/dist SHA-256 byte parity를
한 번에 확인합니다.

독립 배포 산출물만 만들려면 다음 명령을 사용합니다.

```bash
npm run build
# dist/
```

공통 프런트엔드 경계와 동기화 절차는
[`docs/shared-frontend-integration.md`](docs/shared-frontend-integration.md)에
정리되어 있습니다.

## 데이터/해석 주의

- ETF 공급자 페이지와 공개 API에서 읽은 공개 정보만 사용합니다.
- 이력에는 공급자가 제공한 전체 보유종목을 보존하고, TOP10은 화면용 파생 뷰로 사용합니다. TOP10 밖(11위 이하)으로 내려간 종목도 전체 보유목록에 남아 있으면 실제 비중/순위로 표시합니다.
- 가격 수익률 분해는 보유종목의 no-trade 예상비중 공식(`전일 비중 × (1+KRW 기준 종목수익률)/(1+가격확보분 벤치마크 수익률)`)을 사용합니다. 여기서 벤치마크는 가격이 확보된 보유종목의 전일비중 가중 수익률이며, 실제 ETF NAV 수익률을 직접 관측한 값은 아닙니다.
- ETF 비중은 KRW NAV 비중이므로 가격 효과는 우선 ETF PDF의 `평가금액/수량` KRW 평가단가 수익률을 사용합니다. 해당 값이 없을 때만 로컬 fixture → Yahoo Chart(query1/query2) → Stooq CSV → 선택적 FinanceDataReader 공개 종가 체인을 사용합니다.
- 외부 USD/JPY/HKD 종가를 사용할 때는 Yahoo Chart FX(`KRW=X` 등)와 Stooq FX CSV 보조 소스를 통해 환율을 직접 가져와 `현지통화 종가수익률 × 환율수익률`로 KRW 기준 수익률을 계산합니다. FX 데이터가 없으면 현지통화 수익률을 표시하되 `fxApplied=false`와 낮은 신뢰도 문구로 표기합니다. Google Finance는 안정적인 공개 historical HTTP API가 없어 자동화 소스로 사용하지 않고 수동 교차확인 대상으로만 봅니다.
- 전체 보유종목 또는 일부 종목 가격이 없으면 `returnCoverageUniverse`가 `priced_subset_of_full_holdings`, `top10_fallback` 등으로 낮아지고 화면에 가격확보 비중/미가격 비중이 표시됩니다.
- `가격 우세(price_aligned)`는 잔차가 작은 no-trade 가격 효과 우세 구간이라는 뜻이며 “완전히 가격으로 설명됨” 또는 “거래가 없었다”는 확정 표현이 아닙니다. 중간 잔차는 `잔차 관찰(residual_watch)`로 두되 방향에 따라 `약한 매수 관찰`/`약한 매도·축소 관찰` 설명을 붙이고, 임계치 이상인 방향성 잔차만 `likely_buy`/`likely_sell` 가능성 신호로 분류합니다.
- 환율 보정에도 불구하고 장중 체결, 현금/선물/비상장 종목, AP 설정·환매 효과를 완전히 복원하지는 못합니다.
- `likely_buy`/`likely_sell`은 실제 운용사 주문 확정이 아니라 가격 변화로 설명되지 않는 비중 잔차 신호입니다.
- 본 페이지는 개인 리서치 도구이며 투자, 세무, 법률 또는 매매 조언이 아닙니다.

## 자동화 이관

정기 수집·계산과 새 판본 발행의 소유자는 Quant2Alpha이다. 기존 `update-data.yml` 예약 및 수동 수집 workflow와 그 전용 교차 프로젝트 대기 코드는 제거했다. 이 저장소에서는 자동 재수집이나 데이터 커밋을 수행하지 않는다.

기존 사이트·원자료·계산 결과는 과거 판본으로 보존한다. JSON에 기록된 수집 시각·cadence·수동 workflow 주소는 당시의 출처이며 현재 실행 지시가 아니다. 과거 메타데이터나 결과를 새 시각으로 고쳐 쓰지 않는다. 정식 결과는 `https://quant2alpha.com/etf-tracking/`에서 확인한다.

원래 Pages를 재게시해야 하는 명시적 요청에는 `deploy-ui.yml`만 수동 실행할 수 있다. 기본 브랜치 검사, `npm test`, 디자인 검증, 공개 UI bytes 비교를 유지하며 공급자 수집은 실행하지 않는다. 수집·계산 코드와 그 단위 검증은 보존된 연구의 재현에 사용하고 새 정기 실행은 Quant2Alpha에서만 관리한다.

## 프로젝트 경계

이 저장소는 ETF Tracking 전용입니다. 통합 허브 연결을 위해서만 별도 `quant-dashboard` 작업트리의 허용된 파일을 수정하며, 다른 프로젝트의 코드나 산출물은 수정하지 않습니다.

화면의 ETF·날짜·기간 선택은 저장 결과 선택기이고, 차트 강조·표 필터·
정렬·테마는 표시 설정입니다. 소유자 refresh/backfill만 인증이 필요한
GitHub Actions operation이며 공개 화면에는 Python 분석 input이나
FastAPI run submission이 없습니다. 대용량 ETF 히스토리는 계속
`data/history/*.json` 정적 파일로 유지하고 DB나 JavaScript bundle에
복제하지 않습니다.
