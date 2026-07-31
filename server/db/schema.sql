-- 프로그램매매/공매도/신용잔고/대차거래 4종 수급데이터 캐시 테이블
-- API마다 응답 필드가 전부 달라서 원본 JSON을 그대로 저장하고,
-- 필요한 필드는 애플리케이션 코드에서 raw_data에서 꺼내 씀.
create table if not exists supply_demand_daily (
  id bigint generated always as identity primary key,
  symbol text not null,
  trade_date date not null,
  data_type text not null check (data_type in ('program_trade', 'short_sale', 'credit_balance', 'loan_trans', 'investor_trend')),
  raw_data jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (symbol, trade_date, data_type)
);

create index if not exists idx_supply_demand_symbol_date
  on supply_demand_daily (symbol, trade_date desc);

-- 2026-07-25: investor_trend(투자자별 개인/외국인/기관 매매동향) 데이터타입 추가.
-- 이미 supply_demand_daily 테이블이 있는 기존 프로젝트는 위 create table문이 스킵되므로
-- CHECK 제약을 아래처럼 직접 갱신해야 함(신규 설치는 위 create table에 이미 포함되어 있어 불필요).
alter table supply_demand_daily drop constraint if exists supply_demand_daily_data_type_check;
alter table supply_demand_daily add constraint supply_demand_daily_data_type_check
  check (data_type in ('program_trade', 'short_sale', 'credit_balance', 'loan_trans', 'investor_trend'));

-- KIS Developers OAuth 접근토큰 영구저장. Render 무료 요금제가 비활성 시 재시작되면
-- 메모리 캐시가 날아가는데, KIS 토큰은 "1일 1회 발급 원칙"이라 재시작마다 새로 받으면 안 됨.
-- 행 하나만 씀(id=1 고정).
create table if not exists kis_oauth_token (
  id smallint primary key,
  access_token text not null,
  expires_at timestamptz not null
);

-- Phase 3: 관심종목. domestic=true면 6자리 종목코드, false면 해외 티커.
-- 스케줄러가 매일 새벽 이 목록을 돌면서 골든/데드크로스·거래량 급증 신호를 체크해 텔레그램으로 알림.
create table if not exists watchlist (
  id bigint generated always as identity primary key,
  symbol text not null,
  domestic boolean not null,
  added_at timestamptz not null default now(),
  unique (symbol)
);

-- 2026-07-31: 관심종목 표시명(예: "삼성전자") 추가. symbol(종목코드/티커)은 검색·삭제 키로 계속 쓰고,
-- name은 화면 표시·텔레그램 메시지용 — 해외 종목은 한글명 조회를 지원 안 해서 null일 수 있음(그 경우
-- 화면/메시지에서 symbol로 폴백). 이미 watchlist 테이블이 있는 기존 프로젝트는 위 create table문이
-- 스킵되므로 이 alter문을 직접 돌려야 함(신규 설치는 need 없음, 그냥 no-op).
alter table watchlist add column if not exists name text;

-- 2026-08-01: 관심종목 커스텀 그룹핑 — 별도 groups 테이블 없이 각 종목에 그룹명 문자열만 붙임
-- (그룹은 이 필드에 등장하는 문자열들의 집합으로 화면에서 묶어서 보여줌 — null/빈 문자열은 "미분류").
alter table watchlist add column if not exists group_name text;
