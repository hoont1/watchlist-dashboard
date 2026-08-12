# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This is not a software project — it's a working folder for financial/market
data analysis and reporting. Contents:

- `지점별_실적_더미데이터*.xlsx` — dummy branch performance data (monthly branch
  KPIs, product subscription records). No build/test tooling; inspect and edit
  via Excel COM (`New-Object -ComObject Excel.Application`) since no
  Python/openpyxl is available in this environment.
- `*.pdf` — securities research reports (Korean brokerage market strategy notes).
- `*리포트.html` — self-contained HTML reports (charts + tables) generated from
  the above data, following the `dataviz` skill's method (categorical palette,
  validated contrast, hover/tooltip, table-view fallback).

## Output rules for reports and analysis in this folder

Apply these to every report, summary, or answer produced from this folder's
data, unless the user overrides them for a specific request:

1. **결론 먼저 (conclusion first)** — state the bottom-line finding or
   recommendation in the first line(s), before supporting detail or methodology.
2. **표는 마크다운 (tables in markdown)** — present tabular data as markdown
   tables, not prose lists or ASCII art.
3. **금액은 억원 단위 (amounts in 억원)** — normalize all won amounts to 억원
   (100-million-won units) for display, even if the source uses 만원, 백만원,
   조원, or raw won. Convert and state the unit in the table header.
4. **수치에는 계산 근거 표시 (show the basis for every number)** — any derived,
   estimated, or aggregated figure must show how it was obtained (formula, source
   ratio, or "원문 명시값" vs "추정치") inline or in a footnote — never present a
   calculated number as if it were a directly-sourced one.

## 리밸런싱 체크 도구 (개인 대시보드 앱)

참조: `@PRD.md` — 목표, 핵심 기능(고객별 자산 정보 입력 / 이탈률 자동 계산 /
리밸런싱 필요 고객 리스트업), 화면 구성, 제외 범위, 검증 기준은 이 문서를
따른다.

이전 버전(관심종목·메모·체크리스트 대시보드)은 이 도구로 완전히 교체되었다.

### 기술 규칙

- **순수 HTML/CSS/JS만 사용, Supabase 클라이언트는 예외** — 프레임워크,
  번들러, 빌드 도구 도입은 금지하되, 데이터 저장을 위한 `@supabase/supabase-js`
  (CDN) 로드는 허용한다.
- **파일 구성은 3개로 유지** — `index.html`, `style.css`, `app.js`. 마크업/스타일/
  로직을 한 파일에 섞지 말고 이 세 파일로 분리해 유지한다.
- **데이터 저장은 Supabase** — 고객·자산군 데이터는 Supabase 테이블(`clients`,
  `holdings`)에 저장한다. 로그인 기능이 없으므로 RLS는 `anon` 전체 접근
  정책으로 열려 있다 — URL/키를 아는 사람은 누구나 읽고 쓸 수 있다는 점을
  전제로 개인 용도로만 사용한다. 이전에 만든 `watchlist`/`memos`/`checklist`
  테이블은 더 이상 이 앱에서 쓰지 않지만 삭제하지 않고 남겨둔다.

### 작업 규칙

- **한 번에 한 태스크만** — 여러 기능/수정 사항을 한 번에 묶어 진행하지 않고,
  하나의 태스크를 완료한 뒤 다음 태스크로 넘어간다.
- **변경 후 반드시 브라우저에서 확인** — 코드를 수정하면 실제로 브라우저에서
  열어 동작을 확인한 뒤에 완료로 간주한다. 코드 리뷰만으로 완료 처리하지 않는다.
